import { formatTokenAmount, formatTokenExact, type AmountUnit, type FormatAmountOptions } from "./tokenAmount.ts";
import styles from "./PcashAmount.module.css";

export function TokenAmount({
  value,
  unit,
  className,
  approximate = false,
  ...options
}: FormatAmountOptions & { value: bigint; unit: AmountUnit; className?: string | undefined; approximate?: boolean }) {
  const display = formatTokenAmount(value, unit, options);
  const exact = formatTokenExact(value, unit);
  return <span className={[styles.amount, className].filter(Boolean).join(" ")} title={approximate ? `Approximate: ${exact}` : display === exact ? undefined : `Exact: ${exact}`} aria-label={approximate ? `Approximately ${exact}` : exact}>{display}</span>;
}
