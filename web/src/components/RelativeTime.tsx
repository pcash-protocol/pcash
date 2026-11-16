import { useSyncExternalStore } from "react";
import { formatTime, relativeTime, timeLeft } from "../routes/explorer/format.ts";

const TICK_MS = 15_000;
const listeners = new Set<() => void>();
let tick = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(() => { tick += 1; for (const notify of listeners) notify(); }, TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) { clearInterval(timer); timer = undefined; }
  };
}

/**
 * A compact age, or with `until` the time left, that keeps itself current,
 * with the absolute time on hover. All instances share one clock.
 */
export function RelativeTime({ seconds, suffix = false, until = false }: { seconds: bigint; suffix?: boolean; until?: boolean }) {
  useSyncExternalStore(subscribe, () => tick, () => tick);
  return <time dateTime={new Date(Number(seconds) * 1000).toISOString()} title={formatTime(seconds)}>
    {until ? timeLeft(seconds) : relativeTime(seconds)}{suffix ? until ? " left" : " ago" : ""}
  </time>;
}
