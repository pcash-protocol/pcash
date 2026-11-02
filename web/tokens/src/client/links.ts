// Claim links, creator and claimant sides.
//
// A creator's link set is a stored nonce plus terms. Its secret re-derives from
// the wallet's nullifier key root, so every link key, the contract, and every
// note opening come back after a reload; the steps (publish the contract, fund
// one note per link) resume from chain and wallet state.

import {
  formatAssetDefinition,
  parseAssetDefinition,
  type AssetDefinition,
} from "@pcash/sdk/protocol";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { looksLikeExtendedCode, parseExtendedCode, resolveRecipientAddress, resolveRecipientDelivery } from "@pcash/sdk/delivery";
import {
  assertReceiveKeyOwned,
  loadReceiveKeyAtSnapshot,
  loadSelfAccountAtSnapshot,
  registeredSelfReceiveKey,
  userAccountCreationAttachment,
} from "@pcash/sdk/wallet/actions";
import { nativeBurnAmount, networkConfigFromStatus, RECENT_PCASH_BLOCK_WINDOW_SECONDS, type AccountCreationAttachment } from "@pcash/sdk/protocol";
import { pollReceipt, type PcashNodeClient } from "@pcash/sdk/clients";
import { addressHex, bytes32Hex, randomFieldEntropy } from "@pcash/sdk/utils";
import {
  buildClaimLinkSpend,
  claimLinkSpendSpec,
  claimLinkAssetId,
  claimLinkContractOf,
  claimLinkContract,
  claimLinkContractSeed,
  claimLinkNote,
  claimLinkSetSecret,
  formatClaimLinkUrl,
  parseClaimLink,
  planClaimLinks,
  type ClaimLink,
  type ClaimLinkContract,
  type ClaimLinkNote,
} from "../link.ts";
import { sponsoredTemplatePrimary } from "../template.ts";
import { TOKENS_CIRCUITS } from "../circuits.ts";
import { fundedLeaves, fundedOutputs, readClaimLink, readTemplateWitness } from "../witness.ts";
import {
  awaitIncluded,
  notify,
  planRole,
  proveAndSubmit,
  resumeTemplateAction,
  templateRole,
  submitSponsoredTemplate,
  templateNetworkFee,
  usesSponsorship,
  walletRecipient,
  walletSender,
  type RolePlan,
  type TemplateRun,
  type TemplateSubmission,
  type TokensActionCallbacks,
  type TokensProgressCallback,
} from "./action.ts";
import { TokensError } from "./errors.ts";
import {
  fundContractNotes,
  ownRecords,
  patchRecord,
  requireRecord,
  walletNkRoot,
  walletPcash,
  walletToken,
  withWallet,
  type TokensRuntime,
} from "./runtime.ts";
import { recoverTokenRecords } from "./recovery.ts";
import { linkSetRecoveryTag } from "./recoveryTag.ts";
import { linkSetKey, type LinkSetRecord } from "./store.ts";

/** Validity window for a claim, from the chain's latest block time. */
export const TOKENS_VALIDITY_WINDOW_SECONDS = 1_800n;
const S_INPUTS = PRIVATE_VALUE_PROFILES.S.inputs;

export type LinkSetPhase = "creating-contract" | "funding" | "ready";

export interface LinkSetView {
  key: string;
  assetId: bigint;
  /** Null for native PCASH. */
  definition: AssetDefinition | null;
  contractAddress: string;
  phase: LinkSetPhase;
  links: { index: number; amount: bigint }[];
  /** Content hashes of the transactions that funded the links, lowercase; empty until the set is ready. */
  fundingContentHashes: string[];
  createdAt: number;
}

/** A claimed link was spent by someone else; a taken-back link was spent into this wallet. */
export type LinkClaimState = "unclaimed" | "claimed" | "taken-back";

export interface LinkClaim {
  index: number;
  amount: bigint;
  state: LinkClaimState;
  /** The transaction that spent the link, once the node names it. */
  transactionId?: string;
}

export interface LinkSetStatus extends LinkSetView {
  /** Present once the set is ready. */
  claims: LinkClaim[] | null;
}

function linkSetDefinition(record: LinkSetRecord): AssetDefinition | null {
  return record.definition === null ? null : parseAssetDefinition(record.definition);
}

/** The open fee and burn a native claim pays from its links, which must leave the claimant a positive amount. */
function assertFeeLeavesPayout(native: boolean, plan: RolePlan, value: bigint): void {
  if (native && plan.openFeeAmount + nativeBurnAmount(plan.burn) >= value) {
    throw new TokensError("fee-exceeds-link", "The network fee is as large as the link's value, so nothing would be left to receive.");
  }
}

function linkSetIndexes(record: LinkSetRecord): number[] {
  const indexes = record.funding === undefined
    ? record.amounts.map((_, index) => index)
    : record.funding.flatMap(chunk => Array.from({ length: chunk.count }, (_, slot) => chunk.firstIndex + slot));
  if (indexes.length !== record.amounts.length || new Set(indexes).size !== indexes.length) {
    throw new Error("link funding indexes do not match its amounts");
  }
  return indexes;
}

function linkSetPlan(record: LinkSetRecord, nkRoot: bigint) {
  return planClaimLinks({
    creatorSecret: claimLinkSetSecret(nkRoot, BigInt(record.nonce)),
    assetId: BigInt(record.assetId),
    amounts: record.amounts.map(BigInt),
    indexes: linkSetIndexes(record),
  });
}

function linkSetContract(record: LinkSetRecord, nkRoot: bigint): ClaimLinkContract {
  return claimLinkContract({
    contractSeed: claimLinkContractSeed(claimLinkSetSecret(nkRoot, BigInt(record.nonce))),
    assetId: BigInt(record.assetId),
  });
}

function linkSetView(record: LinkSetRecord, contract: ClaimLinkContract): LinkSetView {
  const indexes = linkSetIndexes(record);
  return {
    key: record.key,
    assetId: BigInt(record.assetId),
    definition: linkSetDefinition(record),
    contractAddress: addressHex(contract.address),
    phase: record.funding !== undefined ? "ready" : record.fundingJobId !== undefined ? "funding" : "creating-contract",
    links: record.amounts.map((amount, position) => ({ index: indexes[position]!, amount: BigInt(amount) })),
    fundingContentHashes: (record.funding ?? []).map((chunk) => chunk.contentHash.toLowerCase()),
    createdAt: record.createdAt,
  };
}

/** Store a new link set of a token, or of native PCASH under asset ID 0, then run it to ready. */
export async function createLinkSet<Prepared, Output>(rt: TokensRuntime<Prepared, Output>, params: {
  assetId: bigint;
  amounts: readonly bigint[];
  openFeeAmount?: bigint;
  onCreated?: (key: string) => void;
  onProgress?: TokensProgressCallback;
}): Promise<LinkSetView> {
  if (params.amounts.length === 0) throw new Error("a link set needs at least one link");
  const total = params.amounts.reduce((sum, amount) => sum + amount, 0n);
  let definition: AssetDefinition | null = null;
  if (params.assetId === 0n) await walletPcash(rt, total);
  else definition = await walletToken(rt, params.assetId, total);
  const nonce = bytes32Hex(randomFieldEntropy());
  const key = linkSetKey(rt.wallet.network.chainId, rt.wallet.address, nonce);
  const now = rt.now();
  const record: LinkSetRecord = {
    kind: "links",
    key,
    chainId: rt.wallet.network.chainId.toString(),
    creator: rt.wallet.address,
    nonce,
    assetId: params.assetId.toString(),
    definition: definition === null ? null : formatAssetDefinition(definition),
    amounts: params.amounts.map(String),
    ...(params.openFeeAmount === undefined ? {} : { openFeeAmount: params.openFeeAmount.toString() }),
    createdAt: now,
    updatedAt: now,
  };
  // Planning checks the terms before anything is stored.
  linkSetPlan(record, await walletNkRoot(rt));
  await rt.store.update(key, () => record);
  params.onCreated?.(key);
  return advanceLinkSet(rt, key, params.onProgress);
}

/** Run a stored link set's remaining steps: publish the contract, then fund every link. */
export async function advanceLinkSet<Prepared, Output>(
  rt: TokensRuntime<Prepared, Output>,
  key: string,
  onProgress?: TokensProgressCallback,
): Promise<LinkSetView> {
  let record = await requireRecord<LinkSetRecord>(rt, key, "links");
  const plan = linkSetPlan(record, await walletNkRoot(rt));
  if (record.funding === undefined) {
    const openFeeAmount = record.openFeeAmount === undefined ? undefined : BigInt(record.openFeeAmount);
    const funding = await fundContractNotes(rt, key, {
      contract: plan.contract,
      assetId: BigInt(record.assetId),
      notes: plan.links.map((link) => ({ noteSecret: link.noteSecret, amount: link.amount })),
      jobId: record.fundingJobId,
      recoveryTag: linkSetRecoveryTag(BigInt(record.nonce)),
      openFeeAmount,
    }, onProgress);
    record = await patchRecord<LinkSetRecord>(rt, key, (current) => ({ ...current, funding }));
  } else if (record.fundingJobId !== undefined && typeof rt.wallet.bulkJobs === "function") {
    const job = (await rt.wallet.bulkJobs()).find((candidate) => candidate.jobId === record.fundingJobId);
    if (job?.chunks.some((chunk) => chunk.outcome === "unresolved")) await rt.wallet.sync?.();
  }
  return linkSetView(record, plan.contract);
}

async function reconcileLinkSetRecord<Prepared, Output>(rt: TokensRuntime<Prepared, Output>, record: LinkSetRecord): Promise<LinkSetRecord> {
  if (record.funding !== undefined || record.fundingJobId === undefined || typeof rt.wallet.bulkJobs !== "function") return record;
  const job = (await rt.wallet.bulkJobs()).find((candidate) => candidate.jobId === record.fundingJobId);
  const assigned = job?.chunks.reduce((sum, chunk) => sum + chunk.recipientCount, 0) ?? 0;
  if (job === undefined || job.chunks.length === 0 || assigned !== record.amounts.length) return record;
  const accepted = await Promise.all(job.chunks.map(async (chunk) =>
    chunk.outcome === "succeeded" || (await pollReceipt(rt.node, chunk.contentHash.toLowerCase()))?.outcome === "succeeded"));
  if (accepted.some((ok) => !ok)) return record;
  const funding = job.chunks.map((chunk) => {
    const indexes = job.recovery?.originalIndexes.slice(chunk.firstRecipient, chunk.firstRecipient + chunk.recipientCount)
      ?? Array.from({ length: chunk.recipientCount }, (_, offset) => chunk.firstRecipient + offset);
    return { contentHash: chunk.contentHash.toLowerCase(), firstIndex: indexes[0]!, count: chunk.recipientCount };
  });
  return patchRecord<LinkSetRecord>(rt, record.key, (current) => ({ ...current, funding }));
}

async function loadedLinkSetRecord<Prepared, Output>(rt: TokensRuntime<Prepared, Output>, key: string): Promise<LinkSetRecord> {
  const record = await requireRecord<LinkSetRecord>(rt, key, "links");
  if (record.funding !== undefined) return record;
  await recoverTokenRecords(rt);
  return reconcileLinkSetRecord(rt, await requireRecord<LinkSetRecord>(rt, key, "links"));
}

/** This wallet's link sets on its chain, newest first. */
export async function linkSets<Prepared, Output>(rt: TokensRuntime<Prepared, Output>): Promise<LinkSetView[]> {
  await recoverTokenRecords(rt);
  const raw = await ownRecords<LinkSetRecord>(rt, "links");
  if (raw.length === 0) return [];
  const records = await Promise.all(raw.map((record) => reconcileLinkSetRecord(rt, record)));
  const nkRoot = await walletNkRoot(rt);
  return records.map((record) => linkSetView(record, linkSetContract(record, nkRoot)));
}

function readyLinks(record: LinkSetRecord, nkRoot: bigint): { contract: ClaimLinkContract; links: ClaimLink[] } {
  if (record.funding === undefined) throw new TokensError("pending", "This link set is not funded yet.");
  const plan = linkSetPlan(record, nkRoot);
  const definition = linkSetDefinition(record);
  const outputs = fundedOutputs(record.funding);
  return {
    contract: plan.contract,
    links: plan.links.map((link, index) => ({
      contractSeed: plan.contract.contractSeed,
      funding: outputs[index]!,
      amount: link.amount,
      linkKey: link.linkKey,
      definition,
    })),
  };
}

/** A ready set's link notes at their current leaves. */
async function linkNotes(node: PcashNodeClient, contract: ClaimLinkContract, links: readonly ClaimLink[]): Promise<ClaimLinkNote[]> {
  const leaves = await fundedLeaves(node, links.map((link) => link.funding));
  return links.map((link, index) => {
    const leafIndex = leaves[index];
    if (leafIndex === null || leafIndex === undefined) throw new TokensError("pending", "A funding transaction is not on chain right now; try again shortly.");
    return claimLinkNote(contract, { ...link, leafIndex });
  });
}

/** A link's note at its current leaf, or null while its funding is not accepted. */
async function linkNote(node: PcashNodeClient, contract: ClaimLinkContract, link: ClaimLink): Promise<ClaimLinkNote | null> {
  const [leafIndex] = await fundedLeaves(node, [link.funding]);
  return leafIndex === null || leafIndex === undefined ? null : claimLinkNote(contract, { ...link, leafIndex });
}

/** Every link of a ready set as a claim URL on `claimPageUrl`, in link order. */
export async function linkSetUrls<Prepared, Output>(
  rt: TokensRuntime<Prepared, Output>,
  key: string,
  claimPageUrl: string,
): Promise<string[]> {
  const record = await loadedLinkSetRecord(rt, key);
  return readyLinks(record, await walletNkRoot(rt)).links.map((link) => formatClaimLinkUrl(link, claimPageUrl));
}

/**
 * Which links of a set have been spent, from the node's current nullifier set.
 * A link whose spending transaction created a note this wallet holds came back
 * to it: taken back. The wallet's notes survive a restore, so this does too.
 */
export async function linkSetStatus<Prepared, Output>(rt: TokensRuntime<Prepared, Output>, key: string): Promise<LinkSetStatus> {
  const record = await loadedLinkSetRecord(rt, key);
  const nkRoot = await walletNkRoot(rt);
  if (record.funding === undefined) return { ...linkSetView(record, linkSetContract(record, nkRoot)), claims: null };
  const { contract, links } = readyLinks(record, nkRoot);
  const view = linkSetView(record, contract);
  const nullifiers = (await linkNotes(rt.node, contract, links)).map((note) => bytes32Hex(note.nullifier));
  const { statuses } = await rt.node.getCurrentNullifierStatuses(nullifiers);
  const [spenders, ownLeaves] = await Promise.all([
    Promise.all(statuses.map((status, index) => status.spent ? rt.node.getTransactionByNullifier(nullifiers[index]!) : null)),
    statuses.some((status) => status.spent)
      ? rt.wallet.notes().then((notes) => notes.flatMap((note) => note.leafIndex === null ? [] : [note.leafIndex]))
      : [],
  ]);
  return {
    ...view,
    claims: links.map((link, index): LinkClaim => {
      const claim = { index: view.links[index]!.index, amount: link.amount };
      if (!statuses[index]!.spent) return { ...claim, state: "unclaimed" };
      const spender = spenders[index]?.summary;
      if (spender === undefined) return { ...claim, state: "claimed" };
      const start = spender.outputLeafStart;
      const returned = start !== null && ownLeaves.some((leaf) => leaf >= start && leaf < start + spender.outputsAdded);
      return { ...claim, state: returned ? "taken-back" : "claimed", transactionId: spender.transactionId.toLowerCase() };
    }),
  };
}

export interface UnclaimedLinksClaim extends TemplateSubmission {
  /** Link indexes this transaction claims for the creator. */
  claimed: number[];
  /** Links still unclaimed after it. */
  remaining: number;
}

/**
 * Claim up to four still-unclaimed links (fewer when this wallet pays a token
 * claim's relay fee or network fee) into the creator's wallet. The creator
 * holds every link, so this is an ordinary claim; a link someone else already
 * claimed is theirs. Native links pay any relay fee and network fee from their
 * own value. Call again while `remaining` is positive.
 */
export async function claimUnclaimedLinks<Prepared, Output>(rt: TokensRuntime<Prepared, Output>, key: string, options: {
  openFeeAmount?: bigint;
} & TokensActionCallbacks = {}): Promise<UnclaimedLinksClaim> {
  const record = await requireRecord<LinkSetRecord>(rt, key, "links");
  const originalIndexes = linkSetIndexes(record);
  const native = record.definition === null;
  const sponsored = await withWallet(rt, "claim-unclaimed-links-retry", options, async (run) => {
    if (native || !usesSponsorship(run, options.openFeeAmount, templateNetworkFee(run.ctx.status))) return null;
    const { contract, links } = readyLinks(record, run.ctx.profile.nkRoot);
    const notes = await linkNotes(run.ctx.node, contract, links);
    const resumed = await resumeTemplateAction(run, notes.map((note) => note.nullifier), run.ctx.profile.address);
    const { statuses } = await run.ctx.node.getCurrentNullifierStatuses(notes.map((note) => bytes32Hex(note.nullifier)));
    const unclaimed = links.flatMap((_, index) => statuses[index]!.spent ? [] : [index]);
    if (resumed !== null) {
      const submission = await awaitIncluded(run, resumed.submission);
      const inFlight = new Set(resumed.nullifiers);
      const claimed = notes.flatMap((note, index) => inFlight.has(note.nullifier) ? [index] : []);
      return { result: { ...submission, claimed, remaining: unclaimed.filter((index) => !claimed.includes(index)).length } };
    }
    if (unclaimed.length === 0) throw new TokensError("links-all-claimed", "Every link in this set has been claimed.");
    const plan = await planRole(run, { freeInputs: S_INPUTS - 1, openFeeAmount: options.openFeeAmount });
    const batch = unclaimed.slice(0, S_INPUTS - plan.feeNotes.length);
    return { contract, links, notes, batch, remaining: unclaimed.length - batch.length };
  });
  if (sponsored !== null) {
    if ("result" in sponsored && sponsored.result !== undefined) {
      return { ...sponsored.result, claimed: sponsored.result.claimed.map(position => originalIndexes[position]!) };
    }
    const { contract, links, notes, batch, remaining } = sponsored;
    const recipientAddress = BigInt(rt.wallet.address);
    const submission = await submitSponsoredTemplate(rt, {
      contract: contract.address,
      reservedInputSlots: batch.map((_, slot) => slot),
      reservedOutputSlots: [0],
      snapshotQuery: {
        outputs: batch.map((index) => ({ outputIndex: BigInt(notes[index]!.leafIndex), outputCommitment: notes[index]!.outputCommitment })),
        nullifiers: batch.map((index) => bytes32Hex(notes[index]!.nullifier)),
      },
      primary: (context) => {
        if (context.snapshot.outputs === null || context.snapshot.nullifiers.statuses.some((status) => status.spent)) {
          throw new TokensError("link-claimed", "One of these links was claimed first.");
        }
        const spec = claimLinkSpendSpec({
          contract,
          pcashChainId: rt.wallet.network.chainId,
          snapshot: context.roots,
          contractOpening: { accountIndex: Number(context.contractAccount.account.index), accountSiblings: context.contractAccount.accountSiblings },
          notes: batch.map((index, position) => ({ ...links[index]!, leafIndex: notes[index]!.leafIndex, siblings: context.outputPaths[position]!.siblings })),
          recipient: { address: recipientAddress, receiveKey: context.selfReceiveKey(), self: true },
          role: { kind: "transfer" },
          validUntilTimestamp: context.status.latestBlockTimestamp + TOKENS_VALIDITY_WINDOW_SECONDS,
          assetDefinition: links[0]!.definition,
        });
        return sponsoredTemplatePrimary(spec, { circuitUrl: TOKENS_CIRCUITS.claimLink, label: "claim-link function" }, [0]);
      },
      prover: rt.prover,
      openFeeAmount: options.openFeeAmount,
      claimLinkRecipient: recipientAddress,
    }, options);
    return { ...submission, claimed: batch.map(position => originalIndexes[position]!), remaining };
  }
  return withWallet(rt, "claim-unclaimed-links", options, async (run) => {
    const { contract, links } = readyLinks(record, run.ctx.profile.nkRoot);
    const notes = await linkNotes(run.ctx.node, contract, links);
    const resumed = await resumeTemplateAction(run, notes.map((note) => note.nullifier), run.ctx.profile.address);
    const unclaimedNow = async (): Promise<number[]> => {
      const { statuses } = await run.ctx.node.getCurrentNullifierStatuses(notes.map((note) => bytes32Hex(note.nullifier)));
      return links.flatMap((_, index) => statuses[index]!.spent ? [] : [index]);
    };
    if (resumed !== null) {
      const submitted = await awaitIncluded(run, resumed.submission);
      const inFlight = new Set(resumed.nullifiers);
      const claimed = notes.flatMap((note, index) => inFlight.has(note.nullifier) ? [index] : []);
      return { ...submitted, claimed: claimed.map(position => originalIndexes[position]!),
        remaining: (await unclaimedNow()).filter((index) => !claimed.includes(index)).length };
    }
    notify(run.onProgress, "preparing", "Finding unclaimed links…");
    const unclaimed = await unclaimedNow();
    if (unclaimed.length === 0) throw new TokensError("links-all-claimed", "Every link in this set has been claimed.");
    const plan = await planRole(run, { freeInputs: S_INPUTS - 1, native, ...(options.openFeeAmount === undefined ? {} : { openFeeAmount: options.openFeeAmount }) });
    const batch = unclaimed.slice(0, S_INPUTS - plan.feeNotes.length);
    assertFeeLeavesPayout(native, plan, batch.reduce((sum, index) => sum + links[index]!.amount, 0n));
    const witness = await readTemplateWitness(run.ctx.node, {
      contract: contract.address,
      notes: batch.map((index) => ({ leafIndex: notes[index]!.leafIndex, outputCommitment: notes[index]!.outputCommitment })),
      nullifiers: [],
    });
    if (witness === null) throw new Error("a funded link note is missing from the output tree");
    const action = buildClaimLinkSpend({
      contract,
      pcashChainId: run.ctx.network.chainId,
      snapshot: witness.snapshot,
      contractOpening: witness.contractOpening,
      notes: batch.map((index, position) => ({ ...links[index]!, leafIndex: notes[index]!.leafIndex, siblings: witness.notes[position]!.siblings })),
      recipient: await walletRecipient(run.ctx, BigInt(witness.snapshot.accountStateRoot)),
      role: templateRole(run, plan),
      validUntilTimestamp: (await run.ctx.node.status()).latestBlockTimestamp + TOKENS_VALIDITY_WINDOW_SECONDS,
      assetDefinition: links[0]!.definition,
      ...walletSender(run.ctx),
    });
    const submitted = await awaitIncluded(run, await proveAndSubmit(run, action, {
      ownedSlots: [0], claimLinkRecipient: run.ctx.profile.address,
    }));
    return { ...submitted, claimed: batch.map(position => originalIndexes[position]!), remaining: unclaimed.length - batch.length };
  });
}

export type ClaimLinkStatus = "claimable" | "claimed" | "unfunded" | "invalid";

export interface ClaimLinkInspection {
  link: ClaimLink;
  /** 0 for native PCASH. */
  assetId: bigint;
  /** Null for native PCASH. */
  definition: AssetDefinition | null;
  amount: bigint;
  status: ClaimLinkStatus;
}

function parseLink(url: string): ClaimLink {
  try {
    return parseClaimLink(url);
  } catch (cause) {
    throw new TokensError("link-invalid", "This is not a valid claim link.", { cause });
  }
}

/** What a claim link holds and whether it can still be claimed. Needs no wallet. */
export async function inspectClaimLink<Prepared, Output>(rt: TokensRuntime<Prepared, Output>, url: string): Promise<ClaimLinkInspection> {
  return inspectLinkAtNode(rt.node, url);
}

/** Read a shared claim link before the visitor connects a wallet. */
export async function inspectLinkAtNode(node: PcashNodeClient, url: string): Promise<ClaimLinkInspection> {
  const link = parseLink(url);
  const contract = claimLinkContractOf(link);
  const note = await linkNote(node, contract, link);
  const state = note === null ? { status: "unfunded" as const } : await readClaimLink(node, contract, { ...link, leafIndex: note.leafIndex });
  return {
    link,
    assetId: claimLinkAssetId(link.definition),
    definition: link.definition,
    amount: link.amount,
    status: state.status,
  };
}

export interface TokenClaimResult extends TemplateSubmission {
  /** 0 for native PCASH. */
  assetId: bigint;
  /** Null for native PCASH. */
  definition: AssetDefinition | null;
  /** The link's value; a native claim's recipient receives it less `openFeeAmount` and `nativeBurnAmount`. */
  amount: bigint;
  /** The relay's open fee a native claim paid from the link. */
  openFeeAmount: bigint;
  /** The native PCASH a native claim burned from the link: the network fee. */
  nativeBurnAmount: bigint;
  /** The address that received the claim. */
  recipient: string;
}

/**
 * An explicit recipient other than automatic self delivery. A bare address's
 * key comes from `receiveKeyOf`, which reads the claim's own snapshot.
 */
async function explicitClaimRecipient(
  to: string,
  chainId: bigint,
  wallet: bigint,
  receiveKeyOf: (address: string) => Promise<Uint8Array | null>,
): Promise<{ address: bigint; receiveKey: Uint8Array; self?: true }> {
  const delivery = await resolveRecipientDelivery(to, chainId, receiveKeyOf);
  const receiveKey = delivery.recipientReceiveKey ?? parseExtendedCode(delivery.recipientExtendedCode!).mlKemPublicKey;
  return delivery.recipientAddress === wallet
    ? { address: delivery.recipientAddress, receiveKey, self: true }
    : { address: delivery.recipientAddress, receiveKey };
}

/** A recipient named by address or receive code, keyed in the claim's snapshot. */
async function claimRecipient<Prepared, Output>(run: TemplateRun<Prepared, Output>, to: string, accountStateRoot: bigint) {
  const recipient = await explicitClaimRecipient(to, run.ctx.network.chainId, run.ctx.profile.address,
    (address) => loadReceiveKeyAtSnapshot(run.ctx.store, address, accountStateRoot, () => run.ctx.synchronize()));
  if (recipient.self) assertReceiveKeyOwned(await run.ctx.store.load(), recipient.receiveKey);
  return recipient;
}

function minBigint(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function linkRefusal(status: Exclude<ClaimLinkStatus, "claimable">): TokensError {
  return status === "claimed"
    ? new TokensError("link-claimed", "This link has already been claimed.")
    : status === "unfunded"
      ? new TokensError("link-unfunded", "This link's funds have not arrived on chain yet.")
      : new TokensError("link-invalid", "This link does not open anything on this chain.");
}

/**
 * Claim a link into this wallet, or to `recipient` (an address or receive
 * code). Self-publication and a zero relay fee claim in the transfer role. A
 * token claim's positive relay fee or network fee is paid from this wallet's
 * PCASH; a native claim's come out of the link, and the recipient receives the
 * rest. A claim that creates this wallet's account counts that account in its
 * network fee. A claim this wallet already journaled is resubmitted byte for
 * byte.
 */
export async function claimLink<Prepared, Output>(rt: TokensRuntime<Prepared, Output>, url: string, options: {
  recipient?: string;
  openFeeAmount?: bigint;
} & TokensActionCallbacks = {}): Promise<TokenClaimResult> {
  const link = parseLink(url);
  const contract = claimLinkContractOf(link);
  const native = link.definition === null;
  const note = await linkNote(rt.node, contract, link);
  if (note === null) throw linkRefusal("unfunded");
  const noteRef = { ...link, leafIndex: note.leafIndex };
  const sponsored = await withWallet(rt, "claim-link-retry", options, async (run) => {
    if (native || !usesSponsorship(run, options.openFeeAmount, templateNetworkFee(run.ctx.status))) return null;
    const address = options.recipient === undefined ? run.ctx.profile.address
      : resolveRecipientAddress(options.recipient, run.ctx.network.chainId).recipientAddress;
    const resumed = await resumeTemplateAction(run, [note.nullifier], address);
    if (resumed !== null) return { address, automaticSelf: false, resumed: await awaitIncluded(run, resumed.submission) };
    const automaticSelf = address === run.ctx.profile.address && (options.recipient === undefined || !looksLikeExtendedCode(options.recipient));
    // The recipient's key is read in the sponsorship's snapshot; a code to
    // this wallet must name a key it owns.
    if (!automaticSelf && address === run.ctx.profile.address) {
      assertReceiveKeyOwned(await run.ctx.store.load(), parseExtendedCode(options.recipient!).mlKemPublicKey);
    }
    return { address, automaticSelf, resumed: null };
  });
  if (sponsored !== null) {
    const address = sponsored.address;
    let submission = sponsored.resumed;
    if (sponsored.resumed === null) {
      submission = await submitSponsoredTemplate(rt, {
        contract: contract.address,
        reservedInputSlots: [0],
        reservedOutputSlots: [0],
        snapshotQuery: {
          outputs: [{ outputIndex: BigInt(note.leafIndex), outputCommitment: note.outputCommitment }],
          nullifiers: [bytes32Hex(note.nullifier)],
        },
        primary: async (context) => {
          if (context.snapshot.nullifiers.statuses[0]?.spent) throw linkRefusal("claimed");
          if (context.snapshot.outputs === null) throw linkRefusal("unfunded");
          const recipient = sponsored.automaticSelf
            ? { address, receiveKey: context.selfReceiveKey(), self: true as const }
            : await explicitClaimRecipient(options.recipient!, rt.wallet.network.chainId, BigInt(rt.wallet.address), context.receiveKeyOf);
          const spec = claimLinkSpendSpec({
            contract,
            pcashChainId: rt.wallet.network.chainId,
            snapshot: context.roots,
            contractOpening: {
              accountIndex: Number(context.contractAccount.account.index),
              accountSiblings: context.contractAccount.accountSiblings,
            },
            notes: [{ ...noteRef, siblings: context.outputPaths[0]!.siblings }],
            recipient,
            role: { kind: "transfer" },
            validUntilTimestamp: context.status.latestBlockTimestamp + TOKENS_VALIDITY_WINDOW_SECONDS,
            assetDefinition: link.definition,
          });
          return sponsoredTemplatePrimary(spec, { circuitUrl: TOKENS_CIRCUITS.claimLink, label: "claim-link function" },
            recipient.address === BigInt(rt.wallet.address) ? [0] : []);
        },
        prover: rt.prover,
        openFeeAmount: options.openFeeAmount,
        claimLinkRecipient: address,
      }, options);
    }
    if (link.definition !== null && address === BigInt(rt.wallet.address)) await rt.wallet.importAssetDefinition(link.definition);
    return {
      ...submission!,
      assetId: contract.configuration.assetId,
      definition: link.definition,
      amount: link.amount,
      openFeeAmount: 0n,
      nativeBurnAmount: 0n,
      recipient: addressHex(address),
    };
  }
  const result = await withWallet(rt, "claim-link", options, async (run) => {
    const address = options.recipient === undefined ? run.ctx.profile.address
      : resolveRecipientAddress(options.recipient, run.ctx.network.chainId).recipientAddress;
    const resumed = await resumeTemplateAction(run, [note.nullifier], address);
    if (resumed !== null) {
      return {
        submission: await awaitIncluded(run, resumed.submission),
        recipient: address,
        openFeeAmount: native ? resumed.openFeeAmount : 0n,
        nativeBurnAmount: native ? resumed.nativeBurnAmount : 0n,
      };
    }
    notify(run.onProgress, "preparing", "Checking the link…");
    // A claim into this wallet reads its account from the local directory at the claim's snapshot.
    const self = address === run.ctx.profile.address && (options.recipient === undefined || !looksLikeExtendedCode(options.recipient));
    const state = await readClaimLink(run.ctx.node, contract, noteRef);
    if (state.status !== "claimable") throw linkRefusal(state.status);
    const { witness } = state;
    const accountStateRoot = BigInt(witness.snapshot.accountStateRoot);
    const account = self ? await loadSelfAccountAtSnapshot(run.ctx.store, run.ctx.profile.address, accountStateRoot, () => run.ctx.synchronize()) : undefined;
    // An attached creation signs this deadline, and must expire within its recent block's window.
    const validUntilTimestamp = minBigint(
      (await run.ctx.node.status()).latestBlockTimestamp + TOKENS_VALIDITY_WINDOW_SECONDS,
      witness.recentBlockTimestamp + RECENT_PCASH_BLOCK_WINDOW_SECONDS,
    );
    // A claim that creates this wallet's account counts it in the network fee.
    const plan = await planRole(run, {
      freeInputs: S_INPUTS - 1,
      native,
      createsAccount: account === null,
      ...(options.openFeeAmount === undefined ? {} : { openFeeAmount: options.openFeeAmount }),
    });
    assertFeeLeavesPayout(native, plan, link.amount);
    let recipient: Awaited<ReturnType<typeof claimRecipient>>;
    let accountCreation: AccountCreationAttachment | undefined;
    if (account === null) {
      // No account yet: the claim creates it, and pays the key that creation registers.
      if (!run.ctx.spendable()) throw new TokensError("wallet-not-ready", "Creating an account needs a wallet that can sign.");
      const { profile, signer } = run.ctx;
      notify(run.onProgress, "signing", "Approve creating your PCASH account.");
      accountCreation = await userAccountCreationAttachment({
        chainId: run.ctx.network.chainId,
        network: networkConfigFromStatus(run.ctx.status),
        wallet: profile,
        defaultRuleSecrets: profile.defaultUserRuleSecrets,
        mlKemPublicKey: profile.mlKemPublicKey,
        recentPcashBlockHash: witness.snapshot.recentPcashBlockHash,
        validUntilTimestamp,
      }, signer);
      recipient = { address: profile.address, receiveKey: profile.mlKemPublicKey, self: true };
    } else if (account !== undefined) {
      recipient = { address: run.ctx.profile.address, receiveKey: registeredSelfReceiveKey(account, await run.ctx.store.load()), self: true };
    } else {
      recipient = await claimRecipient(run, options.recipient!, accountStateRoot);
    }
    const action = buildClaimLinkSpend({
      contract,
      pcashChainId: run.ctx.network.chainId,
      snapshot: witness.snapshot,
      contractOpening: witness.contractOpening,
      notes: [{ ...noteRef, siblings: witness.notes[0]!.siblings }],
      recipient,
      role: templateRole(run, plan),
      validUntilTimestamp,
      assetDefinition: link.definition,
      ...walletSender(run.ctx),
      ...(accountCreation === undefined ? {} : { accountCreation }),
    });
    let submitted: TemplateSubmission;
    try {
      submitted = await proveAndSubmit(run, action, {
        ownedSlots: recipient.address === run.ctx.profile.address ? [0] : [],
        claimLinkRecipient: recipient.address,
        createsAccount: accountCreation !== undefined,
      });
    } catch (error) {
      const { statuses } = await run.ctx.node.getCurrentNullifierStatuses([bytes32Hex(note.nullifier)]);
      if (statuses[0]!.spent) throw new TokensError("link-claimed", "Someone claimed this link first.", { cause: error });
      throw error;
    }
    return {
      submission: await awaitIncluded(run, submitted),
      recipient: recipient.address,
      openFeeAmount: plan.openFeeAmount,
      nativeBurnAmount: nativeBurnAmount(plan.burn),
    };
  });
  if (link.definition !== null && result.recipient === BigInt(rt.wallet.address)) await rt.wallet.importAssetDefinition(link.definition);
  return {
    ...result.submission,
    assetId: contract.configuration.assetId,
    definition: link.definition,
    amount: link.amount,
    openFeeAmount: result.openFeeAmount,
    nativeBurnAmount: result.nativeBurnAmount,
    recipient: addressHex(result.recipient),
  };
}
