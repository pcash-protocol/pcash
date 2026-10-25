// Pinned-digest enforcement for every artifact the browser prover fetches.
// Shared by the main-thread client (CHONK VK loads) and the worker (circuits,
// VKs, CRS), so both sides verify the same release pins.

import { sha256 } from "@noble/hashes/sha2.js";

import { toHex } from "../utils/hex.ts";
import { CIRCUIT_PROVING_RUNTIMES } from "../constants/circuitRuntimes.ts";
import { BROWSER_PROVER_ASSET_SET_ID } from "../constants/proverArtifacts.ts";

export interface AdvertisedBrowserProverAssets {
  assetSetId: string;
  baseUrl: string;
}

/** One immutable, connection-scoped source for the release-pinned public files. */
export interface BrowserProverAssetSource {
  readonly assetSetId: string;
  readonly baseUrl: string;
}

function browserLocation(): string | undefined {
  return typeof window === "undefined" ? undefined : window.location.href;
}

function publicAssetUrl(value: string, base: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value, base);
  } catch {
    throw new Error(`Browser proving is unavailable: the node advertised an invalid ${label}.`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(`Browser proving is unavailable: the node advertised a credential-bearing ${label}.`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(`Browser proving is unavailable: the node advertised a query- or fragment-bearing ${label}.`);
  }
  const localhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localhost)) {
    throw new Error(`Browser proving is unavailable: the node advertised a non-HTTPS ${label}.`);
  }
  return parsed;
}

/** Resolve and authenticate one node-advertised asset location on the main thread. */
export function resolveBrowserProverAssetSource(
  rpcUrl: string,
  advertised: AdvertisedBrowserProverAssets | null | undefined,
  pageUrl = browserLocation(),
): BrowserProverAssetSource {
  if (advertised === null || advertised === undefined) {
    throw new Error("Browser proving is unavailable: the configured node does not advertise browser prover assets.");
  }
  if (advertised.assetSetId !== BROWSER_PROVER_ASSET_SET_ID) {
    throw new Error(
      `Website/node prover asset version mismatch: this website expects ${BROWSER_PROVER_ASSET_SET_ID}, but the node advertises ${advertised.assetSetId}.`,
    );
  }
  if (pageUrl === undefined && !URL.canParse(rpcUrl)) {
    throw new Error("Browser proving is unavailable: a relative node RPC URL cannot be resolved outside a browser.");
  }
  const effectiveRpc = publicAssetUrl(rpcUrl, pageUrl ?? rpcUrl, "RPC URL");
  const base = publicAssetUrl(advertised.baseUrl, effectiveRpc.href, "prover asset URL");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return Object.freeze({ assetSetId: advertised.assetSetId, baseUrl: base.href });
}

/** Map a release-pinned logical key to one connection's versioned download base. */
export function resolveBrowserProverAssetUrl(
  source: BrowserProverAssetSource,
  logicalKey: string,
): string {
  if (!logicalKey.startsWith("/") || logicalKey.startsWith("//") || logicalKey.includes("\\")) {
    throw new Error(`invalid browser prover asset key ${logicalKey}`);
  }
  const resolved = new URL(logicalKey.slice(1), source.baseUrl);
  const base = new URL(source.baseUrl);
  if (!resolved.href.startsWith(base.href)) throw new Error(`browser prover asset key escapes its source: ${logicalKey}`);
  return resolved.href;
}

/**
 * `/prover/app/functions/claim.json` -> `app/functions/claim`.
 *
 * The path is kept, not just the basename: the release pins keys under the same
 * relative path, and a nested circuit whose id collapsed to `claim` would look
 * for a key that does not exist and silently fall back to deriving one.
 */
export function proverCircuitId(circuitUrl: string): string {
  return circuitUrl.replace(/^\/prover\//, "").replace(/\.json$/, "");
}

/**
 * Runtime support is a product boundary, separate from artifact authenticity.
 * `allowNativeOnly` is a prover profile's explicit opt-in for measurement.
 */
export function assertBrowserCircuit(circuitUrl: string, allowNativeOnly = false): void {
  if (allowNativeOnly) return;
  const path = new URL(circuitUrl, "https://pcash.invalid").pathname;
  const id = path.replace(/^\/(prover|chonk-vks)\//, "").replace(/\.(json|vk)$/, "");
  const runtimes = CIRCUIT_PROVING_RUNTIMES[id];
  if (runtimes !== undefined && !runtimes.includes("browser")) {
    throw new Error(`Circuit ${id} requires native proving; browser proving is not supported.`);
  }
}

/**
 * Fail unless `bytes` are the exact artifact pinned for `url`. A URL without a
 * pin is not a soft failure: nothing in this release may execute it.
 */
export function requireArtifactDigest(
  logicalKey: string,
  bytes: Uint8Array,
  digests: Readonly<Record<string, string>>,
): void {
  const pinned = digests[logicalKey];
  if (pinned === undefined) {
    throw new Error(`prover artifact ${logicalKey} is not pinned by this release`);
  }
  if (toHex(sha256(bytes)) !== `0x${pinned}`) {
    throw new Error(`prover artifact ${logicalKey} failed its pinned digest`);
  }
}

/** Bounds far above any pinned circuit or CHONK VK, so an oversized reply fails before it is buffered. */
const MAX_CIRCUIT_BYTES = 16 * 1024 * 1024;
const MAX_VK_BYTES = 64 * 1024;

/**
 * Read a response body of at most `maxBytes`: a larger stated length fails
 * before reading, and a longer stream fails as soon as it passes the bound.
 */
export async function readCappedBody(response: Response, maxBytes: number, label: string): Promise<Uint8Array> {
  const statedLength = response.headers.get("content-length");
  if (statedLength !== null && Number(statedLength) > maxBytes) {
    await response.body?.cancel();
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  if (response.body === null) throw new Error(`${label} has no response body`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Fetch one artifact and verify its exact bytes before returning them. */
export async function fetchPinnedArtifact(
  logicalKey: string,
  digests: Readonly<Record<string, string>>,
  source: BrowserProverAssetSource,
  allowNativeOnly = false,
): Promise<Uint8Array> {
  assertBrowserCircuit(logicalKey, allowNativeOnly);
  const downloadUrl = resolveBrowserProverAssetUrl(source, logicalKey);
  let response: Response;
  try {
    response = await fetch(downloadUrl, { credentials: "omit" });
  } catch (cause) {
    throw new Error(`failed to load prover artifact ${logicalKey} from the configured node`, { cause });
  }
  if (!response.ok) {
    throw new Error(`configured node is missing prover artifact ${logicalKey}: HTTP ${response.status}`);
  }
  const maxBytes = logicalKey.startsWith("/chonk-vks/") ? MAX_VK_BYTES : MAX_CIRCUIT_BYTES;
  const bytes = await readCappedBody(response, maxBytes, `prover artifact ${logicalKey}`);
  requireArtifactDigest(logicalKey, bytes, digests);
  return bytes;
}
