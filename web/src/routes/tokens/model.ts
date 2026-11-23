import { toField } from "@pcash/sdk/crypto";
import {
  assetDefinitionAssetId,
  formatAssetDefinition,
  parseAssetDefinition,
  type AssetDefinition,
} from "@pcash/sdk/protocol";
import { recognizeMintRule, recognizeTransferRule } from "@pcash/sdk/rules";
import { addressHex, bytes32Hex, fromHex, toHex } from "@pcash/sdk/utils";
import { unopenableRuleReason } from "@pcash/sdk/wallet";
import type { AmountUnit } from "../../components/tokenAmount.ts";

export const TOKENS_PATH = "/tokens";
export const NEW_TOKEN_PATH = "/tokens/new";
const TOKEN_PATH_PREFIX = "/token/";

/** A token nobody has shown this wallet a definition for: raw base units, no decimals. */
export const UNVERIFIED_UNIT: AmountUnit = { decimals: 0, symbol: "units" };

export function assetIdHex(assetId: bigint): string {
  return bytes32Hex(assetId);
}

export function shortAssetId(assetId: bigint): string {
  const hex = assetIdHex(assetId);
  return `${hex.slice(0, 8)}…${hex.slice(-6)}`;
}

/** The token ID in a `/token/<id>` path: 0x and 64 hex digits naming a nonzero field element. */
export function parseAssetIdSegment(segment: string): bigint | undefined {
  if (!/^0x[0-9a-fA-F]{64}$/.test(segment)) return undefined;
  try {
    const assetId = toField(BigInt(segment), "token ID");
    return assetId === 0n ? undefined : assetId;
  } catch {
    return undefined;
  }
}

export function tokenPath(assetId: bigint): string {
  return `${TOKEN_PATH_PREFIX}${assetIdHex(assetId)}`;
}

/** Anyone who opens this link can check the definition against the token ID in its path. */
export function tokenShareLink(origin: string, definition: AssetDefinition): string {
  return `${origin}${tokenPath(assetDefinitionAssetId(definition))}#d=${formatAssetDefinition(definition)}`;
}

/** The shared definition text a token link carries in its fragment, if any. */
export function definitionFromHash(hash: string): string | undefined {
  if (!hash.startsWith("#")) return undefined;
  return new URLSearchParams(hash.slice(1)).get("d") ?? undefined;
}

export type DefinitionCheck =
  | { state: "verified"; definition: AssetDefinition; assetId: bigint }
  | { state: "mismatch"; definition: AssetDefinition; assetId: bigint }
  | { state: "invalid"; message: string };

/**
 * Pasted text and link fragments come from whoever shared them. A definition
 * is only trustworthy as far as it derives the token ID being looked at, and
 * the ID does not fix a standard rule's configuration bytes, so a definition
 * whose standard rule configuration does not open its commitment is invalid.
 */
export function checkDefinition(text: string, expectedAssetId?: bigint): DefinitionCheck {
  const trimmed = text.trim();
  if (trimmed === "") return { state: "invalid", message: "Paste a token definition or a token link." };
  let definition: AssetDefinition;
  try {
    definition = parseAssetDefinition(trimmed);
  } catch {
    return {
      state: "invalid",
      message: trimmed.includes("#") || trimmed.includes("/token/")
        ? "This link does not carry a readable token definition."
        : "This is not a readable token definition.",
    };
  }
  const assetId = assetDefinitionAssetId(definition);
  if (expectedAssetId !== undefined && assetId !== expectedAssetId) return { state: "mismatch", definition, assetId };
  if (unopenableRuleReason(definition) !== undefined) {
    return { state: "invalid", message: "This definition's rule settings do not match its token ID." };
  }
  return { state: "verified", definition, assetId };
}

export interface TokenTerms {
  mint:
    | { kind: "fixed-supply"; supply: bigint }
    | { kind: "account-mint"; account: string }
    | { kind: "deposit-mint"; vault: string }
    | { kind: "custom" };
  transfers: { kind: "unrestricted" } | { kind: "sender-deny-list"; contract: string; listId: string; maxDelta: bigint } | { kind: "custom" };
}

/**
 * What the definition commits about minting and transfers, as a holder reads
 * it. An account-mint token's terms never claim backing or a cap: the
 * account's current rules can change.
 */
export function tokenTerms(definition: AssetDefinition): TokenTerms {
  const recognized = recognizeMintRule(definition.mintRule);
  const mint: TokenTerms["mint"] = recognized.kind === "fixed-supply"
    ? { kind: "fixed-supply", supply: recognized.configuration.supply }
    : recognized.kind === "account-mint"
      ? { kind: "account-mint", account: addressHex(recognized.configuration.accountAddress) }
      : recognized.kind === "deposit-mint"
        ? { kind: "deposit-mint", vault: addressHex(recognized.configuration.vault) }
        : { kind: "custom" };
  if (definition.transferRule === undefined) return { mint, transfers: { kind: "unrestricted" } };
  const rule = recognizeTransferRule(definition.transferRule);
  return {
    mint,
    transfers: rule.kind === "sender-deny-list"
      ? {
        kind: "sender-deny-list", contract: addressHex(toField(rule.configuration.contractAddress)),
        listId: toHex(rule.configuration.listId), maxDelta: rule.configuration.maxDelta,
      }
      : { kind: "custom" },
  };
}

/** A whole number of seconds in the largest unit that divides it: "2 hours", "90 minutes", "45 seconds". */
export function durationText(seconds: bigint): string {
  const [count, unit] = seconds % 86_400n === 0n ? [seconds / 86_400n, "day"]
    : seconds % 3_600n === 0n ? [seconds / 3_600n, "hour"]
    : seconds % 60n === 0n ? [seconds / 60n, "minute"]
    : [seconds, "second"];
  return `${count.toLocaleString("en-US")} ${unit}${count === 1n ? "" : "s"}`;
}

export function tokenUnit(definition: AssetDefinition): AmountUnit {
  return { decimals: definition.metadata.decimals, symbol: definition.metadata.symbol };
}

export const ZERO_CONTENT_DIGEST = new Uint8Array(32);

export function isZeroDigest(digest: Uint8Array): boolean {
  return digest.every((byte) => byte === 0);
}

export function contentDigestHex(digest: Uint8Array): string {
  return toHex(digest);
}

export function parseContentDigest(text: string): Uint8Array {
  const trimmed = text.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) throw new Error("A content digest is 0x followed by 64 hex digits.");
  return fromHex(trimmed);
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

export function sameDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export interface DistributionEntry {
  line: number;
  to: string;
  amountText: string;
}

/**
 * One recipient per line: `recipient, amount`. A tab or spaces may separate
 * them instead. Recipients never contain commas, so the amount keeps any
 * thousands separators.
 */
export function parseDistributionLines(text: string): { entries: DistributionEntry[]; errors: { line: number; message: string }[] } {
  const entries: DistributionEntry[] = [];
  const errors: { line: number; message: string }[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trim() === "") return;
    const match = /^\s*([^,\s]+)\s*[,\t ]\s*(\S.*?)\s*$/.exec(raw);
    if (match === null) {
      errors.push({ line: index + 1, message: "Write the recipient, a comma, then the amount." });
      return;
    }
    entries.push({ line: index + 1, to: match[1]!, amountText: match[2]! });
  });
  return { entries, errors };
}
