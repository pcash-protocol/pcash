import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex, keccak256, numberToHex } from "viem";
import {
  DEFAULT_NETWORK_CONFIG,
  encodeContractAccountCreation,
  encodeUserAccountCreation,
  PcashNodeRpcError,
  RECENT_PCASH_BLOCK_WINDOW_SECONDS,
  type MempoolItemResult,
  type PcashNodeClient,
} from "@pcash/sdk/browser";
import { buildDirectReferenceUserAccountCreation } from "@pcash/sdk/builders";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import {
  isStaleTransactionAnchorError,
  restoreMarketplaceTransactionToMempool,
  submitMarketplaceTransactionToMempool,
} from "../src/client/mempoolSubmission.ts";
import { createMempoolSubmissionAdapter, DurablePreBroadcastError } from "@pcash/sdk/wallet";
import {
  anchoredPrivateValueTransaction,
  sponsoredContractFunding,
  fixtureContractBody,
} from "./anchoredTransaction.ts";

const ANCHOR = 0x5151n;
const ANCHOR_HEX = numberToHex(ANCHOR, { size: 32 });
const LATEST_TIMESTAMP = 10_000n;
const anchorBlock = (age: bigint) => ({ hash: ANCHOR_HEX, timestamp: LATEST_TIMESTAMP - age });
const restoredEntry = anchoredPrivateValueTransaction(ANCHOR);
const restoredTransactionHex = bytesToHex(restoredEntry);
const restoredContentHash = keccak256(restoredTransactionHex);
const CAPABILITIES = {
  pcashChainId: Number(DEFAULT_NETWORK_CONFIG.pcashChainId),
  genesisHash: `0x${"66".repeat(32)}`,
  acceptedTransactionTypes: [0, 1, 2, 3],
  acceptedBatchVersions: [1],
  latestBlockTimestamp: LATEST_TIMESTAMP,
};
/** A node whose head still admits the saved anchor; tests override the methods they exercise. */
function anchoredNode(overrides: Record<string, unknown>): PcashNodeClient {
  return {
    status: async () => CAPABILITIES,
    getBlockByHash: async (hash: string) => {
      assert.equal(hash, ANCHOR_HEX);
      return anchorBlock(RECENT_PCASH_BLOCK_WINDOW_SECONDS);
    },
    ...overrides,
  } as unknown as PcashNodeClient;
}

function mempoolItem(status: string): MempoolItemResult {
  return {
    contentHash: restoredContentHash,
    statementId: `0x${"11".repeat(32)}`,
    stableId: `0x${"22".repeat(32)}`,
    conflictKeys: [],
    kind: "privateValue",
    fundingMode: null,
    byteSize: BigInt(restoredEntry.length),
    openFeeAmount: 0n,
    issuanceOwnerCommitment: `0x${"00".repeat(32)}`,
    issuanceRoute: "open",
    validUntil: null,
    status,
    conflictCount: 0n,
    receivedAtUnixMs: 0n,
    headCheckedBlock: 1n,
    headCheckedBlockHash: `0x${"33".repeat(32)}`,
    recentPcashBlockHash: null,
    publicRecords: [],
    rawTransaction: restoredTransactionHex,
  };
}

function acceptedReceipt(): Record<string, unknown> {
  return {
    contentHash: restoredContentHash,
    transactionId: `0x${"e1".repeat(32)}`,
    outcome: "succeeded",
    failureDetail: null,
    l1Sender: "0x0000000000000000000000000000000000000000",
    issuanceOwnerCommitment: null,
    settledOpenFeeAmount: 0n,
    settledIssuanceAmount: 0n,
    kind: "privateValue",
    outputLeafStart: null,
    inclusion: {
      l1BlockNumber: 1n,
      l1BlockHash: `0x${"44".repeat(32)}`,
      l1TransactionIndex: 0n,
      batchItemIndex: 0n,
    },
  };
}

test("marketplace exact bytes are checkpointed before mempool admission", async () => {
  const entry = Uint8Array.of(1, 2, 3);
  const contentHash = keccak256(entry);
  const events: string[] = [];
  const result = await submitMarketplaceTransactionToMempool({
    node: {} as PcashNodeClient,
    transactionBytes: entry,
    onPrepared: () => {
      events.push("checkpoint");
    },
    submit: async () => {
      events.push("admit");
      return { contentHash, receipt: null, queued: true };
    },
  });
  assert.equal(result.contentHash, contentHash);
  assert.deepEqual(events, ["checkpoint", "admit"]);
});

test("marketplace persistence failure prevents mempool admission", async () => {
  let admitted = false;
  await assert.rejects(
    submitMarketplaceTransactionToMempool({
      node: {} as PcashNodeClient,
      transactionBytes: Uint8Array.of(7, 8, 9),
      onPrepared: () => { throw new Error("storage full"); },
      submit: async () => {
        admitted = true;
        throw new Error("must not admit");
      },
    }),
    /storage full/,
  );
  assert.equal(admitted, false);
});

test("marketplace restore treats only a ready retained entry as relayable", async () => {
  let submitted = false;
  const node = anchoredNode({
    getReceipt: async () => [],
    getMempoolTransaction: async () => mempoolItem("ready"),
    submitRawTransaction: async () => {
      submitted = true;
      throw new Error("must not submit");
    },
  });
  assert.equal(await restoreMarketplaceTransactionToMempool({
    node,
    contentHash: restoredContentHash,
    transactionHex: restoredTransactionHex,
  }), "retained");
  assert.equal(submitted, false);
});

test("marketplace restore rejects a suspended retained entry without duplicate admission", async () => {
  let submitted = false;
  const node = anchoredNode({
    getReceipt: async () => [],
    getMempoolTransaction: async () => mempoolItem("suspended"),
    submitRawTransaction: async () => {
      submitted = true;
      throw new Error("must not submit");
    },
  });
  await assert.rejects(
    restoreMarketplaceTransactionToMempool({ node, contentHash: restoredContentHash, transactionHex: restoredTransactionHex }),
    /non-relayable mempool status suspended/,
  );
  assert.equal(submitted, false);
});

test("marketplace restore re-admits exact saved bytes and confirms ready retention", async () => {
  const events: string[] = [];
  let retained: MempoolItemResult | null = null;
  const node = anchoredNode({
    getReceipt: async () => [],
    getMempoolTransaction: async () => retained,
    submitRawTransaction: async (transactionHex: string) => {
      assert.equal(transactionHex, restoredTransactionHex);
      events.push("submit");
      retained = mempoolItem("ready");
      return {
        contentHash: restoredContentHash,
        statementId: `0x${"11".repeat(32)}`,
        stableId: `0x${"22".repeat(32)}`,
        status: "ready",
        headCheckedBlock: 1n,
        headCheckedBlockHash: `0x${"33".repeat(32)}`,
      };
    },
  });
  assert.equal(await restoreMarketplaceTransactionToMempool({
    node,
    contentHash: restoredContentHash,
    transactionHex: restoredTransactionHex,
    beforeSubmit: () => { events.push("before"); },
  }), "restored");
  assert.deepEqual(events, ["before", "submit"]);
});

test("marketplace restore verifies ready retention after an injected submitter queues exact bytes", async () => {
  let retained: MempoolItemResult | null = null;
  const node = anchoredNode({
    getReceipt: async () => [],
    getMempoolTransaction: async () => retained,
    submitRawTransaction: async (transactionHex: string) => {
      assert.equal(transactionHex, restoredTransactionHex);
      retained = mempoolItem("ready");
      return {
        contentHash: restoredContentHash,
        statementId: `0x${"11".repeat(32)}`,
        stableId: `0x${"22".repeat(32)}`,
        status: "ready",
        headCheckedBlock: 1n,
        headCheckedBlockHash: `0x${"33".repeat(32)}`,
      };
    },
  });
  assert.equal(await restoreMarketplaceTransactionToMempool({
    node,
    contentHash: restoredContentHash,
    transactionHex: restoredTransactionHex,
    submit: async (entry, params) => {
      assert.deepEqual(entry, restoredEntry);
      await params.node.submitRawTransaction(bytesToHex(entry));
      return { contentHash: restoredContentHash, receipt: null, queued: true };
    },
  }), "restored");
});

test("marketplace restore does not report success when admission leaves the entry suspended", async () => {
  let calls = 0;
  const node = anchoredNode({
    getReceipt: async () => [],
    getMempoolTransaction: async () => {
      calls++;
      return calls === 1 ? null : mempoolItem("suspended");
    },
    submitRawTransaction: async () => ({
      contentHash: restoredContentHash,
      statementId: `0x${"11".repeat(32)}`,
      stableId: `0x${"22".repeat(32)}`,
      status: "suspended",
      headCheckedBlock: 1n,
      headCheckedBlockHash: `0x${"33".repeat(32)}`,
    }),
  });
  await assert.rejects(
    restoreMarketplaceTransactionToMempool({ node, contentHash: restoredContentHash, transactionHex: restoredTransactionHex }),
    /non-relayable mempool status suspended/,
  );
});

test("marketplace restore recognizes canonical acceptance racing admission", async () => {
  let receiptReads = 0;
  const node = anchoredNode({
    getReceipt: async () => {
      receiptReads++;
      return receiptReads === 1 ? [] : [acceptedReceipt()];
    },
    getMempoolTransaction: async () => null,
    submitRawTransaction: async () => { throw new Error("ambiguous admission"); },
  });
  assert.equal(await restoreMarketplaceTransactionToMempool({
    node,
    contentHash: restoredContentHash,
    transactionHex: restoredTransactionHex,
  }), "receipt");
});

test("marketplace restore rejects an unsupported transaction type before raw admission", async () => {
  let submissions = 0;
  const node = anchoredNode({
    status: async () => ({ ...CAPABILITIES, acceptedTransactionTypes: [1, 2, 3] }),
    getReceipt: async () => [],
    getMempoolTransaction: async () => null,
    submitRawTransaction: async () => {
      submissions += 1;
      throw new Error("must reject before raw admission");
    },
  });

  await assert.rejects(restoreMarketplaceTransactionToMempool({
    node,
    contentHash: restoredContentHash,
    transactionHex: restoredTransactionHex,
  }), /transaction type 0x00 is not accepted/);
  assert.equal(submissions, 0);
});

test("marketplace restore refuses bytes whose anchor was orphaned instead of re-admitting them", async () => {
  let probes = 0;
  const node = anchoredNode({
    getReceipt: async () => [],
    getBlockByHash: async () => null,
    getMempoolTransaction: async () => {
      probes += 1;
      return null;
    },
    submitRawTransaction: async () => { throw new Error("must not submit"); },
  });
  await assert.rejects(
    restoreMarketplaceTransactionToMempool({ node, contentHash: restoredContentHash, transactionHex: restoredTransactionHex }),
    (error: unknown) => isStaleTransactionAnchorError(error)
      && error.reason === "orphaned"
      && error.contentHash === restoredContentHash
      && error.recentPcashBlockHash === ANCHOR_HEX,
  );
  assert.equal(probes, 0);
});

test("marketplace restore refuses bytes whose anchor aged past the recent-block window", async () => {
  const node = anchoredNode({
    getReceipt: async () => [],
    getBlockByHash: async () => anchorBlock(RECENT_PCASH_BLOCK_WINDOW_SECONDS + 1n),
    getMempoolTransaction: async () => { throw new Error("must not probe"); },
  });
  await assert.rejects(
    restoreMarketplaceTransactionToMempool({ node, contentHash: restoredContentHash, transactionHex: restoredTransactionHex }),
    (error: unknown) => isStaleTransactionAnchorError(error) && error.reason === "expired",
  );
});

test("marketplace restore keeps bytes whose anchor is exactly at the window edge", async () => {
  const node = anchoredNode({
    getReceipt: async () => [],
    getMempoolTransaction: async () => mempoolItem("ready"),
  });
  assert.equal(await restoreMarketplaceTransactionToMempool({
    node,
    contentHash: restoredContentHash,
    transactionHex: restoredTransactionHex,
  }), "retained");
});

for (const funding of [sponsoredContractFunding(ANCHOR), { mode: "unfunded", recentPcashBlockHash: ANCHOR, validUntilTimestamp: 1n } as const]) {
  test(`marketplace restore checks the anchor of a ${funding.mode} contract creation`, async () => {
    const contractEntry = encodeContractAccountCreation(DEFAULT_NETWORK_CONFIG.pcashChainId, fixtureContractBody(), funding);
    const node = anchoredNode({
      getReceipt: async () => [],
      getMempoolTransaction: async () => ({ ...mempoolItem("ready"), contentHash: keccak256(contractEntry) }),
    });
    assert.equal(await restoreMarketplaceTransactionToMempool({
      node,
      contentHash: keccak256(contractEntry),
      transactionHex: bytesToHex(contractEntry),
      submit: async () => ({ contentHash: keccak256(contractEntry), receipt: null, queued: true }),
    }), "retained");
  });
}

test("marketplace restore reports an accepted receipt before judging its anchor", async () => {
  const node = anchoredNode({
    getReceipt: async () => [acceptedReceipt()],
    getBlockByHash: async () => { throw new Error("an accepted entry needs no anchor"); },
  });
  assert.equal(await restoreMarketplaceTransactionToMempool({
    node,
    contentHash: restoredContentHash,
    transactionHex: restoredTransactionHex,
  }), "receipt");
});

function admittingNode(overrides: Record<string, unknown> = {}) {
  const admitted: string[] = [];
  const node = anchoredNode({
    getReceipt: async () => [],
    getMempoolTransaction: async () => null,
    submitRawTransaction: async (transactionHex: string) => {
      admitted.push(transactionHex);
      return { ...mempoolItem("ready"), contentHash: keccak256(transactionHex as `0x${string}`), status: "ready" };
    },
    ...overrides,
  });
  return { node, admitted };
}

function mempoolWallet(node: PcashNodeClient): import("@pcash/sdk/wallet").WalletExecutionContext {
  return { submission: createMempoolSubmissionAdapter(node) } as unknown as import("@pcash/sdk/wallet").WalletExecutionContext;
}

test("zero-open-fee open and designated claims reach the public mempool", async () => {
  const { createMarketplaceTransactionSubmitter } = await import("../src/client/submitBuiltTransaction.ts");
  const claim = anchoredPrivateValueTransaction(ANCHOR, 9n, 0n);
  const { node, admitted } = admittingNode();
  const submit = createMarketplaceTransactionSubmitter(mempoolWallet(node));
  assert.deepEqual(await submit(claim, { node }), { contentHash: keccak256(claim), receipt: null, queued: true });
  assert.deepEqual(admitted, [bytesToHex(claim)]);
  // Designated issuance is still a proof-bearing public mempool entry.
  const designated = anchoredPrivateValueTransaction(ANCHOR, 11n, 0n, 0x1234n);
  assert.deepEqual(await submit(designated, { node }), { contentHash: keccak256(designated), receipt: null, queued: true });
  assert.deepEqual(admitted, [bytesToHex(claim), bytesToHex(designated)]);

  const restored = admittingNode();
  assert.equal(await restoreMarketplaceTransactionToMempool({
    node: restored.node, contentHash: keccak256(claim), transactionHex: bytesToHex(claim), submit: createMarketplaceTransactionSubmitter(mempoolWallet(restored.node)),
  }), "restored");
  assert.deepEqual(restored.admitted, [bytesToHex(claim)]);
});

test("marketplace admission frees inputs only on the node's pre-insert refusal", async () => {
  const { submitBuiltTransaction } = await import("../src/client/submitBuiltTransaction.ts");
  const entry = anchoredPrivateValueTransaction(ANCHOR, 13n, 5n);
  const refusing = (code: number) => admittingNode({
    submitRawTransaction: async () => {
      throw new PcashNodeRpcError({ code, message: "refused" }, { method: "pcash_submitRawTransaction", url: "http://node" });
    },
  }).node;
  await assert.rejects(submitBuiltTransaction(entry, { node: refusing(-32_011) }), DurablePreBroadcastError);
  await assert.rejects(submitBuiltTransaction(entry, { node: refusing(-32_013) }), (error) => !(error instanceof DurablePreBroadcastError));
});

test("proof-free USER creation is refused, while a zero-open-fee proved creation reaches the public mempool", async () => {
  const { createMarketplaceTransactionSubmitter } = await import("../src/client/submitBuiltTransaction.ts");
  const creation = encodeContractAccountCreation(DEFAULT_NETWORK_CONFIG.pcashChainId, fixtureContractBody(), sponsoredContractFunding(ANCHOR, 1n, 0n));
  const { node, admitted } = admittingNode();
  const submit = createMarketplaceTransactionSubmitter(mempoolWallet(node));
  assert.deepEqual(await submit(creation, { node }), { contentHash: keccak256(creation), receipt: null, queued: true });
  assert.deepEqual(admitted, [bytesToHex(creation)]);

  const wallet = derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(23), DEFAULT_NETWORK_CONFIG);
  const proofFree = encodeUserAccountCreation(DEFAULT_NETWORK_CONFIG.pcashChainId,
    buildDirectReferenceUserAccountCreation({ chainId: DEFAULT_NETWORK_CONFIG.pcashChainId,
      wallet, defaultRuleSecrets: wallet.defaultUserRuleSecrets, recentPcashBlockHash: ANCHOR,
      validUntilTimestamp: 20_000n }).body);
  await assert.rejects(submit(proofFree, { node }), /proof-free USER creation must use owner-authorized Ethereum publication/);
  await assert.rejects(restoreMarketplaceTransactionToMempool({
    node, contentHash: keccak256(proofFree), transactionHex: bytesToHex(proofFree), submit,
  }), /proof-free USER creation must use owner-authorized Ethereum publication/);
  assert.deepEqual(admitted, [bytesToHex(creation)]);
});

test("an explicit L1 wallet adapter posts paid marketplace entries on Ethereum too", async () => {
  const { createMarketplaceTransactionSubmitter } = await import("../src/client/submitBuiltTransaction.ts");
  const entry = anchoredPrivateValueTransaction(ANCHOR, 13n, 5n);
  const contentHash = keccak256(entry);
  let posted = 0;
  const node = anchoredNode({
    getReceipt: async () => [],
    submitRawTransaction: async () => { throw new Error("an L1 publication must not use the mempool"); },
  });
  const wallet = {
    submission: {
      mode: "l1",
      preflight: async () => undefined,
      submit: async () => { posted += 1; return { accepted: false, queued: true, output: {} }; },
    },
  } as unknown as import("@pcash/sdk/wallet").WalletExecutionContext;
  await createMarketplaceTransactionSubmitter(wallet)(entry, { node });
  assert.equal(posted, 1);
});

test("zero-fee marketplace recovery uses the wallet L1 adapter without reading the mempool", async () => {
  const { createMarketplaceTransactionSubmitter } = await import("../src/client/submitBuiltTransaction.ts");
  const entry = anchoredPrivateValueTransaction(ANCHOR, 1n, 0n);
  const contentHash = keccak256(entry);
  let posted = 0;
  const node = anchoredNode({
    getReceipt: async () => [],
    getMempoolTransaction: async () => { throw new Error("zero-fee recovery must bypass mempool"); },
  });
  const wallet = {
    submission: {
      mode: "l1",
      preflight: async () => undefined,
      submit: async ({ transactionBytes: submitted }: { transactionBytes: Uint8Array }) => {
        assert.deepEqual(submitted, entry);
        posted += 1;
        return { accepted: false, queued: true, output: {} };
      },
    },
  } as unknown as import("@pcash/sdk/wallet").WalletExecutionContext;
  const result = await restoreMarketplaceTransactionToMempool({ node, contentHash, transactionHex: bytesToHex(entry), submit: createMarketplaceTransactionSubmitter(wallet) });
  assert.equal(result, "restored");
  assert.equal(posted, 1);
});

test("selected marketplace recovery re-admits exact designated bytes through the public mempool", async () => {
  const { createMarketplaceTransactionSubmitter } = await import("../src/client/submitBuiltTransaction.ts");
  const entry = anchoredPrivateValueTransaction(ANCHOR, 42n, 0n, 77n);
  const contentHash = keccak256(entry);
  const { node, admitted } = admittingNode();
  const wallet = {
    submission: {
      ...createMempoolSubmissionAdapter(node),
      selectedRelayQuote: { recipient: 0x1234n, requestQuote: async () => { throw new Error("saved bytes need no quote"); } },
    },
  } as unknown as import("@pcash/sdk/wallet").WalletExecutionContext;
  const submit = createMarketplaceTransactionSubmitter(wallet);
  assert.equal(submit.publication, undefined);
  assert.equal(await restoreMarketplaceTransactionToMempool({ node, contentHash, transactionHex: bytesToHex(entry), submit }), "restored");
  assert.deepEqual(admitted, [bytesToHex(entry)]);
});
