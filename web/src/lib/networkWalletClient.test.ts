import { describe, expect, it, vi } from "vitest";
import { defineChain, type WalletClient } from "viem";
import { networkWalletClient } from "./networkWalletClient.ts";

const address = `0x${"12".repeat(20)}` as const;
const chain = defineChain({ id: 12345678, name: "Anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://localhost:8545"] } } });

describe("wallet requests", () => {
  it("asks the wallet once when it answers with an unclear error", async () => {
    const request = vi.fn(async () => { throw Object.assign(new Error("Internal JSON-RPC error."), { code: -32603 }); });
    const client = networkWalletClient({ request } as unknown as WalletClient, address, chain);
    await expect(client.request({ method: "eth_sendTransaction", params: [{ from: address, to: address, value: "0x0" }] })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
