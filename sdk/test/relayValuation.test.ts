import { describe, expect, it, vi } from "vitest";
import type { BlockEconomicsQuery, MempoolItemResult } from "../src/clients/index.ts";
import type { IssuanceTerms } from "../src/protocol/issuance.ts";
import {
  batchExpectedIssuance,
  discountIssuance,
  DEFAULT_ISSUANCE_WINDOW_BLOCKS,
  estimateOtherQualifyingActions,
  nextBlockIssuanceQuote,
  recentBlockEconomics,
  relayTransactionGain,
  relayIssuance,
  selectRelayCandidates,
  type RelaySelectionPolicy,
  type RelayValuation,
} from "../src/relay/valuation.ts";

const TERMS: IssuanceTerms = { internalOffer: 100n, blockAllowance: 1_000n, remaining: 10n ** 9n };
const ZERO_TERMS: IssuanceTerms = { internalOffer: 0n, blockAllowance: 0n, remaining: 0n };
const CONTROLLED = `0x${"0c".repeat(32)}`;
const ELSEWHERE = `0x${"0e".repeat(32)}`;
const OPEN = `0x${"00".repeat(32)}`;

function valuation(overrides: Partial<RelayValuation> = {}): RelayValuation {
  return {
    terms: TERMS,
    otherQualifyingActions: 0n,
    selfMinedActions: 0n,
    issuanceHaircutBps: 0,
    controlled: new Set([BigInt(CONTROLLED)]),
    ...overrides,
  };
}

function policy(overrides: Partial<RelaySelectionPolicy> = {}): RelaySelectionPolicy {
  return {
    maxBatchBytes: 1_000_000n,
    maxTransactions: 64,
    minValuePerByte: 0n,
    sponsorUnpaid: false,
    nowUnixMs: 1_000_000n,
    ...overrides,
  };
}

function entry(id: number, overrides: Partial<MempoolItemResult> = {}): MempoolItemResult {
  const hash = `0x${id.toString(16).padStart(64, "0")}`;
  return {
    contentHash: hash,
    statementId: hash,
    stableId: hash,
    conflictKeys: [],
    kind: "privateValue",
    fundingMode: null,
    byteSize: 100n,
    openFeeAmount: 0n,
    issuanceOwnerCommitment: OPEN,
    issuanceRoute: "open",
    validUntil: null,
    status: "ready",
    conflictCount: 0n,
    receivedAtUnixMs: 1_000_000n - BigInt(id),
    headCheckedBlock: 1n,
    headCheckedBlockHash: `0x${"aa".repeat(32)}`,
    recentPcashBlockHash: null,
    publicRecords: [],
    rawTransaction: null,
    ...overrides,
  };
}

const designatedTo = (commitment: string): Partial<MempoolItemResult> => ({ issuanceOwnerCommitment: commitment, issuanceRoute: "designated" });
const accountOperation: Partial<MempoolItemResult> = { kind: "userAccountUpdate" };
const ids = (items: readonly MempoolItemResult[]) => items.map((item) => Number(BigInt(item.contentHash)));

describe("relay issuance valuation", () => {
  it("values the next controlled action at its marginal block issuance", () => {
    const open = entry(1);
    const gains = Array.from({ length: 11 }, (_, controlled) =>
      relayTransactionGain(open, valuation(), { controlled: BigInt(controlled), uncontrolled: 0n }));
    expect(gains).toEqual([...Array(10).fill(100n), -10n]);
    expect(relayIssuance(TERMS, 0n, 11n, 0n) - relayIssuance(TERMS, 0n, 10n, 0n)).toBe(-10n);
  });

  it("counts other posters' actions and prices uncontrolled actions as pure dilution", () => {
    const other = valuation({ otherQualifyingActions: 10n });
    expect(relayTransactionGain(entry(1), other, { controlled: 0n, uncontrolled: 0n })).toBe(90n);
    expect(relayTransactionGain(entry(2, designatedTo(ELSEWHERE)), other, { controlled: 1n, uncontrolled: 0n })).toBe(-7n);
  });

  it("follows the remaining-supply clip", () => {
    expect(relayTransactionGain(entry(1), valuation({ terms: { ...TERMS, remaining: 250n } }), { controlled: 2n, uncontrolled: 0n })).toBe(49n);
  });

  it("gains nothing from more zero-fee actions once the allowance is held", () => {
    expect(relayTransactionGain(entry(1), valuation({ selfMinedActions: 10n }), { controlled: 10n, uncontrolled: 0n })).toBe(-10n);
    expect(relayTransactionGain(entry(1), valuation({ terms: ZERO_TERMS }), { controlled: 0n, uncontrolled: 0n })).toBe(0n);
  });

  it("discounts issuance gains, never losses or fees", () => {
    expect([100n, 49n, -10n].map((amount) => discountIssuance(amount, 5_000))).toEqual([50n, 24n, -10n]);
    const halved = valuation({ issuanceHaircutBps: 5_000 });
    expect(relayTransactionGain(entry(1, { openFeeAmount: 30n }), halved, { controlled: 0n, uncontrolled: 0n })).toBe(80n);
    expect(relayTransactionGain(entry(1, { ...accountOperation, openFeeAmount: 30n }), halved, { controlled: 0n, uncontrolled: 0n })).toBe(30n);
  });

  it("counts fees only for controlled destinations", () => {
    const state = { controlled: 0n, uncontrolled: 0n };
    const noIssuance = valuation({ terms: ZERO_TERMS });
    expect(relayTransactionGain(entry(1, { ...accountOperation, openFeeAmount: 9n, issuanceRoute: "none" }), noIssuance, state)).toBe(9n);
    expect(relayTransactionGain(entry(1, { ...accountOperation, openFeeAmount: 0n, ...designatedTo(CONTROLLED) }), noIssuance, state)).toBe(0n);
    expect(relayTransactionGain(entry(1, { kind: "userAccountCreation", issuanceRoute: "none" }), valuation(), state)).toBe(0n);
  });

  it("estimates other posters' actions as the ceiling of the per-block mean", () => {
    expect(estimateOtherQualifyingActions([{ blocks: 1n, qualifyingActions: 3n }, { blocks: 1n, qualifyingActions: 4n }])).toBe(4n);
    expect(estimateOtherQualifyingActions([{ blocks: 2n, qualifyingActions: 8n }])).toBe(4n);
    expect(estimateOtherQualifyingActions([])).toBe(0n);
  });

  it("reports a prepared batch's expected issuance from the node's counts", () => {
    expect(batchExpectedIssuance(valuation(), 10n, 10n)).toEqual({ rewardEach: 100n, expectedIssuance: 1_000n });
    expect(batchExpectedIssuance(valuation(), 5n, 10n)).toEqual({ rewardEach: 100n, expectedIssuance: 500n });
    expect(batchExpectedIssuance(valuation(), 5n, 12n)).toEqual({ rewardEach: 83n, expectedIssuance: 415n });
    expect(batchExpectedIssuance(valuation({ selfMinedActions: 10n }), 0n, 1n)).toEqual({ rewardEach: 90n, expectedIssuance: -100n });
  });
});

describe("automatic relay selection", () => {
  const twelveOpen = Array.from({ length: 12 }, (_, index) => entry(index + 1));

  it("takes zero-fee open actions until the allowance saturates", () => {
    expect(selectRelayCandidates(twelveOpen, policy(), valuation({ issuanceHaircutBps: 5_000 }))).toHaveLength(10);
  });

  it("treats zero-fee open actions as worth nothing under a zero offer unless sponsoring", () => {
    const empty = valuation({ terms: ZERO_TERMS });
    expect(selectRelayCandidates(twelveOpen, policy(), empty)).toEqual([]);
    expect(selectRelayCandidates(twelveOpen, policy({ sponsorUnpaid: true }), empty)).toHaveLength(12);
  });

  it("sponsors zero-fee account operations only when asked", () => {
    const operation = [entry(1, accountOperation)];
    expect(selectRelayCandidates(operation, policy(), valuation())).toEqual([]);
    expect(ids(selectRelayCandidates(operation, policy({ sponsorUnpaid: true }), valuation()))).toEqual([1]);
  });

  it("values a controlled designated action like an open one", () => {
    const controlled = Array.from({ length: 11 }, (_, index) => entry(index + 1, designatedTo(CONTROLLED)));
    expect(relayTransactionGain(controlled[0]!, valuation(), { controlled: 0n, uncontrolled: 0n })).toBe(100n);
    expect(ids(selectRelayCandidates([...controlled, entry(20, designatedTo(ELSEWHERE))], policy(), valuation())))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("selects a zero-fee designated action only for the relayer controlling its destination", () => {
    const zeroTip = entry(1, designatedTo(CONTROLLED));
    const named = valuation();
    const unrelated = valuation({ controlled: new Set([BigInt(ELSEWHERE)]) });
    const state = { controlled: 0n, uncontrolled: 0n };
    expect(relayTransactionGain(zeroTip, named, state)).toBe(100n);
    expect(relayTransactionGain(zeroTip, unrelated, state)).toBe(0n);
    expect(ids(selectRelayCandidates([zeroTip], policy(), named))).toEqual([1]);
    expect(selectRelayCandidates([zeroTip], policy(), unrelated)).toEqual([]);
  });

  it("keeps discovered issuance control on its exact content hash", () => {
    const a = entry(1, designatedTo(ELSEWHERE));
    const b = entry(2, designatedTo(ELSEWHERE));
    const scoped = valuation({ controlled: new Set(),
      controlledByContentHash: new Map([[a.contentHash.toLowerCase(), BigInt(ELSEWHERE)]]) });
    const state = { controlled: 0n, uncontrolled: 0n };
    expect(relayTransactionGain(a, scoped, state)).toBe(100n);
    expect(relayTransactionGain(b, scoped, state)).toBe(0n);
    expect(ids(selectRelayCandidates([a, b], policy(), scoped))).toEqual([1]);
    expect(selectRelayCandidates([b], policy(), scoped)).toEqual([]);
    const staticallyControlled = valuation({ controlled: new Set([BigInt(ELSEWHERE)]) });
    expect(ids(selectRelayCandidates([a, b], policy(), staticallyControlled))).toEqual([1, 2]);
  });

  it("values a private fee by the transaction's own issuance route, not the quoted one", () => {
    const open = entry(1);
    const elsewhere = entry(2, designatedTo(ELSEWHERE));
    const fees = valuation({ controlled: new Set(), otherQualifyingActions: 10n,
      privateFeeByContentHash: new Map([[open.contentHash, 40n], [elsewhere.contentHash, 40n]]) });
    const state = { controlled: 1n, uncontrolled: 0n };
    // The poster takes an open route's issuance; another destination only dilutes it.
    expect(relayTransactionGain(open, fees, state)).toBe(40n + 76n);
    expect(relayTransactionGain(elsewhere, fees, state)).toBe(40n - 7n);
  });

  it("ranks public open fees independently of issuance routing", () => {
    const items = [
      entry(1, { openFeeAmount: 0n, ...designatedTo(ELSEWHERE) }),
      entry(2, { ...accountOperation, openFeeAmount: 10_000n, issuanceRoute: "none" }),
      entry(3, { ...accountOperation, openFeeAmount: 5n, issuanceRoute: "none" }),
    ];
    expect(ids(selectRelayCandidates(items, policy(), valuation()))).toEqual([2, 3]);
  });

  it("orders by net value per byte, then content hash", () => {
    const halved = valuation({ issuanceHaircutBps: 5_000 });
    const items = [entry(1), entry(2, { ...accountOperation, openFeeAmount: 60n })];
    expect(ids(selectRelayCandidates(items, policy({ maxTransactions: 1 }), halved))).toEqual([2]);
    expect(ids(selectRelayCandidates(items, policy(), halved))).toEqual([2, 1]);
    const tied = [entry(5, { ...accountOperation, openFeeAmount: 60n }), entry(4, { ...accountOperation, openFeeAmount: 60n })];
    expect(ids(selectRelayCandidates(tied, policy(), halved))).toEqual([4, 5]);
  });

  it("recomputes marginal issuance as the batch fills", () => {
    // After nine controlled actions the tenth still earns 100, the eleventh loses 10.
    const items = [...twelveOpen.slice(0, 9), entry(20, { ...accountOperation, openFeeAmount: 1n }), entry(21), entry(22)];
    expect(ids(selectRelayCandidates(items, policy(), valuation()))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 21, 20]);
  });

  it("applies the per-byte floor exactly at the boundary for different sizes", () => {
    const items = [
      entry(1, { ...accountOperation, openFeeAmount: 100n, byteSize: 100n }),
      entry(2, { ...accountOperation, openFeeAmount: 199n, byteSize: 200n }),
      entry(3, { ...accountOperation, openFeeAmount: 400n, byteSize: 400n }),
    ];
    expect(ids(selectRelayCandidates(items, policy({ minValuePerByte: 1n }), valuation()))).toEqual([1, 3]);
  });

  it("lets a tip cover self-mined saturation and the byte floor", () => {
    const saturated = valuation({ selfMinedActions: 10n });
    const floor = policy({ minValuePerByte: 2n });
    const zeroTip = entry(1, { byteSize: 5n });
    expect(ids(selectRelayCandidates([zeroTip, entry(2, { openFeeAmount: 20n, byteSize: 5n })], floor, saturated))).toEqual([2]);
    expect(selectRelayCandidates([zeroTip, entry(3, { openFeeAmount: 19n, byteSize: 5n })], floor, saturated)).toEqual([]);
  });

  it("sponsors every remaining entry, oldest first, including a tip below the byte floor", () => {
    const zeroFee = entry(1, accountOperation);
    const oneWei = entry(2, { ...accountOperation, openFeeAmount: 1n });
    const floor = { minValuePerByte: 1n };
    expect(selectRelayCandidates([zeroFee, oneWei], policy(floor), valuation())).toEqual([]);
    expect(ids(selectRelayCandidates([zeroFee, oneWei], policy({ ...floor, sponsorUnpaid: true }), valuation()))).toEqual([2, 1]);
  });

  it("takes overdue entries first, oldest first, and needs sponsorship for overdue unpaid entries", () => {
    const overdue = { receivedAtUnixMs: 1_000_000n - 60_000n };
    const older = { receivedAtUnixMs: 1_000_000n - 90_000n };
    const items = [
      entry(1, { ...accountOperation, openFeeAmount: 500n }),
      entry(2, { ...accountOperation, openFeeAmount: 1n, ...overdue }),
      entry(3, { ...accountOperation, openFeeAmount: 1n, ...older }),
      entry(4, { ...accountOperation, openFeeAmount: 0n, ...older }),
      entry(5, { ...accountOperation, openFeeAmount: 1_000n, issuanceRoute: "none", ...older }),
    ];
    const floor = { maxWaitMs: 30_000n, minValuePerByte: 3n };
    expect(ids(selectRelayCandidates(items, policy(floor), valuation()))).toEqual([3, 5, 2, 1]);
    expect(ids(selectRelayCandidates(items, policy({ ...floor, sponsorUnpaid: true }), valuation()))).toEqual([3, 4, 5, 2, 1]);
  });

  it("skips entries that do not fit and keeps packing smaller ones", () => {
    const items = [
      entry(1, { ...accountOperation, openFeeAmount: 10_000n, byteSize: 900n }),
      entry(2, { ...accountOperation, openFeeAmount: 5n, byteSize: 100n }),
      entry(3, { ...accountOperation, openFeeAmount: 5n, byteSize: 100n }),
    ];
    const capacity = 67n + 4n + 900n + 4n + 100n;
    expect(ids(selectRelayCandidates(items, policy({ maxBatchBytes: capacity }), valuation()))).toEqual([1, 2]);
    expect(ids(selectRelayCandidates(items, policy({ maxBatchBytes: capacity - 1n }), valuation()))).toEqual([1]);
    expect(ids(selectRelayCandidates(items, policy({ maxBatchBytes: 500n }), valuation()))).toEqual([2, 3]);
  });

  it("considers only ready entries", () => {
    expect(selectRelayCandidates([entry(1, { status: "suspended" })], policy({ sponsorUnpaid: true }), valuation())).toEqual([]);
  });
});

describe("next-block issuance reads", () => {
  const QUOTE = { rewardPossible: true } as never;

  /** A node whose head moves to `movedTo` as the first quote is read, and which refuses candidates before its head. */
  function movingHead(movedTo: bigint) {
    let head = 1_000n;
    return {
      status: vi.fn(async () => ({ latestBlockTimestamp: head }) as never),
      getIssuanceQuote: vi.fn(async (candidate: bigint) => {
        head = movedTo;
        if (candidate < head) throw new Error(`invalid block timestamp: previous ${head}, actual ${candidate}`);
        return QUOTE;
      }),
    };
  }

  it("quotes one slot after the head", async () => {
    const node = movingHead(1_000n);
    expect(await nextBlockIssuanceQuote(node, { latestBlockTimestamp: 1_000n })).toBe(QUOTE);
    expect(node.getIssuanceQuote.mock.calls).toEqual([[1_012n]]);
    expect(node.status).not.toHaveBeenCalled();
  });

  it("re-reads the head once when it has passed the candidate time", async () => {
    const node = movingHead(1_030n);
    expect(await nextBlockIssuanceQuote(node, { latestBlockTimestamp: 1_000n })).toBe(QUOTE);
    expect(node.getIssuanceQuote.mock.calls).toEqual([[1_012n], [1_042n]]);
  });

  it("keeps any other quote failure", async () => {
    const node = movingHead(1_000n);
    node.getIssuanceQuote.mockRejectedValueOnce(new Error("quote unavailable"));
    await expect(nextBlockIssuanceQuote(node, { latestBlockTimestamp: 1_000n })).rejects.toThrow("quote unavailable");
    expect(node.getIssuanceQuote).toHaveBeenCalledTimes(1);
    const unreachable = { status: vi.fn(async () => { throw new Error("status unavailable"); }), getIssuanceQuote: vi.fn(async () => { throw new Error("quote unavailable"); }) };
    await expect(nextBlockIssuanceQuote(unreachable, { latestBlockTimestamp: 1_000n })).rejects.toThrow("quote unavailable");
  });

  it("ends the economics window at the index head when the index lags", async () => {
    const reads: BlockEconomicsQuery[] = [];
    const node = {
      getBlockEconomics: vi.fn(async (query: BlockEconomicsQuery) => {
        reads.push(query);
        return { atBlockNumber: 50n, atBlockHash: "0x", nextBlock: null, records: query.fromBlock! > 50n ? [] : [{ blocks: 10n, qualifyingActions: 4n }] } as never;
      }),
    };
    const page = await recentBlockEconomics(node, 100n, 10);
    expect(reads).toEqual([{ fromBlock: 91n, limit: 10, bucket: 1 }, { fromBlock: 41n, limit: 10, bucket: 1 }]);
    expect(estimateOtherQualifyingActions(page.records)).toBe(1n);
    await recentBlockEconomics(node, 100n);
    expect(reads.at(-2)).toEqual({ fromBlock: 37n, limit: DEFAULT_ISSUANCE_WINDOW_BLOCKS, bucket: 1 });
  });

  it("refuses an empty economics window", async () => {
    const node = { getBlockEconomics: vi.fn(async () => ({ atBlockNumber: 5n, atBlockHash: "0x", nextBlock: null, records: [] }) as never) };
    await expect(recentBlockEconomics(node, 5n)).rejects.toThrow(/no blocks in the issuance window/);
  });
});
