// Ethereum identity and account helpers. Every L1 transaction is sent through
// ../relay/ so each host uses its durable journal.

import {
  createPublicClient,
  defineChain,
  http,
  type Account,
  type Chain,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fromHex, toHex } from "../utils/hex.ts";
import { DEFAULT_NETWORK_CONFIG, inboxAddressHex } from "../protocol/network.ts";
import { VERSION, encodeBatchForVersion, type BatchVersion } from "../protocol/codec.ts";

/** Default INBOX_ADDRESS as a 20-byte 0x address string. */
export const DEFAULT_INBOX = inboxAddressHex(DEFAULT_NETWORK_CONFIG);

/** Frame exact transaction bytes into canonical batch calldata. */
export function assembleBatch(
  txBytesList: readonly Uint8Array[],
  posterOwnerCommitment: bigint,
  posterContext: bigint,
  version: BatchVersion = VERSION,
): Uint8Array {
  return encodeBatchForVersion(txBytesList, version, posterOwnerCommitment, posterContext);
}

// --- viem plumbing ---------------------------------------------------------

/**
 * Narrow an L1 chain id to the `number` viem models `Chain.id` as. The protocol
 * carries a `u64`, so values above `Number.MAX_SAFE_INTEGER` would silently round
 * to a different EIP-155 chain and sign transactions no RPC would accept. Every
 * client, cache key, and signer goes through this before converting.
 */
export function l1ChainIdNumber(chainId: bigint | number): number {
  const value = BigInt(chainId);
  if (value <= 0n) throw new Error(`L1 chain id must be positive, got ${value}`);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`L1 chain id ${value} exceeds the ${Number.MAX_SAFE_INTEGER} this stack can represent exactly`);
  }
  return Number(value);
}

/**
 * A minimal chain definition for the L1 the node follows. PCASH resolves L1
 * identity from `pcash_status` at runtime, so the chain is built from that rather
 * than pinned to a viem/chains entry.
 */
export function pcashL1Chain(chainId: bigint | number, rpcUrl: string): Chain {
  return defineChain({
    id: l1ChainIdNumber(chainId),
    name: "pcash-l1",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function publicClientFor(
  rpcUrl: string,
  chainId: bigint | number,
  timeoutMs: number,
  transport?: Transport,
) {
  return createPublicClient({
    chain: pcashL1Chain(chainId, rpcUrl),
    transport: transport ?? http(rpcUrl, { timeout: timeoutMs }),
  });
}

/**
 * Strip anything that might carry a credential-bearing URL out of an error,
 * keeping its name so callers can still recognize a timeout.
 */
function transportError(what: string, error: unknown): Error {
  const detail = error instanceof Error ? error.name : "unknown error";
  const failure = new Error(`${what} failed (${detail})`);
  if (error instanceof Error) failure.name = error.name;
  return failure;
}

/** The L1 endpoint answered, but it is not the L1 the node follows. Carries no URL. */
export class L1IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "L1IdentityError";
  }
}

export interface ExpectedL1Identity {
  chainId: bigint;
  anchorNumber: bigint;
  anchorHash: string;
}

/** Confirm that the endpoint receiving the batch is the L1 followed by the node. */
export async function requireL1Identity(
  rpcUrl: string,
  expected: ExpectedL1Identity,
  opts: { timeoutMs?: number; transport?: Transport } = {},
): Promise<void> {
  const client = publicClientFor(
    rpcUrl,
    expected.chainId,
    opts.timeoutMs ?? 30_000,
    opts.transport,
  );
  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch (error) {
    throw transportError("reading the L1 chain id", error);
  }
  if (BigInt(chainId) !== expected.chainId) {
    throw new L1IdentityError(
      `L1 endpoint chain id ${chainId} does not match node L1 chain id ${expected.chainId}`,
    );
  }

  let anchorHash: string | null;
  try {
    anchorHash = (await client.getBlock({ blockNumber: expected.anchorNumber })).hash;
  } catch (error) {
    throw transportError("reading the L1 anchor block", error);
  }
  if (!anchorHash) throw new L1IdentityError("L1 anchor block has no hash (still pending?)");
  if (anchorHash.toLowerCase() !== expected.anchorHash.toLowerCase()) {
    throw new L1IdentityError(
      `L1 endpoint anchor hash ${anchorHash} does not match node anchor hash ${expected.anchorHash}`,
    );
  }
}

/** secp256k1 account for a 32-byte 0x-hex key. The key never touches disk. */
export function relayerAccount(privateKey: string): Account {
  const key = fromHex(privateKey, "relayer private key");
  if (key.length !== 32) throw new Error("relayer private key must be exactly 32 bytes");
  return privateKeyToAccount(toHex(key) as Hex);
}
