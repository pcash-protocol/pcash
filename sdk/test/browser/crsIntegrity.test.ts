// The browser worker must hand Barretenberg exactly the release-pinned CRS
// bytes and never let bb.js run its own SRS loader, which reads bb.js's
// IndexedDB cache and downloads missing points from Aztec's CDN.

import { IDBFactory } from "fake-indexeddb";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";

import type { WorkerRequest, WorkerResponse } from "../../src/browser-prover/proverWorker.ts";
import { BROWSER_CRS_DATABASE, GRUMPKIN_POINTS } from "../../src/browser-prover/crsCache.ts";
import { toHex } from "../../src/utils/hex.ts";

const bb = vi.hoisted(() => ({
  srsInitSrs: vi.fn(async () => ({ pointsBuf: new Uint8Array() })),
  srsInitGrumpkinSrs: vi.fn(async () => ({})),
  initSRSChonk: vi.fn(async () => {
    throw new Error("bb.js SRS loader is forbidden");
  }),
  destroy: vi.fn(async () => undefined),
}));

vi.mock("@aztec-foundation/bb.js", () => ({
  BackendType: { Wasm: "wasm", WasmWorker: "wasm-worker", NativeUnixSocket: "native" },
  Barretenberg: { new: vi.fn(async () => bb) },
  CircuitKind: { App: 0, Kernel: 1, HidingKernel: 2 },
  flattenChonkProofFields: vi.fn(),
}));
vi.mock("@noir-lang/noir_js", () => ({ Noir: class {} }));
vi.mock("@noir-lang/acvm_js", () => ({ default: vi.fn(async () => undefined) }));
vi.mock("@noir-lang/noirc_abi", () => ({ default: vi.fn(async () => undefined) }));

import { Barretenberg } from "@aztec-foundation/bb.js";

const ASSET_BASE = "https://assets.example/proving/test-assets/";
const SRS_POINTS = 2 ** 18;
const G1_KEY = `/crs/${SRS_POINTS}/bn254_g1.dat`;
const G2_KEY = "/crs/bn254_g2.dat";
const GRUMPKIN_KEY = "/crs/grumpkin_g1_v2.flat.dat";
const PINNED = new Map<string, Uint8Array<ArrayBuffer>>([
  [G1_KEY, new Uint8Array(SRS_POINTS * 64).fill(1)],
  [G2_KEY, new Uint8Array(128).fill(2)],
  [GRUMPKIN_KEY, new Uint8Array(GRUMPKIN_POINTS * 64).fill(3)],
]);
const digest = (bytes: Uint8Array): string => toHex(sha256(bytes)).slice(2);
const DIGESTS = Object.fromEntries([...PINNED].map(([key, bytes]) => [key, digest(bytes)]));
const SETUP: WorkerRequest = {
  kind: "setup",
  profile: { srsPoints: SRS_POINTS, threads: 1, reuse: false },
  artifactDigests: DIGESTS,
  assetSource: { assetSetId: "test-assets", baseUrl: ASSET_BASE },
};

/** Each recorded SRS init command, with byte fields replaced by their SHA-256. */
function initCalls(init: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return init.mock.calls.map(([command]) => Object.fromEntries(
    Object.entries(command as Record<string, unknown>).map(([field, value]) =>
      [field, value instanceof Uint8Array ? digest(value) : value]),
  ));
}

let served = new Map(PINNED);
let crsRequests: string[] = [];
const worker = {
  crossOriginIsolated: true,
  onmessage: null as ((event: { data: WorkerRequest }) => void) | null,
  postMessage: (_message: WorkerResponse): void => undefined,
};

/** Send one request to the worker and return its final response. */
function run(request: WorkerRequest): Promise<WorkerResponse> {
  return new Promise((resolve) => {
    worker.postMessage = (message) => {
      if (message.type !== "status") resolve(message);
    };
    worker.onmessage!({ data: request });
  });
}

beforeAll(async () => {
  vi.stubGlobal("self", worker);
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    // The Noir runtime's Wasm loaders are mocked and ignore these bytes.
    if (!url.startsWith(ASSET_BASE)) return new Response(new Uint8Array());
    crsRequests.push(url);
    const bytes = served.get(`/${url.slice(ASSET_BASE.length)}`);
    return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes);
  });
  await import("../../src/browser-prover/proverWorker.ts");
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("indexedDB", new IDBFactory());
  served = new Map(PINNED);
  crsRequests = [];
});

test("the worker passes exactly the pinned CRS bytes to Barretenberg's SRS init calls", async () => {
  for (const expectedDownloads of [[G1_KEY, G2_KEY, GRUMPKIN_KEY], []]) {
    vi.clearAllMocks();
    crsRequests = [];

    expect(await run(SETUP)).toEqual({ type: "setup-result" });

    expect(crsRequests).toEqual(expectedDownloads.map((key) => `${ASSET_BASE}${key.slice(1)}`));
    expect(Barretenberg.new).toHaveBeenCalledOnce();
    expect(Barretenberg.new).toHaveBeenCalledWith({ threads: 1, backend: "wasm", skipSrsInit: true });
    expect(bb.initSRSChonk).not.toHaveBeenCalled();
    expect(initCalls(bb.srsInitSrs)).toEqual([
      { pointsBuf: DIGESTS[G1_KEY], numPoints: SRS_POINTS, g2Point: DIGESTS[G2_KEY] },
    ]);
    expect(initCalls(bb.srsInitGrumpkinSrs)).toEqual([
      { pointsBuf: DIGESTS[GRUMPKIN_KEY], numPoints: GRUMPKIN_POINTS },
    ]);
    // Nothing is seeded into bb.js's own CRS cache.
    expect((await indexedDB.databases()).map(({ name }) => name)).toEqual([BROWSER_CRS_DATABASE]);
  }
});

test.each([
  {
    name: "missing",
    serve: () => served.delete(G1_KEY),
    error: `the configured node does not host the pinned browser proving parameter ${G1_KEY}`,
  },
  {
    name: "mismatched",
    serve: () => served.set(GRUMPKIN_KEY, new Uint8Array(GRUMPKIN_POINTS * 64).fill(4)),
    error: `prover artifact ${GRUMPKIN_KEY} failed its pinned digest`,
  },
])("a $name CRS file stops proving before Barretenberg starts", async ({ serve, error }) => {
  serve();

  const response = await run(SETUP);

  expect(response.type).toBe("error");
  expect(response.type === "error" && response.error).toContain(error);
  expect(Barretenberg.new).not.toHaveBeenCalled();
  expect(bb.srsInitSrs).not.toHaveBeenCalled();
  expect(bb.srsInitGrumpkinSrs).not.toHaveBeenCalled();
});
