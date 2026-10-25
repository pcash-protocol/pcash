// Typed failures shared by relay orchestration and platform hosts.

import { BaseError } from "viem";
import { PcashNodeRpcError } from "../clients/jsonRpc.ts";
import { L1IdentityError } from "../l1/relayer.ts";
import { parseHexQuantity } from "../utils/hex.ts";

class RelayError extends Error {
  constructor(name: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = name;
  }
}

/** A request or local relay policy was invalid before any L1 broadcast. */
export class RelayValidationError extends RelayError {
  constructor(message: string, cause?: unknown) {
    super("RelayValidationError", message, cause);
  }
}

/** The operation failed before the wallet accepted a broadcast. */
export class RelayPreBroadcastError extends RelayValidationError {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), cause);
    this.name = "RelayPreBroadcastError";
  }
}

/** The account's relay journal cannot take this transaction: it is full, overlaps an in-flight batch, or holds an unresolved intent. */
export class RelayJournalConflictError extends RelayError {
  constructor(message: string, cause?: unknown) {
    super("RelayJournalConflictError", message, cause);
  }
}

/** A pending batch cannot be replaced within the configured execution fee ceiling. */
export class RelayFeeCeilingError extends RelayJournalConflictError {
  readonly resolutionId: string;
  readonly transactionHash: string;
  readonly maxFeePerGas: bigint;

  constructor(resolutionId: string, transactionHash: string, maxFeePerGas: bigint) {
    super(`relay journal ${resolutionId} is pending: replacement exceeds maximum fee per gas ${maxFeePerGas} wei`);
    this.name = "RelayFeeCeilingError";
    this.resolutionId = resolutionId;
    this.transactionHash = transactionHash;
    this.maxFeePerGas = maxFeePerGas;
  }
}

/** An upstream operation did not finish inside its explicit deadline. */
export class RelayDeadlineError extends RelayError {
  constructor(message: string, cause?: unknown) {
    super("RelayDeadlineError", message, cause);
  }
}

/** The PCASH node or L1 endpoint failed, refused, or reverted an operation. */
export class RelayUpstreamError extends RelayError {
  constructor(message: string, cause?: unknown) {
    super("RelayUpstreamError", message, cause);
  }
}

/** Parse an upstream JSON-RPC quantity, reporting a malformed one as an upstream failure. */
export function upstreamQuantity(value: unknown, message: string): bigint {
  try {
    return parseHexQuantity(value);
  } catch (error) {
    throw new RelayUpstreamError(message, error);
  }
}

/** Bound an operation even when its underlying transport has no abort support. */
export function withRelayDeadline<T>(
  what: string,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new RelayDeadlineError(`${what} timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    void Promise.resolve().then(operation).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Map a transport or upstream failure onto the relay error types. Unknown
 * errors keep only their name, since transport messages can carry a
 * credential-bearing URL.
 */
export function relayFailure(what: string, error: unknown): Error {
  if (
    error instanceof RelayDeadlineError
    || error instanceof RelayJournalConflictError
    || error instanceof RelayUpstreamError
    || error instanceof RelayValidationError
  ) {
    return error;
  }
  if (error instanceof L1IdentityError) return new RelayUpstreamError(error.message, error);
  const detail = error instanceof Error ? error.name : "unknown error";
  if (
    error instanceof Error
    && (/timeout/i.test(error.name) || /timed? out/i.test(error.message))
  ) {
    return new RelayDeadlineError(`${what} timed out`, error);
  }
  return new RelayUpstreamError(`${what} failed (${detail})`, error);
}

/**
 * The message a service may return to a caller. Messages are text PCASH code
 * writes, and an upstream failure's own text stays on `cause`. viem's errors
 * are the exception: their messages print the request URL, which can carry a
 * credential, and the request body, so they give only their short description.
 * A node's JSON-RPC error keeps its code and words.
 */
export function publicErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // A wrapper that repeats its cause's message answers with its cause's.
  if (error.cause instanceof Error && error.message === error.cause.message) return publicErrorMessage(error.cause);
  if (error instanceof BaseError && !(error instanceof PcashNodeRpcError)) return error.shortMessage;
  return error.message;
}
