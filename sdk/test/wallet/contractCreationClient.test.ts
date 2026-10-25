import { transactionIdentity as submissionIdentity } from "@pcash/sdk/protocol";
import { testStatus } from "./statusFixture.ts";
import { describe, expect, it, vi } from "vitest";
import { decodePayload, decryptEnvelope, generateMlKemKeyPair, receiveKeyHash } from "@pcash/sdk/protocol";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import { addressHex, toHex } from "@pcash/sdk/utils";
import { derivePcashProfileFromPrivateKey } from "../../src/wallet/externalIdentity.ts";
import {
  accountStateCommitment,
  buildContractBody,
  WIRE_PROOF_BYTES,
  functionSelector,
  fullOutputCommitment,
} from "@pcash/sdk/protocol";
import { SparseMerkleTree } from "@pcash/sdk/crypto";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import type { WalletFileData } from "../../src/wallet/noteStore.ts";
import { MERKLE_DEPTH, PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import { createWalletRuntime } from "../../src/wallet/actions/walletRuntime.ts";
import { runSponsoredContractCreationClient } from "../../src/wallet/actions/contractCreationClient.ts";
import { DurablePreBroadcastError } from "../../src/wallet/actions/durableSubmission.ts";
import { syntheticRecentBlockFixture } from "./builderTestHelpers.ts";
import { chainRecords } from "./chainFixture.ts";
import { anchoredChain } from "./chainFixture.ts";
import { storedReceiveKeyPair } from "../../src/wallet/receiveKeyring.ts";
import type { SponsoredContractCreationBuild } from "@pcash/sdk/builders";

const CHAIN_ID = 1_346_589_512n;
const GENESIS_HASH = `0x${"11".repeat(32)}`;
const PRIVATE_KEY = Uint8Array.from(
  Buffer.from("2233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011", "hex"),
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

const hex = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;
const address = `0x${wallet.address.toString(16).padStart(40, "0")}`;

// One native note, the sponsor's whole balance, so a retry that reselects coins
// finds nothing.
const noteSecret = 0x9911n;
const noteAmount = 5_000n;
const openFeeAmount = 250n;
const outputCommitment = fullOutputCommitment(
  { owner: wallet.address, noteSecret, assetId: 0n, amount: noteAmount },
  0,
);
const noteTree = new SparseMerkleTree(MERKLE_DEPTH);
noteTree.setLeaf(0, outputCommitment);
const noteOpening = noteTree.proof(0);
const accountStateTree = new SparseMerkleTree(MERKLE_DEPTH);
accountStateTree.setLeaf(0, accountStateCommitment(
  wallet.address,
  wallet.nullifierKeyCommitment,
  rules.accountRuleSetCommitment,
  0n,
  1n,
  receiveKeyHash(wallet.mlKemPublicKey),
));
const accountOpening = accountStateTree.proof(0);
const recentBlock = syntheticRecentBlockFixture({
  outputRoot: noteOpening.root,
  outputCount: 1,
  accountStateRoot: accountOpening.root,
  accountCount: 1,
  blockNumber: 10n,
  timestamp: 1_800_000_000n,
});
const boundary = recentBlock.boundary;
const chain = chainRecords({
  outputs: [{ leaf: outputCommitment, mark: true }],
  accounts: [{
    address,
    nullifierKeyCommitment: wallet.nullifierKeyCommitment,
    accountRuleSetCommitment: rules.accountRuleSetCommitment,
    receiveKey: wallet.mlKemPublicKey,
  }],
  anchor: boundary,
});
const contract = buildContractBody({
  nullifierKey: { publishesNkRoot: true, nkRoot: 0x5151n },
  functions: [{
    selector: functionSelector(0),
    applicationVkHash: 0x1234n,
    configurationCommitment: 0x5678n,
  }],
});

const status: StatusResult = testStatus({
  latestBlock: 10n,
  latestBlockHash: hex(boundary.blockHash),
  latestBlockTimestamp: 1_800_000_000n,
  finalizedBlock: 9n,
  finalizedBlockHash: `0x${"44".repeat(32)}`,
  finalizedBlockTimestamp: 1_799_999_000n,
  latestL1BlockNumber: 10n,
  latestL1BlockHash: hex(boundary.blockHash),
  finalizedL1BlockNumber: 9n,
  finalizedL1BlockHash: `0x${"44".repeat(32)}`,
  stateRoot: hex(boundary.header.stateRoot),
  l1OriginRoot: hex(boundary.header.l1OriginRoot),
  historyRoot: hex(boundary.header.historyRoot),
  pcashChainId: Number(CHAIN_ID),
  genesisHash: GENESIS_HASH,
  acceptedTransactionTypes: [0, 2],
  l1ChainId: NETWORK.l1ChainId,
  inboxAddress: NETWORK.inboxAddress,
  genesisL1Block: 1n,
  genesisL1BlockHash: `0x${"77".repeat(32)}`,
});

function walletData(): WalletFileData {
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

function fixture() {
  let proveCalls = 0;
  let retained: Record<string, unknown> | null = null;
  const node = {
    status: async () => status,
    getReceipt: async () => [],
    getMempoolTransaction: async () => retained,
  } as unknown as PcashNodeClient;
  const prover = {
    proveAndEncode: async (build: { encodeTransaction(proof: Uint8Array): Uint8Array }) => {
      proveCalls += 1;
      return build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES));
    },
  };
  return {
    node,
    prover,
    proveCalls: () => proveCalls,
    submission: (behavior: "queued" | "definite" = "queued") => ({
      mode: "mempool" as const,
      preflight: async () => "prepared",
      submit: async ({ transactionBytes: entry }: { transactionBytes: Uint8Array }) => {
        const { contentHash } = submissionIdentity(entry);

        if (behavior === "definite") throw new DurablePreBroadcastError("not broadcast");
        retained = {
          contentHash,
          kind: "contractAccount",
          rawTransaction: toHex(entry),
          status: "ready",
        };
        return { accepted: false, queued: true, output: "queued" };
      },
    }),
  };
}

function walletStore(data: WalletFileData = walletData()) {
  return memoryWalletStateStore(data, chain);
}

function params(f: ReturnType<typeof fixture>, store: ReturnType<typeof memoryWalletStateStore>) {
  return {
    node: f.node,
    store,
    wallet,
    signer,
    chainId: CHAIN_ID,
    contract: { body: contract.body, address: contract.address },
    openFeeAmount,
    prover: f.prover,
    submission: f.submission(),
  };
}

describe("durable sponsored contract creation client", () => {
  it("journals the sponsor's fee spend with its four input positions and change", async () => {
    const f = fixture();
    const store = walletStore();
    const created = await runSponsoredContractCreationClient(params(f, store));

    expect(created.contractAddress.toLowerCase())
      .toBe(`0x${contract.address.toString(16).padStart(40, "0")}`);
    expect(created.openFeeAmount).toBe(openFeeAmount);
    expect(created.changeAmount).toBe(noteAmount - openFeeAmount);
    const data = store.snapshot()!;
    const pending = data.pendingAssetActions!;
    expect(pending).toHaveLength(1);
    // A sponsored creation settles as a contractAccount receipt, and journals
    // all four section positions so reconciliation can match its nullifiers.
    expect(pending[0]!.receiptKind).toBe("contractAccount");
    expect(pending[0]!.inputs).toHaveLength(4);
    expect(pending[0]!.inputs.filter((input) => input.spentCommitment !== null)).toHaveLength(1);
    // The fee note is reserved and the change is pending until it settles.
    expect(data.notes.filter((note) => !note.spent && !note.pending)).toHaveLength(1);
    expect(data.notes.filter((note) => note.pending)).toHaveLength(1);
  });

  it("relays a creation with the node's suggested fee by default and reuses its durable fee after restart", async () => {
    const f = fixture();
    const estimateFee = vi.fn(async () => ({
      head: { blockNumber: 10n, blockHash: status.latestBlockHash },
      windowBlocks: 1n, byteSize: 30_000n,
      tiers: { low: openFeeAmount, standard: openFeeAmount, fast: openFeeAmount }, basis: {
        includedSamples: 0n, included: null, pendingSamples: 0n, pending: null,
      },
    }));
    f.node.estimateFee = estimateFee;
    const runtime = (store: ReturnType<typeof memoryWalletStateStore>) => createWalletRuntime({
      node: f.node, store, wallet, signer, chainId: CHAIN_ID,
      provers: { sponsoredContractCreation: f.prover }, submission: f.submission(),
    });
    const store = walletStore();
    const intent = { contract: { body: contract.body, address: contract.address } };
    const first = await runtime(store).contractCreation(intent);
    expect(first.openFeeAmount).toBe(openFeeAmount);
    expect(first.publicationDetails).toEqual({ issuanceRoute: "none", beneficiary: { kind: "none" }, openFeeAmount, privateRelayFeeAmount: 0n, privateRelayRecipient: null });
    expect(estimateFee).toHaveBeenCalledTimes(1);
    expect(estimateFee).toHaveBeenCalledWith({ byteSize: BigInt((first.transactionHex.length - 2) / 2) });
    estimateFee.mockRejectedValue(new Error("must not re-estimate"));
    const resumed = await runtime(memoryWalletStateStore(store.snapshot()!, store.chainSnapshot())).contractCreation(intent);
    expect(resumed.transactionHex).toBe(first.transactionHex);
    expect(resumed.openFeeAmount).toBe(openFeeAmount);
    expect(f.proveCalls()).toBe(1);
    expect(estimateFee).toHaveBeenCalledTimes(1);
  });

  it("refuses an explicit zero-fee creation relayed through the mempool before proving", async () => {
    const f = fixture();
    const store = walletStore();
    const runtime = createWalletRuntime({
      node: f.node, store, wallet, signer, chainId: CHAIN_ID,
      provers: { sponsoredContractCreation: f.prover }, submission: f.submission(),
    });
    await expect(runtime.contractCreation({ contract: { body: contract.body, address: contract.address }, openFeeAmount: 0n }))
      .rejects.toThrow(/zero fee pays no publisher; pass a positive fee or publish it yourself/);
    expect(store.snapshot()).toEqual(walletData());
    expect(f.proveCalls()).toBe(0);
  });

  it("self-publishes a zero-fee creation from all-dummy slots without touching the sponsor's notes", async () => {
    const f = fixture();
    const store = walletStore();
    const created = await runSponsoredContractCreationClient({ ...params(f, store), openFeeAmount: 0n, submission: { ...f.submission(), mode: "l1" as const } });

    expect(created.openFeeAmount).toBe(0n);
    expect(created.changeAmount).toBe(0n);
    expect(created.publicationDetails).toEqual({ issuanceRoute: "none", beneficiary: { kind: "none" }, openFeeAmount: 0n, privateRelayFeeAmount: 0n, privateRelayRecipient: null });
    const data = store.snapshot()!;
    const pending = data.pendingAssetActions!;
    // Contract creation earns no issuance and needs no PCASH self-fee.
    expect(pending[0]!.issuanceRecipient).toBeUndefined();
    expect(BigInt(pending[0]!.issuanceOwnerCommitment)).toBe(0n);
    expect(pending[0]!.inputs.every((input) => input.spentCommitment === null)).toBe(true);
    expect(pending[0]!.ownedOutputs).toHaveLength(0);
    // The sponsor's note stays spendable: a zero-fee creation spends nothing.
    expect(data.notes.filter((note) => !note.spent && !note.pending)).toHaveLength(1);
  });

  it("explains the note-only fee requirement and permits a self-published zero-fee creation without notes", async () => {
    const f = fixture();
    const store = walletStore({ ...walletData(), notes: [] });
    await expect(runSponsoredContractCreationClient({
      ...params(f, store), openFeeAmount: 10n ** 16n,
    })).rejects.toThrow("Contract creation needs 0.01 PCASH in spendable notes, but only 0 PCASH in notes can be used. Choose a zero PCASH creation fee");
    expect(f.proveCalls()).toBe(0);
    expect(store.snapshot()!.pendingAssetActions ?? []).toHaveLength(0);

    const created = await runSponsoredContractCreationClient({ ...params(f, store), openFeeAmount: 0n, submission: { ...f.submission(), mode: "l1" as const } });
    expect(created.openFeeAmount).toBe(0n);
    expect(f.proveCalls()).toBe(1);
    expect(store.snapshot()!.pendingAssetActions![0]!.inputs.every((input) => input.spentCommitment === null)).toBe(true);
  });

  it("resumes an ambiguous submission from its journal after a restart", async () => {
    const f = fixture();
    const firstStore = walletStore();
    const first = await runSponsoredContractCreationClient(params(f, firstStore));
    expect(f.proveCalls()).toBe(1);

    const restartedStore = memoryWalletStateStore(firstStore.snapshot()!, firstStore.chainSnapshot());
    const resumed = await runSponsoredContractCreationClient({
      ...params(f, restartedStore),
      prover: { proveAndEncode: async () => { throw new Error("a durable retry must not re-prove"); } },
      signer: {
        address: signer.address,
        signTypedData: async () => { throw new Error("a durable retry must not sign again"); },
      },
    });

    expect(resumed.contentHash).toBe(first.contentHash);
    expect(resumed.transactionHex).toBe(first.transactionHex);
    expect(f.proveCalls()).toBe(1);
    expect(restartedStore.snapshot()!.pendingAssetActions).toHaveLength(1);
  });

  it("releases the sponsor's notes when submission is definitively refused", async () => {
    const f = fixture();
    const store = walletStore();
    await expect(runSponsoredContractCreationClient({
      ...params(f, store),
      submission: f.submission("definite"),
    })).rejects.toThrow("not broadcast");

    const data = store.snapshot()!;
    expect(data.pendingAssetActions ?? []).toHaveLength(0);
    expect(data.notes.filter((note) => note.pending)).toHaveLength(0);
    expect(data.notes.filter((note) => !note.spent && !note.pending)).toHaveLength(1);
    expect(data.resourceReservations ?? []).toHaveLength(0);
  });
});

it("authenticates a fixed-nullifier named fee before the contract sponsor signs", async () => {
  const { createSelectedRelayQuote } = await import("@pcash/sdk/eip712");
  const { payoutTransactionContext } = await import("@pcash/sdk/protocol");
  const key = new Uint8Array(32); key[31] = 63;
  const recipientSigner = privateKeyPcashActionSigner(key);
  for (const tamper of [false, true]) {
    const f = fixture(), store = walletStore(), events: string[] = [];
    let context = 0n;
    const runtime = createWalletRuntime({ node: f.node, store, wallet, chainId: CHAIN_ID,
      signer: { address: signer.address, signTypedData: async (request) => { events.push("payer"); return signer.signTypedData(request); } },
      provers: { sponsoredContractCreation: { proveAndEncode: async (build) => {
        events.push("proof");
        expect(payoutTransactionContext(CHAIN_ID, build.publicInputs.slice(2, 6))).toBe(context);
        expect(build.publicInputs[PRIVATE_VALUE_PROFILES.S.offsets.issuanceOwner]).toBe(0n);
        return f.prover.proveAndEncode(build);
      } } }, submission: { ...f.submission(), mode: "mempool" as const }, settlePollMaxAttempts: 1,
    });
    const action = runtime.contractCreation({ contract: { body: contract.body, address: contract.address }, openFeeAmount: 0n, privateRelayFeeAmount: openFeeAmount,
      selectedRelayQuote: { recipient: recipientSigner.address, requestQuote: async (request) => {
        events.push("quote"); context = request.transactionContext;
        const quote = await createSelectedRelayQuote({ ...request, network: NETWORK, nkRoot: 123n, receiveKey: wallet.mlKemPublicKey, signer: recipientSigner });
        return tamper ? { ...quote, privateFeeAmount: BigInt(quote.privateFeeAmount) + 1n } : quote;
      } },
    });
    if (tamper) {
      await expect(action).rejects.toThrow(/quote does not match/);
      expect(events).toEqual(["quote"]);
      expect(store.snapshot()!.pendingAssetActions ?? []).toHaveLength(0);
    } else {
      await action;
      expect(events).toEqual(["quote", "payer", "proof"]);
      expect(BigInt(store.snapshot()!.pendingAssetActions![0]!.issuanceOwnerCommitment)).toBe(0n);
      expect(store.snapshot()!.pendingAssetActions![0]!.privateRelayFeeAmount).toBe(openFeeAmount.toString());
    }
  }
});

it("threads a selected multi-day deadline ceiling through the wallet runtime", async () => {
  const { createSelectedRelayQuote } = await import("@pcash/sdk/eip712");
  const relayKey = new Uint8Array(32); relayKey[31] = 79;
  const relaySigner = privateKeyPcashActionSigner(relayKey);
  const requested = status.latestBlockTimestamp + 3n * 86_400n;
  const bounded = status.latestBlockTimestamp + 1_800n;
  const run = async (validUntilMode: "exact" | "ceiling") => {
    const f = fixture(), store = walletStore();
    let quoteRequests = 0, proofCalls = 0;
    const runtime = createWalletRuntime({ node: f.node, store, wallet, signer, chainId: CHAIN_ID,
      provers: { sponsoredContractCreation: { proveAndEncode: async (build) => {
        proofCalls += 1;
        expect(build.payment.transaction.global.validUntilTimestamp).toBe(bounded);
        return f.prover.proveAndEncode(build);
      } } }, submission: f.submission(), settlePollMaxAttempts: 1,
    });
    const selectedRelayQuote = { recipient: relaySigner.address, maxQuoteLifetimeSeconds: 3_600n,
      requestQuote: async (request: Parameters<import("@pcash/sdk/eip712").SelectedRelayQuoteProvider["requestQuote"]>[0]) => {
        quoteRequests += 1;
        expect(request.validUntilTimestamp).toBe(bounded);
        return createSelectedRelayQuote({ ...request, network: NETWORK, nkRoot: 123n,
          receiveKey: wallet.mlKemPublicKey, signer: relaySigner });
      },
    };
    const operation = runtime.contractCreation({ contract: { body: contract.body, address: contract.address },
      openFeeAmount: 0n, privateRelayFeeAmount: openFeeAmount, selectedRelayQuote,
      validUntilTimestamp: requested, validUntilMode,
    });
    return { operation, store, counts: () => ({ quoteRequests, proofCalls }) };
  };
  const ceiling = await run("ceiling");
  await ceiling.operation;
  expect(ceiling.counts()).toEqual({ quoteRequests: 1, proofCalls: 1 });
  expect(BigInt(ceiling.store.snapshot()!.pendingAssetActions![0]!.validUntilTimestamp)).toBe(bounded);
  const exact = await run("exact");
  await expect(exact.operation).rejects.toThrow(/exact sponsored contract creation deadline exceeds/);
  expect(exact.counts()).toEqual({ quoteRequests: 0, proofCalls: 0 });
});

describe("a resumed sponsored creation keeps its saved private relay destination", () => {
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
    requestQuote: async () => { throw new Error("a resumed creation replays its saved bytes"); },
  });

  /** A journaled creation, reopened from a copy of its store. */
  async function journaled(selectedRelayQuote?: typeof a) {
    const f = fixture();
    const store = walletStore();
    const selected = selectedRelayQuote !== undefined;
    const action = { ...params(f, store),
      openFeeAmount: selected ? 0n : openFeeAmount,
      ...(selected ? { privateRelayFeeAmount: openFeeAmount, selectedRelayQuote,
        submission: { ...f.submission(), mode: "mempool" as const } } : {}),
    };
    await runSponsoredContractCreationClient(action);
    return { f, store: memoryWalletStateStore(store.snapshot()!, store.chainSnapshot()), action };
  }

  it("reports a designated creation resumed without a provider as paying its saved recipient", async () => {
    const { store, action } = await journaled(a);
    const resumed = await runSponsoredContractCreationClient({ ...action, store });
    expect(resumed.publicationDetails).toEqual({
      issuanceRoute: "none", beneficiary: { kind: "none" }, openFeeAmount: 0n,
      privateRelayFeeAmount: openFeeAmount, privateRelayRecipient: a.address,
    });
  });

  it("rejects a resumed creation that names a different destination", async () => {
    const designated = await journaled(a);
    await expect(runSponsoredContractCreationClient({ ...designated.action, store: designated.store, selectedRelayQuote: unrequested(b.recipient) }))
      .rejects.toThrow(/different selected relay destination/);
    const open = await journaled();
    await expect(runSponsoredContractCreationClient({ ...open.action, store: open.store, selectedRelayQuote: unrequested(a.recipient), privateRelayFeeAmount: openFeeAmount, openFeeAmount: 0n, submission: { ...open.f.submission(), mode: "mempool" as const } }))
      .rejects.toThrow(/different selected relay destination/);
    const resumedOpen = await runSponsoredContractCreationClient({ ...open.action, store: open.store });
    expect(resumedOpen.publicationDetails).toMatchObject({ issuanceRoute: "none", beneficiary: { kind: "none" } });
  });
});

describe("registered sponsored creation change delivery", () => {
  function storeWithKey(receiveKey: Uint8Array | null, data = walletData()) {
    return memoryWalletStateStore(data, anchoredChain({
      outputs: [{ leaf: outputCommitment, mark: true }],
      accounts: [{ address, nullifierKeyCommitment: wallet.nullifierKeyCommitment,
        accountRuleSetCommitment: rules.accountRuleSetCommitment,
        ...(receiveKey === null ? {} : { receiveKey }) }],
      blockNumber: 10n, timestamp: status.latestBlockTimestamp,
    }).records);
  }

  it("encrypts sponsor change to the registered owned key after replacement", async () => {
    const rotated = generateMlKemKeyPair();
    const data = walletData();
    data.receiveKeys.push(storedReceiveKeyPair(rotated));
    const f = fixture();
    const prove = vi.fn(f.prover.proveAndEncode);
    await runSponsoredContractCreationClient({ ...params(f, storeWithKey(rotated.publicKey, data)), prover: { proveAndEncode: prove } });
    const build = prove.mock.calls[0]![0] as SponsoredContractCreationBuild;
    expect(decodePayload(decryptEnvelope(rotated.secretKey, build.payment.outputData[0]!)!, { chainId: CHAIN_ID }).amount)
      .toBe(noteAmount - openFeeAmount);
    expect(decryptEnvelope(wallet.mlKemSecretKey, build.payment.outputData[0]!)).toBeNull();
  });

  it("fails before proving when change has no registered key or owned secret", async () => {
    for (const receiveKey of [null, generateMlKemKeyPair().publicKey]) {
      const f = fixture();
      await expect(runSponsoredContractCreationClient(params(f, storeWithKey(receiveKey))))
        .rejects.toThrow(/registered receive key/);
      expect(f.proveCalls()).toBe(0);
    }
  });

  it("allows an exact fee with no registered key because it creates no change", async () => {
    const f = fixture();
    const result = await runSponsoredContractCreationClient({ ...params(f, storeWithKey(null)), openFeeAmount: noteAmount });
    expect(result.changeAmount).toBe(0n);
    expect(f.proveCalls()).toBe(1);
  });
});
