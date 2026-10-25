import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { transactionIdentity as submissionIdentity } from "@pcash/sdk/protocol";
import { createWalletRuntime } from "../../src/wallet/actions/walletRuntime.ts";
import type { DurableSubmissionAdapter } from "../../src/wallet/actions/durableSubmission.ts";
import { awaitingAcceptance, createMempoolSubmissionAdapter } from "../../src/wallet/submission.ts";
import { testStatus } from "./statusFixture.ts";
import { describe, expect, it, vi } from "vitest";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import { WIRE_PROOF_BYTES } from "@pcash/sdk/protocol";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import { addressHex, keccak256, toHex } from "@pcash/sdk/utils";
import { decryptEnvelope, generateMlKemKeyPair, receiveKeyHash as protocolReceiveKeyHash } from "@pcash/sdk/protocol";
import { fieldToHex } from "@pcash/sdk/crypto";
import { derivePcashProfileFromPrivateKey } from "../../src/wallet/externalIdentity.ts";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import type { WalletFileData } from "../../src/wallet/noteStore.ts";
import { WalletChainState } from "../../src/wallet/chainState.ts";
import { reconcilePendingUserAccountUpdates } from "../../src/wallet/actions/clientReconciliation.ts";
import {
  runUserAccountUpdateClient,
  type UserAccountUpdateClientParams,
} from "../../src/wallet/actions/userAccountUpdateClient.ts";
import type { ReferenceWalletRuleInspection } from "@pcash/sdk/rules";
import { buildAccountRuleSet, fullOutputCommitment } from "@pcash/sdk/protocol";
import { authorizeUserAccountUpdate, prepareUserAccountUpdate } from "@pcash/sdk/builders";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import { anchoredChain, syncStoreTo } from "./chainFixture.ts";
import { retainReceiveKeyPair } from "../../src/wallet/receiveKeyring.ts";

const CHAIN_ID = 1_346_589_512n;
const GENESIS_HASH = `0x${"11".repeat(32)}`;
const PRIVATE_KEY = Uint8Array.from(
  Buffer.from("10112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex"),
);
const NETWORK = {
  pcashChainId: CHAIN_ID,
  l1ChainId: 11_155_111n,
  inboxAddress: `0x${"66".repeat(20)}`,
};
const wallet = derivePcashProfileFromPrivateKey(PRIVATE_KEY, NETWORK);
const signer = privateKeyPcashActionSigner(PRIVATE_KEY);
const rules = defaultUserAccountRuleSet({
  wallet,
  network: NETWORK,
  secrets: wallet.defaultUserRuleSecrets,
});

const hex32 = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;
const address = `0x${wallet.address.toString(16).padStart(40, "0")}`;
const receiveKeyHash = fieldToHex(protocolReceiveKeyHash(wallet.mlKemPublicKey));
const walletKeyPair = { publicKey: wallet.mlKemPublicKey, secretKey: wallet.mlKemSecretKey };

function ruleInspection(): ReferenceWalletRuleInspection {
  const entry = (rule: typeof rules.rule) => ({
    entryIndex: rule.entryIndex,
    applicationVkHash: rule.applicationVkHash,
    configurationCommitment: rule.configurationCommitment,
    commitmentBlinder: rule.commitmentBlinder,
  });
  return {
    entries: rules.entries.map(entry),
    recovery: { kind: "ethereum-signature-derived" },
  };
}

const feeNoteSecret = 0x2244n;
const feeNoteAmount = 1_000n;
const feeNoteCommitment = fullOutputCommitment(
  { owner: wallet.address, noteSecret: feeNoteSecret, assetId: 0n, amount: feeNoteAmount },
  0,
);
const FEE_AMOUNT = 25n;

type ReceiveMaterial = "absent" | "available" | "unavailable";

/** The wallet's local chain state, synced to block 10 with its account and fee note. */
function chain(options: { material?: ReceiveMaterial; accountRevision?: number; timestamp?: bigint; receiveKey?: Uint8Array } = {}) {
  const material = options.material ?? "available";
  return anchoredChain({
    outputs: [{ leaf: feeNoteCommitment, mark: true }],
    accounts: [{
      address,
      nullifierKeyCommitment: wallet.nullifierKeyCommitment,
      accountRuleSetCommitment: rules.accountRuleSetCommitment,
      accountRevision: options.accountRevision ?? 1,
      receiveKey: material === "absent" ? null : options.receiveKey ?? wallet.mlKemPublicKey,
    }],
    blockNumber: 10n,
    timestamp: options.timestamp ?? 1_800_000_000n,
    withheldKeys: material === "unavailable" ? [address] : [],
  });
}
const syncedChain = (options: Parameters<typeof chain>[0]) => WalletChainState.fromRecords(chain(options).records);
const boundary = chain().boundary;

const status: StatusResult = testStatus({
  latestBlock: 10n,
  latestBlockHash: hex32(boundary.blockHash),
  latestBlockTimestamp: 1_800_000_000n,
  finalizedBlock: 9n,
  finalizedBlockHash: `0x${"44".repeat(32)}`,
  finalizedBlockTimestamp: 1_799_999_000n,
  latestL1BlockNumber: 10n,
  latestL1BlockHash: hex32(boundary.blockHash),
  finalizedL1BlockNumber: 9n,
  finalizedL1BlockHash: `0x${"44".repeat(32)}`,
  stateRoot: hex32(boundary.header.stateRoot),
  l1OriginRoot: hex32(boundary.header.l1OriginRoot),
  historyRoot: hex32(boundary.header.historyRoot),
  pcashChainId: Number(CHAIN_ID),
  genesisHash: GENESIS_HASH,
  acceptedTransactionTypes: [3],
  l1ChainId: NETWORK.l1ChainId,
  inboxAddress: NETWORK.inboxAddress,
  genesisL1Block: 1n,
  genesisL1BlockHash: `0x${"77".repeat(32)}`,
});

function walletData(): WalletFileData {
  return {
    address: addressHex(wallet.address),
    network: { chainId: CHAIN_ID.toString(), genesisHash: GENESIS_HASH },
    receiveKeys: [],
    notes: [],
  };
}

function walletDataWithFeeNote(): WalletFileData {
  return {
    ...walletData(),
    notes: [{
      leafIndex: "0",
      outputIndex: 0,
      assetId: "0x0",
      amount: feeNoteAmount.toString(),
      owner: addressHex(wallet.address),
      noteSecret: hex32(feeNoteSecret),
      commitment: hex32(feeNoteCommitment),
      spent: false,
      pending: false,
    }],
  };
}

function fixture(material: ReceiveMaterial = "available", accountRevision = 1, receiveKey = wallet.mlKemPublicKey) {
  let retained: Record<string, unknown> | null = null;
  let receipts: Record<string, unknown>[] = [];
  let proveCalls = 0;
  let submitCalls = 0;
  const records = chain({ material, accountRevision, receiveKey }).records;
  const builds: Parameters<UserAccountUpdateClientParams["prover"]["proveAndEncode"]>[0][] = [];
  const node = {
    status: async () => status,
    getReceipt: async () => receipts,
    getMempoolTransaction: async () => retained,
  } as unknown as PcashNodeClient;
  const submission = {
    mode: "mempool" as const,
    preflight: async () => "prepared",
    submit: async ({ transactionBytes: entry }: { transactionBytes: Uint8Array }) => {
      const { contentHash } = submissionIdentity(entry);

      submitCalls += 1;
      retained = {
        contentHash,
        kind: "userAccountUpdate",
        rawTransaction: toHex(entry),
        status: "ready",
      };
      return { accepted: false, queued: true, output: "queued" };
    },
  };
  const prover = {
    proveAndEncode: async (build: Parameters<UserAccountUpdateClientParams["prover"]["proveAndEncode"]>[0]) => {
      proveCalls += 1;
      builds.push(build);
      return build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES));
    },
  };
  return {
    node,
    store: (data: WalletFileData) => memoryWalletStateStore(data, records),
    submission,
    /** Zero-fee account operations carry no publisher payment, so only self-publication posts them. */
    selfPublication: { ...submission, mode: "l1" as const },
    prover,
    builds,
    proveCalls: () => proveCalls,
    submitCalls: () => submitCalls,
    setReceipts: (value: Record<string, unknown>[]) => { receipts = value; },
  };
}

describe("durable user account update client", () => {
  it.each(["keep", "clear"] as const)("encrypts %s fee change to the registered key after rotation", async (operation) => {
    const registered = generateMlKemKeyPair(new Uint8Array(64).fill(0x83));
    const f = fixture("available", 2, registered.publicKey);
    const data = walletDataWithFeeNote();
    retainReceiveKeyPair(data, registered);
    await runUserAccountUpdateClient({
      node: f.node, store: f.store(data), address: wallet.address, wallet, signer,
      chainId: CHAIN_ID, openFeeAmount: FEE_AMOUNT, receiveKey: { operation },
      prover: f.prover, submission: f.submission,
    });
    const change = f.builds[0]!.payment.outputData[0]!;
    expect(decryptEnvelope(registered.secretKey, change)).not.toBeNull();
    expect(decryptEnvelope(wallet.mlKemSecretKey, change)).toBeNull();
  });

  it.each(["available", "absent"] as const)("encrypts REPLACE fee change to the new key when current material is %s", async (material) => {
    const replacement = generateMlKemKeyPair(new Uint8Array(64).fill(0x84));
    const f = fixture(material);
    const store = f.store(walletDataWithFeeNote());
    await runUserAccountUpdateClient({
      node: f.node, store, address: wallet.address, wallet, signer,
      chainId: CHAIN_ID, openFeeAmount: FEE_AMOUNT,
      receiveKey: { operation: "replace", keyPair: replacement },
      prover: f.prover, submission: f.submission,
    });
    const change = f.builds[0]!.payment.outputData[0]!;
    expect(decryptEnvelope(replacement.secretKey, change)).not.toBeNull();
    expect(decryptEnvelope(wallet.mlKemSecretKey, change)).toBeNull();
    expect(store.snapshot()!.receiveKeys.some((key) => key.mlKemPublicKey === toHex(replacement.publicKey))).toBe(true);
  });

  it.each(["absent", "unowned"] as const)("rejects encrypted fee change before proving when the registered key is %s", async (material) => {
    const registered = generateMlKemKeyPair(new Uint8Array(64).fill(0x85));
    const f = fixture(material === "absent" ? "absent" : "available", 1, registered.publicKey);
    await expect(runUserAccountUpdateClient({
      node: f.node, store: f.store(walletDataWithFeeNote()), address: wallet.address, wallet, signer,
      chainId: CHAIN_ID, openFeeAmount: FEE_AMOUNT, receiveKey: { operation: "keep" },
      prover: f.prover, submission: f.submission,
    })).rejects.toThrow(/receive key/);
    expect(f.proveCalls()).toBe(0);
    expect(f.submitCalls()).toBe(0);
  });

  it.each(["absent", "unowned"] as const)("allows zero-change updates when the registered key is %s", async (material) => {
    const registered = generateMlKemKeyPair(new Uint8Array(64).fill(0x86));
    const f = fixture(material === "absent" ? "absent" : "available", 1, registered.publicKey);
    await runUserAccountUpdateClient({
      node: f.node, store: f.store(walletData()), address: wallet.address, wallet, signer,
      chainId: CHAIN_ID, openFeeAmount: 0n,
      receiveKey: { operation: material === "absent" ? "keep" : "clear" },
      prover: f.prover, submission: f.selfPublication,
    });
    expect(f.proveCalls()).toBe(1);
  });

  it("journals exact bytes and reuses them on retry", async () => {
    const f = fixture();
    const store = f.store(walletDataWithFeeNote());
    const params = {
      node: f.node,
      store,
      address: wallet.address,
      wallet,
      signer,
      chainId: CHAIN_ID,
      openFeeAmount: FEE_AMOUNT,
      receiveKey: { operation: "keep" as const },
      prover: f.prover,
      submission: f.submission,
    };
    const first = await runUserAccountUpdateClient(params);
    const pending = store.snapshot()!.pendingUserAccountUpdates![0]!;
    expect(first.queued).toBe(true);
    expect(pending.transactionHex).toBe(first.transactionHex);
    expect(pending.contentHash).toBe(first.contentHash);
    expect(pending.receiveKeyOperation).toBe("keep");

    await expect(runUserAccountUpdateClient({
      ...params,
      receiveKey: { operation: "replace", keyPair: walletKeyPair },
    })).rejects.toThrow(/has an unresolved different update/);

    const second = await runUserAccountUpdateClient(params);
    expect(second.transactionHex).toBe(first.transactionHex);
    expect(second.retried).toBe(true);
    expect(second.recovered).toBe(true);
    expect(f.proveCalls()).toBe(1);
    expect(f.submitCalls()).toBe(1);
  });

  it("rejects noncanonical delivery operations before authorization or proving", async () => {
    const absent = fixture("absent");
    await expect(runUserAccountUpdateClient({
      node: absent.node,
      store: absent.store(walletData()),
      address: wallet.address,
      wallet,
      signer,
      chainId: CHAIN_ID,
      openFeeAmount: 0n,
      receiveKey: { operation: "clear" },
      prover: absent.prover,
      submission: absent.selfPublication,
    })).rejects.toThrow(/CLEAR is noncanonical.*use KEEP/);
    expect(absent.proveCalls()).toBe(0);
    expect(absent.submitCalls()).toBe(0);

    const present = fixture();
    await expect(runUserAccountUpdateClient({
      node: present.node,
      store: present.store(walletData()),
      address: wallet.address,
      wallet,
      signer,
      chainId: CHAIN_ID,
      openFeeAmount: 0n,
      receiveKey: { operation: "replace", keyPair: walletKeyPair },
      prover: present.prover,
      submission: present.selfPublication,
    })).rejects.toThrow(/REPLACE is noncanonical.*use KEEP/);
    expect(present.proveCalls()).toBe(0);
    expect(present.submitCalls()).toBe(0);
  });

  it("persists an owned replacement keypair before proving and retains it across a crash retry", async () => {
    const f = fixture();
    const store = f.store(walletData());
    const replacement = generateMlKemKeyPair(new Uint8Array(64).fill(0x72));
    const params = {
      node: f.node,
      store,
      address: wallet.address,
      wallet,
      signer,
      chainId: CHAIN_ID,
      openFeeAmount: 0n,
      receiveKey: { operation: "replace" as const, keyPair: replacement },
      submission: f.selfPublication,
    };
    await expect(runUserAccountUpdateClient({
      ...params,
      prover: { proveAndEncode: async () => { throw new Error("simulated prover crash"); } },
    })).rejects.toThrow("simulated prover crash");
    const afterCrash = store.snapshot()!;
    expect(afterCrash.receiveKeys).toHaveLength(2);
    expect(afterCrash.receiveKeys.map((key) => key.receiveKeyHash)).toContain(
      fieldToHex(protocolReceiveKeyHash(replacement.publicKey)),
    );
    expect(afterCrash.pendingUserAccountUpdates).toBeUndefined();

    await expect(runUserAccountUpdateClient({ ...params, prover: f.prover })).resolves.toMatchObject({
      queued: true,
    });
    expect(store.snapshot()!.receiveKeys).toHaveLength(2);
  });

  it("resumes a journaled replacement after restart by resolving its durable key hash", async () => {
    const f = fixture();
    const replacement = generateMlKemKeyPair(new Uint8Array(64).fill(0x74));
    const firstStore = f.store(walletData());
    const first = await runUserAccountUpdateClient({
      node: f.node,
      store: firstStore,
      address: wallet.address,
      wallet,
      signer,
      chainId: CHAIN_ID,
      openFeeAmount: 0n,
      receiveKey: { operation: "replace", keyPair: replacement },
      prover: f.prover,
      submission: f.selfPublication,
    });
    expect(first.queued).toBe(true);
    expect(firstStore.snapshot()!.pendingUserAccountUpdates).toHaveLength(1);

    const restartedStore = memoryWalletStateStore(firstStore.snapshot()!, firstStore.chainSnapshot());
    const resumed = await runUserAccountUpdateClient({
      node: f.node,
      store: restartedStore,
      address: wallet.address,
      wallet,
      signer,
      chainId: CHAIN_ID,
      openFeeAmount: 0n,
      receiveKey: { operation: "replace" },
      prover: {
        proveAndEncode: async () => { throw new Error("a durable retry must not re-prove"); },
      },
      submission: f.selfPublication,
    });

    expect(resumed.contentHash).toBe(first.contentHash);
    expect(resumed.retried).toBe(true);
    // A self-published retry re-posts the same exact bytes.
    expect(f.submitCalls()).toBe(2);
    expect(resumed.newReceiveKeyHash).toBe(fieldToHex(protocolReceiveKeyHash(replacement.publicKey)));
    expect(restartedStore.snapshot()!.receiveKeys).toHaveLength(2);
  });

  it("relays an account update with the node's suggested fee by default and retains it on retry", async () => {
    const f = fixture();
    const estimateFee = vi.fn(async () => ({
      head: { blockNumber: 10n, blockHash: status.latestBlockHash },
      windowBlocks: 1n, byteSize: 30_000n,
      tiers: { low: FEE_AMOUNT, standard: FEE_AMOUNT, fast: FEE_AMOUNT }, basis: {
        includedSamples: 0n, included: null, pendingSamples: 0n, pending: null,
      },
    }));
    f.node.estimateFee = estimateFee;
    const runtime = (store: ReturnType<typeof memoryWalletStateStore>) => createWalletRuntime({
      node: f.node, store, wallet, signer, chainId: CHAIN_ID,
      provers: { userAccountUpdate: f.prover }, submission: f.submission,
    });
    const store = f.store(walletDataWithFeeNote());
    const first = await runtime(store).account();
    expect(store.snapshot()!.pendingUserAccountUpdates![0]!.openFeeAmount).toBe(FEE_AMOUNT.toString());
    expect(first).toMatchObject({ publicationDetails: { issuanceRoute: "none", beneficiary: { kind: "none" }, openFeeAmount: FEE_AMOUNT } });
    expect(estimateFee).toHaveBeenCalledTimes(1);
    expect(estimateFee).toHaveBeenCalledWith({ byteSize: BigInt((store.snapshot()!.pendingUserAccountUpdates![0]!.transactionHex.length - 2) / 2) });
    estimateFee.mockRejectedValue(new Error("must not re-estimate"));
    const resumed = await runtime(memoryWalletStateStore(store.snapshot()!, store.chainSnapshot())).account();
    expect(resumed.contentHash).toBe(first.contentHash);
    expect(f.proveCalls()).toBe(1);
    expect(estimateFee).toHaveBeenCalledTimes(1);
  });

  it("refuses `account --fee 0` on the mempool path and publishes it on L1 only with `--submit l1`", async () => {
    const f = fixture();
    f.node.estimateFee = async () => ({ tiers: { low: 1n, standard: FEE_AMOUNT, fast: 50n } }) as never;
    const relay = vi.fn(async (entry: Uint8Array) => {
      const contentHash = toHex(keccak256(entry));
      f.setReceipts([{
        inclusion: { l1BlockNumber: "0xa", l1BlockHash: `0x${"88".repeat(32)}`, l1TransactionIndex: "0x0", l1TransactionHash: `0x${"7c".repeat(32)}`, batchItemIndex: "0x0" },
        contentHash, transactionId: `0x${"55".repeat(32)}`, outcome: "succeeded", failureDetail: null, l1Sender: "0x0000000000000000000000000000000000000000",
        issuanceOwnerCommitment: null, settledOpenFeeAmount: "0x0", settledIssuanceAmount: "0x0", kind: "userAccountUpdate", outputLeafStart: null,
      }]);
      return { txHash: `0x${"7c".repeat(32)}`, observed: true, receipt: { status: 1, blockNumber: 10n, blockHash: `0x${"88".repeat(32)}`, transactionIndex: 0, gasUsed: 1n } };
    });
    const wait = { node: f.node, pollIntervalMs: 0, pollMaxAttempts: 1 };
    const service = (path: "mempool" | "l1"): DurableSubmissionAdapter => path === "mempool"
      ? awaitingAcceptance(createMempoolSubmissionAdapter(f.node), wait)
      : awaitingAcceptance({
        mode: "l1",
        preflight: async () => undefined,
        submit: async ({ transactionBytes }) => {
          const posted = await relay(transactionBytes);
          return { accepted: false, queued: false, l1Hash: posted.txHash, output: { path: "l1", relay: posted } };
        },
      }, wait);
    const store = f.store(walletData());
    const runtime = (submission: ReturnType<typeof service>) => createWalletRuntime({
      node: f.node, store, wallet, signer, chainId: CHAIN_ID, provers: { userAccountUpdate: f.prover },
      submission, settlePollIntervalMs: 0, settlePollMaxAttempts: 1,
    });

    await expect(runtime(service("mempool")).account({ openFeeAmount: 0n }))
      .rejects.toThrow(/zero fee pays no publisher; pass a positive fee or publish it yourself/);
    expect(relay).not.toHaveBeenCalled();
    expect(f.proveCalls()).toBe(0);
    expect(store.snapshot()).toEqual(walletData());

    const published = await runtime(service("l1")).account({ openFeeAmount: 0n });
    expect(relay).toHaveBeenCalledTimes(1);
    expect(published).toMatchObject({ accepted: true, publicationDetails: { issuanceRoute: "none", beneficiary: { kind: "none" }, openFeeAmount: 0n } });
  });

  it("self-publishes an account update with no PCASH fee or issuance when the caller passes an L1 adapter", async () => {
    const f = fixture();
    f.node.estimateFee = async () => { throw new Error("self-publication needs no fee estimate"); };
    const store = f.store(walletDataWithFeeNote());
    const result = await createWalletRuntime({
      node: f.node, store, wallet, signer, chainId: CHAIN_ID,
      provers: { userAccountUpdate: f.prover }, submission: { ...f.submission, mode: "l1" as const },
    }).account();
    const pending = store.snapshot()!.pendingUserAccountUpdates![0]!;
    expect(pending).toMatchObject({ openFeeAmount: "0", issuanceRecipient: null, issuanceOwnerCommitment: "0" });
    expect(result).toMatchObject({ publicationDetails: { issuanceRoute: "none", beneficiary: { kind: "none" }, openFeeAmount: 0n } });
  });

  it("resumes a fee-paying update from its journal instead of selecting notes again", async () => {
    for (const noteSelector of [undefined, hex32(feeNoteCommitment)]) {
      const f = fixture();
      const firstStore = f.store(walletDataWithFeeNote());
      const params = {
        node: f.node,
        address: wallet.address,
        wallet,
        signer,
        chainId: CHAIN_ID,
        receiveKey: { operation: "keep" as const },
        openFeeAmount: FEE_AMOUNT,
        submission: f.submission,
        ...(noteSelector === undefined ? {} : { noteSelector }),
      };
      const first = await runUserAccountUpdateClient({ ...params, store: firstStore, prover: f.prover });
      expect(first.queued).toBe(true);
      expect(f.proveCalls()).toBe(1);

      // The journaled update reserves the wallet's only note and holds its
      // change pending, so nothing is spendable. Retrying the exact saved
      // transaction must not need more funds, another signature, or a re-proof.
      const saved = firstStore.snapshot()!;
      expect(saved.pendingUserAccountUpdates).toHaveLength(1);
      expect(saved.notes.filter((note) => !note.spent && !note.pending)).toHaveLength(1);
      const restartedStore = memoryWalletStateStore(saved, firstStore.chainSnapshot());
      const resumed = await runUserAccountUpdateClient({
        ...params,
        store: restartedStore,
        signer: {
          address: signer.address,
          signTypedData: async () => { throw new Error("a durable retry must not sign again"); },
        },
        prover: { proveAndEncode: async () => { throw new Error("a durable retry must not re-prove"); } },
      });

      expect(resumed.contentHash).toBe(first.contentHash);
      expect(resumed.transactionHex).toBe(first.transactionHex);
      expect(resumed.retried).toBe(true);
      expect(f.proveCalls()).toBe(1);
    }
  });

  it("refuses to resume a journaled update under different fee terms", async () => {
    const f = fixture();
    const store = f.store(walletDataWithFeeNote());
    const params = {
      node: f.node,
      store,
      address: wallet.address,
      wallet,
      signer,
      chainId: CHAIN_ID,
      receiveKey: { operation: "keep" as const },
      openFeeAmount: FEE_AMOUNT,
      prover: f.prover,
      submission: f.submission,
    };
    await runUserAccountUpdateClient(params);
    await expect(runUserAccountUpdateClient({ ...params, openFeeAmount: FEE_AMOUNT + 1n }))
      .rejects.toThrow("unresolved different update");
    await expect(runUserAccountUpdateClient({ ...params, issuanceOwnerCommitment: 0x1234n }))
      .rejects.toThrow("unresolved different update");
    expect(f.proveCalls()).toBe(1);
  });

  it("rejects a replacement public key without owned secret material", async () => {
    const f = fixture();
    const replacement = generateMlKemKeyPair(new Uint8Array(64).fill(0x73));
    await expect(runUserAccountUpdateClient({
      node: f.node,
      store: f.store(walletData()),
      address: wallet.address,
      wallet,
      signer,
      chainId: CHAIN_ID,
      openFeeAmount: 0n,
      receiveKey: {
        operation: "replace",
        keyPair: { publicKey: replacement.publicKey } as typeof replacement,
      },
      prover: f.prover,
      submission: f.selfPublication,
    })).rejects.toThrow("secret key must be 2400 bytes");
    expect(f.proveCalls()).toBe(0);
  });

  it("requires a complete keypair when REPLACE is not a durable retry", async () => {
    const f = fixture();
    await expect(runUserAccountUpdateClient({
      node: f.node,
      store: f.store(walletData()),
      address: wallet.address,
      wallet,
      signer,
      chainId: CHAIN_ID,
      openFeeAmount: 0n,
      receiveKey: { operation: "replace" },
      prover: f.prover,
      submission: f.selfPublication,
    })).rejects.toThrow("new REPLACE requires a complete owned ML-KEM keypair");
    expect(f.proveCalls()).toBe(0);
  });

  it("supports a custom administration adapter with no profile or signer", async () => {
    const f = fixture();
    const result = await runUserAccountUpdateClient({
      node: f.node,
      store: f.store(walletData()),
      address: wallet.address,
      chainId: CHAIN_ID,
      openFeeAmount: 0n,
      receiveKey: { operation: "clear" },
      nkRoot: wallet.nkRoot,
      ruleSetCommitment: rules.accountRuleSetCommitment,
      ruleInspection: ruleInspection(),
      authorizeBuild: async (base) => {
        const unsigned = prepareUserAccountUpdate({
          ...base,
          rule: rules.accountAdminRule,
          readableEcdsa: { signerAddress: wallet.address },
        });
        return authorizeUserAccountUpdate(unsigned, signer);
      },
      prover: f.prover,
      submission: f.selfPublication,
    });
    expect(result.queued).toBe(true);
    expect(result.address).toBe(address);
  });

  it("keeps authenticated receive state when its raw material is unavailable", async () => {
    const f = fixture("unavailable");
    const store = f.store(walletData());
    const kept = await runUserAccountUpdateClient({
      node: f.node,
      store,
      address: wallet.address,
      chainId: CHAIN_ID,
      openFeeAmount: 0n,
      receiveKey: { operation: "keep" },
      nkRoot: wallet.nkRoot,
      ruleSetCommitment: rules.accountRuleSetCommitment,
      ruleInspection: ruleInspection(),
      authorizeBuild: async (base) => authorizeUserAccountUpdate(
        prepareUserAccountUpdate({
          ...base,
          rule: rules.accountAdminRule,
          readableEcdsa: { signerAddress: wallet.address },
        }),
        signer,
      ),
      prover: f.prover,
      submission: f.selfPublication,
    });
    expect(kept.queued).toBe(true);
    expect(store.snapshot()!.pendingUserAccountUpdates![0]).toMatchObject({
      receiveKeyOperation: "keep",
      newReceiveKeyHash: receiveKeyHash,
    });
  });

  it("enforces rule-set safety before invoking custom authorization", async () => {
    const f = fixture();
    const nativeOnly = buildAccountRuleSet([{
      entryIndex: rules.rule.entryIndex,
      accountRuleEntryCommitment: rules.rule.accountRuleEntryCommitment,
    }]);
    let authorizeCalls = 0;
    await expect(runUserAccountUpdateClient({
      node: f.node,
      store: f.store(walletData()),
      address: wallet.address,
      chainId: CHAIN_ID,
      openFeeAmount: 0n,
      receiveKey: { operation: "clear" },
      ruleSetCommitment: nativeOnly.accountRuleSetCommitment,
      ruleInspection: {
        entries: [{
          entryIndex: rules.rule.entryIndex,
          applicationVkHash: rules.rule.applicationVkHash,
          configurationCommitment: rules.rule.configurationCommitment,
          commitmentBlinder: rules.rule.commitmentBlinder,
        }],
        recovery: { kind: "ethereum-signature-derived" },
      },
      authorizeBuild: async () => {
        authorizeCalls += 1;
        throw new Error("must not authorize");
      },
      prover: f.prover,
      submission: f.selfPublication,
    })).rejects.toThrow(/missing verified account-admin, contract-fee-sponsorship, privateValue-account-wide path/);
    expect(authorizeCalls).toBe(0);
  });

  it("retains exact pending bytes and outbox state across an ambiguous submission", async () => {
    const f = fixture();
    const store = f.store(walletDataWithFeeNote());
    let loseResponse = true;
    const submission = {
      ...f.submission,
      submit: async (context: Parameters<typeof f.submission.submit>[0]) => {
        if (loseResponse) throw new Error("submission response lost");
        return f.submission.submit(context);
      },
    };
    const params = {
      node: f.node,
      store,
      address: wallet.address,
      wallet,
      signer,
      chainId: CHAIN_ID,
      openFeeAmount: FEE_AMOUNT,
      receiveKey: { operation: "keep" as const },
      prover: f.prover,
      submission,
    };
    await expect(runUserAccountUpdateClient(params)).rejects.toThrow(/response lost/);
    const snapshot = store.snapshot()!;
    const pending = snapshot.pendingUserAccountUpdates![0]!;
    expect(snapshot.mempoolOutbox![0]).toMatchObject({
      contentHash: pending.contentHash,
      transactionHex: pending.transactionHex,
      kind: "userAccountUpdate",
      state: "prepared",
    });

    loseResponse = false;
    const retry = await runUserAccountUpdateClient(params);
    expect(retry.transactionHex).toBe(pending.transactionHex);
    expect(retry.retried).toBe(true);
    expect(f.proveCalls()).toBe(1);
  });

  it("settles an accepted advancement once finalized and expires by finalized time", async () => {
    const acceptedFixture = fixture();
    const acceptedStore = acceptedFixture.store(walletData());
    await runUserAccountUpdateClient({
      node: acceptedFixture.node,
      store: acceptedStore,
      address: wallet.address,
      wallet,
      signer,
      chainId: CHAIN_ID,
      openFeeAmount: 0n,
      receiveKey: { operation: "keep" },
      prover: acceptedFixture.prover,
      submission: acceptedFixture.selfPublication,
    });
    const acceptedData = acceptedStore.snapshot()!;
    // A reorg can still drop the advancing write; the bytes stay journaled.
    expect(reconcilePendingUserAccountUpdates(acceptedData, syncedChain({ accountRevision: 2 }), status)).toBe(false);
    expect(acceptedData.pendingUserAccountUpdates).toHaveLength(1);
    expect(reconcilePendingUserAccountUpdates(acceptedData, syncedChain({ accountRevision: 2 }),
      { ...status, finalizedBlock: 10n })).toBe(true);
    expect(acceptedData.pendingUserAccountUpdates).toBeUndefined();
    expect(acceptedData.mempoolOutbox).toBeUndefined();

    const expiredFixture = fixture();
    const expiredStore = expiredFixture.store(walletData());
    const validUntilTimestamp = status.latestBlockTimestamp + 1n;
    await runUserAccountUpdateClient({
      node: expiredFixture.node,
      store: expiredStore,
      address: wallet.address,
      wallet,
      signer,
      chainId: CHAIN_ID,
      openFeeAmount: 0n,
      receiveKey: { operation: "keep" },
      validUntilTimestamp,
      prover: expiredFixture.prover,
      submission: expiredFixture.selfPublication,
    });
    const expiredData = expiredStore.snapshot()!;
    expect(reconcilePendingUserAccountUpdates(expiredData, syncedChain({ timestamp: validUntilTimestamp + 1n }), status)).toBe(false);
    const finalized = (finalizedBlockTimestamp: bigint) => ({ ...status, finalizedBlock: 10n, finalizedBlockTimestamp });
    expect(reconcilePendingUserAccountUpdates(expiredData, syncedChain({}), finalized(validUntilTimestamp))).toBe(false);
    expect(reconcilePendingUserAccountUpdates(expiredData, syncedChain({}), finalized(validUntilTimestamp + 1n))).toBe(true);
    expect(expiredData.pendingUserAccountUpdates).toBeUndefined();
    expect(expiredData.mempoolOutbox).toBeUndefined();
  });

  it.each(["replace", "clear"] as const)("resumes a %s the local chain shows included above finality by its journaled bytes", async (operation) => {
    const f = fixture();
    const store = f.store(walletDataWithFeeNote());
    const replacement = generateMlKemKeyPair(new Uint8Array(64).fill(0x86));
    const params = {
      node: f.node, store, address: wallet.address, wallet, signer, chainId: CHAIN_ID, openFeeAmount: FEE_AMOUNT,
      receiveKey: operation === "replace" ? { operation, keyPair: replacement } as const : { operation } as const,
      prover: f.prover, submission: f.submission, settlePollMaxAttempts: 1,
    };
    const first = await runUserAccountUpdateClient(params);
    // The update landed in block 10, above the finalized block 9.
    await syncStoreTo(store, chain(operation === "replace"
      ? { accountRevision: 2, receiveKey: replacement.publicKey }
      : { accountRevision: 2, material: "absent" }).records);
    const retry = await runUserAccountUpdateClient(params);
    expect(retry.retried).toBe(true);
    expect(retry.transactionHex).toBe(first.transactionHex);
    expect(f.proveCalls()).toBe(1);
  });

  it("waits out an update whose predecessor a reorg dropped instead of failing synchronization", async () => {
    // The predecessor advanced the account at head and was settled; this
    // update is journaled against the advanced revision.
    const f = fixture("available", 2);
    const store = f.store(walletData());
    const validUntilTimestamp = status.latestBlockTimestamp + 1n;
    await runUserAccountUpdateClient({
      node: f.node,
      store,
      address: wallet.address,
      wallet,
      signer,
      chainId: CHAIN_ID,
      openFeeAmount: 0n,
      receiveKey: { operation: "keep" },
      validUntilTimestamp,
      prover: f.prover,
      submission: f.selfPublication,
    });
    const data = store.snapshot()!;
    const journaled = BigInt(data.pendingUserAccountUpdates![0]!.currentAccountRevision);

    // A reorg drops the predecessor: the account reads behind the journal.
    // The predecessor may be included again, so this update may still land.
    const behind = Number(journaled - 1n);
    expect(reconcilePendingUserAccountUpdates(data, syncedChain({ accountRevision: behind }), status)).toBe(false);
    expect(data.pendingUserAccountUpdates).toHaveLength(1);

    expect(reconcilePendingUserAccountUpdates(data, syncedChain({ accountRevision: behind }),
      { ...status, finalizedBlock: 10n, finalizedBlockTimestamp: validUntilTimestamp + 1n })).toBe(true);
    expect(data.pendingUserAccountUpdates).toBeUndefined();
    expect(data.mempoolOutbox).toBeUndefined();
  });
});

it("authenticates a fixed-nullifier named fee before the account owner signs", async () => {
  const { createSelectedRelayQuote } = await import("@pcash/sdk/eip712");
  const { payoutTransactionContext } = await import("@pcash/sdk/protocol");
  const key = new Uint8Array(32); key[31] = 64;
  const recipientSigner = privateKeyPcashActionSigner(key);
  for (const tamper of [false, true]) {
    const f = fixture(), store = f.store(walletDataWithFeeNote()), events: string[] = [];
    let context = 0n;
    const runtime = createWalletRuntime({ node: f.node, store, wallet, chainId: CHAIN_ID,
      signer: { address: signer.address, signTypedData: async (request) => { events.push("payer"); return signer.signTypedData(request); } },
      provers: { userAccountUpdate: { proveAndEncode: async (build) => {
        events.push("proof");
        expect(payoutTransactionContext(CHAIN_ID, build.publicInputs.slice(2, 6))).toBe(context);
        expect(build.publicInputs[PRIVATE_VALUE_PROFILES.S.offsets.issuanceOwner]).toBe(0n);
        return f.prover.proveAndEncode(build);
      } } }, submission: { ...f.submission, mode: "mempool" as const }, settlePollMaxAttempts: 1,
    });
    const action = runtime.account({ openFeeAmount: 0n, privateRelayFeeAmount: FEE_AMOUNT, receiveKey: { operation: "keep" },
      selectedRelayQuote: { recipient: recipientSigner.address, maxQuoteLifetimeSeconds: 600n, requestQuote: async (request) => {
        events.push("quote"); context = request.transactionContext;
        expect(request.validUntilTimestamp).toBe(status.latestBlockTimestamp + 600n);
        const quote = await createSelectedRelayQuote({ ...request, network: NETWORK, nkRoot: 124n, receiveKey: wallet.mlKemPublicKey, signer: recipientSigner });
        return tamper ? { ...quote, privateFeeAmount: BigInt(quote.privateFeeAmount) + 1n } : quote;
      } },
    });
    if (tamper) {
      await expect(action).rejects.toThrow(/quote does not match/);
      expect(events).toEqual(["quote"]);
      expect(store.snapshot()!.pendingUserAccountUpdates ?? []).toHaveLength(0);
    } else {
      await action;
      expect(events).toEqual(["quote", "payer", "proof"]);
      expect(BigInt(store.snapshot()!.pendingUserAccountUpdates![0]!.issuanceOwnerCommitment)).toBe(0n);
      expect(store.snapshot()!.pendingUserAccountUpdates![0]!.privateRelayFeeAmount).toBe(FEE_AMOUNT.toString());
      expect(BigInt(store.snapshot()!.pendingUserAccountUpdates![0]!.validUntilTimestamp))
        .toBe(status.latestBlockTimestamp + 600n);
    }
  }
});

describe("a retried account update keeps its saved private relay destination", () => {
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
  const a = quoter(64);
  const b = quoter(65);
  const unrequested = (recipient: bigint) => ({
    recipient,
    requestQuote: async () => { throw new Error("a retried update replays its saved bytes"); },
  });

  /** A journaled relayed update, reopened from a copy of its store. */
  async function journaled(selectedRelayQuote?: typeof a) {
    const f = fixture();
    const store = f.store(walletDataWithFeeNote());
    const params = {
      node: f.node, address: wallet.address, wallet, signer, chainId: CHAIN_ID,
      openFeeAmount: FEE_AMOUNT, receiveKey: { operation: "keep" as const }, prover: f.prover, submission: f.submission,
    };
    const selected = selectedRelayQuote !== undefined;
    const action = { ...params,
      openFeeAmount: selected ? 0n : FEE_AMOUNT,
      ...(selected ? { privateRelayFeeAmount: FEE_AMOUNT, selectedRelayQuote,
        submission: { ...f.submission, mode: "mempool" as const } } : {}),
    };
    await runUserAccountUpdateClient({ ...action, store });
    return { f, params: { ...action, store: memoryWalletStateStore(store.snapshot()!, store.chainSnapshot()) } };
  }

  it("persists the authenticated recipient with the pending update", async () => {
    const designated = await journaled(a);
    expect(designated.params.store.snapshot()!.pendingUserAccountUpdates![0]!.issuanceRecipient).toBeNull();
    expect(designated.params.store.snapshot()!.pendingUserAccountUpdates![0]!.privateRelayFeeAmount).toBe(FEE_AMOUNT.toString());
    expect(designated.params.store.snapshot()!.pendingUserAccountUpdates![0]!.privateRelayRecipient).toBe(a.address);
    const open = await journaled();
    expect(open.params.store.snapshot()!.pendingUserAccountUpdates![0]!.issuanceRecipient).toBeNull();
  });

  it("rejects a retry that names a different recipient before resubmitting", async () => {
    const designated = await journaled(a);
    await expect(runUserAccountUpdateClient({ ...designated.params, selectedRelayQuote: unrequested(b.recipient) }))
      .rejects.toThrow(/different selected relay destination/);
    const open = await journaled();
    await expect(runUserAccountUpdateClient({ ...open.params, selectedRelayQuote: unrequested(a.recipient) }))
      .rejects.toThrow(/different selected relay destination/);
    expect(designated.f.submitCalls()).toBe(1);
    expect(open.f.submitCalls()).toBe(1);
  });

  it("reports the saved private relay recipient when a selected update is retried", async () => {
    const { f, params } = await journaled(a);
    const resumed = await runUserAccountUpdateClient(params);
    expect(resumed.retried).toBe(true);
    expect(resumed.publicationDetails).toEqual({
      issuanceRoute: "none", beneficiary: { kind: "none" }, openFeeAmount: 0n,
      privateRelayFeeAmount: FEE_AMOUNT, privateRelayRecipient: a.address,
    });
    expect(f.proveCalls()).toBe(1);
  });

  it("resumes a retry that names the same recipient without requesting another quote", async () => {
    const { f, params } = await journaled(a);
    const resumed = await runUserAccountUpdateClient({ ...params, selectedRelayQuote: unrequested(a.recipient) });
    expect(resumed.publicationDetails).toMatchObject({ issuanceRoute: "none", beneficiary: { kind: "none" }, privateRelayRecipient: a.address });
    expect(f.proveCalls()).toBe(1);
  });

  it("rejects a retry whose private relay fee differs from the saved one", async () => {
    const { params } = await journaled(a);
    await expect(runUserAccountUpdateClient({ ...params, privateRelayFeeAmount: FEE_AMOUNT + 1n }))
      .rejects.toThrow(/different update|different private relay fee/);
  });
});
