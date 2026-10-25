import { describe, expect, it } from "vitest";
import { onboardingDestination, onWalletSurface } from "./walletSurface.ts";

describe("wallet surface network switching", () => {
  it("recognizes sidebar intents and application journeys", () => {
    for (const path of ["/marketplace", "/get", "/tokens", "/tokens/new", `/token/0x${"0a".repeat(32)}`, "/claim", `/drop/0x${"ab".repeat(20)}`]) expect(onWalletSurface(path)).toBe(true);
    for (const hash of ["#wallet", "#ethereum-submission", "#send"]) expect(onWalletSurface("/get", hash)).toBe(true);
  });
  it("does not prompt while browsing identities or public content", () => {
    for (const path of [`/0x${"ab".repeat(20)}`, "/alice.eth", "/docs", "/explorer", "/"]) {
      expect(onWalletSurface(path)).toBe(false);
    }
  });
});

describe("onboarding destination", () => {
  it.each(["#send", "#ethereum-submission"])("preserves %s and query parameters on the current page", (hash) => {
    expect(onboardingDestination({ pathname: "/get", search: "?to=alice.eth&amount=10", hash }))
      .toBe(`/get?to=alice.eth&amount=10${hash}`);
  });
  it.each(["/", "/alice.eth", "/marketplace"])("opens setup in the sidebar on %s", (pathname) => {
    expect(onboardingDestination({ pathname, search: "?unit=pcash", hash: "#details" })).toBe(`${pathname}?unit=pcash#wallet`);
  });
});
