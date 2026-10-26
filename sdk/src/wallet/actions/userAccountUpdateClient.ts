import type { SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
// Browser-safe reference user-account update state machine. Platform adapters
// provide proof production, persistence, and submission; this module owns the
// rule-set/receive-key checks, exact-byte journal, retry, and reconciliation.

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
  type IssuanceBeneficiary,
  type PublicationPlan,
} from "./publication.ts";
import { toHex } from "@pcash/sdk/utils";
import { acceptedReceiptOfKind, assertWalletStoreMatches } from "./walletSession.ts";
import { ML_KEM_768_PUBLIC_KEY_LENGTH, PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import type { PcashActionSigner } from "@pcash/sdk/eip712";
import { assertTransactionTypeAccepted } from "@pcash/sdk/protocol";
import { reconcilePendingWalletActions } from "./clientReconciliation.ts";
import { localAccount, localWitnessSnapshot } from "./localChain.ts";
import { registeredSelfReceiveKey } from "./selfDelivery.ts";
import type { WalletStateStore } from "../store.ts";
import {
  encodeProposedAccountFields,
  receiveKeyHash as protocolReceiveKeyHash,
  userAccountUpdateSize,
  TX_KIND_USER_ACCOUNT_UPDATE,
  type UserAccountReceiveKeyUpdate,
} from "@pcash/sdk/protocol";
import {
  submitDurableAction,
  type DurableSubmissionAdapter,
  type DurableSubmissionCallbacks,
  type DurableSubmissionResult,
  settlePollOptions,
  type SettlePollOptions,
} from "./durableSubmission.ts";
import { transactionIdentity } from "@pcash/sdk/protocol";
import { addressHex, bytes32Hex } from "@pcash/sdk/utils";
import type { MlKemKeyPair } from "@pcash/sdk/protocol";
import { assertPcashProfileMatchesAccountIdentity, type PcashProfile } from "../externalIdentity.ts";
import { fieldToHex, toField, type FieldNumberish } from "@pcash/sdk/crypto";
import { networkConfigFromStatus } from "@pcash/sdk/protocol";
import type { PcashNodeClient, AccountProofResult, StatusResult } from "@pcash/sdk/clients";
import {
  addPendingNote,
  addPendingUserAccountUpdate,
  removePendingNotesForTransaction,
  removePendingUserAccountUpdate,
  selectInputNotes,
  type PendingUserAccountUpdate,
  type WalletNote,
} from "../noteStore.ts";
import { directSendsToRecord } from "../directSends.ts";
import {
  receiveKeyHashHex,
  receiveKeyPairForHash,
  retainReceiveKeyPair,
  retainReceiveKeyPairForRescan,
  storedReceiveKeyPair,
} from "../receiveKeyring.ts";
import {
  validateReferenceWalletRuleSet,
  type IrreversibleRuleOverride,
  type ReferenceWalletRuleInspection,
} from "@pcash/sdk/rules";
import {
  authorizeUserAccountUpdate,
  prepareUserAccountUpdate,
  snapshotFromAccountProof,
  type BuildUserAccountUpdateParams,
  type UserAccountUpdateBuild,
} from "@pcash/sdk/builders";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import {
  FULL_RESCAN_RESOURCE,
  accountResource,
  noteResource,
  withWalletReservation,
} from "../reservations.ts";

const DEFAULT_USER_ACCOUNT_UPDATE_VALIDITY_WINDOW = 1_800n;


function defaultRuleInspection(
  defaults: ReturnType<typeof defaultUserAccountRuleSet>,
  recoveryContract: "ethereum-signature-derived" | "seed-derived",
): ReferenceWalletRuleInspection {
  const entry = (rule: typeof defaults.rule) => ({
    entryIndex: rule.entryIndex,
    applicationVkHash: rule.applicationVkHash,
    configurationCommitment: rule.configurationCommitment,
    commitmentBlinder: rule.commitmentBlinder,
  });
  return {
    entries: defaults.entries.map(entry),
    recovery: { kind: recoveryContract },
  };
}

/** The receive-key hash the account commits after `update`; zero means no key. */
function receiveKeyTarget(
  current: Extract<AccountProofResult, { status: "present" }>["account"],
  update: UserAccountReceiveKeyUpdate,
): bigint {
  const currentHash = toField(current.receiveKeyHash, "receiveKeyHash");
  if (update.operation === "clear") {
    if (currentHash === 0n) {
      throw new Error("CLEAR is noncanonical when the current receive key is absent; use KEEP");
    }
    return 0n;
  }
  if (update.operation === "replace") {
    if (update.mlKemPublicKey.length !== ML_KEM_768_PUBLIC_KEY_LENGTH) {
      throw new Error(`new mlKemPublicKey must be ${ML_KEM_768_PUBLIC_KEY_LENGTH} bytes`);
    }
    const hash = protocolReceiveKeyHash(update.mlKemPublicKey);
    if (hash === currentHash) {
      throw new Error("REPLACE is noncanonical when the receive-key hash is unchanged; use KEEP");
    }
    return hash;
  }
  return currentHash;
}

function currentReceiveKeyState(
  current: Extract<AccountProofResult, { status: "present" }>["account"],
): BuildUserAccountUpdateParams["current"]["receiveKey"] {
  const receiveKeyHash = toField(current.receiveKeyHash, "receiveKeyHash");
  return receiveKeyHash === 0n ? { status: "absent" } : { status: "unavailable", receiveKeyHash };
}

export type UserAccountReceiveKeyClientUpdate =
  | { operation: "keep" }
  | { operation: "clear" }
  | { operation: "replace"; keyPair?: MlKemKeyPair };

function protocolReceiveKeyUpdate(
  update: UserAccountReceiveKeyClientUpdate,
): UserAccountReceiveKeyUpdate {
  if (update.operation !== "replace") return update;
  if (update.keyPair === undefined) {
    throw new Error("a new REPLACE requires a complete owned ML-KEM keypair");
  }
  return { operation: "replace", mlKemPublicKey: update.keyPair.publicKey };
}

async function currentAccountProof(
  node: PcashNodeClient,
  store: WalletStateStore,
  address: string,
  feeInputs: readonly WalletNote[],
): Promise<{
  proof: Extract<AccountProofResult, { status: "present" }>;
  status: StatusResult;
  outputPaths: { siblings: bigint[] }[];
}> {
  const status = await node.status();
  const snapshot = await localWitnessSnapshot(store, {
    accounts: [address],
    outputs: feeInputs.map((note) => ({ outputIndex: BigInt(note.leafIndex!) })),
  });
  const value = snapshot.accounts[0]!;
  if (value.status !== "present") throw new Error(`user account ${address} does not exist`);
  return { proof: value, status, outputPaths: snapshot.outputs?.paths ?? [] };
}


export interface UserAccountUpdateProver {
  proveAndEncode(build: UserAccountUpdateBuild): Promise<Uint8Array>;
}

export interface UserAccountUpdateClientParams<Prepared = unknown, Output = unknown>
  extends DurableSubmissionCallbacks, SettlePollOptions {
  node: PcashNodeClient;
  store: WalletStateStore;
  /** Public account address. Custom recovery does not require nkRoot or a full profile. */
  address: FieldNumberish;
  /** Enables the default readable-ECDSA administration convenience path. */
  wallet?: PcashProfile;
  /** Required by the reference readable-ECDSA path; custom authorization supplies authorizeBuild. */
  signer?: PcashActionSigner;
  chainId: bigint;
  /** A new REPLACE requires the complete owned keypair so it can be persisted
   * before authorization or proof. A durable pending retry may omit it. */
  receiveKey: UserAccountReceiveKeyClientUpdate;
  /** Defaults to the reference wallet's four-rule ECDSA set. */
  ruleSetCommitment?: FieldNumberish;
  /** Required for a non-default proposed root. */
  ruleInspection?: ReferenceWalletRuleInspection;
  irreversibleOverride?: IrreversibleRuleOverride;
  /** Select and authorize any installed administration rule while retaining this client's safety and journal boundary. */
  authorizeBuild?: (
    params: Omit<BuildUserAccountUpdateParams, "rule" | "readableEcdsa" | "authorization">,
  ) => Promise<UserAccountUpdateBuild>;
  /** The account's nullifier-key root; defaults to the profile's. */
  nkRoot?: FieldNumberish;
  /** Approved native fee paid from the account's own notes; absent requires self-publication, since account operations earn no issuance. */
  openFeeAmount?: bigint;
  privateRelayFeeAmount?: bigint;
  issuanceOwnerCommitment?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  /** Exact note commitment (0x-hex) or array index to spend for the fee. */
  noteSelector?: string;
  validUntilTimestamp?: bigint;
  prover: UserAccountUpdateProver;
  submission: DurableSubmissionAdapter<Prepared, Output>;
}

export interface UserAccountUpdateClientResult<Output = unknown> {
  contentHash: string;
  transactionHex: string;
  address: string;
  currentAccountRevision: bigint;
  newAccountRevision: bigint;
  newRuleSetCommitment: bigint;
  receiveKeyOperation: PendingUserAccountUpdate["receiveKeyOperation"];
  newReceiveKeyHash: string;
  validUntilTimestamp: bigint;
  accepted: boolean;
  queued: boolean;
  settled: boolean;
  retried: boolean;
  recovered: boolean;
  submission: DurableSubmissionResult<Output> | null;
  publicationDetails: ActionPublication;
}

function resultFromPending<Output>(
  pending: PendingUserAccountUpdate,
  outcome: Awaited<ReturnType<typeof submitDurableAction<unknown, Output>>>,
  beneficiary: IssuanceBeneficiary,
): UserAccountUpdateClientResult<Output> {
  const currentAccountRevision = BigInt(pending.currentAccountRevision);
  return {
    contentHash: pending.contentHash,
    transactionHex: pending.transactionHex,
    address: pending.address,
    currentAccountRevision,
    newAccountRevision: currentAccountRevision + 1n,
    newRuleSetCommitment: BigInt(pending.newRuleSetCommitment),
    receiveKeyOperation: pending.receiveKeyOperation,
    newReceiveKeyHash: pending.newReceiveKeyHash,
    validUntilTimestamp: BigInt(pending.validUntilTimestamp),
    ...outcome,
    publicationDetails: actionPublication(pending, beneficiary, false),
  };
}

export async function runUserAccountUpdateClient<Prepared, Output>(
  params: UserAccountUpdateClientParams<Prepared, Output>,
): Promise<UserAccountUpdateClientResult<Output>> {
  const initialStatus = await params.node.status();
  assertWalletStoreMatches(params.store, params.wallet, params.chainId, initialStatus);
  const data = await params.store.load();
  if (data === null) throw new Error("wallet state is required for durable user account updates");
  if (await params.store.readChain((chain) => reconcilePendingWalletActions(data, chain, initialStatus))) {
    await params.store.save(data);
  }

    const accountAddress = toField(params.address, "address");
    if (accountAddress >= 1n << 160n) throw new Error("address must fit in 160 bits");
    const address = addressHex(accountAddress);
    const pendingForAddress = (data.pendingUserAccountUpdates ?? []).filter(
      (pending) => pending.address.toLowerCase() === address.toLowerCase(),
    );
    if (pendingForAddress.length > 1) {
      throw new Error(`user account ${address} has multiple unresolved updates`);
    }
    const existing = pendingForAddress[0];
    // The journaled bytes fix the destination; a request naming another one is not this update.
    if (
      existing !== undefined
      && params.selectedRelayQuote !== undefined
      && addressHex(params.selectedRelayQuote.recipient).toLowerCase()
        !== existing.privateRelayRecipient?.toLowerCase()
    ) {
      throw new Error(`pending user account update ${existing.contentHash} pays a different selected relay destination`);
    }
    const byteSize = BigInt(userAccountUpdateSize(
      params.receiveKey.operation === "replace" ? ML_KEM_768_PUBLIC_KEY_LENGTH : 0,
    ));
    // A journaled update replays its exact bytes, so its fee needs no new approval.
    const publication = publicationOf(params.submission,
      params.privateRelayFeeAmount ?? (existing === undefined ? 0n : BigInt(existing.privateRelayFeeAmount)));
    const plan: PublicationPlan = existing === undefined
      ? await planPublication({
        qualifying: false, byteSize, openFeeAmount: params.openFeeAmount,
        privateRelayFeeAmount: params.privateRelayFeeAmount, publication,
        selectedRelayQuote: params.selectedRelayQuote, node: params.node,
      })
      : {
        openFeeAmount: params.openFeeAmount ?? BigInt(existing.openFeeAmount), publication,
        privateRelayFeeAmount: params.privateRelayFeeAmount ?? BigInt(existing.privateRelayFeeAmount),
        beneficiary: pendingIssuanceBeneficiary(existing, { address: accountAddress }),
        privateRelayRecipient: existing.privateRelayRecipient,
      };
    const resolved = existing === undefined
      ? resolvePublicationFunding(plan, fee => fee === 0n ? [] : selectInputNotes(data, params.noteSelector, fee))
      : { plan, funding: [] };
    const openFeeAmount = resolved.plan.openFeeAmount;
    let issuanceOwnerCommitment = params.issuanceOwnerCommitment
      ?? (existing === undefined ? 0n : BigInt(existing.issuanceOwnerCommitment));
    if (openFeeAmount + resolved.plan.privateRelayFeeAmount > 0n && params.wallet === undefined) {
      throw new Error("a fee-paying user account update requires the wallet profile that owns the notes");
    }

    // A journaled update already made its selection: its inputs are reserved
    // and its change is still pending, so selecting again would demand funds
    // the wallet is deliberately holding for this exact transaction. Resume it
    // from its own record instead, and select notes only for a new update.
    if (existing !== undefined && (BigInt(existing.openFeeAmount) !== openFeeAmount
      || BigInt(existing.privateRelayFeeAmount) !== resolved.plan.privateRelayFeeAmount)) {
      throw new Error(`user account ${address} has an unresolved different update ${existing.contentHash}`);
    }
    const feeInputNotes = resolved.funding;
    const { proof, status, outputPaths } = await currentAccountProof(params.node, params.store, address, feeInputNotes);
    if (proof.account.accountKind !== 0) throw new Error(`${address} is not a user account`);
    const network = networkConfigFromStatus(status);
    if (params.wallet !== undefined) {
      assertPcashProfileMatchesAccountIdentity(params.wallet, proof.account);
      if (params.wallet.address !== accountAddress) {
        throw new Error("wallet and user account update addresses do not match");
      }
    }
    assertTransactionTypeAccepted(status, TX_KIND_USER_ACCOUNT_UPDATE);
    const defaults = params.wallet === undefined
      ? undefined
      : defaultUserAccountRuleSet({
          wallet: params.wallet,
          network,
          secrets: params.wallet.defaultUserRuleSecrets,
        });
    if (params.ruleSetCommitment === undefined && defaults === undefined) {
      throw new Error("custom user account updates require ruleSetCommitment");
    }
    const proposedRuleSetCommitment = toField(
      params.ruleSetCommitment ?? defaults!.accountRuleSetCommitment,
      "ruleSetCommitment",
    );
    const inspection = params.ruleInspection
      ?? (defaults !== undefined && proposedRuleSetCommitment === defaults.accountRuleSetCommitment
        ? defaultRuleInspection(defaults, params.wallet!.recoveryContract)
        : undefined);
    if (inspection === undefined) {
      throw new Error("a non-default ruleSetCommitment requires inspected rule entries");
    }
    validateReferenceWalletRuleSet({
      expectedRuleSetCommitment: proposedRuleSetCommitment,
      inspection,
      ...(params.irreversibleOverride === undefined
        ? {}
        : { irreversibleOverride: params.irreversibleOverride }),
    });
    const requestedProtocolReceiveKey = params.receiveKey.operation === "replace"
      && params.receiveKey.keyPair === undefined
      ? undefined
      : protocolReceiveKeyUpdate(params.receiveKey);
    // A journaled update may already be included, so the live account's key is
    // canonical only for a new one; a retry is matched against its journal.
    const requestedTargetReceiveKeyHash = existing !== undefined || requestedProtocolReceiveKey === undefined
      ? undefined
      : receiveKeyTarget(proof.account, requestedProtocolReceiveKey);
    // The kernel derives the account's nullifier-key commitment and spends its
    // notes from the root, so every update needs it, custom administration included.
    const nkRoot = params.nkRoot ?? params.wallet?.nkRoot;
    if (nkRoot === undefined) throw new Error("user account updates require nkRoot");
    const feeInputNullifiers = feeInputNotes.map((note) =>
      noteNullifier(nkRoot, note));
    const feeNoteResources = existing === undefined
      ? feeInputNullifiers.map((value) => noteResource(`0x${value.toString(16)}`))
      : existing.inputs.map((input) => noteResource(input.nullifier));
    return withWalletReservation(
      params.store,
      [
        accountResource(address, proof.account.accountRevision),
        ...(params.receiveKey.operation === "replace" ? [FULL_RESCAN_RESOURCE] : []),
        ...feeNoteResources,
      ],
      async (reservation) => {
    if (existing !== undefined) {
      if (
        BigInt(existing.newRuleSetCommitment) !== proposedRuleSetCommitment
        || existing.receiveKeyOperation !== params.receiveKey.operation
        || BigInt(existing.issuanceOwnerCommitment) !== issuanceOwnerCommitment
      ) {
        throw new Error(`user account ${address} has an unresolved different update ${existing.contentHash}`);
      }
      if (params.receiveKey.operation === "replace") {
        if (receiveKeyPairForHash(data, existing.newReceiveKeyHash) === null) {
          throw new Error("pending REPLACE is missing its owned keypair from the durable receive-key keyring");
        }
        if (params.receiveKey.keyPair !== undefined) {
          storedReceiveKeyPair(params.receiveKey.keyPair);
          if (receiveKeyHashHex(params.receiveKey.keyPair) !== existing.newReceiveKeyHash.toLowerCase()) {
            throw new Error(`user account ${address} has an unresolved different update ${existing.contentHash}`);
          }
        }
      }
      let keyringChanged = false;
      if (params.wallet !== undefined) {
        keyringChanged = retainReceiveKeyPair(data, {
          publicKey: params.wallet.mlKemPublicKey,
          secretKey: params.wallet.mlKemSecretKey,
        });
      }
      if (keyringChanged) await reservation.save(data);
      const outcome = await submitDurableAction({
        node: params.node,
        store: params.store,
        data,
        status,
        submission: params.submission,
        reservation,
        callbacks: params,
        action: { contentHash: existing.contentHash, transactionHex: existing.transactionHex, kind: "userAccountUpdate" },
        state: { retry: true },
        isAccepted: () => acceptedReceiptOfKind(params.node, existing.contentHash, "userAccountUpdate", "user account update"),
        isPending: (current) => (current.pendingUserAccountUpdates ?? []).some(
          (pending) => pending.contentHash.toLowerCase() === existing.contentHash.toLowerCase(),
        ),
        ...settlePollOptions(params),
      });
      return resultFromPending(existing, outcome, plan.beneficiary);
    }

    const protocolReceiveKey = requestedProtocolReceiveKey ?? protocolReceiveKeyUpdate(params.receiveKey);
    const targetReceiveKeyHash = requestedTargetReceiveKeyHash ?? receiveKeyTarget(proof.account, protocolReceiveKey);
    let keyringChanged = false;
    if (params.wallet !== undefined) {
      keyringChanged = retainReceiveKeyPair(data, {
        publicKey: params.wallet.mlKemPublicKey,
        secretKey: params.wallet.mlKemSecretKey,
      }) || keyringChanged;
    }
    if (params.receiveKey.operation === "replace") {
      keyringChanged = retainReceiveKeyPairForRescan(data, params.receiveKey.keyPair!) || keyringChanged;
    }
    if (keyringChanged) await reservation.save(data);

    const feeChangeAmount = feeInputNotes.reduce((sum, note) => sum + BigInt(note.amount), 0n)
      - openFeeAmount - resolved.plan.privateRelayFeeAmount;
    const feeReceiveKey = feeChangeAmount > 0n
      ? protocolReceiveKey.operation === "replace"
        ? protocolReceiveKey.mlKemPublicKey
        : registeredSelfReceiveKey(proof.account, data)
      : undefined;
    const validUntilTimestamp = publicationValidUntil({
      chainNow: status.latestBlockTimestamp, defaultWindow: DEFAULT_USER_ACCOUNT_UPDATE_VALIDITY_WINDOW,
      selectedRelayQuote: params.selectedRelayQuote, requested: params.validUntilTimestamp,
      action: "user account update",
    });
    const quotedFee = await prepareAccountPublication({
      node: params.node, status, owner: { address: accountAddress, nkRoot }, publication, inputs: feeInputNotes,
      openFeeAmount, privateRelayFeeAmount: resolved.plan.privateRelayFeeAmount,
      maxTransactionBytes: byteSize,
      issuanceOwnerCommitment, validUntilTimestamp,
      ...(params.selectedRelayQuote === undefined ? {} : { selectedRelayQuote: params.selectedRelayQuote }),
    });
    issuanceOwnerCommitment = quotedFee.issuanceOwnerCommitment;
    const currentReceiveKey = currentReceiveKeyState(proof.account);
    const baseBuildParams: Omit<
      BuildUserAccountUpdateParams,
      "rule" | "readableEcdsa" | "authorization"
    > = {
      network,
      current: {
        address: accountAddress,
        accountRevision: proof.account.accountRevision,
        ruleSetCommitment: BigInt(proof.account.accountRuleSetCommitment),
        receiveKey: currentReceiveKey,
      },
      nkRoot,
      proposed: {
        ruleSetCommitment: proposedRuleSetCommitment,
        receiveKey: protocolReceiveKey,
      },
      recentPcashBlockHash: proof.boundary.blockHash,
      validUntilTimestamp,
      snapshot: snapshotFromAccountProof(proof),
      fee: {
          openFeeAmount,
          ...quotedFee,
          inputs: feeInputNotes.map((note, index) => ({
            noteSecret: BigInt(note.noteSecret),
            amount: BigInt(note.amount),
            leafIndex: Number(note.leafIndex!),
            siblings: outputPaths[index]!.siblings,
          })),
          ...(feeReceiveKey === undefined ? {} : { receiveKey: feeReceiveKey }),
      },
      ...(params.wallet === undefined ? {} : { sender: {
        outgoingKey: params.wallet.outgoingKey,
        directSendOpenings: directSendsToRecord(data, params.wallet.address, feeInputNotes),
      } }),
    };
    let build: UserAccountUpdateBuild;
    if (params.authorizeBuild !== undefined) {
      build = await params.authorizeBuild(baseBuildParams);
    } else {
      if (defaults === undefined || params.wallet === undefined) {
        throw new Error("a custom administration rule requires authorizeBuild");
      }
      if (BigInt(proof.account.accountRuleSetCommitment) !== defaults.accountRuleSetCommitment) {
        throw new Error("a custom installed administration rule requires authorizeBuild");
      }
      if (params.signer === undefined) {
        throw new Error("the reference readable-ECDSA update path requires signer");
      }
      const unsigned = prepareUserAccountUpdate({
        ...baseBuildParams,
        rule: {
          applicationVkHash: defaults.accountAdminRule.applicationVkHash,
          configurationCommitment: defaults.accountAdminRule.configurationCommitment,
          commitmentBlinder: defaults.accountAdminRule.commitmentBlinder,
          entryIndex: defaults.accountAdminRule.entryIndex,
          siblings: defaults.accountAdminRule.siblings,
        },
        readableEcdsa: { signerAddress: params.wallet.address },
      });
      build = await authorizeUserAccountUpdate(unsigned, params.signer);
    }
    const expectedProposedAccountFields = encodeProposedAccountFields({
      address: accountAddress,
      newRuleSetCommitment: proposedRuleSetCommitment,
      receiveKey: protocolReceiveKey,
    });
    if (
      toHex(build.proposedAccountFields) !== toHex(expectedProposedAccountFields)
      || build.publicInputs[PRIVATE_VALUE_PROFILES.S.offsets.chainId] !== params.chainId
      || build.publicInputs[PRIVATE_VALUE_PROFILES.S.offsets.recentBlockHash] !== proof.boundary.blockHash
      || build.publicInputs[PRIVATE_VALUE_PROFILES.S.offsets.openFeeAmount] !== openFeeAmount
      || build.publicInputs[PRIVATE_VALUE_PROFILES.S.offsets.issuanceOwner] !== issuanceOwnerCommitment
    ) throw new Error("authorized user account update does not match the inspected proposal and current boundary");
    if (build.payment.nativeInputs.length !== feeInputNotes.length
      || build.payment.nativeInputs.some((input, index) => input.nullifier !== feeInputNullifiers[index])
    ) throw new Error("authorized user account update does not spend the selected fee notes");
    params.onProgress?.("proving", "generating the user account update proof…");
    const entry = await params.prover.proveAndEncode(build);
    const { contentHash, transactionHex } = transactionIdentity(entry);
    const pending: PendingUserAccountUpdate = {
      contentHash,
      transactionHex,
      address,
      currentAccountRevision: proof.account.accountRevision.toString(),
      newRuleSetCommitment: fieldToHex(proposedRuleSetCommitment),
      receiveKeyOperation: params.receiveKey.operation,
      newReceiveKeyHash: fieldToHex(targetReceiveKeyHash),
      validUntilTimestamp: validUntilTimestamp.toString(),
      openFeeAmount: openFeeAmount.toString(),
      privateRelayFeeAmount: resolved.plan.privateRelayFeeAmount.toString(),
      privateRelayRecipient: quotedFee.privateRelayPayment === undefined ? null
        : addressHex(quotedFee.privateRelayPayment.recipientAddress),
      issuanceOwnerCommitment: issuanceOwnerCommitment.toString(),
      issuanceRecipient: quotedFee.designatedIssuanceOpening === undefined
        ? null
        : addressHex(BigInt(quotedFee.designatedIssuanceOpening.recipientAddress)),
      inputs: feeInputNotes.map((note, index) => ({
        nullifier: bytes32Hex(feeInputNullifiers[index]!),
        spentCommitment: bytes32Hex(BigInt(note.commitment!)),
      })),
      change: build.payment.change === null
        ? null
        : {
          amount: build.payment.change.amount.toString(),
          owner: address,
          noteSecret: bytes32Hex(build.payment.change.noteSecret),
        },
    };
    const changeNote = build.payment.change === null
      ? null
      : {
        outputIndex: build.payment.change.slot,
        assetId: 0n,
        amount: build.payment.change.amount,
        owner: accountAddress,
        noteSecret: build.payment.change.noteSecret,
      };
    const preparedSubmission = await params.submission.preflight({
      transactionBytes: entry,
      status,
      retry: false,
    });
    const outcome = await submitDurableAction({
      node: params.node,
      store: params.store,
      data,
      status,
      submission: params.submission,
      reservation,
      callbacks: params,
      action: { contentHash, transactionHex, kind: "userAccountUpdate" },
      state: {
        retry: false,
        prepared: preparedSubmission,
        validateJournal: async () => {
          const current = await localAccount(params.store, address);
          if (
            current === null
            || current.accountRevision !== proof.account.accountRevision
            || current.accountRuleSetCommitment.toLowerCase() !== proof.account.accountRuleSetCommitment.toLowerCase()
            || current.receiveKeyHash.toLowerCase() !== proof.account.receiveKeyHash.toLowerCase()
          ) throw new Error("the user account changed before the update reservation was written");
        },
        journal: () => {
          addPendingUserAccountUpdate(data, pending);
          if (changeNote !== null) addPendingNote(data, contentHash, changeNote);
        },
        rollback: () => {
          removePendingUserAccountUpdate(data, address);
          removePendingNotesForTransaction(data, contentHash);
        },
      },
      isAccepted: () => acceptedReceiptOfKind(params.node, contentHash, "userAccountUpdate", "user account update"),
      isPending: (current) => (current.pendingUserAccountUpdates ?? []).some(
        (item) => item.contentHash.toLowerCase() === contentHash.toLowerCase(),
      ),
      ...settlePollOptions(params),
    });
    return resultFromPending(pending, outcome, plan.beneficiary);
      },
      existing === undefined ? {} : { allowPendingContentHash: existing.contentHash },
    );
}
