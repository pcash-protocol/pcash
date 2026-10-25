import { formatEthCost } from "../lib/gasGuard.tsx";
import { useFastSendEstimate, type FastSendEstimate } from "../lib/useFastSendEstimate.ts";
import type { SubmissionMode } from "../lib/WebsiteSettings.tsx";
import { PcashAmount } from "./PcashAmount.tsx";
import { SubmissionModeControl } from "./SubmissionModeControl.tsx";
import styles from "./WalletSettings.module.css";

/** What posting a Faster transaction to Ethereum costs, once it is estimated. */
export function EthereumGasCost({ estimate }: { estimate: FastSendEstimate | undefined }) {
  if (estimate === undefined) return <>you pay the Ethereum gas</>;
  if (estimate.state === "loading") return <>Ethereum gas: estimating…</>;
  if (estimate.state === "error") return <>Ethereum gas could not be estimated</>;
  return <>Ethereum gas about {formatEthCost(estimate.estimatedCostWei)}, up to {formatEthCost(estimate.maximumCostWei)}</>;
}

/**
 * The Faster or More private choice with what each costs: Faster's estimated
 * Ethereum gas, paid by the Ethereum wallet, or More private's PCASH fee.
 */
export function SubmissionChoice({ value, onChange, openFee, label, disabled = false, fastDisabled = false, fastExplanation }: {
  value: SubmissionMode;
  onChange(value: SubmissionMode): void;
  /** More private's PCASH fee; undefined until it is known. */
  openFee: bigint | undefined;
  label?: string;
  disabled?: boolean;
  fastDisabled?: boolean;
  fastExplanation?: string;
}) {
  const estimate = useFastSendEstimate(value === "fast" && !disabled);
  return <>
    <SubmissionModeControl value={value} onChange={onChange} disabled={disabled} fastDisabled={fastDisabled}
      {...(label === undefined ? {} : { label })} {...(fastExplanation === undefined ? {} : { fastExplanation })} />
    <p className={styles.modeFee}>Network fee: {value === "fast"
      ? <><EthereumGasCost estimate={estimate} />, paid by your Ethereum wallet</>
      : openFee === undefined ? "…" : <PcashAmount value={openFee} rounding="up" />}</p>
  </>;
}
