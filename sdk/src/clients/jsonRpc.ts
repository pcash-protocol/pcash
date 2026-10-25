// The JSON-RPC 2.0 exchange shared by every PCASH node listener: `pcash_*`,
// the `pscan_*` source listener, and the operator-only `admin_*` listener.
// viem's HTTP RPC client carries the request; the reply is a trust boundary,
// so parsing is strict: a malformed reply fails rather than decoding to
// something plausible.

import { RpcRequestError } from "viem";
import { getHttpRpcClient, type HttpRpcClientOptions } from "viem/utils";
import { parseHexQuantity } from "../utils/hex.ts";

export interface NodeRpcOptions {
  /** Deadline for one request, including reading its response body. */
  timeoutMs?: number;
  /** Override for `fetch`, e.g. to add an abort signal or to answer requests in a test. */
  fetchFn?: HttpRpcClientOptions["fetchFn"];
}

const DEFAULT_NODE_RPC_TIMEOUT_MS = 60_000;

// The largest reply each listener sends: its server's response body limit.
// Reading stops past it, so a hostile endpoint cannot make the client buffer
// and parse an unbounded body.
/** `pcash_*`: the node's `MAX_RPC_RESPONSE_BODY_BYTES`. */
export const MAX_RPC_RESPONSE_BODY_BYTES = 10 * 1024 * 1024;
/** `admin_*` and `pscan_*`: the node's `SOURCE_PUBLICATION_MAX_BODY_BYTES`. */
export const SOURCE_PUBLICATION_MAX_BODY_BYTES = 16 * 1024 * 1024;

/**
 * A JSON-RPC error returned by a PCASH node listener. `code` and `data` are the
 * listener's; `kind` is its machine-readable `data.kind`, when it sends one.
 */
export class PcashNodeRpcError extends RpcRequestError {
  override name = "PcashNodeRpcError";
  readonly kind: string | undefined;

  constructor(error: { code: number; message: string; data?: unknown }, request: { method: string; url: string }) {
    super({ body: { method: request.method }, error, url: request.url });
    const data = error.data;
    this.kind = data !== null && typeof data === "object" && typeof (data as { kind?: unknown }).kind === "string"
      ? (data as { kind: string }).kind
      : undefined;
    // Wallet and explorer surfaces show `message`; keep it the listener's own words.
    this.message = `node RPC error ${error.code}${this.kind === undefined ? "" : ` (${this.kind})`}: ${error.message}`;
  }
}

/**
 * A caller for one listener URL: send a request, return its `result`. A
 * JSON-RPC error object wins over the HTTP status, because a listener may carry
 * its typed refusal on a non-2xx reply; any other non-2xx reply, a body that is
 * not JSON, a body longer than `maxResponseBytes`, or a missing `result` throws.
 */
export function nodeRpc(
  url: string,
  maxResponseBytes: number,
  options: NodeRpcOptions = {},
): (method: string, params: unknown[]) => Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_NODE_RPC_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("node RPC timeoutMs must be a positive integer");
  }
  // The deadline is our own signal rather than viem's `timeout`, because viem's
  // stops at the response headers and a stalled body must fail too.
  const client = getHttpRpcClient(url, { fetchFn: options.fetchFn, timeout: 0, maxResponseBodySize: maxResponseBytes });
  return async (method, params) => {
    const envelope = rpcObject(
      await client.request({ body: { method, params }, fetchOptions: { signal: AbortSignal.timeout(timeoutMs) } }),
      "node RPC response",
    );
    if (envelope.error !== undefined && envelope.error !== null) {
      const error = rpcObject(envelope.error, "node RPC error");
      if (typeof error.code !== "number" || !Number.isSafeInteger(error.code)) {
        throw new Error("node RPC error code must be an integer");
      }
      throw new PcashNodeRpcError(
        { code: error.code, message: rpcString(error.message, "node RPC error message"), data: error.data },
        { method, url },
      );
    }
    return rpcOwn(envelope, "result", "node RPC result");
  };
}

export function rpcObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function rpcString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

export function rpcBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

export function rpcOwn(object: Record<string, unknown>, key: string, label: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(object, key)) throw new Error(`${label} is required`);
  return object[key];
}

// Declarative reply shapes. A parser takes an untrusted value and the label
// that names it in errors; `shape` labels each field `${label}.${key}` and
// `array` each element `${label}[${index}]`.

export type Parser<T> = (value: unknown, label: string) => T;

export const quantity: Parser<bigint> = (value, label) => parseHexQuantity(value, label);
export const str: Parser<string> = rpcString;
export const bool: Parser<boolean> = rpcBoolean;

/** Any value, as long as the key is present. */
export const present: Parser<unknown> = (value, label) => {
  if (value === undefined) throw new Error(`${label} is required`);
  return value;
};

export function oneOf<const T extends readonly string[]>(...values: T): Parser<T[number]> {
  return (value, label) => {
    const text = rpcString(value, label);
    if (!(values as readonly string[]).includes(text)) throw new Error(`${label} must be one of ${values.join(", ")}`);
    return text as T[number];
  };
}

export function array<T>(item: Parser<T>): Parser<T[]> {
  return (value, label) => {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    return value.map((entry, index) => item(entry, `${label}[${index}]`));
  };
}

/** The key must be present; its value may be null. */
export function nullable<T>(parse: Parser<T>): Parser<T | null> {
  return (value, label) => {
    if (value === null) return null;
    if (value === undefined) throw new Error(`${label} is required and must be explicit or null`);
    return parse(value, label);
  };
}

export function shape<S extends Record<string, Parser<unknown>>>(
  spec: S,
): Parser<{ [K in keyof S]: S[K] extends Parser<infer T> ? T : never }> {
  return (value, label) => {
    const object = rpcObject(value, label);
    const parsed: Record<string, unknown> = {};
    for (const key of Object.keys(spec)) {
      parsed[key] = spec[key]!(Object.hasOwn(object, key) ? object[key] : undefined, `${label}.${key}`);
    }
    return parsed as { [K in keyof S]: S[K] extends Parser<infer T> ? T : never };
  };
}
