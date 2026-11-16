import type {
  BlockPayoutsResult,
  BlockIdResult,
  BlockEconomicsRecordResult,
  IssuanceRoute,
  PcashNodeClient,
  TransactionOutcome,
  TransactionSummaryResult,
} from "@pcash/sdk/clients";
import { sleep as sdkSleep } from "@pcash/sdk/utils";
import { controlsSystemPayout } from "@pcash/sdk/wallet/actions";

/** What the action's inclusion settled and whether this wallet controls where it went. */
export interface EarnPayout {
  route: IssuanceRoute;
  /** The resolved destination: the designated commitment, or the including batch's poster commitment. */
  destination: string | null;
  openFeeAmount: bigint;
  issuanceAmount: bigint;
  /** Whether this wallet's seed opens the destination's payout; null until the block's payout record shows it. */
  yours: boolean | null;
}

/** What happened to one earn action once the node derived it. */
export interface EarnLanding {
  contentHash: string;
  transactionId: string;
  blockNumber: bigint;
  blockHash: string;
  timestamp: bigint;
  /** Ethereum transaction carrying the canonical inclusion. */
  l1TransactionHash?: string;
  outcome: TransactionOutcome;
  /** The block's economics row, absent only if the index had not caught up within the wait. */
  block: BlockEconomicsRecordResult | null;
  /** Null for a failed inclusion, which settles nothing. */
  payout: EarnPayout | null;
}

export type EarnWatchNode = Pick<PcashNodeClient, "getSubmission" | "getBlockEconomics" | "getReceipt" | "getBlockPayouts">;

/** The wallet whose seed decides whether a destination is its own. */
export interface EarnOwner {
  address: bigint;
  nkRoot: bigint;
}

export interface EarnWatchOptions {
  /** Index reads per observation; polling callers can use one. */
  indexAttempts?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Set to stop polling early. */
  cancelled?: { current: boolean };
}

/**
 * One reading of an action's canonical standing.
 * - `landed`: a consistent inclusion with its block's economics.
 * - `absent`: the node holds no inclusion of these bytes.
 * - `moved`: the canonical view changed between the reads; read again.
 * - `incomplete`: the inclusion history exceeded the search budget with no
 *   success seen, so nothing can be concluded from the newest entries.
 */
export type EarnReading =
  | { kind: "landed"; landing: EarnLanding }
  | { kind: "absent"; indexHead?: BlockIdResult }
  | { kind: "moved" }
  | { kind: "incomplete" };

const DEFAULT_INTERVAL_MS = 6_000;
/** Reads of the block's index rows before reporting them as pending. */
const INDEX_ATTEMPTS = 5;
const SUBMISSION_PAGE = 100;
/** Pages of inclusion history read before the search reports itself incomplete. */
export const SUBMISSION_PAGES = 50;

/**
 * The inclusion that speaks for an action. The node lists every canonical
 * inclusion of the same bytes newest first, and a later replay of an already
 * settled action fails on its spent nullifiers, so a succeeded inclusion wins
 * over any newer rejected one; with no success, the newest inclusion stands.
 */
export function selectInclusion(items: readonly TransactionSummaryResult[]): TransactionSummaryResult | undefined {
  return items.find((item) => item.outcome === "succeeded") ?? items[0];
}

export type InclusionSearch =
  | { inclusion: TransactionSummaryResult | undefined; complete: true; indexHead?: BlockIdResult }
  | { inclusion: TransactionSummaryResult | undefined; complete: false };

/** Read the action's inclusion history, following pages until a success is seen or the history ends. */
export async function findInclusion(node: EarnWatchNode, contentHash: string, pages = SUBMISSION_PAGES): Promise<InclusionSearch> {
  let seen: TransactionSummaryResult[] = [];
  let next: Parameters<EarnWatchNode["getSubmission"]>[0]["cursor"];
  for (let page = 0; page < pages; page += 1) {
    const result = await node.getSubmission({ contentHash, limit: SUBMISSION_PAGE, ...(next === undefined ? {} : { cursor: next }) });
    seen = [...seen, ...result.items];
    if (result.items.some((item) => item.outcome === "succeeded") || result.nextCursor === null) return { inclusion: selectInclusion(seen), complete: true, indexHead: result.head };
    next = result.nextCursor;
  }
  return { inclusion: selectInclusion(seen), complete: false };
}

function sameInclusion(left: TransactionSummaryResult, right: TransactionSummaryResult): boolean {
  return left.transactionId === right.transactionId && left.block.blockHash === right.block.blockHash && left.outcome === right.outcome;
}

/**
 * One consistent reading of where an action stands. The inclusion's receipt
 * says what it settled and to which destination; the block's economics row and
 * payout record are joined to it, and the inclusion is then re-read: if
 * the canonical view moved between the reads, the reading is `moved`.
 */
export async function resolveEarnLanding(node: EarnWatchNode, contentHash: string, owner: EarnOwner, options: EarnWatchOptions = {}): Promise<EarnReading> {
  const { intervalMs = DEFAULT_INTERVAL_MS, sleep = sdkSleep, cancelled } = options;
  const search = await findInclusion(node, contentHash);
  if (!search.complete) return { kind: "incomplete" };
  const summary = search.inclusion;
  if (summary === undefined) return { kind: "absent", ...(search.indexHead === undefined ? {} : { indexHead: search.indexHead }) };
  const receipt = summary.outcome !== "succeeded" ? undefined
    : (await node.getReceipt(summary.transactionId)).find((entry) => entry.transactionId.toLowerCase() === summary.transactionId.toLowerCase());
  const destination = receipt?.issuanceOwnerCommitment ?? null;
  // Ownership is read from the destination's payout record, which exists only when something was paid.
  const needsRecord = receipt !== undefined && destination !== null && receipt.settledOpenFeeAmount + receipt.settledIssuanceAmount > 0n;
  let block: BlockEconomicsRecordResult | null = null;
  let record: BlockPayoutsResult | null = null;
  const pending = () => block === null || (needsRecord && record === null);
  for (let read = 0; read < (options.indexAttempts ?? INDEX_ATTEMPTS) && pending(); read += 1) {
    if (cancelled?.current) return { kind: "moved" };
    if (block === null) {
      const economics = await node.getBlockEconomics({ fromBlock: summary.block.blockNumber, limit: 1 });
      const row = economics.records[0];
      if (row !== undefined && row.firstBlock === summary.block.blockNumber) block = row;
    }
    if (needsRecord && record === null) record = await node.getBlockPayouts(summary.block);
    if (pending()) await sleep(intervalMs);
  }
  const confirmed = await findInclusion(node, contentHash);
  if (!confirmed.complete) return { kind: "incomplete" };
  if (confirmed.inclusion === undefined || !sameInclusion(confirmed.inclusion, summary)) return { kind: "moved" };
  const payout = destination === null ? undefined : record?.payouts.find((entry) => entry.ownerCommitment === BigInt(destination));
  return {
    kind: "landed",
    landing: {
      contentHash,
      transactionId: summary.transactionId,
      blockNumber: summary.block.blockNumber,
      blockHash: summary.block.blockHash,
      timestamp: summary.timestamp,
      l1TransactionHash: receipt?.inclusion?.l1TransactionHash ?? summary.inclusion.l1TransactionHash,
      outcome: summary.outcome,
      block,
      payout: receipt === undefined ? null : {
        route: summary.issuanceRoute,
        destination,
        openFeeAmount: receipt.settledOpenFeeAmount,
        issuanceAmount: receipt.settledIssuanceAmount,
        yours: destination === null ? false : payout === undefined ? null : controlsSystemPayout(owner, payout),
      },
    },
  };
}
