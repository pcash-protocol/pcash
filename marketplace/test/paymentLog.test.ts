import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, numberToHex, type Hex } from "viem";
import { PAYMENT_EVENT_SIG } from "../src/commitments.mts";
import { selectPaymentLog } from "../src/client/paymentLog.ts";

function topic(value: bigint): Hex {
  return numberToHex(value, { size: 32 });
}

function paymentLog(
  router: bigint,
  offerId: bigint,
  seller: bigint,
  amount: bigint,
  commitment: Hex,
) {
  return {
    address: numberToHex(router, { size: 20 }),
    topics: [PAYMENT_EVENT_SIG, topic(offerId), topic(seller), topic(0x999n)],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }, { type: "bytes" }],
      [amount, commitment, "0x0102"]),
  };
}

test("Payment selection binds every accepted event field and returns its local index", () => {
  const commitment = topic(0xabcn);
  const expected = {
    router: 0x123n,
    offerId: 0x456n,
    seller: 0x789n,
    amount: 10n,
    claimKeyCommitment: commitment,
  };
  const spoof = paymentLog(0xdeadn, expected.offerId, expected.seller, expected.amount, commitment);
  const real = paymentLog(expected.router, expected.offerId, expected.seller, expected.amount, commitment);
  assert.deepEqual(selectPaymentLog([spoof, real], PAYMENT_EVENT_SIG, expected), {
    log: real,
    logIndex: 1,
    payer: 0x999n,
  });
  const wrongEthPrice = paymentLog(expected.router, expected.offerId, expected.seller, 11n, commitment);
  assert.throws(() => selectPaymentLog([wrongEthPrice], PAYMENT_EVENT_SIG, expected), /found 0/);
});
