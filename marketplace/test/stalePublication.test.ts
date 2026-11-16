import assert from "node:assert/strict";
import test from "node:test";
import { resetPublishCheckpoint, type StoredOffer } from "../src/client/offerPersistence.ts";
import type { OfferPublication } from "../src/client/publication.ts";

const hash = `0x${"11".repeat(32)}`;
const offer = (): StoredOffer => ({ key: "listing", pub: {} as OfferPublication, source: "created", savedAt: 1,
  publish: { phase: "funding-submitted", fundingContentHash: hash, fundingTransactionHex: "0x1234",
    fundingAcceptedBlock: "8", fundingAcceptedBlockHash: "0x88", fundingOpenFeeBaseUnits: "1", updatedAt: 1 } });

test("wallet-approved rebuilding clears the application checkpoint and preserves reviewed terms", () => {
  const current = offer();
  const reset = resetPublishCheckpoint(current, hash, 9);
  assert.deepEqual(reset.publish, { phase: "draft", fundingOpenFeeBaseUnits: "1", updatedAt: 9 });
  assert.equal(reset.pub, current.pub);
  assert.equal(current.publish?.fundingContentHash, hash);
});

test("another tab's replacement checkpoint cannot be cleared", () => {
  const current = offer();
  current.publish!.fundingContentHash = `0x${"22".repeat(32)}`;
  assert.throws(() => resetPublishCheckpoint(current, hash, 9), /saved listing changed/);
  assert.equal(current.publish!.fundingContentHash, `0x${"22".repeat(32)}`);
});

test("a removed or finalized checkpoint cannot be reset", () => {
  assert.throws(() => resetPublishCheckpoint(null, hash, 9), /saved listing changed/);
  const current = offer(); current.publish!.fundingFinalizedAt = 8;
  assert.throws(() => resetPublishCheckpoint(current, hash, 9), /saved listing changed/);
  assert.equal(current.publish!.fundingFinalizedAt, 8);
});
