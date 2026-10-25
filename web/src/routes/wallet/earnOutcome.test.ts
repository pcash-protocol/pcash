import { describe, expect, it, vi } from "vitest";
import type { BlockPayoutsResult, BlockEconomicsRecordResult, ReceiptResult, TransactionPageResult, TransactionSummaryResult } from "@pcash/sdk/clients";
import { issuancePayoutOpening, posterPayoutOpening } from "@pcash/sdk/protocol";
import { findInclusion, resolveEarnLanding, selectInclusion, type EarnWatchNode } from "./earnOutcome.ts";

const HASH = `0x${"ab".repeat(32)}`;
const hash = (byte: string) => `0x${byte.repeat(32)}`;
const CHAIN_ID = 31_337n;
const OWNER = { address: 11n, nkRoot: 22n };
const STRANGER = { address: 33n, nkRoot: 44n };
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;

function summary(blockNumber: bigint, outcome: TransactionSummaryResult["outcome"] = "succeeded", blockHash = hash("ef"), transactionId = hash("cd")): TransactionSummaryResult {
  return {
    transactionId, contentHash: HASH, outcome, failureDetail: null, declaredOpenFeeAmount: 0n, declaredIssuanceOwnerCommitment: word(0n),
    issuanceRoute: "open", kind: "privateValue", fundingMode: null, block: { blockNumber, blockHash }, pcashTransactionIndex: 0n, timestamp: 1_000n,
    inclusion: { l1BlockNumber: 1n, l1BlockHash: hash("01"), l1TransactionIndex: 0n, l1TransactionHash: hash("02"), batchItemIndex: 0n },
    l1Sender: `0x${"11".repeat(20)}`, issuanceOwnerCommitment: null, settledOpenFeeAmount: 0n, settledIssuanceAmount: 0n,
    byteSize: 1n, outputLeafStart: null, outputsAdded: 5n, nullifiers: null, account: null,
  };
}

function economics(firstBlock: bigint, actions: bigint, rewardEach: bigint): BlockEconomicsRecordResult {
  return { firstBlock, lastBlock: firstBlock, firstTimestamp: 1_000n, lastTimestamp: 1_000n, blocks: 1n, qualifyingActions: actions, issuanceTotal: rewardEach * actions,
    openFeesTotal: 0n, rewardEach, baseline: 0n, internalOffer: 0n, blockAllowance: 0n, lagQ: 0n };
}

/** The open route pays the including batch's poster; `poster` published block `blockNumber`'s batch. */
function posted(blockNumber: bigint, issuance: bigint, poster = OWNER, fee = 0n): { receipt: ReceiptResult; record: BlockPayoutsResult } {
  const opening = posterPayoutOpening(poster.address, poster.nkRoot, blockNumber);
  const receipt = { transactionId: hash("cd"), contentHash: HASH, outcome: "succeeded", issuanceOwnerCommitment: word(opening.ownerCommitment),
    settledOpenFeeAmount: fee, settledIssuanceAmount: issuance } as ReceiptResult;
  const record: BlockPayoutsResult = {
    block: { blockNumber, blockHash: hash("ef") }, openFeesTotal: fee, issuanceTotal: issuance,
    payouts: [
      ...(fee === 0n ? [] : [{ source: { kind: "posterPayout" as const, l1TransactionIndices: [0n] }, component: "openFee" as const, amount: fee,
        ownerCommitment: opening.ownerCommitment, outputIndex: 0n, contexts: [opening.context] }]),
      ...(issuance === 0n ? [] : [{ source: { kind: "posterPayout" as const, l1TransactionIndices: [0n] }, component: "issuance" as const, amount: issuance,
        ownerCommitment: opening.ownerCommitment, outputIndex: fee === 0n ? 0n : 1n, contexts: [opening.context] }]),
    ],
  };
  return { receipt, record };
}

/** A self-published action names its publisher's own seed-derived commitment for its nullifiers. */
function designated(blockNumber: bigint, issuance: bigint, recipient = OWNER): { receipt: ReceiptResult; record: BlockPayoutsResult } {
  const opening = issuancePayoutOpening(recipient.address, recipient.nkRoot, CHAIN_ID, [1n, 2n, 3n, 4n]);
  const receipt = { transactionId: hash("cd"), contentHash: HASH, outcome: "succeeded", issuanceOwnerCommitment: word(opening.ownerCommitment),
    settledOpenFeeAmount: 0n, settledIssuanceAmount: issuance } as ReceiptResult;
  const record: BlockPayoutsResult = {
    block: { blockNumber, blockHash: hash("ef") }, openFeesTotal: 0n, issuanceTotal: issuance,
    payouts: [{ source: { kind: "designatedIssuance", l1TransactionIndex: 0n, batchItemIndex: 0n }, component: "issuance", amount: issuance,
      ownerCommitment: opening.ownerCommitment, outputIndex: 0n, contexts: [opening.context] }],
  };
  return { receipt, record };
}

const head = { blockNumber: 9n, blockHash: "0x" };
const page = (items: TransactionSummaryResult[], more = false): TransactionPageResult => ({ items, nextCursor: more ? { head, blockNumber: 1n, pcashTransactionIndex: 0n } : null, head });

/** A node whose answers are consumed in order; the last answer repeats. */
function node(
  submissions: TransactionPageResult[],
  rows: BlockEconomicsRecordResult[][],
  payout: (BlockPayoutsResult | null)[] = [],
  receipts: ReceiptResult[][] = [],
): EarnWatchNode & { calls: string[] } {
  const calls: string[] = [];
  const take = <T,>(queue: T[]): T | undefined => (queue.length > 1 ? queue.shift() : queue[0]);
  return {
    calls,
    getSubmission: vi.fn(async (query: { cursor?: unknown }) => { calls.push(query.cursor === undefined ? "submission" : "submission-next"); return take(submissions) ?? page([]); }) as never,
    getBlockEconomics: vi.fn(async () => { calls.push("economics"); return { atBlockNumber: 9n, atBlockHash: "0x", records: take(rows) ?? [], nextBlock: null }; }) as never,
    getBlockPayouts: vi.fn(async () => { calls.push("payout"); return take(payout) ?? null; }) as never,
    getReceipt: vi.fn(async () => { calls.push("receipt"); return take(receipts) ?? []; }) as never,
  };
}

const immediate = async () => undefined;
const replay = summary(8n, "proofRejected", hash("11"), hash("22"));

describe("choosing the inclusion that speaks for an action", () => {
  it("prefers a succeeded inclusion over a newer rejected replay of the same bytes", () => {
    const original = summary(7n);
    expect(selectInclusion([replay, original])).toBe(original);
    expect(selectInclusion([replay])).toBe(replay);
    expect(selectInclusion([])).toBeUndefined();
  });

  it("follows submission pages until a success appears", async () => {
    const watched = node([page([replay], true), page([summary(7n)])], []);
    const search = await findInclusion(watched, HASH);
    expect(search.complete).toBe(true);
    expect(search.inclusion?.block.blockNumber).toBe(7n);
    expect(watched.calls).toEqual(["submission", "submission-next"]);
  });

  it("reports an exhausted page budget as incomplete rather than as the newest rejection", async () => {
    const watched = node([page([replay], true), page([replay], true), page([replay], true)], []);
    const search = await findInclusion(watched, HASH, 2);
    expect(search.complete).toBe(false);
    expect(watched.calls).toHaveLength(2);
    const reading = await resolveEarnLanding(node([page([replay], true)], []), HASH, OWNER, { sleep: immediate });
    expect(reading.kind).toBe("incomplete");
  });
});

describe("resolving one consistent reading", () => {
  it("joins the block's economics and payout and confirms the inclusion did not move", async () => {
    const { receipt, record } = posted(7n, 50n);
    const watched = node([page([summary(7n)])], [[economics(7n, 3n, 50n)]], [record], [[receipt]]);
    const reading = await resolveEarnLanding(watched, HASH, OWNER, { sleep: immediate });
    expect(reading.kind).toBe("landed");
    if (reading.kind !== "landed") return;
    expect(reading.landing).toMatchObject({ contentHash: HASH, blockNumber: 7n, blockHash: hash("ef"), outcome: "succeeded" });
    expect(reading.landing.block?.rewardEach).toBe(50n);
    expect(watched.calls).toEqual(["submission", "receipt", "economics", "payout", "submission"]);
  });

  it("counts issuance as this wallet's only when its seed opens the destination", async () => {
    const own = posted(7n, 50n);
    const mine = await resolveEarnLanding(node([page([summary(7n)])], [[economics(7n, 1n, 50n)]], [own.record], [[own.receipt]]), HASH, OWNER, { sleep: immediate });
    expect(mine.kind === "landed" && mine.landing.payout).toEqual({
      route: "open", destination: own.receipt.issuanceOwnerCommitment, openFeeAmount: 0n, issuanceAmount: 50n, yours: true,
    });
    const copied = posted(7n, 50n, STRANGER);
    const theirs = await resolveEarnLanding(node([page([summary(7n)])], [[economics(7n, 1n, 50n)]], [copied.record], [[copied.receipt]]), HASH, OWNER, { sleep: immediate });
    expect(theirs.kind === "landed" && theirs.landing.payout?.yours).toBe(false);
    expect(theirs.kind === "landed" && theirs.landing.payout?.issuanceAmount).toBe(50n);
  });

  it("counts a self-published action's designated payout as this wallet's wherever it landed", async () => {
    const designatedRoute = { ...summary(7n), issuanceRoute: "designated" as const };
    const own = designated(7n, 50n);
    const mine = await resolveEarnLanding(node([page([designatedRoute])], [[economics(7n, 1n, 50n)]], [own.record], [[own.receipt]]), HASH, OWNER, { sleep: immediate });
    expect(mine.kind === "landed" && mine.landing.payout).toEqual({
      route: "designated", destination: own.receipt.issuanceOwnerCommitment, openFeeAmount: 0n, issuanceAmount: 50n, yours: true,
    });
    const other = designated(7n, 50n, STRANGER);
    const theirs = await resolveEarnLanding(node([page([designatedRoute])], [[economics(7n, 1n, 50n)]], [other.record], [[other.receipt]]), HASH, OWNER, { sleep: immediate });
    expect(theirs.kind === "landed" && theirs.landing.payout?.yours).toBe(false);
  });

  it("leaves ownership open while the block's payout record is unindexed", async () => {
    const { receipt } = posted(7n, 50n);
    const reading = await resolveEarnLanding(node([page([summary(7n)])], [[economics(7n, 1n, 50n)]], [null], [[receipt]]), HASH, OWNER, { sleep: immediate });
    expect(reading.kind === "landed" && reading.landing.payout).toMatchObject({ issuanceAmount: 50n, yours: null });
  });

  it("reports a zero-issuance landing without an owner test", async () => {
    const { receipt, record } = posted(7n, 0n);
    const reading = await resolveEarnLanding(node([page([summary(7n)])], [[economics(7n, 1n, 0n)]], [record], [[receipt]]), HASH, OWNER, { sleep: immediate });
    expect(reading.kind === "landed" && reading.landing.payout).toMatchObject({ openFeeAmount: 0n, issuanceAmount: 0n });
  });

  it("reports moved when the canonical view changed between the reads and absent when nothing is included", async () => {
    const before = page([summary(7n, "succeeded", hash("aa"))]);
    const after = page([summary(7n, "succeeded", hash("bb"))]);
    expect((await resolveEarnLanding(node([before, after], [[economics(7n, 1n, 60n)]]), HASH, OWNER, { sleep: immediate })).kind).toBe("moved");
    expect((await resolveEarnLanding(node([page([])], []), HASH, OWNER, { sleep: immediate })).kind).toBe("absent");
  });

  it("reports a rejected inclusion when no success exists and a missing row when the index lags", async () => {
    const failed = await resolveEarnLanding(node([page([summary(2n, "proofRejected")])], [[economics(2n, 0n, 0n)]]), HASH, OWNER, { sleep: immediate });
    expect(failed.kind === "landed" && failed.landing.outcome).toBe("proofRejected");
    const lagging = await resolveEarnLanding(node([page([summary(4n)])], [[]]), HASH, OWNER, { sleep: immediate });
    expect(lagging.kind === "landed" && lagging.landing.block).toBeNull();
  });
});
