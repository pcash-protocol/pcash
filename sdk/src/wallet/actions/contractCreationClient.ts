import type { SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
// Sponsored contract-account creation: this wallet pays the creation fee from
// its own native notes under its installed contract-fee-sponsorship rule. The
// payment is journaled like any other note-spending action, so its inputs stay
// reserved and its change note stays pending until the creation settles.

import { requestPcashAuthorization, type PcashActionSigner } from "@pcash/sdk/eip712";
import { formatUnits } from "viem";
import {
  prepareSponsoredContractCreation,
  snapshotFromAccountProof,
  type SponsoredContractCreationBuild,
} from "@pcash/sdk/builders";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import {
  networkConfigFromStatus,
  decodeTransaction,
  contractAccountCreationSize,
  decodeContractBody,
  verifyContract,
  TX_KIND_CONTRACT_ACCOUNT_CREATION,
} from "@pcash/sdk/protocol";
import { ACCOUNT_KIND_USER } from "@pcash/sdk/constants";
import { addressHex, bytes32Hex, fromHex } from "@pcash/sdk/utils";
import type { DurableSubmissionAdapter, DurableSubmissionCallbacks, SettlePollOptions } from "./durableSubmission.ts";
import { settlePollOptions } from "./durableSubmission.ts";
import { transactionIdentity } from "@pcash/sdk/protocol";
import { submitPreparedAssetAction, type AssetActionSubmissionResult } from "./assetActionClient.ts";
import {
  actionPublication,
  noteNullifier,
  pendingIssuanceBeneficiary,
  planPublication,
  resolvePublicationFunding,
  prepareAccountPublication,
  publicationOf,
  publicationValidUntil,
  type ActionPublication,
} from "./publication.ts";
import { reconcilePendingWalletActions } from "./clientReconciliation.ts";
import { localWitnessSnapshot } from "./localChain.ts";
import { registeredSelfReceiveKey } from "./selfDelivery.ts";
import { assertWalletStoreMatches } from "./walletSession.ts";
import { assertPcashProfileMatchesAccount, type PcashProfile } from "../externalIdentity.ts";
import { InsufficientNotesError, selectInputNotes, type PendingAssetAction, type WalletNote } from "../noteStore.ts";
import type { WalletStateStore } from "../store.ts";

export interface SponsoredContractCreationProver {
  /** Produce the exact type-0x02 transaction bytes for an authorized build. */
  proveAndEncode(build: SponsoredContractCreationBuild): Promise<Uint8Array>;
}

export interface SponsoredContractCreationIntent extends DurableSubmissionCallbacks {
  /** The unsigned contract body and the address the node derives from it. */
  contract: { body: Uint8Array; address: bigint };
  /** Approved fee; absent requires self-publication, since account operations earn no issuance. */
  openFeeAmount?: bigint;
  privateRelayFeeAmount?: bigint;
  issuanceOwnerCommitment?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  /** Exact note commitment (0x-hex) or array index to spend for the fee. */
  noteSelector?: string;
  validUntilTimestamp?: bigint;
  /** Marketplace may pass an application cutoff; omitted means an exact requested deadline. */
  validUntilMode?: "exact" | "ceiling";
}

export interface SponsoredContractCreationClientParams<Prepared = unknown, Output = unknown>
  extends SponsoredContractCreationIntent, SettlePollOptions {
  node: PcashNodeClient;
  store: WalletStateStore;
  wallet: PcashProfile;
  signer: PcashActionSigner;
  chainId: bigint;
  prover: SponsoredContractCreationProver;
  submission: DurableSubmissionAdapter<Prepared, Output>;
  status?: StatusResult;
}

export interface SponsoredContractCreationResult<Output = unknown> extends AssetActionSubmissionResult<Output> {
  contractAddress: string;
  openFeeAmount: bigint;
  changeAmount: bigint;
  publicationDetails: ActionPublication;
}

const DEFAULT_VALIDITY_WINDOW = 1_800n;

/** Derive the address of an encoded body exactly as the node does. */
function bodyAddress(body: Uint8Array): bigint {
  return verifyContract(decodeContractBody(body)).address;
}

function pendingCreationFor(
  data: { pendingAssetActions?: PendingAssetAction[] },
  address: bigint,
): PendingAssetAction | null {
  const matches = (data.pendingAssetActions ?? []).filter((pending) => {
    const decoded = decodeTransaction(fromHex(pending.transactionHex));
    return decoded.kind === TX_KIND_CONTRACT_ACCOUNT_CREATION && bodyAddress(decoded.body) === address;
  });
  if (matches.length > 1) throw new Error("wallet has multiple unresolved sponsored creations of one contract");
  return matches[0] ?? null;
}

export async function runSponsoredContractCreationClient<Prepared, Output>(
  params: SponsoredContractCreationClientParams<Prepared, Output>,
): Promise<SponsoredContractCreationResult<Output>> {
  const initialStatus = params.status ?? await params.node.status();
  assertWalletStoreMatches(params.store, params.wallet, params.chainId, initialStatus);
  const data = await params.store.load();
  if (data === null) throw new Error("wallet state is required for sponsored contract creation");
  if (await params.store.readChain((chain) => reconcilePendingWalletActions(data, chain, initialStatus))) {
    await params.store.save(data);
  }
  const address = params.contract.address;
  if (bodyAddress(params.contract.body) !== address) {
    throw new Error("contract.address does not derive from contract.body");
  }

  const existing = pendingCreationFor(data, address);
  const publication = publicationOf(params.submission,
    params.privateRelayFeeAmount ?? (existing === null ? 0n : BigInt(existing.privateRelayFeeAmount ?? 0n)));
  if (existing !== null) {
    // The journaled bytes fix the destination; a request naming another one is not this creation.
    const requestedRecipient = params.selectedRelayQuote === undefined ? undefined : addressHex(params.selectedRelayQuote.recipient);
    if (
      (requestedRecipient !== undefined && requestedRecipient.toLowerCase()
        !== existing.privateRelayRecipient?.toLowerCase())
      || (params.issuanceOwnerCommitment !== undefined && params.issuanceOwnerCommitment !== BigInt(existing.issuanceOwnerCommitment))
    ) {
      throw new Error(`pending sponsored contract creation ${existing.contentHash} pays a different selected relay destination`);
    }
    const outcome = await submitPreparedAssetAction({
      node: params.node,
      store: params.store,
      data,
      status: initialStatus,
      preparedAction: { transactionBytes: fromHex(existing.transactionHex), pending: existing },
      submission: params.submission,
      preparedSubmission: await params.submission.preflight({
        transactionBytes: fromHex(existing.transactionHex),
        status: initialStatus,
        retry: true,
      }),
      callbacks: params,
      receiptKind: "contractAccount",
      ...settlePollOptions(params),
    });
    return {
      ...outcome,
      contractAddress: addressHex(address),
      openFeeAmount: BigInt(existing.openFeeAmount),
      changeAmount: existing.ownedOutputs.reduce((sum, output) => sum + BigInt(output.amount), 0n),
      publicationDetails: actionPublication(existing, pendingIssuanceBeneficiary(existing, params.wallet), false),
    };
  }

  let plan = await planPublication({
    qualifying: false,
    byteSize: BigInt(contractAccountCreationSize(params.contract.body.length, "sponsored")),
    openFeeAmount: params.openFeeAmount,
    privateRelayFeeAmount: params.privateRelayFeeAmount,
    publication,
    selectedRelayQuote: params.selectedRelayQuote,
    node: params.node,
  });
  let openFeeAmount = plan.openFeeAmount;

  // A zero-fee creation spends nothing: selection returns no notes, so every
  // input slot is a dummy and the sponsor only authorizes the publication. An
  // explicit selector still spends the named note and returns it as change.
  let inputNotes: WalletNote[];
  try {
    const resolved = resolvePublicationFunding(plan,
      fee => selectInputNotes(data, params.noteSelector, fee));
    plan = resolved.plan;
    openFeeAmount = plan.openFeeAmount;
    inputNotes = resolved.funding;
  } catch (cause) {
    if (!(cause instanceof InsufficientNotesError)) throw cause;
    throw new Error(
      `Contract creation needs ${formatUnits(openFeeAmount, 18)} PCASH in spendable notes, `
      + `but only ${formatUnits(cause.maximumTransfer, 18)} PCASH in notes can be used. `
      + "Choose a zero PCASH creation fee or receive more PCASH before retrying.",
      { cause },
    );
  }
  const walletAddress = addressHex(params.wallet.address);
  const status = await params.node.status();
  const snapshot = await localWitnessSnapshot(params.store, {
    accounts: [walletAddress],
    outputs: inputNotes.map((note) => ({ outputIndex: BigInt(note.leafIndex!) })),
  });
  const accountPath = snapshot.accounts[0]!;
  if (accountPath.status !== "present") throw new Error(`sponsor ${walletAddress} has no account`);
  assertWalletStoreMatches(params.store, params.wallet, params.chainId, status);
  const network = networkConfigFromStatus(status);
  const rules = assertPcashProfileMatchesAccount(params.wallet, accountPath.account, network);
  const validUntilTimestamp = publicationValidUntil({
    chainNow: status.latestBlockTimestamp, defaultWindow: DEFAULT_VALIDITY_WINDOW,
    selectedRelayQuote: params.selectedRelayQuote, requested: params.validUntilTimestamp,
    requestedMode: params.validUntilMode,
    action: "sponsored contract creation",
  });

  const quotedFee = await prepareAccountPublication({
    node: params.node, status, owner: params.wallet, publication, inputs: inputNotes,
    openFeeAmount, privateRelayFeeAmount: plan.privateRelayFeeAmount,
    maxTransactionBytes: BigInt(contractAccountCreationSize(params.contract.body.length, "sponsored")),
    issuanceOwnerCommitment: params.issuanceOwnerCommitment ?? 0n, validUntilTimestamp,
    ...(params.selectedRelayQuote === undefined ? {} : { selectedRelayQuote: params.selectedRelayQuote }),
  });
  const issuanceOwnerCommitment = quotedFee.issuanceOwnerCommitment;
  const build = prepareSponsoredContractCreation({
    network,
    contract: { body: params.contract.body, address },
    sponsor: {
      address: params.wallet.address,
      nkRoot: params.wallet.nkRoot,
      accountIndex: Number(accountPath.account.index),
      accountSiblings: accountPath.accountSiblings,
      accountRuleSetCommitment: rules.accountRuleSetCommitment,
      accountKind: ACCOUNT_KIND_USER,
      accountRevision: accountPath.account.accountRevision,
      receiveKeyHash: BigInt(accountPath.account.receiveKeyHash),
      rule: rules.contractFeeSponsorshipRule,
    },
    sponsorWallet: params.wallet,
    sender: { outgoingKey: params.wallet.outgoingKey },
    ...(inputNotes.reduce((sum, note) => sum + BigInt(note.amount), 0n) > openFeeAmount + plan.privateRelayFeeAmount
      ? { sponsorReceiveKey: registeredSelfReceiveKey(accountPath.account, data) } : {}),
    snapshot: snapshotFromAccountProof(accountPath),
    fee: {
      openFeeAmount: openFeeAmount,
      ...quotedFee,
      validUntilTimestamp,
      inputs: inputNotes.map((note, index) => ({
        noteSecret: BigInt(note.noteSecret),
        amount: BigInt(note.amount),
        leafIndex: Number(note.leafIndex!),
        siblings: snapshot.outputs!.paths[index]!.siblings,
      })),
    },
  });
  const expectedNullifiers = inputNotes.map((note) =>
    noteNullifier(params.wallet.nkRoot, note));
  if (build.payment.nativeInputs.some((input, index) => input.nullifier !== expectedNullifiers[index])) {
    throw new Error("sponsored contract creation does not spend the selected fee notes");
  }
  params.onProgress?.("preparing", "requesting the sponsorship signature…");
  const readable = build.authorizeReadableEcdsa(
    await requestPcashAuthorization(params.signer, build.authorizationRequest),
  );
  params.onProgress?.("proving", "generating the sponsored contract creation proof…");
  const entry = await params.prover.proveAndEncode({ ...build, readableEcdsaWitnessMap: readable.witnessMap });
  const decoded = decodeTransaction(entry);
  if (decoded.kind !== TX_KIND_CONTRACT_ACCOUNT_CREATION || decoded.funding.mode !== "sponsored") {
    throw new Error("prover did not return a sponsored contract creation");
  }
  const { contentHash, transactionHex } = transactionIdentity(entry);
  const pending: PendingAssetAction = {
    contentHash,
    transactionHex,
    assetId: bytes32Hex(0n),
    owner: addressHex(params.wallet.address),
    notBeforeTimestamp: "0",
    validUntilTimestamp: validUntilTimestamp.toString(),
    openFeeAmount: openFeeAmount.toString(),
    ...(quotedFee.privateRelayPayment === undefined ? {} : {
      privateRelayFeeAmount: plan.privateRelayFeeAmount.toString(),
      privateRelayRecipient: addressHex(quotedFee.privateRelayPayment.recipientAddress),
    }),
    issuanceOwnerCommitment: issuanceOwnerCommitment.toString(),
    ...(quotedFee.designatedIssuanceOpening === undefined ? {} : {
      issuanceRecipient: addressHex(BigInt(quotedFee.designatedIssuanceOpening.recipientAddress)),
    }),
    receiptKind: "contractAccount",
    // All four input positions, so the journal matches the section's
    // nullifier words; dummy slots spend nothing.
    inputs: [0, 1, 2, 3].map((slot) => {
      const index = build.payment.nativeInputs.findIndex((input) => input.slot === slot);
      return {
        nullifier: bytes32Hex(build.payment.publicInputs[2 + slot]!),
        spentCommitment: index === -1 ? null : bytes32Hex(BigInt(inputNotes[index]!.commitment!)),
      };
    }),
    ownedOutputs: build.payment.change === null
      ? []
      : [{
        outputIndex: build.payment.change.slot,
        assetId: "0x0",
        amount: build.payment.change.amount.toString(),
        owner: addressHex(params.wallet.address),
        noteSecret: bytes32Hex(build.payment.change.noteSecret),
      }],
  };
  const preparedSubmission = await params.submission.preflight({ transactionBytes: entry, status, retry: false });
  const outcome = await submitPreparedAssetAction({
    node: params.node,
    store: params.store,
    data,
    status,
    preparedAction: { transactionBytes: entry, pending },
    submission: params.submission,
    preparedSubmission,
    callbacks: params,
    receiptKind: "contractAccount",
    ...settlePollOptions(params),
  });
  return {
    ...outcome,
    contractAddress: addressHex(address),
    openFeeAmount: openFeeAmount,
    changeAmount: build.payment.change?.amount ?? 0n,
    publicationDetails: actionPublication(pending, plan.beneficiary, false),
  };
}
