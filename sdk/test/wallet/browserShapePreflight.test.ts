import { describe, expect, it, vi } from "vitest";
import { createBrowserWalletProvers } from "../../src/wallet/web/provers.ts";
import type { NativeTransferBuild, AssetActionBuild } from "@pcash/sdk/builders";
const { loadProver } = vi.hoisted(() => ({ loadProver: vi.fn() }));
vi.mock("@pcash/sdk/browser-prover", () => ({
  createBrowserProver: loadProver,
  resolveBrowserProverAssetSource: vi.fn(),
}));

describe("native-only shape preflight", () => {
  it("rejects L before loading a browser prover or downloading artifacts", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const provers = createBrowserWalletProvers({
        node: { rpcUrl: "https://node.invalid/rpc" },
        proverAssets: null,
      });
      await expect(provers.privateValue.proveAndEncode({ shape: 1 } as NativeTransferBuild)).rejects.toThrow("native proving");
      await expect(provers.assetCreation.proveAndEncode({ shape: 1 } as AssetActionBuild, {})).rejects.toThrow("native proving");
      expect(loadProver).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
});
