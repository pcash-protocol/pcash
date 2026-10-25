import { describe, expect, it } from "vitest";
import { planNativeConsolidation } from "../../src/wallet/consolidation.ts";

describe("ordinary native-note consolidation planning", () => {
  it("requires no transaction when four inputs already cover a requested spend", () => {
    expect(planNativeConsolidation([10n, 10n, 10n, 10n, 10n], 1n, 39n).transactions).toBe(0);
  });
  it("plans a four-input merge for a fragmented spend without anticipated issuance", () => {
    const plan = planNativeConsolidation([10n, 10n, 10n, 10n, 10n], 1n, 49n);
    expect(plan).toMatchObject({ transactions: 1, estimatedFees: 1n, maximumSpendableAfter: 49n, remainingNotes: 2, canCover: true, issuanceNotePerTransaction: false });
  });
  it("counts the poster note a self-published merge pays this wallet as inventory, not funding", () => {
    const plan = planNativeConsolidation([10n, 10n, 10n, 10n, 10n], 1n, 49n, { issuanceNote: true });
    expect(plan).toMatchObject({ transactions: 1, maximumSpendableAfter: 49n, remainingNotes: 3, canCover: true, issuanceNotePerTransaction: true });
  });
  it("reports when merge fees make a spend impossible", () => {
    expect(planNativeConsolidation([10n, 10n, 10n, 10n, 10n], 1n, 50n)).toMatchObject({ canCover: false, transactions: 1 });
  });
  it("plans L inventory reductions with and without an issuance note per merge", () => {
    const inventory = Array(5000).fill(100n);
    expect(planNativeConsolidation(inventory, 0n, undefined, { shape: 1 }))
      .toMatchObject({ shape: 1, transactions: 162, canCover: true, batchBytesPerTransaction: 80269 });
    expect(planNativeConsolidation(inventory, 0n, undefined, { shape: 1, issuanceNote: true }))
      .toMatchObject({ transactions: 167, canCover: true });
  });
  it("splits overflowing consolidated amounts into ordinary bounded outputs", () => {
    const maximum = (1n << 128n) - 1n;
    expect(planNativeConsolidation(Array(32).fill(maximum / 16n), 0n, undefined, { shape: 1 }))
      .toMatchObject({ transactions: 1, remainingNotes: 2, canCover: true });
  });
  it("bounds a thousands-note inventory and never creates an oversized note", () => {
    expect(planNativeConsolidation(Array(5000).fill(1n), 0n)).toMatchObject({ transactions: 1666, remainingNotes: 2 });
    const plan = planNativeConsolidation(Array(5000).fill(1n), 0n, undefined, { issuanceNote: true });
    expect(plan).toMatchObject({ transactions: 2498, remainingNotes: 4, maximumSpendableAfter: 5000n, canCover: true });
    expect(planNativeConsolidation(Array(5).fill((1n << 128n) - 1n), 0n)).toMatchObject({ transactions: 0, canCover: false });
  });
});
