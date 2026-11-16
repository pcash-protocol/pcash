import { PCASH_UNIT, type FormatPcashOptions } from "./pcashAmount.ts";
import { TokenAmount } from "./TokenAmount.tsx";

export function PcashAmount(props: FormatPcashOptions & { value: bigint; className?: string | undefined }) {
  return <TokenAmount {...props} unit={PCASH_UNIT} />;
}
