import { useCallback, useRef, useState } from "react";

/**
 * Holds a form from the moment it is submitted until its work settles. The ref
 * refuses a second submission that arrives before the locked form renders;
 * `locked` disables the form. The work must handle its own errors.
 */
export function useSubmitLock() {
  const held = useRef(false);
  const [locked, setLocked] = useState(false);
  const hold = useCallback((work: () => Promise<void>) => {
    if (held.current) return;
    held.current = true;
    setLocked(true);
    void work().finally(() => {
      held.current = false;
      setLocked(false);
    });
  }, []);
  return { locked, hold };
}
