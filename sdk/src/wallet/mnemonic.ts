import { validateMnemonic } from "@scure/bip39";
import { english, generateMnemonic } from "viem/accounts";

/** English BIP-39 phrases are accepted with copied whitespace and letter case. */
export function normalizeWalletMnemonic(mnemonic: string): string {
  return mnemonic.normalize("NFKD").trim().toLowerCase().replace(/\s+/gu, " ");
}

/** A seed wallet requires the 256 bits of entropy encoded by a 24-word phrase. */
export function validateWalletMnemonic(mnemonic: string): boolean {
  const normalized = normalizeWalletMnemonic(mnemonic);
  return normalized.split(" ").length === 24 && validateMnemonic(normalized, english);
}

export function generateWalletMnemonic(): string {
  return generateMnemonic(english, 256);
}
