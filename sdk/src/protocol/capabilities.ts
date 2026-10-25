import {
  TX_KIND_CONTRACT_ACCOUNT_CREATION,
  TX_KIND_USER_ACCOUNT_CREATION,
  TX_KIND_USER_ACCOUNT_UPDATE,
  TX_KIND_PRIVATE_VALUE,
  VERSION,
  type BatchVersion,
  type TransactionType,
} from "./codec.ts";

export interface NodeCapabilities {
  acceptedTransactionTypes: readonly number[];
  acceptedBatchVersions: readonly number[];
}

const KNOWN_TRANSACTION_TYPES = new Set<number>([
  TX_KIND_PRIVATE_VALUE,
  TX_KIND_USER_ACCOUNT_CREATION,
  TX_KIND_CONTRACT_ACCOUNT_CREATION,
  TX_KIND_USER_ACCOUNT_UPDATE,
]);

function isKnownTransactionType(value: number): value is TransactionType {
  return Number.isInteger(value) && KNOWN_TRANSACTION_TYPES.has(value);
}

export function transactionTypeOf(bytes: Uint8Array): TransactionType {
  const transactionType = bytes[0];
  if (transactionType === undefined) throw new Error("transaction bytes are empty");
  if (!isKnownTransactionType(transactionType)) {
    throw new Error(`unknown transaction type 0x${transactionType.toString(16).padStart(2, "0")}`);
  }
  return transactionType;
}

export function assertTransactionTypeAccepted(
  status: Pick<NodeCapabilities, "acceptedTransactionTypes">,
  transactionType: TransactionType,
): void {
  if (!status.acceptedTransactionTypes.includes(transactionType)) {
    throw new Error(`transaction type 0x${transactionType.toString(16).padStart(2, "0")} is not accepted at the derived head`);
  }
}

/**
 * The privateValue relation to build against, checked live rather than assumed:
 * V1 defines exactly one, so this asserts the derived head still admits it and
 * returns it. A second privateValue type would have to be a deliberate protocol
 * change here, not a silent fallback — the public type byte must not become an
 * optional privacy signal.
 */
export function selectPrivateValueTransactionType(
  status: Pick<NodeCapabilities, "acceptedTransactionTypes">,
): typeof TX_KIND_PRIVATE_VALUE {
  assertTransactionTypeAccepted(status, TX_KIND_PRIVATE_VALUE);
  return TX_KIND_PRIVATE_VALUE;
}

/** V1 is the only defined batch encoding; future versions remain an independent axis. */
export function selectBatchVersion(
  status: Pick<NodeCapabilities, "acceptedBatchVersions">,
): BatchVersion {
  if (!status.acceptedBatchVersions.includes(VERSION)) {
    throw new Error(`node does not accept supported batch version ${VERSION}`);
  }
  return VERSION;
}
