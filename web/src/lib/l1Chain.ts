import { foundry } from "viem/chains";

export const DEFAULT_L1_CHAIN_ID = foundry.id;

export function parseL1ChainId(
  value: string | undefined,
  variableName = "VITE_L1_CHAIN_ID",
): number {
  if (value === undefined || value === "") return DEFAULT_L1_CHAIN_ID;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${variableName} must be a positive decimal integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${variableName} must be a safe integer`);
  return parsed;
}
