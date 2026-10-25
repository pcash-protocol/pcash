import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { bytesToHex, keccak256, type Hex } from "viem";
import { openNodeWallet } from "@pcash/wallet";
import {
  bytes32Hex,
  noteNk,
  nullifier,
  privateKeyPcashActionSigner,
  type PcashNodeClient,
  type StatusResult,
  type WalletProfileWithReceiveKeys,
} from "@pcash/sdk/browser";
import {
  derivePcashProfileFromPrivateKey,
  walletAction,
  type Wallet,
  type WalletExecutionContext,
} from "@pcash/sdk/wallet";
import {
  preflightNoteFundedTransfer,
  noteFundedTransferValidUntil,
  resolveRecipientDelivery,
  runNoteFundedTransferFlow,
  type NoteFundedTransferFlowRuntime,
} from "../src/client/noteFundedTransfer.ts";
import { runSponsoredContractCreationFlow } from "../src/client/contractCreation.ts";
import { ChainSim, noteTo, profileAccount } from "./walletChain.ts";

const CHAIN_ID = 1346589512n;
const GENESIS_HASH = `0x${"11".repeat(32)}`;
const TEST_WALLET_DIR = mkdtempSync(join(tmpdir(), "pcash-marketplace-wallet-"));
after(() => rmSync(TEST_WALLET_DIR, { recursive: true, force: true }));
const NO_PROVE_PROVERS: NonNullable<Parameters<typeof openNodeWallet>[0]["provers"]> = {
  privateValue: {
    proveAndEncode: async () => { throw new Error("must not prove a replacement transaction"); },
  },
};

type TestWalletOptions = Omit<Parameters<typeof openNodeWallet>[0], "dataDir"> & {
  storageName: string;
};
type WalletFileData = Parameters<WalletExecutionContext["store"]["save"]>[0];

async function openTestWallet(options: TestWalletOptions): Promise<Wallet> {
  const { storageName: _storageName, ...walletOptions } = options;
  return openNodeWallet({
    ...walletOptions,
    provers: walletOptions.provers ?? NO_PROVE_PROVERS,
    dataDir: TEST_WALLET_DIR,
  } as Parameters<typeof openNodeWallet>[0]);
}

async function useTestWallet<T>(
  options: TestWalletOptions,
  operation: (wallet: Wallet) => Promise<T>,
): Promise<T> {
  const wallet = await openTestWallet(options);
  try {
    return await operation(wallet);
  } finally {
    await wallet.close();
  }
}

const RECIPIENT = `0x${"22".repeat(20)}`;

const status: StatusResult = {
  latestBlock: 10n,
  latestBlockHash: `0x${"00".repeat(31)}0a`,
  latestBlockTimestamp: 1_800_000_000n,
  finalizedBlock: 9n,
  finalizedBlockHash: `0x${"00".repeat(31)}09`,
  finalizedBlockTimestamp: 1_799_999_000n,
  latestL1BlockNumber: 10n,
  latestL1BlockHash: `0x${"33".repeat(32)}`,
  observedL1BlockNumber: 10n,
  derivation: { state: "following", sinceUnixMs: 0n },
  finalizedL1BlockNumber: 9n,
  finalizedL1BlockHash: `0x${"44".repeat(32)}`,
  stateRoot: `0x${"55".repeat(32)}`,
  l1OriginRoot: `0x${"56".repeat(32)}`,
  historyRoot: `0x${"57".repeat(32)}`,
  outputCount: 0n,
  issuedSoFar: 0n,
  supplyCap: 1_000_000_000n * 10n ** 18n,
  totalSucceeded: 0n,
  totalFailed: 0n,
  totalTransactions: 0n,
  index: { status: "ready", cursor: { blockNumber: 10n, blockHash: `0x${"00".repeat(31)}0a` } },
  proverAssets: null,
  pcashChainId: Number(CHAIN_ID),
  genesisHash: GENESIS_HASH,
  acceptedTransactionTypes: [0, 1, 2, 3],
  acceptedBatchVersions: [1],
  l1ChainId: 11155111n,
  inboxAddress: `0x${"66".repeat(20)}`,
  genesisL1Block: 1n,
  genesisL1BlockHash: `0x${"77".repeat(32)}`,
  forkCapability: {
    chainId: CHAIN_ID,
    genesisHash: GENESIS_HASH,
    headTimestamp: 1_800_000_000n,
    currentForkCount: 0n,
    currentPrefixHash: `0x${"00".repeat(32)}`,
    nextActivationTimestamp: 0n,
    nextPrefixHash: `0x${"00".repeat(32)}`,
  },
};

/** Save `data` over the wallet's document as synchronized from `node`. */
const saveStore = async (node: PcashNodeClient, profile: WalletProfileWithReceiveKeys, data: Partial<WalletFileData>) =>
  useTestWallet({ storageName: "state", node, profile }, (wallet) =>
    wallet.execute(walletAction("test:save-wallet", async ({ store }) => store.save({ ...(await store.load())!, ...data }))));
const loadStore = async (node: PcashNodeClient, profile: WalletProfileWithReceiveKeys) =>
  useTestWallet({ storageName: "state", node, profile }, (wallet) =>
    wallet.execute(walletAction("test:load-wallet", ({ store }) => store.load())));
const scanWallet = async (
  node: PcashNodeClient,
  profile: WalletProfileWithReceiveKeys,
) => useTestWallet({ storageName: "scan", node, profile }, (wallet) =>
  wallet.sync().then((result) => result.data));

const TEST_NETWORK = {
  pcashChainId: CHAIN_ID,
  l1ChainId: status.l1ChainId,
  inboxAddress: status.inboxAddress,
};

function testWallet(privateKey: Uint8Array) {
  return derivePcashProfileFromPrivateKey(privateKey, TEST_NETWORK);
}

/** A chain on which `wallet` has registered its default account. */
function registeredChain(wallet: ReturnType<typeof testWallet>): ChainSim {
  const sim = new ChainSim(CHAIN_ID, { l1ChainId: TEST_NETWORK.l1ChainId, inboxAddress: TEST_NETWORK.inboxAddress });
  sim.addBlock({ accounts: [profileAccount(sim, wallet)] });
  return sim;
}

test("a marketplace validity ceiling shortens the normal wallet-policy deadline", () => {
  const ceiling = status.latestBlockTimestamp + 301n;
  assert.equal(noteFundedTransferValidUntil(status, ceiling), ceiling);
  assert.throws(
    () => noteFundedTransferValidUntil(status, status.latestBlockTimestamp),
    /must be later/,
  );
});

test("marketplace funding executes through the same unified Wallet path as note preflight", async () => {
  const events: string[] = [];
  const node = {} as PcashNodeClient;
  const wallet = {
    preflightSend: async () => ({
      inputCount: 1,
      inputTotal: 10n,
      openFeeAmount: 1n,
      beneficiary: { kind: "publisher" },
      retry: false,
    }),
    send: async (intent: Record<string, unknown>) => {
      assert.equal(intent.to, RECIPIENT);
      assert.equal(intent.amount, 50n);
      assert.equal(intent.openFeeAmount, 1n);
      assert.equal(intent.validUntilMode, "ceiling");
      assert.equal((intent.submission as { mode: string }).mode, "mempool");
      await (intent.beforeJournal as () => Promise<void>)();
      await (intent.onPrepared as (contentHash: string, transactionHex: string) => Promise<void>)(
        `0x${"12".repeat(32)}`,
        `0x${"34".repeat(4)}`,
      );
      events.push("unified send");
      return {
        contentHash: `0x${"12".repeat(32)}`,
        queued: true,
        recipient: RECIPIENT,
        amount: 50n,
        changeAmount: 0n,
        settled: false,
      };
    },
  } as unknown as Wallet;

  assert.deepEqual(await preflightNoteFundedTransfer({
    wallet,
    amount: 50n,
    openFeeAmount: 1n,
    to: RECIPIENT,
  }), { inputCount: 1, inputTotal: 10n });

  assert.deepEqual(await runNoteFundedTransferFlow({
    wallet,
    node,
    to: RECIPIENT,
    amount: 50n,
    openFeeAmount: 1n,
    beforeSubmit: async () => { events.push("before journal"); },
    onPreparedContentHash: async () => { events.push("prepared"); },
  }), {
    contentHash: `0x${"12".repeat(32)}`,
    queued: true,
    recipient: RECIPIENT,
    amount: 50n,
    changeAmount: 0n,
    settled: false,
  });
  assert.deepEqual(events, ["before journal", "prepared", "unified send"]);
});

test("marketplace names its open compensation destination under the wallet's compensation key", async () => {
  const intents: Record<string, unknown>[] = [];
  const result = { contentHash: `0x${"12".repeat(32)}`, transactionHex: "0x00", queued: true, recipient: RECIPIENT, amount: 50n, changeAmount: 0n, settled: false };
  const wallet = {
    preflightSend: async (intent: Record<string, unknown>) => { intents.push(intent); return { inputCount: 1, inputTotal: 10n }; },
    send: async (intent: Record<string, unknown>) => { intents.push(intent); return result; },
    sponsorContractCreation: async (intent: Record<string, unknown>) => { intents.push(intent); return result; },
  } as unknown as Wallet;
  const node = {} as PcashNodeClient;
  await preflightNoteFundedTransfer({ wallet, amount: 50n, openFeeAmount: 1n, issuanceOwnerCommitment: 0n, to: RECIPIENT });
  await runNoteFundedTransferFlow({ wallet, node, to: RECIPIENT, amount: 50n, openFeeAmount: 1n, issuanceOwnerCommitment: 0n });
  await runSponsoredContractCreationFlow({ wallet, node, contract: { body: new Uint8Array(), address: 1n }, openFeeAmount: 1n, issuanceOwnerCommitment: 0n });
  assert.equal(intents.length, 3);
  for (const intent of intents) {
    assert.equal(intent.issuanceOwnerCommitment, 0n);
    assert.equal("feeOwnerCommitment" in intent, false);
  }
});

test("an Ethereum broadcast awaiting derivation is not staged as a mempool transaction", async () => {
  const result = {
    contentHash: `0x${"12".repeat(32)}`, transactionHex: "0x00", queued: true, settled: false,
    recipient: RECIPIENT, amount: 50n, changeAmount: 0n,
    submission: { l1Hash: `0x${"34".repeat(32)}` },
  };
  const wallet = {
    send: async () => result,
    sponsorContractCreation: async () => result,
  } as unknown as Wallet;
  const node = {} as PcashNodeClient;
  assert.equal((await runNoteFundedTransferFlow({ wallet, node, to: RECIPIENT, amount: 50n, openFeeAmount: 0n })).queued, false);
  assert.equal((await runSponsoredContractCreationFlow({ wallet, node, contract: { body: new Uint8Array(), address: 1n }, openFeeAmount: 0n })).queued, false);
});

test("address delivery reads the recipient's key from the local directory without naming it to the node", async () => {
  const key = Uint8Array.from({ length: 1184 }, () => 0xab);
  let requested: string | undefined;
  const lookup = async (address: string) => {
    requested = address;
    return key;
  };

  const result = await resolveRecipientDelivery(RECIPIENT, CHAIN_ID, lookup);
  assert.deepEqual(result.recipientReceiveKey, key);
  assert.equal(requested, RECIPIENT);
});

test("an unresolved note-funded transfer retries its exact journaled bytes without proving again", async () => {
  const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const wallet = testWallet(privateKey);
  const entry = Uint8Array.of(0, 7, 8, 9);
  const transactionHex = bytesToHex(entry);
  const contentHash = keccak256(transactionHex);
  const node = registeredChain(wallet).client();
  const data: Partial<WalletFileData> = {
    receiveKeys: [],
    notes: [],
    pendingNoteFundedTransfers: [{
      kind: "payment",
      contentHash,
      transactionHex,
      notBeforeTimestamp: "0",
      validUntilTimestamp: "1800001000",
      transferAmount: "50",
      openFeeAmount: "1",
      privateRelayFeeAmount: "0",
      privateRelayRecipient: null,
      issuanceOwnerCommitment: "0",
      issuanceRecipient: null,
      recipient: RECIPIENT.toUpperCase().replace("0X", "0x"),
      recipientAddress: RECIPIENT,
      inputs: [{
        nullifier: `0x${"88".repeat(32)}`,
        spentCommitment: `0x${"99".repeat(32)}`,
      }],
      change: {
        amount: "4",
        owner: `0x${wallet.address.toString(16).padStart(64, "0")}`,
        noteSecret: `0x${"aa".repeat(32)}`,
      },
    }],
  };
  await saveStore(node, wallet, data);

  const events: string[] = [];
  const runtime: NoteFundedTransferFlowRuntime = {
    submitBuiltTransaction: async (submitted) => {
      assert.deepEqual(submitted, entry);
      events.push("submit exact bytes");
      return { contentHash, receipt: null, queued: true };
    },
  };

  const result = await useTestWallet({
    storageName: "note-funded-exact-retry",
    node,
    profile: wallet,
    signer: privateKeyPcashActionSigner(privateKey),
  }, (client) => runNoteFundedTransferFlow({
    wallet: client,
    node,
    to: RECIPIENT,
    amount: 50n,
    openFeeAmount: 1n,
    issuanceOwnerCommitment: 0n,
    onPreparedContentHash: async (preparedContentHash, preparedHex: Hex) => {
      assert.equal(preparedContentHash, contentHash);
      assert.equal(preparedHex, transactionHex);
      events.push("checkpoint exact bytes");
    },
    beforeSubmit: () => { events.push("before submit"); },
  }, runtime));

  assert.deepEqual(events, ["checkpoint exact bytes", "before submit", "submit exact bytes"]);
  assert.deepEqual(result, {
    contentHash,
    queued: true,
    recipient: RECIPIENT.toUpperCase().replace("0X", "0x"),
    amount: 50n,
    changeAmount: 4n,
    settled: false,
  });
  const saved = (await loadStore(node, wallet))!;
  assert.equal(saved.pendingNoteFundedTransfers?.[0]?.transactionHex, transactionHex);
  assert.equal(saved.mempoolOutbox?.[0]?.transactionHex, transactionHex);
  assert.equal(saved.mempoolOutbox?.[0]?.state, "admitted");
});

test("an ambiguous admission keeps the journal and a restart retries the same bytes", async () => {
  const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 4);
  const wallet = testWallet(privateKey);
  const entry = Uint8Array.of(0, 14, 15, 16);
  const transactionHex = bytesToHex(entry);
  const contentHash = keccak256(transactionHex);
  const node = registeredChain(wallet).client();
  await saveStore(node, wallet, {
    receiveKeys: [],
    notes: [],
    pendingNoteFundedTransfers: [{
      kind: "payment",
      contentHash,
      transactionHex,
      notBeforeTimestamp: "0",
      validUntilTimestamp: "1800001000",
      transferAmount: "50",
      openFeeAmount: "1",
      privateRelayFeeAmount: "0",
      privateRelayRecipient: null,
      issuanceOwnerCommitment: "0",
      issuanceRecipient: null,
      recipient: RECIPIENT,
      recipientAddress: RECIPIENT,
      inputs: [{ nullifier: `0x${"ef".repeat(32)}`, spentCommitment: `0x${"f0".repeat(32)}` }],
      change: null,
    }],
  });
  let submitCalls = 0;
  const params = {
    node,
    to: RECIPIENT,
    amount: 50n,
    openFeeAmount: 1n,
    issuanceOwnerCommitment: 0n,
  };
  const lostResponseRuntime: NoteFundedTransferFlowRuntime = {
    submitBuiltTransaction: async (submitted) => {
      submitCalls += 1;
      assert.deepEqual(submitted, entry);
      throw new Error("admission response lost");
    },
  };

  await assert.rejects(
    useTestWallet({
      storageName: "note-funded-lost-response",
      node,
      profile: wallet,
      signer: privateKeyPcashActionSigner(privateKey),
    }, (client) => runNoteFundedTransferFlow({ ...params, wallet: client }, lostResponseRuntime)),
    /admission response lost/,
  );
  const unresolved = (await loadStore(node, wallet))!;
  assert.equal(unresolved.pendingNoteFundedTransfers?.[0]?.transactionHex, transactionHex);
  assert.equal(unresolved.mempoolOutbox?.[0]?.transactionHex, transactionHex);
  assert.equal(unresolved.mempoolOutbox?.[0]?.state, "prepared");

  const retryRuntime: NoteFundedTransferFlowRuntime = {
    submitBuiltTransaction: async (submitted) => {
      submitCalls += 1;
      assert.deepEqual(submitted, entry);
      return { contentHash, receipt: null, queued: true };
    },
  };
  await assert.doesNotReject(useTestWallet({
    storageName: "note-funded-retry-response",
    node,
    profile: wallet,
    signer: privateKeyPcashActionSigner(privateKey),
  }, (client) => runNoteFundedTransferFlow({ ...params, wallet: client }, retryRuntime)));
  assert.equal(submitCalls, 2);
  const retried = (await loadStore(node, wallet))!;
  assert.equal(retried.pendingNoteFundedTransfers?.[0]?.transactionHex, transactionHex);
  assert.equal(retried.mempoolOutbox?.[0]?.state, "admitted");
});

test("preflight accepts a matching unresolved exact-byte transfer without selecting replacement notes", async () => {
  const wallet = testWallet(Uint8Array.from({ length: 32 }, (_, index) => index + 2));
  const transactionHex = bytesToHex(Uint8Array.of(0, 10, 11));
  const contentHash = keccak256(transactionHex);
  const node = registeredChain(wallet).client();
  await saveStore(node, wallet, {
    receiveKeys: [],
    notes: [],
    pendingNoteFundedTransfers: [{
      kind: "payment",
      contentHash,
      transactionHex,
      notBeforeTimestamp: "0",
      validUntilTimestamp: "1800001000",
      transferAmount: "50",
      openFeeAmount: "1",
      privateRelayFeeAmount: "0",
      privateRelayRecipient: null,
      issuanceOwnerCommitment: "0",
      issuanceRecipient: null,
      recipient: RECIPIENT,
      recipientAddress: RECIPIENT,
      inputs: [{ nullifier: `0x${"ab".repeat(32)}`, spentCommitment: `0x${"bc".repeat(32)}` }],
      change: {
        amount: "4",
        owner: `0x${wallet.address.toString(16).padStart(64, "0")}`,
        noteSecret: `0x${"0".repeat(63)}1`,
      },
    }],
  });

  await assert.doesNotReject(async () => {
    const result = await useTestWallet({
      storageName: "note-funded-preflight",
      node,
      profile: wallet,
    }, (client) => preflightNoteFundedTransfer({
      wallet: client,
      amount: 50n,
      openFeeAmount: 1n,
      issuanceOwnerCommitment: 0n,
      to: RECIPIENT,
      validUntilTimestamp: 1_800_001_000n,
    }));
    assert.deepEqual(result, { inputCount: 1, inputTotal: 55n });
  });
});

test("a browser scan rejects a restored profile that disagrees with its authenticated account", async () => {
  const wallet = testWallet(Uint8Array.from({ length: 32 }, (_, index) => index + 6));
  const sim = new ChainSim(CHAIN_ID, { l1ChainId: TEST_NETWORK.l1ChainId, inboxAddress: TEST_NETWORK.inboxAddress });
  sim.addBlock({ accounts: [{ ...profileAccount(sim, wallet), nullifierKeyCommitment: wallet.nullifierKeyCommitment + 1n }] });

  await assert.rejects(
    scanWallet(sim.client(), wallet),
    /nullifier-key commitment/,
  );
});

test("a normal wallet scan releases an expired unresolved transfer and its pending change", async () => {
  const wallet = testWallet(Uint8Array.from({ length: 32 }, (_, index) => index + 3));
  const transactionHex = bytesToHex(Uint8Array.of(0, 12, 13));
  const contentHash = keccak256(transactionHex);
  const sim = registeredChain(wallet);
  const node = sim.client();
  await saveStore(node, wallet, {
    receiveKeys: [],
    notes: [{
      leafIndex: null,
      outputIndex: 1,
      assetId: "0x0",
      amount: "4",
      owner: `0x${wallet.address.toString(16)}`,
      noteSecret: "0x1",
      commitment: null,
      spent: false,
      pending: true,
      pendingContentHash: contentHash,
    }],
    pendingNoteFundedTransfers: [{
      kind: "payment",
      contentHash,
      transactionHex,
      notBeforeTimestamp: "0",
      validUntilTimestamp: "1800001000",
      transferAmount: "50",
      openFeeAmount: "1",
      privateRelayFeeAmount: "0",
      privateRelayRecipient: null,
      issuanceOwnerCommitment: "0",
      issuanceRecipient: null,
      recipient: RECIPIENT,
      recipientAddress: RECIPIENT,
      inputs: [{ nullifier: `0x${"cd".repeat(32)}`, spentCommitment: `0x${"de".repeat(32)}` }],
      change: {
        amount: "4",
        owner: `0x${wallet.address.toString(16).padStart(64, "0")}`,
        noteSecret: `0x${"0".repeat(63)}1`,
      },
    }],
    mempoolOutbox: [{
      contentHash,
      transactionHex,
      kind: "noteFundedTransfer",
      state: "admitted",
      createdAtUnixMs: "1",
    }],
  });
  // Finalized time passes the transfer's deadline without its input being consumed.
  sim.addBlock({ timestamp: 1_800_002_000n });

  const scanned = await scanWallet(node, wallet);
  assert.equal(scanned.pendingNoteFundedTransfers, undefined);
  assert.equal(scanned.mempoolOutbox, undefined);
  assert.equal(scanned.notes.some((note) => note.pending), false);
});

test("a normal wallet scan retires pending change after a distinct inclusion succeeds", async () => {
  const wallet = testWallet(Uint8Array.from({ length: 32 }, (_, index) => index + 5));
  const transactionHex = bytesToHex(Uint8Array.of(0, 17, 18));
  const contentHash = keccak256(transactionHex);
  const sim = registeredChain(wallet);
  sim.addBlock({ transactions: [{ outputs: [noteTo(wallet, 51n, 2n), null, null, null, null] }] });
  const node = sim.client();
  const input = (await scanWallet(node, wallet)).notes[0]!;
  const inputCommitment = input.commitment!;
  const inputNullifier = bytes32Hex(nullifier(BigInt(inputCommitment), noteNk(wallet.nkRoot), BigInt(input.noteSecret)));
  await saveStore(node, wallet, {
    receiveKeys: [],
    notes: [input, {
      leafIndex: null,
      outputIndex: 1,
      assetId: "0x0",
      amount: "4",
      owner: `0x${wallet.address.toString(16)}`,
      noteSecret: "0x3",
      commitment: null,
      spent: false,
      pending: true,
      pendingContentHash: contentHash,
    }],
    pendingNoteFundedTransfers: [{
      kind: "payment",
      contentHash,
      transactionHex,
      notBeforeTimestamp: "0",
      validUntilTimestamp: "1800001000",
      transferAmount: "46",
      openFeeAmount: "1",
      privateRelayFeeAmount: "0",
      privateRelayRecipient: null,
      issuanceOwnerCommitment: "0",
      issuanceRecipient: null,
      recipient: RECIPIENT,
      recipientAddress: RECIPIENT,
      inputs: [{ nullifier: inputNullifier, spentCommitment: inputCommitment }],
      change: {
        amount: "4",
        owner: `0x${wallet.address.toString(16).padStart(64, "0")}`,
        noteSecret: `0x${"0".repeat(63)}3`,
      },
    }],
    mempoolOutbox: [{
      contentHash,
      transactionHex,
      kind: "noteFundedTransfer",
      state: "admitted",
      createdAtUnixMs: "1",
    }],
  });
  // The journaled content lands under a transaction id of its own.
  sim.addBlock({ transactions: [{
    contentHash: contentHash,
    nullifiers: [inputNullifier, `0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`, `0x${"03".repeat(32)}`],
    outputs: [null, null, null, null, null],
  }] });

  const scanned = await scanWallet(node, wallet);
  assert.equal(scanned.pendingNoteFundedTransfers, undefined);
  assert.equal(scanned.mempoolOutbox, undefined);
  assert.equal(scanned.notes.find((note) => note.commitment === inputCommitment)?.spent, true);
  assert.equal(scanned.notes.some((note) => note.pending && note.noteSecret === "0x3"), false);
});

test("zero-fee funding preserves the wallet's configured direct L1 transport", async () => {
  let submitted = false;
  const client = {
    send: async (params: { submission?: unknown; openFeeAmount?: bigint }) => {
      assert.equal(params.submission, undefined);
      assert.equal(params.openFeeAmount, 0n);
      submitted = true;
      return { contentHash: "saved", queued: true, recipient: RECIPIENT, amount: 1n, changeAmount: 0n, settled: false };
    },
  } as unknown as Wallet;
  await runNoteFundedTransferFlow({ wallet: client, node: {} as PcashNodeClient, to: RECIPIENT, amount: 1n, openFeeAmount: 0n });
  assert.equal(submitted, true);
});
