import { toField } from "@pcash/sdk/crypto";
import {
  assetDefinitionAssetId,
  formatAssetDefinition,
  parseAssetDefinition,
  type AssetDefinition,
} from "@pcash/sdk/protocol";
import { bytes32Hex, fromHex, toHex } from "@pcash/sdk/utils";
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
 * is only trustworthy as far as it derives the token ID being looked at.
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
  return { state: "verified", definition, assetId };
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
