import type { IssuanceQuoteResult } from "@pcash/sdk/clients";
import { ChartTooltip, Legend, compactNumber, niceTicks, timeLabel, timeTicks, useChartWidth, useCrosshair } from "./chartParts.tsx";
import { dailyIssuance, referenceRatePerDay, scheduleWindow, type IssuanceHistory } from "./issuanceOverviewModel.ts";
import styles from "./IssuanceOverview.module.css";

const HEIGHT = 250;
const PAD = { left: 56, right: 18, top: 24, bottom: 44 };
const SAMPLES = 160;

const perDay = (value: number) => `${compactNumber(value)} PCASH a day`;
const dateLabel = (seconds: number) => new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** The target rate falls in a straight line over the schedule; actual daily issuance sits against it. */
export function IssuanceRateChart({ quote, history }: { quote: IssuanceQuoteResult; history: IssuanceHistory | undefined }) {
  const chart = useChartWidth();
  const { now, anchor, start, end } = scheduleWindow(quote, history);
  const target = (time: number) => referenceRatePerDay(quote.supplyCap, time - anchor);
  const actual = history === undefined ? [] : dailyIssuance(history.supply).filter(day => day.start <= now);
  const top = Math.max(target(anchor), ...actual.map(day => day.perDay), 1) * 1.1;
  const width = chart.width;
  const x0 = PAD.left, x1 = width - PAD.right, y0 = PAD.top, y1 = HEIGHT - PAD.bottom;
  const xAt = (time: number) => x0 + (time - start) / (end - start) * (x1 - x0);
  const yAt = (value: number) => y1 - value / top * (y1 - y0);
  const curveStart = Math.max(start, Math.min(anchor, end));
  const samples = Array.from({ length: SAMPLES + 1 }, (_, index) => curveStart + (end - curveStart) * index / SAMPLES);
  const actualPoints = actual.map(day => ({ time: (day.start + day.end) / 2, value: day.perDay }));
  const stopTimes = [...actualPoints.map(point => point.time), ...samples.filter(time => time > now)];
  const crosshair = useCrosshair(stopTimes.map(xAt));
  const path = (items: readonly { time: number; value: number }[]) => items.map((item, index) => `${index === 0 ? "M" : "L"}${xAt(item.time).toFixed(1)} ${yAt(item.value).toFixed(1)}`).join(" ");
  const activeTime = crosshair.index === undefined ? undefined : stopTimes[crosshair.index];
  const activeDay = activeTime === undefined ? undefined : actual.find(day => activeTime >= day.start && activeTime <= day.end);
  const times = timeTicks(start, end);
  return <section className={`panel ${styles.chartCard}`} aria-labelledby="rate-title">
    <p className="eyebrow">Issuance rate</p>
    <h2 id="rate-title">New PCASH per day</h2>
    <p className={styles.lede}>The target rate starts at {perDay(target(anchor))} and falls in a straight line to zero over the schedule. The actual rate is what was issued each day.</p>
    <Legend items={[{ kind: "line", label: "Actual" }, { kind: "dash", label: "Target" }]} />
    <div ref={chart.ref} className={styles.chartFrame}>
      {activeTime !== undefined && <ChartTooltip x={xAt(activeTime)} width={width} title={dateLabel(activeTime)} rows={[
        ...(activeDay === undefined ? [] : [{ kind: "line" as const, label: "actual", value: perDay(activeDay.perDay) }]),
        { kind: "dash", label: "target", value: perDay(target(activeTime)) },
      ]} />}
      <svg className={styles.chart} viewBox={`0 0 ${width} ${HEIGHT}`} tabIndex={0} {...crosshair.handlers} role="img"
        aria-label={`Target issuance falls from ${perDay(target(anchor))} to zero between ${dateLabel(anchor)} and ${dateLabel(end)}. Actual issuance over the last day: ${actual.length === 0 ? "none recorded" : perDay(actual.at(-1)!.perDay)}.`}>
        {niceTicks(top).map(value => <g key={value}><path className={value === 0 ? styles.axis : styles.grid} d={`M${x0} ${yAt(value).toFixed(1)} H${x1}`} /><text x={x0 - 8} y={yAt(value) + 4} textAnchor="end">{compactNumber(value)}</text></g>)}
        {times.map(time => <text key={time} x={xAt(time)} y={y1 + 22} textAnchor="middle">{timeLabel(time, end - start)}</text>)}
        <path className={styles.today} d={`M${xAt(now).toFixed(1)} ${y0 - 6} V${y1}`} />
        <text className={styles.endLabel} x={xAt(now) + 6} y={y0 + 4}>Today: {actual.length === 0 ? "—" : perDay(actual.at(-1)!.perDay)}</text>
        {anchor < end && <path className={styles.dashed} d={path(samples.map(time => ({ time, value: target(time) })))} />}
        {actualPoints.length > 1 && <path className={styles.line} d={path(actualPoints)} />}
        {actualPoints.length > 0 && <circle className={styles.endDot} cx={xAt(actualPoints.at(-1)!.time)} cy={yAt(actualPoints.at(-1)!.value)} r="5" />}
        {activeTime !== undefined && <><path className={styles.crosshair} d={`M${xAt(activeTime)} ${y0} V${y1}`} />
          <circle className={styles.hollowDot} cx={xAt(activeTime)} cy={yAt(target(activeTime))} r="4" /></>}
      </svg>
    </div>
    <p className={styles.caption}>The actual rate can run up to 3× the target in a busy block, and far below it when few people mine; the reward per mine adjusts to pull it back toward the target.</p>
    <details className={styles.table}><summary>Show data</summary><table>
      <thead><tr><th scope="col">Date</th><th scope="col">Actual</th><th scope="col">Target</th></tr></thead>
      <tbody>{times.map(time => {
        const day = actual.find(item => time >= item.start && time <= item.end);
        return <tr key={time}><th scope="row">{dateLabel(time)}</th><td>{day === undefined ? "—" : perDay(day.perDay)}</td><td>{perDay(target(time))}</td></tr>;
      })}</tbody>
    </table></details>
  </section>;
}
