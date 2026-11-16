// Who signs and broadcasts this client's L1 transactions.
//
// One signer seam serves headless raw-key drivers and browser EIP-1193 wallets
// without requiring application flows to hold key material.
//
// Nothing here reads, derives, or stores key material. A signer that holds none
// is the entire point.

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** One L1 transaction to broadcast. */
export interface L1TransactionRequest {
  /** The chain on which these exact transaction fields are intended to execute. */
  chainId: bigint;
  to: Address;
  data?: Hex;
  value?: bigint;
  /** A prepared gas limit; supplied so the signer does not estimate again after a checkpoint. */
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface L1FeeCap {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gas?: bigint;
}

export interface L1Signer {
  /** The address transactions are sent from. */
  readonly address: Address;
  /**
   * The chain this signer will actually broadcast to.
   *
   * Read separately from the L1 RPC's chain id on purpose. A raw key signs for
   * whichever RPC it was configured with, so the two agree by construction; a
   * browser wallet has its own selected network and may be pointed somewhere
   * else entirely. `assertSignerChain` is what closes that gap before value
   * moves.
   */
  chainId(): Promise<bigint>;
  sendTransaction(tx: L1TransactionRequest): Promise<Hex>;
}

/** A signer-owned check that failed before its broadcast call was reached. */
export class L1SignerPreflightError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "L1SignerPreflightError";
  }
}

/** Only errors that prove the signer never accepted a transaction for broadcast. */
export function isDefinitelyNotBroadcastL1Error(cause: unknown): boolean {
  const seen = new Set<unknown>();
  let current = cause;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    if (current instanceof L1SignerPreflightError) return true;
    if ((current as { code?: unknown }).code === 4001) return true;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Sign with a raw secp256k1 key against a configured RPC.
 *
 * This is the headless path: end-to-end drivers, the live-journey scripts, and
 * anything else running outside a browser. It is deliberately NOT the path a
 * user-facing application takes.
 */
export function privateKeyL1Signer(key: Hex, l1Url: string, feeCap?: L1FeeCap): L1Signer {
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, transport: http(l1Url) });
  const reader = createPublicClient({ transport: http(l1Url) });
  return {
    address: account.address,
    chainId: async () => BigInt(await reader.getChainId()),
    sendTransaction: async ({ chainId, ...tx }) => {
      try {
        const actual = BigInt(await reader.getChainId());
        if (actual !== chainId) {
          throw new Error(`L1 signer RPC changed to chain ${actual}, expected chain ${chainId}`);
        }
      } catch (cause) {
        throw new L1SignerPreflightError(cause);
      }
      return wallet.sendTransaction({
        ...tx,
        ...(feeCap === undefined ? {} : feeCap),
        chain: null,
      });
    },
  };
}

/**
 * Sign with the viem Wallet Client supplied by the application.
 *
 * The address is supplied rather than discovered, because account selection and
 * the connection prompt belong to the application, not to this module.
 */
export function viemL1Signer(client: WalletClient, address: Address): L1Signer {
  return {
    address,
    chainId: async () => BigInt(await client.getChainId()),
    sendTransaction: async (tx) => {
      try {
        const chainId = BigInt(await client.getChainId());
        if (chainId !== tx.chainId) {
          throw new Error(`wallet changed to chain ${chainId}, expected chain ${tx.chainId}`);
        }
        const selected = (await client.getAddresses())[0];
        if (selected === undefined) throw new Error("wallet has no connected account");
        if (selected.toLowerCase() !== address.toLowerCase()) {
          throw new Error(`wallet changed account from ${address} to ${selected}`);
        }
        if (client.chain === undefined || BigInt(client.chain.id) !== tx.chainId) {
          throw new Error(`viem wallet client is not configured for chain ${tx.chainId}`);
        }
      } catch (cause) {
        throw new L1SignerPreflightError(cause);
      }
      const { chainId: _chainId, ...transaction } = tx;
      return client.sendTransaction({ account: address, chain: client.chain, ...transaction } as never);
    },
  };
}

/**
 * Require the signer to be on the chain the PCASH node follows.
 *
 * Checking the L1 RPC alone is not enough once the signer is separable from it:
 * a browser wallet on the wrong network would broadcast real value to a chain
 * where the router, the offer, and the escrow do not exist.
 */
export async function assertSignerChain(signer: L1Signer, expectedL1ChainId: bigint): Promise<void> {
  const actual = await signer.chainId();
  if (actual !== expectedL1ChainId) {
    throw new Error(
      `wallet is connected to chain ${actual}, but this node follows L1 chain ${expectedL1ChainId}; `
        + "switch networks before continuing",
    );
  }
}
