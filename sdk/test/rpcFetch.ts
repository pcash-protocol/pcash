// A viem `fetchFn` for the node clients that hands each JSON-RPC request to a
// test callback instead of the network.

import type { NodeRpcOptions } from "../src/clients/jsonRpc.ts";

export interface RpcRequestBody {
  jsonrpc: string;
  id: number;
  method: string;
  params: unknown[];
}

/** Client options whose fetch answers every request with `respond`'s Response. */
export function rpcFetch(
  respond: (body: RpcRequestBody, url: string, init: RequestInit) => Response | Promise<Response>,
): NodeRpcOptions {
  return { fetchFn: async (url, init = {}) => await respond(JSON.parse(String(init.body)), String(url), init) };
}

/** A successful JSON-RPC reply to `body`. */
export function rpcResult(body: RpcRequestBody, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
}
