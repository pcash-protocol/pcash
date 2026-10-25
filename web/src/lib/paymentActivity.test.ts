import { describe, expect, it } from "vitest";
import { pendingPaymentActivity, observedPaymentActivity } from "./paymentActivity.ts";
import type { WalletPaymentActivity } from "./WalletProvider.tsx";

const pending = {
  kind: "payment" as const,
  contentHash: "0xpayment",
  deliveryTarget: "0xrecipient",
  recipientAddress: "0xrecipient",
  includeSender: false,
  amount: 5n,
  openFeeAmount: 1n,
  privateRelayFeeAmount: 0n,
  privateRelayRecipient: null,
  validUntilTimestamp: 100n,
  state: "admitted" as const,
};
const confirmed: WalletPaymentActivity = { ...pending, status: "confirmed", receiptTxId: "0xreceipt" };

describe("payment activity refresh", () => {
  it("shows failed mining independently of account readiness and retains its retry row", () => {
    const mining = { ...pending, amount: 0n, openFeeAmount: 0n, state: "submission-unknown" as const };
    const [row] = pendingPaymentActivity([mining], []);
    const failed = observedPaymentActivity(row!, { receipt: null, rejectedReceipt: "0xfailed", mempool: false, journal: false });
    expect(failed).toMatchObject({ status: "failed", receiptTxId: "0xfailed" });
    expect(pendingPaymentActivity([mining], [failed])).toEqual([failed]);
    expect(observedPaymentActivity(failed, { receipt: undefined, mempool: undefined, journal: undefined })).toEqual(failed);
    expect(observedPaymentActivity(failed, { receipt: "0xsuccess", mempool: false, journal: false })).toMatchObject({ status: "confirmed", receiptTxId: "0xsuccess" });
    expect(observedPaymentActivity(failed, { receipt: null, mempool: false, journal: false })).toMatchObject({ status: "unknown" });
  });
  it("keeps confirmed status and receipt through snapshot refresh and failed reads", () => {
    const [refreshing] = pendingPaymentActivity([pending], [confirmed]);
    expect(refreshing).toMatchObject({ status: "confirmed", receiptTxId: "0xreceipt" });
    expect(observedPaymentActivity(refreshing!, { receipt: undefined, mempool: undefined, journal: undefined })).toEqual(confirmed);
    expect(observedPaymentActivity(refreshing!, { receipt: undefined, mempool: false, journal: false })).toEqual(confirmed);
  });

  it("keeps a payment posted to Ethereum pending while its transaction is unsettled, and offers recovery once it is dropped", () => {
    const posted = { ...pending, state: "submission-unknown" as const, l1TxHash: `0x${"ab".repeat(32)}` };
    const [row] = pendingPaymentActivity([posted], []);
    expect(row?.status).toBe("pending");
    expect(observedPaymentActivity(row!, { receipt: null, mempool: false, journal: true }).status).toBe("pending");
    expect(observedPaymentActivity(row!, { receipt: null, mempool: false, journal: undefined }).status).toBe("pending");
    const dropped = observedPaymentActivity(row!, { receipt: null, mempool: false, journal: false });
    expect(dropped.status).toBe("unknown");
    expect(pendingPaymentActivity([posted], [dropped])[0]?.status).toBe("unknown");
  });

  it("shows newly admitted payments immediately without guessing uncertain submission succeeded", () => {
    expect(pendingPaymentActivity([pending], [])[0]?.status).toBe("pending");
    expect(pendingPaymentActivity([{ ...pending, state: "submission-unknown" }], [])[0]?.status).toBe("unknown");
  });

  it("keeps pending status on a failed mempool read, and accepts a receipt independently", () => {
    const payment = { ...pending, status: "pending" as const };
    expect(observedPaymentActivity(payment, { receipt: null, mempool: undefined, journal: undefined }).status).toBe("pending");
    expect(observedPaymentActivity(payment, { receipt: "0xreceipt", mempool: undefined, journal: undefined })).toMatchObject({
      status: "confirmed", receiptTxId: "0xreceipt",
    });
  });

  it("allows successful reads to reverse confirmation after a reorg", () => {
    expect(observedPaymentActivity(confirmed, { receipt: null, mempool: true, journal: false })).toEqual({ ...pending, status: "pending" });
    expect(observedPaymentActivity(confirmed, { receipt: null, mempool: false, journal: false })).toEqual({ ...pending, status: "unknown" });
    expect(observedPaymentActivity(confirmed, { receipt: null, mempool: undefined, journal: undefined })).toEqual({ ...pending, status: "unknown" });
  });

  it("removes pending status when the mempool successfully reports absence", () => {
    expect(observedPaymentActivity({ ...pending, status: "pending" }, { receipt: undefined, mempool: false, journal: false }).status).toBe("unknown");
  });

  it("does not resurrect persisted admission after observing mempool removal", () => {
    expect(pendingPaymentActivity([pending], [{ ...pending, status: "unknown" }])[0]?.status).toBe("unknown");
  });

  it("uses only current snapshot rows and never carries terminal history into pending", () => {
    expect(pendingPaymentActivity([], [confirmed])).toEqual([]);
    expect(pendingPaymentActivity([pending], [{ ...confirmed, status: "finalized" }])[0]).toEqual({ ...pending, status: "pending" });
  });
});
