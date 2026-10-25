import type { ProveStatus } from "@pcash/sdk/browser-prover/requests";
import { useEffect, useMemo, useState } from "react";
import { proofCompletion, proofStage, readProofTimings, type ProofCompletion } from "./proofStages.ts";

/**
 * Work done on the proof `proof` belongs to, undefined until the prover reports
 * a stage. It reads this device's timings; each prover's status intake records
 * them, because React may never render a completion that the next update follows.
 */
export function useProofCompletion(proof: ProveStatus | undefined): ProofCompletion | undefined {
  const stage = proofStage(proof);
  // Each update is a new object; the current operation's share grows from its arrival.
  const arrivedAt = useMemo(() => Date.now(), [proof]);
  const timings = useMemo(() => readProofTimings(), [proof]);
  const [now, setNow] = useState(Date.now);
  const running = stage !== undefined && !stage.completed;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running, proof]);
  return stage === undefined ? undefined : proofCompletion(stage, Math.max(now - arrivedAt, 0), timings);
}
