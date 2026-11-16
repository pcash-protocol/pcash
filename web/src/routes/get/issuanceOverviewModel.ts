import type { BlockEconomicsRecordResult, IssuanceQuoteResult, PcashNodeClient } from "@pcash/sdk/clients";

// The reference schedule and controller in node/crates/issuance/src/lib.rs.
export const REFERENCE_SECONDS = 365 * 86_400;
const REFERENCE_INTERVAL_SECONDS = 12;
const HALF_LIFE_SECONDS = 2 * 86_400;
const MAXIMUM_LAG_SECONDS = 4 * 86_400;
const DAY_SECONDS = 86_400;
const BLOCKS_PER_DAY = DAY_SECONDS / REFERENCE_INTERVAL_SECONDS;
const Q = 2 ** 128;

/** Display-only conversion; chart geometry does not need exact base units. */
export const pcashNumber = (value: bigint) => Number(value) / 1e18;

/** Seconds of reference progress that `issued` represents: T(1 − √(1 − I/S)). */
export function referenceProgressSeconds(cap: bigint, issued: bigint): number {
  const fraction = cap === 0n ? 1 : Number(issued) / Number(cap);
  return REFERENCE_SECONDS * (1 - Math.sqrt(Math.max(0, 1 - fraction)));
}

/** PCASH the reference pace has issued `seconds` after it starts: S(2u − u²), u = seconds / T. */
export function referenceSupply(cap: bigint, seconds: number): number {
  const u = Math.min(1, Math.max(0, seconds / REFERENCE_SECONDS));
  return pcashNumber(cap) * (2 * u - u * u);
}

/** PCASH per day the reference pace issues `seconds` after it starts: the curve's slope, 2S(1 − u)/T. Zero outside the schedule. */
export function referenceRatePerDay(cap: bigint, seconds: number): number {
  const u = seconds / REFERENCE_SECONDS;
  return u < 0 || u > 1 ? 0 : pcashNumber(cap) * 2 * (1 - u) / REFERENCE_SECONDS * DAY_SECONDS;
}

/** Signed seconds from a Q128 lag. */
export function lagSeconds(lag: bigint): number {
  return Number(lag) / Q;
}

/**
 * When the reference pace the controller steers toward began. The parent's lag
 * is elapsed reference time minus the progress issued so far, so the gap
 * between issued supply and this curve is exactly the controller's lag.
 */
export function referenceStart(quote: Pick<IssuanceQuoteResult, "parent" | "supplyCap" | "issuedSoFar" | "lagQ">): number {
  return Number(quote.parent.timestamp) - referenceProgressSeconds(quote.supplyCap, quote.issuedSoFar) - lagSeconds(quote.lagQ);
}

export interface RewardPosition {
  /** What one mine earns alone in the next block, before sharing with other mines. */
  reward: bigint;
  /** The target rate: the reward that issues on schedule when one action qualifies per block. */
  baseline: bigint;
  /** Reward relative to the target rate. */
  ratio: number;
  /** The most one mine can earn relative to the target rate: the block allowance. */
  maximumRatio: number;
  atMaximum: boolean;
  /** Positive when issuance is behind the target schedule, negative when ahead. */
  lagDays: number;
}

export function rewardPosition(quote: IssuanceQuoteResult): RewardPosition | undefined {
  if (quote.exhausted || quote.baseline === 0n) return undefined;
  const lag = lagSeconds(quote.lagQ);
  const maximumRatio = Number(quote.blockAllowance) / Number(quote.baseline);
  const atMaximum = quote.maxSingleActionReward >= quote.blockAllowance;
  return {
    reward: quote.maxSingleActionReward,
    baseline: quote.baseline,
    ratio: Number(quote.maxSingleActionReward) / Number(quote.baseline),
    maximumRatio,
    atMaximum,
    lagDays: lag / DAY_SECONDS,
  };
}

/** PCASH per day the schedule targets: the target rate once every 12-second block. */
export function targetPerDay(baseline: bigint): bigint {
  return baseline * BigInt(BLOCKS_PER_DAY);
}

export interface Pace {
  /** Length of the measured window; shorter than asked for on a young chain. */
  seconds: number;
  issuedPerDay: number;
  actionsPerDay: number;
  /** Issued per day relative to the target per day. */
  ratio: number;
}

/** Seconds of history in the newest `asked` seconds: all of them, or since genesis on a young chain. */
function windowSeconds(history: IssuanceHistory, asked: number): number {
  const since = history.supply[0]?.firstTimestamp;
  return since === undefined ? asked : Math.min(asked, Number(history.asOf - since));
}

/** Issuance per day over the newest `seconds` of history (or since genesis). */
export function measuredPace(history: IssuanceHistory, window: "day" | "week", baseline: bigint): Pace | undefined {
  const seconds = windowSeconds(history, window === "day" ? DAY_SECONDS : 7 * DAY_SECONDS);
  const target = pcashNumber(targetPerDay(baseline));
  if (seconds <= 0 || target === 0) return undefined;
  const activity = window === "day" ? history.day : history.week;
  const issuedPerDay = pcashNumber(activity.issuanceTotal) * DAY_SECONDS / seconds;
  return { seconds, issuedPerDay, actionsPerDay: Number(activity.qualifyingActions) * DAY_SECONDS / seconds, ratio: issuedPerDay / target };
}

/** Non-empty blocks per day, keyed by the qualifying actions each carried. */
export type BlockPattern = ReadonlyMap<number, number>;

/** The last day's qualifying actions (or those since genesis) as a daily block pattern: what the forecast assumes continues. */
export function dayBlockPattern(history: IssuanceHistory): BlockPattern | undefined {
  const seconds = windowSeconds(history, DAY_SECONDS);
  if (seconds <= 0) return undefined;
  const actionsPerDay = Number(history.day.qualifyingActions) * DAY_SECONDS / seconds;
  if (actionsPerDay === 0) return new Map();
  let sampled = 0;
  for (const [actions, blocks] of history.recentBlocks) sampled += actions * blocks;
  // Approximation: the day's actions arrive grouped like the recent block sample (one action per block if it has none).
  if (sampled === 0) return new Map([[1, actionsPerDay]]);
  return new Map([...history.recentBlocks].map(([actions, blocks]) => [actions, blocks * actionsPerDay / sampled]));
}

/** Mean qualifying actions per non-empty block in `pattern`; undefined when it has none. */
export function actionsPerBlock(pattern: BlockPattern): number | undefined {
  let actions = 0, blocks = 0;
  for (const [count, perDay] of pattern) { actions += count * perDay; blocks += perDay; }
  return blocks === 0 ? undefined : actions / blocks;
}

export interface BlockSplit {
  /** The block's pot: its allowance, shared equally by every qualifying transaction in it (§14.2). */
  maximum: bigint;
  /** What one transaction alone in its block earns: the offer, capped at the pot. */
  each: bigint;
  /** ⌊pot / offer⌋: how many transactions in one block each still get `each`. Undefined while the offer is zero. */
  fullShares: bigint | undefined;
  /** Recent qualifying transactions per non-empty block, and what each earns when a block holds that many. */
  recent?: { perBlock: number; each: bigint };
}

/** How the next block's issuance splits among its qualifying transactions, from the node's quote. */
export function blockSplit(quote: Pick<IssuanceQuoteResult, "internalOffer" | "blockAllowance" | "maxSingleActionReward">, pattern?: BlockPattern): BlockSplit {
  const split: BlockSplit = {
    maximum: quote.blockAllowance,
    each: quote.maxSingleActionReward,
    fullShares: quote.internalOffer === 0n ? undefined : quote.blockAllowance / quote.internalOffer,
  };
  const perBlock = pattern === undefined ? undefined : actionsPerBlock(pattern);
  if (perBlock === undefined) return split;
  const share = quote.blockAllowance * 1_000n / BigInt(Math.round(perBlock * 1_000));
  return { ...split, recent: { perBlock, each: share < split.each ? share : split.each } };
}

/** Qualifying actions a block holds at least when recent blocks are crowded enough to split below `each`; zero otherwise. */
export function crowdedBlockActions(split: BlockSplit): bigint {
  return split.recent === undefined || split.recent.each >= split.each ? 0n : BigInt(Math.ceil(split.recent.perBlock));
}

/**
 * Issuance per day relative to target when blocks keep arriving in `pattern`
 * and one action alone earns `ratio` times the target rate. A block of k
 * actions issues min(k × offer, allowance) (§14.2), so actions batched into one
 * block issue less than the same actions spread across blocks. Integer
 * rounding and the remaining-supply cap are ignored.
 */
export function paceRatio(position: Pick<RewardPosition, "maximumRatio">, pattern: BlockPattern, ratio: number): number {
  let issued = 0;
  for (const [actions, blocks] of pattern) issued += blocks * Math.min(actions * ratio, position.maximumRatio);
  return issued / BLOCKS_PER_DAY;
}

/**
 * Daily change of the reward when issuance runs at `paceRatio` of target. Lag
 * grows by (1 − ratio) per unit time and each half-life of lag doubles the reward.
 */
export function dailyChange(paceRatio: number): number {
  return 2 ** ((1 - paceRatio) * DAY_SECONDS / HALF_LIFE_SECONDS) - 1;
}

/** Where the reward settles under `pattern`: where issuance meets the target, or the maximum if even the maximum falls short. */
export function settledReward(position: RewardPosition, pattern: BlockPattern): { reward: number; capped: boolean } {
  const baseline = pcashNumber(position.baseline);
  const maximum = position.maximumRatio;
  if (paceRatio(position, pattern, maximum) < 1) return { reward: baseline * maximum, capped: true };
  // Pace never falls as the reward rises, so bisect for where it reaches the target.
  let low = 0, high = maximum;
  for (let step = 0; step < 50; step += 1) {
    const middle = (low + high) / 2;
    if (paceRatio(position, pattern, middle) < 1) low = middle; else high = middle;
  }
  return { reward: baseline * high, capped: false };
}

/** Days until the reward reaches its maximum under `pattern`; undefined if it levels off below it within `horizonDays`. */
export function daysUntilMaximum(position: RewardPosition, pattern: BlockPattern, horizonDays = 60): number | undefined {
  const maximum = pcashNumber(position.baseline) * position.maximumRatio;
  const reached = forecastRewards(position, pattern, horizonDays).find(point => point.reward >= maximum * 0.999);
  return reached === undefined ? undefined : reached.seconds / DAY_SECONDS;
}

export interface ForecastPoint { seconds: number; reward: number }

/**
 * The reward over the next `days` if blocks keep arriving in `pattern`,
 * stepping the controller hourly. The target rate is held fixed; it falls only
 * as supply is issued, which a week barely moves.
 */
export function forecastRewards(position: RewardPosition, pattern: BlockPattern, days = 7): ForecastPoint[] {
  const baseline = pcashNumber(position.baseline);
  const step = 3_600;
  // Start from the quoted reward itself rather than re-deriving it from the parent's lag.
  let lag = position.atMaximum || position.ratio <= 0 ? position.lagDays * DAY_SECONDS : HALF_LIFE_SECONDS * Math.log2(position.ratio);
  const points: ForecastPoint[] = [];
  for (let seconds = 0; seconds <= days * DAY_SECONDS; seconds += step) {
    const ratio = Math.min(2 ** (lag / HALF_LIFE_SECONDS), position.maximumRatio);
    points.push({ seconds, reward: baseline * ratio });
    lag = Math.min(MAXIMUM_LAG_SECONDS, lag + (1 - paceRatio(position, pattern, ratio)) * step);
  }
  return points;
}

export interface SupplyPoint { time: number; issued: number }

/** Cumulative gross issuance, starting from zero at the first record. */
export function supplyPoints(records: readonly BlockEconomicsRecordResult[]): SupplyPoint[] {
  const first = records[0];
  if (first === undefined) return [];
  let issued = 0n;
  return [{ time: Number(first.firstTimestamp), issued: 0 }, ...records.map((record) => {
    issued += record.issuanceTotal;
    return { time: Number(record.lastTimestamp), issued: pcashNumber(issued) };
  })];
}

export interface DailyIssuance { start: number; end: number; perDay: number }

/**
 * Issuance per day in whole days from the first record. Each record's issuance
 * is spread evenly over the time it covers, from its first block to the next
 * record's first block (for the newest record, one reference interval past its
 * last block), so a record that crosses midnight or spans several days is split by time. Each
 * day's rate is over the seconds its records cover, which scales the newest
 * partial day.
 */
export function dailyIssuance(records: readonly BlockEconomicsRecordResult[]): DailyIssuance[] {
  const first = records[0];
  if (first === undefined) return [];
  const origin = Number(first.firstTimestamp);
  const days = new Map<number, { issued: number; covered: number }>();
  records.forEach((record, index) => {
    const start = Number(record.firstTimestamp);
    const end = Number(records[index + 1]?.firstTimestamp ?? record.lastTimestamp + BigInt(REFERENCE_INTERVAL_SECONDS));
    const issued = pcashNumber(record.issuanceTotal);
    for (let day = Math.floor((start - origin) / DAY_SECONDS); origin + day * DAY_SECONDS < end; day += 1) {
      const overlap = Math.min(end, origin + (day + 1) * DAY_SECONDS) - Math.max(start, origin + day * DAY_SECONDS);
      const total = days.get(day) ?? { issued: 0, covered: 0 };
      days.set(day, { issued: total.issued + issued * overlap / (end - start), covered: total.covered + overlap });
    }
  });
  return [...days.entries()].sort(([left], [right]) => left - right).map(([day, { issued, covered }]) => {
    const start = origin + day * DAY_SECONDS;
    return { start, end: start + covered, perDay: issued * DAY_SECONDS / covered };
  });
}

/** One time axis for both schedule charts: genesis (or the schedule start) through the end of the target schedule. */
export function scheduleWindow(quote: Pick<IssuanceQuoteResult, "parent" | "supplyCap" | "issuedSoFar" | "lagQ">, history: IssuanceHistory | undefined) {
  const now = Number(quote.parent.timestamp);
  const anchor = referenceStart(quote);
  const genesis = history?.supply[0] === undefined ? now : Number(history.supply[0].firstTimestamp);
  return { now, anchor, start: Math.min(genesis, anchor, now), end: Math.max(now, anchor + REFERENCE_SECONDS) };
}

export interface IssuanceActivity { qualifyingActions: bigint; issuanceTotal: bigint }
export interface IssuanceHistory {
  /** Genesis to the head in at most about 600 buckets, oldest first. */
  supply: BlockEconomicsRecordResult[];
  day: IssuanceActivity;
  week: IssuanceActivity;
  /** Non-empty blocks among the newest `SAMPLE_BLOCKS`, keyed by the qualifying actions each carried. */
  recentBlocks: ReadonlyMap<number, number>;
  asOf: bigint;
}

const SUPPLY_RECORDS = 600;
/** Recent blocks read one by one to see how actions group into blocks. */
const SAMPLE_BLOCKS = 300n;
/** The node scans at most this many block rows per economics request and returns a cursor for the rest. */
const SCANNED_ROWS = 32_768;
const MAX_BUCKET = 32_768;

/** Bound history to an immutable indexed head, expanding coarse time coverage only when needed. */
export async function readIssuanceWindows(node: Pick<PcashNodeClient, "getBlockEconomics" | "getBlock">): Promise<IssuanceHistory> {
  const snapshot = await node.getBlockEconomics({ fromBlock: 0n, limit: 1, bucket: 1 });
  const head = await node.getBlock(snapshot.atBlockNumber);
  if (head === null || head.hash !== snapshot.atBlockHash) throw new Error("Issuance history changed while loading.");
  const incomplete = () => new Error("Issuance history window is incomplete.");
  // A bucket that straddles a window edge or the pinned head, read block by block through the head.
  const refined = new Map<bigint, Promise<BlockEconomicsRecordResult[]>>();
  const refine = (record: BlockEconomicsRecordResult) => {
    let promise = refined.get(record.firstBlock);
    if (promise === undefined) {
      promise = (async () => {
        const blocks: BlockEconomicsRecordResult[] = [];
        let from = record.firstBlock;
        const end = record.lastBlock < head.number ? record.lastBlock : head.number;
        for (let count = 0; count < 32 && from <= end; count += 1) {
          const result = await node.getBlockEconomics({ fromBlock: from, bucket: 1, limit: Math.min(1024, Number(end - from + 1n)) });
          const selected = result.records.filter(item => item.lastBlock <= end);
          if (selected.length === 0) throw incomplete();
          blocks.push(...selected); from = selected.at(-1)!.lastBlock + 1n;
        }
        if (from <= end) throw incomplete();
        return blocks;
      })();
      refined.set(record.firstBlock, promise);
    }
    return promise;
  };
  /**
   * Every bucket from `from` through the pinned head, following the node's page
   * cursor. A later page can come from a newer index head, so a bucket that runs
   * past the pinned head is replaced by its blocks through that head.
   */
  const through = async (from: bigint, bucket: number): Promise<BlockEconomicsRecordResult[]> => {
    if (bucket > MAX_BUCKET) throw new Error("Issuance history window is too large.");
    const span = Number(head.number - from + 1n);
    const pages = Math.ceil(span / SCANNED_ROWS) + Math.ceil(span / bucket / 1024) + 1;
    const records: BlockEconomicsRecordResult[] = [];
    let cursor: bigint | null = from;
    for (let page = 0; cursor !== null && cursor <= head.number; page += 1) {
      if (page === pages) throw incomplete();
      const result = await node.getBlockEconomics({ fromBlock: cursor, bucket, limit: 1024 });
      for (const record of result.records) {
        if (record.firstBlock > head.number) break;
        records.push(...(record.lastBlock > head.number ? await refine(record) : [record]));
      }
      if (result.nextBlock !== null && result.nextBlock <= cursor) throw incomplete();
      cursor = records.at(-1)?.lastBlock === head.number ? null : result.nextBlock;
    }
    if (records.at(-1)?.lastBlock !== head.number) throw incomplete();
    return records;
  };
  const weekCutoff = head.timestamp - 7n * 86_400n;
  let span = 50_400n;
  let records: BlockEconomicsRecordResult[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const start = head.number > span ? head.number - span : 0n;
    records = await through(start, Math.max(1, Math.ceil(Number(head.number - start + 1n) / 900)));
    const first = records[0]!;
    if (first.firstTimestamp <= weekCutoff || first.firstBlock === 0n) break;
    if (attempt === 3) throw incomplete();
    span *= 16n;
  }
  const window = async (cutoff: bigint) => (await Promise.all(records.filter(record => record.lastTimestamp >= cutoff).map(async record =>
    record.firstTimestamp < cutoff ? (await refine(record)).filter(item => item.firstTimestamp >= cutoff) : [record]))).flat();
  // Settlement caps each block, not each action (§14.2), so the reward forecast needs how actions group into blocks.
  const sample = async () => (await node.getBlockEconomics({ fromBlock: head.number >= SAMPLE_BLOCKS ? head.number - SAMPLE_BLOCKS + 1n : 0n, bucket: 1, limit: Number(SAMPLE_BLOCKS) }))
    .records.filter(record => record.lastBlock <= head.number);
  const supplyBucket = Math.min(MAX_BUCKET, Math.max(1, Math.ceil(Number(head.number + 1n) / SUPPLY_RECORDS)));
  const [dayRecords, weekRecords, supply, sampleRecords] = await Promise.all([window(head.timestamp - 86_400n), window(weekCutoff), through(0n, supplyBucket), sample()]);
  const total = (items: BlockEconomicsRecordResult[]): IssuanceActivity => items.reduce((sum, record) => ({ qualifyingActions: sum.qualifyingActions + record.qualifyingActions, issuanceTotal: sum.issuanceTotal + record.issuanceTotal }), { qualifyingActions: 0n, issuanceTotal: 0n });
  const byActions = new Map<number, number>();
  for (const record of sampleRecords) {
    const actions = Number(record.qualifyingActions);
    if (actions > 0) byActions.set(actions, (byActions.get(actions) ?? 0) + 1);
  }
  const confirmed = await node.getBlock(head.number);
  if (confirmed?.hash !== snapshot.atBlockHash) throw new Error("Issuance history changed while loading.");
  return { supply, day: total(dayRecords), week: total(weekRecords), recentBlocks: byActions, asOf: head.timestamp };
}
