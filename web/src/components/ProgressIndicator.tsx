import type { ProveStatus } from "@pcash/sdk/browser-prover/requests";
import { proofStage } from "./proofStages.ts";
import styles from "./ProgressIndicator.module.css";

export function proofProgressMessage(proof: ProveStatus | undefined): string {
  const stage = proofStage(proof);
  if (stage !== undefined) {
    const circuit = `${(stage.circuitIndex ?? 0) + 1} of ${stage.circuitCount}`;
    switch (stage.kind) {
      case "load": return "Loading the proof circuits…";
      case "execute": return `Running circuit ${circuit}…`;
      case "start": return "Starting the proof…";
      case "fold": return `Proving circuit ${circuit}…`;
      case "finalize": return "Finishing the proof. This step takes longest.";
      case "compress": return "Compressing the proof…";
    }
  }
  switch (proof?.step) {
    case "crs": return "Loading proving data. The first run can take longer.";
    case "runtime": return "Starting the prover…";
    case "load": return "Loading the proof circuits…";
    case "assemble":
    case "execute": return "Preparing the proof inputs…";
    case "artifacts": return "Finishing your proof…";
    default: return "Generating your proof on this device. Keep this page open.";
  }
}

/** A filling bar when `value` (0 to 1) is known; otherwise a moving one that only shows activity. */
export function ProgressIndicator({ label, detail, value }: { label: string; detail: string; value?: number | undefined }) {
  if (value === undefined) {
    return <div className={styles.bar} role="progressbar" aria-label={label} aria-valuetext={detail}><span /></div>;
  }
  const percent = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  return <div className={styles.bar} role="progressbar" aria-label={label} aria-valuetext={detail}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
    <span className={styles.filled} style={{ width: `${percent}%` }} />
  </div>;
}
