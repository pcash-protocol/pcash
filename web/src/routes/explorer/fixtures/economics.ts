// The fixture world's per-block economics series, derived from the recorded
// blocks, transactions, blockPayouts records, and issuance quote the same way
// the node's index derives its rows from canonical history, then bucketed with
// the node's rules:
// buckets align to multiples of `bucket`, totals sum over the bucket, rates,
// lag, fee excess and cumulative burns are the last block's, and the bucket
// holding the head may be partial.

import type { BlockEconomicsPageResult, BlockEconomicsQuery, BlockEconomicsRecordResult, TransactionSummaryResult } from "@pcash/sdk/clients";
import { ACCOUNT_UPDATE_UNITS, ACCOUNT_WEIGHT, baseFee, nextFeeExcess, privateValueUnits } from "@pcash/sdk/protocol";
import type { FixtureWorld } from "./world.ts";

interface Row {
  number: bigint;
  timestamp: bigint;
  qualifyingActions: bigint;
  rewardEach: bigint;
  issuanceTotal: bigint;
  openFeesTotal: bigint;
  burnTotal: bigint;
  burnedSoFar: bigint;
  usedUnits: bigint;
  baseFee: bigint;
  feeExcess: bigint;
}

/** The state units a successful transaction used; a failed one uses none. */
function units(summary: TransactionSummaryResult): bigint {
  if (summary.outcome !== "succeeded") return 0n;
  switch (summary.kind) {
    case "privateValue": return privateValueUnits(summary.nullifiers?.length ?? 0, summary.accountCreation === 1);
    case "userAccountUpdate": return ACCOUNT_UPDATE_UNITS;
    case "userAccountCreation":
    case "contractAccount": return ACCOUNT_WEIGHT;
    default: return 0n;
  }
}

/**
 * Every successful type 0x00 action qualifies and receives the same issuance,
 * so the block's issuance total divides exactly by its qualifying actions.
 * Each block's base fee comes from its parent's fee excess, zero at genesis.
 */
function rows(world: FixtureWorld): Row[] {
  let feeExcess = 0n;
  let burnedSoFar = 0n;
  return [...world.blocks].sort((left, right) => (left.number < right.number ? -1 : left.number > right.number ? 1 : 0)).map((block) => {
    const hash = block.hash.toLowerCase();
    const included = world.transactions.map(({ summary }) => summary).filter((summary) => summary.block.blockHash.toLowerCase() === hash);
    const qualifyingActions = BigInt(included.filter((summary) => summary.kind === "privateValue" && summary.outcome === "succeeded").length);
    const blockPayouts = world.blockPayouts.get(hash);
    const issuanceTotal = blockPayouts?.issuanceTotal ?? 0n;
    const burnTotal = included.reduce((total, summary) => total + summary.settledNativeBurnAmount, 0n);
    const usedUnits = included.reduce((total, summary) => total + units(summary), 0n);
    const charged = baseFee(feeExcess);
    feeExcess = nextFeeExcess(feeExcess, usedUnits);
    burnedSoFar += burnTotal;
    return {
      number: block.number,
      timestamp: block.timestamp,
      qualifyingActions,
      rewardEach: qualifyingActions === 0n ? 0n : issuanceTotal / qualifyingActions,
      issuanceTotal,
      openFeesTotal: blockPayouts?.openFeesTotal ?? 0n,
      burnTotal,
      burnedSoFar,
      usedUnits,
      baseFee: charged,
      feeExcess,
    };
  });
}

/** The node reads at most this many rows per page, whatever `limit` says. */
export const ECONOMICS_SCAN_ROWS = 32_768;

export function fixtureBlockEconomics(world: FixtureWorld, query: BlockEconomicsQuery = {}, scanRows = ECONOMICS_SCAN_ROWS): BlockEconomicsPageResult {
  const head = world.status.latestBlock;
  const page: BlockEconomicsPageResult = { atBlockNumber: head, atBlockHash: world.status.latestBlockHash, records: [], nextBlock: null };
  const bucket = BigInt(query.bucket ?? 1);
  const limit = query.limit ?? 256;
  const from = query.fromBlock ?? 0n;
  if (from > head) return page;
  const start = from - from % bucket;
  const quote = world.issuance;
  let current: BlockEconomicsRecordResult | undefined;
  const candidates = rows(world).filter((candidate) => candidate.number >= start && candidate.number <= head);
  const truncated = candidates.length > scanRows;
  let expected = start;
  for (const row of candidates.slice(0, scanRows)) {
    expected = row.number + 1n;
    current ??= {
      firstBlock: row.number, lastBlock: row.number, firstTimestamp: row.timestamp, lastTimestamp: row.timestamp, blocks: 0n,
      qualifyingActions: 0n, issuanceTotal: 0n, openFeesTotal: 0n, burnTotal: 0n, burnedSoFar: 0n, usedUnits: 0n, rewardEach: 0n,
      baseline: quote?.baseline ?? 0n, internalOffer: quote?.internalOffer ?? 0n, blockAllowance: quote?.blockAllowance ?? 0n, lagQ: quote?.lagQ ?? 0n,
      baseFee: 0n, feeExcess: 0n,
    };
    current.lastBlock = row.number;
    current.lastTimestamp = row.timestamp;
    current.blocks += 1n;
    current.qualifyingActions += row.qualifyingActions;
    current.issuanceTotal += row.issuanceTotal;
    current.openFeesTotal += row.openFeesTotal;
    current.burnTotal += row.burnTotal;
    current.usedUnits += row.usedUnits;
    current.rewardEach = row.rewardEach;
    current.burnedSoFar = row.burnedSoFar;
    current.baseFee = row.baseFee;
    current.feeExcess = row.feeExcess;
    const bucketEnd = row.number - row.number % bucket + bucket - 1n;
    if (row.number === bucketEnd || row.number === head) {
      page.records.push(current);
      current = undefined;
      if (row.number === head) break;
      if (page.records.length === limit) {
        page.nextBlock = row.number + 1n;
        return page;
      }
    }
  }
  // The scan budget cut the series short: retry the unfinished bucket from its first block.
  if (truncated) page.nextBlock = current?.firstBlock ?? expected;
  return page;
}
