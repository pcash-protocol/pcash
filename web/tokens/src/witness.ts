// Node reads for the token templates. Every opening one action proves comes
// from a single witness snapshot, so the contract account, the spent notes,
// any claimant or fee-payer account, and the spentness answers all describe
// one recent block.

import {
  OutputOpeningMismatchError,
  pollReceipt,
  type AccountProofResult,
  type PcashNodeClient,
} from "@pcash/sdk/clients";
import { snapshotFromAccountProof, type AccountProofSnapshot } from "@pcash/sdk/builders";
import { BLOCK_HEADER_KEY_STATE_ROOT, STATE_KEY_ACCOUNT_COUNT } from "@pcash/sdk/constants";
import { openBlockHeaderKey, openStateKey } from "@pcash/sdk/protocol";
import { addressHex, bytes32Hex } from "@pcash/sdk/utils";
import type { TemplateContractOpening, TemplateNoteOpening } from "./template.ts";
import { claimLinkNote, type ClaimLinkContract, type ClaimLinkNoteRef } from "./link.ts";
import {
  dropClaimMarker,
  dropInventoryNote,
  type DropClaimantAccount,
  type DropEligibilityOpening,
  type DropInventoryNote,
  type EligibilityDrop,
} from "./drop.ts";

export type TokensNode = Pick<PcashNodeClient, "getWitnessSnapshot" | "getHistoryProof" | "getBlockHeader">;

/**
 * One funding transaction's share of a contract's notes. Logical indexes
 * `firstIndex..firstIndex+count-1` sit at output slots `0..count-1`. A leaf
 * index and inclusion transaction ID can change after a reorg, while the
 * content hash of exact bytes stays the same.
 */
export interface FundingChunk {
  contentHash: string;
  firstIndex: number;
  count: number;
}

/** A note's place: output `slot` of the exact bytes named by `contentHash`. */
export interface FundedOutput {
  contentHash: string;
  slot: number;
}

export interface IndexedFundedOutput extends FundedOutput {
  index: number;
}

export function indexedFundedOutputs(funding: readonly FundingChunk[]): IndexedFundedOutput[] {
  return funding.flatMap((chunk) => Array.from({ length: chunk.count }, (_, slot) => ({
    contentHash: chunk.contentHash,
    slot,
    index: chunk.firstIndex + slot,
  })));
}

export function fundedOutputs(funding: readonly FundingChunk[]): FundedOutput[] {
  return indexedFundedOutputs(funding).map(({ contentHash, slot }) => ({ contentHash, slot }));
}

/**
 * Each output's leaf at the node's head, or null while its transaction has no
 * accepted receipt there. One receipt read per distinct transaction.
 */
export async function fundedLeaves(node: PcashNodeClient, outputs: readonly FundedOutput[]): Promise<(number | null)[]> {
  const contentHashes = [...new Set(outputs.map((output) => output.contentHash.toLowerCase()))];
  const starts = new Map(await Promise.all(contentHashes.map(async (contentHash) => {
    const receipt = await pollReceipt(node, contentHash);
    return [contentHash, receipt?.outcome === "succeeded" ? receipt.outputLeafStart : null] as const;
  })));
  return outputs.map(({ contentHash, slot }) => {
    const start = starts.get(contentHash.toLowerCase()) ?? null;
    return start === null ? null : Number(start) + slot;
  });
}

/** A drop's inventory notes whose funding is accepted at the node's head, in note order. */
export async function dropInventory(node: PcashNodeClient, drop: EligibilityDrop, funding: readonly FundingChunk[]): Promise<DropInventoryNote[]> {
  const outputs = indexedFundedOutputs(funding);
  const leaves = await fundedLeaves(node, outputs);
  return leaves.flatMap((leafIndex, position) => leafIndex === null ? [] : [dropInventoryNote(drop, outputs[position]!.index, leafIndex)]);
}

type PresentAccount = Extract<AccountProofResult, { status: "present" }>;

/** Every opening one template action proves, read in one snapshot. */
export interface TemplateWitness {
  snapshot: AccountProofSnapshot;
  /** The snapshot block's number; its history holds every earlier block. */
  recentBlockNumber: bigint;
  contractOpening: TemplateContractOpening;
  /** One opening per requested note, in request order. */
  notes: TemplateNoteOpening[];
  /** One answer per requested nullifier, in request order. */
  spent: boolean[];
  /** One proof per requested extra account, in request order; null when absent. */
  accounts: (PresentAccount | null)[];
}

export class TemplateContractMissingError extends Error {
  constructor(address: bigint) {
    super(`template contract ${addressHex(address)} does not exist yet`);
    this.name = "TemplateContractMissingError";
  }
}

/**
 * Read a template action's openings. Returns null when a requested note is not
 * in the output tree yet; throws `OutputOpeningMismatchError` when its leaf
 * holds a different commitment.
 */
export async function readTemplateWitness(node: TokensNode, request: {
  contract: bigint;
  notes: readonly { leafIndex: number; outputCommitment: bigint }[];
  nullifiers: readonly bigint[];
  accounts?: readonly bigint[];
}): Promise<TemplateWitness | null> {
  const extra = request.accounts ?? [];
  const result = await node.getWitnessSnapshot({
    accounts: [addressHex(request.contract), ...extra.map(addressHex)],
    outputs: request.notes.map((note) => ({ outputIndex: note.leafIndex, outputCommitment: note.outputCommitment })),
    nullifiers: request.nullifiers.map(bytes32Hex),
  });
  const [contract, ...accounts] = result.accounts;
  if (contract?.status !== "present") throw new TemplateContractMissingError(request.contract);
  if (result.outputs === null) return null;
  return {
    snapshot: snapshotFromAccountProof(contract),
    recentBlockNumber: contract.boundary.header.number,
    contractOpening: { accountIndex: Number(contract.account.index), accountSiblings: contract.accountSiblings },
    notes: result.outputs.paths.map((path) => ({ leafIndex: Number(path.outputIndex), siblings: path.siblings })),
    spent: result.nullifiers.statuses.map((status) => status.spent),
    accounts: accounts.map((account) => account.status === "present" ? account : null),
  };
}

/** Openings a role adds to an action's snapshot: a fee payer's account and native notes. */
export interface WitnessExtras {
  /** Opened after the action's own accounts, in `TemplateWitness.accounts`. */
  accounts?: readonly bigint[];
  /** Opened after the action's own notes, in `TemplateWitness.notes`. */
  notes?: readonly { leafIndex: number; outputCommitment: bigint }[];
}

export type ClaimLinkState =
  | { status: "claimable"; witness: TemplateWitness }
  | { status: "claimed" }
  | { status: "unfunded" }
  /** The link's leaf holds another note: the link is wrong for this chain. */
  | { status: "invalid" };

/** Whether a link's note is funded and unspent, with the openings to spend it. */
export async function readClaimLink(
  node: TokensNode,
  contract: ClaimLinkContract,
  link: ClaimLinkNoteRef,
  extras: WitnessExtras = {},
): Promise<ClaimLinkState> {
  const note = claimLinkNote(contract, link);
  let witness: TemplateWitness | null;
  try {
    witness = await readTemplateWitness(node, {
      contract: contract.address,
      notes: [{ leafIndex: note.leafIndex, outputCommitment: note.outputCommitment }, ...(extras.notes ?? [])],
      nullifiers: [note.nullifier],
      accounts: extras.accounts ?? [],
    });
  } catch (error) {
    if (error instanceof OutputOpeningMismatchError) return { status: "invalid" };
    if (error instanceof TemplateContractMissingError) return { status: "unfunded" };
    throw error;
  }
  if (witness === null) return { status: "unfunded" };
  return witness.spent[0] ? { status: "claimed" } : { status: "claimable", witness };
}

/** Which inventory notes are still unspent at the node's head. */
export async function unspentDropInventory(
  node: Pick<PcashNodeClient, "getCurrentNullifierStatuses">,
  inventory: readonly DropInventoryNote[],
): Promise<DropInventoryNote[]> {
  const unspent: DropInventoryNote[] = [];
  for (let start = 0; start < inventory.length; start += 256) {
    const chunk = inventory.slice(start, start + 256);
    const { statuses } = await node.getCurrentNullifierStatuses(chunk.map((note) => bytes32Hex(note.nullifier)));
    chunk.forEach((note, index) => {
      if (!statuses[index]!.spent) unspent.push(note);
    });
  }
  return unspent;
}

/**
 * The eligibility openings under one recent block, or null while that block's
 * history does not yet contain the cutoff block.
 */
export async function readDropEligibility(
  node: TokensNode,
  drop: EligibilityDrop,
  recent: { hash: bigint; number: bigint },
): Promise<DropEligibilityOpening | null> {
  if (drop.configuration.cutoffBlockNumber >= recent.number) return null;
  const history = await node.getHistoryProof(recent.hash, drop.configuration.cutoffBlockNumber);
  const cutoff = (await node.getBlockHeader({ hash: history.historicalBlockHash })).boundary;
  const accountCount = openStateKey(cutoff.state, STATE_KEY_ACCOUNT_COUNT);
  return {
    historyRoot: history.historyRoot,
    historyRootHeaderSiblings: history.historyRootSiblings,
    cutoffBlockHash: history.historicalBlockHash,
    historySiblings: history.historySiblings,
    cutoffStateRoot: cutoff.header.stateRoot,
    cutoffStateRootHeaderSiblings: openBlockHeaderKey(cutoff.header, BLOCK_HEADER_KEY_STATE_ROOT).siblings,
    cutoffAccountCount: accountCount.value,
    cutoffAccountCountSiblings: accountCount.siblings,
  };
}

export type DropEligibility =
  | { status: "eligible"; accountIndex: bigint; cutoffAccountCount: bigint }
  | { status: "ineligible"; accountIndex: bigint; cutoffAccountCount: bigint }
  | { status: "notStarted" }
  | { status: "noAccount" };

/** Whether an address's account existed at the drop's cutoff block. */
export async function checkDropEligibility(
  node: TokensNode & Pick<PcashNodeClient, "getAccountProof">,
  drop: EligibilityDrop,
  address: bigint,
): Promise<DropEligibility> {
  const proof = await node.getAccountProof(addressHex(address));
  if (proof.status !== "present") return { status: "noAccount" };
  const eligibility = await readDropEligibility(node, drop, { hash: proof.boundary.blockHash, number: proof.boundary.header.number });
  if (eligibility === null) return { status: "notStarted" };
  const accountIndex = proof.account.index;
  const cutoffAccountCount = eligibility.cutoffAccountCount;
  return { status: accountIndex < cutoffAccountCount ? "eligible" : "ineligible", accountIndex, cutoffAccountCount };
}

export function claimantAccount(proof: PresentAccount): DropClaimantAccount {
  return {
    accountIndex: Number(proof.account.index),
    accountSiblings: proof.accountSiblings,
    accountRuleSetCommitment: BigInt(proof.account.accountRuleSetCommitment),
    accountRevision: proof.account.accountRevision,
    receiveKeyHash: BigInt(proof.account.receiveKeyHash),
  };
}

export type DropClaimState =
  | {
      status: "claimable";
      witness: TemplateWitness;
      inventory: DropInventoryNote;
      claimant: DropClaimantAccount;
      claimantAccount: PresentAccount["account"];
      eligibility: DropEligibilityOpening;
    }
  /** This claimant account already spent its marker. */
  | { status: "claimed" }
  /** The claimant account was created after the cutoff block. */
  | { status: "ineligible"; accountIndex: bigint; cutoffAccountCount: bigint }
  /** The chain has not completed the cutoff block yet. */
  | { status: "notStarted" }
  | { status: "noAccount" }
  | { status: "exhausted" };

/**
 * Pick one unspent inventory note at random and read everything an unsponsored
 * claim proves. A claim that loses a race for its note is retried with that
 * note in `exclude`.
 */
export async function readDropClaim(node: TokensNode & Pick<PcashNodeClient, "getCurrentNullifierStatuses">, params: {
  drop: EligibilityDrop;
  inventory: readonly DropInventoryNote[];
  claimant: { address: bigint; nkRoot: bigint };
  exclude?: ReadonlySet<number>;
  extras?: WitnessExtras;
  random?: () => number;
}): Promise<DropClaimState> {
  const random = params.random ?? Math.random;
  const candidates = (await unspentDropInventory(node, params.inventory))
    .filter((note) => !params.exclude?.has(note.leafIndex));
  while (candidates.length > 0) {
    const [inventory] = candidates.splice(Math.floor(random() * candidates.length), 1);
    let witness: TemplateWitness | null;
    try {
      witness = await readTemplateWitness(node, {
        contract: params.drop.address,
        notes: [{ leafIndex: inventory!.leafIndex, outputCommitment: inventory!.outputCommitment }, ...(params.extras?.notes ?? [])],
        nullifiers: [dropClaimMarker(params.drop, params.claimant), inventory!.nullifier],
        accounts: [params.claimant.address, ...(params.extras?.accounts ?? [])],
      });
    } catch (error) {
      // A publication may list a leaf that holds another note; it is unusable.
      if (error instanceof OutputOpeningMismatchError) continue;
      throw error;
    }
    if (witness === null) continue;
    if (witness.spent[0]) return { status: "claimed" };
    if (witness.spent[1]) continue;
    const claimantProof = witness.accounts[0];
    if (claimantProof === null || claimantProof === undefined) return { status: "noAccount" };
    const eligibility = await readDropEligibility(node, params.drop, {
      hash: witness.snapshot.recentPcashBlockHash,
      number: witness.recentBlockNumber,
    });
    if (eligibility === null) return { status: "notStarted" };
    if (claimantProof.account.index >= eligibility.cutoffAccountCount) {
      return { status: "ineligible", accountIndex: claimantProof.account.index, cutoffAccountCount: eligibility.cutoffAccountCount };
    }
    return {
      status: "claimable",
      witness: { ...witness, accounts: witness.accounts.slice(1) },
      inventory: inventory!,
      claimant: claimantAccount(claimantProof),
      claimantAccount: claimantProof.account,
      eligibility,
    };
  }
  return { status: "exhausted" };
}
