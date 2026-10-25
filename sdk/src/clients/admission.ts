// Mempool admission of exact transaction bytes: the checks every submitter runs
// against the node's current status, and the submission that proves the node
// admitted these bytes rather than some other content.

import { assertTransactionTypeAccepted, transactionTypeOf } from "../protocol/capabilities.ts";
import { decodeTransactionForChain, TX_KIND_USER_ACCOUNT_CREATION } from "../protocol/codec.ts";
import { transactionIdentity } from "../protocol/block.ts";
import { sleep } from "../utils/time.ts";
import { PcashNodeRpcError } from "./jsonRpc.ts";
import type { PcashNodeClient, StatusResult, SubmitRawTransactionResult } from "./nodeClient.ts";

/**
 * Refuse a transaction the node's mempool cannot take: a transaction type the node
 * does not accept, or a direct account creation, which only its owner can
 * publish on Ethereum.
 */
export function assertMempoolAdmissible(status: StatusResult, transaction: Uint8Array): void {
  const transactionType = transactionTypeOf(transaction);
  if (transactionType === TX_KIND_USER_ACCOUNT_CREATION) {
    const creation = decodeTransactionForChain(transaction, status.pcashChainId);
    if (creation.kind === TX_KIND_USER_ACCOUNT_CREATION && creation.authorization.kind === "direct") {
      throw new Error("direct account creation requires a dedicated owner L1 submission; the mempool cannot admit it");
    }
  }
  assertTransactionTypeAccepted(status, transactionType);
}

/**
 * The node's answer when its admission queue or unpaid work budget is
 * exhausted. It reached no verdict on the transaction, so the same bytes may be
 * sent again.
 */
const MEMPOOL_BUSY = -32016;
const DEFAULT_ADMISSION_RETRY_MS = 30_000;

/**
 * `pcash_submitRawTransaction` errors the node returns before the transaction
 * can enter its pool: malformed parameters, no mempool, an invalid transaction,
 * a full pool, a policy refusal, a busy node, and a transaction ineligible at
 * the node's current state, which the client rebuilds. A verification or
 * storage failure, or a code from anything between the client and the node,
 * may follow an insert.
 */
const PRE_INSERT_REFUSALS: ReadonlySet<number> = new Set([-32602, -32010, -32011, -32012, -32015, MEMPOOL_BUSY, -32017]);

/** The node refused these bytes, so they are not in its pool. */
export function isAdmissionRefusal(error: unknown): error is PcashNodeRpcError {
  return error instanceof PcashNodeRpcError && PRE_INSERT_REFUSALS.has(error.code);
}

/**
 * Submit exact transaction bytes to the node's mempool and require it to admit that
 * content, resubmitting for up to `retryForMs` while the node's admission queue
 * is full.
 */
export async function admitTransaction(
  node: Pick<PcashNodeClient, "submitRawTransaction">,
  transaction: Uint8Array,
  retryForMs = DEFAULT_ADMISSION_RETRY_MS,
): Promise<SubmitRawTransactionResult> {
  const { contentHash, transactionHex } = transactionIdentity(transaction);
  const deadline = Date.now() + retryForMs;
  for (let attempt = 1; ; attempt += 1) {
    let admission: SubmitRawTransactionResult;
    try {
      admission = await node.submitRawTransaction(transactionHex);
    } catch (error) {
      if (!(error instanceof PcashNodeRpcError && error.code === MEMPOOL_BUSY) || Date.now() >= deadline) {
        throw error;
      }
      await sleep(Math.min(2_000, 100 * attempt) + Math.floor(Math.random() * 100));
      continue;
    }
    if (admission.contentHash.toLowerCase() !== contentHash) {
      throw new Error(`node admitted content ${admission.contentHash}, expected ${contentHash}`);
    }
    return admission;
  }
}
