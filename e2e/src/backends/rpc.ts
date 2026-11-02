export async function l1Rpc<T>(url: string, method: string, params: readonly unknown[] = []): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`L1 RPC ${method} request to ${url} failed: ${detail}`, { cause: error });
  }
  if (!response.ok) throw new Error(`L1 RPC ${method} returned HTTP ${response.status}`);
  const body = await response.json() as { result?: T; error?: { code?: number; message: string } };
  if (body.error !== undefined) {
    throw new Error(`L1 RPC ${method} failed${body.error.code === undefined ? "" : ` (${body.error.code})`}: ${body.error.message}`);
  }
  if (!("result" in body)) throw new Error(`L1 RPC ${method} returned no result`);
  return body.result as T;
}

/**
 * EIP-1559 fees for one L1 action: twice the base fee plus priority headroom,
 * or the operator's `PCASH_E2E_L1_MAX_FEE_PER_GAS` ceiling when one is configured.
 */
export async function l1FeeCaps(rpcUrl: string, ceiling?: bigint): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}> {
  const [block, priority] = await Promise.all([
    l1Rpc<{ baseFeePerGas: string }>(rpcUrl, "eth_getBlockByNumber", ["latest", false]),
    l1Rpc<string>(rpcUrl, "eth_maxPriorityFeePerGas"),
  ]);
  const suggestedPriority = BigInt(priority);
  const headroom = suggestedPriority > 1_000_000_000n ? suggestedPriority : 1_000_000_000n;
  const maxFeePerGas = ceiling ?? 2n * BigInt(block.baseFeePerGas) + headroom;
  return {
    maxFeePerGas,
    maxPriorityFeePerGas: suggestedPriority > maxFeePerGas ? maxFeePerGas : suggestedPriority,
  };
}

export function quantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

export function validPrivateKey(value: string | undefined, name: string): `0x${string}` {
  if (value === undefined || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte 0x-prefixed private key`);
  }
  return value as `0x${string}`;
}
