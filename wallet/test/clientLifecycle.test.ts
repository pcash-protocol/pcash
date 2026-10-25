import type { NoteFundedProver } from "@pcash/sdk/wallet/actions";
import { transactionIdentity as submissionIdentity } from "@pcash/sdk/protocol";
// Client lifecycle: receipt handling, reconciliation, scan cursor, and
// WalletRuntime account/transfer against a mock pcash node. No live node.

import { testForkCapabilityDto } from "./statusFixture.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectCurrentNoteTransferOpenings,
  DEFAULT_NOTE_FUNDED_VALIDITY_WINDOW,
  noteFundedTransferValidUntil,
} from "@pcash/sdk/wallet/testing";
import { DurablePreBroadcastError, type DurableSubmissionAdapter } from "@pcash/sdk/wallet";
import { RelayJournalRecoveryManager, type RelayJournalEntry } from "@pcash/sdk/relay";
import { releaseExpiredAccountActivation } from "@pcash/sdk/wallet/web";
import { syncWallet } from "@pcash/sdk/wallet/testing";
import { createWalletRuntime } from "@pcash/sdk/wallet/testing";
import { privateKeyPcashActionSigner, serializeEcdsaSignature, signDigest, type PcashActionSigner } from "@pcash/sdk/eip712";
import { assertTransactionTypeAccepted, transactionTypeOf, decodeTransaction, encodePrivateValueTransaction, encodeUserAccountCreation, WIRE_PROOF_BYTES } from "@pcash/sdk/protocol";
import {
  parseLocalChainCode,
  resolveRecipientDelivery,
} from "@pcash/sdk/delivery";
import { awaitAcceptedReceipt, awaitReceipt, type L1DeliveryBatchResult } from "@pcash/sdk/clients";
import { reconcilePendingNoteFundedTransfers } from "@pcash/sdk/wallet/testing";
import { PCASH_CHAIN_ID } from "@pcash/sdk/constants";
import { DEFAULT_INBOX } from "@pcash/sdk/l1";
import { addressHex, beBytes, concatBytes, keccak256, toHex } from "@pcash/sdk/utils";
import { generateMlKemKeyPair, RECENT_PCASH_BLOCK_WINDOW_SECONDS } from "@pcash/sdk/protocol";
import { requireReceiveKeys, walletExtendedCode } from "@pcash/sdk/wallet";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import { TEST_NK_ROOT, TEST_PRIV_KEY, deriveTestWallet } from "./testWallet.ts";
import { openNodeWalletDatabase } from "../src/node/walletDatabase.ts";
import { WALLET_DATABASE_STATE_STORE, type WalletDatabase } from "@pcash/sdk/wallet/database";
import { emptyWalletState as makeEmptyWalletFile } from "@pcash/sdk/wallet/testing";
import {
  addPendingNote,
  addPendingNoteFundedTransfer,
  addPendingUserAccountCreation,
  type WalletFileData,
} from "@pcash/sdk/wallet/testing";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PcashNodeClient } from "@pcash/sdk/clients";
import {
  boundaryId,
  computeBlockHash,
  computeStateRoot,
  transactionResultsRoot as computeTransactionResultsRoot,
  parseCurrentBoundaryEnvelope,
} from "@pcash/sdk/protocol";
import { accountStateCommitment, receiveKeyHash } from "@pcash/sdk/protocol";
import { rootFromIndex } from "@pcash/sdk/crypto";
import { nullifierTreeFixture } from "@pcash/test-support/protocol-fixtures";
import { WalletChainState, type NullifierConsumption } from "@pcash/sdk/wallet/testing";
import { memoryWalletStateStore } from "@pcash/sdk/wallet/testing";
import { ChainSim, chainRecords, denseRoot, type AccountRow } from "./chainFixture.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const ADDR = "0x1234567890123456789012345678901234567890";
const TEST_NETWORK = {
  pcashChainId: PCASH_CHAIN_ID,
  // Every ChainSim starts from this genesis, so a wallet here can sync against one.
  genesisHash: new ChainSim(PCASH_CHAIN_ID).genesisHash,
  l1ChainId: 11155111n,
  inboxAddress: DEFAULT_INBOX,
  genesisL1Block: 0n,
  genesisL1BlockHash: `0x${"33".repeat(32)}`,
};
const TEST_BINDING = { chainId: PCASH_CHAIN_ID, genesisHash: TEST_NETWORK.genesisHash };
const TEST_PROFILE = derivePcashProfileFromPrivateKey(TEST_PRIV_KEY, {
  pcashChainId: PCASH_CHAIN_ID,
  l1ChainId: TEST_NETWORK.l1ChainId,
  inboxAddress: TEST_NETWORK.inboxAddress,
});
const TEST_PROFILE_RULES = defaultUserAccountRuleSet({
  wallet: TEST_PROFILE,
  network: {
    pcashChainId: PCASH_CHAIN_ID,
    l1ChainId: TEST_NETWORK.l1ChainId,
    inboxAddress: TEST_NETWORK.inboxAddress,
  },
  secrets: TEST_PROFILE.defaultUserRuleSecrets,
});
/** The Ethereum account a direct creation must be sent from: the profile's own. */
const TEST_L1_SENDER = addressHex(TEST_PROFILE.address);
/** A creation entry with placeholder fields; only its authorization mode matters to submission. */
const placeholderCreation = (mode: "direct" | "signed") => encodeUserAccountCreation(PCASH_CHAIN_ID, concatBytes(
  Uint8Array.of(mode === "direct" ? 0 : 1), beBytes(1n, 32), beBytes(2n, 32), Uint8Array.of(0), beBytes(3n, 32), beBytes(100n, 8),
  ...(mode === "signed" ? [beBytes(1n, 32), beBytes(2n, 32), Uint8Array.of(0)] : []),
));
const emptyWalletFile = (address: bigint) => makeEmptyWalletFile({ address, network: TEST_BINDING });
const databases = new Map<string, Promise<WalletDatabase>>();
const stateStore = async (path: string, address: bigint) => {
  let database = databases.get(path);
  if (database === undefined) {
    database = openNodeWalletDatabase(path);
    databases.set(path, database);
  }
  return (await database)[WALLET_DATABASE_STATE_STORE]({ address, network: TEST_BINDING });
};
afterEach(async () => {
  for (const database of databases.values()) await (await database).close();
  databases.clear();
});
const loadWalletState = async (path: string, address: bigint): Promise<WalletFileData> => {
  const data = await (await stateStore(path, address)).load();
  if (data === null) throw new Error(`wallet state ${path} does not exist`);
  return data;
};
const saveWalletState = async (path: string, data: WalletFileData, chain?: Map<string, unknown>): Promise<void> => {
  await (await stateStore(path, BigInt(data.address))).save(data, chain === undefined ? {} : {
    chain: { state: WalletChainState.fromRecords(chain)!, commit: { replace: true, writes: chain } },
  });
};

const STUB_PROVERS = {
  privateValue: { proveAndEncode: async () => { throw new Error("unexpected private-value prove"); } },
  userAccountUpdate: {
    proveAndEncode: async (build: { encodeTransaction: (proof: Uint8Array) => Uint8Array }) =>
      build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)),
  },
};

function mempoolAdapter(
  node: PcashNodeClient,
  wait: boolean,
): DurableSubmissionAdapter<{ contentHash: string }, unknown> {
  return {
    mode: "mempool",
    async preflight({ transactionBytes: entry, status }) {
      assertTransactionTypeAccepted(status, transactionTypeOf(entry));
      return { contentHash: toHex(keccak256(entry)) };
    },
    async submit({ transactionBytes: entry, prepared }) {
      const admission = await node.submitRawTransaction(toHex(entry));
      if (wait) {
        await awaitAcceptedReceipt(node, prepared.contentHash, { pollIntervalMs: 0, pollMaxAttempts: 1 });
        return { accepted: true, queued: false, output: admission };
      }
      return { accepted: false, queued: true, output: admission };
    },
  };
}

/** Self-publication whose broadcast the tests observe through the node mock. */
function selfPublicationAdapter(node: PcashNodeClient, wait: boolean): DurableSubmissionAdapter<{ contentHash: string }, unknown> {
  return { ...mempoolAdapter(node, wait), mode: "l1" };
}

async function runtimeFor(node: PcashNodeClient, storePath: string, wait: boolean) {
  return createWalletRuntime({
    node,
    chainId: PCASH_CHAIN_ID,
    wallet: TEST_PROFILE,
    signer: privateKeyPcashActionSigner(TEST_PRIV_KEY),
    store: await stateStore(storePath, TEST_PROFILE.address),
    provers: STUB_PROVERS,
    submission: mempoolAdapter(node, wait),
    settlePollIntervalMs: 0,
    settlePollMaxAttempts: 1,
  });
}

describe("wallet runtime receive keys", () => {
  it("durably requires a full replay when a key is retained without one", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "pcash-runtime-key-")), "wallet.pglite");
    const runtime = await runtimeFor({} as PcashNodeClient, path, false);
    const pair = requireReceiveKeys(TEST_PROFILE);

    await runtime.importReceiveKey({
      publicKey: pair.mlKemPublicKey,
      secretKey: pair.mlKemSecretKey,
    }, { rescan: false });

    const stored = await loadWalletState(path, TEST_PROFILE.address);
    expect(stored.receiveKeys).toHaveLength(1);
    expect(stored.fullRescanRequired).toBe(true);
  });
});

// --- mock node -------------------------------------------------------------

interface MockCall {
  method: string;
  params: unknown[];
}

function mockNode(
  handlers: Record<string, (params: unknown[]) => unknown>,
  cap: MockCall[] = [],
): PcashNodeClient {
  const fetchFn = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    cap.push({ method: body.method, params: body.params });
    const h = handlers[body.method];
    const payload = h
      ? { jsonrpc: "2.0", id: body.id, result: h(body.params) }
      : { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `no mock for ${body.method}` } };
    return new Response(JSON.stringify(payload));
  };
  return new PcashNodeClient("http://mock", { fetchFn });
}

/** Synthetic header time for block `n`: 12 s slots from a fixed epoch. */
const tsOfBlock = (n: bigint) => 1_800_000_000n + n * 12n;
const word = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;
const statusResult = (latest: bigint, finalized: bigint) => ({
  latestBlock: `0x${latest.toString(16)}`,
  latestBlockHash: word(latest),
  latestBlockTimestamp: `0x${tsOfBlock(latest).toString(16)}`,
  finalizedBlock: `0x${finalized.toString(16)}`,
  finalizedBlockHash: `0x${finalized.toString(16).padStart(64, "0")}`,
  finalizedBlockTimestamp: `0x${tsOfBlock(finalized).toString(16)}`,
  latestL1BlockNumber: `0x${latest.toString(16)}`,
  latestL1BlockHash: `0x${latest.toString(16).padStart(64, "0")}`,
  observedL1BlockNumber: `0x${latest.toString(16)}`,
  derivation: { state: "following", sinceUnixMs: "0x0" },
  finalizedL1BlockNumber: `0x${finalized.toString(16)}`,
  finalizedL1BlockHash: `0x${finalized.toString(16).padStart(64, "0")}`,
  stateRoot: word(0n),
  l1OriginRoot: word(1n),
  historyRoot: word(2n),
  outputCount: "0x0",
  issuedSoFar: "0x0",
  supplyCap: "0x33b2e3c9fd0803ce8000000",
  totalSucceeded: "0x0",
  totalFailed: "0x0",
  totalTransactions: "0x0",
  index: { status: "ready", cursor: { blockNumber: `0x${latest.toString(16)}`, blockHash: word(latest) } },
  proverAssets: null,
  pcashChainId: `0x${PCASH_CHAIN_ID.toString(16)}`,
  genesisHash: TEST_NETWORK.genesisHash,
  acceptedTransactionTypes: ["0x0", "0x1", "0x2", "0x3"],
  acceptedBatchVersions: ["0x1"],
  l1ChainId: `0x${TEST_NETWORK.l1ChainId.toString(16)}`,
  inboxAddress: TEST_NETWORK.inboxAddress,
  genesisL1Block: `0x${TEST_NETWORK.genesisL1Block.toString(16)}`,
  genesisL1BlockHash: TEST_NETWORK.genesisL1BlockHash,
  forkCapability: testForkCapabilityDto(
    `0x${PCASH_CHAIN_ID.toString(16)}`,
    TEST_NETWORK.genesisHash,
    `0x${tsOfBlock(latest).toString(16)}`,
    word(3n),
  ),
});

const EMPTY_NULLIFIER_ROOT = nullifierTreeFixture().root;

function nullifierBoundary(
  latest: bigint,
  root: bigint,
  overrides: Partial<{
    outputRoot: bigint;
    outputCount: bigint;
    issuedSoFar: bigint;
    lagQ: bigint;
    accountStateRoot: bigint;
    accountCount: bigint;
  }> = {},
) {
  const state = {
    outputRoot: 0n,
    outputCount: 0n,
    issuedSoFar: 0n,
    lagQ: 0n,
    accountStateRoot: 0n,
    accountCount: 0n,
    nullifierRoot: root,
    nullifierCount: 0n,
    ...overrides,
  };
  const stateRoot = computeStateRoot(state);
  const header = {
    parentHash: latest === 0n ? 0n : latest - 1n,
    number: latest,
    timestamp: tsOfBlock(latest),
    transactionResultsRoot: computeTransactionResultsRoot([], []),
    stateRoot,
    l1OriginRoot: 1n,
    historyRoot: 2n,
  };
  const blockHash = computeBlockHash(header);
  return {
    state: {
      outputRoot: word(state.outputRoot),
      outputCount: `0x${state.outputCount.toString(16)}`,
      issuedSoFar: word(state.issuedSoFar),
      lagQ: state.lagQ.toString(),
      accountStateRoot: word(state.accountStateRoot),
      accountCount: `0x${state.accountCount.toString(16)}`,
      nullifierRoot: word(state.nullifierRoot),
      nullifierCount: `0x${state.nullifierCount.toString(16)}`,
    },
    header: {
      parentHash: word(header.parentHash),
      number: `0x${header.number.toString(16)}`,
      timestamp: `0x${header.timestamp.toString(16)}`,
      transactionResultsRoot: word(header.transactionResultsRoot),
      stateRoot: word(header.stateRoot),
      l1OriginRoot: word(header.l1OriginRoot),
      historyRoot: word(header.historyRoot),
    },
    blockHash: word(blockHash),
  };
}

function accountLeaf(row: AccountRow): bigint {
  const receiveKey = row.receiveKey ?? null;
  return accountStateCommitment(
    row.address,
    row.nullifierKeyCommitment,
    row.accountRuleSetCommitment,
    row.accountKind ?? 0,
    row.accountRevision ?? 1,
    receiveKey === null ? 0n : receiveKeyHash(receiveKey),
  );
}

/** Local chain records anchored at block `latest` whose tree holds exactly these output leaves and accounts. */
function localChain(latest: bigint, params: {
  leaves?: readonly bigint[];
  accounts?: readonly AccountRow[];
  consumed?: readonly (readonly [string, NullifierConsumption])[];
} = {}) {
  const leaves = params.leaves ?? [];
  const accounts = params.accounts ?? [];
  const anchor = parseCurrentBoundaryEnvelope(nullifierBoundary(latest, EMPTY_NULLIFIER_ROOT, {
    outputRoot: denseRoot(leaves),
    outputCount: BigInt(leaves.length),
    accountStateRoot: denseRoot(accounts.map(accountLeaf)),
    accountCount: BigInt(accounts.length),
  }));
  const records = chainRecords({
    outputs: leaves.map((leaf) => ({ leaf, mark: true })),
    accounts,
    anchor,
    ...(params.consumed === undefined ? {} : { consumed: params.consumed }),
  });
  return { records, anchor };
}

const receiptAt =(block: number, accepted: boolean, contentHash = `0x${"00".repeat(32)}`) => ({
  inclusion: {
    l1BlockNumber: `0x${block.toString(16)}`,
    l1BlockHash: `0x${"11".repeat(32)}`,
    l1TransactionIndex: "0x0",
    l1TransactionHash: `0x${"7c".repeat(32)}`,
    batchItemIndex: "0x0",
  },
  transactionId: word(BigInt(block) + 500n),
  contentHash,
  outcome: accepted ? "succeeded" : "proofRejected",
  failureDetail: null,
  l1Sender: "0x0000000000000000000000000000000000000000",
  issuanceOwnerCommitment: null,
  settledOpenFeeAmount: "0x0",
  settledIssuanceAmount: "0x0",
  kind: "userAccountCreation",
  fundingMode: null,
  outputLeafStart: null,
  outputsAdded: "0x0",
  nullifiers: null,
  account: null,
});

const accountDto = () => ({
  address: `0x${TEST_PROFILE.address.toString(16).padStart(40, "0")}`,
  index: "0x0",
  accountRevision: "0x1",
  nullifierKeyCommitment: word(TEST_PROFILE.nullifierKeyCommitment),
  accountRuleSetCommitment: word(TEST_PROFILE_RULES.accountRuleSetCommitment),
  accountKind: "0x0",
  receiveKeyHash: word(receiveKeyHash(TEST_PROFILE.mlKemPublicKey)),
  material: { status: "available", mlKem768PublicKey: toHex(TEST_PROFILE.mlKemPublicKey) },
});

const profileAccountRow = (): AccountRow => ({
  address: accountDto().address,
  nullifierKeyCommitment: TEST_PROFILE.nullifierKeyCommitment,
  accountRuleSetCommitment: TEST_PROFILE_RULES.accountRuleSetCommitment,
  receiveKey: TEST_PROFILE.mlKemPublicKey,
});

/** A wallet file synced to block 10, where the profile has no account yet. */
const saveUnactivatedWallet = (path: string) =>
  saveWalletState(path, emptyWalletFile(TEST_PROFILE.address), localChain(10n).records);

describe("account runtime", () => {
  it("creates the Ethereum-derived default profile with the requested receive key", async () => {
    const calls: MockCall[] = [];
    let submittedContentHash = "";
    let submittedEntry = "";
    const replacement = generateMlKemKeyPair(new Uint8Array(64).fill(0x44));
    const node = mockNode({
      pcash_status: () => statusResult(10n, 9n),
      pcash_getBlockByNumber: () => ({ ...blockDto(10n, word(9n)), hash: word(10n) }),
      pcash_submitRawTransaction: ([entry]) => {
        expect(entry).toMatch(/^0x01/);
        submittedEntry = entry as string;
        submittedContentHash = toHex(keccak256(Uint8Array.from(Buffer.from((entry as string).slice(2), "hex"))));
        return {
          contentHash: submittedContentHash,
          statementId: word(0x22n),
          stableId: word(0x33n),
          status: "ready",
          headCheckedBlock: "0xa",
          headCheckedBlockHash: word(0x0an),
        };
      },
      pcash_getReceipt: () => [receiptAt(10, true, submittedContentHash)],
    }, calls);
    const path = join(mkdtempSync(join(tmpdir(), "pcash-account-create-")), "wallet.pglite");
    await saveUnactivatedWallet(path);
    await expect((await runtimeFor(node, path, true)).account({
      receiveKey: { operation: "replace", keyPair: replacement },
    })).resolves.toMatchObject({ accepted: true });
    expect(calls.map((call) => call.method)).toContain("pcash_submitRawTransaction");
    expect(submittedEntry).toContain(toHex(replacement.publicKey).slice(2));
    expect(calls.map((call) => call.method)).not.toContain("pcash_estimateFee");
  });

  it("publishes a new account on the wallet's own L1 creation path unless the caller names one", async () => {
    const creationNode = (calls: MockCall[]) => mockNode({
      pcash_status: () => statusResult(10n, 9n),
      pcash_getBlockByNumber: () => ({ ...blockDto(10n, word(9n)), hash: word(10n) }),
      pcash_submitRawTransaction: ([entry]) => ({
        contentHash: toHex(keccak256(Uint8Array.from(Buffer.from((entry as string).slice(2), "hex")))),
        statementId: word(0x22n), stableId: word(0x33n), status: "ready", headCheckedBlock: "0xa", headCheckedBlockHash: word(0x0an),
      }),
      pcash_getReceipt: () => [],
    }, calls);
    const posted: string[] = [];
    const ownL1: DurableSubmissionAdapter<{ contentHash: string }, unknown> = {
      mode: "l1",
      preflight: async ({ transactionBytes }) => { const { contentHash } = submissionIdentity(transactionBytes); return ({ contentHash }); },
      submit: async ({ transactionBytes }) => {
        const { contentHash } = submissionIdentity(transactionBytes);
        posted.push(contentHash); return { accepted: false, queued: true, l1Hash: word(0x77n), output: null };
      },
    };
    const runtime = async (node: PcashNodeClient) => {
      const path = join(mkdtempSync(join(tmpdir(), "pcash-account-default-")), "wallet.pglite");
      await saveUnactivatedWallet(path);
      return createWalletRuntime({
        node, chainId: PCASH_CHAIN_ID, wallet: TEST_PROFILE, signer: privateKeyPcashActionSigner(TEST_PRIV_KEY),
        store: await stateStore(path, TEST_PROFILE.address), provers: STUB_PROVERS,
        submission: mempoolAdapter(node, false), userAccountCreationSubmission: ownL1,
        settlePollIntervalMs: 0, settlePollMaxAttempts: 1,
      });
    };

    // The update path the caller passes does not redirect a creation.
    const defaultedCalls: MockCall[] = [];
    const defaulted = creationNode(defaultedCalls);
    await (await runtime(defaulted)).account({ submission: mempoolAdapter(defaulted, false) });
    expect(posted).toHaveLength(1);
    expect(defaultedCalls.map((call) => call.method)).not.toContain("pcash_submitRawTransaction");

    // An explicit creation path, here the mempool, is honored.
    const explicitCalls: MockCall[] = [];
    const explicit = creationNode(explicitCalls);
    await (await runtime(explicit)).account({ userAccountCreationSubmission: mempoolAdapter(explicit, false) });
    expect(posted).toHaveLength(1);
    expect(explicitCalls.map((call) => call.method)).toContain("pcash_submitRawTransaction");
  });

  it("prepares direct creation without an action signer and preserves its exact mode on retry", async () => {
    const node = mockNode({
      pcash_status: () => statusResult(10n, 9n),
      pcash_getBlockByNumber: () => ({ ...blockDto(10n, word(9n)), hash: word(10n) }),
    });
    const path = join(mkdtempSync(join(tmpdir(), "pcash-direct-prepare-")), "wallet.pglite");
    await saveUnactivatedWallet(path);
    const store = await stateStore(path, TEST_PROFILE.address);
    const direct = createWalletRuntime({ node, chainId: PCASH_CHAIN_ID, wallet: TEST_PROFILE, store });
    const pending = await direct.prepareAccountActivation({ authorizationMode: "direct" });
    expect(decodeTransaction(Uint8Array.from(Buffer.from(pending.transactionHex.slice(2), "hex")))).toMatchObject({ authorization: { kind: "direct" } });
    expect(await direct.prepareAccountActivation({ authorizationMode: "direct" })).toEqual(pending);
    const unsupported = createWalletRuntime({ node, chainId: PCASH_CHAIN_ID, wallet: TEST_PROFILE, store,
      submission: { mode: "l1", preflight: vi.fn(), submit: vi.fn() },
    });
    await expect(unsupported.submitAccountActivation()).rejects.toThrow(`direct account activation must be sent on Ethereum by ${TEST_L1_SENDER}`);
    expect((await store.load())?.pendingUserAccountCreations?.[0]).toMatchObject({ state: "prepared", transactionHex: pending.transactionHex, l1TxHash: null });
    const signed = await runtimeFor(node, path, false);
    await expect(signed.prepareAccountActivation()).rejects.toThrow(/different exact account activation/);
    expect((await loadWalletState(path, TEST_PROFILE.address)).pendingUserAccountCreations?.[0]?.contentHash).toBe(pending.contentHash);
  });

  it("refuses a direct activation sent from another Ethereum account before preflight", async () => {
    const node = mockNode({
      pcash_status: () => statusResult(10n, 9n),
      pcash_getBlockByNumber: () => ({ ...blockDto(10n, word(9n)), hash: word(10n) }),
    });
    const path = join(mkdtempSync(join(tmpdir(), "pcash-direct-sender-")), "wallet.pglite");
    await saveUnactivatedWallet(path);
    const store = await stateStore(path, TEST_PROFILE.address);
    const preflight = vi.fn(async () => null);
    const submit = vi.fn();
    // The node would create the sender's account, not this wallet's.
    const runtime = createWalletRuntime({ node, chainId: PCASH_CHAIN_ID, wallet: TEST_PROFILE, store,
      userAccountCreationSubmission: { mode: "l1", l1Sender: `0x${"34".repeat(20)}`, preflight, submit } });
    const pending = await runtime.prepareAccountActivation({ authorizationMode: "direct" });
    await expect(runtime.submitAccountActivation()).rejects.toThrow(`direct account activation must be sent on Ethereum by ${TEST_L1_SENDER}`);
    expect(preflight).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect((await store.load())?.pendingUserAccountCreations).toEqual([pending]);
  });

  it("refuses an activation signature that recovers to another account before journaling", async () => {
    const node = mockNode({
      pcash_status: () => statusResult(10n, 9n),
      pcash_getBlockByNumber: () => ({ ...blockDto(10n, word(9n)), hash: word(10n) }),
    });
    const path = join(mkdtempSync(join(tmpdir(), "pcash-signed-signer-")), "wallet.pglite");
    await saveUnactivatedWallet(path);
    const store = await stateStore(path, TEST_PROFILE.address);
    // Claims this wallet's address but signs with another key. The node would
    // create the recovered signer's account, so the wallet must not build it.
    const otherKey = Uint8Array.from({ length: 32 }, (_, i) => i + 34);
    const signer: PcashActionSigner = {
      address: privateKeyPcashActionSigner(TEST_PRIV_KEY).address,
      signTypedData: async (request) => serializeEcdsaSignature(signDigest(otherKey, request.digest)),
    };
    const preflight = vi.fn(async () => null);
    const submit = vi.fn();
    const beforeJournal = vi.fn();
    const runtime = createWalletRuntime({ node, chainId: PCASH_CHAIN_ID, wallet: TEST_PROFILE, signer, store, provers: STUB_PROVERS,
      userAccountCreationSubmission: { mode: "l1", l1Sender: TEST_L1_SENDER, preflight, submit } });
    await expect(runtime.account({ beforeJournal })).rejects.toThrow(
      `signature recovers ${addressHex(privateKeyPcashActionSigner(otherKey).address)}, expected ${TEST_L1_SENDER}`);
    expect(beforeJournal).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect((await store.load())?.pendingUserAccountCreations).toBeUndefined();
  });

  it("keeps direct activation bytes through transaction rejection and retries only the Ethereum submission", async () => {
    const node = mockNode({
      pcash_status: () => statusResult(10n, 9n),
      pcash_getBlockByNumber: () => ({ ...blockDto(10n, word(9n)), hash: word(10n) }),
    });
    const path = join(mkdtempSync(join(tmpdir(), "pcash-direct-retry-")), "wallet.pglite");
    await saveUnactivatedWallet(path);
    const store = await stateStore(path, TEST_PROFILE.address);
    let reject = true;
    const entries: string[] = [];
    const adapter: DurableSubmissionAdapter<null, null> = {
      mode: "l1", l1Sender: TEST_L1_SENDER, preflight: async () => null,
      isDefinitePreBroadcastError: (error) => error instanceof DurablePreBroadcastError,
      submit: async ({ transactionBytes: entry }) => {
        expect((await store.load())?.pendingUserAccountCreations?.[0]?.state).toBe("broadcast-requested");
        entries.push(toHex(entry));
        if (reject) throw new DurablePreBroadcastError(new Error("wallet rejected transaction"));
        return { accepted: false, queued: true, l1Hash: word(0xaan), output: null };
      },
    };
    const runtime = createWalletRuntime({ node, chainId: PCASH_CHAIN_ID, wallet: TEST_PROFILE, store, userAccountCreationSubmission: adapter });
    const prepared = await runtime.prepareAccountActivation({ authorizationMode: "direct" });
    await expect(runtime.submitAccountActivation()).rejects.toThrow(/wallet rejected transaction/);
    expect((await store.load())?.pendingUserAccountCreations?.[0]).toMatchObject({ state: "prepared", transactionHex: prepared.transactionHex });
    reject = false;
    await runtime.submitAccountActivation();
    expect(entries).toEqual([prepared.transactionHex, prepared.transactionHex]);
    expect((await store.load())?.pendingUserAccountCreations?.[0]).toMatchObject({ state: "l1-submitted", l1TxHash: word(0xaan) });
    await expect(runtime.submitAccountActivation()).rejects.toThrow(/already submitted/);
  });

  it("keeps setup and mining bytes across reload and retries only the Ethereum submission", async () => {
    const node = mockNode({
      pcash_status: () => statusResult(10n, 9n),
      pcash_getBlockByNumber: () => ({ ...blockDto(10n, word(9n)), hash: word(10n) }),
    });
    const path = join(mkdtempSync(join(tmpdir(), "pcash-direct-retry-")), "wallet.pglite");
    await saveUnactivatedWallet(path);
    const store = await stateStore(path, TEST_PROFILE.address);
    let reject = true;
    const entries: string[] = [];
    const batches: string[][] = [];
    const adapter: DurableSubmissionAdapter<null, null> = {
      mode: "l1", l1Sender: TEST_L1_SENDER, preflight: async ({ transactionBytes: entry, additionalTransactions = [] }) => { batches.push([entry, ...additionalTransactions].map(toHex)); return null; },
      isDefinitePreBroadcastError: (error) => error instanceof DurablePreBroadcastError,
      submit: async ({ transactionBytes: entry }) => {
        expect((await store.load())?.pendingUserAccountCreations?.[0]?.state).toBe("broadcast-requested");
        entries.push(toHex(entry));
        if (reject) throw new DurablePreBroadcastError(new Error("wallet rejected transaction"));
        return { accepted: false, queued: true, l1Hash: word(0xaan), output: null };
      },
    };
    const proveAndEncode = vi.fn<NoteFundedProver["proveAndEncode"]>(async (build) => encodePrivateValueTransaction({ shape: build.shape, publicInputs: build.publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData: build.outputData, arena: build.arena }));
    const actionSigner = { address: privateKeyPcashActionSigner(TEST_PRIV_KEY).address, signTypedData: vi.fn(async () => { throw new Error("setup mining must not sign"); }) };
    const open = () => createWalletRuntime({ node, chainId: PCASH_CHAIN_ID, wallet: TEST_PROFILE, store,
      signer: actionSigner, provers: { ...STUB_PROVERS, privateValue: { proveAndEncode } }, userAccountCreationSubmission: adapter });
    const first = open();
    const prepared = await first.prepareAccountActivation({ authorizationMode: "direct", mine: true });
    expect(prepared.miningTransactionHex).toBeDefined();
    expect(decodeTransaction(Uint8Array.from(Buffer.from(prepared.miningTransactionHex!.slice(2), "hex")))).toMatchObject({ kind: 0 });
    const runtime = open();
    expect(await runtime.prepareAccountActivation({ authorizationMode: "direct", mine: true })).toEqual(prepared);
    expect(proveAndEncode).toHaveBeenCalledOnce();
    await expect(runtime.submitAccountActivation()).rejects.toThrow(/wallet rejected transaction/);
    expect((await store.load())?.pendingUserAccountCreations?.[0]).toMatchObject({ state: "prepared", transactionHex: prepared.transactionHex });
    reject = false;
    await runtime.submitAccountActivation();
    expect(entries).toEqual([prepared.transactionHex, prepared.transactionHex]);
    expect(batches).toEqual([[prepared.transactionHex, prepared.miningTransactionHex], [prepared.transactionHex, prepared.miningTransactionHex]]);
    expect(proveAndEncode).toHaveBeenCalledOnce();
    const mining = (await store.load())?.pendingNoteFundedTransfers?.[0];
    expect(actionSigner.signTypedData).not.toHaveBeenCalled();
    expect(proveAndEncode.mock.calls[0]![0].authorizationCircuit).toBe("account_rule_mine");
    expect(mining).toMatchObject({ kind: "mine", transactionHex: prepared.miningTransactionHex, transferAmount: "0", openFeeAmount: "0", change: null });
    expect(mining?.inputs).toHaveLength(4);
    expect(mining?.inputs.every((input) => input.spentCommitment === null)).toBe(true);
    expect((await store.load())?.pendingUserAccountCreations?.[0]).toMatchObject({ state: "l1-submitted", l1TxHash: word(0xaan) });
    await expect(runtime.submitAccountActivation()).rejects.toThrow(/already submitted/);
    await runtime.clearAccountActivation();
    expect((await store.load())?.pendingUserAccountCreations).toBeUndefined();
    expect((await store.load())?.pendingNoteFundedTransfers).toEqual([mining]);
  });

  it.each(["prepared", "broadcast-requested", "l1-submitted", "declined"] as const)(
    "keeps the winning setup proof when a second tab finishes during %s", async (stage) => {
      const node = mockNode({
        pcash_status: () => statusResult(10n, 9n),
        pcash_getBlockByNumber: () => ({ ...blockDto(10n, word(9n)), hash: word(10n) }),
      });
      const path = join(mkdtempSync(join(tmpdir(), "pcash-setup-race-")), "wallet.pglite");
      await saveUnactivatedWallet(path);
      const store = await stateStore(path, TEST_PROFILE.address);
      const submitting = deferred();
      const finishSubmission = deferred();
      const batches: string[][] = [];
      const adapter: DurableSubmissionAdapter<null, null> = {
        mode: "l1",
        l1Sender: TEST_L1_SENDER,
        preflight: async ({ transactionBytes: entry, additionalTransactions = [] }) => { batches.push([entry, ...additionalTransactions].map(toHex)); return null; },
        isDefinitePreBroadcastError: (error) => error instanceof DurablePreBroadcastError,
        submit: async () => {
          submitting.resolve();
          await finishSubmission.promise;
          if (stage === "declined") throw new DurablePreBroadcastError(new Error("wallet rejected transaction"));
          return { accepted: false, queued: true, l1Hash: word(0xaan), output: null };
        },
      };
      const tab = (proofByte: number) => {
        const started = deferred();
        const finish = deferred();
        const proveAndEncode: NoteFundedProver["proveAndEncode"] = async (build) => {
          started.resolve();
          await finish.promise;
          return encodePrivateValueTransaction({ shape: build.shape, publicInputs: build.publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES).fill(proofByte), outputData: build.outputData, arena: build.arena });
        };
        const runtime = createWalletRuntime({ node, chainId: PCASH_CHAIN_ID, wallet: TEST_PROFILE, store,
          signer: privateKeyPcashActionSigner(TEST_PRIV_KEY), provers: { ...STUB_PROVERS, privateValue: { proveAndEncode } }, userAccountCreationSubmission: adapter });
        return { runtime, started, finish };
      };
      const a = tab(1), b = tab(2);
      await a.runtime.prepareAccountActivation({ authorizationMode: "direct" });
      const first = a.runtime.prepareAccountActivation({ authorizationMode: "direct", mine: true });
      const second = b.runtime.prepareAccountActivation({ authorizationMode: "direct", mine: true });
      await Promise.all([a.started.promise, b.started.promise]);
      a.finish.resolve();
      const winner = await first;
      let submission: Promise<unknown> | undefined;
      if (stage !== "prepared") {
        submission = a.runtime.submitAccountActivation();
        await submitting.promise;
        if (stage !== "broadcast-requested") {
          finishSubmission.resolve();
          if (stage === "declined") await expect(submission).rejects.toThrow("wallet rejected transaction");
          else await submission;
        }
      }
      b.finish.resolve();
      const authoritative = await second;
      expect(authoritative).toMatchObject({ contentHash: winner.contentHash, miningTransactionHex: winner.miningTransactionHex,
        state: stage === "declined" ? "prepared" : stage });
      const saved = await store.load();
      expect(saved?.pendingUserAccountCreations).toEqual([authoritative]);
      expect(saved?.pendingNoteFundedTransfers).toHaveLength(1);
      expect(saved?.pendingNoteFundedTransfers?.[0]?.transactionHex).toBe(winner.miningTransactionHex);
      if (stage !== "prepared") expect(batches).toEqual([[winner.transactionHex, winner.miningTransactionHex]]);
      if (stage === "broadcast-requested") { finishSubmission.resolve(); await submission; }
      if (stage === "declined") {
        expect(await b.runtime.prepareAccountActivation({ authorizationMode: "direct", mine: true })).toEqual(authoritative);
      }
    },
  );

  it.each(["cleared", "replaced", "submitted"] as const)("discards a late setup proof after activation is %s", async (change) => {
    const node = mockNode({
      pcash_status: () => statusResult(10n, 9n),
      pcash_getBlockByNumber: () => ({ ...blockDto(10n, word(9n)), hash: word(10n) }),
    });
    const path = join(mkdtempSync(join(tmpdir(), "pcash-setup-stale-")), "wallet.pglite");
    await saveUnactivatedWallet(path);
    const store = await stateStore(path, TEST_PROFILE.address);
    const started = deferred(), finish = deferred();
    const proveAndEncode: NoteFundedProver["proveAndEncode"] = async (build) => {
      started.resolve(); await finish.promise;
      return encodePrivateValueTransaction({ shape: build.shape, publicInputs: build.publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData: build.outputData, arena: build.arena });
    };
    const adapter: DurableSubmissionAdapter<null, null> = { mode: "l1", l1Sender: TEST_L1_SENDER, preflight: async () => null,
      submit: async () => ({ accepted: false, queued: true, l1Hash: word(0xaan), output: null }) };
    const open = () => createWalletRuntime({ node, chainId: PCASH_CHAIN_ID, wallet: TEST_PROFILE, store,
      signer: privateKeyPcashActionSigner(TEST_PRIV_KEY), provers: { ...STUB_PROVERS, privateValue: { proveAndEncode } }, userAccountCreationSubmission: adapter });
    const a = open(), b = open();
    const pending = a.prepareAccountActivation({ authorizationMode: "direct", mine: true });
    await started.promise;
    if (change === "submitted") await b.submitAccountActivation();
    else {
      await b.clearAccountActivation();
      if (change === "replaced") await b.prepareAccountActivation({ authorizationMode: "direct", validUntilTimestamp: 999n });
    }
    const before = await store.load();
    finish.resolve();
    await expect(pending).rejects.toThrow(/Account activation (changed|was submitted) while preparing setup mining/);
    expect(await store.load()).toEqual(before);
    expect((await store.load())?.pendingNoteFundedTransfers ?? []).toHaveLength(0);
  });

  it.each([false, true])("recovers a broadcast hash after a receipt failure (interrupted handoff: %s)", async (interrupted) => {
    const node = mockNode({
      pcash_status: () => statusResult(10n, 9n),
      pcash_getBlockByNumber: () => ({ ...blockDto(10n, word(9n)), hash: word(10n) }),
    });
    const path = join(mkdtempSync(join(tmpdir(), "pcash-activation-hash-")), "wallet.pglite");
    await saveUnactivatedWallet(path);
    const store = await stateStore(path, TEST_PROFILE.address);
    const onSubmitted = vi.fn();
    let broadcastHash: string | null = null;
    let activationContentHash = "";
    const submit = vi.fn(async ({ onL1Submitted }: { onL1Submitted?: (hash: string) => Promise<void> }) => {
      broadcastHash = word(0xaan);
      if (!interrupted) {
        await onL1Submitted!(broadcastHash);
        expect(onSubmitted).toHaveBeenCalledOnce();
        expect((await store.load())?.pendingUserAccountCreations?.[0]).toMatchObject({ state: "l1-submitted", l1TxHash: broadcastHash });
      }
      throw new Error("Receipt lookup unavailable");
    });
    const runtime = createWalletRuntime({
      node, chainId: PCASH_CHAIN_ID, wallet: TEST_PROFILE, store,
      userAccountCreationSubmission: {
        mode: "l1", l1Sender: TEST_L1_SENDER, preflight: async () => null, submit,
        l1Recovery: async () => ({
          show: async () => ({ latched: broadcastHash !== null, entries: broadcastHash === null ? []
            : [{ kind: "batch", selected: [activationContentHash], transactionHash: broadcastHash } as RelayJournalEntry] }),
          reconcile: vi.fn(), resolve: vi.fn(),
        }),
      },
    });
    const prepared = await runtime.prepareAccountActivation({ authorizationMode: "direct" });
    activationContentHash = prepared.contentHash;
    await expect(runtime.submitAccountActivation(onSubmitted)).rejects.toThrow("Receipt lookup unavailable");
    expect(await runtime.accountActivation()).toMatchObject({ state: "l1-submitted", l1TxHash: broadcastHash, contentHash: prepared.contentHash });
    expect((await store.load())?.pendingUserAccountCreations?.[0]?.l1TxHash).toBe(broadcastHash);
    await expect(runtime.submitAccountActivation()).rejects.toThrow("already submitted");
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each(["ambiguous", "pending", "unobserved"])("retains expired activation while its Ethereum submission is %s", async (outcome) => {
    const hash = outcome === "ambiguous" ? null : word(0xaan);
    let expired = false;
    const node = mockNode({
      pcash_status: () => statusResult(expired ? 200n : 10n, 9n),
    });
    const path = join(mkdtempSync(join(tmpdir(), "pcash-expired-activation-")), "wallet.pglite");
    await saveUnactivatedWallet(path);
    const store = await stateStore(path, TEST_PROFILE.address);
    let entry: RelayJournalEntry | null = null;
    const journal = {
      read: async () => entry === null ? [] : [entry],
      clear: vi.fn(async () => { entry = null; }),
      archive: vi.fn(), create: vi.fn(), replace: vi.fn(),
    };
    const receipt = { status: "success" as const, blockNumber: 9n, blockHash: word(9n), transactionIndex: 0, gasUsed: 21_000n };
    const readL1Receipt = vi.fn().mockResolvedValue(outcome === "unobserved" ? receipt : null);
    const getInboxDeliveryBatch = vi.fn<() => Promise<L1DeliveryBatchResult | null>>().mockResolvedValue(null);
    const recovery = new RelayJournalRecoveryManager({
      journal, node: { getInboxDeliveryBatch }, readL1Receipt,
    });
    const submit = vi.fn();
    const runtime = createWalletRuntime({
      node, chainId: PCASH_CHAIN_ID, wallet: TEST_PROFILE, store,
      userAccountCreationSubmission: {
        mode: "l1", preflight: vi.fn(), submit,
        l1Recovery: async () => recovery,
      },
    });
    const prepared = await runtime.prepareAccountActivation({ authorizationMode: "direct" });
    entry = { kind: "batch", resolutionId: "expired-setup", selected: [prepared.contentHash], transactionHash: hash, previousTransactionHashes: [] as string[] } as RelayJournalEntry;
    expired = true;
    const pending = await runtime.accountActivation();
    expect(pending).toMatchObject({ contentHash: prepared.contentHash, l1TxHash: hash, state: hash === null ? "broadcast-requested" : "l1-submitted" });
    expect(await runtime.prepareAccountActivation({ authorizationMode: "direct" })).toEqual(pending);
    await expect(runtime.submitAccountActivation()).rejects.toThrow(hash === null ? "ambiguous" : "already submitted");
    expect(submit).not.toHaveBeenCalled();
    await expect(releaseExpiredAccountActivation({ wallet: runtime, node, recovery, contentHash: prepared.contentHash })).rejects.toThrow(
      outcome === "unobserved" ? "Wait for PCASH to process it" : "Ethereum submission is unresolved",
    );
    expect(journal.archive).not.toHaveBeenCalled();
    expect(journal.clear).not.toHaveBeenCalled();
    expect(await runtime.accountActivation()).toEqual(pending);
    expect(await runtime.prepareAccountActivation({ authorizationMode: "direct" })).toEqual(pending);
    expect(submit).not.toHaveBeenCalled();
    entry = { ...entry!, transactionHash: word(0xaan) };
    readL1Receipt.mockResolvedValue({ ...receipt, status: "reverted" });
    await expect(recovery.reconcile()).resolves.toMatchObject({ latched: true, entries: [{ outcome: "unobserved" }] });
    expect(await runtime.accountActivation()).toMatchObject({ contentHash: prepared.contentHash });
    expect(journal.clear).not.toHaveBeenCalled();
    // Canonical delivery releases recovery; expiry can then retire the saved activation.
    getInboxDeliveryBatch.mockResolvedValue({ l1TransactionHash: word(0xaan) } as L1DeliveryBatchResult);
    await expect(recovery.reconcile()).resolves.toMatchObject({ latched: false, entries: [{ outcome: "cleared" }] });
    expect(await runtime.accountActivation()).toBeNull();
    const next = await runtime.prepareAccountActivation({ authorizationMode: "direct" });
    expect(next.contentHash).not.toBe(prepared.contentHash);
    expect(next.state).toBe("prepared");
  });

  it("refuses to replace a different exact activation intent", async () => {
    const node = mockNode({
      pcash_status: () => statusResult(10n, 9n),
    });
    const path = join(mkdtempSync(join(tmpdir(), "pcash-account-intent-")), "wallet.pglite");
    await saveUnactivatedWallet(path);
    const runtime = await runtimeFor(node, path, false);
    const first = await runtime.prepareAccountActivation();
    const replacement = generateMlKemKeyPair(new Uint8Array(64).fill(0x55));

    await expect(runtime.prepareAccountActivation({
      receiveKey: { operation: "replace", keyPair: replacement },
    })).rejects.toThrow(/different exact account activation/);
    expect((await loadWalletState(path, TEST_PROFILE.address)).pendingUserAccountCreations?.[0]?.contentHash)
      .toBe(first.contentHash);
  });

  it("refuses an activation deadline beyond its recent block's window", async () => {
    const node = mockNode({
      pcash_status: () => statusResult(10n, 9n),
    });
    const path = join(mkdtempSync(join(tmpdir(), "pcash-account-deadline-")), "wallet.pglite");
    await saveUnactivatedWallet(path);
    const runtime = await runtimeFor(node, path, false);
    const windowEnd = tsOfBlock(10n) + RECENT_PCASH_BLOCK_WINDOW_SECONDS;

    await expect(runtime.prepareAccountActivation({ validUntilTimestamp: windowEnd + 1n }))
      .rejects.toThrow(/beyond its recent PCASH block's window/);
    expect((await loadWalletState(path, TEST_PROFILE.address)).pendingUserAccountCreations ?? []).toHaveLength(0);
    const pending = await runtime.prepareAccountActivation({ validUntilTimestamp: windowEnd });
    expect(pending.validUntilTimestamp).toBe(windowEnd.toString());
  });

  it("serializes direct activation submission across wallet instances", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "pcash-account-direct-")), "wallet.pglite");
    const address = accountDto().address;
    const entry = placeholderCreation("direct");
    const contentHash = toHex(keccak256(entry));
    const data = emptyWalletFile(TEST_PROFILE.address);
    addPendingUserAccountCreation(data, {
      contentHash,
      transactionHex: toHex(entry),
      address,
      pcashChainId: PCASH_CHAIN_ID.toString(),
      pcashGenesisHash: TEST_NETWORK.genesisHash,
      l1ChainId: TEST_NETWORK.l1ChainId.toString(),
      inboxAddress: TEST_NETWORK.inboxAddress,
      genesisL1Block: TEST_NETWORK.genesisL1Block.toString(),
      genesisL1BlockHash: TEST_NETWORK.genesisL1BlockHash,
      ruleSetCommitment: "1",
      receiveKeyHash: word(0n),
      recentPcashBlockNumber: "10",
      recentPcashBlockHash: word(10n),
      validUntilTimestamp: (tsOfBlock(10n) + 1_800n).toString(),
      state: "prepared",
      l1TxHash: null,
      preparedAtUnixMs: "1",
    });
    await saveWalletState(path, data);
    const node = mockNode({
      pcash_status: () => statusResult(10n, 9n),
      pcash_getBlockByNumber: () => ({ ...blockDto(10n, word(9n)), hash: word(10n) }),
    });
    let releaseSubmit!: () => void;
    const submitted = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    let enteredSubmit!: () => void;
    const submitEntered = new Promise<void>((resolve) => {
      enteredSubmit = resolve;
    });
    const adapter: DurableSubmissionAdapter<{ contentHash: string }, unknown> = {
      mode: "l1",
      l1Sender: TEST_L1_SENDER,
      preflight: async ({ transactionBytes }) => { const { contentHash: preparedContentHash } = submissionIdentity(transactionBytes); return ({ contentHash: preparedContentHash }); },
      submit: vi.fn(async () => {
        enteredSubmit();
        await submitted;
        return {
          accepted: false,
          queued: true,
          l1Hash: word(0xaan),
          output: null,
        };
      }),
    };
    const makeRuntime = async () => createWalletRuntime({
      node,
      chainId: PCASH_CHAIN_ID,
      wallet: TEST_PROFILE,
      signer: privateKeyPcashActionSigner(TEST_PRIV_KEY),
      store: await stateStore(path, TEST_PROFILE.address),
      userAccountCreationSubmission: adapter,
    });
    const first = (await makeRuntime()).submitAccountActivation();
    await submitEntered;
    await expect((await makeRuntime()).submitAccountActivation()).rejects.toThrow(/reserved by another operation/);
    releaseSubmit();
    await expect(first).resolves.toMatchObject({ l1Hash: word(0xaan) });
    expect(adapter.submit).toHaveBeenCalledTimes(1);
  });

  it("keeps mempool activation prepared after an ambiguous submission failure", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "pcash-account-mempool-retry-")), "wallet.pglite");
    const address = accountDto().address;
    const entry = placeholderCreation("signed");
    const data = emptyWalletFile(TEST_PROFILE.address);
    addPendingUserAccountCreation(data, {
      contentHash: toHex(keccak256(entry)),
      transactionHex: toHex(entry),
      address,
      pcashChainId: PCASH_CHAIN_ID.toString(),
      pcashGenesisHash: TEST_NETWORK.genesisHash,
      l1ChainId: TEST_NETWORK.l1ChainId.toString(),
      inboxAddress: TEST_NETWORK.inboxAddress,
      genesisL1Block: TEST_NETWORK.genesisL1Block.toString(),
      genesisL1BlockHash: TEST_NETWORK.genesisL1BlockHash,
      ruleSetCommitment: "1",
      receiveKeyHash: word(0n),
      recentPcashBlockNumber: "10",
      recentPcashBlockHash: word(10n),
      validUntilTimestamp: (tsOfBlock(10n) + 1_800n).toString(),
      state: "prepared",
      l1TxHash: null,
      preparedAtUnixMs: "1",
    });
    await saveWalletState(path, data);
    const node = mockNode({
      pcash_status: () => statusResult(10n, 9n),
      pcash_getBlockByNumber: () => ({ ...blockDto(10n, word(9n)), hash: word(10n) }),
    });
    const adapter: DurableSubmissionAdapter<null, unknown> = {
      mode: "mempool",
      preflight: async () => null,
      submit: async () => {
        throw new Error("node response lost");
      },
    };
    const runtime = createWalletRuntime({
      node,
      chainId: PCASH_CHAIN_ID,
      wallet: TEST_PROFILE,
      signer: privateKeyPcashActionSigner(TEST_PRIV_KEY),
      store: await stateStore(path, TEST_PROFILE.address),
      userAccountCreationSubmission: adapter,
    });
    await expect(runtime.submitAccountActivation()).rejects.toThrow("node response lost");
    expect((await loadWalletState(path, TEST_PROFILE.address)).pendingUserAccountCreations?.[0]?.state)
      .toBe("prepared");
  });

  it("reports acceptance and the advanced revision from the update path", async () => {
    const walletPath = join(mkdtempSync(join(tmpdir(), "pcash-account-update-")), "wallet.pglite");
    const { records, anchor } = localChain(10n, { accounts: [profileAccountRow()] });
    await saveWalletState(walletPath, emptyWalletFile(TEST_PROFILE.address), records);
    const calls: MockCall[] = [];
    let submittedContentHash = "";
    const node = mockNode({
      pcash_status: () => ({ ...statusResult(10n, 9n), latestBlockHash: boundaryId(anchor) }),
      pcash_submitRawTransaction: ([entry]) => {
        submittedContentHash = toHex(keccak256(Uint8Array.from(Buffer.from((entry as string).slice(2), "hex"))));
        return {
          contentHash: submittedContentHash,
          statementId: word(0x22n),
          stableId: word(0x33n),
          status: "ready",
          headCheckedBlock: "0xa",
          headCheckedBlockHash: word(0x0an),
        };
      },
      pcash_getReceipt: () => [{
        ...receiptAt(10, true, submittedContentHash),
        kind: "userAccountUpdate",
      }],
    }, calls);

    await expect((await runtimeFor(node, walletPath, true)).account({ openFeeAmount: 0n, submission: selfPublicationAdapter(node, true) })).resolves.toMatchObject({
      accepted: true,
      currentAccountRevision: 1n,
      newAccountRevision: 2n,
      settled: false,
    });
    // The account and its opening come from the local chain state.
    expect(new Set(calls.map((call) => call.method))).toEqual(new Set(["pcash_status", "pcash_submitRawTransaction", "pcash_getReceipt"]));
  });
});

// --- dense private-output cursor --------------------------------------------

type BlockDto = {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
  transactionResultsRoot: string;
  stateRoot: string;
  l1OriginRoot: string;
  historyRoot: string;
  transactionResultCount: string;
  transactionResults: unknown[];
  transactionBytes: null;
  l1Origin: {
    blockNumber: string;
    blockHash: string;
    blockTimestamp: string;
    l1LogsRoot: string;
    l1LogCount: string;
  };
};

function blockDto(number: bigint, parentHash: string): BlockDto {
  const transactionResultsRoot = word(computeTransactionResultsRoot([], []));
  const stateRoot = word(0x2000n + number);
  const l1OriginRoot = word(0x3000n + number);
  const historyRoot = word(0x3100n + number);
  const hash = word(computeBlockHash({
    parentHash: BigInt(parentHash),
    number,
    timestamp: tsOfBlock(number),
    transactionResultsRoot: BigInt(transactionResultsRoot),
    stateRoot: BigInt(stateRoot),
    l1OriginRoot: BigInt(l1OriginRoot),
    historyRoot: BigInt(historyRoot),
  }));
  return {
    number: `0x${number.toString(16)}`,
    hash,
    parentHash,
    timestamp: `0x${tsOfBlock(number).toString(16)}`,
    transactionResultsRoot,
    stateRoot,
    l1OriginRoot,
    historyRoot,
    transactionResultCount: "0x0",
    transactionResults: [],
    transactionBytes: null,
    l1Origin: {
      blockNumber: `0x${number.toString(16)}`,
      blockHash: word(0x4000n + number),
      blockTimestamp: `0x${(1_700_000_000n + number).toString(16)}`,
      l1LogsRoot: word(0n),
      l1LogCount: "0x0",
    },
  };
}

describe("syncWallet dense private-output cursor", () => {
  const address = TEST_PROFILE.address;
  const walletPath = () => join(mkdtempSync(join(tmpdir(), "pcash-scan-")), "wallet.pglite");
  const chain = (): ChainSim => {
    const sim = new ChainSim(PCASH_CHAIN_ID, { l1ChainId: TEST_NETWORK.l1ChainId, inboxAddress: TEST_NETWORK.inboxAddress });
    sim.finalityLag = 1n;
    return sim;
  };

  async function runSync(
    path: string,
    sim: ChainSim,
    extra: {
      node?: PcashNodeClient;
      rescan?: boolean;
      targetNumber?: bigint;
    } = {},
  ) {
    const store = await stateStore(path, address);
    const targetBlock = sim.block(extra.targetNumber ?? sim.head.number);
    return syncWallet({
      node: extra.node ?? sim.client(),
      wallet: TEST_PROFILE,
      chainId: PCASH_CHAIN_ID,
      store,
      target: { pcashNumber: targetBlock.number, pcashHash: word(targetBlock.hash) },
      ...(extra.rescan === true ? { rescan: true } : {}),
    });
  }

  it("advances from the durable output index without replaying intervening blocks", async () => {
    const path = walletPath();
    await saveWalletState(path, emptyWalletFile(address));
    const sim = chain();
    sim.addBlock({ transactions: [{ outputs: [null, null] }] });
    const first = await runSync(path, sim);
    expect({ from: first.startedAtOutputIndex, to: first.nextOutputIndex }).toEqual({ from: 0n, to: 2n });
    expect((await loadWalletState(path, address)).syncedThrough).toEqual({
      blockNumber: "1",
      blockHash: word(sim.block(1n).hash),
    });

    sim.addBlock({ transactions: [{ outputs: [null] }] });
    const second = await runSync(path, sim);
    expect({ from: second.startedAtOutputIndex, to: second.nextOutputIndex }).toEqual({ from: 2n, to: 3n });
    expect((await loadWalletState(path, address)).syncedThrough).toEqual({
      blockNumber: "2",
      blockHash: word(sim.block(2n).hash),
    });
  });

  it("retains an action journal committed while output discovery is running", async () => {
    const path = walletPath();
    await saveWalletState(path, emptyWalletFile(address));
    const sim = chain();
    sim.addBlock({ transactions: [{ outputs: [null, null] }] });
    const node = sim.client();
    const readPage = node.getOutputs.bind(node);
    let scanStarted!: () => void;
    let releaseScan!: () => void;
    const started = new Promise<void>((resolve) => { scanStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseScan = resolve; });
    node.getOutputs = async (request) => {
      scanStarted();
      await released;
      return readPage(request);
    };

    const running = runSync(path, sim, { node });
    await started;
    const external = await stateStore(path, address);
    const concurrent = await external.load();
    if (concurrent === null) throw new Error("wallet disappeared during concurrent scan test");
    concurrent.mempoolOutbox = [{
      contentHash: word(0xabc1n),
      transactionHex: "0x00",
      kind: "noteFundedTransfer",
      state: "prepared",
      createdAtUnixMs: "1",
    }];
    await external.save(concurrent);
    releaseScan();
    await running;

    expect((await loadWalletState(path, address)).mempoolOutbox).toEqual(concurrent.mempoolOutbox);
  });

  it("rejects current-boundary anchoring before reading any chain data for an existing action journal", async () => {
    const path = walletPath();
    const data = emptyWalletFile(address);
    data.mempoolOutbox = [{
      contentHash: word(0xabc2n),
      transactionHex: "0x00",
      kind: "noteFundedTransfer",
      state: "prepared",
      createdAtUnixMs: "1",
    }];
    await saveWalletState(path, data);
    const sim = chain();

    await expect(syncWallet({
      node: sim.client(),
      wallet: TEST_PROFILE,
      chainId: PCASH_CHAIN_ID,
      store: await stateStore(path, address),
      anchorAtCurrentBoundary: true,
    })).rejects.toThrow("fresh action-free wallet");
    expect(sim.calls.map((call) => call.method)).toEqual(["status"]);
  });

  it("rescan resets the note cursor and replays encrypted outputs from index zero", async () => {
    const path = walletPath();
    await saveWalletState(path, emptyWalletFile(address));
    const sim = chain();
    sim.addBlock({ transactions: [{ outputs: [null, null] }] });
    await runSync(path, sim);
    const replay = await runSync(path, sim, { rescan: true });
    expect({ from: replay.startedAtOutputIndex, to: replay.nextOutputIndex }).toEqual({ from: 0n, to: 2n });
    expect((await loadWalletState(path, address)).syncedThrough?.blockHash).toBe(word(sim.block(1n).hash));
  });

  it("keeps the prior scan inventory when a staged full rescan fails", async () => {
    const path = walletPath();
    await saveWalletState(path, emptyWalletFile(address));
    const sim = chain();
    sim.addBlock({ transactions: [{ outputs: [null, null] }] });
    await runSync(path, sim);
    const before = await loadWalletState(path, address);
    const syncedBefore = await (await stateStore(path, address)).readChain((local) => local?.synced);
    sim.addBlock({ transactions: [{ outputs: [null] }] });
    sim.pageSize = 2;
    const failing = sim.client();
    const original = failing.getOutputs.bind(failing);
    let pages = 0;
    failing.getOutputs = async (request) => {
      pages += 1;
      if (pages > 1) throw new Error("worker scan failed");
      return original(request);
    };

    await expect(runSync(path, sim, { node: failing, rescan: true, targetNumber: 2n }))
      .rejects.toThrow("worker scan failed");
    expect(await loadWalletState(path, address)).toEqual(before);
    expect(await (await stateStore(path, address)).readChain((local) => local?.synced)).toEqual(syncedBefore);
  });

  it("does not mutate wallet state when the server rejects its branch-bound cursor", async () => {
    const path = walletPath();
    await saveWalletState(path, emptyWalletFile(address));
    const sim = chain();
    await runSync(path, sim);
    const before = await loadWalletState(path, address);
    sim.addBlock({ transactions: [{ outputs: [null] }] });
    const node = sim.client();
    node.getOutputs = async () => {
      throw new Error("output cursor mismatch");
    };
    await expect(runSync(path, sim, { node })).rejects.toThrow(/cursor mismatch/);
    expect(await loadWalletState(path, address)).toEqual(before);
  });
});


// --- runtime defaults / lifecycle (mock node) ------------------------------

describe("shared note-funded validity", () => {
  it("defaults to chain time plus the shared wallet-policy window", async () => {
    const status = await mockNode({ pcash_status: () => statusResult(100n, 80n) }).status();
    expect(noteFundedTransferValidUntil(status)).toBe(
      tsOfBlock(100n) + DEFAULT_NOTE_FUNDED_VALIDITY_WINDOW,
    );
  });

  it("uses an explicit future deadline", async () => {
    const status = await mockNode({ pcash_status: () => ({
      ...statusResult(0n, 0n),
      latestBlockTimestamp: "0x1",
    }) }).status();
    expect(noteFundedTransferValidUntil(status, { validUntilTimestamp: 0x2an })).toBe(0x2an);
  });

  it("uses wall time before the first derived block", async () => {
    const status = await mockNode({ pcash_status: () => ({
      ...statusResult(0n, 0n),
      latestBlockTimestamp: "0x0",
    }) }).status();
    expect(noteFundedTransferValidUntil(status, {}, () => 123n)).toBe(
      123n + DEFAULT_NOTE_FUNDED_VALIDITY_WINDOW,
    );
  });
});

describe("awaitReceipt lifecycle (reorg-safe)", () => {
  const contentHash = `0x${"ab".repeat(32)}`;

  it("returns the receipt once it appears at latest", async () => {
    let calls = 0;
    const node = mockNode({
      pcash_getReceipt: () => (calls++ < 1 ? [] : [receiptAt(5, true, contentHash)]),
    });
    const r = await awaitReceipt(node, contentHash, { pollIntervalMs: 0, pollMaxAttempts: 5 });
    expect(r?.outcome === "succeeded").toBe(true);
    expect(r?.inclusion.l1BlockNumber).toBe(5n);
  });

  it("accepts contract-account receipts", async () => {
    const node = mockNode({
      pcash_getReceipt: () => [{ ...receiptAt(5, true, contentHash), kind: "contractAccount", fundingMode: "sponsored" }],
    });
    const r = await awaitReceipt(node, contentHash, { pollIntervalMs: 0, pollMaxAttempts: 1 });
    expect(r?.kind).toBe("contractAccount");
    expect(r?.fundingMode).toBe("sponsored");
  });

  it("--finalized waits for inclusion <= finalized and survives an intervening reorg", async () => {
    let gr = 0;
    const receiptSeq = [[receiptAt(5, true, contentHash)], [], [receiptAt(5, true, contentHash)]];
    const node = mockNode({
      pcash_getReceipt: () => receiptSeq[Math.min(gr++, receiptSeq.length - 1)],
      pcash_status: () => statusResult(5n, gr >= 3 ? 5n : 3n),
    });
    const r = await awaitReceipt(node, contentHash, { finalized: true, pollIntervalMs: 0, pollMaxAttempts: 10 });
    expect(r?.inclusion.l1BlockNumber).toBe(5n);
  });

  it("never reports a vanished receipt (times out to null)", async () => {
    let gr = 0;
    const node = mockNode({
      pcash_getReceipt: () => (gr++ < 1 ? [receiptAt(5, true, contentHash)] : []),
      pcash_status: () => statusResult(5n, 3n),
    });
    const r = await awaitReceipt(node, contentHash, { finalized: true, pollIntervalMs: 0, pollMaxAttempts: 4 });
    expect(r).toBeNull();
  });

  it("rejects a malformed receipt instead of supplying safety-relevant defaults", async () => {
    const { outcome: _outcome, ...malformed } = receiptAt(5, false, contentHash);
    const node = mockNode({ pcash_getReceipt: () => [malformed] });
    await expect(awaitReceipt(node, contentHash, { pollIntervalMs: 0, pollMaxAttempts: 1 })).rejects.toThrow(
      /outcome must be/,
    );
  });
});

describe("extended code (pcash code) wrong-chain rejection", () => {
  it("accepts a local-chain code and rejects one minted for another chain", () => {
    const wallet = requireReceiveKeys(deriveTestWallet({ mlKem: "deterministic" }));
    const good = walletExtendedCode(wallet, PCASH_CHAIN_ID);
    expect(parseLocalChainCode(good, PCASH_CHAIN_ID).chainId).toBe(PCASH_CHAIN_ID);
    const wrong = walletExtendedCode(wallet, 9999n);
    expect(() => parseLocalChainCode(wrong, PCASH_CHAIN_ID)).toThrow(/chain id/);
  });
});

// --- acceptance gate: a skipped/rejected tx must NOT be reported as success ---

describe("awaitAcceptedReceipt (skip is a failure, not a success)", () => {
  const contentHash = `0x${"cd".repeat(32)}`;

  it("returns the receipt when the engine accepted it", async () => {
    const node = mockNode({ pcash_getReceipt: () => [receiptAt(5, true, contentHash)] });
    const r = await awaitAcceptedReceipt(node, contentHash, { pollIntervalMs: 0, pollMaxAttempts: 3 });
    expect(r.outcome === "succeeded").toBe(true);
    expect(r.inclusion.l1BlockNumber).toBe(5n);
  });

  it("throws the canonical outcome for a rejected receipt", async () => {
    const node = mockNode({ pcash_getReceipt: () => [receiptAt(5, false, contentHash)] });
    await expect(
      awaitAcceptedReceipt(node, contentHash, { pollIntervalMs: 0, pollMaxAttempts: 3 }),
    ).rejects.toThrow(/canonical outcome proofRejected/);
  });

  it("throws on timeout when no receipt ever appears", async () => {
    const node = mockNode({ pcash_getReceipt: () => [] });
    await expect(
      awaitAcceptedReceipt(node, contentHash, { pollIntervalMs: 0, pollMaxAttempts: 3 }),
    ).rejects.toThrow(/timed out/);
  });

  it("the timeout error says the tx may still be accepted and that 'pcash scan' reconciles", async () => {
    const node = mockNode({ pcash_getReceipt: () => [] });
    await expect(
      awaitAcceptedReceipt(node, contentHash, { pollIntervalMs: 0, pollMaxAttempts: 2 }),
    ).rejects.toThrow(/may still be accepted[\s\S]*pcash scan/);
  });
});

describe("exact-byte transfer retries", () => {
  function retryNode(entry: Uint8Array, calls: MockCall[]): PcashNodeClient {
    const contentHash = toHex(keccak256(entry));
    return mockNode({
      pcash_status: () => statusResult(10n, 9n),
      pcash_getReceipt: () => [],
      pcash_getMempoolTransaction: () => null,
      pcash_submitRawTransaction: (params) => {
        expect(params[0]).toBe(toHex(entry));
        return {
          contentHash,
          statementId: `0x${"22".repeat(32)}`,
          stableId: `0x${"33".repeat(32)}`,
          status: "ready",
          headCheckedBlock: "0xa",
          headCheckedBlockHash: `0x${"0a".repeat(32)}`,
        };
      },
    }, calls);
  }

  it("retries an unresolved note-funded transfer with its saved bytes and no new proof", async () => {
    const wallet = TEST_PROFILE;
    const path = join(mkdtempSync(join(tmpdir(), "pcash-note-retry-")), "wallet.pglite");
    const entry = Uint8Array.of(0, 7, 8, 9);
    const contentHash = toHex(keccak256(entry));
    const data = emptyWalletFile(wallet.address);
    addPendingNoteFundedTransfer(data, {
      contentHash,
      transactionHex: toHex(entry),
      notBeforeTimestamp: "0",
      validUntilTimestamp: (tsOfBlock(20n)).toString(),
      kind: "payment" as const,
      transferAmount: "50",
      openFeeAmount: "10",
      privateRelayFeeAmount: "0",
      privateRelayRecipient: null,
      issuanceOwnerCommitment: "0",
      issuanceRecipient: null,
      recipient: ADDR,
      recipientAddress: ADDR,
      inputs: [{
        nullifier: word(0xa1n),
        spentCommitment: word(0xb1n),
      }],
      change: {
        amount: "40",
        owner: `0x${wallet.address.toString(16).padStart(40, "0")}`,
        noteSecret: `0x${"0".repeat(63)}1`,
      },
    });
    await saveWalletState(path, data);
    const calls: MockCall[] = [];
    const node = retryNode(entry, calls);

    await expect((await runtimeFor(node, path, false)).transfer({
      to: ADDR,
      amount: 50n,
      openFeeAmount: 10n,
      issuanceOwnerCommitment: 0n,
    })).resolves.toMatchObject({ contentHash, settled: false });
    expect(calls.filter((call) => call.method === "pcash_submitRawTransaction")).toHaveLength(1);
    expect((await loadWalletState(path, wallet.address)).pendingNoteFundedTransfers?.[0]?.transactionHex).toBe(toHex(entry));
  });


});

describe("durable transfer journal reconciliation (nullifier-based)", () => {
  const pendingContentHash = `0x${"aa".repeat(32)}`;
  const conflictContentHash = `0x${"cc".repeat(32)}`;
  const INPUT_NULLIFIER = word(0xa1n);
  const SECOND_INPUT_NULLIFIER = word(0xa2n);
  /** The synced chain's record of the transaction that consumed a watched nullifier. */
  const consumedAt = (
    block: bigint,
    contentHash: string,
    nullifiers = [
      INPUT_NULLIFIER,
      word(0xb1n),
      word(0xb2n),
      word(0xb3n),
    ],
  ): NullifierConsumption => ({
    pcashNumber: block,
    pcashHash: word(block),
    timestamp: 1_800_000_000n + block * 12n,
    transactionId: word(block + 0x50n),
    contentHash,
    nullifiers,
  });
  /** Reconcile against a chain synced to `latest` whose finalized head is `finalized`. */
  const reconcileAt = async (
    data: WalletFileData,
    latest: bigint,
    finalized: bigint,
    consumed: readonly (readonly [string, NullifierConsumption])[] = [],
  ) => reconcilePendingNoteFundedTransfers(
    data,
    WalletChainState.fromRecords(localChain(latest, { consumed }).records),
    await mockNode({ pcash_status: () => statusResult(latest, finalized) }).status(),
  );
  const pendingData = (): WalletFileData => {
    const data = emptyWalletFile(0xabcn);
    data.notes = [{
      leafIndex: "1",
      outputIndex: 0,
      assetId: "0x0",
      amount: "100",
      owner: "0xabc",
      noteSecret: "0x1",
      commitment: "0x11",
      spent: false,
      pending: false,
    }];
    addPendingNoteFundedTransfer(data, {
      contentHash: pendingContentHash,
      transactionHex: "0x010203",
      // Deadline at block-20 header time: equality is still consensus-valid;
      // finality at block 21 has passed it.
      notBeforeTimestamp: "0",
      validUntilTimestamp: tsOfBlock(20n).toString(),
      kind: "payment" as const,
      transferAmount: "50",
      openFeeAmount: "10",
      privateRelayFeeAmount: "0",
      privateRelayRecipient: null,
      issuanceOwnerCommitment: "0",
      issuanceRecipient: null,
      recipient: ADDR,
      recipientAddress: ADDR,
      inputs: [{
        nullifier: INPUT_NULLIFIER,
        spentCommitment: `0x${"0".repeat(62)}11`,
      }],
      change: {
        amount: "40",
        owner: `0x${"0".repeat(37)}abc`,
        noteSecret: `0x${"0".repeat(63)}2`,
      },
    });
    addPendingNote(data, pendingContentHash, {
      outputIndex: 1,
      assetId: 0n,
      amount: 40n,
      owner: 0xabcn,
      noteSecret: 2n,
    });
    return data;
  };
  const addSecondInput = (data: WalletFileData) => {
    data.notes.push({
      leafIndex: "2",
      outputIndex: 0,
      assetId: "0x0",
      amount: "50",
      owner: "0xabc",
      noteSecret: "0x3",
      commitment: "0x22",
      spent: false,
      pending: false,
    });
    data.pendingNoteFundedTransfers![0]!.inputs.push({
      nullifier: SECOND_INPUT_NULLIFIER,
      spentCommitment: `0x${"0".repeat(62)}22`,
    });
  };

  it("applies our-tx effects atomically once its consuming block is finalized", async () => {
    const data = pendingData();
    expect(await reconcileAt(data, 7n, 5n, [[INPUT_NULLIFIER, consumedAt(5n, pendingContentHash)]])).toBe(true);
    expect(data.pendingNoteFundedTransfers).toBeUndefined();
    expect(data.notes.some((note) => note.pending)).toBe(false);
    expect(data.paymentHistory).toEqual([expect.objectContaining({
      contentHash: pendingContentHash,
      state: "succeeded",
      receipt: { transactionId: word(0x55n), pcashBlockNumber: "5", pcashBlockHash: word(5n) },
    })]);
  });

  it("keeps an accepted-but-unfinalized our-tx input reserved", async () => {
    const data = pendingData();
    expect(await reconcileAt(data, 7n, 4n, [[INPUT_NULLIFIER, consumedAt(5n, pendingContentHash)]])).toBe(false);
    expect(data.pendingNoteFundedTransfers).toHaveLength(1);
    expect(data.notes[0]!.spent).toBe(false);
  });

  it("keeps the reservation through a dropped inclusion and settles once it is finalized", async () => {
    const data = pendingData();
    // Accepted at head: confirmed for the user, still reserved here.
    expect(await reconcileAt(data, 7n, 4n, [[INPUT_NULLIFIER, consumedAt(5n, pendingContentHash)]])).toBe(false);
    expect(data.pendingNoteFundedTransfers).toHaveLength(1);

    // A reorg drops the inclusion. The input reads unspent and the node
    // re-queues the exact entry, so the bytes and reservation must survive.
    expect(await reconcileAt(data, 8n, 4n)).toBe(false);
    expect(data.pendingNoteFundedTransfers).toHaveLength(1);
    expect(data.notes[0]!.spent).toBe(false);

    // Re-included and finalized.
    expect(await reconcileAt(data, 12n, 9n, [[INPUT_NULLIFIER, consumedAt(9n, pendingContentHash)]])).toBe(true);
    expect(data.pendingNoteFundedTransfers).toBeUndefined();
    expect(data.paymentHistory?.[0]).toMatchObject({ contentHash: pendingContentHash, state: "succeeded", receipt: { transactionId: word(0x59n), pcashBlockNumber: "9" } });
  });

  it("drops the reservation (no change note) when a conflicting spend consumed the input", async () => {
    const data = pendingData();
    expect(await reconcileAt(data, 7n, 5n, [[INPUT_NULLIFIER, consumedAt(5n, conflictContentHash)]])).toBe(true);
    expect(data.pendingNoteFundedTransfers).toBeUndefined();
    // Our transfer did not land: no change note, and the payment is recorded as conflicted.
    expect(data.notes.find((n) => n.pending)).toBeUndefined();
    expect(data.paymentHistory).toEqual([expect.objectContaining({ contentHash: pendingContentHash, state: "conflicted" })]);
  });

  it("settles when one finalized conflicting transaction consumed every journaled input", async () => {
    const data = pendingData();
    addSecondInput(data);
    const conflict = consumedAt(5n, conflictContentHash, [
      INPUT_NULLIFIER,
      SECOND_INPUT_NULLIFIER,
      word(0xb2n),
      word(0xb3n),
    ]);
    expect(await reconcileAt(data, 7n, 5n, [[INPUT_NULLIFIER, conflict], [SECOND_INPUT_NULLIFIER, conflict]])).toBe(true);
    expect(data.pendingNoteFundedTransfers).toBeUndefined();
    expect(data.paymentHistory).toEqual([expect.objectContaining({ contentHash: pendingContentHash, state: "conflicted" })]);
  });

  it("keeps all inputs reserved until every latest-head conflict is finalized", async () => {
    const data = pendingData();
    addSecondInput(data);
    const firstConflict = consumedAt(5n, conflictContentHash, [
      INPUT_NULLIFIER,
      word(0xb1n),
      word(0xb2n),
      word(0xb3n),
    ]);
    const secondConflict = consumedAt(6n, `0x${"dd".repeat(32)}`, [
      SECOND_INPUT_NULLIFIER,
      word(0xc1n),
      word(0xc2n),
      word(0xc3n),
    ]);
    expect(await reconcileAt(data, 7n, 5n, [
      [INPUT_NULLIFIER, firstConflict],
      [SECOND_INPUT_NULLIFIER, secondConflict],
    ])).toBe(false);
    expect(data.pendingNoteFundedTransfers).toHaveLength(1);
    expect(data.notes.find((n) => n.commitment === "0x11")!.spent).toBe(false);
    expect(data.notes.find((n) => n.commitment === "0x22")!.spent).toBe(false);
  });

  it("settles once a later-landing tx consumes the nullifier", async () => {
    const data = pendingData();
    expect(await reconcileAt(data, 7n, 5n)).toBe(false);
    expect(data.pendingNoteFundedTransfers).toHaveLength(1);
    expect(await reconcileAt(data, 10n, 9n, [[INPUT_NULLIFIER, consumedAt(9n, pendingContentHash)]])).toBe(true);
    expect(data.pendingNoteFundedTransfers).toBeUndefined();
    expect(data.paymentHistory?.[0]?.state).toBe("succeeded");
  });

  it("keeps an unconsumed input reserved while finality is behind its deadline", async () => {
    const data = pendingData();
    expect(await reconcileAt(data, 21n, 18n)).toBe(false);
    expect(data.pendingNoteFundedTransfers).toHaveLength(1);
    expect(data.notes[0]!.spent).toBe(false);
  });

  it("keeps an unconsumed input reserved when finalized time equals its deadline", async () => {
    const data = pendingData();
    expect(await reconcileAt(data, 21n, 20n)).toBe(false);
    expect(data.pendingNoteFundedTransfers).toHaveLength(1);
    expect(data.notes[0]!.spent).toBe(false);
  });

  it("releases an unconsumed input once finalized time passes its deadline", async () => {
    const data = pendingData();
    expect(await reconcileAt(data, 21n, 21n)).toBe(true);
    expect(data.pendingNoteFundedTransfers).toBeUndefined();
    expect(data.notes[0]!.spent).toBe(false);
    expect(data.paymentHistory?.[0]?.state).toBe("expired");
  });
});

describe("resolveRecipientDelivery", () => {
  it("rejects a field hex that is not a 20-byte address", async () => {
    const receiveKeyOf = vi.fn(async () => null); // no lookup should be made
    const field = `0x${"ab".repeat(32)}`;
    await expect(resolveRecipientDelivery(field, PCASH_CHAIN_ID, receiveKeyOf)).rejects.toThrow(/neither a 20-byte address nor an extended code/);
    expect(receiveKeyOf).not.toHaveBeenCalled();
  });

  it("resolves an extended code to a code-delivery target", async () => {
    const receiveKeyOf = vi.fn(async () => null);
    const wallet = requireReceiveKeys(deriveTestWallet({ mlKem: "deterministic" }));
    const code = walletExtendedCode(wallet, PCASH_CHAIN_ID);
    const d = await resolveRecipientDelivery(code, PCASH_CHAIN_ID, receiveKeyOf);
    expect(d.recipientExtendedCode).toBe(code);
    expect(d.recipientReceiveKey).toBeUndefined();
    expect(receiveKeyOf).not.toHaveBeenCalled();
  });

  it("takes the address branch for a 20-byte address (errors when no receive key is published)", async () => {
    await expect(resolveRecipientDelivery(ADDR, PCASH_CHAIN_ID, async () => null)).rejects.toThrow(/no published ML-KEM receive key/);
  });

  it("reads the recipient's published receive key by address", async () => {
    const key = new Uint8Array(1184).fill(0xab);
    let request: string | undefined;
    const delivery = await resolveRecipientDelivery(ADDR, PCASH_CHAIN_ID, async (address) => {
      request = address;
      return key;
    });
    expect(delivery.recipientReceiveKey).toEqual(key);
    expect(request).toBe(ADDR);
  });
});

describe("awaitReceipt duplicate-inclusion selection (relay rebroadcast)", () => {
  const contentHash = `0x${"ef".repeat(32)}`;
  // Same tx included twice: ACCEPTED at block 5, SKIPPED (replay) at block 9.
  const acceptedFirst = [receiptAt(5, true, contentHash), receiptAt(9, false, contentHash)];
  const skippedFirst = [receiptAt(9, false, contentHash), receiptAt(5, true, contentHash)];

  it("prefers the accepted (earlier) receipt over a later skipped replay, in either order", async () => {
    for (const seq of [acceptedFirst, skippedFirst]) {
      const node = mockNode({ pcash_getReceipt: () => seq });
      const r = await awaitReceipt(node, contentHash, { pollIntervalMs: 0, pollMaxAttempts: 3 });
      expect(r?.outcome === "succeeded").toBe(true); // NOT the block-9 skip
      expect(r?.inclusion.l1BlockNumber).toBe(5n); // earliest accepted inclusion
    }
  });

  it("awaitAcceptedReceipt reports success (not SKIPPED) for a duplicated tx, in either order", async () => {
    for (const seq of [acceptedFirst, skippedFirst]) {
      const node = mockNode({ pcash_getReceipt: () => seq });
      const r = await awaitAcceptedReceipt(node, contentHash, { pollIntervalMs: 0, pollMaxAttempts: 3 });
      expect(r.outcome === "succeeded").toBe(true);
      expect(r.inclusion.l1BlockNumber).toBe(5n);
    }
  });

  it("--finalized waits on the ACCEPTED inclusion, not the later skipped block", async () => {
    // finalized height 6: the accepted block 5 is final; the skipped block 9 is not.
    const node = mockNode({
      pcash_getReceipt: () => skippedFirst,
      pcash_status: () => statusResult(9n, 6n),
    });
    const r = await awaitReceipt(node, contentHash, { finalized: true, pollIntervalMs: 0, pollMaxAttempts: 3 });
    expect(r?.outcome === "succeeded").toBe(true);
    expect(r?.inclusion.l1BlockNumber).toBe(5n);
  });
});

describe("note-transfer current-boundary collection", () => {
  const OUTPUT_LEAF = 0x22n;
  const localStore = (accounts: readonly AccountRow[]) => {
    const { records, anchor } = localChain(100n, { leaves: [OUTPUT_LEAF], accounts });
    return { store: memoryWalletStateStore(emptyWalletFile(TEST_PROFILE.address), records), anchor };
  };

  it("uses the local anchor for an absent account only when no notes are spent", async () => {
    const { store, anchor } = localStore([]);
    const node = mockNode({ pcash_status: () => statusResult(100n, 90n) });
    const openings = await collectCurrentNoteTransferOpenings(node, store, ADDR, []);
    expect(openings.accountPath.status).toBe("notFound");
    expect(openings.boundary).toEqual(anchor);
    await expect(collectCurrentNoteTransferOpenings(node, store, ADDR, [{ leafIndex: 0n }]))
      .rejects.toThrow("no address account");
  });

  it("opens inputs at the local anchor while the node head is ahead of it", async () => {
    const { store, anchor } = localStore([{ address: ADDR, nullifierKeyCommitment: 1n, accountRuleSetCommitment: 2n }]);
    const head = await mockNode({ pcash_status: () => statusResult(101n, 90n) }).status();
    const status = vi.fn(async () => head);
    // Any read beyond status would fail: witnesses never come from the node.
    const node = { status } as unknown as PcashNodeClient;
    const result = await collectCurrentNoteTransferOpenings(node, store, ADDR, [{ leafIndex: 0n }]);
    expect(boundaryId(result.boundary)).toBe(boundaryId(anchor));
    expect(result.status.latestBlock).toBe(101n);
    expect(status).toHaveBeenCalledTimes(1);
    expect(result.accountPath.status).toBe("present");
    expect(rootFromIndex(OUTPUT_LEAF, 0n, result.inputPaths[0]!.siblings.map(BigInt))).toBe(anchor.state.outputRoot);
  });
});

describe("wallet runtime direct transfer retry selection", () => {
  // Two unresolved copies of one payment: semantic matching cannot tell them
  // apart, so the runtime must hand the client the caller's exact selectors.
  const seedAmbiguousPendingWallet = async (): Promise<string> => {
    const path = join(mkdtempSync(join(tmpdir(), "pcash-runtime-retry-")), "wallet.pglite");
    const data = emptyWalletFile(TEST_PROFILE.address);
    const note = (commitment: string, noteSecret: string) => ({
      leafIndex: "1",
      outputIndex: 0,
      assetId: "0x0",
      amount: "100",
      owner: word(TEST_PROFILE.address),
      noteSecret,
      commitment,
      spent: false,
      pending: false,
    });
    data.notes = [note(word(0x11n), word(1n)), note(word(0x22n), word(2n))];
    const copy = {
      transactionHex: "0x010203",
      notBeforeTimestamp: "0",
      validUntilTimestamp: tsOfBlock(20n).toString(),
      kind: "payment" as const,
      transferAmount: "50",
      openFeeAmount: "10",
      privateRelayFeeAmount: "0",
      privateRelayRecipient: null,
      issuanceOwnerCommitment: "0",
      issuanceRecipient: null,
      recipient: ADDR,
      recipientAddress: ADDR,
      change: null,
    };
    addPendingNoteFundedTransfer(data, {
      ...copy,
      contentHash: `0x${"11".repeat(32)}`,
      inputs: [{ nullifier: word(0xa1n), spentCommitment: word(0x11n) }],
    });
    addPendingNoteFundedTransfer(data, {
      ...copy,
      contentHash: `0x${"22".repeat(32)}`,
      transactionHex: "0x040506",
      inputs: [{ nullifier: word(0xa2n), spentCommitment: word(0x22n) }],
    });
    await saveWalletState(path, data);
    return path;
  };

  const retryIntent = {
    to: ADDR,
    amount: 50n,
    openFeeAmount: 10n,
    issuanceOwnerCommitment: 0n,
    validUntilTimestamp: tsOfBlock(20n),
    expectedReview: {
      openFeeAmount: 10n,
      privateRelayFeeAmount: 0n,
      privateRelayRecipient: null,
      beneficiary: { kind: "publisher" as const },
      publication: "open" as const,
      inputCount: 0,
      inputTotal: 0n,
      retry: true,
    },
  };

  // Finality behind the deadline leaves both copies unresolved through reconciliation.
  const ambiguousRuntime = async () =>
    runtimeFor(mockNode({ pcash_status: () => statusResult(7n, 5n) }), await seedAmbiguousPendingWallet(), false);

  it("forwards an exact retry content hash to the direct note-funded client", async () => {
    const runtime = await ambiguousRuntime();
    // A dropped retry id falls back to semantic matching and reports ambiguity
    // instead of resolving the one transaction the caller named.
    await expect(runtime.transfer({
      ...retryIntent,
      retryContentHash: `0x${"33".repeat(32)}`,
    })).rejects.toThrow(/is no longer available/);
  });

  it.each([true, false])("keeps the durable fee without another estimate (reviewed: %s)", async (reviewed) => {
    const node = mockNode({ pcash_status: () => statusResult(7n, 5n) });
    const estimate = vi.spyOn(node, "estimateFee").mockRejectedValue(new Error("must use reviewed fee"));
    const runtime = await runtimeFor(node, await seedAmbiguousPendingWallet(), false);
    const { openFeeAmount: _fee, issuanceOwnerCommitment: _recipient, expectedReview, ...reviewedIntent } = retryIntent;
    await expect(runtime.transfer({
      ...reviewedIntent,
      ...(reviewed ? { expectedReview } : {}),
      retryContentHash: `0x${"22".repeat(32)}`,
      signal: AbortSignal.abort(),
    })).rejects.toThrow(/wallet action canceled/);
    expect(estimate).not.toHaveBeenCalled();
  });

  it("forwards a cancellation signal to the direct note-funded client", async () => {
    const runtime = await ambiguousRuntime();
    await expect(runtime.transfer({
      ...retryIntent,
      retryContentHash: `0x${"22".repeat(32)}`,
      signal: AbortSignal.abort(),
    })).rejects.toThrow(/wallet action canceled/);
  });
});
