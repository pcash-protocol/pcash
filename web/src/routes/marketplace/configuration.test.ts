import { describe, expect, it } from "vitest";
import { resolveMarketplaceRouterConfiguration } from "./configuration.ts";

const ADDRESS = `0x${"12".repeat(20)}`;

describe("Marketplace router configuration", () => {
  it("requires a router address", () => {
    expect(resolveMarketplaceRouterConfiguration({})).toEqual({
      error: "Marketplace payments are read-only until the router address is configured.",
    });
  });

  it("accepts the router address alone", () => {
    expect(resolveMarketplaceRouterConfiguration({
      VITE_PAYMENT_ROUTER_ADDRESS: ADDRESS,
    })).toEqual({
      configuration: { address: ADDRESS },
    });
  });

  it("rejects an invalid address", () => {
    expect(resolveMarketplaceRouterConfiguration({
      VITE_PAYMENT_ROUTER_ADDRESS: "0x1234",
    }).configuration).toBeUndefined();
  });
});
