// Deposits to a deposit-mint asset's vault: the codes a wallet gives
// depositors, finding the wallet's deposits, and minting one. A code commits to
// the chain, the asset and the wallet's address under a salt derived from its
// nk root and the code's public nonce, so the wallet finds its deposits by
// reading the vault's `Deposit` logs from Ethereum and keeps no record of the
// codes it gave out. A wallet restored from its seed finds them the same way.
//
// Listing reads every `Deposit` log of the vault with `eth_getLogs`, the same
// requests for every wallet, and asks the node whether the mint markers of the
// wallet's own deposits are spent. Minting reads the deposit's transaction
// receipt from Ethereum, for the log's index within it, and asks the node for
// the log's opening.

import type { Hex } from "viem";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { BN254_SCALAR_MODULUS } from "@pcash/sdk/crypto";
import {
  buildAssetAction,
  openedAssetActionOutput,
  ownerChangeAssetActionOutput,
  type AssetActionInput,
  type AssetActionOutput,
} from "@pcash/sdk/builders";
import { requestPcashAuthorization, type PcashActionSigner, type SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
import {
  assetDefinitionDescriptor,
  dummyNullifier,
  mintMarker,
  nativeBurnAmount,
  networkConfigFromStatus,
  ownerCommitment,
  quoteNativeBurn,
  type AssetDefinition,
  type WalletProfile,
} from "@pcash/sdk/protocol";
import {
  decodeDepositLog,
  DEPOSIT_MINT_RULE_CIRCUIT,
  DEPOSIT_TOPIC0,
  depositLog,
  depositMintWitness,
  depositReplayId,
  depositSalt,
  encodeDepositCode,
  opensRecipientCommitment,
  recipientCommitment,
  recognizeMintRule,
  type DepositEvent,
} from "@pcash/sdk/rules";
import { randomFieldEntropy } from "@pcash/sdk/utils";
import { L1_SNAPSHOT_ATTEMPTS, l1LogRanges, type L1BlockIdentity, type L1ListedLog, type L1LogReader } from "../denyListSync.ts";
import { directSendsToRecord } from "../directSends.ts";
import type { PcashProfile } from "../externalIdentity.ts";
import { selectInputNotes } from "../noteStore.ts";
import { loadWalletStateOrEmpty, type WalletStateStore } from "../store.ts";
import type { AssetCreationProver } from "./assetCreationClient.ts";
import {
  collectAssetActionWitnesses,
  prepareAssetAction,
  submitPreparedAssetAction,
  type AssetActionSubmissionResult,
} from "./assetActionClient.ts";
import { settlePollOptions, type DurableSubmissionAdapter, type DurableSubmissionCallbacks, type SettlePollOptions } from "./durableSubmission.ts";
import { mintMarkersSpent } from "./mintClient.ts";
import {
  actionPublication,
  fixPublication,
  noteNullifier,
  paddedPrivateValueByteSize,
  planPublication,
  privateValueActionUnits,
  publicationOf,
  publicationValidUntil,
  resolvePublicationFunding,
  type ActionPublication,
} from "./publication.ts";
import { registeredSelfReceiveKey } from "./selfDelivery.ts";

/** One of this wallet's deposits to an asset's vault. */
export interface WalletDeposit {
  /**
   * The `Deposit` log's Ethereum block, transaction index, and index among
   * the block's logs as `eth_getLogs` returns it, which is its leaf index in
   * the block's normalized log tree.
   */
  position: { l1BlockNumber: bigint; l1BlockHash: Hex; transactionIndex: number; blockLogIndex: number };
  transactionHash: Hex;
  /** The Ethereum account that deposited; the issuer for a credit. */
  depositor: bigint;
  amount: bigint;
  /** The code's nonce, from which the wallet derives the commitment's salt. */
  nonce: bigint;
  /** The recipient commitment word as the log carries it. */
  recipientCommitment: bigint;
  /** Whether the deposit's mint marker is spent. */
  minted: boolean;
}

/** The vault of a deposit-mint asset. */
function depositVault(definition: AssetDefinition): bigint {
  const rule = recognizeMintRule(definition.mintRule);
  if (rule.kind !== "deposit-mint") throw new Error("this asset is not minted by deposit");
  return rule.configuration.vault;
}

/**
 * A fresh deposit code for a deposit-mint asset: the chain, the asset and the
 * wallet's address committed under the salt of a new random nonce.
 */
export function createDepositCode(params: {
  asset: AssetDefinition;
  wallet: Pick<WalletProfile, "address" | "nkRoot">;
  chainId: bigint;
}): string {
  const vault = depositVault(params.asset);
  const assetId = assetDefinitionDescriptor(params.asset).assetId;
  const nonce = randomFieldEntropy();
  const salt = depositSalt(params.wallet.nkRoot, params.chainId, vault, nonce);
  return encodeDepositCode({
    pcashChainId: params.chainId, vault, recipientCommitment: recipientCommitment(params.chainId, assetId, params.wallet.address, salt), nonce,
  });
}

/** The node answers at most this many nullifiers per query. */
const NULLIFIERS_PER_QUERY = 256;

/** A deposit found in the vault's logs, with its replay ID; its minted status is read on each listing. */
type FoundDeposit = Omit<WalletDeposit, "minted"> & { replayId: bigint };

/**
 * What earlier listings of one asset read: the vault's `Deposit` logs through
 * one Ethereum block, and this wallet's deposits among them, oldest first.
 */
export interface DepositScan {
  scannedThrough: bigint;
  /** The hash of block `scannedThrough`; a later listing resumes only while it is canonical. */
  scannedHash: Hex;
  deposits: readonly FoundDeposit[];
}

/** One wallet's deposit scans, keyed by asset ID. */
export type DepositScans = Map<bigint, DepositScan>;

/**
 * This wallet's deposits to `asset`'s vault in the Ethereum blocks PCASH has
 * derived, oldest first. A log the rule cannot open is no deposit. The vault's
 * logs are read from the network's genesis Ethereum block on the first call
 * for an asset, and later calls read only the blocks after the last one
 * `scans` holds, unless that block is no longer canonical. Whether each
 * deposit is minted is read from `node`, which so learns the mint markers
 * this wallet asks about.
 */
export async function listDeposits(params: {
  reader: L1LogReader;
  node: PcashNodeClient;
  wallet: Pick<WalletProfile, "address" | "nkRoot">;
  chainId: bigint;
  asset: AssetDefinition;
  scans: DepositScans;
}): Promise<WalletDeposit[]> {
  const assetId = assetDefinitionDescriptor(params.asset).assetId;
  const found = await scanDeposits({ ...params, assetId, vault: depositVault(params.asset) });
  const spent: boolean[] = [];
  for (let start = 0; start < found.length; start += NULLIFIERS_PER_QUERY) {
    spent.push(...await mintMarkersSpent(params.node, assetId,
      found.slice(start, start + NULLIFIERS_PER_QUERY).map((deposit) => deposit.replayId)));
  }
  return found.map(({ replayId: _replayId, ...deposit }, index) => ({ ...deposit, minted: spent[index]! }));
}

/** The deposits `scans` holds for the asset, brought through the last Ethereum block PCASH has derived. */
async function scanDeposits(params: {
  reader: L1LogReader;
  node: PcashNodeClient;
  wallet: Pick<WalletProfile, "address" | "nkRoot">;
  chainId: bigint;
  assetId: bigint;
  vault: bigint;
  scans: DepositScans;
}): Promise<readonly FoundDeposit[]> {
  const { reader, wallet, chainId, assetId, vault } = params;
  const status = await params.node.status();
  for (let attempt = 1; ; attempt += 1) {
    // PCASH block N is derived from Ethereum block genesisL1Block + N.
    const derived = status.genesisL1Block + status.latestBlock;
    const head = await reader.head();
    const target: L1BlockIdentity | null = head.number <= derived ? head : await reader.block(derived);
    if (target === null) throw new Error("the Ethereum endpoint has no block PCASH derived");
    const cached = params.scans.get(assetId);
    if (cached?.scannedHash === target.hash) return cached.deposits;
    const resumes = cached !== undefined && cached.scannedThrough <= target.number
      && (await reader.block(cached.scannedThrough))?.hash === cached.scannedHash;
    const deposits = resumes ? [...cached.deposits] : [];
    const from = resumes ? cached.scannedThrough + 1n : status.genesisL1Block;
    for (const range of l1LogRanges(from, target.number)) {
      for (const listed of await reader.logs({ address: vault, topics: [DEPOSIT_TOPIC0], ...range })) {
        const deposit = ownDeposit(listed, { wallet, chainId, assetId, vault });
        if (deposit !== undefined) deposits.push(deposit);
      }
    }
    // Logs are read by block number; the target's unchanged hash shows they all came from its chain.
    if ((await reader.block(target.number))?.hash !== target.hash) {
      if (attempt < L1_SNAPSHOT_ATTEMPTS) continue;
      throw new Error("Ethereum reorganized while deposits were read; try again");
    }
    params.scans.set(assetId, { scannedThrough: target.number, scannedHash: target.hash, deposits });
    return deposits;
  }
}

/** The deposit `listed` carries if its recipient commitment opens to this wallet on the chain and asset. */
function ownDeposit(listed: L1ListedLog, params: {
  wallet: Pick<WalletProfile, "address" | "nkRoot">;
  chainId: bigint;
  assetId: bigint;
  vault: bigint;
}): FoundDeposit | undefined {
  let event: DepositEvent;
  try {
    event = decodeDepositLog(listed);
  } catch {
    return undefined;
  }
  // A code's nonce is a field element.
  if (event.nonce >= BN254_SCALAR_MODULUS) return undefined;
  const salt = depositSalt(params.wallet.nkRoot, params.chainId, params.vault, event.nonce);
  if (!opensRecipientCommitment(event.recipientCommitment, params.chainId, params.assetId, params.wallet.address, salt)) return undefined;
  return {
    position: {
      l1BlockNumber: listed.blockNumber, l1BlockHash: listed.blockHash,
      transactionIndex: listed.transactionIndex, blockLogIndex: listed.blockLogIndex,
    },
    transactionHash: listed.transactionHash,
    ...event,
    replayId: depositReplayId(listed.blockNumber, listed.blockLogIndex, salt),
  };
}

export interface DepositMintIntent extends DurableSubmissionCallbacks {
  /** The definition of a deposit-mint asset. */
  asset: AssetDefinition;
  /** One of this wallet's deposits, as `listDeposits` returns it. */
  deposit: WalletDeposit;
  validUntilTimestamp?: bigint;
  openFeeAmount?: bigint;
  privateRelayFeeAmount?: bigint;
  /** Native PCASH to burn beyond the quoted protocol fee. */
  voluntaryBurnAmount?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
}

/**
 * Mint one deposit to this wallet's own address: one mint marker, one asset
 * output of the deposited amount, and native inputs and change for the fee.
 * The account approves with its readable mint rule; the deposit-mint rule opens
 * the deposit log under the action's anchor. The log's index within its
 * receipt is read from `reader`, which so learns the deposit's transaction,
 * and its opening from the node, which so learns the deposit's position.
 */
export async function runDepositMintClient<Prepared, Output>(params: DepositMintIntent & SettlePollOptions & {
  reader: L1LogReader;
  node: PcashNodeClient;
  store: WalletStateStore;
  wallet: PcashProfile;
  signer: PcashActionSigner;
  chainId: bigint;
  prover: AssetCreationProver;
  submission: DurableSubmissionAdapter<Prepared, Output>;
}): Promise<AssetActionSubmissionResult<Output> & { publicationDetails: ActionPublication; assetId: bigint }> {
  const profile = PRIVATE_VALUE_PROFILES.S;
  const descriptor = assetDefinitionDescriptor(params.asset);
  const assetId = descriptor.assetId;
  const vault = depositVault(params.asset);
  const { deposit } = params;
  const { l1BlockNumber, l1BlockHash, transactionIndex, blockLogIndex } = deposit.position;
  const salt = depositSalt(params.wallet.nkRoot, params.chainId, vault, deposit.nonce);
  const replayId = depositReplayId(l1BlockNumber, blockLogIndex, salt);
  if ((await mintMarkersSpent(params.node, assetId, [replayId]))[0]) throw new Error("this deposit is already minted");
  const status = await params.node.status();
  const data = await loadWalletStateOrEmpty(params.store, {
    address: params.wallet.address, network: { chainId: params.chainId, genesisHash: status.genesisHash },
  });
  const plan = await planPublication({
    qualifying: true, byteSize: null, publication: publicationOf(params.submission, params.privateRelayFeeAmount), node: params.node,
    openFeeAmount: params.openFeeAmount, privateRelayFeeAmount: params.privateRelayFeeAmount,
    burn: quoteNativeBurn(status.feeExcess, privateValueActionUnits(profile.shapeId, undefined), params.voluntaryBurnAmount ?? 0n),
    selectedRelayQuote: params.selectedRelayQuote,
  });
  const nativeSlots = profile.inputs - 1;
  const { funding: nativeNotes } = resolvePublicationFunding(plan, (fee) => fee === 0n ? [] : selectInputNotes(data, undefined, fee, nativeSlots));

  params.onProgress?.("preparing", "reading the minting account…");
  const witnesses = await collectAssetActionWitnesses({
    node: params.node, store: params.store, wallet: params.wallet, authorizationKind: "mint",
    inputOpenings: nativeNotes.map((note) => ({ outputIndex: BigInt(note.leafIndex!), outputCommitment: BigInt(note.commitment!) })),
  });
  const logIndex = await params.reader.receiptLogIndex({ blockHash: l1BlockHash, transactionHash: deposit.transactionHash, blockLogIndex });
  const log = depositLog({ ...deposit, vault, transactionIndex, logIndex });
  const proof = await params.node.getL1LogProof(witnesses.anchor.blockHash, l1BlockNumber, transactionIndex, logIndex, log);
  const receiveKey = registeredSelfReceiveKey(witnesses.account, data);
  // The readable mint rule declares every minted unit, the wallet's own included.
  const minted = openedAssetActionOutput({
    kind: "asset", pcashChainId: params.chainId, assetId, outputIndex: 0, amount: deposit.amount,
    recipientAddress: params.wallet.address, recipientMlKemPublicKey: receiveKey, authenticatedRecipient: true,
    assetDefinition: params.asset, change: true,
  });
  const dummy = (): AssetActionOutput => ({ kind: "dummy", dummySecret: randomFieldEntropy(), amount: 0n });
  const dummyInputSeed = randomFieldEntropy();
  const inputs: AssetActionInput[] = [
    { kind: "mint-marker", replayId },
    ...nativeNotes.map((note, index) => ({
      kind: "native" as const, amount: BigInt(note.amount), noteSecret: BigInt(note.noteSecret),
      leafIndex: Number(note.leafIndex!), siblings: witnesses.inputSiblings[index]!,
    })),
  ];
  while (inputs.length < profile.inputs) inputs.push({ kind: "dummy" });
  const nullifiers = inputs.map((input, slot) => input.kind === "mint-marker" ? mintMarker(assetId, replayId)
    : input.kind === "native" ? noteNullifier(params.wallet.nkRoot, nativeNotes[slot - 1]!)
    : dummyNullifier(dummyInputSeed, slot));
  const validUntilTimestamp = publicationValidUntil({
    chainNow: witnesses.status.latestBlockTimestamp, defaultWindow: 1800n,
    selectedRelayQuote: params.selectedRelayQuote, requested: params.validUntilTimestamp, action: "mint",
  });
  const publication = await fixPublication({
    maxTransactionBytes: paddedPrivateValueByteSize(profile.shapeId, undefined),
    selectedRelayQuote: params.selectedRelayQuote, publication: plan.publication, owner: params.wallet,
    requestedCommitment: 0n, node: params.node, status: witnesses.status, nullifiers,
    shape: profile.shapeId, openFeeAmount: plan.openFeeAmount,
    privateRelayFeeAmount: plan.privateRelayFeeAmount, validUntilTimestamp,
  });
  const nativeTotal = nativeNotes.reduce((sum, note) => sum + BigInt(note.amount), 0n);
  const changeAmount = nativeTotal - plan.openFeeAmount - plan.privateRelayFeeAmount - nativeBurnAmount(plan.burn);
  const outputs: AssetActionOutput[] = [minted];
  if (changeAmount !== 0n) {
    outputs.push(ownerChangeAssetActionOutput({ kind: "native", pcashChainId: params.chainId, assetId: 0n, amount: changeAmount, receiveKey }));
  }
  // A relay payment takes the last slot; without one, dummies fill every free slot.
  while (outputs.length < profile.outputs - (publication.privateRelayPayment === undefined ? 0 : 1)) outputs.push(dummy());
  let privateRelayOwnerCommitment = 0n;
  if (publication.privateRelayPayment !== undefined) {
    const feeOutput = openedAssetActionOutput({
      kind: "native", pcashChainId: params.chainId, assetId: 0n, outputIndex: profile.outputs - 1,
      amount: publication.privateRelayPayment.amount, recipientAddress: publication.privateRelayPayment.recipientAddress,
      recipientMlKemPublicKey: publication.privateRelayPayment.receiveKey, authenticatedRecipient: true,
    });
    if (feeOutput.kind !== "native" || feeOutput.destination.kind !== "opening") throw new Error("selected relay fee has no owner opening");
    privateRelayOwnerCommitment = ownerCommitment(feeOutput.destination.recipientAddress, feeOutput.destination.noteSecret);
    outputs.push(feeOutput);
  }
  const build = buildAssetAction({
    pcashChainId: params.chainId, snapshot: witnesses.snapshot, owner: witnesses.owner,
    mint: { descriptor },
    inputs, outputs,
    openFeeAmount: plan.openFeeAmount,
    burn: plan.burn,
    issuanceOwnerCommitment: publication.issuanceOwnerCommitment,
    ...(publication.designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening: publication.designatedIssuanceOpening }),
    ...(publication.privateRelayPayment === undefined ? {} : { privateRelayPayment: {
      amount: publication.privateRelayPayment.amount, ownerCommitment: privateRelayOwnerCommitment,
    } }),
    dummyInputSeed, validUntilTimestamp, assetDefinition: params.asset,
    sender: { outgoingKey: params.wallet.outgoingKey, directSendOpenings: directSendsToRecord(data, params.wallet.address, nativeNotes) },
  });
  // Built before the signature request, so a deposit the rule would refuse asks for no signature.
  const mintRule = { packageName: DEPOSIT_MINT_RULE_CIRCUIT, witnessMap: depositMintWitness({
    mint: build, configuration: { vault }, log, opening: { ...proof, logsRoot: proof.l1LogsRoot, logCount: proof.l1LogCount },
    recipientAddress: params.wallet.address, salt, noteSecret: build.outputNoteSecrets[0]!,
  }) };
  const authorization = build.prepareOwnerAuthorization({ wallet: params.wallet, network: networkConfigFromStatus(witnesses.status) });
  const signed = authorization.authorize(await requestPcashAuthorization(params.signer, authorization.request));
  params.onProgress?.("proving", "proving the authorized mint…");
  const entry = await params.prover.proveAndEncode(build, signed.witnessMap, mintRule);
  const preparedAction = prepareAssetAction({
    build, transactionBytes: entry, ...publication,
    ...(publication.privateRelayPayment === undefined ? {} : { privateRelayRecipient: publication.privateRelayPayment.recipientAddress }),
    privateRelayFeeAmount: plan.privateRelayFeeAmount,
    ownedOutputs: [
      { outputIndex: 0, assetId, owner: params.wallet.address, noteSecret: build.outputNoteSecrets[0]!, amount: deposit.amount },
      ...(changeAmount === 0n ? [] : [{ outputIndex: 1, assetId: 0n, owner: params.wallet.address,
        noteSecret: build.outputNoteSecrets[1]!, amount: changeAmount }]),
    ],
  });
  const preparedSubmission = await params.submission.preflight({ transactionBytes: entry, status: witnesses.status, retry: false });
  const result = await submitPreparedAssetAction({
    node: params.node, store: params.store, data, status: witnesses.status, preparedAction,
    submission: params.submission, preparedSubmission, callbacks: params, ...settlePollOptions(params),
  });
  return { ...result, publicationDetails: actionPublication(preparedAction.pending, plan.beneficiary), assetId };
}
