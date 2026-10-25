import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_BROWSER_RELAY_BATCH_BYTES } from "@pcash/sdk/relay";
import { purchaseBatches } from "../src/client/purchaseBatches.ts";

test("packs claims into the fewest consecutive carriers with room for framing", () => {
  const claims = Array.from({ length: 8 }, (_, index) => ({ index, bytes: 35_000 }));
  const batches = purchaseBatches(claims, claim => claim.bytes);
  assert.deepEqual(batches.map(batch => batch.length), [3, 3, 2]);
  assert.deepEqual(batches.flat(), claims);
  for (const batch of batches) assert.ok(67n + batch.reduce((sum, claim) => sum + BigInt(claim.bytes) + 4n, 0n) <= MAX_BROWSER_RELAY_BATCH_BYTES);
});

test("includes the carrier header and length prefixes at the exact byte boundary", () => {
  const size = Number((MAX_BROWSER_RELAY_BATCH_BYTES - 67n - 8n) / 2n);
  const remainder = Number(MAX_BROWSER_RELAY_BATCH_BYTES - 67n - 8n) - size;
  assert.equal(purchaseBatches([size, remainder], bytes => bytes).length, 1);
  assert.equal(purchaseBatches([size, remainder + 1], bytes => bytes).length, 2);
  assert.deepEqual(purchaseBatches([], () => 0), []);
});
