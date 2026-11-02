import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readJourneyIssuanceQuote } from "./marketplace_issuance.mjs";

describe("marketplace journey issuance quote", () => {
  it("retries from a fresh head when auto-relay advances before the quote", async () => {
    const quote = { issuedSoFar: 1n };
    const candidates = [];
    let head = 1_000n;
    const node = {
      status: async () => ({ latestBlockTimestamp: head }),
      getIssuanceQuote: async (candidate) => {
        candidates.push(candidate);
        if (candidates.length === 1) head = 1_030n;
        if (candidate < head) throw new Error(`candidateTimestamp ${candidate} is before ${head}`);
        return quote;
      },
    };

    assert.equal(await readJourneyIssuanceQuote(node), quote);
    assert.deepEqual(candidates, [1_012n, 1_042n]);
  });
});
