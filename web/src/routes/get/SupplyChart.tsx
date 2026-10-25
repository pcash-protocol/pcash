import type { IssuanceQuoteResult } from "@pcash/sdk/clients";
import { PcashAmount } from "../../components/PcashAmount.tsx";
import { ChartTooltip, Legend, compactNumber, niceTicks, timeLabel, timeTicks, useChartWidth, useCrosshair } from "./chartParts.tsx";
import { REFERENCE_SECONDS, lagSeconds, pcashNumber, referenceStart, referenceSupply, scheduleWindow, supplyPoints, type IssuanceHistory } from "./issuanceOverviewModel.ts";
import styles from "./IssuanceOverview.module.css";

const HEIGHT = 270;
const PAD = { left: 56, right: 18, top: 24, bottom: 44 };
const SAMPLES = 160;
const DAY = 86_400;

const pcashLabel = (value: number) => `${compactNumber(value)} PCASH`;

function days(seconds: number): string {
  const value = Math.abs(seconds) / DAY;
  if (value < 1) {
    const hours = Math.max(1, Math.round(value * 24));
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${rounded === 1 ? "day" : "days"}`;
}

/** Share of the cap issued; small shares keep enough digits to be nonzero. */
export function issuedPercent(issued: bigint, cap: bigint): string {
  if (cap === 0n || issued === 0n) return "0%";
  const percent = Number(issued) / Number(cap) * 100;
  if (percent < 0.0001) return "<0.0001%";
  return `${new Intl.NumberFormat("en", { maximumSignificantDigits: percent < 1 ? 2 : 3 }).format(percent)}%`;
}

/** Where issued supply stands against the target schedule, in PCASH and in time. */
export function supplyStatus(quote: IssuanceQuoteResult, now: number): string {
  const anchor = referenceStart(quote);
  const gap = referenceSupply(quote.supplyCap, now - anchor) - pcashNumber(quote.issuedSoFar);
  const lag = lagSeconds(quote.lagQ);
  if (Math.abs(lag) < 3_600) return "Issuance is on the target schedule.";
  return `${lag > 0 ? "Behind" : "Ahead of"} the target by ${pcashLabel(Math.abs(gap))}: the target reached today's supply ${days(lag)} ${lag > 0 ? "ago" : "from now"}.`;
}

export function SupplyChart({ quote, history }: { quote: IssuanceQuoteResult; history: IssuanceHistory | undefined }) {
  const chart = useChartWidth();
  const { now, anchor, start, end } = scheduleWindow(quote, history);
  const cap = pcashNumber(quote.supplyCap);
  const issuedNow = pcashNumber(quote.issuedSoFar);
  const actual = history === undefined ? [] : supplyPoints(history.supply).filter(point => point.time <= now);
  if (actual.length > 0 && actual.at(-1)!.time < now) actual.push({ time: now, issued: issuedNow });
  const target = (time: number) => referenceSupply(quote.supplyCap, time - anchor);
  const top = cap;
  const width = chart.width;
  const x0 = PAD.left, x1 = width - PAD.right, y0 = PAD.top, y1 = HEIGHT - PAD.bottom;
  const xAt = (time: number) => x0 + (time - start) / (end - start) * (x1 - x0);
  const yAt = (value: number) => y1 - value / top * (y1 - y0);
  const curveStart = Math.max(start, Math.min(anchor, end));
  const samples = Array.from({ length: SAMPLES + 1 }, (_, index) => curveStart + (end - curveStart) * index / SAMPLES);
  const stopTimes = [...actual.map(point => point.time), ...samples.filter(time => time > now)];
  const crosshair = useCrosshair(stopTimes.map(xAt));
  const issuedAt = (time: number) => {
    let value: number | undefined;
    for (const point of actual) if (point.time <= time) value = point.issued;
    return value;
  };
  const targetPath = samples.map((time, index) => `${index === 0 ? "M" : "L"}${xAt(time).toFixed(1)} ${yAt(target(time)).toFixed(1)}`).join(" ");
  const actualPath = actual.map((point, index) => `${index === 0 ? "M" : "L"}${xAt(point.time).toFixed(1)} ${yAt(point.issued).toFixed(1)}`).join(" ");
  const times = timeTicks(start, end);
  const activeTime = crosshair.index === undefined ? undefined : stopTimes[crosshair.index];
  const activeIssued = activeTime === undefined || activeTime > now ? undefined : issuedAt(activeTime);
  const labelTime = anchor + REFERENCE_SECONDS / 2 > start && anchor + REFERENCE_SECONDS / 2 < end ? anchor + REFERENCE_SECONDS / 2 : undefined;
  const completes = new Date((anchor + REFERENCE_SECONDS) * 1000).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  return <section className={`panel ${styles.chartCard}`} aria-labelledby="supply-title">
    <p className="eyebrow">Supply</p>
    <h2 id="supply-title">{issuedPercent(quote.issuedSoFar, quote.supplyCap)} issued</h2>
    <p className={styles.lede}><PcashAmount value={quote.issuedSoFar} /> issued of <PcashAmount value={quote.supplyCap} />; <PcashAmount value={quote.supplyCap - quote.issuedSoFar} rounding="down" /> left. Gross issuance counts PCASH later spent or burned.</p>
    <p className={styles.status}>{supplyStatus(quote, now)}</p>
    <Legend items={[{ kind: "line", label: "Issued" }, { kind: "dash", label: "Target" }]} />
    <div ref={chart.ref} className={styles.chartFrame}>
      {activeTime !== undefined && <ChartTooltip x={xAt(activeTime)} width={width} title={new Date(activeTime * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} rows={[
        ...(activeIssued === undefined ? [] : [{ kind: "line" as const, label: "issued", value: pcashLabel(activeIssued) }]),
        { kind: "dash", label: "target", value: pcashLabel(target(activeTime)) },
      ]} />}
      <svg className={styles.chart} viewBox={`0 0 ${width} ${HEIGHT}`} tabIndex={0} {...crosshair.handlers} role="img"
        aria-label={`Issued supply against the target schedule. Issued now: ${pcashLabel(issuedNow)}; target now: ${pcashLabel(target(now))}.`}>
        {niceTicks(top).map(value => <g key={value}><path className={value === 0 ? styles.axis : styles.grid} d={`M${x0} ${yAt(value).toFixed(1)} H${x1}`} /><text x={x0 - 8} y={yAt(value) + 4} textAnchor="end">{compactNumber(value)}</text></g>)}
        {times.map(time => <text key={time} x={xAt(time)} y={y1 + 22} textAnchor="middle">{timeLabel(time, end - start)}</text>)}
        <path className={styles.today} d={`M${xAt(now).toFixed(1)} ${y0 - 6} V${y1}`} />
        <text className={styles.endLabel} x={xAt(now) + 6} y={y0 + 4}>Today: {compactNumber(issuedNow)} issued</text>
        {anchor < end && <path className={styles.dashed} d={targetPath} />}
        {labelTime !== undefined && <text x={xAt(labelTime)} y={yAt(target(labelTime)) - 12} textAnchor="middle">Target</text>}
        {actual.length > 1 && <path className={styles.line} d={actualPath} />}
        <circle className={styles.endDot} cx={xAt(now)} cy={yAt(issuedNow)} r="5" />
        {activeTime !== undefined && <><path className={styles.crosshair} d={`M${xAt(activeTime)} ${y0} V${y1}`} />
          {activeIssued !== undefined && <circle className={styles.endDot} cx={xAt(activeTime)} cy={yAt(activeIssued)} r="5" />}
          <circle className={styles.hollowDot} cx={xAt(activeTime)} cy={yAt(target(activeTime))} r="4" /></>}
      </svg>
    </div>
    <p className={styles.caption}>On the target schedule, all 1 billion PCASH is issued by {completes}, one year after the schedule starts. That is the fastest it can go: the protocol remembers at most 4 days of shortfall, so a quieter chain stretches the schedule instead of catching up later.</p>
    <details className={styles.table}><summary>Show data</summary><table>
      <thead><tr><th scope="col">Date</th><th scope="col">Issued</th><th scope="col">Target</th></tr></thead>
      <tbody>{times.map(time => <tr key={time}><th scope="row">{new Date(time * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</th><td>{time > now ? "—" : pcashLabel(issuedAt(time) ?? 0)}</td><td>{pcashLabel(target(time))}</td></tr>)}</tbody>
    </table></details>
  </section>;
}
