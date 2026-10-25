import type { IssuanceQuoteResult } from "@pcash/sdk/clients";
import { PcashAmount } from "../../components/PcashAmount.tsx";
import { formatPcashAmount } from "../../components/pcashAmount.ts";
import { formatRatio } from "./chartParts.tsx";
import { blockSplit, dailyChange, dayBlockPattern, daysUntilMaximum, paceRatio, pcashNumber, rewardPosition, settledReward, type BlockPattern, type BlockSplit, type IssuanceHistory, type RewardPosition } from "./issuanceOverviewModel.ts";
import styles from "./RewardNow.module.css";

function duration(days: number): string {
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * 24));
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const rounded = days < 10 ? Math.round(days * 10) / 10 : Math.round(days);
  return `${rounded} ${rounded === 1 ? "day" : "days"}`;
}

/** A whole-PCASH value without its unit, for labels on the reward scale. */
const scaleValue = (value: bigint) => formatPcashAmount(value).replace(/ PCASH$/, "");
const percent = (value: number) => `${Math.round(Math.abs(value) * 100).toLocaleString()}%`;
const roundPcash = (value: number) => value > 0 && value < 1 ? "<1 PCASH" : `${new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value)} PCASH`;

/** How a block's maximum is shared: who gets the full reward, and what recent blocks paid each. */
export function splitLines(split: BlockSplit): string[] {
  const lines: string[] = [];
  if (split.fullShares !== undefined) lines.push(split.fullShares <= 1n
    ? "Every block pays its maximum, split among everyone mining in it."
    : `Up to ${split.fullShares.toLocaleString()} mines per block each get the full ${formatPcashAmount(split.each)}; with more, they share the block maximum equally.`);
  if (split.recent !== undefined) lines.push(`Recently about ${Math.max(1, Math.round(split.recent.perBlock)).toLocaleString()} per block, so about ${formatPcashAmount(split.recent.each)} each.`);
  return lines;
}

/** Which way the reward is moving if the last day's blocks keep arriving, and where that leads. */
export function rewardTrend(position: RewardPosition, pattern: BlockPattern): string {
  const maximum = roundPcash(pcashNumber(position.baseline) * position.maximumRatio);
  const pace = paceRatio(position, pattern, position.ratio);
  if (position.atMaximum && pace < 1) return `At its maximum of ${maximum} per mine`;
  const change = dailyChange(pace);
  if (Math.abs(change) < 0.01) return "Steady: issuance is keeping pace with the target";
  const direction = `${change > 0 ? "Rising" : "Falling"} ${percent(change)} a day ${pattern.size === 0 ? "while nobody mines" : "at the current pace"}`;
  const settled = settledReward(position, pattern);
  if (!settled.capped) return `${direction}, leveling off near ${roundPcash(settled.reward)} per mine`;
  const days = daysUntilMaximum(position, pattern);
  return days === undefined ? direction : `${direction}; it reaches its maximum of ${maximum} per mine in about ${duration(days)}`;
}

export function RewardNow({ quote, history, error }: { quote: IssuanceQuoteResult | null | undefined; history?: IssuanceHistory | undefined; error?: string | undefined }) {
  if (quote === undefined) return <div className={styles.reward}><p className="eyebrow">Mining reward now</p><p className={styles.placeholder}>{error ?? "Loading the current reward…"}</p></div>;
  if (quote === null) return <div className={styles.reward}><p className="eyebrow">Mining reward now</p><p className={styles.placeholder}>The mining reward is available after the first PCASH block.</p></div>;
  const position = rewardPosition(quote);
  if (position === undefined) return <div className={styles.reward}><p className="eyebrow">Mining reward now</p><p className={styles.hero}>0 PCASH</p><p>All PCASH has been issued. Relaying fee-paying transactions still earns their fees.</p></div>;
  const pattern = history === undefined ? undefined : dayBlockPattern(history);
  const split = blockSplit(quote, pattern);
  const fill = Math.min(100, position.ratio / position.maximumRatio * 100);
  const target = 100 / position.maximumRatio;
  const relative = position.ratio < 1 ? `${new Intl.NumberFormat("en", { maximumSignificantDigits: 2 }).format(position.ratio * 100)}% of the target rate` : `${formatRatio(position.ratio)} the target rate`;
  return <div className={styles.reward}>
    <p className="eyebrow">Mining reward now</p>
    <p className={styles.hero}>{formatPcashAmount(position.reward)}</p>
    <p className={styles.unit}>per mine · {relative} (<PcashAmount value={position.baseline} />)</p>
    <div className={styles.scale} role="meter" aria-valuemin={0} aria-valuemax={position.maximumRatio} aria-valuenow={position.ratio}
      aria-valuetext={`${formatPcashAmount(split.each)} per mine; the target is ${formatPcashAmount(position.baseline)} and the block maximum ${formatPcashAmount(split.maximum)}`} aria-label="Mining reward against its range">
      <div className={styles.nowLabel} aria-hidden="true"><span style={{ left: `${fill}%`, transform: `translateX(-${fill}%)` }}>{scaleValue(position.reward)}</span></div>
      <div className={styles.track}><div className={styles.fill} style={{ width: `${fill}%` }} /><span className={styles.referenceTick} style={{ left: `${target}%` }} /></div>
      <div className={styles.scaleLabels} aria-hidden="true"><span>0</span><span style={{ left: `${target}%` }}>Target {scaleValue(position.baseline)}</span><span>Block maximum {scaleValue(split.maximum)}</span></div>
    </div>
    {splitLines(split).map(line => <p key={line} className={styles.split}>{line}</p>)}
    {pattern !== undefined && <p className={styles.trend}>{rewardTrend(position, pattern)}</p>}
    <p className={styles.mechanism}>The protocol targets a pace of new PCASH per day. The target rate is what one mine earns when a transaction qualifies every block and issuance is on schedule. The reward rises while issuance runs behind the schedule, doubling for every 2 days behind, and falls while it runs ahead.</p>
  </div>;
}
