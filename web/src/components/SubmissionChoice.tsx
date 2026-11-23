import type { SubmissionMode } from "../lib/WebsiteSettings.tsx";
import { PcashAmount } from "./PcashAmount.tsx";
import { SubmissionModeControl } from "./SubmissionModeControl.tsx";
import styles from "./WalletSettings.module.css";

/**
 * The Faster or More private choice with what each costs: Faster's Ethereum
 * gas, which the Ethereum wallet shows and pays, or More private's PCASH fee
 * to the relayer. Either way the action also burns any network fee.
 */
export function SubmissionChoice({ value, onChange, openFee, networkFee, label, disabled = false, fastDisabled = false, fastExplanation }: {
  value: SubmissionMode;
  onChange(value: SubmissionMode): void;
  /** More private's PCASH fee; undefined until it is known. */
  openFee: bigint | undefined;
  networkFee?: bigint | undefined;
  label?: string;
  disabled?: boolean;
  fastDisabled?: boolean;
  fastExplanation?: string;
}) {
  return <>
    <SubmissionModeControl value={value} onChange={onChange} disabled={disabled} fastDisabled={fastDisabled}
      {...(label === undefined ? {} : { label })} {...(fastExplanation === undefined ? {} : { fastExplanation })} />
    <p className={styles.modeFee}>Fee: {value === "fast"
      ? "Ethereum gas, paid by your Ethereum wallet"
      : openFee === undefined ? "…" : <><PcashAmount value={openFee} rounding="up" /> to the relayer</>}
      {networkFee !== undefined && networkFee > 0n && <> · network fee <PcashAmount value={networkFee} rounding="up" /></>}</p>
  </>;
}
