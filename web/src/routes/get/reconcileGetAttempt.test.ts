import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockEconomicsRecordResult, BlockPayoutsResult, ReceiptResult, TransactionSummaryResult, StatusResult, BlockResult } from "@pcash/sdk/clients";
import { issuancePayoutOpening } from "@pcash/sdk/protocol";
import { reconcileAttempt, type RelayAttempt } from "../../shared/relayHistory.ts";
import { reconcileGetAttempt } from "./reconcileGetAttempt.ts";

vi.mock("../../shared/relayHistory.ts", () => ({ reconcileAttempt: vi.fn() }));
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const OWNER = { address: 11n, nkRoot: 22n };
const STRANGER = { address: 33n, nkRoot: 44n };
const OWN_BATCH = word(10n);
const OTHER_BATCH = word(20n);
const BASE: RelayAttempt = { id: "attempt", at: 0, contentHashes: [word(1n)], txHash: OWN_BATCH, status: "included",
  collectedFee: 7n, collectedIssuance: 11n };

function watched(recipient = OWNER, batchHash = OTHER_BATCH, missingReceipt = false) {
  const opening = issuancePayoutOpening(recipient.address, recipient.nkRoot, 31337n, [1n, 2n, 3n, 4n]);
  const summary: TransactionSummaryResult = {
    transactionId: word(2n), contentHash: word(1n), outcome: "succeeded", failureDetail: null,
    declaredOpenFeeAmount: 0n, declaredIssuanceOwnerCommitment: word(opening.ownerCommitment),
    issuanceRoute: "designated", kind: "privateValue", accountCreation: 0, block: { blockNumber: 7n, blockHash: word(7n) },
    pcashTransactionIndex: 0n, timestamp: 1000n,
    inclusion: { l1BlockNumber: 1n, l1BlockHash: word(8n), l1TransactionIndex: 0n, l1TransactionHash: batchHash, batchItemIndex: 0n },
    l1Sender: `0x${"11".repeat(20)}`, issuanceOwnerCommitment: null, settledOpenFeeAmount: 0n, settledIssuanceAmount: 0n,
    byteSize: 1n, outputLeafStart: null, outputsAdded: 5n, nullifiers: null, account: null,
  };
  const receipt = { transactionId: summary.transactionId, contentHash: summary.contentHash, outcome: "succeeded",
    inclusion: summary.inclusion, issuanceOwnerCommitment: word(opening.ownerCommitment),
    settledOpenFeeAmount: 99n, settledIssuanceAmount: 50n } as ReceiptResult;
  const economics: BlockEconomicsRecordResult = { firstBlock: 7n, lastBlock: 7n, firstTimestamp: 1000n, lastTimestamp: 1000n,
    blocks: 1n, qualifyingActions: 1n, issuanceTotal: 50n, openFeesTotal: 99n,
    rewardEach: 50n, baseline: 0n, internalOffer: 0n, blockAllowance: 0n, lagQ: 0n };
  const payouts: BlockPayoutsResult = { block: summary.block, openFeesTotal: 99n, issuanceTotal: 50n,
    payouts: [
      { source: { kind: "posterPayout", l1TransactionIndices: [0n] }, component: "openFee", amount: 99n,
        ownerCommitment: 999n, outputIndex: 0n, contexts: [888n] },
      { source: { kind: "designatedIssuance", l1TransactionIndex: 0n, batchItemIndex: 0n }, component: "issuance", amount: 50n,
        ownerCommitment: opening.ownerCommitment, outputIndex: 1n, contexts: [opening.context] },
    ] };
  return {
    getSubmission: vi.fn(async () => ({ items: [summary], nextCursor: null, head: summary.block })),
    getReceipt: vi.fn(async () => missingReceipt ? [] : [receipt]),
    getBlockEconomics: vi.fn(async () => ({ atBlockNumber: 7n, atBlockHash: word(7n), records: [economics], nextBlock: null })),
    getBlockPayouts: vi.fn(async () => payouts),
    getInboxDeliveryBatch: vi.fn(), getBlockByHash: vi.fn(async () => null), status: vi.fn(),
  } as unknown as Parameters<typeof reconcileGetAttempt>[0];
}

beforeEach(() => { vi.mocked(reconcileAttempt).mockImplementation(async (_node, attempt) => ({ ...attempt, ...BASE })); });
describe("Get PCASH actual mining earnings", () => {
  it("counts owned issuance from an earlier poster once, without their explicit fees", async () => {
    const attempt = { ...BASE, mineContentHashes: [word(1n), word(1n)], collectedIssuance: 61n };
    const result = await reconcileGetAttempt(watched(), attempt, "0xaccount", OWNER);
    expect(result.collectedFee).toBe(7n);
    expect(result.collectedIssuance).toBe(61n);
    expect(vi.mocked(reconcileAttempt).mock.calls[0]![1].collectedIssuance).toBeUndefined();
    expect((await reconcileGetAttempt(watched(), result as typeof attempt, "0xaccount", OWNER)).collectedIssuance).toBe(61n);
  });

  it("does not count a donation paid to someone else", async () => {
    expect((await reconcileGetAttempt(watched(STRANGER), { ...BASE, mineContentHashes: [word(1n)] }, "0xaccount", OWNER)).collectedIssuance).toBe(11n);
  });

  it("does not count issuance in our batch twice", async () => {
    expect((await reconcileGetAttempt(watched(OWNER, OWN_BATCH), { ...BASE, mineContentHashes: [word(1n)] }, "0xaccount", OWNER)).collectedIssuance).toBe(11n);
  });

  it("keeps unavailable receipts pending instead of reporting partial earnings", async () => {
    const result = await reconcileGetAttempt(watched(OWNER, OTHER_BATCH, true), { ...BASE, mineContentHashes: [word(1n)] }, "0xaccount", OWNER);
    expect(result.collectedFee).toBeUndefined();
    expect(result.collectedIssuance).toBeUndefined();
  });

  it("finishes an excluded finalized batch with no mine inclusions at zero", async () => {
    const node = watched();
    vi.mocked(node.getSubmission).mockResolvedValue({ items: [], nextCursor: null, head: { blockNumber: 9n, blockHash: word(9n) } });
    const actual = await vi.importActual<typeof import("../../shared/relayHistory.ts")>("../../shared/relayHistory.ts");
    vi.mocked(reconcileAttempt).mockImplementation(actual.reconcileAttempt);
    vi.mocked(node.status).mockResolvedValue({ finalizedL1BlockNumber: 1n, genesisL1Block: 0n } as StatusResult);
    vi.mocked(node.getBlockByHash).mockResolvedValue({ l1Origin: { blockNumber: 1n } } as BlockResult);
    vi.mocked(node.getInboxDeliveryBatch).mockResolvedValue({ posterOwnerCommitment: null, posterContext: null,
      l1BlockNumber: 1n, l1BlockHash: word(9n), l1TransactionIndex: 0n, l1TransactionHash: OWN_BATCH, l1Sender: "0xaccount",
      carrierType: "calldata", logIndex: null, emitter: null, context: null,
      carrierHash: word(9n), carrierLength: 1n, blobVersionedHashes: [],
      exclusionReason: "unsupportedBatchVersion", items: [] });
    const result = await reconcileGetAttempt(node, { ...BASE, mineContentHashes: [word(1n)] }, "0xaccount", OWNER);
    expect(result).toMatchObject({ status: "finalized", collectedFee: 0n, collectedIssuance: 0n });
  });

  it("keeps absent inclusions pending until the containing batch is finalized", async () => {
    const node = watched();
    vi.mocked(node.getSubmission).mockResolvedValue({ items: [], nextCursor: null, head: { blockNumber: 9n, blockHash: word(9n) } });
    const result = await reconcileGetAttempt(node, { ...BASE, mineContentHashes: [word(1n)] }, "0xaccount", OWNER);
    expect(result.collectedFee).toBeUndefined();
    expect(result.collectedIssuance).toBeUndefined();
  });

  it("reads unavailable payout data once per polling pass", async () => {
    const node = watched();
    vi.mocked(node.getBlockPayouts).mockResolvedValue(null);
    const result = await reconcileGetAttempt(node, { ...BASE, mineContentHashes: [word(1n)] }, "0xaccount", OWNER);
    expect(node.getBlockPayouts).toHaveBeenCalledTimes(1);
    expect(result.collectedIssuance).toBeUndefined();
  });


  it("does not wait for payout data for a failed mine inclusion", async () => {
    const node = watched();
    const page = await node.getSubmission({ contentHash: word(1n) });
    vi.mocked(node.getSubmission).mockResolvedValue({ ...page, items: page.items.map(item => ({ ...item, outcome: "proofRejected" })) });
    vi.mocked(reconcileAttempt).mockImplementation(async (_node, attempt) => ({ ...attempt, status: "finalized", collectedFee: 0n, collectedIssuance: 0n }));
    const result = await reconcileGetAttempt(node, { ...BASE, mineContentHashes: [word(1n)] }, "0xaccount", OWNER);
    expect(result).toMatchObject({ status: "finalized", collectedFee: 0n, collectedIssuance: 0n });
    expect(node.getBlockPayouts).not.toHaveBeenCalled();
  });


  it("keeps a finalized excluded batch pending until submission indexing covers its L1 origin", async () => {
    const node = watched();
    vi.mocked(node.getSubmission).mockResolvedValue({ items: [], nextCursor: null, head: { blockNumber: 2n, blockHash: word(2n) } });
    const actual = await vi.importActual<typeof import("../../shared/relayHistory.ts")>("../../shared/relayHistory.ts");
    vi.mocked(reconcileAttempt).mockImplementation(actual.reconcileAttempt);
    vi.mocked(node.status).mockResolvedValue({ finalizedL1BlockNumber: 110n, genesisL1Block: 100n } as StatusResult);
    vi.mocked(node.getInboxDeliveryBatch).mockResolvedValue({ posterOwnerCommitment: null, posterContext: null,
      l1BlockNumber: 110n, l1BlockHash: word(9n), l1TransactionIndex: 0n, l1TransactionHash: OWN_BATCH, l1Sender: "0xaccount",
      carrierType: "calldata", logIndex: null, emitter: null, context: null,
      carrierHash: word(9n), carrierLength: 1n, blobVersionedHashes: [],
      exclusionReason: "unsupportedBatchVersion", items: [] });
    const attempt = { ...BASE, mineContentHashes: [word(1n)] };
    vi.mocked(node.getBlockByHash).mockResolvedValue({ l1Origin: { blockNumber: 102n } } as BlockResult);
    const lagging = await reconcileGetAttempt(node, attempt, "0xaccount", OWNER);
    expect(lagging.collectedIssuance).toBeUndefined();
    expect(lagging.collectedFee).toBeUndefined();
    vi.mocked(node.getSubmission).mockResolvedValue({ items: [], nextCursor: null, head: { blockNumber: 10n, blockHash: word(10n) } });
    vi.mocked(node.getBlockByHash).mockResolvedValue({ l1Origin: { blockNumber: 110n } } as BlockResult);
    const caughtUp = await reconcileGetAttempt(node, lagging as typeof attempt, "0xaccount", OWNER);
    expect(caughtUp).toMatchObject({ status: "finalized", collectedFee: 0n, collectedIssuance: 0n });
  });


  it("keeps an absent reading from an orphaned index snapshot pending", async () => {
    const node = watched();
    vi.mocked(node.getSubmission).mockResolvedValue({ items: [], nextCursor: null, head: { blockNumber: 20n, blockHash: word(20n) } });
    vi.mocked(reconcileAttempt).mockImplementation(async (_node, attempt) => ({ ...attempt, status: "finalized", l1BlockNumber: 110n, collectedFee: 0n, collectedIssuance: 0n }));
    vi.mocked(node.getBlockByHash).mockResolvedValue(null);
    const result = await reconcileGetAttempt(node, { ...BASE, mineContentHashes: [word(1n)] }, "0xaccount", OWNER);
    expect(node.getBlockByHash).toHaveBeenCalledWith(word(20n));
    expect(result.collectedIssuance).toBeUndefined();
    expect(result.collectedFee).toBeUndefined();
  });

});
