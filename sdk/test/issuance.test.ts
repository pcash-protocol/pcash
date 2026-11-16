import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { issuanceTerms, rewardEach } from "../src/protocol/issuance.ts";

interface IssuanceVector {
  name: string;
  qualifyingActions: number;
  parent: { issuedSoFar: string };
  quote: { internalOffer: string; blockAllowance: string; exhausted: boolean };
  result: { rewardEach: string };
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../vectors/issuance.json", import.meta.url)), "utf8"),
) as { supplyCap: string; vectors: IssuanceVector[] };

describe("rewardEach", () => {
  it.each(vectors.vectors.map((vector) => [vector.name, vector] as const))("matches the Rust transition for %s", (_name, vector) => {
    const terms = issuanceTerms({
      internalOffer: BigInt(vector.quote.internalOffer),
      blockAllowance: BigInt(vector.quote.blockAllowance),
      supplyCap: BigInt(vectors.supplyCap),
      issuedSoFar: BigInt(vector.parent.issuedSoFar),
      exhausted: vector.quote.exhausted,
    });
    expect(rewardEach(terms, BigInt(vector.qualifyingActions))).toBe(BigInt(vector.result.rewardEach));
  });

  it("is zero for no qualifying actions, an exhausted quote, or no quote", () => {
    const quote = { internalOffer: 100n, blockAllowance: 1_000n, supplyCap: 10_000n, issuedSoFar: 0n, exhausted: false };
    expect(rewardEach(issuanceTerms(quote), 0n)).toBe(0n);
    expect(rewardEach(issuanceTerms(quote), 1n)).toBe(100n);
    expect(rewardEach(issuanceTerms({ ...quote, exhausted: true }), 1n)).toBe(0n);
    expect(issuanceTerms(null)).toEqual({ internalOffer: 0n, blockAllowance: 0n, remaining: 0n });
    expect(rewardEach(issuanceTerms(null), 1n)).toBe(0n);
  });

  it("takes the smallest of the offer, the allowance share, and the remaining-supply share", () => {
    const terms = { internalOffer: 100n, blockAllowance: 1_000n, remaining: 10n ** 9n };
    expect([1n, 10n, 11n, 12n].map((count) => rewardEach(terms, count))).toEqual([100n, 100n, 90n, 83n]);
    expect(rewardEach({ ...terms, remaining: 250n }, 3n)).toBe(83n);
    expect(rewardEach({ ...terms, remaining: 250n }, 4n)).toBe(62n);
  });
});
