import * as localChain from "../../src/wallet/actions/localChain.ts";
import { deliveredOutput } from "./deliveryHelpers.ts";
import { applicationSchemaId } from "../../src/protocol/records.ts";
import { readPublicRecords } from "../../src/protocol/arena.ts";
import { orderedRecords, applicationDataRecords } from "../recordHelpers.ts";
import { memoSchema, claimedSenderSchema, storeTransactionData, transactionDataHash } from "../../src/delivery/index.ts";
import { testStatus } from "./statusFixture.ts";
import { describe, expect, it, vi } from "vitest";
import { privateKeyPcashActionSigner, type PcashAuthorizationRequest } from "@pcash/sdk/eip712";
import { scanFeed, SYSTEM_NOTE_OUTPUT_INDEX } from "../../src/wallet/actions/scan.ts";
import { reconcilePendingNoteFundedTransfers } from "../../src/wallet/actions/clientReconciliation.ts";
import { controlsSystemPayout } from "../../src/wallet/actions/publication.ts";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import { addressHex, fromHex } from "@pcash/sdk/utils";
import { derivePcashProfileFromPrivateKey } from "../../src/wallet/externalIdentity.ts";
import {
  DurablePreBroadcastError,
  type DurableSubmissionAdapter,
} from "../../src/wallet/actions/durableSubmission.ts";
import { PcashNodeClient, PcashNodeRpcError, type StatusResult } from "@pcash/sdk/clients";
import { InsufficientNotesError, type WalletFileData } from "../../src/wallet/noteStore.ts";
import * as noteStore from "../../src/wallet/noteStore.ts";
import { OUTPUT_DATA_BYTES, PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import { type AccountRow, anchoredChain, recordConsumption } from "./chainFixture.ts";
import { createWalletRuntime, WalletReviewStaleError } from "../../src/wallet/actions/walletRuntime.ts";
import { matchingPendingNoteFundedTransfer, noteFundedTransferValidUntil, runNoteFundedTransferClient, selectedPendingNoteFundedTransfer, type NoteFundedProver } from "../../src/wallet/actions/noteFundedClient.ts";
import {
  decodePayload,
  buildContractBody,
  functionSelector,
  deliveryCommitment,
  decryptEnvelope,
  discloseOutput,
  encodePrivateValueTransaction,
  generateMlKemKeyPair,
  openSenderRecords,
  trialOpenEnvelope,
  noteBodyCommitment,
  outputCommitment as leafCommitment,
  ownerCommitment,
  PayoutRole,
  payoutNoteSecret,
  payoutSeed,
  payoutTransactionContext,
  WIRE_PROOF_BYTES,
  fullOutputCommitment,
  transactionPublication,
  transactionIdentity,
} from "@pcash/sdk/protocol";
import type { WalletTransferPreflight } from "../../src/wallet/actions/transferReview.ts";
import { type WalletSaveOptions, type WalletStateStore, walletStore, WalletConflictError } from "../../src/wallet/store.ts";
import { FULL_RESCAN_RESOURCE } from "../../src/wallet/reservations.ts";
import { browserSubmissionHarness } from "./browserSubmissionHarness.ts";
import { IndexedDbRelayJournal, browserRelayJournalKey } from "@pcash/sdk/relay";
import { createMempoolSubmissionAdapter } from "../../src/wallet/submission.ts";
import { createBrowserL1SubmissionAdapter } from "../../src/wallet/web/submission.ts";
import { storedReceiveKeyPair } from "../../src/wallet/receiveKeyring.ts";
import { buildExtendedCode } from "@pcash/sdk/delivery";
import type { NativeTransferBuild } from "@pcash/sdk/builders";

const CHAIN_ID = 1_346_589_512n;
const GENESIS_HASH = `0x${"11".repeat(32)}`;
const PRIVATE_KEY = Uint8Array.from(
  Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex"),
);
const NETWORK = {
  pcashChainId: CHAIN_ID,
  l1ChainId: 11_155_111n,
  inboxAddress: `0x${"66".repeat(20)}`,
};
const wallet = derivePcashProfileFromPrivateKey(PRIVATE_KEY, NETWORK);
const signer = privateKeyPcashActionSigner(PRIVATE_KEY);

const hex = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;
/** The arena and context of a native transfer build's section. */
const sectionOf = (build: NativeTransferBuild) => ({
  arena: build.arena,
  shape: build.shape,
  context: { chainId: CHAIN_ID, transactionType: 0 as const, nullifiers: build.transaction.inputs.map((input) => input.nullifier) },
});
const bytesHex = (value: Uint8Array): string =>
  `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const rules = defaultUserAccountRuleSet({
  wallet,
  network: NETWORK,
  secrets: wallet.defaultUserRuleSecrets,
});
const noteSecret = 0x1234n;
const noteAmount = 10n;
const outputCommitment = fullOutputCommitment({
  owner: wallet.address,
  noteSecret,
  assetId: 0n,
  amount: noteAmount,
}, 0);
const walletAccount: AccountRow = {
  address: `0x${wallet.address.toString(16).padStart(40, "0")}`,
  nullifierKeyCommitment: wallet.nullifierKeyCommitment,
  accountRuleSetCommitment: rules.accountRuleSetCommitment,
  receiveKey: wallet.mlKemPublicKey,
};

/** Local chain state synced through block 10 holding exactly these notes, this wallet's account, and `accounts`. */
function chainOf(data: WalletFileData, accounts: readonly AccountRow[] = []) {
  return anchoredChain({
    outputs: data.notes.map((note) => ({ leaf: BigInt(note.commitment!), mark: true })),
    accounts: [walletAccount, ...accounts],
    blockNumber: 10n,
    timestamp: 1_800_000_000n,
  });
}

function storeOf(data = initialWalletData(), accounts: readonly AccountRow[] = []) {
  return memoryWalletStateStore(data, chainOf(data, accounts).records);
}

const boundary = chainOf(initialWalletData()).boundary;
const BLOCK_HASH = hex(boundary.blockHash);

const status: StatusResult = testStatus({
  latestBlock: 10n,
  latestBlockHash: BLOCK_HASH,
  latestBlockTimestamp: 1_800_000_000n,
  finalizedBlock: 9n,
  finalizedBlockHash: `0x${"44".repeat(32)}`,
  finalizedBlockTimestamp: 1_799_999_000n,
  latestL1BlockNumber: 10n,
  latestL1BlockHash: BLOCK_HASH,
  finalizedL1BlockNumber: 9n,
  finalizedL1BlockHash: `0x${"44".repeat(32)}`,
  stateRoot: hex(boundary.header.stateRoot),
  l1OriginRoot: hex(boundary.header.l1OriginRoot),
  historyRoot: hex(boundary.header.historyRoot),
  pcashChainId: Number(CHAIN_ID),
  genesisHash: GENESIS_HASH,
  l1ChainId: NETWORK.l1ChainId,
  inboxAddress: NETWORK.inboxAddress,
  genesisL1Block: 1n,
  genesisL1BlockHash: `0x${"77".repeat(32)}`,
});

it("bounds selected default and ceiling deadlines by the advertised quote lifetime", () => {
  const selectedRelayQuote = {
    recipient: 1n,
    maxQuoteLifetimeSeconds: 600n,
    requestQuote: async () => { throw new Error("deadline planning must not request a quote"); },
  };
  const now = status.latestBlockTimestamp;
  expect(noteFundedTransferValidUntil(status, { selectedRelayQuote })).toBe(now + 600n);
  expect(noteFundedTransferValidUntil(status, { selectedRelayQuote,
    validUntilTimestamp: now + 900n, validUntilMode: "ceiling" })).toBe(now + 600n);
  expect(noteFundedTransferValidUntil(status, { selectedRelayQuote,
    validUntilTimestamp: now + 300n, validUntilMode: "ceiling" })).toBe(now + 300n);
});

it("rejects an exact selected deadline beyond the advertised quote lifetime", () => {
  const selectedRelayQuote = {
    recipient: 1n,
    maxQuoteLifetimeSeconds: 600n,
    requestQuote: async () => { throw new Error("deadline planning must not request a quote"); },
  };
  expect(() => noteFundedTransferValidUntil(status, { selectedRelayQuote,
    validUntilTimestamp: status.latestBlockTimestamp + 601n, validUntilMode: "exact" }))
    .toThrow(/exact transfer deadline exceeds the selected relayer's advertised maximum quote lifetime/);
  expect(noteFundedTransferValidUntil(status, { selectedRelayQuote,
    validUntilTimestamp: status.latestBlockTimestamp + 600n, validUntilMode: "exact" }))
    .toBe(status.latestBlockTimestamp + 600n);
});

function initialWalletData(): WalletFileData {
  return {
    address: addressHex(wallet.address),
    network: { chainId: CHAIN_ID.toString(), genesisHash: GENESIS_HASH },
    receiveKeys: [storedReceiveKeyPair({ publicKey: wallet.mlKemPublicKey, secretKey: wallet.mlKemSecretKey })],
    notes: [{
      leafIndex: "0",
      outputIndex: 0,
      assetId: "0x0",
      amount: noteAmount.toString(),
      owner: addressHex(wallet.address),
      noteSecret: hex(noteSecret),
      commitment: hex(outputCommitment),
      spent: false,
      pending: false,
    }],
  };
}

/** Witnesses, spentness, and recipient keys come from the store; the node serves status and own-transaction polling. */
function testNode(): PcashNodeClient {
  return {
    status: async () => status,
    getReceipt: async () => [],
    getMempoolTransaction: async () => null,
  } as unknown as PcashNodeClient;
}

interface TestStore extends WalletStateStore {
  snapshot(): WalletFileData | null;
}

function memoryAdapter(initial: WalletFileData, trace: string[]): TestStore {
  const store = storeOf(initial);
  return {
    identity: store.identity,
    transaction: store.transaction,
    load: store.load,
    readChain: store.readChain,
    chainStep: store.chainStep,
    save: async (data, options) => {
      trace.push("save");
      await store.save(data, options);
    },
    snapshot: store.snapshot,
  };
}

function serializedAdapter(initial: WalletFileData, trace: string[]): TestStore {
  // Round-trips through JSON on every read and write, the way a durable backend
  // does, so nothing in the engine can retain a reference into stored state.
  let value = JSON.stringify(initial);
  let revision = 0;
  const chain = new Map([...chainOf(initial).records].map(([key, record]) => [key, JSON.stringify(record)]));
  const store = walletStore({
    read: () => Promise.resolve({ revision, data: JSON.parse(value) as unknown }),
    transaction: (operation, commit) => {
      const committed = operation({ revision, data: JSON.parse(value) as unknown });
      value = JSON.stringify(committed.data);
      revision += 1;
      if (commit?.replace) chain.clear();
      for (const [key, record] of commit?.writes ?? []) {
        if (record === null) chain.delete(key);
        else chain.set(key, JSON.stringify(record));
      }
      return Promise.resolve(committed.value);
    },
    readChain: (keys) => Promise.resolve(new Map((keys ?? [...chain.keys()]).filter((key) => chain.has(key))
      .map((key) => [key, JSON.parse(chain.get(key)!) as unknown]))),
  }, {
    address: BigInt(initial.address),
    network: initial.network,
  }, "serialized test wallet");
  return {
    identity: store.identity,
    load: store.load,
    transaction: store.transaction,
    readChain: store.readChain,
    chainStep: store.chainStep,
    save: (data: WalletFileData, options?: WalletSaveOptions) => {
      trace.push("save");
      return store.save(data, options);
    },
    snapshot: () => JSON.parse(value) as WalletFileData,
  };
}

const deterministicTransactionInput = {
  eventSalt: 7n,
  dummyInputEntropy: 1n,
  outputEntropies: [2n, 3n, 4n, 5n, 6n],
  outputData: [
    Uint8Array.from({ length: OUTPUT_DATA_BYTES }, (_, index) => index === 0 ? 1 : 2),
    Uint8Array.from({ length: OUTPUT_DATA_BYTES }, (_, index) => index === 0 ? 1 : 5),
    Uint8Array.from({ length: OUTPUT_DATA_BYTES }, (_, index) => index === 0 ? 1 : 8),
    Uint8Array.from({ length: OUTPUT_DATA_BYTES }, (_, index) => index === 0 ? 1 : 11),
    Uint8Array.from({ length: OUTPUT_DATA_BYTES }, (_, index) => index === 0 ? 1 : 14),
  ] as const,
  arena: Uint8Array.from({ length: PRIVATE_VALUE_PROFILES.S.arenaBytes }, (_, index) => index & 0xff),
};

function submissionAdapter(
  trace: string[],
  preparedEntries: string[],
  behavior: "queued" | "definite" | "ambiguous",
  mode: "mempool" | "l1" = "mempool",
): DurableSubmissionAdapter<string, string> {
  return {
    mode,
    preflight: async ({ transactionBytes: entry }) => {
      trace.push("preflight");
      preparedEntries.push(bytesHex(entry));
      return "prepared";
    },
    submit: async () => {
      trace.push("submit");
      if (behavior === "definite") throw new DurablePreBroadcastError("not broadcast");
      if (behavior === "ambiguous") throw new Error("response lost");
      return { accepted: false, queued: true, output: "queued" };
    },
  };
}

async function runWith(
  store: TestStore,
  trace: string[],
  preparedEntries: string[],
  behavior: "queued" | "definite" | "ambiguous",
  mode: "mempool" | "l1" = "mempool",
  expectedReview?: WalletTransferPreflight,
  productionSubmission?: DurableSubmissionAdapter,
) {
  return runNoteFundedTransferClient({
    node: testNode(),
    store,
    wallet,
    signer,
    chainId: CHAIN_ID,
    to: `0x${wallet.address.toString(16).padStart(40, "0")}`,
    amount: 4n,
    openFeeAmount: mode === "l1" ? 0n : productionSubmission === undefined ? 1n : 0n,
    issuanceOwnerCommitment: 0n,
    status,
    deterministicTransactionInput,
    ...(expectedReview === undefined ? {} : { expectedReview }),
    nowUnixMilliseconds: () => 123,
    prover: {
      proveAndEncode: async (build) => encodePrivateValueTransaction({
        publicInputs: build.publicInputs,
        proof: new Uint8Array(WIRE_PROOF_BYTES),
        outputData: build.outputData, arena: build.arena,
      }),
    },
    submission: productionSubmission ?? submissionAdapter(trace, preparedEntries, behavior, mode),
  });
}

function journalTransaction(discriminator = 1n): string {
  const profile = PRIVATE_VALUE_PROFILES.S;
  const outputData = Array.from({ length: profile.outputs }, () => new Uint8Array(OUTPUT_DATA_BYTES));
  const arena = new Uint8Array(profile.arenaBytes);
  const publicInputs = Array<bigint>(profile.publicInputs).fill(0n);
  publicInputs[0] = CHAIN_ID;
  publicInputs[1] = discriminator;
  publicInputs[profile.offsets.deliveryCommitment] = deliveryCommitment(outputData, arena);
  return bytesHex(encodePrivateValueTransaction({ publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData, arena }));
}

describe("shared note-funded client engine contract", () => {
  it("selects the exact pending transaction when identical payment intents coexist", () => {
    const data = initialWalletData();
    const recipient = `0x${wallet.address.toString(16).padStart(40, "0")}`;
    const pending = {
      contentHash: `0x${"11".repeat(32)}`,
      transactionHex: journalTransaction(),
      notBeforeTimestamp: "0",
      validUntilTimestamp: "100",
      kind: "payment" as const,
      transferAmount: "4",
      openFeeAmount: "1",
      privateRelayFeeAmount: "0",
      privateRelayRecipient: null,
      issuanceOwnerCommitment: "0",
      issuanceRecipient: null,
      recipient,
      recipientAddress: recipient,
      inputs: [],
      creditContribution: "0",
      change: null,
    };
    data.pendingNoteFundedTransfers = [
      pending,
      { ...pending, contentHash: `0x${"22".repeat(32)}`, transactionHex: journalTransaction(2n) },
    ];
    const intent = {
      to: recipient,
      amount: 4n,
      openFeeAmount: 1n,
      validUntilTimestamp: 100n,
    };

    expect(() => matchingPendingNoteFundedTransfer(data, intent)).toThrow(/multiple unresolved copies/);
    expect(selectedPendingNoteFundedTransfer(data, {
      ...intent,
      retryContentHash: `0x${"22".repeat(32)}`,
    })?.transactionHex).toBe(journalTransaction(2n));
  });

  it("resumes a pending payment only under the same memo and sender choice", () => {
    const data = initialWalletData();
    const recipient = `0x${wallet.address.toString(16).padStart(40, "0")}`;
    const contentHash = `0x${"11".repeat(32)}`;
    const pending = {
      contentHash, transactionHex: journalTransaction(), notBeforeTimestamp: "0", validUntilTimestamp: "100", kind: "payment" as const,
      transferAmount: "4", openFeeAmount: "1", privateRelayFeeAmount: "0", privateRelayRecipient: null,
      issuanceOwnerCommitment: "0", issuanceRecipient: null, recipient, recipientAddress: recipient,
      data: storeTransactionData(memoIntent(recipient, "rent", true))!, inputs: [], change: null,
    };
    data.pendingNoteFundedTransfers = [pending];
    const intent = { to: recipient, amount: 4n, data: memoIntent(recipient, "rent", true) };

    expect(matchingPendingNoteFundedTransfer(data, intent)?.contentHash).toBe(contentHash);
    for (const changed of [
      { ...intent, data: memoIntent(recipient, "rent!", true) },
      { ...intent, data: memoIntent(recipient, "", true) },
      { ...intent, data: memoIntent(recipient, "rent") },
      { to: recipient, amount: 4n },
    ]) {
      expect(matchingPendingNoteFundedTransfer(data, changed)).toBeNull();
    }
    expect(() => selectedPendingNoteFundedTransfer(data, { ...intent, data: memoIntent(recipient, "other"), retryContentHash: contentHash }))
      .toThrow(/does not match the reviewed payment/);

    const { data: _data, ...plain } = pending;
    data.pendingNoteFundedTransfers = [plain];
    expect(matchingPendingNoteFundedTransfer(data, { to: recipient, amount: 4n })?.contentHash)
      .toBe(contentHash);
  });

  it("resumes a pending payment only under the same sender records", () => {
    const data = initialWalletData();
    const recipient = `0x${wallet.address.toString(16).padStart(40, "0")}`;
    const contentHash = `0x${"12".repeat(32)}`;
    data.pendingNoteFundedTransfers = [{
      contentHash, transactionHex: journalTransaction(), notBeforeTimestamp: "0", validUntilTimestamp: "100", kind: "payment" as const,
      transferAmount: "4", openFeeAmount: "1", privateRelayFeeAmount: "0", privateRelayRecipient: null,
      issuanceOwnerCommitment: "0", issuanceRecipient: null, recipient, recipientAddress: recipient,
      data: storeTransactionData({ self: [{ schema: applicationSchemaId("com.example.record009"), data: Uint8Array.of(1, 2) }] })!, inputs: [], change: null,
    }];
    const intent = { to: recipient, amount: 4n, data: { self: [{ schema: applicationSchemaId("com.example.record009"), data: Uint8Array.of(1, 2) }] } };
    expect(matchingPendingNoteFundedTransfer(data, intent)?.contentHash).toBe(contentHash);
    expect(matchingPendingNoteFundedTransfer(data, { to: recipient, amount: 4n })).toBeNull();
    for (const senderRecords of [[], [{ schema: applicationSchemaId("com.example.record009"), data: Uint8Array.of(1, 3) }], [{ schema: applicationSchemaId("com.example.record010"), data: Uint8Array.of(1, 2) }]]) {
      expect(matchingPendingNoteFundedTransfer(data, { ...intent, data: { self: senderRecords } })).toBeNull();
    }
  });

  it("prepares identical fresh bytes and journal transitions through two platform stores", async () => {
    const memoryTrace: string[] = [];
    const jsonTrace: string[] = [];
    const memoryEntries: string[] = [];
    const jsonEntries: string[] = [];
    const memory = memoryAdapter(initialWalletData(), memoryTrace);
    const browser = serializedAdapter(initialWalletData(), jsonTrace);

    const [memoryResult, browserResult] = await Promise.all([
      runWith(memory, memoryTrace, memoryEntries, "queued"),
      runWith(browser, jsonTrace, jsonEntries, "queued"),
    ]);

    expect(memoryEntries).toEqual(jsonEntries);
    expect(memoryResult.transactionHex).toBe(browserResult.transactionHex);
    expect(memoryResult.contentHash).toBe(browserResult.contentHash);
    expect(memoryTrace).toEqual(["preflight", "submit"]);
    expect(jsonTrace).toEqual(memoryTrace);
    expect(browser.snapshot()).toEqual(memory.snapshot());
    expect(memory.snapshot()?.mempoolOutbox?.[0]?.state).toBe("admitted");
    expect(memory.snapshot()?.pendingNoteFundedTransfers?.[0]).toMatchObject({
      recipient: `0x${wallet.address.toString(16).padStart(40, "0")}`,
      recipientAddress: `0x${wallet.address.toString(16).padStart(40, "0")}`,
    });
  });

  it("rolls back a definite non-broadcast and retains an ambiguous exact-byte reservation", async () => {
    const definiteTrace: string[] = [];
    const ambiguousTrace: string[] = [];
    const definite = memoryAdapter(initialWalletData(), definiteTrace);
    const ambiguous = serializedAdapter(initialWalletData(), ambiguousTrace);

    await expect(runWith(definite, definiteTrace, [], "definite")).rejects.toThrow("not broadcast");
    expect(definite.snapshot()).toEqual(initialWalletData());
    expect(definiteTrace).toEqual(["preflight", "submit", "save"]);

    await expect(runWith(ambiguous, ambiguousTrace, [], "ambiguous")).rejects.toThrow("response lost");
    expect(ambiguous.snapshot()?.pendingNoteFundedTransfers).toHaveLength(1);
    expect(ambiguous.snapshot()?.mempoolOutbox?.[0]?.state).toBe("prepared");
    expect(ambiguousTrace).toEqual(["preflight", "submit"]);
  });

  it("persists fresh-action rollback for a definite L1 pre-broadcast failure", async () => {
    const trace: string[] = [];
    const store = serializedAdapter(initialWalletData(), trace);

    await expect(runWith(store, trace, [], "definite", "l1")).rejects.toThrow("not broadcast");

    expect(store.snapshot()).toEqual(initialWalletData());
    expect(trace).toEqual(["preflight", "submit", "save"]);
  });

  it("checks a reviewed funding snapshot after reserving its selected inputs", async () => {
    const backing = storeOf();
    let firstLoad = true;
    const store: TestStore = {
      identity: backing.identity,
      transaction: backing.transaction,
      readChain: backing.readChain,
      chainStep: backing.chainStep,
      save: backing.save,
      snapshot: backing.snapshot,
      load: async () => {
        const current = await backing.load();
        if (firstLoad) {
          firstLoad = false;
          await backing.transaction((fresh) => {
            fresh!.notes[0]!.amount = "9";
            return { data: fresh!, value: undefined };
          });
        }
        return current;
      },
    };
    const reviewed: WalletTransferPreflight = {
      openFeeAmount: 1n,
      privateRelayFeeAmount: 0n,
      privateRelayRecipient: null,
      beneficiary: { kind: "publisher" },
      publication: "open",
      inputCount: 1,
      inputTotal: 10n,
      retry: false,
    };
    const trace: string[] = [];
    const preparedEntries: string[] = [];
    const selection = vi.spyOn(noteStore, "selectInputNotes");

    await expect(runWith(store, trace, preparedEntries, "queued", "mempool", reviewed))
      .rejects.toBeInstanceOf(WalletReviewStaleError);

    expect(selection).toHaveBeenCalledTimes(2);
    selection.mockRestore();
    expect(preparedEntries).toEqual([]);
    expect(trace).toEqual([]);
    expect(store.snapshot()?.resourceReservations).toBeUndefined();
  });

  it("rejects a competing reservation acquired after unreviewed funding selection", async () => {
    const backing = storeOf();
    let competing = false;
    const store: TestStore = {
      ...backing,
      async transaction<T>(operation: (current: WalletFileData | null) => { data: WalletFileData; value: T }): Promise<T> {
        if (!competing) {
          competing = true;
          await backing.transaction((current) => {
            current!.resourceReservations = [{
              reservationId: "competing", resources: [FULL_RESCAN_RESOURCE],
              createdAtUnixMs: "1", heartbeatAtUnixMs: "1", expiresAtUnixMs: "100000",
            }];
            return { data: current!, value: undefined };
          });
        }
        return backing.transaction(operation);
      },
    };
    const trace: string[] = [];
    const preparedEntries: string[] = [];
    const selection = vi.spyOn(noteStore, "selectInputNotes");
    await expect(runWith(store, trace, preparedEntries, "queued")).rejects.toBeInstanceOf(WalletConflictError);
    expect(selection).toHaveBeenCalledTimes(1);
    selection.mockRestore();
    expect(competing).toBe(true);
    expect(preparedEntries).toHaveLength(1);
    expect(trace).not.toContain("submit");
    expect(backing.snapshot()?.pendingNoteFundedTransfers).toBeUndefined();
  });

  it("holds no durable input or transaction state while a direct-note proof is running", async () => {
    const store = storeOf();
    const proving = deferred<void>();
    const release = deferred<void>();
    const operation = runNoteFundedTransferClient({
      node: testNode(),
      store,
      wallet,
      signer,
      chainId: CHAIN_ID,
      to: `0x${wallet.address.toString(16).padStart(40, "0")}`,
      amount: 4n,
      openFeeAmount: 1n,
      issuanceOwnerCommitment: 0n,
      status,
      deterministicTransactionInput,
      prover: {
        proveAndEncode: async (build) => {
          proving.resolve();
          await release.promise;
          return encodePrivateValueTransaction({
            publicInputs: build.publicInputs,
            proof: new Uint8Array(WIRE_PROOF_BYTES),
            outputData: build.outputData, arena: build.arena,
          });
        },
      },
      submission: submissionAdapter([], [], "queued"),
    });

    await proving.promise;
    expect(store.snapshot()?.resourceReservations).toBeUndefined();
    expect(store.snapshot()?.pendingNoteFundedTransfers).toBeUndefined();
    expect(store.snapshot()?.mempoolOutbox).toBeUndefined();

    release.resolve();
    await expect(operation).resolves.toMatchObject({ queued: true });
  });

  it("cancels during signing before the prover or durable boundary", async () => {
    const store = storeOf();
    const signing = deferred<void>();
    const neverSigned = deferred<never>();
    const controller = new AbortController();
    let proved = false;
    const operation = runNoteFundedTransferClient({
      node: testNode(),
      store,
      wallet,
      signer: {
        address: signer.address,
        signTypedData: async () => {
          signing.resolve();
          return neverSigned.promise;
        },
      },
      chainId: CHAIN_ID,
      to: `0x${wallet.address.toString(16).padStart(40, "0")}`,
      amount: 4n,
      openFeeAmount: 1n,
      issuanceOwnerCommitment: 0n,
      status,
      signal: controller.signal,
      deterministicTransactionInput,
      prover: {
        proveAndEncode: async () => {
          proved = true;
          throw new Error("prover should not start");
        },
      },
      submission: submissionAdapter([], [], "queued"),
    });

    await signing.promise;
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(proved).toBe(false);
    expect(store.snapshot()?.resourceReservations).toBeUndefined();
    expect(store.snapshot()?.pendingNoteFundedTransfers).toBeUndefined();
    expect(store.snapshot()?.mempoolOutbox).toBeUndefined();
  });

  it("leaves no durable state when the post-proof beforeJournal gate rejects", async () => {
    const trace: string[] = [];
    const store = storeOf();
    await expect(runNoteFundedTransferClient({
      node: testNode(),
      store,
      wallet,
      signer,
      chainId: CHAIN_ID,
      to: `0x${wallet.address.toString(16).padStart(40, "0")}`,
      amount: 4n,
      openFeeAmount: 1n,
      issuanceOwnerCommitment: 0n,
      status,
      deterministicTransactionInput,
      beforeJournal: () => { throw new Error("user replaced payment"); },
      prover: {
        proveAndEncode: async (build) => encodePrivateValueTransaction({
          publicInputs: build.publicInputs,
          proof: new Uint8Array(WIRE_PROOF_BYTES),
          outputData: build.outputData, arena: build.arena,
        }),
      },
      submission: submissionAdapter(trace, [], "queued"),
    })).rejects.toThrow("user replaced payment");

    expect(trace).toEqual(["preflight"]);
    expect(store.snapshot()?.resourceReservations).toBeUndefined();
    expect(store.snapshot()?.pendingNoteFundedTransfers).toBeUndefined();
    expect(store.snapshot()?.mempoolOutbox).toBeUndefined();
  });

  it("lets only one concurrent proof atomically journal the same exact inputs", async () => {
    const store = storeOf();
    const bothProving = deferred<void>();
    const release = deferred<void>();
    let provingCount = 0;
    const run = () => runNoteFundedTransferClient({
      node: testNode(),
      store,
      wallet,
      signer,
      chainId: CHAIN_ID,
      to: `0x${wallet.address.toString(16).padStart(40, "0")}`,
      amount: 4n,
      openFeeAmount: 1n,
      issuanceOwnerCommitment: 0n,
      status,
      deterministicTransactionInput,
      prover: {
        proveAndEncode: async (build) => {
          provingCount += 1;
          if (provingCount === 2) bothProving.resolve();
          await release.promise;
          return encodePrivateValueTransaction({
            publicInputs: build.publicInputs,
            proof: new Uint8Array(WIRE_PROOF_BYTES),
            outputData: build.outputData, arena: build.arena,
          });
        },
      },
      submission: submissionAdapter([], [], "queued"),
    });

    const first = run();
    const second = run();
    await bothProving.promise;
    expect(store.snapshot()?.resourceReservations).toBeUndefined();
    release.resolve();
    const results = await Promise.allSettled([first, second]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toBeDefined();
    if (rejected?.status === "rejected") expect(rejected.reason).toBeInstanceOf(WalletConflictError);
    expect(store.snapshot()?.pendingNoteFundedTransfers).toHaveLength(1);
    expect(store.snapshot()?.mempoolOutbox).toHaveLength(1);
  });

  it("rolls back a node's pre-insert refusal but retains any other admission failure", async () => {
    const runBrowser = async (submitRawTransaction: PcashNodeClient["submitRawTransaction"]) => {
      const node = {
        ...testNode(),
        submitRawTransaction,
      } as unknown as PcashNodeClient;
      const store = storeOf();
      const operation = runNoteFundedTransferClient({
        node,
        store,
        wallet,
        signer,
        chainId: CHAIN_ID,
        to: `0x${wallet.address.toString(16).padStart(40, "0")}`,
        amount: 4n,
        openFeeAmount: 1n,
        issuanceOwnerCommitment: 0n,
        status,
        deterministicTransactionInput,
        prover: {
          proveAndEncode: async (build) => encodePrivateValueTransaction({
            publicInputs: build.publicInputs,
            proof: new Uint8Array(WIRE_PROOF_BYTES),
            outputData: build.outputData, arena: build.arena,
          }),
        },
        submission: createMempoolSubmissionAdapter(node),
      });
      await expect(operation).rejects.toThrow();
      return store.snapshot();
    };
    const throwing = (cause: Error) => async () => { throw cause; };
    const nodeError = (code: number, message: string) =>
      new PcashNodeRpcError({ code, message }, { method: "pcash_submitRawTransaction", url: "http://node" });

    const refused = await runBrowser(throwing(nodeError(-32_011, "invalid transaction: proof rejected")));
    expect(refused).toEqual(initialWalletData());

    // A gateway that forwarded the request and then gave up on the node.
    const gateway = new PcashNodeClient("https://gateway.example/rpc", {
      fetchFn: async () => new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32_603, message: "upstream request timeout" } }),
        { status: 504, headers: { "content-type": "application/json" } },
      ),
    });
    for (const submit of [
      throwing(new Error("connection closed after request write")),
      throwing(nodeError(-32_013, "verification unavailable: admission task failed")),
      (transactionHex: string) => gateway.submitRawTransaction(transactionHex),
    ]) {
      const ambiguous = await runBrowser(submit);
      expect(ambiguous?.pendingNoteFundedTransfers).toHaveLength(1);
      expect(ambiguous?.mempoolOutbox?.[0]?.state).toBe("prepared");
    }
  });
});

it("explicit self-publication rolls back a wallet-rejected zero-fee transfer and releases its input", async () => {
  const store = serializedAdapter(initialWalletData(), []);
  const node = testNode();
  const account = `0x${wallet.address.toString(16).padStart(40, "0")}` as const;
  const harness = browserSubmissionHarness(node, status, account);
  harness.setSend(async () => { throw { code: 4001, message: "User rejected" }; });
  const adapter = createBrowserL1SubmissionAdapter({ node, account, ...harness });
  await expect(runWith(store, [], [], "queued", "l1", undefined, adapter)).rejects.toThrow(/rejected/);
  expect(store.snapshot()).toEqual(initialWalletData());
  const journal = new IndexedDbRelayJournal({ accountKey: browserRelayJournalKey(status, account) });
  expect(await journal.read()).toEqual([]);
  expect(harness.sent).toHaveLength(1);
});

it("reloading while a self-published broadcast is unresolved preserves the exact action and blocks another send", async () => {
  const store = serializedAdapter(initialWalletData(), []);
  const node = testNode();
  const account = `0x${wallet.address.toString(16).padStart(40, "0")}` as const;
  const harness = browserSubmissionHarness(node, status, account);
  node.getReceipt = async () => [];
  const requested = deferred<void>();
  const response = deferred<void>();
  harness.setSend(async () => { requested.resolve(); await response.promise; throw new Error("response lost"); });
  const adapter = () => createBrowserL1SubmissionAdapter({ node, account, ...harness });
  const operation = runWith(store, [], [], "queued", "l1", undefined, adapter());
  const failure = expect(operation).rejects.toThrow(/response lost/);
  await requested.promise;
  const saved = store.snapshot()!;
  expect(saved.pendingNoteFundedTransfers).toHaveLength(1);
  const journal = new IndexedDbRelayJournal({ accountKey: browserRelayJournalKey(status, account) });
  expect(await journal.read()).toMatchObject([{ phase: "broadcast_attempted", transactionHash: null }]);
  const pending = saved.pendingNoteFundedTransfers![0]!;
  const reloaded = adapter();
  await expect(reloaded.preflight({ transactionBytes: fromHex(pending.transactionHex), status, retry: true })).rejects.toThrow(/unresolved|latched|journal/i);
  response.resolve();
  await failure;
  expect(store.snapshot()?.pendingNoteFundedTransfers).toEqual(saved.pendingNoteFundedTransfers);
  expect(harness.sent).toHaveLength(1);
  expect(await journal.read()).toHaveLength(1);
});

it("authenticates the recipient quote after fixed nullifiers and before payer signing", async () => {
  const { createSelectedRelayQuote } = await import("@pcash/sdk/eip712");
  const { payoutTransactionContext } = await import("@pcash/sdk/protocol");
  const receiverKey = new Uint8Array(32); receiverKey[31] = 42;
  const receiverSigner = privateKeyPcashActionSigner(receiverKey);
  for (const tamper of [false, true]) {
    const store = serializedAdapter(initialWalletData(), []);
    const events: string[] = [];
    let quotedContext = 0n;
    const operation = runNoteFundedTransferClient({
      node: testNode(), store, wallet,
      signer: { address: signer.address, signTypedData: async (request) => { events.push("payer"); return signer.signTypedData(request); } },
      chainId: CHAIN_ID, to: `0x${wallet.address.toString(16).padStart(40, "0")}`,
      amount: 4n, openFeeAmount: 0n, privateRelayFeeAmount: 1n, status, deterministicTransactionInput,
      selectedRelayQuote: {
        recipient: receiverSigner.address,
        maxQuoteLifetimeSeconds: 600n,
        async requestQuote(request) {
          events.push("quote"); quotedContext = request.transactionContext;
          expect(request.validUntilTimestamp).toBe(status.latestBlockTimestamp + 600n);
          const quote = await createSelectedRelayQuote({ ...request, network: NETWORK, nkRoot: 99n, receiveKey: wallet.mlKemPublicKey, signer: receiverSigner });
          return tamper ? { ...quote, issuanceNoteSecret: BigInt(quote.issuanceNoteSecret) + 1n } : quote;
        },
      },
      prover: { proveAndEncode: async (build) => {
        events.push("proof");
        expect(payoutTransactionContext(CHAIN_ID, build.transaction.inputs.map((input) => input.nullifier))).toBe(quotedContext);
        expect(build.transaction.global.issuanceOwnerCommitment).not.toBe(0n);
        return encodePrivateValueTransaction({ publicInputs: build.publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData: build.outputData, arena: build.arena });
      } },
      submission: submissionAdapter([], [], "queued"),
    });
    if (tamper) {
      await expect(operation).rejects.toThrow(/opening mismatch/);
      expect(events).toEqual(["quote"]);
      expect(store.snapshot()).toEqual(initialWalletData());
    } else {
      await operation;
      expect(events).toEqual(["quote", "payer", "proof"]);
      expect(BigInt(store.snapshot()!.pendingNoteFundedTransfers![0]!.issuanceOwnerCommitment)).not.toBe(0n);
      expect(BigInt(store.snapshot()!.pendingNoteFundedTransfers![0]!.validUntilTimestamp))
        .toBe(status.latestBlockTimestamp + 600n);
    }
  }
});

describe("network binding of runtime submissions", () => {
  // The node reports another, uncompiled chain id and its own inbox, which
  // would also escape the compiled inbox pin.
  const switched = (): PcashNodeClient => ({ ...testNode(), status: async () => ({
    ...status, pcashChainId: Number(CHAIN_ID) + 1, inboxAddress: `0x${"77".repeat(20)}`,
  }) }) as unknown as PcashNodeClient;
  const l1Submission = () => {
    const preflight = vi.fn(async () => "prepared");
    return { preflight, submission: { mode: "l1" as const, preflight,
      submit: async () => { throw new Error("nothing may be submitted"); } } };
  };

  it("refuses a relay-only batch under a status for another PCASH chain", async () => {
    const { preflight, submission } = l1Submission();
    const runtime = createWalletRuntime({ node: switched(), chainId: CHAIN_ID, wallet, signer, store: storeOf(), submission });
    await expect(runtime.mineBatch({ count: 0, relayEntries: [Uint8Array.of(0, 1)] })).rejects.toThrow(/chain ids must match/);
    expect(preflight).not.toHaveBeenCalled();
  });

  it("refuses to prepare an account activation under a status for another PCASH chain", async () => {
    const { submission } = l1Submission();
    const store = storeOf();
    const runtime = createWalletRuntime({ node: switched(), chainId: CHAIN_ID, wallet, signer, store,
      submission, userAccountCreationSubmission: submission });
    await expect(runtime.prepareAccountActivation({})).rejects.toThrow(/chain ids must match/);
    expect(store.snapshot()?.pendingUserAccountCreations ?? []).toEqual([]);
  });
});

describe("default publication through the wallet runtime", () => {
  const recipient = `0x${wallet.address.toString(16).padStart(40, "0")}`;
  const prover = {
    proveAndEncode: async (build: Parameters<NoteFundedProver["proveAndEncode"]>[0]) => build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)),
  };
  /** A node whose issuance quote fee planning never reads. */
  function feeNode() {
    const reads = { estimates: 0 };
    const node = Object.assign(testNode(), {
      getIssuanceQuote: async () => { throw new Error("fee planning reads no issuance quote"); },
      estimateFee: async () => {
        reads.estimates += 1;
        return { tiers: { low: 1n, standard: 3n, fast: 5n } } as never;
      },
    });
    return { node, reads };
  }
  function runtime(node: PcashNodeClient, store: WalletStateStore, submission: DurableSubmissionAdapter<string, string>) {
    return createWalletRuntime({
      node, chainId: CHAIN_ID, wallet, signer, store, provers: { privateValue: prover }, submission,
      settlePollIntervalMs: 0, settlePollMaxAttempts: 1,
    });
  }
  const publicationSectionOf = (transactionHex: string) => transactionPublication(fromHex(transactionHex))!;

  it("sends a transfer with the node's suggested fee on the open route through the mempool by default", async () => {
    const { node, reads } = feeNode();
    const store = storeOf();
    const trace: string[] = [];
    const result = await runtime(node, store, submissionAdapter(trace, [], "queued")).transfer({ to: recipient, amount: 4n });
    expect(publicationSectionOf(result.transactionHex)).toMatchObject({ openFeeAmount: 3n, issuanceOwnerCommitment: 0n });
    expect(result.publicationDetails).toEqual({ issuanceRoute: "open", beneficiary: { kind: "publisher" }, openFeeAmount: 3n, privateRelayFeeAmount: 0n, privateRelayRecipient: null });
    expect(store.snapshot()?.mempoolOutbox?.[0]).toMatchObject({ contentHash: result.contentHash, state: "admitted" });
    expect(store.snapshot()?.pendingNoteFundedTransfers?.[0]).toMatchObject({ openFeeAmount: "3", issuanceOwnerCommitment: "0" });
    expect(reads.estimates).toBe(1);
  });

  // The website matches a payment it saw journaled to its pending record and Activity row by this id.
  it("journals a payment under the contentHash its pending record keeps", async () => {
    const { node } = feeNode();
    const store = storeOf();
    const journaled: string[] = [];
    const result = await runtime(node, store, submissionAdapter([], [], "queued"))
      .transfer({ to: recipient, amount: 4n, beforeJournal: (contentHash) => { journaled.push(contentHash); } });
    expect(journaled).toEqual([result.contentHash]);
    expect(store.snapshot()?.pendingNoteFundedTransfers?.map((transfer) => transfer.contentHash)).toEqual([result.contentHash]);
  });

  it("relays an explicit zero-fee transfer on the open route", async () => {
    const { node, reads } = feeNode();
    const store = storeOf();
    const result = await runtime(node, store, submissionAdapter([], [], "queued")).transfer({ to: recipient, amount: 4n, openFeeAmount: 0n });
    expect(publicationSectionOf(result.transactionHex)).toMatchObject({ openFeeAmount: 0n, issuanceOwnerCommitment: 0n });
    expect(result.publicationDetails).toEqual({ issuanceRoute: "open", beneficiary: { kind: "publisher" }, openFeeAmount: 0n, privateRelayFeeAmount: 0n, privateRelayRecipient: null });
    expect(store.snapshot()?.mempoolOutbox?.[0]).toMatchObject({ contentHash: result.contentHash, state: "admitted" });
    expect(reads.estimates).toBe(0);
  });

  it("relays an explicit zero-fee transfer designated to a quoting recipient", async () => {
    const { createSelectedRelayQuote } = await import("@pcash/sdk/eip712");
    const secret = new Uint8Array(32); secret[31] = 42;
    const quoteSigner = privateKeyPcashActionSigner(secret);
    const selectedRelayQuote = {
      recipient: quoteSigner.address,
      requestQuote: (request: Parameters<import("@pcash/sdk/eip712").SelectedRelayQuoteProvider["requestQuote"]>[0]) =>
        createSelectedRelayQuote({ ...request, network: NETWORK, nkRoot: 42n, receiveKey: wallet.mlKemPublicKey, signer: quoteSigner }),
    };
    const { node, reads } = feeNode();
    const store = storeOf();
    const result = await runtime(node, store, submissionAdapter([], [], "queued")).transfer({ to: recipient, amount: 4n, openFeeAmount: 0n, privateRelayFeeAmount: 1n, selectedRelayQuote });
    expect(publicationSectionOf(result.transactionHex).openFeeAmount).toBe(0n);
    expect(publicationSectionOf(result.transactionHex).issuanceOwnerCommitment).not.toBe(0n);
    expect(result.publicationDetails).toMatchObject({ issuanceRoute: "designated", openFeeAmount: 0n, privateRelayFeeAmount: 1n, beneficiary: { kind: "recipient" } });
    expect(reads.estimates).toBe(0);
  });

  it("retries selected exact bytes without requesting another quote or proof", async () => {
    const { createSelectedRelayQuote } = await import("@pcash/sdk/eip712");
    const relayKey = new Uint8Array(32); relayKey[31] = 52;
    const relaySigner = privateKeyPcashActionSigner(relayKey);
    const originalSession = {
      recipient: relaySigner.address,
      requestQuote: (request: Parameters<import("@pcash/sdk/eip712").SelectedRelayQuoteProvider["requestQuote"]>[0]) =>
        createSelectedRelayQuote({ ...request, network: NETWORK, nkRoot: 52n, receiveKey: wallet.mlKemPublicKey, signer: relaySigner }),
    };
    const { node } = feeNode();
    const store = storeOf();
    await expect(runtime(node, store, submissionAdapter([], [], "ambiguous")).transfer({
      to: recipient, amount: 4n, openFeeAmount: 0n, privateRelayFeeAmount: 1n, selectedRelayQuote: originalSession,
    })).rejects.toThrow("response lost");
    const pending = store.snapshot()!.pendingNoteFundedTransfers![0]!;
    expect(pending.privateRelayRecipient).toBe(`0x${relaySigner.address.toString(16).padStart(40, "0")}`);
    const requestQuote = vi.fn(async () => { throw new Error("retry must not request another quote"); });
    const freshSession = { recipient: relaySigner.address, requestQuote };
    const restartedStore = memoryWalletStateStore(store.snapshot()!, store.chainSnapshot());
    const restarted = createWalletRuntime({
      node, chainId: CHAIN_ID, wallet, signer, store: restartedStore,
      provers: { privateValue: { proveAndEncode: async () => { throw new Error("retry must not prove again"); } } },
      submission: submissionAdapter([], [], "queued"), settlePollIntervalMs: 0, settlePollMaxAttempts: 1,
    });
    const result = await restarted.transfer({
      to: recipient, amount: 4n, openFeeAmount: 0n, privateRelayFeeAmount: 1n,
      retryContentHash: pending.contentHash, selectedRelayQuote: freshSession,
    });
    expect(result.transactionHex).toBe(pending.transactionHex);
    expect(result.contentHash).toBe(pending.contentHash);
    expect(requestQuote).not.toHaveBeenCalled();
  });

  it("resumes an unresolved send through an open-route selected relayer instead of paying again", async () => {
    const { createSelectedRelayQuote } = await import("@pcash/sdk/eip712");
    const relayKey = new Uint8Array(32); relayKey[31] = 53;
    const relaySigner = privateKeyPcashActionSigner(relayKey);
    // A valid quote on the open issuance route names no issuance recipient.
    const openRouteSession = {
      recipient: relaySigner.address,
      requestQuote: (request: Parameters<import("@pcash/sdk/eip712").SelectedRelayQuoteProvider["requestQuote"]>[0]) =>
        createSelectedRelayQuote({ ...request, issuanceEligible: false, network: NETWORK, nkRoot: 53n, receiveKey: wallet.mlKemPublicKey, signer: relaySigner }),
    };
    const { node } = feeNode();
    const store = storeOf();
    const send = { to: recipient, amount: 4n, openFeeAmount: 0n, privateRelayFeeAmount: 1n };
    await expect(runtime(node, store, submissionAdapter([], [], "ambiguous")).transfer({ ...send, selectedRelayQuote: openRouteSession }))
      .rejects.toThrow("response lost");
    const pending = store.snapshot()!.pendingNoteFundedTransfers![0]!;
    expect(pending.issuanceRecipient).toBeNull();
    const requestQuote = vi.fn(async () => { throw new Error("a resumed send must not request another quote"); });
    const restarted = createWalletRuntime({
      node, chainId: CHAIN_ID, wallet, signer, store: memoryWalletStateStore(store.snapshot()!, store.chainSnapshot()),
      provers: { privateValue: { proveAndEncode: async () => { throw new Error("a resumed send must not prove again"); } } },
      submission: submissionAdapter([], [], "queued"), settlePollIntervalMs: 0, settlePollMaxAttempts: 1,
    });
    const result = await restarted.transfer({ ...send, selectedRelayQuote: { recipient: relaySigner.address, requestQuote } });
    expect(result.contentHash).toBe(pending.contentHash);
    expect(requestQuote).not.toHaveBeenCalled();
  });

  it("delivers a memo and sender record to the recipient and records the payment in the payer's sender region", async () => {
    const recipientKeys = generateMlKemKeyPair();
    const payee = `0x${"77".repeat(20)}`;
    const store = storeOf(initialWalletData(), [{
      address: payee, nullifierKeyCommitment: 1n, accountRuleSetCommitment: 1n, receiveKey: recipientKeys.publicKey,
    }]);
    const built: NativeTransferBuild[] = [];
    const memo = "dinner — thanks";
    const result = await createWalletRuntime({
      node: feeNode().node, chainId: CHAIN_ID, wallet, signer, store, submission: submissionAdapter([], [], "queued"),
      provers: { privateValue: { proveAndEncode: async (build) => {
        built.push(build);
        return prover.proveAndEncode(build);
      } } },
      settlePollIntervalMs: 0, settlePollMaxAttempts: 1,
    }).transfer({ to: payee, amount: 4n, openFeeAmount: 1n, data: memoIntent(payee, memo, true) });

    const build = built[0]!;
    const source = sectionOf(build);
    const opened = trialOpenEnvelope(recipientKeys.secretKey, build.outputData[0]!)!;
    const disclosed = discloseOutput({ ...source, sharedSecret: opened.sharedSecret, slot: 0, outputData: build.outputData })!;
    expect(disclosed.note.amount).toBe(4n);
    expect(disclosed.records).toEqual([memoSchema.encode(memo), claimedSenderSchema.encode(wallet.address)]);
    const sent = openSenderRecords({ ...source, outgoingKey: wallet.outgoingKey })!;
    expect(sent.sentEnvelopes).toEqual([{ slot: 0, sharedSecret: opened.sharedSecret, recipientAddress: BigInt(payee) }]);
    expect(sent.sentOpenings).toEqual([]);
    expect(store.snapshot()?.pendingNoteFundedTransfers).toEqual([
      expect.objectContaining({ contentHash: result.contentHash, data: storeTransactionData(memoIntent(payee, memo, true)) }),
    ]);
  });

  it("matches attached payment retries from retained transaction bytes", async () => {
    const store = storeOf();
    const proveAndEncode = vi.fn(prover.proveAndEncode);
    const client = createWalletRuntime({ node: feeNode().node, chainId: CHAIN_ID, wallet, signer, store,
      submission: submissionAdapter([], [], "queued"), provers: { privateValue: { proveAndEncode } },
      settlePollIntervalMs: 0, settlePollMaxAttempts: 1 });
    const body = (nkRoot: bigint) => buildContractBody({ nullifierKey: { publishesNkRoot: true, nkRoot },
      functions: [{ selector: functionSelector(0), applicationVkHash: 71n, configurationCommitment: 81n }] }).body;
    const accountCreation = { kind: "contract" as const, body: body(51n) };
    const intent = { to: recipient, amount: 4n, openFeeAmount: 1n, accountCreation };
    const first = await client.transfer(intent);
    const retry = await client.transfer({ ...intent, accountCreation: { ...accountCreation, body: accountCreation.body.slice() }, retryContentHash: first.contentHash });
    expect(retry.transactionHex).toBe(first.transactionHex);
    expect(proveAndEncode).toHaveBeenCalledTimes(1);
    const { accountCreation: _attachment, ...withoutAttachment } = intent;
    await expect(client.transfer({ ...withoutAttachment, retryContentHash: first.contentHash })).rejects.toThrow(/reviewed payment/);
    await expect(client.transfer({ ...intent, accountCreation: { kind: "contract", body: body(52n) }, retryContentHash: first.contentHash })).rejects.toThrow(/reviewed payment/);
  });

  it("binds every data audience into review and durable retry matching", async () => {
    const store = storeOf();
    const proveAndEncode = vi.fn(prover.proveAndEncode);
    const client = createWalletRuntime({ node: feeNode().node, chainId: CHAIN_ID, wallet, signer, store,
      submission: submissionAdapter([], [], "queued"), provers: { privateValue: { proveAndEncode } },
      settlePollIntervalMs: 0, settlePollMaxAttempts: 1 });
    const post = (text: string) => ({ schema: applicationSchemaId("com.example.post"), data: new TextEncoder().encode(text) });
    const intent = { to: recipient, amount: 0n, openFeeAmount: 0n,
      data: { ...memoIntent(recipient, "recipient"), self: [memoSchema.encode("self")], public: [post("public")] } };
    const review = await client.preflightTransfer(intent);
    for (const data of [
      { ...intent.data, recipients: memoIntent(recipient, "changed").recipients },
      { ...intent.data, self: [memoSchema.encode("changed")] },
      { ...intent.data, public: [post("changed")] },
    ]) await expect(client.transfer({ ...intent, data, expectedReview: review })).rejects.toThrow(/Review/);
    expect(proveAndEncode).not.toHaveBeenCalled();
    const prepared = await client.transfer({ ...intent, expectedReview: review });
    expect(readPublicRecords(proveAndEncode.mock.calls[0]![0].arena)).toEqual([post("public")]);
    const retry = await client.transfer({ ...intent, retryContentHash: prepared.contentHash });
    expect(retry.contentHash).toBe(prepared.contentHash);
    expect(proveAndEncode).toHaveBeenCalledTimes(1);
    expect(retry.transactionHex).toBe(prepared.transactionHex);
    for (const data of [
      { ...intent.data, recipients: memoIntent(recipient, "changed").recipients },
      { ...intent.data, self: [memoSchema.encode("changed")] },
      { ...intent.data, public: [post("changed")] },
    ]) await expect(client.transfer({ ...intent, data, retryContentHash: prepared.contentHash })).rejects.toThrow();
  });

  it.each(["status", "lookup", "signer", "prover"] as const)("snapshots reviewed data before deferred %s", async stage => {
    const store = storeOf();
    const { node } = feeNode();
    const entered = deferred<void>();
    const release = deferred<void>();
    const pause = async () => { entered.resolve(); await release.promise; };
    const builds: NativeTransferBuild[] = [];
    const client = createWalletRuntime({
      node, chainId: CHAIN_ID, wallet, store,
      signer: { address: signer.address, signTypedData: async request => {
        if (stage === "signer") await pause();
        return signer.signTypedData(request);
      } },
      submission: submissionAdapter([], [], "queued"),
      provers: { privateValue: { proveAndEncode: async build => {
        builds.push(build);
        if (stage === "prover") await pause();
        return prover.proveAndEncode(build);
      } } }, settlePollIntervalMs: 0, settlePollMaxAttempts: 1,
    });
    const data = { recipients: [{ to: addressHex(wallet.address), records: [memoSchema.encode("A")] }],
      self: [memoSchema.encode("S")] };
    const original = structuredClone(data);
    const intent = { to: recipient, amount: 4n, openFeeAmount: 1n, data };
    const review = await client.preflightTransfer(intent);
    expect(review.dataHash).toBe(transactionDataHash(original));
    const snapshotOf = localChain.localWitnessSnapshot;
    const lookup = stage === "lookup" ? vi.spyOn(localChain, "localWitnessSnapshot").mockImplementation(async (...args) => {
      const snapshot = await snapshotOf(...args);
      return { ...snapshot, receiveKeyOf: async (address: string) => { await pause(); return snapshot.receiveKeyOf(address); } };
    }) : undefined;
    const statusCall = node.status.bind(node);
    if (stage === "status") node.status = async () => { await pause(); return statusCall(); };
    try {
      const operation = client.transfer({ ...intent, expectedReview: review });
      await entered.promise;
      data.recipients[0]!.records[0]!.data[0] = 0x42;
      data.self[0]!.data[0] = 0x54;
      data.recipients[0]!.records.push({ schema: applicationSchemaId("com.example.extra"), data: Uint8Array.of(1) });
      release.resolve();
      const result = await operation;
      expect(deliveredOutput(builds[0]!, CHAIN_ID, wallet.mlKemSecretKey, 0)?.records).toEqual([memoSchema.encode("A")]);
      expect(openSenderRecords({ ...sectionOf(builds[0]!), outgoingKey: wallet.outgoingKey })?.records).toEqual([memoSchema.encode("S")]);
      expect(store.snapshot()?.pendingNoteFundedTransfers?.[0]?.data).toEqual(storeTransactionData(original));
      await expect(client.transfer({ ...intent, retryContentHash: result.contentHash })).rejects.toThrow();
      const retry = await client.transfer({ ...intent, data: original, retryContentHash: result.contentHash });
      expect(retry.transactionHex).toBe(result.transactionHex);
      expect(builds).toHaveLength(1);
    } finally {
      release.resolve();
      lookup?.mockRestore();
    }
  });

  it("writes the caller's sender records to the payer's sender region and journals them", async () => {
    const built: NativeTransferBuild[] = [];
    const store = storeOf();
    const senderRecords = [{ schema: applicationSchemaId("com.example.record009"), data: Uint8Array.of(1, 2, 3) }];
    const result = await createWalletRuntime({
      node: feeNode().node, chainId: CHAIN_ID, wallet, signer, store, submission: submissionAdapter([], [], "queued"),
      provers: { privateValue: { proveAndEncode: async (build) => {
        built.push(build);
        return prover.proveAndEncode(build);
      } } },
      settlePollIntervalMs: 0, settlePollMaxAttempts: 1,
    }).transfer({ to: recipient, amount: 4n, openFeeAmount: 1n, data: { self: senderRecords } });

    expect(applicationDataRecords(openSenderRecords({ ...sectionOf(built[0]!), outgoingKey: wallet.outgoingKey })?.records ?? [])).toEqual(orderedRecords(senderRecords));
    expect(store.snapshot()?.pendingNoteFundedTransfers).toEqual([
      expect.objectContaining({ contentHash: result.contentHash, data: storeTransactionData({ self: senderRecords }) }),
    ]);
  });

  it("records a payment to itself in its sender region, so a restore shows it as a payment", async () => {
    const built: NativeTransferBuild[] = [];
    await createWalletRuntime({
      node: feeNode().node, chainId: CHAIN_ID, wallet, signer, store: storeOf(), submission: submissionAdapter([], [], "queued"),
      provers: { privateValue: { proveAndEncode: async (build) => {
        built.push(build);
        return prover.proveAndEncode(build);
      } } },
      settlePollIntervalMs: 0, settlePollMaxAttempts: 1,
    }).transfer({ to: recipient, amount: 4n, openFeeAmount: 1n, data: memoIntent(recipient, "to self") });

    const sent = openSenderRecords({ ...sectionOf(built[0]!), outgoingKey: wallet.outgoingKey })!;
    expect(sent.sentEnvelopes).toEqual([expect.objectContaining({ slot: 0, recipientAddress: wallet.address })]);
  });

  it("refuses a memo or sender the payment cannot carry before proving", async () => {
    const proveAndEncode = vi.fn(prover.proveAndEncode);
    const store = storeOf();
    const walletRuntime = createWalletRuntime({
      node: feeNode().node, chainId: CHAIN_ID, wallet, signer, store, submission: submissionAdapter([], [], "queued"),
      provers: { privateValue: { proveAndEncode } }, settlePollIntervalMs: 0, settlePollMaxAttempts: 1,
    });
    await expect(walletRuntime.transfer({ to: recipient, amount: 4n, openFeeAmount: 1n,
      data: { self: [memoSchema.encode("x".repeat(3000))] },
    })).rejects.toThrow(/arena/);
    await expect(walletRuntime.preflightTransfer({ to: recipient, amount: 0n, openFeeAmount: 0n,
      data: memoIntent(recipient, "hi"),
    })).resolves.toMatchObject({ retry: false });
    expect(proveAndEncode).not.toHaveBeenCalled();
    expect(store.snapshot()).toEqual(initialWalletData());
  });

  it("honors an explicit fee", async () => {
    const { node } = feeNode();
    const store = storeOf();
    const result = await runtime(node, store, submissionAdapter([], [], "queued")).transfer({ to: recipient, amount: 4n, openFeeAmount: 1n });
    expect(publicationSectionOf(result.transactionHex)).toMatchObject({ openFeeAmount: 1n, issuanceOwnerCommitment: 0n });
    expect(result.publicationDetails).toEqual({ issuanceRoute: "open", beneficiary: { kind: "publisher" }, openFeeAmount: 1n, privateRelayFeeAmount: 0n, privateRelayRecipient: null });
  });

  it("self-publishes without a PCASH fee and recovers its own designated issuance", async () => {
    const { node } = feeNode();
    const store = storeOf();
    const signed: PcashAuthorizationRequest[] = [];
    const recordingSigner = {
      address: signer.address,
      signTypedData: async (request: PcashAuthorizationRequest) => { signed.push(request); return signer.signTypedData(request); },
    };
    const result = await createWalletRuntime({
      node, chainId: CHAIN_ID, wallet, signer: recordingSigner, store, provers: { privateValue: prover },
      submission: submissionAdapter([], [], "queued", "l1"), settlePollIntervalMs: 0, settlePollMaxAttempts: 1,
    }).transfer({ to: recipient, amount: 4n });
    const section = publicationSectionOf(result.transactionHex);
    expect(section.openFeeAmount).toBe(0n);
    expect(section.issuanceOwnerCommitment).not.toBe(0n);
    // The commitment opens to this wallet's address under its seed-derived issuance secret.
    const context = payoutTransactionContext(CHAIN_ID, section.nullifiers, section.shape);
    const noteSecret = payoutNoteSecret(payoutSeed(wallet.nkRoot), PayoutRole.ISSUANCE, context);
    expect(ownerCommitment(wallet.address, noteSecret)).toBe(section.issuanceOwnerCommitment);
    expect(signed.map((request) => String((request.typedData.message as Record<string, unknown>).issuanceRecipient).toLowerCase()))
      .toEqual([recipient.toLowerCase()]);
    expect(result.publicationDetails).toEqual({ issuanceRoute: "designated", beneficiary: { kind: "self" }, openFeeAmount: 0n, privateRelayFeeAmount: 0n, privateRelayRecipient: null });
    expect(store.snapshot()?.pendingNoteFundedTransfers?.[0]?.issuanceRecipient).toBe(recipient);
    expect(store.snapshot()?.mempoolOutbox).toBeUndefined();
    // Its payout is a designatedIssuance record that the seed-only scan
    // restores and that counts as this wallet's.
    const payout = {
      sourceKind: "designatedIssuance" as const, component: "issuance" as const, contexts: [context], amount: 9n,
      ownerCommitment: section.issuanceOwnerCommitment,
    };
    const { recovered } = await scanFeed({
      chainId: CHAIN_ID, owners: [wallet.address], mlKemSecretKeys: [], recoveryWallet: wallet,
      feed: [{ kind: "system", outputIndex: SYSTEM_NOTE_OUTPUT_INDEX, leafIndex: 5n,
        outputCommitment: leafCommitment(noteBodyCommitment(payout.ownerCommitment, 0n, payout.amount), 5n), payout }],
    });
    expect(recovered.map((note) => [note.amount, note.noteSecret])).toEqual([[9n, noteSecret]]);
    expect(controlsSystemPayout(wallet, {
      source: { kind: "designatedIssuance", l1TransactionIndex: 0n, batchItemIndex: 0n },
      ownerCommitment: section.issuanceOwnerCommitment, contexts: [context],
    })).toBe(true);
  });

  describe("a retried payment keeps its saved issuance and relay destinations", () => {
    const quoter = (key: number) => {
      const secret = new Uint8Array(32); secret[31] = key;
      const quoteSigner = privateKeyPcashActionSigner(secret);
      return {
        recipient: quoteSigner.address,
        address: `0x${quoteSigner.address.toString(16).padStart(40, "0")}`,
        async requestQuote(request: Parameters<import("@pcash/sdk/eip712").SelectedRelayQuoteProvider["requestQuote"]>[0]) {
          const { createSelectedRelayQuote } = await import("@pcash/sdk/eip712");
          return createSelectedRelayQuote({ ...request, network: NETWORK, nkRoot: BigInt(key), receiveKey: wallet.mlKemPublicKey, signer: quoteSigner });
        },
      };
    };
    const a = quoter(42);
    const b = quoter(43);
    const noQuote = { recipient: b.recipient, requestQuote: async () => { throw new Error("a retry replays saved bytes"); } };

    /** A payment whose submission outcome was lost, so its exact bytes stay journaled for retry. */
    async function pendingPayment(selectedRelayQuote?: typeof a, mode: "mempool" | "l1" = "mempool") {
      const { node } = feeNode();
      const store = storeOf();
      const publication = selectedRelayQuote === undefined ? mode : "selected";
      await expect(runtime(node, store, submissionAdapter([], [], "ambiguous", mode)).transfer({
        to: recipient, amount: 4n, openFeeAmount: publication === "mempool" ? 1n : 0n,
        ...(selectedRelayQuote === undefined ? {} : { selectedRelayQuote, privateRelayFeeAmount: 1n }),
      })).rejects.toThrow("response lost");
      const pending = store.snapshot()!.pendingNoteFundedTransfers![0]!;
      return { walletRuntime: runtime(node, store, submissionAdapter([], [], "queued", mode)),
        retryContentHash: pending.contentHash as `0x${string}`, selectedRelayQuote };
    }
    const retry = { to: recipient, amount: 4n };

    it("reuses exact bytes with the saved selected fee", async () => {
      const { walletRuntime, retryContentHash, selectedRelayQuote } = await pendingPayment(a);
      expect(await walletRuntime.preflightTransfer({ ...retry, retryContentHash })).toMatchObject({ retry: true });
      const selectedRetry = { ...retry, openFeeAmount: 0n, privateRelayFeeAmount: 1n, selectedRelayQuote: selectedRelayQuote! };
      const review = await walletRuntime.preflightTransfer({ ...selectedRetry, retryContentHash });
      expect(review).toMatchObject({ retry: true, beneficiary: { kind: "recipient", address: a.address } });
      await expect(walletRuntime.transfer({ ...selectedRetry, retryContentHash, expectedReview: { ...review, beneficiary: { kind: "publisher" } } }))
        .rejects.toBeInstanceOf(WalletReviewStaleError);
      const result = await walletRuntime.transfer({ ...selectedRetry, retryContentHash, expectedReview: review });
      expect(result).toMatchObject({ retried: true, contentHash: retryContentHash });
      expect(result.publicationDetails).toMatchObject({ issuanceRoute: "designated", beneficiary: { kind: "recipient", address: a.address } });
    });

    it("rejects a retry that names another designated recipient", async () => {
      const { walletRuntime, retryContentHash } = await pendingPayment(a);
      await expect(walletRuntime.preflightTransfer({ ...retry, openFeeAmount: 0n, privateRelayFeeAmount: 1n, retryContentHash, selectedRelayQuote: noQuote }))
        .rejects.toThrow(/does not match the reviewed payment/);
      await expect(walletRuntime.transfer({ ...retry, openFeeAmount: 0n, privateRelayFeeAmount: 1n, retryContentHash, selectedRelayQuote: noQuote }))
        .rejects.toThrow(/does not match the reviewed payment/);
      expect(b.address).not.toBe(a.address);
    });

    it("reviews and reports a self-published retry as the wallet's own destination on any path", async () => {
      const { walletRuntime, retryContentHash } = await pendingPayment(undefined, "l1");
      const review = await walletRuntime.preflightTransfer({ ...retry, retryContentHash });
      expect(review).toMatchObject({ retry: true, beneficiary: { kind: "self" } });
      const result = await walletRuntime.transfer({ ...retry, retryContentHash, expectedReview: review });
      expect(result).toMatchObject({ retried: true, contentHash: retryContentHash });
      expect(result.publicationDetails).toEqual({ issuanceRoute: "designated", beneficiary: { kind: "self" }, openFeeAmount: 0n, privateRelayFeeAmount: 0n, privateRelayRecipient: null });
    });

    it("keeps an open retry open and refuses a designated recipient for it", async () => {
      const { walletRuntime, retryContentHash } = await pendingPayment();
      expect(await walletRuntime.preflightTransfer({ ...retry, retryContentHash }))
        .toMatchObject({ retry: true, beneficiary: { kind: "publisher" } });
      await expect(walletRuntime.preflightTransfer({ ...retry, retryContentHash, selectedRelayQuote: noQuote }))
        .rejects.toThrow(/does not match the reviewed payment/);
    });
  });

  it("reviews the default fee and destination and rejects a send whose beneficiary changed", async () => {
    const { node } = feeNode();
    const store = storeOf();
    const trace: string[] = [];
    const walletRuntime = runtime(node, store, submissionAdapter(trace, [], "queued"));
    const review = await walletRuntime.preflightTransfer({ to: recipient, amount: 4n });
    expect(review).toEqual({ openFeeAmount: 3n, privateRelayFeeAmount: 0n, privateRelayRecipient: null, beneficiary: { kind: "publisher" }, publication: "open", inputCount: 1, inputTotal: 10n, retry: false });
    await expect(walletRuntime.transfer({ to: recipient, amount: 4n, expectedReview: { ...review, beneficiary: { kind: "self" } } }))
      .rejects.toBeInstanceOf(WalletReviewStaleError);
    expect(trace).toEqual([]);
    await expect(walletRuntime.transfer({ to: recipient, amount: 4n, expectedReview: review }))
      .resolves.toMatchObject({ queued: true });
  });
  it.each([false, true])("charges no PCASH self-fee (empty: %s)", async empty => {
    const { node, reads } = feeNode();
    const store = storeOf({ ...initialWalletData(), ...(empty ? { notes: [] } : {}) });
    const client = runtime(node, store, submissionAdapter([], [], "queued", "l1"));
    const intent = { to: recipient, amount: empty ? 0n : 10n };
    const review = await client.preflightTransfer(intent);
    expect(review.openFeeAmount).toBe(0n);
    const result = await client.transfer({ ...intent, expectedReview: review });
    expect(result.amount).toBe(intent.amount);
    expect(publicationSectionOf(result.transactionHex).openFeeAmount).toBe(0n);
    expect(reads.estimates).toBe(0);
  });

  it.each(["0", hex(outputCommitment), "0,1"])("rejects a requested PCASH self-fee for a full-balance selection %s", async noteSelector => {
    const data = initialWalletData();
    if (noteSelector === "0,1") data.notes.push({ ...data.notes[0]!, leafIndex: "1", outputIndex: 1,
      noteSecret: hex(noteSecret + 1n), commitment: hex(fullOutputCommitment({
        owner: wallet.address, noteSecret: noteSecret + 1n, assetId: 0n, amount: noteAmount,
      }, 1)) });
    const { node } = feeNode();
    const store = storeOf(data);
    const client = runtime(node, store, submissionAdapter([], [], "queued", "l1"));
    const intent = { to: recipient, amount: noteAmount * BigInt(data.notes.length), noteSelector };
    await expect(client.preflightTransfer({ ...intent, openFeeAmount: 3n })).rejects.toThrow(/self-publication has no PCASH network fee/);
    await expect(client.transfer({ ...intent, openFeeAmount: 3n })).rejects.toThrow(/self-publication has no PCASH network fee/);
    const review = await client.preflightTransfer(intent);
    expect(review).toMatchObject({ openFeeAmount: 0n, inputCount: data.notes.length, inputTotal: intent.amount });
    const result = await client.transfer({ ...intent, expectedReview: review });
    expect(result.amount).toBe(intent.amount);
    expect(publicationSectionOf(result.transactionHex).openFeeAmount).toBe(0n);
  });

  it.each(["invalid", "0,0", "1", "spent"])("does not waive selector errors for %s", async selection => {
    const data = initialWalletData();
    if (selection === "spent") data.notes[0]!.spent = true;
    const { node } = feeNode();
    const store = storeOf(data);
    const submitted: string[] = [];
    const client = runtime(node, store, submissionAdapter([], submitted, "queued", "l1"));
    const intent = { to: recipient, amount: 10n, noteSelector: selection === "spent" ? "0" : selection };
    const error = selection === "invalid" ? /must be a 0x commitment/ : selection === "0,0" ? /duplicate/ : selection === "spent" ? /spent\/pending/ : /no spendable note/;
    await expect(client.preflightTransfer(intent)).rejects.toThrow(error);
    await expect(client.transfer(intent)).rejects.toThrow(error);
    expect(submitted).toEqual([]);
    expect(store.snapshot()).toEqual(data);
  });

  describe("zero-value payments", () => {
    const unfundedWalletData = (): WalletFileData => ({ ...initialWalletData(), notes: [] });
    const journalOf = (store: { snapshot(): WalletFileData | null }) =>
      store.snapshot()!.pendingNoteFundedTransfers![0]!;
    const realInputs = (pending: { inputs: readonly { spentCommitment: string | null }[] }) =>
      pending.inputs.filter((input) => input.spentCommitment !== null);

    it("sends a zero payment with an explicit zero fee from a wallet that holds no notes", async () => {
      const { node, reads } = feeNode();
      const store = storeOf(unfundedWalletData());
      const walletRuntime = runtime(node, store, submissionAdapter([], [], "queued", "l1"));
      const review = await walletRuntime.preflightTransfer({ to: recipient, amount: 0n, openFeeAmount: 0n });
      expect(review).toEqual({
        openFeeAmount: 0n, privateRelayFeeAmount: 0n, privateRelayRecipient: null, beneficiary: { kind: "self" }, publication: "self",
        inputCount: 0, inputTotal: 0n, retry: false,
      });
      const result = await walletRuntime.transfer({ to: recipient, amount: 0n, openFeeAmount: 0n, expectedReview: review });
      expect(result).toMatchObject({ queued: true, amount: 0n, openFeeAmount: 0n, changeAmount: 0n });
      const section = publicationSectionOf(result.transactionHex);
      expect(section.openFeeAmount).toBe(0n);
      expect(section.issuanceOwnerCommitment).not.toBe(0n);
      expect(result.publicationDetails).toEqual({ issuanceRoute: "designated", beneficiary: { kind: "self" }, openFeeAmount: 0n, privateRelayFeeAmount: 0n, privateRelayRecipient: null });
      // Every input slot is a dummy and no output belongs to this wallet.
      const pending = journalOf(store);
      expect(pending.inputs).toHaveLength(PRIVATE_VALUE_PROFILES.S.inputs);
      expect(realInputs(pending)).toEqual([]);
      expect(pending.change).toBeNull();
      expect(store.snapshot()!.notes).toEqual([]);
      expect(reads.estimates).toBe(0);
    });

    it("selects no notes for a zero payment even when the wallet holds them", async () => {
      const { node } = feeNode();
      const store = storeOf();
      const walletRuntime = runtime(node, store, submissionAdapter([], [], "queued", "l1"));
      const review = await walletRuntime.preflightTransfer({ to: recipient, amount: 0n, openFeeAmount: 0n });
      expect(review).toMatchObject({ inputCount: 0, inputTotal: 0n });
      await walletRuntime.transfer({ to: recipient, amount: 0n, openFeeAmount: 0n, expectedReview: review });
      expect(realInputs(journalOf(store))).toEqual([]);
      expect(store.snapshot()!.notes).toEqual(initialWalletData().notes);
      expect(store.snapshot()!.resourceReservations).toBeUndefined();
    });

    it("funds a positive fee for a zero payment and returns the rest as change", async () => {
      const { node } = feeNode();
      const store = storeOf();
      const walletRuntime = runtime(node, store, submissionAdapter([], [], "queued"));
      const review = await walletRuntime.preflightTransfer({ to: recipient, amount: 0n, openFeeAmount: 1n });
      expect(review).toMatchObject({ openFeeAmount: 1n, inputCount: 1, inputTotal: 10n, publication: "open" });
      const result = await walletRuntime.transfer({ to: recipient, amount: 0n, openFeeAmount: 1n, expectedReview: review });
      expect(result).toMatchObject({ amount: 0n, openFeeAmount: 1n, changeAmount: 9n });
      expect(publicationSectionOf(result.transactionHex).openFeeAmount).toBe(1n);
      const pending = journalOf(store);
      expect(realInputs(pending)).toHaveLength(1);
      expect(pending.change).toMatchObject({ amount: "9" });
    });

    it("keeps the relayed default fee for a zero payment and reports insufficient notes for it", async () => {
      const { node, reads } = feeNode();
      const funded = storeOf();
      const fundedRuntime = runtime(node, funded, submissionAdapter([], [], "queued"));
      const review = await fundedRuntime.preflightTransfer({ to: recipient, amount: 0n });
      expect(review).toMatchObject({ openFeeAmount: 3n, inputCount: 1, inputTotal: 10n });
      expect(reads.estimates).toBe(1);
      const result = await fundedRuntime.transfer({ to: recipient, amount: 0n, expectedReview: review });
      expect(result).toMatchObject({ amount: 0n, openFeeAmount: 3n, changeAmount: 7n });

      const unfundedRuntime = runtime(node, storeOf(unfundedWalletData()), submissionAdapter([], [], "queued"));
      await expect(unfundedRuntime.preflightTransfer({ to: recipient, amount: 0n }))
        .rejects.toBeInstanceOf(InsufficientNotesError);
      await expect(unfundedRuntime.transfer({ to: recipient, amount: 0n, openFeeAmount: 1n }))
        .rejects.toBeInstanceOf(InsufficientNotesError);
    });

    it("returns an explicitly selected input as change on a zero payment with a zero fee", async () => {
      const { node } = feeNode();
      const store = storeOf();
      const walletRuntime = runtime(node, store, submissionAdapter([], [], "queued", "l1"));
      const result = await walletRuntime.transfer({
        to: recipient, amount: 0n, openFeeAmount: 0n, noteSelector: hex(outputCommitment),
      });
      expect(result).toMatchObject({ amount: 0n, openFeeAmount: 0n, changeAmount: 10n });
      const pending = journalOf(store);
      expect(realInputs(pending)).toHaveLength(1);
      expect(pending.change).toMatchObject({ amount: "10" });
    });

    it("journals, retries, survives a reorg, and completes a no-input action by its consumed dummy nullifiers", async () => {
      const { node } = feeNode();
      const store = storeOf(unfundedWalletData());
      const ambiguous = runtime(node, store, submissionAdapter([], [], "ambiguous", "l1"));
      await expect(ambiguous.transfer({ to: recipient, amount: 0n, openFeeAmount: 0n })).rejects.toThrow("response lost");
      const pending = journalOf(store);
      expect(realInputs(pending)).toEqual([]);

      // A restart replays the exact journaled bytes instead of proving again.
      const submitted: string[] = [];
      const proved: string[] = [];
      const retryRuntime = createWalletRuntime({
        node, chainId: CHAIN_ID, wallet, signer, store,
        provers: { privateValue: { proveAndEncode: async () => { proved.push("proof"); throw new Error("a retry proves nothing"); } } },
        submission: {
          mode: "l1",
          preflight: async () => "prepared",
          submit: async ({ transactionBytes: entry }) => { submitted.push(bytesHex(entry)); return { accepted: false, queued: true, output: "queued" }; },
        },
        settlePollIntervalMs: 0, settlePollMaxAttempts: 1,
      });
      const retried = await retryRuntime.transfer({ to: recipient, amount: 0n, openFeeAmount: 0n, retryContentHash: pending.contentHash });
      expect(retried).toMatchObject({ contentHash: pending.contentHash, retried: true });
      expect(proved).toEqual([]);
      expect(submitted).toEqual([pending.transactionHex]);

      // A reorg that drops the inclusion leaves the exact bytes retryable.
      const dropped = store.snapshot()!;
      expect(await store.readChain((chain) => reconcilePendingNoteFundedTransfers(dropped, chain, status))).toBe(false);
      expect(dropped.pendingNoteFundedTransfers).toHaveLength(1);

      // Re-included and finalized: the synced chain consumed its dummy nullifiers, which completes the action.
      const nullifiers = pending.inputs.map((input) => input.nullifier);
      await recordConsumption(store, nullifiers.map((nullifier) => [nullifier, {
        pcashNumber: status.finalizedBlock, pcashHash: status.finalizedBlockHash, timestamp: status.finalizedBlockTimestamp,
        transactionId: `0x${"55".repeat(32)}`, contentHash: pending.contentHash, nullifiers,
      }]));
      const settled = store.snapshot()!;
      expect(await store.readChain((chain) => reconcilePendingNoteFundedTransfers(settled, chain, status))).toBe(true);
      expect(settled.pendingNoteFundedTransfers).toBeUndefined();
      expect(settled.notes).toEqual([]);
      expect(settled.paymentHistory).toMatchObject([{ contentHash: pending.contentHash.toLowerCase(), state: "succeeded", transferAmount: "0" }]);
    });

    /** An accepted receipt for exactly these journaled bytes. */
    const acceptedReceipt = (
      pending: { contentHash: string; issuanceOwnerCommitment: string; inputs: readonly { nullifier: string }[] },
    ) => ({
      inclusion: { l1BlockNumber: "0xa", l1BlockHash: `0x${"11".repeat(32)}`, l1TransactionIndex: "0x0",
        l1TransactionHash: `0x${"7c".repeat(32)}`, batchItemIndex: "0x0" },
      contentHash: pending.contentHash, transactionId: `0x${"55".repeat(32)}`, outcome: "succeeded", failureDetail: null,
      l1Sender: `0x${"00".repeat(20)}`, issuanceOwnerCommitment: pending.issuanceOwnerCommitment,
      settledOpenFeeAmount: "0x0", settledIssuanceAmount: "0x9", kind: "privateValue", outputLeafStart: null,
      outputsAdded: "0x1", nullifiers: pending.inputs.map((input) => input.nullifier), account: null,
    });

    it("earns again as a distinct action while the accepted one is unfinalized, and keeps it retryable", async () => {
      const store = storeOf(unfundedWalletData());
      // The accepted receipt of whichever action has landed.
      let landed: ReturnType<typeof acceptedReceipt> | null = null;
      const node = {
        ...feeNode().node,
        getReceipt: async (query: { contentHash: string }) =>
          landed !== null && query.contentHash.toLowerCase() === landed.contentHash.toLowerCase() ? [landed] : [],
      } as unknown as PcashNodeClient;
      const trace: string[] = [];
      const published: string[] = [];
      const mining = runtime(node, store, submissionAdapter(trace, published, "queued", "l1"));
      const earn = { to: recipient, amount: 0n, openFeeAmount: 0n };

      const first = await mining.transfer(earn);
      const firstPending = journalOf(store);
      // Accepted in synced block 10, above finality at block 9, so the journal keeps the exact bytes.
      landed = acceptedReceipt(firstPending);
      const nullifiers = firstPending.inputs.map((input) => input.nullifier);
      await recordConsumption(store, nullifiers.map((nullifier) => [nullifier, {
        pcashNumber: 10n, pcashHash: BLOCK_HASH, timestamp: 1_800_000_120n, transactionId: landed!.transactionId, contentHash: firstPending.contentHash, nullifiers,
      }]));

      // A deliberate second earn action signs, proves and publishes distinct bytes.
      const second = await mining.transfer({ ...earn, newAction: true });
      expect(second.contentHash).not.toBe(first.contentHash);
      const journal = store.snapshot()!.pendingNoteFundedTransfers!;
      expect(journal).toHaveLength(2);
      const secondPending = journal[1]!;
      expect(secondPending.inputs.map((input) => input.nullifier))
        .not.toEqual(firstPending.inputs.map((input) => input.nullifier));
      expect(new Set(published).size).toBe(2);
      expect(trace.filter((step) => step === "submit")).toHaveLength(2);

      // An explicit retry still names the original transaction, and republishes nothing
      // because that transaction is already accepted.
      const retried = await mining.transfer({ ...earn, retryContentHash: first.contentHash });
      expect(retried).toMatchObject({ contentHash: first.contentHash, retried: true, accepted: true });
      expect(trace.filter((step) => step === "submit")).toHaveLength(2);

      // Finality releases the first record and leaves the second earning action pending.
      const settled = store.snapshot()!;
      const finalized = { ...status, finalizedBlock: 10n };
      expect(await store.readChain((chain) => reconcilePendingNoteFundedTransfers(settled, chain, finalized))).toBe(true);
      expect(settled.pendingNoteFundedTransfers).toMatchObject([{ contentHash: secondPending.contentHash }]);
      expect(settled.paymentHistory).toMatchObject([{ contentHash: first.contentHash.toLowerCase(), state: "succeeded", receipt: { transactionId: landed.transactionId } }]);
    });

    describe("a recipient with no published receive key", () => {
      const stranger = `0x${"ab".repeat(20)}`;
      const keyless: AccountRow = { ...walletAccount, address: stranger, receiveKey: null };

      it("pays zero to an unregistered address and refuses a positive payment to it", async () => {
        const { node } = feeNode();
        const store = storeOf();
        const signed: PcashAuthorizationRequest[] = [];
        const recordingSigner = {
          address: signer.address,
          signTypedData: async (request: PcashAuthorizationRequest) => { signed.push(request); return signer.signTypedData(request); },
        };
        const walletRuntime = createWalletRuntime({
          node, chainId: CHAIN_ID, wallet, signer: recordingSigner, store, provers: { privateValue: prover },
          submission: submissionAdapter([], [], "queued", "l1"), settlePollIntervalMs: 0, settlePollMaxAttempts: 1,
        });
        const result = await walletRuntime.transfer({ to: stranger, amount: 0n, openFeeAmount: 0n });
        expect(result).toMatchObject({ amount: 0n, openFeeAmount: 0n, changeAmount: 0n });
        const pending = journalOf(store);
        expect(pending.recipient).toBe(stranger);
        expect(pending.recipientAddress).toBe(stranger);
        expect(realInputs(pending)).toEqual([]);
        // The signed payment message names that exact address.
        expect(signed.map((request) => String((request.typedData.message as Record<string, unknown>).recipient).toLowerCase()))
          .toEqual([stranger]);
        // A positive payment to the same recipient still needs its encryption material.
        await expect(walletRuntime.transfer({ to: stranger, amount: 1n, openFeeAmount: 0n }))
          .rejects.toThrow(/has no published ML-KEM receive key/);
      });

      it("pays zero to a registered address whose receive key is absent", async () => {
        const { node } = feeNode();
        const store = storeOf(initialWalletData(), [keyless]);
        const walletRuntime = runtime(node, store, submissionAdapter([], [], "queued", "l1"));
        const result = await walletRuntime.transfer({ to: stranger, amount: 0n, openFeeAmount: 0n });
        expect(result).toMatchObject({ amount: 0n, openFeeAmount: 0n });
        expect(journalOf(store).recipientAddress).toBe(stranger);
        await expect(walletRuntime.transfer({ to: stranger, amount: 1n, openFeeAmount: 0n }))
          .rejects.toThrow(/has no published ML-KEM receive key/);
      });

      it("refuses a zero payment to a 32-byte value, which names no address", async () => {
        const { node } = feeNode();
        const walletRuntime = runtime(node, storeOf(), submissionAdapter([], [], "queued", "l1"));
        await expect(walletRuntime.transfer({ to: `0x${"99".repeat(32)}`, amount: 0n, openFeeAmount: 0n }))
          .rejects.toThrow(/neither a 20-byte address nor an extended code/);
      });
    });
  });
});

describe("registered native self delivery", () => {
  const rotated = generateMlKemKeyPair();
  const external = generateMlKemKeyPair();
  const externalCode = buildExtendedCode({ chainId: CHAIN_ID, address: 0x1234n, mlKemPublicKey: external.publicKey });

  function prepared(registeredKey: Uint8Array | null, owned = true, to = walletAccount.address) {
    const data = initialWalletData();
    if (owned) data.receiveKeys.push(storedReceiveKeyPair(rotated));
    const { receiveKey: _oldKey, ...account } = walletAccount;
    const local = anchoredChain({
      outputs: [{ leaf: outputCommitment, mark: true }],
      accounts: [{ ...account, ...(registeredKey === null ? {} : { receiveKey: registeredKey }) }],
      blockNumber: 10n, timestamp: status.latestBlockTimestamp,
    });
    const store = memoryWalletStateStore(data, local.records);
    const prove = vi.fn(async (build: NativeTransferBuild) => build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)));
    const run = () => runNoteFundedTransferClient({
      node: testNode(), store, wallet, signer, chainId: CHAIN_ID, to,
      amount: 4n, openFeeAmount: 1n,
      prover: { proveAndEncode: prove },
      submission: submissionAdapter([], [], "queued"),
    });
    return { run, prove };
  }

  it("uses the registered owned key for a bare-address self payment and change, and records the payment", async () => {
    const test = prepared(rotated.publicKey);
    await test.run();
    const build = test.prove.mock.calls[0]![0];
    expect(decodePayload(decryptEnvelope(rotated.secretKey, build.outputData[0]!)!, { chainId: CHAIN_ID }).amount).toBe(4n);
    expect(decodePayload(decryptEnvelope(rotated.secretKey, build.outputData[1]!)!, { chainId: CHAIN_ID }).amount).toBe(5n);
    expect(openSenderRecords({ ...sectionOf(build), outgoingKey: wallet.outgoingKey })!.sentEnvelopes.map(({ slot }) => slot)).toEqual([0]);
    for (const slot of [0, 1, 2]) expect(decryptEnvelope(wallet.mlKemSecretKey, build.outputData[slot]!)).toBeNull();
  });

  it("keeps an owned explicit self code authoritative while automatic outputs use the registry", async () => {
    const to = buildExtendedCode({ chainId: CHAIN_ID, address: wallet.address, mlKemPublicKey: wallet.mlKemPublicKey });
    const test = prepared(rotated.publicKey, true, to);
    await test.run();
    const build = test.prove.mock.calls[0]![0];
    expect(decodePayload(decryptEnvelope(wallet.mlKemSecretKey, build.outputData[0]!)!, { chainId: CHAIN_ID }).amount).toBe(4n);
    expect(decryptEnvelope(rotated.secretKey, build.outputData[0]!)).toBeNull();
    expect(decodePayload(decryptEnvelope(rotated.secretKey, build.outputData[1]!)!, { chainId: CHAIN_ID }).amount).toBe(5n);
    expect(openSenderRecords({ ...sectionOf(build), outgoingKey: wallet.outgoingKey })!.sentEnvelopes.map(({ slot }) => slot)).toEqual([0]);
  });

  it("fails before proving when automatic self delivery has no registered key", async () => {
    const test = prepared(null, true, externalCode);
    await expect(test.run()).rejects.toThrow(/no registered receive key/);
    expect(test.prove).not.toHaveBeenCalled();
  });

  it("fails before proving when the registered receive secret is missing", async () => {
    const test = prepared(rotated.publicKey, false, externalCode);
    await expect(test.run()).rejects.toThrow(/does not own the registered receive key/);
    expect(test.prove).not.toHaveBeenCalled();
  });

  it("fails before proving when an explicit self code uses an unowned key", async () => {
    const to = buildExtendedCode({ chainId: CHAIN_ID, address: wallet.address, mlKemPublicKey: external.publicKey });
    const test = prepared(rotated.publicKey, true, to);
    await expect(test.run()).rejects.toThrow(/does not own the receive key for this output/);
    expect(test.prove).not.toHaveBeenCalled();
  });
});

function memoIntent(to: string, memo: string, includeSender = false) {
  return { recipients: [{ to, records: [memoSchema.encode(memo), ...includeSender ? [claimedSenderSchema.encode(wallet.address)] : []] }] };
}

it.each(["known", "ambiguous", "unrelated"] as const)("resumes an existing native journal through L1 transport observation: %s", async kind => {
  const store = storeOf();
  let carrying: import("@pcash/sdk/relay").RelayJournalEntry | undefined;
  let proofs = 0;
  let broadcasts = 0;
  const preflight = vi.fn(async () => {
    if (carrying !== undefined && kind === "unrelated") throw new Error("adapter capacity is occupied");
    return null;
  });
  const checkpoints: string[] = [];
  const submission: DurableSubmissionAdapter<null, null> = {
    mode: "l1", preflight,
    l1Recovery: async () => ({
      reconcile: async () => ({ latched: carrying !== undefined, entries: [] }),
      show: async () => ({ latched: carrying !== undefined, entries: carrying === undefined ? [] : [carrying] }),
      resolve: async () => { throw new Error("not requested"); },
    }),
    submit: async ({ transactionBytes }) => {
      broadcasts++;
      const { contentHash } = transactionIdentity(transactionBytes);
      carrying = { kind: "batch", selected: [contentHash], transactionHash: hex(700n) } as import("@pcash/sdk/relay").RelayJournalEntry;
      throw new Error("response lost after Ethereum publication");
    },
  };
  const run = () => runNoteFundedTransferClient({
    node: testNode(), store, wallet, signer, chainId: CHAIN_ID,
    to: addressHex(wallet.address), amount: 4n, openFeeAmount: 0n,
    status, deterministicTransactionInput, submission,
    onPrepared: hash => { checkpoints.push(hash); },
    prover: { proveAndEncode: async build => { proofs++; return build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)); } },
  });
  await expect(run()).rejects.toThrow("response lost after Ethereum publication");
  const pending = (await store.load())!.pendingNoteFundedTransfers![0]!;
  expect(pending.l1TxHash).toBeUndefined();
  checkpoints.length = 0; // The application lost its own checkpoint; the wallet retained the value journal.
  if (kind === "ambiguous") carrying!.transactionHash = null;
  if (kind === "unrelated") (carrying as import("@pcash/sdk/relay").RelayBatchJournalEntry).selected = [hex(999n)];
  if (kind === "known") {
    expect(await run()).toMatchObject({ contentHash: pending.contentHash, accepted: false, queued: false, retried: true, recovered: true });
    expect((await store.load())!.pendingNoteFundedTransfers![0]!.l1TxHash).toBe(hex(700n));
  } else {
    await expect(run()).rejects.toThrow(kind === "ambiguous" ? "has no known hash" : "adapter capacity is occupied");
  }
  expect(checkpoints).toEqual([pending.contentHash]);
  expect(proofs).toBe(1);
  expect(broadcasts).toBe(1);
  expect(preflight).toHaveBeenCalledTimes(kind === "unrelated" ? 2 : 1);
});
