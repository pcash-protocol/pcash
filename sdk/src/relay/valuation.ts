// Automatic relay valuation: what including one mempool transaction is worth to
// this relayer in explicit fees plus expected issuance, net of its publication
// floor.
//
// The relayer posts under its own poster commitment, so every open-route
// transaction pays it; designated transactions pay it only when their
// commitment is one it controls. Issuance is shared by every qualifying action
// in the block, so an action's value is its marginal effect on the relayer's
// block issuance.

import type {
  BlockEconomicsPageResult,
  BlockEconomicsRecordResult,
  IssuanceQuoteResult,
  MempoolItemResult,
  PcashNodeClient,
  StatusResult,
} from "../clients/index.ts";
import { rewardEach, type IssuanceTerms } from "../protocol/issuance.ts";
import { RelayUpstreamError } from "./errors.ts";

/** The candidate block is quoted one L1 slot after the current head. */
export const EXPECTED_INCLUSION_SECONDS = 12n;

/** Recent blocks averaged to estimate other posters' qualifying actions. */
export const DEFAULT_ISSUANCE_WINDOW_BLOCKS = 64;

/** The node reads a next-block issuance quote needs. */
export type IssuanceQuoteNode = Pick<PcashNodeClient, "getIssuanceQuote"> & {
  status(): Promise<Pick<StatusResult, "latestBlockTimestamp">>;
};

/**
 * The issuance quote for a block one slot after the head `status` names. The
 * node refuses a candidate time before its current head, and the head can pass
 * that time between the status read and the quote read; then the head is read
 * again and the quote asked once more.
 */
export async function nextBlockIssuanceQuote(
  node: IssuanceQuoteNode,
  status: Pick<StatusResult, "latestBlockTimestamp">,
): Promise<IssuanceQuoteResult | null> {
  const candidate = status.latestBlockTimestamp + EXPECTED_INCLUSION_SECONDS;
  try {
    return await node.getIssuanceQuote(candidate);
  } catch (cause) {
    const current = await Promise.resolve().then(() => node.status()).catch(() => undefined);
    if (current === undefined || current.latestBlockTimestamp <= candidate) throw cause;
    return node.getIssuanceQuote(current.latestBlockTimestamp + EXPECTED_INCLUSION_SECONDS);
  }
}

/**
 * Per-block economics for the `windowBlocks` blocks ending at the index head.
 * The derived index can lag the canonical `head`, and a window starting past
 * the index head reads nothing, so the window is re-anchored at the index head.
 */
export async function recentBlockEconomics(
  node: Pick<PcashNodeClient, "getBlockEconomics">,
  head: bigint,
  windowBlocks: number = DEFAULT_ISSUANCE_WINDOW_BLOCKS,
): Promise<BlockEconomicsPageResult> {
  const window = BigInt(windowBlocks);
  const windowStart = (end: bigint) => end + 1n > window ? end + 1n - window : 0n;
  const read = (fromBlock: bigint) => node.getBlockEconomics({ fromBlock, limit: windowBlocks, bucket: 1 });
  const fromBlock = windowStart(head);
  let economics = await read(fromBlock);
  if (economics.atBlockNumber < head && windowStart(economics.atBlockNumber) !== fromBlock) {
    economics = await read(windowStart(economics.atBlockNumber));
  }
  if (economics.records.length === 0) {
    throw new RelayUpstreamError("block economics index has no blocks in the issuance window");
  }
  return economics;
}

/** Bytes of batch framing before the first item, and before each item. */
export const BATCH_HEADER_BYTES = 67n;
export const ITEM_LENGTH_PREFIX_BYTES = 4n;
const BPS = 10_000n;

export interface RelayValuation {
  terms: IssuanceTerms;
  /** m: other posters' qualifying actions expected in the same block. */
  otherQualifyingActions: bigint;
  /** k0: this relayer's own qualifying actions in the same block outside the candidates. */
  selfMinedActions: bigint;
  /** Discount on positive expected issuance; fees are never discounted. */
  issuanceHaircutBps: number;
  /** Operator-configured commitment control, independent of discovered transaction-specific control. */
  controlled: ReadonlySet<bigint>;
  /** Designated commitments derived for one exact transaction, keyed by its content hash. */
  controlledByContentHash?: ReadonlyMap<string, bigint>;
  /** Exact native PCASH notes this relayer can decrypt and receive from ready transactions. */
  privateFeeByContentHash?: ReadonlyMap<string, bigint>;
}

/** Qualifying actions already counted into the block being valued. */
export interface RelayIssuanceState {
  /** Controlled qualifying actions, including self-mined ones. */
  controlled: bigint;
  uncontrolled: bigint;
}

export interface RelaySelectionPolicy {
  maxBatchBytes: bigint;
  maxTransactions: number;
  /** PCASH publication cost per transaction byte that fee plus discounted issuance must cover. */
  minValuePerByte: bigint;
  /** After paying transactions, take every remaining fitting transaction, oldest first. */
  sponsorUnpaid: boolean;
  /** Transactions at least this old are taken first regardless of the byte floor. */
  maxWaitMs?: bigint;
  nowUnixMs: bigint;
}

/** ceil(mean qualifying actions per block); zero without records. */
export function estimateOtherQualifyingActions(
  records: readonly Pick<BlockEconomicsRecordResult, "blocks" | "qualifyingActions">[],
): bigint {
  let blocks = 0n;
  let actions = 0n;
  for (const record of records) {
    blocks += record.blocks;
    actions += record.qualifyingActions;
  }
  return blocks === 0n ? 0n : (actions + blocks - 1n) / blocks;
}

/** I(c, u) = c · rewardEach(m + c + u): the relayer's issuance with c controlled and u uncontrolled actions. */
export function relayIssuance(terms: IssuanceTerms, otherActions: bigint, controlled: bigint, uncontrolled: bigint): bigint {
  return controlled * rewardEach(terms, otherActions + controlled + uncontrolled);
}

/** Gains are discounted by the haircut; losses count at face value. */
export function discountIssuance(amount: bigint, haircutBps: number): bigint {
  return amount > 0n ? amount * (BPS - BigInt(haircutBps)) / BPS : amount;
}

function qualifies(entry: MempoolItemResult): boolean {
  return entry.kind === "privateValue";
}

function controls(entry: MempoolItemResult, valuation: RelayValuation): boolean {
  if (entry.issuanceRoute === "open") return true;
  if (entry.issuanceRoute !== "designated") return false;
  const commitment = BigInt(entry.issuanceOwnerCommitment);
  return valuation.controlled.has(commitment)
    || valuation.controlledByContentHash?.get(entry.contentHash.toLowerCase()) === commitment;
}

/** Public open fee plus discounted marginal issuance controlled by this relayer. */
export function relayTransactionGain(entry: MempoolItemResult, valuation: RelayValuation, state: RelayIssuanceState): bigint {
  const controlled = controls(entry, valuation);
  const fee = entry.openFeeAmount + (valuation.privateFeeByContentHash?.get(entry.contentHash.toLowerCase()) ?? 0n);
  if (!qualifies(entry)) return fee;
  const { terms, otherQualifyingActions: m } = valuation;
  const before = relayIssuance(terms, m, state.controlled, state.uncontrolled);
  const after = controlled
    ? relayIssuance(terms, m, state.controlled + 1n, state.uncontrolled)
    : relayIssuance(terms, m, state.controlled, state.uncontrolled + 1n);
  return fee + discountIssuance(after - before, valuation.issuanceHaircutBps);
}

/**
 * Undiscounted issuance a prepared batch adds for this relayer, from the node's
 * counts: I(k0 + qc, qs − qc) − I(k0, 0), and the per-action issuance (`rewardEach`) it assumes.
 */
export function batchExpectedIssuance(
  valuation: RelayValuation,
  collectibleQualifyingActions: bigint,
  selectedQualifyingActions: bigint,
): { rewardEach: bigint; expectedIssuance: bigint } {
  const { terms, otherQualifyingActions: m, selfMinedActions: k0 } = valuation;
  return {
    rewardEach: rewardEach(terms, m + k0 + selectedQualifyingActions),
    expectedIssuance: relayIssuance(terms, m, k0 + collectibleQualifyingActions, selectedQualifyingActions - collectibleQualifyingActions)
      - relayIssuance(terms, m, k0, 0n),
  };
}

function byAge(left: MempoolItemResult, right: MempoolItemResult): number {
  if (left.receivedAtUnixMs !== right.receivedAtUnixMs) return left.receivedAtUnixMs < right.receivedAtUnixMs ? -1 : 1;
  return byContentHash(left, right);
}

function byContentHash(left: MempoolItemResult, right: MempoolItemResult): number {
  return left.contentHash.toLowerCase().localeCompare(right.contentHash.toLowerCase());
}

/**
 * Deterministic automatic selection: overdue transactions oldest first, then
 * greedily by net value per byte with marginal issuance recomputed after each
 * pick, then (when sponsoring) every remaining transaction, oldest first,
 * including ones that pay this relayer nothing or fall below the byte floor.
 * Transactions that do not fit are skipped.
 */
export function selectRelayCandidates(
  items: readonly MempoolItemResult[],
  policy: RelaySelectionPolicy,
  valuation: RelayValuation,
): MempoolItemResult[] {
  const selected: MempoolItemResult[] = [];
  const state: RelayIssuanceState = { controlled: valuation.selfMinedActions, uncontrolled: 0n };
  let bytes = BATCH_HEADER_BYTES;
  let remaining = items.filter((item) => item.status === "ready");

  const fits = (entry: MempoolItemResult) =>
    selected.length < policy.maxTransactions && bytes + ITEM_LENGTH_PREFIX_BYTES + entry.byteSize <= policy.maxBatchBytes;
  const gain = (entry: MempoolItemResult) => relayTransactionGain(entry, valuation, state);
  const take = (entry: MempoolItemResult) => {
    if (qualifies(entry)) {
      if (controls(entry, valuation)) state.controlled += 1n;
      else state.uncontrolled += 1n;
    }
    bytes += ITEM_LENGTH_PREFIX_BYTES + entry.byteSize;
    selected.push(entry);
    remaining = remaining.filter((item) => item !== entry);
  };

  const { maxWaitMs, nowUnixMs } = policy;
  if (maxWaitMs !== undefined) {
    const overdue = remaining
      .filter((item) => item.receivedAtUnixMs <= nowUnixMs && nowUnixMs - item.receivedAtUnixMs >= maxWaitMs)
      .sort(byAge);
    for (const entry of overdue) {
      if (fits(entry) && (policy.sponsorUnpaid || gain(entry) > 0n)) take(entry);
    }
  }

  for (;;) {
    let best: { entry: MempoolItemResult; net: bigint } | undefined;
    for (const entry of remaining) {
      if (!fits(entry)) continue;
      const value = gain(entry);
      if (value <= 0n) continue;
      const net = value - policy.minValuePerByte * entry.byteSize;
      if (net < 0n) continue;
      if (best === undefined) {
        best = { entry, net };
        continue;
      }
      const left = net * best.entry.byteSize;
      const right = best.net * entry.byteSize;
      if (left > right || (left === right && byContentHash(entry, best.entry) < 0)) best = { entry, net };
    }
    if (best === undefined) break;
    take(best.entry);
  }

  if (policy.sponsorUnpaid) {
    for (const entry of [...remaining].sort(byAge)) {
      if (fits(entry)) take(entry);
    }
  }
  return selected;
}
