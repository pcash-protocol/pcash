export const MULTICALL3_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11";

/**
 * Install Multicall3 on an Anvil instance for clients that batch ETH balance reads.
 * @param {(method: string, params: unknown[]) => Promise<unknown>} rpc
 */
export async function setupAnvilMulticall3(rpc) {
  const { multicall3Bytecode } = await import(new URL("./constants/contracts.js", import.meta.resolve("viem")).href);
  const runtime = await rpc("eth_call", [{ data: multicall3Bytecode }, "latest"]);
  await rpc("anvil_setCode", [MULTICALL3_ADDRESS, runtime]);
}
