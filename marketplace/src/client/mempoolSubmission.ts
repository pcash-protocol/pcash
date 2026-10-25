import { bytesToBigInt, hexToBytes, numberToHex, type Hex } from "viem";
import {
  decodeTransaction,
  transactionIdentity,
  RECENT_PCASH_BLOCK_WINDOW_SECONDS,
  sectionPublicInput,
  TX_KIND_CONTRACT_ACCOUNT_CREATION,
  TX_KIND_PRIVATE_VALUE,
  TX_KIND_USER_ACCOUNT_UPDATE,
  type PcashNodeClient,
} from "@pcash/sdk/browser";
import { pollReceipt } from "@pcash/sdk/browser";
import {
  submitBuiltTransaction,
  type MarketplaceTransactionSubmitter,
} from "./submitBuiltTransaction.ts";
import type { ProvePhase } from "@pcash/sdk/browser-prover";

export interface PreparedMarketplaceTransaction {
  contentHash: Hex;
  transactionHex: Hex;
}

export type { MarketplaceTransactionSubmitter } from "./submitBuiltTransaction.ts";

function retainedStatusError(contentHash: string, status: string): Error {
  return new Error(
    `prepared transaction ${contentHash} is retained with non-relayable mempool status ${status}; wait for node lifecycle reconciliation before retrying`,
  );
}

/** Saved bytes name a recentPcashBlockHash the node can no longer execute against; the same action must be proved again. */
export class StaleTransactionAnchorError extends Error {
  readonly contentHash: string;
  readonly recentPcashBlockHash: Hex;
  readonly reason: "orphaned" | "expired";

  constructor(contentHash: string, recentPcashBlockHash: Hex, reason: "orphaned" | "expired") {
    super(
      `saved transaction ${contentHash} is proved against PCASH block ${recentPcashBlockHash}, which `
        + (reason === "orphaned" ? "is no longer canonical" : "is older than the recent-block window")
        + "; the same action must be proved again against the current head",
    );
    this.name = "StaleTransactionAnchorError";
    this.contentHash = contentHash;
    this.recentPcashBlockHash = recentPcashBlockHash;
    this.reason = reason;
  }
}

export function isStaleTransactionAnchorError(error: unknown): error is StaleTransactionAnchorError {
  return error instanceof StaleTransactionAnchorError;
}

/** The recentPcashBlockHash a saved transaction names. */
function savedTransactionAnchor(entry: Uint8Array): bigint {
  const decoded = decodeTransaction(entry);
  if (decoded.kind === TX_KIND_PRIVATE_VALUE) return sectionPublicInput(decoded, 1);
  if (decoded.kind === TX_KIND_CONTRACT_ACCOUNT_CREATION) {
    return decoded.funding.mode === "sponsored"
      ? sectionPublicInput(decoded.funding.section, 1)
      : bytesToBigInt(decoded.funding.recentPcashBlockHash);
  }
  if (decoded.kind === TX_KIND_USER_ACCOUNT_UPDATE) return sectionPublicInput(decoded.section, 1);
  return bytesToBigInt(decoded.recentPcashBlockHash);
}

/**
 * Refuse to re-admit bytes whose anchor left the recent-block window (§10.6). A
 * reorganization drops an orphaned anchor immediately and age drops a canonical
 * one after the window, so neither case is worth waiting on.
 */
export async function assertSavedTransactionAnchorUsable(node: PcashNodeClient, contentHash: string, transactionHex: Hex): Promise<void> {
  const anchorHex = numberToHex(savedTransactionAnchor(hexToBytes(transactionHex)), { size: 32 });
  const [status, block] = await Promise.all([node.status(), node.getBlockByHash(anchorHex)]);
  if (block === null) throw new StaleTransactionAnchorError(contentHash, anchorHex, "orphaned");
  if (status.latestBlockTimestamp - block.timestamp > RECENT_PCASH_BLOCK_WINDOW_SECONDS) {
    throw new StaleTransactionAnchorError(contentHash, anchorHex, "expired");
  }
}

/** Persist exact marketplace bytes before admitting them to the configured node. */
export async function submitMarketplaceTransactionToMempool(params: {
  node: PcashNodeClient;
  transactionBytes: Uint8Array;
  onPrepared?: (contentHash: string, transactionHex: Hex) => void | Promise<void>;
  onProgress?: (phase: ProvePhase, message: string) => void;
  submit?: MarketplaceTransactionSubmitter;
}): Promise<PreparedMarketplaceTransaction> {
  const prepared = transactionIdentity(params.transactionBytes);
  await params.onPrepared?.(prepared.contentHash, prepared.transactionHex);
  await (params.submit ?? submitBuiltTransaction)(params.transactionBytes, {
    node: params.node,
    ...(params.onProgress !== undefined ? { onProgress: params.onProgress } : {}),
  });
  return prepared;
}

/**
 * Re-admit an absent durable marketplace transaction. Non-ready retained transactions await
 * node lifecycle reconciliation; bytes whose anchor can no longer execute throw
 * `StaleTransactionAnchorError` so the caller can prove the same action again.
 */
export async function restoreMarketplaceTransactionToMempool(params: {
  node: PcashNodeClient;
  contentHash: string;
  transactionHex: Hex;
  beforeSubmit?: () => void | Promise<void>;
  onProgress?: (phase: ProvePhase, message: string) => void;
  submit?: MarketplaceTransactionSubmitter;
}): Promise<"receipt" | "retained" | "restored"> {
  params.onProgress?.("submitting", "checking the saved transaction with the configured mempool node…");
  if ((await pollReceipt(params.node, params.contentHash))?.outcome === "succeeded") return "receipt";
  await assertSavedTransactionAnchorUsable(params.node, params.contentHash, params.transactionHex);
  if (params.submit?.publication === "l1") {
    await params.beforeSubmit?.();
    await params.submit(hexToBytes(params.transactionHex), { node: params.node, ...(params.onProgress === undefined ? {} : { onProgress: params.onProgress }) });
    return "restored";
  }
  const existing = await params.node.getMempoolTransaction(params.contentHash);
  if (existing !== null) {
    if (existing.status.toLowerCase() === "ready") return "retained";
    throw retainedStatusError(params.contentHash, existing.status);
  }
  await params.beforeSubmit?.();
  params.onProgress?.("submitting", "re-admitting the exact saved transaction to this node…");
  let admissionStatus: string | null = null;
  try {
    if (params.submit === undefined) {
      const submitted = await submitBuiltTransaction(hexToBytes(params.transactionHex), {
        node: params.node,
      });
      const admitted = await params.node.getMempoolTransaction(submitted.contentHash);
      if (admitted === null) {
        const receipt = await pollReceipt(params.node, submitted.contentHash);
        if (receipt?.outcome === "succeeded") return "receipt";
        throw new Error(`restored transaction ${submitted.contentHash} was neither retained nor accepted`);
      }
      if (admitted.contentHash.toLowerCase() !== params.contentHash.toLowerCase()) {
        throw new Error(`mempool admission returned ${admitted.contentHash}, expected prepared content ${params.contentHash}`);
      }
      admissionStatus = admitted.status;
    } else {
      const observedNode = new Proxy(params.node, {
        get(target, property) {
          if (property === "submitRawTransaction") {
            return async (transactionHex: string) => {
              const admitted = await target.submitRawTransaction(transactionHex);
              admissionStatus = admitted.status;
              return admitted;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await params.submit(hexToBytes(params.transactionHex), {
        node: observedNode,
        ...(params.onProgress !== undefined ? { onProgress: params.onProgress } : {}),
      });
    }
  } catch (error) {
    const receipt = await pollReceipt(params.node, params.contentHash);
    const retained = receipt?.outcome === "succeeded" ? null : await params.node.getMempoolTransaction(params.contentHash);
    if (receipt?.outcome === "succeeded") return "receipt";
    if (retained?.status.toLowerCase() === "ready") return "restored";
    if (retained !== null) throw retainedStatusError(params.contentHash, retained.status);
    throw error;
  }
  if (admissionStatus !== null && admissionStatus.toLowerCase() !== "ready") {
    const receipt = await pollReceipt(params.node, params.contentHash);
    if (receipt?.outcome === "succeeded") return "receipt";
    const retained = await params.node.getMempoolTransaction(params.contentHash);
    if (retained?.status.toLowerCase() === "ready") return "restored";
    throw retainedStatusError(params.contentHash, retained?.status ?? admissionStatus);
  }
  return "restored";
}
