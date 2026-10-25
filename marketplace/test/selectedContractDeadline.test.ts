import assert from "node:assert/strict";
import test from "node:test";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import type { SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
import type { Wallet } from "@pcash/sdk/wallet";
import { runSponsoredContractCreationFlow } from "../src/client/contractCreation.ts";
import { offerFundingValidUntil } from "../src/client/publishOffer.ts";

const now = 1_800_000_000n;
const offerDeadline = now + 3n * 86_400n;
const contract = { body: new Uint8Array(), address: 1n };
const node = {} as PcashNodeClient;
const selectedRelayQuote = {} as SelectedRelayQuoteProvider;

test("selected contract creation passes the offer deadline as a ceiling to the wallet", async () => {
  let received: Parameters<Wallet["sponsorContractCreation"]>[0] | undefined;
  const wallet = {
    sponsorContractCreation: async (intent: Parameters<Wallet["sponsorContractCreation"]>[0]) => {
      received = intent;
      return { contentHash: `0x${"11".repeat(32)}`, transactionHex: "0x", queued: true,
        settled: false, changeAmount: 0n };
    },
  } as Wallet;
  const result = await runSponsoredContractCreationFlow({
    wallet, node, contract, openFeeAmount: 0n, privateRelayFeeAmount: 250n,
    selectedRelayQuote, validUntilTimestamp: offerFundingValidUntil(offerDeadline),
    validUntilMode: "ceiling",
  });
  assert.equal(received?.validUntilTimestamp, offerFundingValidUntil(offerDeadline));
  assert.equal(received?.validUntilMode, "ceiling");
  assert.equal(received?.selectedRelayQuote, selectedRelayQuote);
  assert.equal(received?.privateRelayFeeAmount, 250n);
  assert.equal(result.queued, true);
});
