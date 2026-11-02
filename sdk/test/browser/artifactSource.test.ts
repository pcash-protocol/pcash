import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  fetchPinnedArtifact,
  resolveBrowserProverAssetSource,
  resolveBrowserProverAssetUrl,
} from "../../src/browser-prover/artifacts.ts";
import { BROWSER_PROVER_ASSET_SET_ID } from "../../src/constants/proverArtifacts.ts";
import { toHex } from "../../src/utils/hex.ts";

const advertised = (baseUrl = `/proving/${BROWSER_PROVER_ASSET_SET_ID}/`) => ({
  assetSetId: BROWSER_PROVER_ASSET_SET_ID,
  baseUrl,
});

test("relative discovery is resolved against the effective node RPC origin", () => {
  const source = resolveBrowserProverAssetSource(
    "/rpc",
    advertised(),
    "https://website.example/account",
  );
  assert.equal(source.baseUrl, `https://website.example/proving/${BROWSER_PROVER_ASSET_SET_ID}/`);
  assert.equal(
    resolveBrowserProverAssetUrl(source, "/prover/contracts/escrow/claim.json"),
    `https://website.example/proving/${BROWSER_PROVER_ASSET_SET_ID}/prover/contracts/escrow/claim.json`,
  );
});

test("absolute node discovery keeps the node origin rather than the website origin", () => {
  const source = resolveBrowserProverAssetSource(
    "https://api.example/rpc",
    advertised(),
    "https://website.example/account",
  );
  assert.equal(source.baseUrl, `https://api.example/proving/${BROWSER_PROVER_ASSET_SET_ID}/`);
});

test("missing, mismatched, credential-bearing, and insecure discovery fails closed", () => {
  assert.throws(
    () => resolveBrowserProverAssetSource("https://api.example/rpc", null),
    /does not advertise browser prover assets/,
  );
  assert.throws(
    () => resolveBrowserProverAssetSource("https://api.example/rpc", { ...advertised(), assetSetId: "0".repeat(64) }),
    /Website\/node prover asset version mismatch/,
  );
  assert.throws(
    () => resolveBrowserProverAssetSource("https://api.example/rpc", advertised("https://user:secret@assets.example/proving/")),
    /credential-bearing/,
  );
  assert.throws(
    () => resolveBrowserProverAssetSource("https://api.example/rpc?api_key=secret", advertised()),
    /query- or fragment-bearing/,
  );
  assert.throws(
    () => resolveBrowserProverAssetSource("https://api.example/rpc", advertised("https://assets.example/proving/#release")),
    /query- or fragment-bearing/,
  );
  assert.throws(
    () => resolveBrowserProverAssetSource("https://api.example/rpc", advertised("http://assets.example/proving/")),
    /non-HTTPS/,
  );
  assert.doesNotThrow(() => resolveBrowserProverAssetSource(
    "http://127.0.0.1:8645",
    advertised("/proving/"),
  ));
});

test("downloads use the discovered URL without credentials and retain logical-key pins", async () => {
  const bytes = Uint8Array.of(1, 2, 3);
  const logicalKey = "/prover/example.json";
  const fetch = vi.fn(async () => new Response(bytes));
  vi.stubGlobal("fetch", fetch);
  try {
    const source = resolveBrowserProverAssetSource("https://api.example/rpc", advertised());
    await fetchPinnedArtifact(logicalKey, { [logicalKey]: toHex(sha256(bytes)).slice(2) }, source);
    assert.deepEqual(fetch.mock.calls[0], [
      `https://api.example/proving/${BROWSER_PROVER_ASSET_SET_ID}/prover/example.json`,
      { credentials: "omit" },
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});

// A body of `chunks` 64 KiB chunks that records whether its reader cancelled it.
function chunkedBody(chunks: number) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (state.pulled === chunks) controller.close();
      else controller.enqueue(new Uint8Array(64 * 1024));
      state.pulled += 1;
    },
    cancel: () => { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, state };
}

test("artifact downloads stop at a size bound instead of buffering an oversized reply", async () => {
  const source = resolveBrowserProverAssetSource("https://api.example/rpc", advertised());
  for (const [logicalKey, maxBytes] of [["/chonk-vks/example.vk", 64 * 1024], ["/prover/example.json", 16 * 1024 * 1024]] as const) {
    const body = chunkedBody(maxBytes / (64 * 1024) + 4);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body.stream)));
    try {
      await assert.rejects(fetchPinnedArtifact(logicalKey, {}, source), new RegExp(`exceeds ${maxBytes} bytes`));
      assert.equal(body.state.cancelled, true);
    } finally {
      vi.unstubAllGlobals();
    }
  }
});

test("artifact downloads reject an oversized stated length before reading", async () => {
  const body = chunkedBody(1);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body.stream, { headers: { "content-length": String(2 ** 40) } })));
  try {
    const source = resolveBrowserProverAssetSource("https://api.example/rpc", advertised());
    await assert.rejects(fetchPinnedArtifact("/prover/example.json", {}, source), /exceeds 16777216 bytes/);
    assert.equal(body.state.pulled, 0);
  } finally {
    vi.unstubAllGlobals();
  }
});
