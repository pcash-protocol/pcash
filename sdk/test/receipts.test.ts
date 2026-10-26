import { describe, expect, it } from "vitest";
import { awaitAcceptedReceipt, awaitReceipt, isFinalized, pollReceipt, selectReceipt } from "../src/clients/receipts.ts";
import { PcashNodeClient, type StatusResult } from "../src/clients/nodeClient.ts";

const CONTENT = `0x${"1a".repeat(32)}`;
const TRANSACTION_ID = `0x${"3c".repeat(32)}`;
const OTHER = `0x${"44".repeat(32)}`;
const BLOCK_HASH = `0x${"2b".repeat(32)}`;
const nullifiers = Array.from({ length: 4 }, (_, index) => `0x${(index + 10).toString(16).padStart(64, "0")}`);

function wireReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inclusion: {
      l1BlockNumber: "0xa",
      l1BlockHash: BLOCK_HASH,
      l1TransactionIndex: "0x0",
      l1TransactionHash: `0x${"33".repeat(32)}`,
      batchItemIndex: "0x0",
    },
    contentHash: CONTENT,
    transactionId: TRANSACTION_ID,
    outcome: "succeeded",
    failureDetail: null,
    l1Sender: `0x${"00".repeat(20)}`,
    issuanceOwnerCommitment: null,
    settledOpenFeeAmount: "0x0",
    settledIssuanceAmount: "0x0",
    kind: "privateValue",
    accountCreation: 0 as const,
    outputLeafStart: null,
    outputsAdded: "0x0",
    nullifiers,
    account: null,
    ...overrides,
  };
}

function nodeFor(receipts: unknown[], queries: unknown[] = []): PcashNodeClient {
  return new PcashNodeClient("http://mock", { fetchFn: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    queries.push(request.params[0]);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: receipts }));
  } });
}

const expired = () => wireReceipt({
  outcome: "expired",
  failureDetail: { type: "expired", validUntil: "0x10", blockTimestamp: "0x11" },
});
const spent = () => wireReceipt({
  outcome: "nullifierAlreadySpent",
  failureDetail: { type: "nullifierAlreadySpent", inputSlot: "0x1", nullifier: nullifiers[0], spendingTransactionId: OTHER },
});

describe("receipt polling through PcashNodeClient", () => {
  it.each([
    ["expired", expired, "validUntil", 16n],
    ["nullifierAlreadySpent", spent, "inputSlot", 1n],
  ])("keeps decoded %s failure quantities", async (_name, make, field, value) => {
    const queries: unknown[] = [];
    const receipt = await pollReceipt(nodeFor([make()], queries), CONTENT);
    expect(receipt?.outcome).toBe(_name);
    expect(receipt?.failureDetail).toMatchObject({ [field]: value });
    expect(queries).toEqual([{ contentHash: CONTENT }]);
  });

  it.each(["first", "last"])("selects success when an expired inclusion is %s", async (position) => {
    const failed = expired();
    const succeeded = wireReceipt({ inclusion: { ...wireReceipt().inclusion as object, l1BlockNumber: "0x5" } });
    const list = position === "first" ? [failed, succeeded] : [succeeded, failed];
    expect((await pollReceipt(nodeFor(list), CONTENT))?.outcome).toBe("succeeded");
    expect((await awaitAcceptedReceipt(nodeFor(list), CONTENT, { pollMaxAttempts: 1 }))?.inclusion.l1BlockNumber).toBe(5n);
  });

  it("rejects every well formed receipt for the wrong requested content", async () => {
    const wrong = wireReceipt({ contentHash: OTHER });
    await expect(pollReceipt(nodeFor([wrong]), CONTENT)).rejects.toThrow(/contentHash does not match the requested content/);
    await expect(awaitReceipt(nodeFor([wireReceipt(), wrong]), CONTENT, { pollMaxAttempts: 1 }))
      .rejects.toThrow(/contentHash does not match the requested content/);
  });

  it("binds transaction and nullifier queries at the RPC boundary", async () => {
    await expect(nodeFor([wireReceipt({ transactionId: OTHER })]).getReceipt(TRANSACTION_ID))
      .rejects.toThrow(/transactionId does not match the requested transaction/);
    await expect(nodeFor([wireReceipt({ nullifiers: [OTHER, ...nullifiers.slice(1)] })]).getReceipt({ nullifier: nullifiers[0]! }))
      .rejects.toThrow(/does not contain the requested nullifier/);
  });

  it("normalizes receipt identities and rejects malformed nullifiers", async () => {
    const upper = (value: string) => `0x${value.slice(2).toUpperCase()}`;
    const receipt = (await nodeFor([wireReceipt({
      contentHash: upper(CONTENT),
      transactionId: upper(TRANSACTION_ID),
      nullifiers: nullifiers.map(upper),
      inclusion: { ...wireReceipt().inclusion as object, l1BlockHash: upper(BLOCK_HASH) },
    })]).getReceipt({ contentHash: CONTENT }))[0]!;
    expect(receipt.contentHash).toBe(CONTENT);
    expect(receipt.transactionId).toBe(TRANSACTION_ID);
    expect(receipt.inclusion.l1BlockHash).toBe(BLOCK_HASH);
    expect(receipt.nullifiers).toEqual(nullifiers);
    await expect(nodeFor([wireReceipt({ nullifiers: ["0x12", ...nullifiers.slice(1)] })]).getReceipt({ contentHash: CONTENT }))
      .rejects.toThrow(/nullifiers\[0\]/);
  });

  it("keeps selection and finality on typed fields", async () => {
    const node = nodeFor([wireReceipt()]);
    const [receipt] = await node.getReceipt({ contentHash: CONTENT });
    expect(receipt).toBeDefined();
    expect(selectReceipt([receipt!])).toBe(receipt);
    expect(isFinalized(receipt!.inclusion.l1BlockNumber, { finalizedL1BlockNumber: 10n } as StatusResult)).toBe(true);
  });

  it("breaks same-block ties by transaction id regardless of listing order", async () => {
    const lower = wireReceipt({ transactionId: TRANSACTION_ID });
    const higher = wireReceipt({ transactionId: OTHER });
    const receipts = await nodeFor([lower, higher]).getReceipt({ contentHash: CONTENT });
    expect(selectReceipt(receipts).transactionId).toBe(TRANSACTION_ID);
    expect(selectReceipt([...receipts].reverse()).transactionId).toBe(TRANSACTION_ID);
  });
});
