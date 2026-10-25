import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertMarketplaceNetworkFee, marketplaceNetAmount } from "../src/client/networkFee.ts";

describe("marketplace open or private network fees", () => {
  it("keeps a positive net transfer amount", () => {
    assert.doesNotThrow(() => assertMarketplaceNetworkFee(100n, 0n));
    assert.equal(marketplaceNetAmount(100n, 99n), 1n);
    assert.throws(() => marketplaceNetAmount(100n, -1n), /must be nonnegative/);
    assert.throws(() => marketplaceNetAmount(100n, 100n), /must be less than transfer amount/);
  });
});
