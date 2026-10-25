// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockEconomicsRecordResult, IssuanceQuoteResult } from "@pcash/sdk/clients";
import type { OfferPublication } from "@pcash/marketplace/app";
import { IssuanceOverview } from "./IssuanceOverview.tsx";
import { RewardNow, rewardTrend, splitLines } from "./RewardNow.tsx";
import { blockSplit, rewardPosition, type IssuanceHistory } from "./issuanceOverviewModel.ts";
import { bestPcashListing } from "./useBestListing.ts";
import { compactNumber, formatRatio } from "./chartParts.tsx";
import { IssuanceFormulas } from "./IssuanceFormulas.tsx";
import { renderDocument } from "../docs/longDocument.ts";
import { documentPath, publicDocuments } from "../docs/publicDocuments.ts";
import { documentSource } from "../docs/sources.ts";

/** Whether a link to a section of a published document names a heading that document has. */
function documentSectionExists(href: string): boolean {
  const [path, fragment] = href.split("#");
  const document = publicDocuments.find(({ file }) => documentPath(file) === path);
  return document !== undefined && renderDocument(documentSource(document.file), (link) => link).headings.some(({ id }) => id === fragment);
}

const unit = 10n ** 18n;
const baseline = 800n * unit;
const Q = 1n << 128n;
const day = 86_400n;
const now = 2_000_000n;

const quote = {
  parent: { blockNumber: 1_000n, blockHash: "0x01", timestamp: now }, candidateTimestamp: now + 12n, supplyCap: 1_000_000_000n * unit, issuedSoFar: 1_229n * unit,
  baseline, internalOffer: baseline / 16n, blockAllowance: baseline * 3n, maxSingleActionReward: baseline / 16n,
  multiplierQ: Q / 16n, lagQ: -8n * day * Q, exhausted: false, rewardPossible: true,
} as IssuanceQuoteResult;

function history(): IssuanceHistory {
  const rewards: BlockEconomicsRecordResult[] = Array.from({ length: 48 }, (_, index) => {
    const time = now - BigInt(47 - index) * 3_600n;
    return {
      firstBlock: BigInt(index * 300), lastBlock: BigInt(index * 300 + 299), firstTimestamp: time - 3_588n, lastTimestamp: time, blocks: 300n,
      qualifyingActions: index % 6 === 0 ? 2n : 0n, issuanceTotal: index % 6 === 0 ? baseline / 16n : 0n, openFeesTotal: 0n, rewardEach: 0n,
      baseline, internalOffer: baseline / 32n + baseline * BigInt(index) / 1_600n, blockAllowance: baseline * 3n, lagQ: 0n,
    };
  });
  return { supply: rewards, day: { qualifyingActions: 8n, issuanceTotal: baseline / 4n }, week: { qualifyingActions: 16n, issuanceTotal: baseline / 2n }, recentBlocks: new Map([[2, 1]]), asOf: now };
}

let root: Root, element: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); element = document.createElement("div"); root = createRoot(element); });
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

describe("reward now", () => {
  it("places the reward on its range and says where it is heading", async () => {
    await act(async () => root.render(<RewardNow quote={quote} history={history()} />));
    expect(element.textContent).toContain("50 PCASH");
    expect(element.textContent).toContain("6.3% of the target rate");
    expect(element.textContent).toContain("Rising 41% a day at the current pace; it reaches its maximum of 2,400 PCASH per mine in about 11 days");
    const meter = element.querySelector("[role=meter]")!;
    expect(meter.getAttribute("aria-valuenow")).toBe(String(1 / 16));
    expect(meter.getAttribute("aria-valuemax")).toBe("3");
    expect([...meter.querySelectorAll("span")].map(span => span.textContent).filter(Boolean)).toEqual(["50", "0", "Target 800", "Block maximum 2,400"]);
    expect(meter.getAttribute("aria-valuetext")).toBe("50 PCASH per mine; the target is 800 PCASH and the block maximum 2,400 PCASH");
    expect(element.textContent).toContain("Up to 48 mines per block each get the full 50 PCASH; with more, they share the block maximum equally.");
    expect(element.textContent).toContain("Recently about 2 per block, so about 50 PCASH each.");
    expect(element.textContent).not.toContain("share at most the maximum");
  });
  it("says how a block's maximum is shared, by the quote's offer and recent crowding", () => {
    expect(splitLines(blockSplit({ internalOffer: 500n * unit, blockAllowance: 1_500n * unit, maxSingleActionReward: 500n * unit }, new Map([[5, 10]])))).toEqual([
      "Up to 3 mines per block each get the full 500 PCASH; with more, they share the block maximum equally.",
      "Recently about 5 per block, so about 300 PCASH each.",
    ]);
    expect(splitLines(blockSplit({ internalOffer: 1_600n * unit, blockAllowance: 1_500n * unit, maxSingleActionReward: 1_500n * unit }))).toEqual([
      "Every block pays its maximum, split among everyone mining in it.",
    ]);
    expect(splitLines(blockSplit({ internalOffer: 1_000n * unit, blockAllowance: 1_500n * unit, maxSingleActionReward: 1_000n * unit }))[0]).toBe("Every block pays its maximum, split among everyone mining in it.");
    expect(splitLines(blockSplit({ internalOffer: 0n, blockAllowance: 1_500n * unit, maxSingleActionReward: 0n }))).toEqual([]);
  });
  it("says which way the reward moves and where it settles", () => {
    const launch = rewardPosition(quote)!;
    expect(rewardTrend(launch, new Map())).toBe("Rising 41% a day while nobody mines; it reaches its maximum of 2,400 PCASH per mine in about 11 days");
    const onTarget = rewardPosition({ ...quote, lagQ: 0n, maxSingleActionReward: baseline })!;
    expect(rewardTrend(onTarget, new Map([[1, 7_200]]))).toBe("Steady: issuance is keeping pace with the target");
    expect(rewardTrend(onTarget, new Map([[2, 7_200]]))).toBe("Falling 29% a day at the current pace, leveling off near 400 PCASH per mine");
    const capped = rewardPosition({ ...quote, lagQ: 5n * day * Q, maxSingleActionReward: baseline * 3n })!;
    expect(rewardTrend(capped, new Map())).toBe("At its maximum of 2,400 PCASH per mine");
  });
  it("rises when batched mines fill each block's allowance, and falls when the same mines are spread across blocks", () => {
    const doubled = rewardPosition({ ...quote, lagQ: 2n * day * Q, maxSingleActionReward: baseline * 2n })!;
    expect(rewardTrend(doubled, new Map([[3, 1_800]]))).toBe("Rising 9% a day at the current pace; it reaches its maximum of 2,400 PCASH per mine in about 4.7 days");
    expect(rewardTrend(doubled, new Map([[1, 5_400]]))).toBe("Falling 16% a day at the current pace, leveling off near 1,067 PCASH per mine");
  });
});

describe("issuance overview", () => {
  it("renders the pace, the falling target rate and the rising supply curve with data tables", async () => {
    await act(async () => root.render(<MemoryRouter><IssuanceOverview quote={quote} history={history()} /></MemoryRouter>));
    expect(element.textContent).toContain("Issuance against the target");
    expect(element.textContent).toContain("5.76M PCASH a day");
    expect(element.textContent).toContain("New PCASH per day");
    expect(element.textContent).toContain("The target rate starts at 5.48M PCASH a day");
    expect(element.textContent).toContain("Ahead of the target by 1.23K PCASH: the target reached today's supply 8 days from now.");
    expect(element.textContent).toContain("one year after the schedule starts");
    const svg = element.querySelector("svg[role=img]")!;
    await act(async () => { (svg as SVGSVGElement).dispatchEvent(new FocusEvent("focus")); });
    expect(element.querySelectorAll("tbody tr").length).toBeGreaterThan(0);
    expect(element.textContent).not.toContain("Through");
    const learn = [...element.querySelectorAll("a")].find((link) => link.textContent!.startsWith("How PCASH issuance works"))!.getAttribute("href")!;
    expect(learn).toBe("/docs/whitepaper#how-issuance-keeps-pace");
    expect(documentSectionExists(learn)).toBe(true);
  });
});

describe("issuance formulas", () => {
  it("states the block quote and settlement symbolically and links to the specification", async () => {
    await act(async () => root.render(<MemoryRouter><IssuanceFormulas /></MemoryRouter>));
    const formulas = new Map([...element.querySelectorAll("dt")].map(term => [term.textContent, term.nextElementSibling!.textContent]));
    expect(formulas.get("baseline")).toBe("= 2 × S × τ × √(1 − I / S) / T");
    expect(formulas.get("offer")).toBe("= baseline × multiplier");
    expect(formulas.get("rewardEach")).toBe("= min(⌊offer⌋, ⌊allowance / n⌋, ⌊(S − I) / n⌋)");
    expect(formulas.get("offerLag")).toBe("= min(L, lag + elapsed)");
    expect(element.textContent).toContain("Bitcoin Cash’s ASERT");
    expect(element.textContent).toContain("atomic units (10−18 PCASH) and times in seconds");
    expect(element.textContent).toContain("I stays at S, and nextLag = lag, with no elapsed time added");
    expect(element.textContent).not.toContain("every value is zero");
    expect(element.textContent).not.toMatch(/\d+ days?\b/);
    const specification = element.querySelector("a")!.getAttribute("href")!;
    expect(specification).toBe("/docs/protocol-spec#14-native-issuance-and-block-settlement");
    expect(documentSectionExists(specification)).toBe(true);
  });
});

describe("marketplace comparison", () => {
  const offer = (amount: bigint, price: bigint, assetId = 0n) => ({ terms: { amount: String(amount), ethPriceWei: String(price), assetId: String(assetId) } }) as unknown as OfferPublication;
  it("finds the cheapest open PCASH listing per unit and ignores token listings", () => {
    const best = bestPcashListing([offer(1_000n * unit, 10n ** 16n), offer(500n * unit, 10n ** 15n), offer(100n * unit, 1n, 7n)]);
    expect(best).toEqual({ weiPerThousand: 2n * 10n ** 15n, approximate: false });
    expect(bestPcashListing([])).toBeUndefined();
  });
});

it("labels chart values in whole numbers, compact above 1,000", () => {
  expect([compactNumber(0), compactNumber(0.4), compactNumber(12.34), compactNumber(1_234.5), compactNumber(5_480_000)]).toEqual(["0", "<1", "12", "1.23K", "5.48M"]);
});

it("formats multiples of the reference rate", () => {
  expect([formatRatio(1 / 16), formatRatio(0.3), formatRatio(1), formatRatio(3)]).toEqual(["1/16×", "0.3×", "1×", "3×"]);
});
