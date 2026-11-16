import { describe, expect, it } from "vitest";
import type { StatusResult } from "@pcash/sdk/clients";
import {
  DEVELOPMENT_EXPLORER_RPC_URL,
  DEVELOPMENT_PSCAN_URL,
  explorerIdentityMismatch,
  FIXTURE_EXPLORER_CONFIG,
  resolveExplorerConfig,
} from "./config.ts";
import { FIXTURE_CHAIN_ID } from "./fixtures/constants.ts";

const identity = (pcashChainId: number): StatusResult => ({ pcashChainId } as StatusResult);

describe("Explorer configuration", () => {
  it("supplies unpinned local endpoints only during development", () => {
    expect(resolveExplorerConfig({ VITE_PCASH_CHAIN_ID: "0x50435348" }, false)).toEqual({
      status: "valid",
      config: {
        rpcUrl: DEVELOPMENT_EXPLORER_RPC_URL,
        rpcDisplayUrl: DEVELOPMENT_EXPLORER_RPC_URL,
        pscanUrl: DEVELOPMENT_PSCAN_URL,
        pscanDisplayUrl: DEVELOPMENT_PSCAN_URL,
        pcashChainId: 0x50435348,
      },
    });
    expect(resolveExplorerConfig({}, true)).toEqual({
      status: "invalid",
      message: "Explorer production builds require PCASH_RPC_URL.",
    });
  });

  it("requires a chain id in development and production alike", () => {
    expect(resolveExplorerConfig({}, false)).toEqual({
      status: "invalid",
      message: "Explorer requires PCASH_CHAIN_ID.",
    });
    expect(resolveExplorerConfig({ VITE_PCASH_RPC_URL: "https://rpc.example/pcash" }, true)).toEqual({
      status: "invalid",
      message: "Explorer requires PCASH_CHAIN_ID.",
    });
  });

  it("parses and sanitizes an explicitly pinned production endpoint", () => {
    expect(resolveExplorerConfig({
      VITE_PCASH_RPC_URL: "https://rpc.example/pcash?key=secret",
      VITE_PCASH_CHAIN_ID: "0x50435348",
    }, true)).toEqual({
      status: "valid",
      config: {
        rpcUrl: "https://rpc.example/pcash?key=secret",
        rpcDisplayUrl: "https://rpc.example",
        pcashChainId: 0x50435348,
      },
    });
    expect(resolveExplorerConfig({
      VITE_PCASH_RPC_URL: "https://rpc.example/pcash",
      VITE_PCASH_CHAIN_ID: "0x50435348",
      VITE_PCASH_PSCAN_URL: "https://scan.example/pscan?token=s3cret",
    }, true)).toEqual({
      status: "valid",
      config: {
        rpcUrl: "https://rpc.example/pcash",
        rpcDisplayUrl: "https://rpc.example",
        pcashChainId: 0x50435348,
        pscanUrl: "https://scan.example/pscan?token=s3cret",
        pscanDisplayUrl: "https://scan.example",
      },
    });
    const sameOrigin = resolveExplorerConfig({
      VITE_PCASH_RPC_URL: "/rpc/private-key",
      VITE_PCASH_CHAIN_ID: "0x50435348",
    }, true);
    expect(sameOrigin.status === "valid" ? sameOrigin.config.rpcDisplayUrl : undefined).toBe("Same-origin RPC");
  });

  it("selects fixture mode before any endpoint or chain requirement applies", () => {
    expect(resolveExplorerConfig({ VITE_PCASH_MODE: "fixtures" }, true)).toEqual({
      status: "fixtures",
      config: FIXTURE_EXPLORER_CONFIG,
    });
    expect(resolveExplorerConfig({ VITE_PCASH_MODE: " fixtures " }, false).status).toBe("fixtures");
    expect(resolveExplorerConfig({ VITE_PCASH_MODE: "live", VITE_PCASH_CHAIN_ID: "1" }, false).status).toBe("valid");
    expect(FIXTURE_EXPLORER_CONFIG.pcashChainId).toBe(FIXTURE_CHAIN_ID);
  });

  it("rejects malformed identity and endpoint values", () => {
    expect(resolveExplorerConfig({
      VITE_PCASH_RPC_URL: "file:///tmp/rpc",
      VITE_PCASH_CHAIN_ID: "1",
    }, true).status).toBe("invalid");
    expect(resolveExplorerConfig({
      VITE_PCASH_RPC_URL: "/rpc",
      VITE_PCASH_CHAIN_ID: "4294967296",
    }, true).status).toBe("invalid");
    expect(resolveExplorerConfig({
      VITE_PCASH_RPC_URL: "/rpc",
      VITE_PCASH_CHAIN_ID: "not-an-integer",
    }, true).status).toBe("invalid");
    expect(resolveExplorerConfig({
      VITE_PCASH_RPC_URL: "/rpc",
      VITE_PCASH_CHAIN_ID: "1",
      VITE_PCASH_PSCAN_URL: "file:///tmp/scan",
    }, true).status).toBe("invalid");
    expect(resolveExplorerConfig({
      VITE_PCASH_RPC_URL: "/rpc",
      VITE_PCASH_CHAIN_ID: "1",
      VITE_PCASH_PSCAN_URL: "https://user:pass@scan.example",
    }, true).status).toBe("invalid");
  });

  it("treats an unconfigured production source service as unavailable, not an error", () => {
    const result = resolveExplorerConfig({
      VITE_PCASH_RPC_URL: "https://rpc.example/pcash",
      VITE_PCASH_CHAIN_ID: "0x50435348",
    }, true);
    expect(result.status).toBe("valid");
    if (result.status !== "valid") throw new Error(result.status === "invalid" ? result.message : "unexpected fixture configuration");
    expect("pscanUrl" in result.config).toBe(false);
    expect("pscanDisplayUrl" in result.config).toBe(false);
  });

  it("accepts a same-origin source endpoint path", () => {
    const result = resolveExplorerConfig({
      VITE_PCASH_RPC_URL: "/rpc",
      VITE_PCASH_CHAIN_ID: "0x50435348",
      VITE_PCASH_PSCAN_URL: "/pscan",
    }, true);
    if (result.status !== "valid") throw new Error(result.status === "invalid" ? result.message : "unexpected fixture configuration");
    expect(result.config.pscanUrl).toBe("/pscan");
    expect(result.config.pscanDisplayUrl).toBe("Same-origin RPC");
  });
});

describe("Explorer network identity", () => {
  const result = resolveExplorerConfig({
    VITE_PCASH_RPC_URL: "/rpc",
    VITE_PCASH_CHAIN_ID: "1346589512",
  }, true);
  if (result.status !== "valid") throw new Error(result.status === "invalid" ? result.message : "unexpected fixture configuration");

  it("accepts only the exact chain id", () => {
    expect(explorerIdentityMismatch(result.config, identity(1346589512))).toBeUndefined();
    expect(explorerIdentityMismatch(result.config, identity(1))).toMatch(/Expected PCASH chain/);
  });
});
