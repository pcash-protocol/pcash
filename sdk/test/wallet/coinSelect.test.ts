import { describe, expect, it } from "vitest";
import { maxSpendable, selectNotes } from "../../src/wallet/coinSelect.ts";

const notes = (...amounts: bigint[]) => amounts.map((amount, i) => ({ amount, id: i }));
const totalOf = (sel: { amount: bigint }[]) => sel.reduce((s, n) => s + n.amount, 0n);

describe("selectNotes", () => {
  it("picks a single note when one covers with least overage", () => {
    const r = selectNotes(notes(100n, 50n, 30n), 40n);
    expect(r).not.toBeNull();
    expect(r!.selected.map((n) => n.amount)).toEqual([50n]);
    expect(r!.total).toBe(50n);
  });

  it("prefers the tightest single note over a larger one", () => {
    const r = selectNotes(notes(1000n, 60n, 55n), 52n);
    expect(r!.selected.map((n) => n.amount)).toEqual([55n]);
  });

  it("combines notes when no single note covers the target", () => {
    const r = selectNotes(notes(30n, 30n, 30n), 70n);
    expect(r).not.toBeNull();
    expect(r!.selected).toHaveLength(3);
    expect(r!.total).toBe(90n);
  });

  it("spends at most four inputs", () => {
    const r = selectNotes(notes(10n, 10n, 10n, 10n, 10n), 45n);
    // Best 4 sum to 40 < 45 → infeasible in one transfer.
    expect(r).toBeNull();
  });

  it("covers exactly at the four-note ceiling", () => {
    const r = selectNotes(notes(10n, 10n, 10n, 10n, 10n), 40n);
    expect(r).not.toBeNull();
    expect(r!.selected).toHaveLength(4);
    expect(r!.total).toBe(40n);
  });

  it("minimizes overage across combinations", () => {
    // Covering 100 from {90,20,15,80}: {20,80} gives exactly 100 (zero overage).
    const r = selectNotes(notes(90n, 20n, 15n, 80n), 100n);
    expect(totalOf(r!.selected)).toBe(100n);
  });

  it("consolidates small notes on a tie (equal overage, more notes wins)", () => {
    // Target 40. {40} and {30,10} both overage 0; the multi-note set is preferred.
    const r = selectNotes(notes(40n, 30n, 10n), 40n);
    expect(r!.total).toBe(40n);
    expect(r!.selected.length).toBeGreaterThan(1);
  });

  it("returns null when the whole balance can't cover", () => {
    expect(selectNotes(notes(5n, 5n), 20n)).toBeNull();
    expect(selectNotes([], 1n)).toBeNull();
  });

  it("covers large shapes without exponential subset search", () => {
    const inventory = Array.from({ length: 5000 }, (_, id) => ({ id, amount: 1n }));
    for (const count of [5, 16, 31, 32, 64]) {
      const result = selectNotes(inventory, BigInt(count), count)!;
      expect(result.total).toBe(BigInt(count));
      expect(result.selected).toHaveLength(count);
      expect(new Set(result.selected.map(note => note.id)).size).toBe(count);
    }
    expect(selectNotes(inventory, 33n, 32)).toBeNull();
  });

  it("selects nothing for a zero need, whatever the inventory holds", () => {
    for (const inventory of [notes(10n, 5n), notes(), notes(1n)]) {
      const result = selectNotes(inventory, 0n);
      expect(result).toEqual({ selected: [], total: 0n });
    }
  });

  it("rejects a negative need and an unusable capacity", () => {
    expect(() => selectNotes(notes(10n), -1n)).toThrow(/nonnegative/);
    expect(() => selectNotes(notes(10n), 0n, 0)).toThrow(/maxInputs/);
  });

  it("stays correct with a large inventory beyond the search cap", () => {
    // 200 dust notes of 1 plus one big note; a 4-input spend can't reach 5 from
    // dust (max 4), so it must use the big note.
    const inv = [...Array(200)].map((_, i) => ({ amount: 1n, id: i })).concat({ amount: 500n, id: 999 });
    const r = selectNotes(inv, 5n);
    expect(r).not.toBeNull();
    expect(totalOf(r!.selected)).toBeGreaterThanOrEqual(5n);
    expect(r!.selected.length).toBeLessThanOrEqual(4);
  });
});

describe("maxSpendable", () => {
  it("sums the largest four notes", () => {
    expect(maxSpendable(notes(10n, 20n, 30n, 40n, 50n))).toBe(140n);
  });
  it("handles fewer than four notes", () => {
    expect(maxSpendable(notes(7n, 3n))).toBe(10n);
    expect(maxSpendable([])).toBe(0n);
  });
});
