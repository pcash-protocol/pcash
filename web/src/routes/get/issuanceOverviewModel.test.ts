import { describe, expect, it, vi } from "vitest";
import type { BlockEconomicsRecordResult, IssuanceQuoteResult, PcashNodeClient } from "@pcash/sdk/clients";
import {
  actionsPerBlock, blockSplit, crowdedBlockActions, dailyChange, dayBlockPattern, daysUntilMaximum, forecastRewards, measuredPace, paceRatio, readIssuanceWindows, referenceStart, referenceSupply, REFERENCE_SECONDS,
  dailyIssuance, referenceRatePerDay, rewardPosition, settledReward, supplyPoints, targetPerDay, type IssuanceHistory,
} from "./issuanceOverviewModel.ts";

const unit = 10n ** 18n;
const cap = 1_000_000_000n * unit;
const Q = 1n << 128n;
const day = 86_400n;
const baseline = 800n * unit;
const quiet = new Map<number, number>();
/** `blocks` blocks a day, each carrying `actions` qualifying actions. */
const every = (actions: number, blocks: number) => new Map([[actions, blocks]]);

function quote(overrides: Partial<IssuanceQuoteResult> = {}): IssuanceQuoteResult {
  return {
    parent: { blockNumber: 10n, blockHash: "0x01", timestamp: 1_000_000n }, candidateTimestamp: 1_000_012n, supplyCap: cap, issuedSoFar: 0n,
    baseline, internalOffer: baseline / 16n, blockAllowance: baseline * 3n, maxSingleActionReward: baseline / 16n,
    multiplierQ: Q / 16n, lagQ: -8n * day * Q, exhausted: false, rewardPossible: true, ...overrides,
  } as IssuanceQuoteResult;
}

function record(first: bigint, overrides: Partial<BlockEconomicsRecordResult> = {}): BlockEconomicsRecordResult {
  return {
    firstBlock: first, lastBlock: first, firstTimestamp: first * 12n, lastTimestamp: first * 12n, blocks: 1n, qualifyingActions: 0n,
    issuanceTotal: 0n, openFeesTotal: 0n, rewardEach: 0n, baseline, internalOffer: baseline / 16n, blockAllowance: baseline * 3n, lagQ: 0n, ...overrides,
  };
}

describe("reward position", () => {
  it("reads a state eight days ahead: a sixteenth of the reference rate", () => {
    const position = rewardPosition(quote())!;
    expect(position.ratio).toBe(1 / 16);
    expect(position.maximumRatio).toBe(3);
    expect(position.atMaximum).toBe(false);
    expect(position.lagDays).toBe(-8);
  });
  it("counts days to the maximum from the pace, and none when it levels off below", () => {
    expect(daysUntilMaximum(rewardPosition(quote())!, quiet)).toBeCloseTo(8 + 2 * Math.log2(3), 1);
    const behind = rewardPosition(quote({ lagQ: day * Q, maxSingleActionReward: baseline * 1414n / 1000n }))!;
    expect(daysUntilMaximum(behind, quiet)).toBeCloseTo(2 * Math.log2(3) - 1, 1);
    expect(daysUntilMaximum(behind, every(2, 7_200))).toBeUndefined();
    expect(rewardPosition(quote({ lagQ: 4n * day * Q, maxSingleActionReward: baseline * 3n }))!.atMaximum).toBe(true);
  });
  it("has no position once supply is exhausted", () => {
    expect(rewardPosition(quote({ exhausted: true }))).toBeUndefined();
  });
});

describe("reference pace", () => {
  it("starts where the controller measures from, so the gap to issued supply is the lag", () => {
    expect(referenceStart(quote())).toBe(1_000_000 + 8 * 86_400);
    const threeQuarters = quote({ issuedSoFar: cap * 3n / 4n, lagQ: 0n });
    expect(referenceStart(threeQuarters)).toBeCloseTo(1_000_000 - REFERENCE_SECONDS / 2);
    expect(referenceSupply(cap, REFERENCE_SECONDS / 2)).toBeCloseTo(750_000_000);
    expect(referenceSupply(cap, -1)).toBe(0);
    expect(referenceSupply(cap, 2 * REFERENCE_SECONDS)).toBe(1_000_000_000);
  });
});

describe("pace and forecast", () => {
  const position = rewardPosition(quote())!;
  it("targets the target rate once per 12-second block", () => {
    expect(targetPerDay(baseline)).toBe(baseline * 7_200n);
  });
  it("measures pace and the block pattern over the window, or since launch on a young chain", () => {
    const history: IssuanceHistory = {
      supply: [record(0n, { firstTimestamp: 1_000_000n - day / 2n })],
      day: { qualifyingActions: 60n, issuanceTotal: 3_600n * baseline }, week: { qualifyingActions: 60n, issuanceTotal: 3_600n * baseline },
      recentBlocks: new Map([[1, 3], [3, 1]]), asOf: 1_000_000n,
    };
    const pace = measuredPace(history, "day", baseline)!;
    expect(pace.seconds).toBe(43_200);
    expect(pace.actionsPerDay).toBe(120);
    expect(pace.ratio).toBe(1);
    // 120 actions a day grouped like the sample (half alone, half in threes): 60 single blocks and 20 triples.
    expect(dayBlockPattern(history)).toEqual(new Map([[1, 60], [3, 20]]));
    expect(dayBlockPattern({ ...history, recentBlocks: new Map() })).toEqual(new Map([[1, 120]]));
    expect(dayBlockPattern({ ...history, day: { qualifyingActions: 0n, issuanceTotal: 0n } })).toEqual(new Map());
  });
  it("doubles the reward every 2 days with no issuance and holds it at target pace", () => {
    expect(dailyChange(0)).toBeCloseTo(Math.SQRT2 - 1);
    expect(dailyChange(1)).toBe(0);
    expect(dailyChange(2)).toBeCloseTo(1 / Math.SQRT2 - 1);
    expect(paceRatio(position, every(1, 7_200), position.ratio)).toBe(1 / 16);
  });
  it("settles where the day's blocks issue the target, capped at the maximum", () => {
    expect(settledReward(position, every(2, 7_200)).reward).toBeCloseTo(400);
    expect(settledReward(position, every(2, 7_200)).capped).toBe(false);
    expect(settledReward(position, every(1, 100))).toEqual({ reward: 2_400, capped: true });
    expect(settledReward(position, quiet)).toEqual({ reward: 2_400, capped: true });
  });
  it("forecasts from the current reward: rising while quiet, converging on the settled reward under steady activity", () => {
    const rising = forecastRewards(position, quiet, 8);
    expect(rising[0]!.reward).toBeCloseTo(50);
    expect(rising.at(-1)!.reward).toBeCloseTo(800);
    const steady = forecastRewards(rewardPosition(quote({ lagQ: 0n, maxSingleActionReward: baseline }))!, every(2, 7_200), 14);
    expect(steady.at(-1)!.reward).toBeCloseTo(400, -1);
  });
  // A block of k actions issues min(k × offer, allowance). Three actions every four blocks at twice the target rate
  // issue 1,800 × 3× = 0.75 of target, so the reward rises; counting 5,400 actions at 2× each predicted 1.5 and a fall.
  const doubled = rewardPosition(quote({ lagQ: 2n * day * Q, maxSingleActionReward: baseline * 2n }))!;
  it("caps batched actions at the block allowance: three actions every four blocks at a 2× reward still run behind", () => {
    const batched = every(3, 1_800);
    expect(paceRatio(doubled, batched, doubled.ratio)).toBe(0.75);
    expect(dailyChange(paceRatio(doubled, batched, doubled.ratio))).toBeCloseTo(2 ** 0.125 - 1);
    expect(settledReward(doubled, batched)).toEqual({ reward: 2_400, capped: true });
    expect(daysUntilMaximum(doubled, batched)).toBeCloseTo((2 * Math.log2(3) - 2) / 0.25, 1);
    const forecast = forecastRewards(doubled, batched, 7);
    expect(forecast[24]!.reward).toBeGreaterThan(1_600);
    expect(forecast.at(-1)!.reward).toBeCloseTo(2_400);
  });
  it("matches the one-action-per-block result when the same actions arrive in separate blocks", () => {
    const spread = every(1, 5_400);
    expect(paceRatio(doubled, spread, doubled.ratio)).toBe(1.5);
    expect(dailyChange(paceRatio(doubled, spread, doubled.ratio))).toBeCloseTo(2 ** -0.25 - 1);
    expect(settledReward(doubled, spread).reward).toBeCloseTo(800 * 7_200 / 5_400);
    expect(forecastRewards(doubled, spread, 7)[24]!.reward).toBeLessThan(1_600);
    // A mixed day: 3,600 single-action blocks and 600 three-action blocks at 1× issue 3,600 + 1,800 = 0.75 of target.
    expect(paceRatio(rewardPosition(quote({ lagQ: 0n, maxSingleActionReward: baseline }))!, new Map([[1, 3_600], [3, 600]]), 1)).toBe(0.75);
  });
});

describe("history series", () => {
  it("declines the target rate linearly from 2S/T a day to zero over the schedule", () => {
    expect(referenceRatePerDay(cap, 0)).toBeCloseTo(2e9 / 365);
    expect(referenceRatePerDay(cap, REFERENCE_SECONDS / 2)).toBeCloseTo(1e9 / 365);
    expect(referenceRatePerDay(cap, -1)).toBe(0);
    expect(referenceRatePerDay(cap, REFERENCE_SECONDS + 1)).toBe(0);
  });
  it("sums issuance into whole days and scales the partial newest day", () => {
    const days = dailyIssuance([
      record(0n, { firstTimestamp: 0n, lastTimestamp: 40_000n, issuanceTotal: 10n * unit }),
      record(1n, { firstTimestamp: 40_000n, lastTimestamp: 86_388n, issuanceTotal: 20n * unit }),
      record(2n, { firstTimestamp: 86_400n, lastTimestamp: 129_588n, issuanceTotal: 5n * unit }),
    ]);
    expect(days.map(item => item.start)).toEqual([0, 86_400]);
    expect(days[0]!.perDay).toBe(30);
    expect(days[1]!.perDay).toBe(10);
  });
  it("charts a constant rate flat across buckets that cross midnight or span several days", () => {
    // One PCASH per 12-second block is 7,200 a day. Bucket sizes in blocks: several cross midnight, 30,000 spans over four days.
    const origin = 1_000_000n;
    const sizes = [5_000n, 30_000n, 1_000n, 7_777n, 3_333n, 12_000n, 2_890n];
    let first = 0n;
    const records = sizes.map(size => {
      const item = record(first, { lastBlock: first + size - 1n, firstTimestamp: origin + first * 12n, lastTimestamp: origin + (first + size - 1n) * 12n, blocks: size, issuanceTotal: size * unit });
      first += size;
      return item;
    });
    const days = dailyIssuance(records);
    expect(days).toHaveLength(Math.ceil(Number(first) * 12 / 86_400));
    for (const item of days) expect(item.perDay).toBeCloseTo(7_200, 6);
    expect(days.at(-1)!.end - days.at(-1)!.start).toBe(Number(first) * 12 % 86_400);
  });
  it("accumulates issued supply from zero", () => {
    const points = supplyPoints([record(0n, { issuanceTotal: 2n * unit, lastTimestamp: 12n }), record(1n, { issuanceTotal: 3n * unit, lastTimestamp: 24n })]);
    expect(points).toEqual([{ time: 0, issued: 0 }, { time: 12, issued: 2 }, { time: 24, issued: 5 }]);
  });
});

interface ChainOptions {
  head: bigint;
  /** The index head after the first (snapshot) read; later pages come from it. */
  advancedHead?: bigint;
  /** Issuance of blocks above the pinned head, which a later page may carry. */
  laterIssuance?: bigint;
  reorganized?: boolean;
}

/** A node that pages block economics by the node's own rules, including its 32,768-row scan ceiling. */
function economicsNode({ head: pinned, advancedHead = pinned, laterIssuance = 5n, reorganized = false }: ChainOptions) {
  let reads = 0;
  let headReads = 0;
  const issuance = (number: bigint) => number > pinned ? laterIssuance : 5n;
  const getBlock = vi.fn(async (number: bigint) => ({ number, hash: number === pinned && reorganized && headReads++ > 0 ? "reorg" : `h${number}`, timestamp: number * 10n }));
  const getBlockEconomics = vi.fn(async ({ fromBlock = 0n, bucket = 1, limit = 256 } = {}) => {
    const head = reads++ === 0 ? pinned : advancedHead;
    const page = { atBlockNumber: head, atBlockHash: `h${head}`, records: [] as BlockEconomicsRecordResult[], nextBlock: null as bigint | null };
    if (fromBlock > head) return page;
    const size = BigInt(bucket);
    const start = fromBlock - fromBlock % size;
    let current: BlockEconomicsRecordResult | undefined;
    let number = start;
    for (; number <= head && number < start + 32_768n; number += 1n) {
      current ??= { firstBlock: number, lastBlock: number, firstTimestamp: number * 10n, lastTimestamp: number * 10n, blocks: 0n, qualifyingActions: 0n, issuanceTotal: 0n } as BlockEconomicsRecordResult;
      current.lastBlock = number; current.lastTimestamp = number * 10n; current.blocks += 1n;
      current.qualifyingActions += 2n; current.issuanceTotal += issuance(number);
      if (number === number - number % size + size - 1n || number === head) {
        page.records.push(current); current = undefined;
        if (number === head) return page;
        if (page.records.length === limit) { page.nextBlock = number + 1n; return page; }
      }
    }
    page.nextBlock = current?.firstBlock ?? number;
    return page;
  });
  return { node: { getBlock, getBlockEconomics } as unknown as PcashNodeClient, getBlock, getBlockEconomics };
}
const issued = (history: IssuanceHistory) => history.supply.reduce((sum, item) => sum + item.issuanceTotal, 0n);

it("refines partial time buckets, sums exact day/week activity, and reads supply from genesis with bounded reads", async () => {
  const { node, getBlock, getBlockEconomics } = economicsNode({ head: 20_000n });
  const result = await readIssuanceWindows(node);
  expect(result.day).toEqual({ qualifyingActions: 8641n * 2n, issuanceTotal: 8641n * 5n });
  expect(result.recentBlocks).toEqual(new Map([[2, 300]]));
  expect(result.week).toEqual({ qualifyingActions: 20_001n * 2n, issuanceTotal: 20_001n * 5n });
  expect(result.supply[0]!.firstBlock).toBe(0n);
  expect(result.supply.length).toBeLessThanOrEqual(600);
  expect(issued(result)).toBe(20_001n * 5n);
  expect(getBlock).toHaveBeenCalledTimes(2);
  expect(getBlockEconomics.mock.calls.length).toBeLessThanOrEqual(5);
});
it("follows page cursors past the node's scan ceiling for the week and the whole supply history", async () => {
  const { node, getBlockEconomics } = economicsNode({ head: 100_000n });
  const result = await readIssuanceWindows(node);
  expect(result.supply.at(-1)!.lastBlock).toBe(100_000n);
  expect(issued(result)).toBe(100_001n * 5n);
  expect(result.week.issuanceTotal).toBe(60_481n * 5n);
  // 10-second test blocks: 50,400 blocks cover under a week, so the week window widens once.
  expect(getBlockEconomics.mock.calls.length).toBeLessThanOrEqual(14);
});
it("keeps blocks after the pinned head out of every series when the index advances mid-read", async () => {
  const { node } = economicsNode({ head: 1_000n, advancedHead: 1_003n, laterIssuance: 1_000_000n });
  const result = await readIssuanceWindows(node);
  expect(result.supply.at(-1)!.lastBlock).toBe(1_000n);
  expect(issued(result)).toBe(1_001n * 5n);
  expect(result.day.issuanceTotal).toBe(1_001n * 5n);
});
it("does not publish mixed history across a reorganization", async () => {
  await expect(readIssuanceWindows(economicsNode({ head: 20_000n, reorganized: true }).node)).rejects.toThrow("changed while loading");
});

describe("block split", () => {
  it("counts how many transactions per block get the full offer from the quote", () => {
    // Offer 50, block maximum 2,400: 48 mines each get 50; the 49th makes them share.
    expect(blockSplit(quote()).fullShares).toBe(48n);
    expect(blockSplit(quote({ internalOffer: 7n * unit, blockAllowance: 20n * unit })).fullShares).toBe(2n);
    expect(blockSplit(quote({ internalOffer: baseline * 4n, maxSingleActionReward: baseline * 3n })).fullShares).toBe(0n);
    expect(blockSplit(quote({ internalOffer: 0n, maxSingleActionReward: 0n })).fullShares).toBeUndefined();
    expect(blockSplit(quote())).toMatchObject({ maximum: baseline * 3n, each: baseline / 16n });
  });
  it("reads recent crowding from non-empty blocks and caps each share at the offer", () => {
    expect(actionsPerBlock(new Map([[1, 10], [4, 10]]))).toBe(2.5);
    expect(actionsPerBlock(quiet)).toBeUndefined();
    const offer = quote({ internalOffer: 500n * unit, blockAllowance: 1_500n * unit, maxSingleActionReward: 500n * unit });
    const calm = blockSplit(offer, every(2, 100));
    expect(calm.recent).toEqual({ perBlock: 2, each: 500n * unit });
    expect(crowdedBlockActions(calm)).toBe(0n);
    const crowded = blockSplit(offer, new Map([[4, 10], [6, 10]]));
    expect(crowded.recent).toEqual({ perBlock: 5, each: 300n * unit });
    expect(crowdedBlockActions(crowded)).toBe(5n);
    expect(crowdedBlockActions(blockSplit(offer, new Map([[4, 1], [5, 1]])))).toBe(5n);
    expect(crowdedBlockActions(blockSplit(offer))).toBe(0n);
  });
});
