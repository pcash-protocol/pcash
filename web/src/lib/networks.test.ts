import { describe, expect, it } from "vitest";
import { configuredNetwork, networkInstanceKey } from "./networks.ts";
import { withRpcEndpoints } from "./NetworkProvider.tsx";
import { explorerIdentityMismatch, networkChangedMessage, resolveNetworkExplorerConfig } from "../routes/explorer/config.ts";
import type { StatusResult } from "@pcash/sdk/clients";

const GENESIS = `0x${"12".repeat(32)}`;
const local = {
  VITE_PCASH_CHAIN_ID: "23100",
  VITE_L1_CHAIN_ID: "1234567890", VITE_PCASH_GENESIS_HASH: GENESIS,
  VITE_PCASH_RPC_URL: "http://localhost:8645", VITE_L1_RPC_URLS: "http://localhost:8545",
};

describe("PCASH deployment profile", () => {
  it("serves exactly the network in the build configuration", () => {
    const network = configuredNetwork({ ...local, VITE_PCASH_PSCAN_URL: "https://pcash.example/pscan" });
    expect(network).toEqual({
      name: "Chain 1234567890", pcashChainId: 23100, genesisHash: GENESIS,
      pcashRpcUrl: "http://localhost:8645", l1ChainId: 1234567890, l1RpcUrls: ["http://localhost:8545"],
      pscanUrl: "https://pcash.example/pscan",
    });
    expect(resolveNetworkExplorerConfig(network)).toMatchObject({
      status: "valid", config: { rpcUrl: network.pcashRpcUrl, pscanUrl: network.pscanUrl, pcashChainId: 23100, l1ChainId: 1234567890 },
    });
  });

  it("names the network after its Ethereum chain", () => {
    for (const [l1ChainId, name] of [[1, "Ethereum"], [560048, "Hoodi"], [11155111, "Sepolia"], [31337, "Anvil"]] as const) {
      expect(configuredNetwork({ ...local, VITE_L1_CHAIN_ID: String(l1ChainId) }).name).toBe(name);
    }
  });

  it("keeps an unconfigured Pscan absent", () => {
    const config = resolveNetworkExplorerConfig(configuredNetwork(local));
    expect(config.status).toBe("valid");
    if (config.status === "valid") expect(config.config.pscanUrl).toBeUndefined();
  });

  it("rejects malformed operator configuration", () => {
    for (const change of [{ VITE_PCASH_CHAIN_ID: String(2 ** 32) }, { VITE_L1_RPC_URLS: "https://user:secret@rpc.example" }, { VITE_L1_RPC_URLS: "/rpc" },
      { VITE_L1_RPC_URLS: "https://rpc.example,/rpc" }, { VITE_L1_RPC_URLS: " , " }, { VITE_PCASH_GENESIS_HASH: "0x12" }]) {
      expect(() => configuredNetwork({ ...local, ...change })).toThrow();
    }
  });

  it("reads Ethereum RPC endpoints in their configured order", () => {
    const network = configuredNetwork({ ...local, VITE_L1_RPC_URLS: "https://first.example/rpc, https://second.example," });
    expect(network.l1RpcUrls).toEqual(["https://first.example/rpc", "https://second.example"]);
  });

  it("uses a browser's RPC endpoints without changing the chain instance", () => {
    const network = configuredNetwork({ ...local, VITE_L1_RPC_URLS: "https://first.example,https://second.example" });
    const custom = withRpcEndpoints(network, { pcashRpcUrl: "https://mine.example/pcash", l1Rpcs: {
      added: [{ url: "https://mine.example/eth", enabled: true }, { url: "https://spare.example/eth", enabled: false }], paused: ["https://first.example"], removed: [],
    } });
    // Only what is on: the deployment's endpoints first, then the browser's own.
    expect(custom).toMatchObject({ pcashRpcUrl: "https://mine.example/pcash", l1RpcUrls: ["https://second.example", "https://mine.example/eth"] });
    expect(networkInstanceKey(custom)).toBe(networkInstanceKey(network));
    // Browser storage is user-editable; an unusable endpoint falls back to the default.
    expect(withRpcEndpoints(network, { pcashRpcUrl: "javascript:alert(1)" })).toEqual(network);
    expect(withRpcEndpoints(network, { l1Rpcs: {
      added: [{ url: "javascript:alert(1)", enabled: true }, { url: "https://mine.example/eth", enabled: false }], paused: ["https://first.example"], removed: ["https://second.example"],
    } })).toEqual(network);
  });

  it("isolates replacement chains", () => {
    const original = configuredNetwork(local);
    for (const replacement of [{ ...original, l1ChainId: original.l1ChainId + 1 }, { ...original, genesisHash: `0x${"13".repeat(32)}` }]) {
      expect(networkInstanceKey(replacement)).not.toBe(networkInstanceKey(original));
      const config = resolveNetworkExplorerConfig(original);
      if (config.status !== "valid") throw new Error("expected valid deployment");
      expect(explorerIdentityMismatch(config.config, {
        pcashChainId: replacement.pcashChainId, l1ChainId: BigInt(replacement.l1ChainId), genesisHash: replacement.genesisHash,
      } as StatusResult)).toBe(networkChangedMessage());
    }
  });

  it("names the local restart only in development", () => {
    expect(networkChangedMessage(true)).toContain("just web");
    expect(networkChangedMessage(false)).not.toContain("just");
  });
});
