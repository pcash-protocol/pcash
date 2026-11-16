import {
  HttpRequestError,
  TimeoutError,
  createTransport,
  http,
  shouldThrow,
  type EIP1193RequestFn,
  type Transport,
} from "viem";

/** How long an endpoint may take to respond while another endpoint could answer instead. */
const ENDPOINT_TIMEOUT_MS = 5_000;
/** How long an endpoint that did not respond is asked last. */
const UNRESPONSIVE_COOLDOWN_MS = 60_000;

/** When each endpoint last failed to respond, for every transport that reads from it. */
const unresponsiveAt = new Map<string, number>();

/**
 * Reads through L1 RPC endpoints in order of preference. An endpoint that
 * fails yields to the next. So does one that answers null: a pruned endpoint
 * answers null for a receipt or block it no longer keeps, which another
 * endpoint may still serve. Null is the result only when no endpoint has the
 * object, and an error only when none could answer.
 *
 * An endpoint that did not respond at all is asked last for a while, so an
 * outage costs one timeout rather than one per read.
 */
export function l1RpcTransport(urls: readonly string[]): Transport {
  const transports = urls.map((url) => http(url));
  return (config) => {
    const endpoints = transports.map((transport, index) => ({
      url: urls[index]!,
      // Retries wrap the whole pass over the endpoints, not each endpoint.
      ...transport({ ...config, retryCount: 0, ...(urls.length > 1 ? { timeout: ENDPOINT_TIMEOUT_MS } : {}) }),
    }));
    return createTransport({
      key: "l1Rpc",
      name: "L1 RPC",
      type: "l1Rpc",
      request: (async (args: never): Promise<unknown> => {
        const now = Date.now();
        const cooling = (url: string) => {
          const at = unresponsiveAt.get(url);
          return at !== undefined && now - at < UNRESPONSIVE_COOLDOWN_MS ? at : 0;
        };
        let absent = false;
        let failure: unknown;
        for (const endpoint of [...endpoints].sort((a, b) => cooling(a.url) - cooling(b.url))) {
          try {
            const result: unknown = await endpoint.request(args);
            if (result !== null) return result;
            absent = true;
          } catch (error) {
            // A revert or a wallet rejection is the answer on every endpoint.
            if (shouldThrow(error as Error)) throw error;
            // An RPC error is an answer about this request; no answer is about the endpoint.
            if (error instanceof HttpRequestError || error instanceof TimeoutError) unresponsiveAt.set(endpoint.url, Date.now());
            failure = error;
          }
        }
        if (absent) return null;
        throw failure;
      }) as EIP1193RequestFn,
    });
  };
}
