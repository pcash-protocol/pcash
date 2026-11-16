import { useCallback, useEffect, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import styles from "./IssuanceOverview.module.css";

export function useChartWidth() {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(640);
  const ref = useCallback((value: HTMLDivElement | null) => setElement(value), []);
  useEffect(() => {
    if (element === null) return;
    const measure = () => {
      const measured = element.getBoundingClientRect().width;
      if (measured > 0) setWidth(measured);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return { ref, width };
}

/** Snap a pointer or arrow key to the nearest stop; the same readout on hover and keyboard focus. */
export function useCrosshair(stops: readonly number[]) {
  const [index, setIndex] = useState<number>();
  const clamp = (value: number) => Math.max(0, Math.min(stops.length - 1, value));
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (stops.length === 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    const scale = box.width === 0 ? 1 : event.currentTarget.viewBox.baseVal.width / box.width;
    const x = (event.clientX - box.left) * scale;
    let nearest = 0;
    for (let candidate = 1; candidate < stops.length; candidate += 1) {
      if (Math.abs(stops[candidate]! - x) < Math.abs(stops[nearest]! - x)) nearest = candidate;
    }
    setIndex(nearest);
  };
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (stops.length === 0) return;
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (event.key === "Home") setIndex(0);
    else if (event.key === "End") setIndex(stops.length - 1);
    else if (step !== 0) setIndex(clamp((index ?? stops.length - 1) + step));
    else return;
    event.preventDefault();
  };
  const active = index === undefined || stops.length === 0 ? undefined : clamp(index);
  return {
    index: active,
    handlers: {
      onPointerMove,
      onPointerLeave: () => setIndex(undefined),
      onFocus: () => setIndex(stops.length - 1),
      onBlur: () => setIndex(undefined),
      onKeyDown,
    },
  };
}

export type SeriesKey = "line" | "dash";

export function SeriesSwatch({ kind }: { kind: SeriesKey }) {
  return <svg className={styles.swatch} viewBox="0 0 18 10" aria-hidden="true">
    <path className={kind === "dash" ? styles.swatchDash : undefined} d="M1 5 H17" />
  </svg>;
}

export function Legend({ items }: { items: readonly { kind: SeriesKey; label: string }[] }) {
  return <ul className={styles.legend}>{items.map(item => <li key={item.label}><SeriesSwatch kind={item.kind} />{item.label}</li>)}</ul>;
}

/** Readout pinned above the plot at the crosshair; values lead, labels follow. */
export function ChartTooltip({ x, width, title, rows }: { x: number; width: number; title: string; rows: readonly { kind: SeriesKey; label: string; value: ReactNode }[] }) {
  const left = Math.max(0, Math.min(100, x / width * 100));
  return <div className={styles.tooltip} style={{ left: `${left}%`, transform: `translateX(-${left}%)` }} role="status">
    <p>{title}</p>
    {rows.map(row => <div key={row.label}><SeriesSwatch kind={row.kind} /><strong>{row.value}</strong><span>{row.label}</span></div>)}
  </div>;
}

const HOUR = 3_600;
const DAY = 86_400;
const STEPS = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 61 * DAY, 91 * DAY];

/** At most `count` evenly stepped times inside [start, end], aligned to local hours or midnights. */
export function timeTicks(start: number, end: number, count = 6): number[] {
  const step = STEPS.find(candidate => (end - start) / candidate <= count) ?? STEPS.at(-1)!;
  const first = new Date(start * 1000);
  if (step < DAY) first.setMinutes(0, 0, 0);
  else first.setHours(0, 0, 0, 0);
  const ticks: number[] = [];
  for (let time = first.getTime() / 1000; time <= end; time += step) if (time >= start) ticks.push(time);
  return ticks;
}

export function timeLabel(seconds: number, span: number): string {
  const date = new Date(seconds * 1000);
  return span <= 2 * DAY
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A reward as a multiple of the reference rate: "1/16×" below it, "2.5×" above. */
export function formatRatio(ratio: number): string {
  if (ratio <= 0) return "0×";
  if (ratio < 1) {
    const inverse = 1 / ratio;
    if (Math.abs(inverse - Math.round(inverse)) < 0.02 && Math.round(inverse) <= 1024) return `1/${Math.round(inverse)}×`;
    return `${new Intl.NumberFormat("en", { maximumSignificantDigits: 2 }).format(ratio)}×`;
  }
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: ratio < 10 ? 2 : 1 }).format(ratio)}×`;
}

/** Round axis values from 0 to at most `top`: steps of 1, 2, 2.5 or 5 times a power of ten. */
export function niceTicks(top: number, count = 4): number[] {
  if (!(top > 0)) return [0];
  const raw = top / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(factor => factor * power).find(candidate => candidate >= raw)!;
  const ticks: number[] = [];
  for (let value = 0; value <= top; value += step) ticks.push(value);
  return ticks;
}

/** Whole numbers below 1,000, compact above it ("5.48M"), and "<1" for a small nonzero value, like whole PCASH amounts. */
export const compactNumber = (value: number) => value > 0 && value < 1 ? "<1"
  : new Intl.NumberFormat("en", { maximumFractionDigits: Math.abs(value) < 1_000 ? 0 : 2, notation: "compact" }).format(value);
