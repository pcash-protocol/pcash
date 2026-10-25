import type { MempoolItemResult, PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import { issuanceTerms, transactionIdentity } from "@pcash/sdk/protocol";
import {
  batchExpectedIssuance,
  estimateOtherQualifyingActions,
  MAX_BROWSER_RELAY_BATCH_BYTES,
  MAX_RELAY_CONTENT_HASHES,
  nextBlockIssuanceQuote,
  recentBlockEconomics,
  selectRelayCandidates,
  type L1BatchCompanions,
  type RelayValuation,
} from "@pcash/sdk/relay";
import { fromHex } from "@pcash/sdk/utils";
import { controlsIssuance, discoverControlledCommitments } from "./relayFees.ts";
import type { DisplayIssuanceInputs } from "./usePaymentIssuance.ts";

/** Batch framing: a four-byte length prefix precedes each item. */
const ITEM_PREFIX_BYTES = 4n;
const MEMPOOL_PAGES = 10;

/** Qualifying actions in a batch: all of them, and those whose issuance this wallet collects. */
export interface BatchActions {
  qualifying: bigint;
  collectible: bigint;
}

export interface FastBatchPlan {
  /**
   * This wallet's own pending transactions, oldest first. They join the batch as
   * required transactions after the caller's, in order, so a contract creation
   * precedes the escrow funding that follows it. Any kind is eligible.
   */
  own: Uint8Array[];
  /** Other private-value transactions that pay this wallet the most per byte. */
  companions: L1BatchCompanions;
  /** Undiscounted issuance the batch is expected to pay this wallet, including the new payment's. */
  expectedIssuance: bigint;
  /** The batch's qualifying actions, the required ones included. */
  actions: BatchActions;
  /** The same batch's qualifying actions without the companions. */
  actionsWithoutCompanions: BatchActions;
  rewardEach: bigint;
  /** Ready transactions the batch could carry: this wallet's own and other wallets' private-value transactions. Absent when they could not be read or prepared. */
  pendingCount?: number;
}

async function readMempool(node: PcashNodeClient): Promise<Map<string, MempoolItemResult>> {
  const items = new Map<string, MempoolItemResult>();
  let cursor: string | undefined;
  for (let page = 0; page < MEMPOOL_PAGES; page++) {
    const result = await node.getMempool({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of result.items) items.set(item.contentHash.toLowerCase(), item);
    if (result.nextCursor === null || result.items.length === 0 || result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  return items;
}

/**
 * The batch to post from this wallet alongside `requiredTransactionCount` transactions of
 * `transactionByteSize` bytes. This wallet's pending transactions come first, oldest
 * first and never reordered; remaining space holds whichever other mempool
 * transactions pay this wallet the most per byte.
 */
export async function planFastBatch({ node, status, profile, ownPendingContentHashes, transactionByteSize, excludeContentHashes = [], actionQualifies = true, requiredTransactionCount = 1, issuanceInputs, companionsOptional = false }: {
  node: PcashNodeClient;
  status: StatusResult;
  profile: { address: bigint; nkRoot: bigint };
  ownPendingContentHashes: readonly string[];
  transactionByteSize: bigint;
  excludeContentHashes?: readonly string[];
  actionQualifies?: boolean;
  requiredTransactionCount?: number;
  /** Keep required transactions publishable when optional companion selection is unavailable. */
  companionsOptional?: boolean;
  /** Display planning may share its quote/history; review and confirmation omit this. */
  issuanceInputs?: DisplayIssuanceInputs;
}): Promise<FastBatchPlan> {
  const canOmitCompanions = companionsOptional && requiredTransactionCount > 0;
  let mempoolUnavailable = false;
  const items = await readMempool(node).catch(error => {
    if (!canOmitCompanions) throw error;
    mempoolUnavailable = true;
    return new Map<string, MempoolItemResult>();
  });
  if (!mempoolUnavailable) await Promise.all(ownPendingContentHashes.filter((id) => !items.has(id.toLowerCase())).map(async (id) => {
    const item = await node.getMempoolTransaction(id).catch(() => null);
    if (item !== null) items.set(item.contentHash.toLowerCase(), item);
  }));
  const excludedIds = new Set(excludeContentHashes.map((id) => id.toLowerCase()));
  const ownIds = new Set(ownPendingContentHashes.map((id) => id.toLowerCase()));
  const ready = [...items.values()].filter((item) => item.status === "ready" && !excludedIds.has(item.contentHash.toLowerCase()));
  const own = ready.filter((item) => ownIds.has(item.contentHash.toLowerCase())).sort(oldestFirst);
  // Another wallet's transaction rides along only as an independent private-value action.
  const others = ready.filter((item) => item.kind === "privateValue" && !ownIds.has(item.contentHash.toLowerCase()));

  const controlled = await discoverControlledCommitments(node, [...own, ...others], profile, status.pcashChainId);
  // Issuance is an estimate; a lagging economics index must not block the batch.
  const [quote, economics] = issuanceInputs === undefined
    ? await Promise.allSettled([nextBlockIssuanceQuote(node, status), recentBlockEconomics(node, status.latestBlock)])
    : [issuanceInputs.quote, issuanceInputs.economics];
  const controlledSet = new Set(controlled.map(BigInt));
  const valuation: RelayValuation = {
    terms: issuanceTerms(quote.status === "fulfilled" ? quote.value : null),
    otherQualifyingActions: economics.status === "fulfilled" ? estimateOtherQualifyingActions(economics.value.records) : 0n,
    selfMinedActions: 0n,
    issuanceHaircutBps: quote.status === "fulfilled" && economics.status === "fulfilled" ? 5_000 : 10_000,
    controlled: controlledSet,
  };

  const actionCount = actionQualifies ? BigInt(requiredTransactionCount) : 0n;
  const capacity = MAX_BROWSER_RELAY_BATCH_BYTES - transactionByteSize - ITEM_PREFIX_BYTES * BigInt(requiredTransactionCount);
  const select = (excluded: ReadonlySet<string>): string[] => {
    // A later transaction of this wallet's never goes ahead of an earlier one that does not fit.
    const pinned: MempoolItemResult[] = [];
    let bytes = 0n;
    for (const item of own) {
      if (excluded.has(item.contentHash.toLowerCase())) continue;
      if (pinned.length >= MAX_RELAY_CONTENT_HASHES - requiredTransactionCount || bytes + ITEM_PREFIX_BYTES + item.byteSize > capacity) break;
      pinned.push(item);
      bytes += ITEM_PREFIX_BYTES + item.byteSize;
    }
    const ownQualifying = pinned.filter((item) => item.kind === "privateValue");
    const ownControlled = BigInt(ownQualifying.filter((item) => controlsIssuance(item, controlledSet)).length);
    const ownUncontrolled = BigInt(ownQualifying.length) - ownControlled;
    const selected = selectRelayCandidates(
      others.filter((item) => !excluded.has(item.contentHash.toLowerCase())),
      {
        maxBatchBytes: capacity - bytes,
        maxTransactions: MAX_RELAY_CONTENT_HASHES - requiredTransactionCount - pinned.length,
        minValuePerByte: 0n,
        sponsorUnpaid: false,
        nowUnixMs: BigInt(Date.now()),
      },
      // Private-value actions qualify for issuance; contract creation does not.
      { ...valuation, selfMinedActions: actionCount + ownControlled, otherQualifyingActions: valuation.otherQualifyingActions + ownUncontrolled },
    );
    return [...pinned, ...selected].map((item) => item.contentHash);
  };

  const prepare = (contentHashes: string[]) => node.prepareRelay({
    contentHashes, controlledIssuanceOwnerCommitments: controlled, maxBatchBytes: capacity,
  });
  const pendingCount = own.length + others.length;
  // Without a readable mempool or a prepared relay, the pending count is unknown.
  const requiredOnly = (known: boolean): FastBatchPlan => {
    const actions = { qualifying: actionCount, collectible: actionCount };
    return { own: [], companions: { transactions: [], collectibleOpenFee: 0n, collectibleOpenFees: [] }, ...batchExpectedIssuance(valuation, actionCount, actionCount),
      actions, actionsWithoutCompanions: actions, ...(known ? { pendingCount } : {}) };
  };
  if (mempoolUnavailable) return requiredOnly(false);
  let selected = select(new Set());
  if (selected.length === 0) return requiredOnly(true);
  let prepared: Awaited<ReturnType<typeof prepare>>;
  try { prepared = await prepare(selected); }
  catch (error) { if (!canOmitCompanions) throw error; return requiredOnly(false); }
  const rejected = new Set(prepared.rejected.filter((item) => item.reason !== "max batch bytes").map((item) => item.contentHash.toLowerCase()));
  if (rejected.size > 0) {
    selected = select(rejected);
    try { prepared = await prepare(selected); }
    catch (error) { if (!canOmitCompanions) throw error; return requiredOnly(false); }
  }
  // The node's bytes are keyed by their own hash, so bytes it returns under a requested ID
  // that hash to something else are never taken as this wallet's or a companion.
  const requested = new Set(selected.map((id) => id.toLowerCase()));
  const bytesById = new Map(prepared.selectedTransactions.map((hex) => {
    const bytes = fromHex(hex);
    return [transactionIdentity(bytes).contentHash.toLowerCase(), bytes] as const;
  }).filter(([id]) => requested.has(id)));
  const ownSelected = own.filter((item) => bytesById.has(item.contentHash.toLowerCase()));
  const ownQualifying = ownSelected.filter((item) => item.kind === "privateValue");
  const ownCollectible = BigInt(ownQualifying.filter((item) => controlsIssuance(item, controlledSet)).length);
  const companionIds = [...bytesById.keys()].filter((id) => !ownIds.has(id));
  const collectibleOpenFees = companionIds.map((id) => {
    const item = items.get(id)!;
    return controlsIssuance(item, controlledSet) ? item.openFeeAmount : 0n;
  });
  return {
    own: ownSelected.map((item) => bytesById.get(item.contentHash.toLowerCase())!),
    companions: { transactions: companionIds.map((id) => bytesById.get(id)!), collectibleOpenFee: collectibleOpenFees.reduce((sum, fee) => sum + fee, 0n), collectibleOpenFees },
    ...batchExpectedIssuance(valuation, prepared.collectibleQualifyingActions + actionCount, prepared.selectedQualifyingActions + actionCount),
    actions: { qualifying: prepared.selectedQualifyingActions + actionCount, collectible: prepared.collectibleQualifyingActions + actionCount },
    actionsWithoutCompanions: { qualifying: BigInt(ownQualifying.length) + actionCount, collectible: ownCollectible + actionCount },
    pendingCount,
  };
}

function oldestFirst(left: MempoolItemResult, right: MempoolItemResult): number {
  return left.receivedAtUnixMs < right.receivedAtUnixMs ? -1 : left.receivedAtUnixMs > right.receivedAtUnixMs ? 1 : 0;
}
