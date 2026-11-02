import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

const bb = vi.hoisted(() => ({
  srsInitSrs: vi.fn(async () => ({ pointsBuf: new Uint8Array() })),
  srsInitGrumpkinSrs: vi.fn(async () => ({ dummy: 0 })),
  initSRSChonk: vi.fn(async () => { throw new Error("bb.js SRS loader is forbidden"); }),
  chonkComputeVk: vi.fn(async () => { throw new Error("stop after SRS initialization"); }),
  destroy: vi.fn(async () => undefined),
}));

vi.mock("@aztec-foundation/bb.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("@aztec-foundation/bb.js")>(),
  Barretenberg: { new: vi.fn(async () => bb) },
}));

const proveTransferTransactionChonk = vi.hoisted(() => vi.fn(async () => ({ proof: Uint8Array.of(7), hidingVerificationKey: new Uint8Array() })));

vi.mock("@pcash/sdk/prover", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pcash/sdk/prover")>(),
  proveTransferTransactionChonk,
}));

vi.mock("@pcash/sdk/node", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pcash/sdk/node")>(),
  createReleaseChonkCircuitResolver: () => vi.fn(),
  nativeChonkBackend: () => ({ kind: "native" }),
}));

import { BackendType, Barretenberg } from "@aztec-foundation/bb.js";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { PROVER_ARTIFACT_SHA256 } from "@pcash/sdk/constants/prover-artifacts";
import type { NativeTransferBuild } from "@pcash/sdk/builders";
import { BN254_G2_CRS_KEY, bn254G1CrsKey, computeChonkVk, GRUMPKIN_G1_CRS_KEY } from "@pcash/sdk/prover";
import { toolPaths } from "@pcash/sdk/node/toolchain";
import { createWalletProvers, walletProverBackend } from "../../src/wallet/provers.ts";

const inheritedToolRoot = process.env.PCASH_TOOL_ROOT;
const installed = toolPaths();
const pinnedCrsInstalled = [installed.bn254G1, installed.bn254G2, installed.grumpkinG1].every((file) => existsSync(file));
const directories: string[] = [];

afterEach(() => {
  if (inheritedToolRoot === undefined) delete process.env.PCASH_TOOL_ROOT;
  else process.env.PCASH_TOOL_ROOT = inheritedToolRoot;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** A temporary tool root; a numeric entry is a zero-filled (sparse) file of that length. */
function useToolRoot(files: Record<string, Uint8Array | number>): string {
  const root = mkdtempSync(join(tmpdir(), "pcash-wallet-crs-"));
  directories.push(root);
  mkdirSync(join(root, "crs"));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, "crs", name);
    writeFileSync(path, typeof contents === "number" ? new Uint8Array() : contents);
    if (typeof contents === "number") truncateSync(path, contents);
  }
  process.env.PCASH_TOOL_ROOT = root;
  return root;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("wallet Wasm proving CRS", () => {
  it("names the toolchain bootstrap when a pinned CRS file is missing", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const root = useToolRoot({});
    expect(() => walletProverBackend("wasm")).toThrow(
      `pinned CRS file is missing at ${join(root, "crs", "bn254_g1.dat")}; run \`just tools\``,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a BN254 G1 file shorter than the Wasm SRS profile", () => {
    useToolRoot({ "bn254_g1.dat": 64 });
    expect(() => walletProverBackend("wasm")).toThrow(/bn254_g1\.dat is shorter than \d+ bytes; run `just tools`/);
  });

  it("rejects CRS bytes that do not match their release pin", () => {
    useToolRoot({
      "bn254_g1.dat": 2 ** 22 * 64,
      "bn254_g2.dat": 128,
      "grumpkin_g1_v2.flat.dat": 2 ** 16 * 64,
    });
    expect(() => walletProverBackend("wasm")).toThrow(
      /bn254_g1\.dat does not match its release pin \/crs\/\d+\/bn254_g1\.dat; run `just tools`/,
    );
  });

  it.runIf(pinnedCrsInstalled)(
    "loads exactly the pinned tool-root CRS into Barretenberg, never bb.js's loader or the network",
    async () => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      process.env.PCASH_TOOL_ROOT = installed.root;
      const backend = walletProverBackend("wasm");
      expect(backend.kind).toBe("wasm-worker");

      const bytecode = gzipSync(Uint8Array.of(1)).toString("base64");
      await expect(computeChonkVk("probe", { bytecode }, "app", backend)).rejects.toThrow("stop after SRS initialization");

      expect(Barretenberg.new).toHaveBeenCalledWith({ threads: 1, backend: BackendType.WasmWorker, skipSrsInit: true });
      expect(bb.initSRSChonk).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();

      expect(bb.srsInitSrs).toHaveBeenCalledOnce();
      const [{ pointsBuf, numPoints, g2Point }] = bb.srsInitSrs.mock.calls[0] as unknown as
        [{ pointsBuf: Uint8Array; numPoints: number; g2Point: Uint8Array }];
      expect(pointsBuf).toHaveLength(numPoints * 64);
      expect(sha256(pointsBuf)).toBe(PROVER_ARTIFACT_SHA256[bn254G1CrsKey(numPoints)]);
      expect(sha256(g2Point)).toBe(PROVER_ARTIFACT_SHA256[BN254_G2_CRS_KEY]);

      expect(bb.srsInitGrumpkinSrs).toHaveBeenCalledOnce();
      const [grumpkin] = bb.srsInitGrumpkinSrs.mock.calls[0] as unknown as [{ pointsBuf: Uint8Array; numPoints: number }];
      expect(grumpkin.numPoints).toBe(2 ** 16);
      expect(sha256(grumpkin.pointsBuf)).toBe(PROVER_ARTIFACT_SHA256[GRUMPKIN_G1_CRS_KEY]);
    },
  );
});

describe("wallet native proving", () => {
  it("passes a private payment's abort signal to the prover", async () => {
    const signal = new AbortController().signal;
    const build = {
      shape: PRIVATE_VALUE_PROFILES.S.shapeId,
      authorizationCircuit: "account_rule_payment_ecdsa",
      accountRuleWitnessMap: {},
      encodeTransaction: (proof: Uint8Array) => proof,
    } as unknown as NativeTransferBuild;
    await expect(createWalletProvers("native").privateValue.proveAndEncode(build, signal)).resolves.toEqual(Uint8Array.of(7));
    expect(proveTransferTransactionChonk).toHaveBeenCalledWith(expect.objectContaining({ signal }));
  });
});
