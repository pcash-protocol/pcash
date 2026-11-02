import { useEffect, useState } from "react";

/** The current time in seconds, refreshed every 15 seconds. */
export function useNowSeconds(): bigint {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  return BigInt(Math.floor(now / 1_000));
}
