import { afterEach, describe, expect, it, vi } from "vitest";
import type { L1DeliveryBatchResult, ReceiptResult } from "@pcash/sdk/clients";
import { applyRecoveredRelayAttempts, applyReleasedRelayAttempts, publishReleasedRelayAttempts, RELAY_ATTEMPTS_RELEASED_EVENT, type RelayAttemptsReleasedDetail, readRelayHistory, reconcileAttempt, relayDeploymentKey, relayHistoryKey, saveRelayHistory, type RelayAttempt, isRelayAttemptTracking, findRelayAttempt } from "./relayHistory.ts";

const attempt: RelayAttempt = { id: "one", at: 123, contentHashes: ["content"], controlledCommitments: ["alice"], txHash: "transaction", status: "pending" };
const batchItem = (contentHash = "content", batchItemIndex = 0n): L1DeliveryBatchResult["items"][number] => ({
  contentHash, batchItemIndex, byteOffset: 7n + batchItemIndex * 7n, byteLength: 3n, exclusionReason: null,
});
const batch: L1DeliveryBatchResult = {
  l1Sender: "alice", l1TransactionHash: "transaction", l1BlockNumber: 10n,
  l1BlockHash: "block", l1TransactionIndex: 2n, carrierType: "calldata", logIndex: null, emitter: null, context: null,
  posterOwnerCommitment: "alice", posterContext: "context", carrierHash: "carrier", carrierLength: 10n, blobVersionedHashes: [], exclusionReason: null,
  items: [batchItem()],
};
const status = vi.fn().mockResolvedValue({ finalizedL1BlockNumber: 10n });
const receipt = (overrides: Partial<ReceiptResult> = {}): ReceiptResult => ({
  contentHash: "content",
  transactionId: `included-${overrides.contentHash ?? "content"}`,
  l1Sender: "alice",
  inclusion: { l1TransactionHash: "transaction" },
  outcome: "succeeded",
  issuanceOwnerCommitment: "alice",
  settledOpenFeeAmount: 12n,
  settledIssuanceAmount: 5n,
  ...overrides,
} as ReceiptResult);

afterEach(() => vi.unstubAllGlobals());

describe("payout commitment attribution", () => {
  it("does not attribute fee or issuance to the L1 sender when the settled destination is someone else", async () => {
    const node = { status, getInboxDeliveryBatch: vi.fn().mockResolvedValue(batch), getReceipt: vi.fn().mockResolvedValue([receipt({ issuanceOwnerCommitment: "someone-else" })]) };
    expect(await reconcileAttempt(node, attempt, "alice")).toMatchObject({ collectedFee: 0n, collectedIssuance: 0n });
  });
});

describe("recent relay storage", () => {
  it("isolates wallets and networks and preserves exact amounts", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const saved = { ...attempt, resolutionId: "journal-one", collectedFee: 123456789012345678901234n, collectedIssuance: 987n };
    saveRelayHistory(relayHistoryKey("network-one", "Alice"), [saved]);
    expect(readRelayHistory(relayHistoryKey("network-one", "alice"))).toEqual([saved]);
    expect(readRelayHistory(relayHistoryKey("network-two", "alice"))).toEqual([]);
    expect(readRelayHistory(relayHistoryKey("network-one", "bob"))).toEqual([]);
  });

  it("keeps storage failures optional", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => { throw new Error("disabled"); },
      setItem: () => { throw new Error("quota"); },
    });
    expect(readRelayHistory("history")).toEqual([]);
    expect(() => saveRelayHistory("history", [attempt])).not.toThrow();
  });

  it("ignores browser data that cannot render as relay history", () => {
    const getItem = vi.fn();
    vi.stubGlobal("sessionStorage", { getItem });
    for (const value of ["null", "{}", "[null]", '[{"contentHashes":null}]']) {
      getItem.mockReturnValue(value);
      expect(readRelayHistory("history")).toEqual([]);
    }
    getItem.mockReturnValue(JSON.stringify([null, attempt]));
    expect(readRelayHistory("history")).toEqual([attempt]);
  });

  it("keeps independent tab histories from overwriting each other", () => {
    const makeTabStore = () => {
      const values = new Map<string, string>();
      return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      };
    };
    const firstTab = makeTabStore();
    const secondTab = makeTabStore();
    const key = relayHistoryKey("network", "alice");
    vi.stubGlobal("sessionStorage", firstTab);
    saveRelayHistory(key, [attempt]);
    vi.stubGlobal("sessionStorage", secondTab);
    expect(readRelayHistory(key)).toEqual([]);
    const otherAttempt = { ...attempt, id: "two" };
    saveRelayHistory(key, [otherAttempt]);
    vi.stubGlobal("sessionStorage", firstTab);
    expect(readRelayHistory(key)).toEqual([attempt]);
    vi.stubGlobal("sessionStorage", secondTab);
    expect(readRelayHistory(key)).toEqual([otherAttempt]);
  });
});

describe("relay deployment identity", () => {
  const deployment = { pcashChainId: 123, genesisHash: "0xAB", l1ChainId: 456n, inboxAddress: "0xCD" };
  it("normalizes hexadecimal case for wallet writers and explorer readers", () => {
    expect(relayDeploymentKey(deployment)).toBe("123:0xab:456:0xcd");
    expect(relayDeploymentKey({ ...deployment, genesisHash: "0xab", inboxAddress: "0xcd" })).toBe(relayDeploymentKey(deployment));
  });
  it("keeps chain and inbox deployments separate", () => {
    const key = relayDeploymentKey(deployment);
    for (const other of [{ ...deployment, pcashChainId: 124 }, { ...deployment, genesisHash: "0xef" },
      { ...deployment, l1ChainId: 457n }, { ...deployment, inboxAddress: "0xef" }]) {
      expect(relayDeploymentKey(other)).not.toBe(key);
    }
  });
});

describe("relay reconciliation", () => {
  it("does not mistake another sender or transaction for this relay", async () => {
    const node = {
      status,
      getInboxDeliveryBatch: vi.fn().mockResolvedValue(batch),
      getReceipt: vi.fn().mockResolvedValue([
        receipt({ l1Sender: "bob" }),
        receipt({ inclusion: { l1TransactionHash: "other" } as ReceiptResult["inclusion"] }),
      ]),
    };
    const observed = await reconcileAttempt(node, attempt, "Alice");
    expect(observed.status).toBe("included");
    expect(observed.collectedFee).toBeUndefined();
    expect(observed.acceptedCount).toBeUndefined();
  });

  it("waits for canonical delivery even when another relayer already succeeded", async () => {
    const node = { status, getInboxDeliveryBatch: vi.fn().mockResolvedValue(null), getReceipt: vi.fn().mockResolvedValue([receipt()]) };
    expect(await reconcileAttempt(node, attempt, "alice")).toBe(attempt);
    expect(node.getReceipt).not.toHaveBeenCalled();
  });

  it("counts confirmed results and only the fee and issuance paid to this relayer's destinations", async () => {
    const node = {
      status,
      getInboxDeliveryBatch: vi.fn().mockResolvedValue({ ...batch, items: [batchItem("one"), batchItem("two", 1n), batchItem("three", 2n)] }),
      getReceipt: vi.fn()
        .mockResolvedValueOnce([receipt({ contentHash: "one" })])
        .mockResolvedValueOnce([receipt({ contentHash: "two", issuanceOwnerCommitment: "bob" })])
        .mockResolvedValueOnce([receipt({ contentHash: "three", outcome: "nullifierAlreadySpent", settledOpenFeeAmount: 0n, settledIssuanceAmount: 0n })]),
    };
    expect(await reconcileAttempt(node, { ...attempt, contentHashes: ["one", "two", "three"] }, "alice")).toMatchObject({
      status: "finalized", collectedFee: 12n, collectedIssuance: 5n, acceptedCount: 2, skippedCount: 1,
    });
  });

  it("finishes delivered batches whose entries were all excluded", async () => {
    const node = {
      status,
      getInboxDeliveryBatch: vi.fn().mockResolvedValue({ ...batch, items: [{ ...batchItem(), exclusionReason: "wrongChainId" }] }),
      getReceipt: vi.fn(),
    };
    expect(await reconcileAttempt(node, attempt, "alice")).toMatchObject({
      status: "finalized", acceptedCount: 0, skippedCount: 1, collectedFee: 0n, collectedIssuance: 0n,
    });
    expect(node.getReceipt).not.toHaveBeenCalled();
  });

  it("clears a prior tracking error once the delivery is confirmed", async () => {
    const node = { status, getInboxDeliveryBatch: vi.fn().mockResolvedValue(batch), getReceipt: vi.fn().mockResolvedValue([receipt()]) };
    const confirmed = await reconcileAttempt(node, { ...attempt, error: "Tracking timed out" }, "alice");
    expect(confirmed.status).toBe("finalized");
    expect(confirmed.error).toBeUndefined();
  });

  it("shows inclusion and collected compensation before finality", async () => {
    const node = {
      status: vi.fn().mockResolvedValueOnce({ finalizedL1BlockNumber: 9n }).mockResolvedValueOnce({ finalizedL1BlockNumber: 10n }),
      getInboxDeliveryBatch: vi.fn().mockResolvedValue(batch),
      getReceipt: vi.fn().mockResolvedValue([receipt()]),
    };
    const included = await reconcileAttempt(node, attempt, "alice");
    expect(included).toMatchObject({ status: "included", collectedFee: 12n, collectedIssuance: 5n, acceptedCount: 1 });
    expect(await reconcileAttempt(node, included, "alice")).toMatchObject({ status: "finalized", collectedFee: 12n, collectedIssuance: 5n });
  });

  it("ignores a different batch returned for the requested transaction hash", async () => {
    const node = {
      status,
      getInboxDeliveryBatch: vi.fn().mockResolvedValue({ ...batch, l1TransactionHash: "other" }),
      getReceipt: vi.fn().mockResolvedValue([receipt()]),
    };
    expect(await reconcileAttempt(node, attempt, "alice")).toBe(attempt);
    expect(node.getReceipt).not.toHaveBeenCalled();
  });

  it("counts each requested content hash once despite unrelated or duplicate receipts", async () => {
    const node = {
      status,
      getInboxDeliveryBatch: vi.fn().mockResolvedValue(batch),
      getReceipt: vi.fn().mockResolvedValue([
        receipt({ contentHash: "unrelated", settledOpenFeeAmount: 100n }),
        receipt({ inclusion: { l1TransactionHash: "other" } as ReceiptResult["inclusion"], settledOpenFeeAmount: 100n }),
        receipt(), receipt(),
      ]),
    };
    expect(await reconcileAttempt(node, attempt, "alice")).toMatchObject({
      status: "finalized", acceptedCount: 1, skippedCount: 0, collectedFee: 12n,
    });
  });

  it("waits for an included receipt while the index catches up", async () => {
    const node = {
      status,
      getInboxDeliveryBatch: vi.fn().mockResolvedValue(batch),
      getReceipt: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([receipt()]),
    };
    expect(await reconcileAttempt(node, attempt, "alice")).toMatchObject({ status: "included" });
    expect(node.getReceipt).toHaveBeenCalledWith({ inclusionId: {
      l1BlockHash: "block", l1TransactionIndex: 2n, batchItemIndex: 0n,
    } });
    expect(await reconcileAttempt(node, attempt, "alice")).toMatchObject({
      status: "finalized", acceptedCount: 1, skippedCount: 0, collectedFee: 12n,
    });
  });

  it("waits when the delivery manifest has no selected item", async () => {
    const node = {
      status,
      getInboxDeliveryBatch: vi.fn().mockResolvedValue({ ...batch, items: [] }),
      getReceipt: vi.fn(),
    };
    expect(await reconcileAttempt(node, attempt, "alice")).toMatchObject({ status: "included" });
    expect(node.getReceipt).not.toHaveBeenCalled();
  });

  it("counts a whole excluded batch as skipped without querying receipts", async () => {
    const node = {
      status,
      getInboxDeliveryBatch: vi.fn().mockResolvedValue({ ...batch, items: [], exclusionReason: "batchCountLimit" }),
      getReceipt: vi.fn(),
    };
    expect(await reconcileAttempt(node, { ...attempt, contentHashes: ["one", "two"] }, "alice")).toMatchObject({
      status: "finalized", acceptedCount: 0, skippedCount: 2, collectedFee: 0n,
    });
    expect(node.getReceipt).not.toHaveBeenCalled();
  });

  it("combines an included receipt with an explicitly excluded item", async () => {
    const node = {
      status,
      getInboxDeliveryBatch: vi.fn().mockResolvedValue({ ...batch, items: [
        batchItem(), { ...batchItem("excluded", 1n), exclusionReason: "wrongChainId" },
      ] }),
      getReceipt: vi.fn().mockResolvedValue([receipt()]),
    };
    expect(await reconcileAttempt(node, { ...attempt, contentHashes: ["content", "excluded"] }, "alice")).toMatchObject({
      status: "finalized", acceptedCount: 1, skippedCount: 1, collectedFee: 12n,
    });
    expect(node.getReceipt).toHaveBeenCalledTimes(1);
  });

  it("keeps an all-excluded batch tracking if its finalized inclusion disappears", async () => {
    const excludedBatch = { ...batch, items: [], exclusionReason: "batchCountLimit" };
    const node = {
      status,
      getInboxDeliveryBatch: vi.fn().mockResolvedValueOnce(excludedBatch).mockResolvedValueOnce(null).mockResolvedValueOnce(null),
      getReceipt: vi.fn(),
    };
    const waiting = await reconcileAttempt(node, attempt, "alice");
    expect(waiting).toMatchObject({ status: "included", l1BlockHash: "block" });
    expect(isRelayAttemptTracking(waiting)).toBe(true);
    expect(node.getInboxDeliveryBatch).toHaveBeenCalledTimes(2);
    expect(await reconcileAttempt(node, waiting, "alice")).toMatchObject({ status: "pending" });
  });
});

describe("provisional relay outcomes", () => {
  it("clears inclusion and collected compensation if the batch disappears in a reorg", async () => {
    const node = { status: vi.fn().mockResolvedValue({ finalizedL1BlockNumber: 9n }),
      getInboxDeliveryBatch: vi.fn().mockResolvedValueOnce(batch).mockResolvedValueOnce(null),
      getReceipt: vi.fn().mockResolvedValue([receipt()]) };
    const included = await reconcileAttempt(node, attempt, "alice");
    expect(included.status).toBe("included");
    const removed = await reconcileAttempt(node, included, "alice");
    expect(removed).toMatchObject({ status: "pending" });
    expect(removed.collectedFee).toBeUndefined();
    expect(removed.collectedIssuance).toBeUndefined();
    expect(removed.acceptedCount).toBeUndefined();
    expect(removed.l1BlockHash).toBeUndefined();
  });

  it("does not carry collected compensation onto a replacement inclusion while its receipts are unavailable", async () => {
    const node = { status: vi.fn().mockResolvedValue({ finalizedL1BlockNumber: 9n }),
      getInboxDeliveryBatch: vi.fn().mockResolvedValueOnce(batch).mockResolvedValueOnce({ ...batch, l1BlockHash: "replacement" }),
      getReceipt: vi.fn().mockResolvedValueOnce([receipt()]).mockRejectedValueOnce(new Error("catching up")) };
    const included = await reconcileAttempt(node, attempt, "alice");
    const replacement = await reconcileAttempt(node, included, "alice");
    expect(replacement).toMatchObject({ status: "included", l1BlockHash: "replacement" });
    expect(replacement.collectedFee).toBeUndefined();
  });

  it("does not finalize a cached outcome while the exact-inclusion receipt is rejected", async () => {
    const node = { status, getInboxDeliveryBatch: vi.fn().mockResolvedValue(batch),
      getReceipt: vi.fn().mockRejectedValueOnce(new Error("catching up")).mockResolvedValueOnce([receipt()]) };
    const cached = { ...attempt, status: "included", l1BlockHash: "block", collectedFee: 12n, collectedIssuance: 5n, acceptedCount: 1, skippedCount: 0 } as RelayAttempt;
    const waiting = await reconcileAttempt(node, cached, "alice");
    expect(waiting.status).toBe("included");
    expect(waiting).toMatchObject({ collectedFee: 12n, collectedIssuance: 5n, acceptedCount: 1, skippedCount: 0 });
    expect(isRelayAttemptTracking(waiting)).toBe(true);
    const completed = await reconcileAttempt(node, waiting, "alice");
    expect(completed.status).toBe("finalized");
    expect(completed.collectedFee).toBe(12n);
    expect(isRelayAttemptTracking(completed)).toBe(false);
  });

  it("does not finalize a cached outcome while the exact-inclusion receipt is empty", async () => {
    const node = { status, getInboxDeliveryBatch: vi.fn().mockResolvedValue(batch),
      getReceipt: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([receipt()]) };
    const cached = { ...attempt, status: "included", l1BlockHash: "block", collectedFee: 12n, collectedIssuance: 5n, acceptedCount: 1, skippedCount: 0 } as RelayAttempt;
    const waiting = await reconcileAttempt(node, cached, "alice");
    expect(waiting).toMatchObject({ status: "included", l1BlockHash: "block", collectedFee: 12n, collectedIssuance: 5n, acceptedCount: 1, skippedCount: 0 });
    expect(isRelayAttemptTracking(waiting)).toBe(true);
    const completed = await reconcileAttempt(node, waiting, "alice");
    expect(completed).toMatchObject({ status: "finalized", collectedFee: 12n, collectedIssuance: 5n, acceptedCount: 1, skippedCount: 0 });
    expect(isRelayAttemptTracking(completed)).toBe(false);
  });

  it("finds a known batch only in this network's tab history", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    saveRelayHistory(relayHistoryKey("one", "alice"), [attempt]);
    expect(findRelayAttempt("one", "transaction")).toEqual(attempt);
    expect(findRelayAttempt("two", "transaction")).toBeUndefined();
    expect(findRelayAttempt("one", "unknown")).toBeUndefined();
  });
});

it("excludes returned own payment fees from earnings while retaining their issuance", async () => {
  const node = { status, getInboxDeliveryBatch: vi.fn().mockResolvedValue(batch), getReceipt: vi.fn().mockResolvedValue([receipt()]) };
  expect(await reconcileAttempt(node, { ...attempt, ownContentHashes: ["CONTENT"] }, "alice"))
    .toMatchObject({ collectedFee: 0n, collectedIssuance: 5n });
});


describe("positive terminal relay recovery", () => {
  const released = [{ resolutionId: "journal-one", transactionHash: "transaction", selected: ["content"] }];
  it("ends a positively released attempt and clears previous settlement display fields", () => {
    const row = { ...attempt, resolutionId: "journal-one", collectedFee: 10n, collectedIssuance: 20n };
    const next = applyReleasedRelayAttempts([row], released)[0]!;
    expect(next.status).toBe("failed");
    expect(next.error).toContain("dropped or replaced");
    expect(next.collectedFee).toBeUndefined();
    expect(next.collectedIssuance).toBeUndefined();
  });
  it("requires the recorded resolution identity before considering weaker matches", () => {
    const rows = [{ ...attempt, resolutionId: "another-journal" }];
    expect(applyReleasedRelayAttempts(rows, released)).toBe(rows);
  });
  it("matches a known hash or an exact unhashed selected set, without ending another hash", () => {
    expect(applyReleasedRelayAttempts([attempt], released)[0]!.status).toBe("failed");
    const { txHash: _hash, ...unhashed } = attempt;
    expect(applyReleasedRelayAttempts([{ ...unhashed, contentHashes: ["A", "B"] }], [{ ...released[0]!, transactionHash: null, selected: ["b", "a"] }])[0]!.status).toBe("failed");
    for (const row of [{ ...attempt, txHash: "another-hash" }, { ...unhashed, contentHashes: ["content", "extra"] }]) {
      expect(applyReleasedRelayAttempts([row], released)[0]).toBe(row);
    }
  });
  it("does not infer failure from a missing journal or overwrite canonical inclusion", () => {
    const rows = [attempt, { ...attempt, status: "included" as const }, { ...attempt, status: "finalized" as const }];
    expect(applyReleasedRelayAttempts(rows, [])).toBe(rows);
    const next = applyReleasedRelayAttempts(rows, released);
    expect(next[1]).toBe(rows[1]);
    expect(next[2]).toBe(rows[2]);
  });
  it("persists recovery outside Get PCASH and informs a mounted consumer in the same tab", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    vi.stubGlobal("window", new EventTarget());
    const key = relayHistoryKey("deployment", "alice");
    const other = relayHistoryKey("deployment", "bob");
    saveRelayHistory(key, [attempt]);
    saveRelayHistory(other, [attempt]);
    let mountedRows = [attempt];
    const receive = vi.fn((event: Event) => {
      const detail = (event as CustomEvent<RelayAttemptsReleasedDetail>).detail;
      if (detail.historyKey === key) mountedRows = applyReleasedRelayAttempts(mountedRows, detail.released);
    });
    window.addEventListener(RELAY_ATTEMPTS_RELEASED_EVENT, receive);
    publishReleasedRelayAttempts(key, released);
    expect(receive).toHaveBeenCalledOnce();
    expect(readRelayHistory(key)[0]!.status).toBe("failed");
    expect(mountedRows[0]!.status).toBe("failed");
    expect(readRelayHistory(other)[0]!.status).toBe("pending");
  });
});


describe("successful publication recovery", () => {
  const recovered = [{ resolutionId: "saved-wallet", transactionHash: "known-hash", selected: ["content"] }];
  const saved: RelayAttempt = { id: "saved", at: 0, status: "wallet", resolutionId: "saved-wallet", contentHashes: ["content"] };
  it("recovers a hash without downgrading canonical or failed rows", () => {
    const rows = [saved, { ...saved, status: "included" as const }, { ...saved, status: "finalized" as const }, { ...saved, status: "failed" as const }];
    const next = applyRecoveredRelayAttempts(rows, recovered);
    expect(next[0]).toMatchObject({ status: "pending", txHash: "known-hash", resolutionId: "saved-wallet" });
    expect(next.slice(1)).toEqual(rows.slice(1));
    expect(applyRecoveredRelayAttempts(rows, [])).toBe(rows);
  });
  it("publishes recovered hashes to storage and the same-tab listener before Get mounts", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    vi.stubGlobal("window", new EventTarget());
    const key = relayHistoryKey("deployment", "alice");
    saveRelayHistory(key, [saved]);
    const receive = vi.fn();
    window.addEventListener(RELAY_ATTEMPTS_RELEASED_EVENT, receive);
    publishReleasedRelayAttempts(key, [], recovered);
    expect(readRelayHistory(key)[0]).toMatchObject({ status: "pending", txHash: "known-hash" });
    expect((receive.mock.calls[0]![0] as CustomEvent<RelayAttemptsReleasedDetail>).detail).toEqual({ historyKey: key, released: [], recovered });
    publishReleasedRelayAttempts(key, [recovered[0]!], recovered);
    expect(readRelayHistory(key)[0]!.status).toBe("failed");
  });
});
