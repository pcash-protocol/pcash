import { useEffect, useState } from "react";

/** Minutes and seconds since `startedAt`, ticking once a second. */
export function ElapsedTime({ startedAt, className }: { startedAt: number; className?: string | undefined }) {
  const [seconds, setSeconds] = useState(() => Math.floor((Date.now() - startedAt) / 1_000));
  useEffect(() => {
    const update = () => setSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return <span className={className} aria-label="Elapsed time">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} elapsed</span>;
}
