import { describe, expect, it } from "vitest";
import { marketplaceSellerWalletSettleOptions } from "../src/scenarios/marketplace.ts";

describe("Marketplace Explorer seed wallet settlement", () => {
  it("performs one accepted-receipt reconciliation and never polls for finality", () => {
    expect(marketplaceSellerWalletSettleOptions({
      deferFundingInventory: true,
      pollIntervalMs: 1_000,
    })).toEqual({
      settlePollIntervalMs: 100,
      settlePollMaxAttempts: 1,
    });
  });

  it("leaves the ordinary acceptance flow settlement policy unchanged", () => {
    expect(marketplaceSellerWalletSettleOptions({})).toEqual({});
  });
});
