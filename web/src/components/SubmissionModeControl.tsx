import { useId } from "react";
import type { SubmissionMode } from "../lib/WebsiteSettings.tsx";
import { HelpTip } from "./Tooltip.tsx";
import styles from "./WalletSettings.module.css";

const MODES = ["fast", "slow"] as const;
const LABELS: Record<SubmissionMode, string> = { fast: "Faster", slow: "More private" };
const EXPLANATIONS: Record<SubmissionMode, string> = {
  fast: "Your Ethereum wallet posts it to Ethereum and pays the gas. Observers can see that your wallet posted a PCASH transaction, but not what it does.",
  slow: "It goes to the public PCASH mempool and any relayer posts it for the relayer fee, so it is harder to trace to you.",
};

export function SubmissionModeControl({ value, onChange, label = "Submission mode", disabled = false, fastDisabled = false, fastExplanation = EXPLANATIONS.fast }: {
  value: SubmissionMode; onChange(value: SubmissionMode): void; label?: string; disabled?: boolean; fastDisabled?: boolean;
  /** For a transaction whose content is public, posting it from the wallet reveals more than that a transaction was sent. */
  fastExplanation?: string;
}) {
  const id = useId();
  const tipId = (mode: SubmissionMode) => `${id}-${mode}`;
  const explanations = { ...EXPLANATIONS, fast: fastExplanation };
  return <div className={styles.mode}>
    <span className={styles.modeLabel}>
      <span id={id}>{label}</span>
      <HelpTip label={`About ${LABELS.fast} and ${LABELS.slow}`} tip={MODES.map((mode) =>
        <span key={mode} className={styles.modeTip}><strong>{LABELS[mode]}</strong> — <span id={tipId(mode)}>{explanations[mode]}
          {mode === "fast" && fastDisabled ? " Available once your Ethereum wallet is ready to post." : ""}</span></span>)} />
    </span>
    <div className={styles.segmented} role="radiogroup" aria-labelledby={id}>
      {MODES.map((mode) => <label key={mode} className={value === mode ? styles.selected : undefined}>
        <input type="radio" name={id} value={mode} checked={value === mode} disabled={disabled || (mode === "fast" && fastDisabled)}
          aria-describedby={tipId(mode)} onChange={() => onChange(mode)} />{LABELS[mode]}
      </label>)}
    </div>
  </div>;
}
