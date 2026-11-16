import { describe, expect, it } from "vitest";
import { acquisitionCostPerThousand, batchIssuance, MAX_MINE_ACTIONS } from "./getEstimate.ts";
import { MAX_BROWSER_RELAY_BATCH_BYTES } from "@pcash/sdk/relay";
import { PADDED_PRIVATE_VALUE_BYTE_SIZE } from "@pcash/sdk/wallet/actions";

describe("Get PCASH acquisition estimates", () => {
  it("fits three padded mines but not four in the browser calldata batch", () => {
    expect(MAX_MINE_ACTIONS).toBe(3);
    expect(3n * PADDED_PRIVATE_VALUE_BYTE_SIZE + 79n).toBeLessThanOrEqual(MAX_BROWSER_RELAY_BATCH_BYTES);
    expect(4n * PADDED_PRIVATE_VALUE_BYTE_SIZE + 83n).toBeGreaterThan(MAX_BROWSER_RELAY_BATCH_BYTES);
  });
  it("prices a thousand PCASH without floating-point conversion", () => {
    expect(acquisitionCostPerThousand(2_000_000_000_000_000n, 100n * 10n ** 18n)).toBe(20_000_000_000_000_000n);
    expect(acquisitionCostPerThousand(0n, 10n ** 18n)).toBe(0n);
    expect(acquisitionCostPerThousand(2n, 0n)).toBeUndefined();
  });
  it("never estimates more per mine than a block as crowded as recent ones pays", () => {
    const terms = { internalOffer: 500n, blockAllowance: 1_500n, remaining: 1_000_000n };
    // Alone, one mine gets the offer; two mines and an own payment still fit under the block maximum.
    expect(batchIssuance(terms, { qualifying: 1n, collectible: 1n }, 0n)).toBe(500n);
    expect(batchIssuance(terms, { qualifying: 3n, collectible: 3n }, 0n)).toBe(1_500n);
    // Recent blocks held about 5: each of this batch's actions gets 1,500 / 5.
    expect(batchIssuance(terms, { qualifying: 1n, collectible: 1n }, 5n)).toBe(300n);
    // A batch larger than recent blocks splits among its own actions.
    expect(batchIssuance(terms, { qualifying: 6n, collectible: 2n }, 5n)).toBe(500n);
  });
});
