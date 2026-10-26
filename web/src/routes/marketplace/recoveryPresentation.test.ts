import { describe, expect, it } from "vitest";
import { publicationIdentity, purchaseCutoff, type MarketplaceActivityItem, type OfferPublication } from "@pcash/marketplace/app";
import {
  marketplaceActivityAction,
  marketplaceActivityStatus,
  marketplaceActionLabel,
  marketplaceNeedsYou,
} from "./recoveryPresentation.ts";

describe("Marketplace recovery presentation", () => {
  it("names submitted trades waiting on the network Pending, never checking or confirming", () => {
    const item = (role: string, phase: string) => ({ role, phase, status: "pending", publication: {} }) as MarketplaceActivityItem;
    expect(marketplaceActivityStatus(item("seller", "funding-submitted"), "checking")).toBe("Pending");
    expect(marketplaceActivityStatus(item("seller", "funding-submitted"), "unavailable")).toBe("Pending");
    expect(marketplaceActivityStatus(item("buyer", "payment-pending"))).toBe("Pending");
    expect(marketplaceActivityStatus(item("buyer", "claim-accepted"))).toBe("Pending");
    expect(marketplaceActivityStatus(item("seller", "reclaim-prepared"), "confirmed")).toBe("Pending");
    expect(marketplaceActivityStatus(item("seller", "reclaim-accepted"))).toBe("Pending");
    expect(marketplaceActivityStatus(item("seller", "funding-submitted"), "mempool")).toBe("Not posted yet");
    expect(marketplaceActivityStatus(item("seller", "funding-submitted"), "ethereum")).toBe("Posted, waiting for inclusion");
  });

  it("waits for a restored escrow to reappear without funding it again", () => {
    const item = { role: "seller", phase: "recovery-unavailable", status: "pending" } as MarketplaceActivityItem;
    expect(marketplaceActivityAction(item)).toBe("refresh");
    expect(marketplaceNeedsYou(item, new Map())).toBe(false);
  });
  it("checks an ambiguous payment instead of offering another payment", () => {
    const item = {
      role: "buyer",
      phase: "payment-ambiguous",
      status: "action-required",
    } as MarketplaceActivityItem;
    const action = marketplaceActivityAction(item);
    expect(action).toBe("check-payment");
    expect(marketplaceActionLabel(item, action!)).toBe("Continue");
  });

  it("names a funded catalog failure as an explicit catalog retry", () => {
    const item = {
      role: "seller",
      phase: "publication-failed",
      status: "action-required",
    } as MarketplaceActivityItem;
    expect(marketplaceActionLabel(item, "resume-publication")).toBe("Continue");
  });

  it("reclaims a funded catalog failure once reclaim opens", () => {
    const item = {
      role: "seller",
      phase: "publication-failed",
      status: "action-required",
      publication: {
        terms: { deadlineT: "100" },
        escrow: { amount: "0x1", leafIndex: 1, noteSecret: "0x2" },
      },
    } as unknown as MarketplaceActivityItem;
    expect(marketplaceActivityAction(item, 100n)).toBe("resume-publication");
    expect(marketplaceActivityAction(item, 101n)).toBe("reclaim");
    const unfundedPublication = { ...item.publication };
    delete unfundedPublication.escrow;
    expect(marketplaceActivityAction({
      ...item,
      publication: unfundedPublication,
    }, 101n)).toBe("resume-publication");
  });

  it("counts a saved trade as waiting on its owner until it is done or moving on its own", () => {
    const open = { terms: { id: "1", deadlineT: String(2n ** 40n) }, escrow: { amount: "0x1", leafIndex: 1, noteSecret: "0x2" } };
    const item = (fields: Partial<MarketplaceActivityItem>) => ({ role: "seller", publication: open, ...fields }) as MarketplaceActivityItem;
    const none = new Map();
    for (const phase of ["draft", "funding-submitted", "finalizing", "publication-failed", "reclaim-prepared", "reclaim-failed"] as const)
      expect(marketplaceNeedsYou(item({ phase, status: "pending" }), none), phase).toBe(true);
    for (const phase of ["selected", "payment-pending", "payment-ambiguous", "paid"] as const)
      expect(marketplaceNeedsYou(item({ role: "buyer", phase, status: "pending" }), none), phase).toBe(true);
    expect(marketplaceNeedsYou(item({ phase: "funded", status: "ready" }), none)).toBe(false);
    expect(marketplaceNeedsYou(item({ phase: "reclaim-accepted", status: "pending" }), none)).toBe(false);
    expect(marketplaceNeedsYou(item({ phase: "reclaimed", status: "complete" }), none)).toBe(false);
    expect(marketplaceNeedsYou(item({ role: "buyer", phase: "claim-accepted", status: "pending" }), none)).toBe(false);
    expect(marketplaceNeedsYou(item({ role: "buyer", phase: "claimed", status: "complete" }), none)).toBe(false);
  });

  it("asks to reclaim a listing past its reclaim time unless a buyer took it", () => {
    const expired = { terms: { id: "1", deadlineT: "100" }, escrow: { amount: "0x1", leafIndex: 1, noteSecret: "0x2" } };
    const item = { role: "seller", phase: "funded", status: "ready", publication: expired } as unknown as MarketplaceActivityItem;
    const sold = new Map([[publicationIdentity(expired as unknown as OfferPublication), {}]]);
    // Reclaim opens only after T.
    expect(marketplaceNeedsYou(item, new Map(), 100n)).toBe(false);
    // Until a sale is known, the listing is the seller's to reclaim.
    expect(marketplaceNeedsYou(item, new Map(), 101n)).toBe(true);
    expect(marketplaceNeedsYou(item, sold, 101n)).toBe(false);
    // A reclaim the seller started is theirs to finish.
    expect(marketplaceNeedsYou({ ...item, phase: "reclaim-prepared" }, sold, 101n)).toBe(true);
  });

  it("resumes a purchase without a sent payment only while buying is open", () => {
    const deadlineT = 1_000_000n;
    const cutoff = purchaseCutoff(deadlineT);
    const item = { role: "buyer", phase: "selected", status: "action-required", publication: { terms: { id: "1", deadlineT: String(deadlineT) } } } as unknown as MarketplaceActivityItem;
    expect(marketplaceActivityAction(item, cutoff - 1n)).toBe("resume-purchase");
    expect(marketplaceActivityAction(item, cutoff)).toBeUndefined();
    // A buyer who paid keeps claiming through the claim-only period.
    for (const phase of ["payment-pending", "paid"] as const)
      expect(marketplaceActivityAction({ ...item, phase }, deadlineT - 1n), phase).toBe("resume-purchase");
    // Paid with no accepted claim: continuing checks the carried claim and retries it if it failed.
    expect(marketplaceActivityStatus({ ...item, phase: "paid" })).toBe("Needs claim");
  });
});
