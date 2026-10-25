import { formatTokenAmount, type AmountRounding, type AmountUnit } from "./tokenAmount.ts";
import { TokenAmount } from "./TokenAmount.tsx";

export const ETH_UNIT: AmountUnit = { decimals: 18, symbol: "ETH" };

export function formatEtherAmount(value: bigint, rounding?: AmountRounding): string {
  return formatTokenAmount(value, ETH_UNIT, { rounding });
}

export function EtherAmount({ value, className, approximate = false }: { value: bigint; className?: string | undefined; approximate?: boolean }) {
  return <TokenAmount value={value} unit={ETH_UNIT} className={className} approximate={approximate} />;
}
