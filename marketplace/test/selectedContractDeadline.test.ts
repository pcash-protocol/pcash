import assert from "node:assert/strict";
import test from "node:test";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import type { SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
import type { Wallet } from "@pcash/sdk/wallet";
import { runNoteFundedTransferFlow } from "../src/client/noteFundedTransfer.ts";
import { offerFundingValidUntil } from "../src/client/publishOffer.ts";

const now = 1_800_000_000n;
const offerDeadline = now + 3n * 86_400n;
const contract = { body: new Uint8Array(), address: 1n };
const node = {} as PcashNodeClient;
const selectedRelayQuote = {} as SelectedRelayQuoteProvider;

test("selected contract creation passes the offer deadline as a ceiling to the wallet", async () => {
  let received: Parameters<Wallet["send"]>[0] | undefined;
  const wallet = {
    send: async (intent: Parameters<Wallet["send"]>[0]) => {
      received = intent;
      return { contentHash: `0x${"11".repeat(32)}`, transactionHex: "0x", queued: true, recipient: "0x1", amount: 10n,
        settled: false, changeAmount: 0n };
    },
  } as Wallet;
  const result = await runNoteFundedTransferFlow({
    wallet, node, to: "0x0000000000000000000000000000000000000001", amount: 10n, accountCreation: { kind: "contract", body: contract.body }, openFeeAmount: 0n, privateRelayFeeAmount: 250n,
    selectedRelayQuote, validUntilTimestamp: offerFundingValidUntil(offerDeadline),
  });
  assert.equal(received?.validUntilTimestamp, offerFundingValidUntil(offerDeadline));
  assert.equal(received?.validUntilMode, "ceiling");
  assert.equal(received?.selectedRelayQuote, selectedRelayQuote);
  assert.equal(received?.privateRelayFeeAmount, 250n);
  assert.equal(result.queued, true);
});
