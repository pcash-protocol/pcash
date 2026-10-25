import { memoSchema, claimedSenderSchema, type TransactionData } from "@pcash/sdk/delivery";
import type { WalletSnapshot } from "@pcash/sdk/wallet";
import type { WalletPaymentActivity } from "./WalletProvider.tsx";

/** Keep observed statuses while a new snapshot's network reads are in flight. */
export function pendingPaymentActivity(
  pending: WalletSnapshot["pendingPayments"],
  previous: WalletPaymentActivity[],
): WalletPaymentActivity[] {
  const byId = new Map(previous.map((payment) => [payment.contentHash, payment]));
  return pending.map((payment) => {
    const prior = byId.get(payment.contentHash);
    const status = prior?.status;
    if (prior !== undefined && (status === "pending" || status === "confirmed" || status === "unknown" || status === "failed")) {
      return {
        ...payment,
        ...paymentMemo(payment),
        status,
        ...(prior.receiptTxId === undefined ? {} : { receiptTxId: prior.receiptTxId }),
      };
    }
    return { ...payment, ...paymentMemo(payment), status: payment.state === "admitted" || payment.l1TxHash !== undefined ? "pending" : "unknown" };
  });
}

export interface PaymentObservation {
  /** Undefined means the read failed; null means no accepted receipt. */
  receipt: string | null | undefined;
  /** An observed failed inclusion remains retryable until the action expires. */
  rejectedReceipt?: string;
  mempool: boolean | undefined;
  /** Whether this browser's Ethereum submission journal carries it; undefined when the read failed. */
  journal: boolean | undefined;
}

export function observedPaymentActivity(
  payment: WalletPaymentActivity,
  observation: PaymentObservation,
): WalletPaymentActivity {
  if (observation.receipt === undefined && (payment.status === "confirmed" || payment.status === "failed")) return payment;
  const { receiptTxId: previousReceipt, ...rest } = payment;
  const receipt = observation.receipt === undefined
    ? payment.status === "confirmed" ? previousReceipt : undefined
    : observation.receipt ?? undefined;
  if (receipt !== undefined) return { ...rest, status: "confirmed", receiptTxId: receipt };
  if (observation.rejectedReceipt !== undefined) return { ...rest, status: "failed", receiptTxId: observation.rejectedReceipt };
  // Pending while the mempool or an unsettled Ethereum transaction of this
  // browser holds it. Once its transaction is dropped, only its recovery remains.
  const held = [observation.mempool, observation.journal];
  const pending = held.includes(true) || (held.includes(undefined) && payment.status === "pending");
  return { ...rest, status: pending ? "pending" : "unknown" };
}

/** Existing memo UI is a projection of transaction data addressed to the payment recipient. */
export function paymentMemo(payment: { data?: TransactionData; deliveryTarget: string }): { memo?: string; includeSender: boolean } {
  const records = payment.data?.recipients?.find(group => group.to.toLowerCase() === payment.deliveryTarget.toLowerCase())?.records ?? [];
  const memo = records.find(record => record.schema === memoSchema.id);
  return { ...(memo === undefined ? {} : { memo: new TextDecoder().decode(memo.data) }), includeSender: records.some(record => record.schema === claimedSenderSchema.id) };
}
