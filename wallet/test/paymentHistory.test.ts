import { memoSchema, claimedSenderSchema, storeTransactionData } from "@pcash/sdk/delivery";
import { PGlite } from "@electric-sql/pglite";
import { expect, it, vi } from "vitest";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { boundaryId } from "@pcash/sdk/protocol";
import { OPEN_WALLET_INTERNAL, Wallet } from "@pcash/sdk/wallet";
import { reconcilePendingNoteFundedTransfers } from "@pcash/sdk/wallet/testing";
import { PGliteWalletDatabase } from "../src/pgliteDatabase.ts";
import { WALLET_DATABASE_STATE_STORE } from "@pcash/sdk/wallet/database";
import { emptyWalletState } from "@pcash/sdk/wallet/testing";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import { TEST_PRIV_KEY } from "./testWallet.ts";
import { testStatus } from "./statusFixture.ts";
import { anchoredChain } from "./chainFixture.ts";

const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const contentHash = word(50);
const nullifiers = [1, 2, 3, 4].map(word);
const profile = derivePcashProfileFromPrivateKey(TEST_PRIV_KEY, {
  pcashChainId: 8191n, l1ChainId: 11155111n, inboxAddress: `0x${"22".repeat(20)}`,
});
const identity = { address: profile.address, network: { chainId: 8191n, genesisHash: word(11) } };

/** Local chain state synced through block 10, where the transaction with `content` consumed every nullifier. */
function syncedChain(content: string | null) {
  return anchoredChain({ blockNumber: 10n, consumed: content === null ? [] : [[nullifiers[0]!, {
    pcashNumber: 10n, pcashHash: word(10), timestamp: 1_800_000_120n, transactionId: word(51), contentHash: content, nullifiers,
  }]] });
}

for (const state of ["succeeded", "expired", "conflicted"] as const) {
  for (const { selected, kind } of [{ selected: false, kind: "payment" }, { selected: true, kind: "payment" }, { selected: false, kind: "mine" }] as const) {
  it(`retains ${state} ${selected ? "selected" : "open"} ${kind} details after journal retirement and wallet reopen`, async () => {
    const db = await PGliteWalletDatabase.open(await PGlite.create("memory://"), { ownsClient: true });
    const store = db[WALLET_DATABASE_STATE_STORE](identity);
    const data = emptyWalletState(identity);
    const requestData = { recipients: [{ to: "private-receive-code", records: [memoSchema.encode("rent — March"), claimedSenderSchema.encode(1n)] }] };
    data.pendingNoteFundedTransfers = [{
      contentHash, transactionHex: "0x00", notBeforeTimestamp: "0", validUntilTimestamp: "100",
      kind,
      transferAmount: kind === "mine" ? "0" : "5", openFeeAmount: kind === "mine" || selected ? "0" : "1", privateRelayFeeAmount: selected ? "2" : "0",
      privateRelayRecipient: selected ? "0x000000000000000000000000000000000000007b" : null,
      issuanceOwnerCommitment: selected ? "1" : "0", issuanceRecipient: selected ? "0x000000000000000000000000000000000000007b" : null,
      recipient: "private-receive-code",
      recipientAddress: `0x${"bb".repeat(20)}`,
      ...(kind === "payment" ? { data: storeTransactionData(requestData)! } : {}),
      inputs: [{ nullifier: nullifiers[0]!, spentCommitment: null }], change: null,
    }];
    await store.save(data);
    let final = false;
    const chain = syncedChain(state === "expired" ? null : state === "conflicted" ? word(60) : contentHash);
    const status = () => testStatus({ pcashChainId: 8191, genesisHash: word(11), latestBlock: 10n,
      latestBlockHash: boundaryId(chain.boundary), finalizedBlock: final ? 10n : 9n,
      finalizedBlockTimestamp: final ? 101n : 99n });
    const node = { status: async () => status() } as unknown as PcashNodeClient;
    const pending = (await store.load())!;
    const competing = (await store.load())!;
    expect(reconcilePendingNoteFundedTransfers(pending, chain.state(), status())).toBe(false);
    expect(pending.pendingNoteFundedTransfers).toHaveLength(1);
    expect(pending.paymentHistory).toBeUndefined();
    final = true;
    expect(reconcilePendingNoteFundedTransfers(pending, chain.state(), status())).toBe(true);
    await store.save(pending);
    if (state === "succeeded") {
      const observedAt = pending.paymentHistory![0]!.resolvedAtUnixMs;
      const clock = vi.spyOn(Date, "now").mockReturnValue(Number(observedAt) + 10_000);
      try {
        expect(reconcilePendingNoteFundedTransfers(competing, chain.state(), status())).toBe(true);
        expect(competing.paymentHistory![0]!.resolvedAtUnixMs).not.toBe(observedAt);
        await store.save(competing);
        expect((await store.load())!.paymentHistory).toEqual(pending.paymentHistory);
      } finally { clock.mockRestore(); }
    }
    const first = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node, profile });
    expect((await first.snapshot()).pendingPayments).toEqual([]);
    await first.close();
    const reopened = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node, profile });
    const history = (await reopened.snapshot()).paymentHistory;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ kind, contentHash, deliveryTarget: "private-receive-code",
      amount: kind === "mine" ? 0n : 5n, openFeeAmount: kind === "mine" || selected ? 0n : 1n, privateRelayFeeAmount: selected ? 2n : 0n,
      privateRelayRecipient: selected ? "0x000000000000000000000000000000000000007b" : null, state,
      ...(kind === "payment" ? { data: { ...requestData, self: [] } } : {}) });
    if (kind === "mine") expect(history[0]).not.toHaveProperty("data");
    expect(history[0]!.resolvedAtUnixMs).toBeGreaterThan(0n);
    if (state === "expired") expect(history[0]!.receipt).toBeUndefined();
    else expect(history[0]!.receipt).toEqual({ transactionId: word(51), pcashBlockNumber: 10n, pcashBlockHash: word(10) });
    expect((await reopened.snapshot()).pendingActionCount).toBe(0);
    await reopened.close();
    await db.close();
  });
  }
}

it("expires setup mining that no Ethereum transaction carried without leaving history", async () => {
  const data = emptyWalletState(identity);
  const mining = {
    contentHash, transactionHex: "0x0abc", notBeforeTimestamp: "0", validUntilTimestamp: "100", kind: "mine" as const,
    transferAmount: "0", openFeeAmount: "0", privateRelayFeeAmount: "0", privateRelayRecipient: null,
    issuanceOwnerCommitment: "0", issuanceRecipient: null, recipient: `0x${"bb".repeat(20)}`,
    recipientAddress: `0x${"bb".repeat(20)}`, inputs: [{ nullifier: nullifiers[0]!, spentCommitment: null }], change: null,
  };
  data.pendingUserAccountCreations = [{
    contentHash: word(60), miningTransactionHex: "0x0abc", transactionHex: "0x0def", address: `0x${"bb".repeat(20)}`,
    pcashChainId: "8191", pcashGenesisHash: word(11), l1ChainId: "11155111", inboxAddress: `0x${"22".repeat(20)}`,
    genesisL1Block: "0", genesisL1BlockHash: word(12), ruleSetCommitment: "0", receiveKeyHash: word(13),
    recentPcashBlockNumber: "0", recentPcashBlockHash: word(14), validUntilTimestamp: "100",
    state: "prepared", l1TxHash: null, preparedAtUnixMs: "0",
  }];
  const chain = syncedChain(null);
  const status = testStatus({ pcashChainId: 8191, genesisHash: word(11), latestBlock: 10n,
    latestBlockHash: boundaryId(chain.boundary), finalizedBlock: 10n, finalizedBlockTimestamp: 101n });
  // An ambiguous payment or mine without a hash is still the user's: it expires into history.
  const ambiguous = structuredClone(data);
  delete ambiguous.pendingUserAccountCreations;
  ambiguous.pendingNoteFundedTransfers = [{ ...mining }];
  expect(reconcilePendingNoteFundedTransfers(ambiguous, chain.state(), status)).toBe(true);
  expect(ambiguous.paymentHistory).toEqual([expect.objectContaining({ contentHash, state: "expired" })]);

  data.pendingNoteFundedTransfers = [{ ...mining }];
  expect(reconcilePendingNoteFundedTransfers(data, chain.state(), status)).toBe(true);
  expect(data.pendingNoteFundedTransfers).toBeUndefined();
  expect(data.paymentHistory).toBeUndefined();
});
