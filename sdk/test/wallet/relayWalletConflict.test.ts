import { keccak256, toHex } from "@pcash/sdk/utils";
import { contractCreationFixture } from "./contractCreationFixture.ts";
import { encodeBatch } from "@pcash/sdk/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { Relayer, type RelayCarrierQuote, type RelaySubmitter } from "@pcash/sdk/relay";
import { FileRelayJournal } from "@pcash/sdk/node";
import { awaitingAcceptance, createL1SubmissionAdapter } from "../../src/wallet/submission.ts";
import { RelayJournalConflictError, RelayUpstreamError, type RelayJournalEntry } from "@pcash/sdk/relay";
import { testStatus } from "./statusFixture.ts";

const CONTENT_HASH = toHex(keccak256(contractCreationFixture(1)));
const HEAD_HASH = `0x${"22".repeat(32)}`;
const ADDRESS = `0x${"33".repeat(20)}`;

const temporaryDirectories: string[] = [];



const relayQuote: RelayCarrierQuote = {
  carrier: "calldata",
  gasLimit: 21_000n,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 1n,
  maxFeePerBlobGas: null,
  blobCount: 0,
  blobVersionedHashes: [],
  estimatedCostWei: 42_000n,
  maximumCostWei: 42_000n,
  balanceWei: 100_000n,
};

function journalEntry(): RelayJournalEntry {
  return {
    kind: "batch",
    createdAt: new Date(0).toISOString(),
    resolutionId: HEAD_HASH,
    phase: "broadcast_attempted",
    submissionKind: "signed_raw",
    transactionHash: HEAD_HASH,
    signedTransaction: "0x02",
    previousTransactionHashes: [],
    lastBroadcastBlock: "9",
    carrier: "calldata",
    batch: toHex(encodeBatch([contractCreationFixture(1)], 123n, 0n)),
    selected: [CONTENT_HASH],
    batchItemIndexes: ["0"],
    observationMode: "selected",
    collectibleOpenFee: "1",
    relayerAddress: ADDRESS,
    chainId: "1",
    inboxAddress: ADDRESS,
    nonce: "1",
    gasLimit: "21000",
    maxFeePerGas: "10",
    maxPriorityFeePerGas: "1",
    maxFeePerBlobGas: null,
    genesisL1Block: "0",
    genesisL1BlockHash: HEAD_HASH,
    headCheckedBlock: "1",
    headCheckedBlockHash: HEAD_HASH,
  };
}

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "pcash-wallet-relay-conflict-"));
  temporaryDirectories.push(dataDir);
  const journal = new FileRelayJournal(join(dataDir, "relay-journal"));
  const admit = vi.fn(async () => ({ contentHash: CONTENT_HASH }));
  const current = testStatus({
    latestBlock: 1n,
    latestBlockHash: HEAD_HASH,
    genesisHash: HEAD_HASH,
    acceptedTransactionTypes: [0, 2],
  });
  const node = {
    status: async () => current,
    getMempool: async () => ({ items: [], nextCursor: null }),
    getMempoolTransaction: async () => null,
    submitRawTransaction: admit,
    getReceipt: async () => [],
    prepareRelay: async ({ contentHashes }: { contentHashes: string[] }) => ({
      selectedTransactions: contentHashes.map(() => toHex(contractCreationFixture(1))),
      selectedContentHashes: contentHashes,
      rejected: [],
      collectibleOpenFee: 1n,
      batchBytes: BigInt(71 + contractCreationFixture(1).length),
      headCheckedBlock: 1n,
      headCheckedBlockHash: HEAD_HASH,
    }),
  } as unknown as PcashNodeClient;
  const submitter: RelaySubmitter = {
    address: ADDRESS,
    supportedCarriers: ["calldata", "blobs"],
    // One in-flight transaction, as the SDK submitters default to.
    assertAvailable: async () => {
      const [entry] = await journal.read();
      if (entry !== undefined) throw new RelayJournalConflictError(`relay journal ${entry.resolutionId} is pending`);
    },
    inFlight: async () => [],
    quote: async () => ({ selected: relayQuote, calldata: relayQuote }),
    send: async () => {
      await journal.create(journalEntry());
      throw new RelayUpstreamError("ambiguous broadcast");
    },
  };
  const relay = new Relayer({ node, payoutRecipient: { address: 1n, nkRoot: 2n }, submitterFor: () => submitter });
  return { admit, current, node, relay, submitter };
}

async function walletAttempt(test: ReturnType<typeof fixture>) {
  const adapter = awaitingAcceptance(createL1SubmissionAdapter({
    node: test.node,
    submitterFor: () => test.submitter,
    payoutRecipient: () => ({ address: 1n, nkRoot: 2n }),
  }), { node: test.node, pollIntervalMs: 1, pollMaxAttempts: 1 });
  const entry = contractCreationFixture(test.current.pcashChainId);
  const prepared = await adapter.preflight({
    transactionBytes: entry,
    status: test.current,
    retry: false,
  });
  return adapter.submit({ transactionBytes: entry, status: test.current, retry: false, prepared });
}

describe("shared wallet relay journal", () => {
  it("blocks wallet L1 submission after an unresolved direct relay", async () => {
    const test = fixture();
    await expect(test.relay.relay({ contentHashes: [CONTENT_HASH] })).rejects.toBeInstanceOf(RelayUpstreamError);
    await expect(walletAttempt(test)).rejects.toBeInstanceOf(RelayJournalConflictError);
    expect(test.admit).not.toHaveBeenCalled();
  });

  it("blocks a later direct relay after an unresolved wallet one-off relay", async () => {
    const test = fixture();
    await expect(walletAttempt(test)).rejects.toBeInstanceOf(RelayUpstreamError);
    expect(test.admit).not.toHaveBeenCalled();
    await expect(test.relay.relay({ contentHashes: [CONTENT_HASH] }))
      .rejects.toBeInstanceOf(RelayJournalConflictError);
  });
});
