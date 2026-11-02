import { useEffect } from "react";
import { useBlocker } from "react-router-dom";
import { confirmDiscardGetWork } from "../../lib/GetActivity.tsx";

/** Hash changes open wallet panels without discarding this page's work. */
export function useGetNavigationGuard(active: boolean) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => active && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (confirmDiscardGetWork()) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
}
