import { recordValue } from "../recordHelpers.ts";
import { storedReceiveKeyPair } from "../../src/wallet/receiveKeyring.ts";
import { describe, expect, it, vi } from "vitest";
import {
  collectAssetActionWitnesses,
  prepareAssetAction,
  submitPreparedAssetAction,
} from "../../src/wallet/actions/assetActionClient.ts";
import { buildAssetAction, outOfBandAssetActionOutput, type AssetActionBuild } from "@pcash/sdk/builders";
import { DurablePreBroadcastError, type DurableSubmissionAdapter } from "../../src/wallet/actions/durableSubmission.ts";
import { runAssetCreationClient } from "../../src/wallet/actions/assetCreationClient.ts";
import { synchronizeWalletInventory } from "../../src/wallet/actions/scan.ts";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import {
  addPendingAssetAction,
  addPendingNote,
  removeMempoolOutboxEntry,
  removePendingAssetAction,
  removePendingNotesForTransaction,
  spendableNotes,
  storedAssetDefinition,
  type WalletFileData,
} from "../../src/wallet/noteStore.ts";
import { deliveredOutput, senderRegionOf } from "./deliveryHelpers.ts";
import type { PcashNodeClient, StatusResult } from "@pcash/sdk/clients";
import {
  assetDefinitionSchema,
  assetSecretCommitment,
  sizeClassFiller,
  SlotClass,
  standardFungibleAssetId,
  encodePrivateValueTransaction,
  WIRE_PROOF_BYTES,
  controlledIssuanceOpening,
  transactionPublication,
  assetDefinitionAssetId,
  decodePayload,
  decryptEnvelope,
  generateMlKemKeyPair,
  type MlKemKeyPair,
} from "@pcash/sdk/protocol";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import * as referenceRules from "@pcash/sdk/rules";
import { derivePcashProfileFromPrivateKey } from "../../src/wallet/externalIdentity.ts";
import { assetActionInputResources } from "../../src/wallet/reservations.ts";
import { anchoredChain, ChainSim, consumedIn } from "./chainFixture.ts";
import { WalletChainState } from "../../src/wallet/chainState.ts";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import { emptyWalletState } from "../../src/wallet/store.ts";
import { fieldToHex } from "@pcash/sdk/crypto";
import { addressHex, fromHex, bytes32Hex } from "@pcash/sdk/utils";
import { testStatus } from "./statusFixture.ts";

const creatorSecret = 0x1234n;
const totalSupply = 1_000n;
const recipientAddress = 0x1234n;
const recipientNoteSecret = 0x10n;
const descriptorFields = {
  metadataCommitment: 0x9999n,
  initialSupply: totalSupply,
  assetSecretCommitment: assetSecretCommitment(creatorSecret),
};
const descriptor = {
  assetId: standardFungibleAssetId(descriptorFields),
  ...descriptorFields,
};

function fixture(nativeAmount = 0n, openFeeAmount = 0n) {
  const build = buildAssetAction({
    pcashChainId: 0x1ff6n,
    owner: { address: 0x1234n, nkRoot: 123n, accountIndex: 0, accountSiblings: Array(40).fill(0n),
      accountRuleSetCommitment: 1n, accountKind: 0n, accountRevision: 0n,
      receiveKeyHash: 0n,
      rule: { configurationCommitment: 1n, commitmentBlinder: 0n, entryIndex: 0, siblings: Array(8).fill(0n) } },
    snapshot: {
      recentPcashBlockHash: 1n,
      stateRoot: 2n,
      stateRootHeaderSiblings: [0n, 0n, 0n, 0n],
      outputRoot: 3n,
      outputRootStateSiblings: [0n, 0n, 0n, 0n],
      accountStateRoot: 4n,
      accountStateRootStateSiblings: [0n, 0n, 0n, 0n],
    },
    assetDescriptor: descriptor,
    assetSecret: creatorSecret,
    inputs: [
      { kind: "creation-marker" },
      nativeAmount === 0n ? { kind: "dummy" } : { kind: "native", amount: nativeAmount, noteSecret: 99n, leafIndex: 0, siblings: Array(40).fill(0n) },
      { kind: "dummy" },
      { kind: "dummy" },
    ],
    outputs: [
      outOfBandAssetActionOutput({
        kind: "asset",
        recipientAddress: 0x1234n,
        noteSecret: recipientNoteSecret,
        amount: totalSupply,
        outputData: sizeClassFiller(),
      }),
      nativeAmount === openFeeAmount ? { kind: "dummy", dummySecret: 0x11n, amount: 0n, outputData: sizeClassFiller() } : outOfBandAssetActionOutput({ kind: "native", recipientAddress: 0x1234n, noteSecret: 98n, amount: nativeAmount - openFeeAmount, outputData: sizeClassFiller() }),
      { kind: "dummy", dummySecret: 0x12n, amount: 0n, outputData: sizeClassFiller() },
      { kind: "dummy", dummySecret: 0x13n, amount: 0n, outputData: sizeClassFiller() },
      { kind: "dummy", dummySecret: 0x14n, amount: 0n, outputData: sizeClassFiller() },
    ],
    openFeeAmount,
    issuanceOwnerCommitment: 0n,
    validUntilTimestamp: 100n,
    dummyInputSeed: 0x99n,
  });
  const entry = encodePrivateValueTransaction({
    publicInputs: build.publicInputs,
    proof: new Uint8Array(WIRE_PROOF_BYTES),
    outputData: build.outputData, arena: build.arena,
  });
  return { build, transactionBytes: entry };
}

function walletData(): WalletFileData {
  return {
    address: addressHex(recipientAddress),
    network: { chainId: "8182", genesisHash: `0x${"11".repeat(32)}` },
    receiveKeys: [],
    notes: [],
  };
}

const fixtureNetwork = {
  pcashChainId: 0x1ff6n,
  l1ChainId: 11_155_111n,
  inboxAddress: `0x${"66".repeat(20)}`,
};
const fixtureGenesisHash = `0x${"11".repeat(32)}`;
const profile = derivePcashProfileFromPrivateKey(
  Uint8Array.from(Buffer.from("10112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex")),
  fixtureNetwork,
);
const profileChain = (accountRuleSetCommitment: bigint, receiveKey?: Uint8Array | null) => anchoredChain({ accounts: [{
  address: addressHex(profile.address), nullifierKeyCommitment: profile.nullifierKeyCommitment, accountRuleSetCommitment,
  ...(receiveKey === undefined ? {} : { receiveKey }),
}] });

describe("asset action durable preparation", () => {
  it.each([
    ["asset-payment", "assetPaymentRule"], ["asset-burn", "assetBurnRule"],
    ["batch-transfer", "batchTransferRule"], ["asset-creation", "assetCreationRule"],
  ] as const)("selects the %s installed rule before building", async (authorizationKind, property) => {
    const rules = defaultUserAccountRuleSet({ wallet: profile, network: fixtureNetwork, secrets: profile.defaultUserRuleSecrets });
    const status = testStatus({ pcashChainId: Number(fixtureNetwork.pcashChainId), genesisHash: fixtureGenesisHash, l1ChainId: fixtureNetwork.l1ChainId, inboxAddress: fixtureNetwork.inboxAddress });
    const node = { status: async () => status } as unknown as PcashNodeClient;
    const data = { ...walletData(), address: addressHex(profile.address) };
    const store = memoryWalletStateStore(data, profileChain(rules.accountRuleSetCommitment).records);
    const derivation = vi.spyOn(referenceRules, "defaultUserAccountRuleSet");
    const result = await collectAssetActionWitnesses({ node, store, wallet: profile, authorizationKind, inputOpenings: [] });
    expect(derivation).toHaveBeenCalledTimes(1);
    derivation.mockRestore();
    expect(result.owner.rule.entryIndex).toBe(rules[property].entryIndex);
  });

  it("uses the supplied custom rule without deriving defaults", async () => {
    const rules = defaultUserAccountRuleSet({ wallet: profile, network: fixtureNetwork, secrets: profile.defaultUserRuleSecrets });
    const status = testStatus({ pcashChainId: Number(fixtureNetwork.pcashChainId), genesisHash: fixtureGenesisHash, l1ChainId: fixtureNetwork.l1ChainId, inboxAddress: fixtureNetwork.inboxAddress });
    const node = { status: async () => status } as unknown as PcashNodeClient;
    const data = { ...walletData(), address: addressHex(profile.address) };
    const store = memoryWalletStateStore(data, profileChain(rules.accountRuleSetCommitment).records);
    const derivation = vi.spyOn(referenceRules, "defaultUserAccountRuleSet");
    const result = await collectAssetActionWitnesses({ node, store, wallet: profile, authorizationKind: "asset-payment", inputOpenings: [], ownerRule: rules.assetPaymentRule });
    expect(derivation).not.toHaveBeenCalled();
    derivation.mockRestore();
    expect(result.owner.rule).toEqual(rules.assetPaymentRule);
  });

  it.each([["unfunded", 0n, 0n], ["native notes", 5n, 2n]] as const)("journals asset creation funded by %s", (_label, nativeAmount, openFeeAmount) => {
    const built = fixture(nativeAmount, openFeeAmount);
    const prepared = prepareAssetAction(built);
    expect(prepared.pending.openFeeAmount).toBe(openFeeAmount.toString());
    expect(built.build.transaction.inputs.filter((input) => input.slotClass === SlotClass.NATIVE)).toHaveLength(nativeAmount === 0n ? 0 : 1);
    expect(assetActionInputResources(prepared.pending).every((resource) => resource.startsWith("note:"))).toBe(true);
  });

  it("does not submit when the synced chain already consumed an input", async () => {
    const built = fixture();
    const prepared = prepareAssetAction(built);
    const data = walletData();
    const { boundary } = anchoredChain({});
    const store = memoryWalletStateStore(data, anchoredChain({
      consumed: consumedIn(boundary, bytes32Hex(7n), [prepared.pending.inputs[0]!.nullifier]),
    }).records);
    let submits = 0;

    await expect(submitPreparedAssetAction({
      node: {} as PcashNodeClient,
      store,
      data,
      status: testStatus(),
      preparedAction: prepared,
      submission: {
        mode: "l1",
        preflight: async () => "prepared",
        submit: async () => {
          submits += 1;
          throw new Error("must not submit");
        },
      },
      preparedSubmission: "prepared",
    })).rejects.toThrow("an asset-action nullifier was spent before reservation");

    expect(submits).toBe(0);
    expect(data.pendingAssetActions).toBeUndefined();
  });

  it("retains exact bytes and openings for a zero-fee action", () => {
    const { build, transactionBytes: entry } = fixture();
    const prepared = prepareAssetAction({
      build,
      transactionBytes: entry,
      ownedOutputs: [{
        outputIndex: 0,
        assetId: build.assetId,
        amount: totalSupply,
        owner: recipientAddress,
        noteSecret: recipientNoteSecret,
      }],
    });
    expect(prepared.pending.inputs).toHaveLength(4);
    expect(prepared.pending.ownedOutputs).toHaveLength(1);
    expect(prepared.pending).toMatchObject({ openFeeAmount: "0", issuanceOwnerCommitment: "0" });

    const wallet = walletData();
    addPendingAssetAction(wallet, prepared.pending);
    expect(wallet.pendingAssetActions).toHaveLength(1);
  });

  it("rejects a wrong output opening and reserves real notes across action kinds", () => {
    const { build, transactionBytes: entry } = fixture();
    expect(() => prepareAssetAction({
      build,
      transactionBytes: entry,
      ownedOutputs: [{
        outputIndex: 0,
        assetId: build.assetId,
        amount: totalSupply,
        owner: recipientAddress,
        noteSecret: recipientNoteSecret + 1n,
      }],
    })).toThrow("opening does not match");

    const wallet = walletData();
    wallet.notes.push({
      leafIndex: "0",
      outputIndex: 0,
      assetId: `0x${build.assetId.toString(16)}`,
      amount: "1",
      owner: addressHex(recipientAddress),
      noteSecret: "0x1",
      commitment: `0x${build.transaction.inputs[0]!.nullifier.toString(16).padStart(64, "0")}`,
      spent: false,
      pending: false,
    });
    const pending = prepareAssetAction({ build, transactionBytes: entry }).pending;
    pending.inputs[0]!.spentCommitment = wallet.notes[0]!.commitment;
    addPendingAssetAction(wallet, pending);
    expect(spendableNotes(wallet, build.assetId)).toHaveLength(0);
  });

  it("returns a zero-secret row as spendable and never a zero-value row", () => {
    const wallet = walletData();
    const base = {
      leafIndex: "1",
      outputIndex: 0,
      assetId: "0x0",
      owner: addressHex(recipientAddress),
      commitment: "0x1",
      spent: false,
      pending: false,
    };
    const zeroSecret = { ...base, leafIndex: "2", commitment: "0x2", amount: "1", noteSecret: "0x0" };
    wallet.notes.push({ ...base, amount: "0", noteSecret: "0x1" }, zeroSecret);
    expect(spendableNotes(wallet)).toEqual([zeroSecret]);
  });

  it("rejects an owned output journaled into another wallet", () => {
    const { build, transactionBytes: entry } = fixture();
    const prepared = prepareAssetAction({
      build,
      transactionBytes: entry,
      ownedOutputs: [{
        outputIndex: 0,
        assetId: build.assetId,
        amount: totalSupply,
        owner: recipientAddress,
        noteSecret: recipientNoteSecret,
      }],
    });
    const otherWallet: WalletFileData = { ...walletData(), address: addressHex(0x9999n) };
    expect(() => addPendingAssetAction(otherWallet, prepared.pending))
      .toThrow(/owner.*wallet|belongs to another owner/);
    expect(otherWallet.pendingAssetActions ?? []).toEqual([]);
    expect(otherWallet.notes).toEqual([]);
    expect(otherWallet.mempoolOutbox ?? []).toEqual([]);
  });

  it("treats a repeated fresh submission as a retry without rolling back the first journal", async () => {
    const { build, transactionBytes: entry } = fixture();
    const prepared = prepareAssetAction({
      build,
      transactionBytes: entry,
      ownedOutputs: [{
        outputIndex: 0,
        assetId: build.assetId,
        amount: totalSupply,
        owner: recipientAddress,
        noteSecret: recipientNoteSecret,
      }],
    });
    const data = walletData();
    addPendingAssetAction(data, prepared.pending);
    addPendingNote(data, prepared.pending.contentHash, {
      outputIndex: 0,
      assetId: build.assetId,
      amount: totalSupply,
      owner: recipientAddress,
      noteSecret: recipientNoteSecret,
    });
    const node = {
      getReceipt: async () => [],
      getMempoolTransaction: async () => null,
      status: async () => testStatus(),
    } as unknown as PcashNodeClient;
    const chain = WalletChainState.fromRecords(anchoredChain({}).records);
    const saves: WalletFileData[] = [];

    await expect(submitPreparedAssetAction({
      node,
      store: {
        identity: { address: BigInt(data.address), network: data.network },
        load: () => Promise.resolve(data),
        transaction: (operation) => {
          const committed = operation(data);
          Object.assign(data, committed.data);
          return Promise.resolve(committed.value);
        },
        save: (value) => { saves.push(structuredClone(value)); return Promise.resolve(); },
        readChain: async (read) => read(chain),
        chainStep: (step) => step(chain),
      },
      data,
      status: {} as StatusResult,
      preparedAction: prepared,
      submission: {
        mode: "l1",
        preflight: async () => "prepared",
        submit: async () => { throw new DurablePreBroadcastError("not broadcast"); },
      },
      preparedSubmission: "ignored-on-retry",
    })).rejects.toThrow("not broadcast");

    expect(data.pendingAssetActions).toEqual([prepared.pending]);
    expect(data.notes).toEqual([
      expect.objectContaining({ pending: true, pendingContentHash: prepared.pending.contentHash }),
    ]);
    expect(saves).toEqual([]);
  });
});

describe("asset creation publication", () => {
  const privateKey = Uint8Array.from(Buffer.from("10112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex"));
  const rules = defaultUserAccountRuleSet({ wallet: profile, network: fixtureNetwork, secrets: profile.defaultUserRuleSecrets });
  const status = testStatus({ pcashChainId: Number(fixtureNetwork.pcashChainId), genesisHash: fixtureGenesisHash, l1ChainId: fixtureNetwork.l1ChainId, inboxAddress: fixtureNetwork.inboxAddress, latestBlockTimestamp: 500n });
  function creationNode() {
    return {
      status: async () => status,
      getIssuanceQuote: async () => { throw new Error("fee planning reads no issuance quote"); },
      estimateFee: async () => { throw new Error("a fee-less action needs no fee estimate"); },
      getReceipt: async () => [],
      getMempoolTransaction: async () => null,
    } as unknown as PcashNodeClient;
  }
  function adapter(mode: "mempool" | "l1", trace: string[]): DurableSubmissionAdapter<string, string> {
    return {
      mode,
      preflight: async () => { trace.push("preflight"); return "prepared"; },
      submit: async () => { trace.push("submit"); return { accepted: false, queued: true, output: "queued" }; },
    };
  }
  const create = (node: PcashNodeClient, store: ReturnType<typeof memoryWalletStateStore>, submission: DurableSubmissionAdapter<string, string>, proofs: string[], builds: AssetActionBuild[] = []) => runAssetCreationClient({
    node, store, wallet: profile, signer: privateKeyPcashActionSigner(privateKey), chainId: fixtureNetwork.pcashChainId,
    metadata: { name: "Asset", symbol: "AST", decimals: 0, contentDigest: new Uint8Array(32) }, initialSupply: 10n,
    prover: { proveAndEncode: async (build) => {
      proofs.push("proof");
      builds.push(build);
      return encodePrivateValueTransaction({ publicInputs: build.publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData: build.outputData, arena: build.arena });
    } },
    submission, settlePollMaxAttempts: 1, settlePollIntervalMs: 0,
  });
  const walletStore = (pair: MlKemKeyPair | null = { publicKey: profile.mlKemPublicKey, secretKey: profile.mlKemSecretKey }) => memoryWalletStateStore({
    ...walletData(), address: addressHex(profile.address),
    receiveKeys: pair === null ? [] : [storedReceiveKeyPair(pair)],
  }, profileChain(rules.accountRuleSetCommitment, pair?.publicKey ?? null).records);

  it("encrypts newly created tokens to the registered independent receive key", async () => {
    const pair = generateMlKemKeyPair(new Uint8Array(64).fill(71));
    const builds: AssetActionBuild[] = [];
    await create(creationNode(), walletStore(pair), adapter("mempool", []), [], builds);
    expect(decryptEnvelope(profile.mlKemSecretKey, builds[0]!.outputData[0]!)).toBeNull();
    expect(decodePayload(decryptEnvelope(pair.secretKey, builds[0]!.outputData[0]!)!, { chainId: fixtureNetwork.pcashChainId }).amount).toBe(10n);
  });

  it("refuses asset creation with no registered receive key before proving", async () => {
    const proofs: string[] = [];
    await expect(create(creationNode(), walletStore(null), adapter("mempool", []), proofs)).rejects.toThrow(/no registered receive key/);
    expect(proofs).toEqual([]);
  });

  it("relays a zero-fee open-route creation", async () => {
    const store = walletStore();
    const trace: string[] = [];
    const result = await create(creationNode(), store, adapter("mempool", trace), []);
    expect(transactionPublication(fromHex(result.transactionHex))).toMatchObject({ openFeeAmount: 0n, issuanceOwnerCommitment: 0n });
    expect(result.publicationDetails).toEqual({ issuanceRoute: "open", beneficiary: { kind: "publisher" }, openFeeAmount: 0n, privateRelayFeeAmount: 0n, privateRelayRecipient: null });
    expect(store.snapshot()?.mempoolOutbox).toHaveLength(1);
    expect(trace).toEqual(["preflight", "submit"]);
  });

  it("self-publishes with no fee through an explicit L1 adapter, designated to the wallet's own commitment", async () => {
    const store = walletStore();
    const result = await create(creationNode(), store, adapter("l1", []), []);
    const entry = fromHex(result.transactionHex);
    const section = transactionPublication(entry)!;
    expect(section.openFeeAmount).toBe(0n);
    expect(section.issuanceOwnerCommitment).not.toBe(0n);
    expect(controlledIssuanceOpening(entry, fixtureNetwork.pcashChainId, profile)?.ownerCommitment).toBe(section.issuanceOwnerCommitment);
    expect(result.publicationDetails).toEqual({ issuanceRoute: "designated", beneficiary: { kind: "self" }, openFeeAmount: 0n, privateRelayFeeAmount: 0n, privateRelayRecipient: null });
    expect(store.snapshot()?.pendingAssetActions?.[0]?.issuanceRecipient).toBe(addressHex(profile.address));
    expect(store.snapshot()?.mempoolOutbox).toBeUndefined();
  });

  it("journals the definition and asset secret before broadcast and records the definition in the sender region only", async () => {
    const store = walletStore();
    let journaled: WalletFileData["assets"];
    let built: AssetActionBuild | undefined;
    const submission: DurableSubmissionAdapter<string, string> = {
      mode: "mempool",
      preflight: async () => "prepared",
      submit: async () => { journaled = store.snapshot()?.assets; return { accepted: false, queued: true, output: "queued" }; },
    };
    const result = await runAssetCreationClient({
      node: creationNode(), store, wallet: profile, signer: privateKeyPcashActionSigner(privateKey), chainId: fixtureNetwork.pcashChainId,
      metadata: { name: "Asset", symbol: "AST", decimals: 0, contentDigest: new Uint8Array(32).fill(5) }, initialSupply: 10n,
      prover: { proveAndEncode: async (build) => {
        built = build;
        return encodePrivateValueTransaction({ publicInputs: build.publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData: build.outputData, arena: build.arena });
      } },
      submission, settlePollMaxAttempts: 1, settlePollIntervalMs: 0,
    });
    expect(assetDefinitionAssetId(result.definition)).toBe(result.assetId);
    expect(result.definition.metadata.contentDigest).toEqual(new Uint8Array(32).fill(5));
    expect(journaled).toHaveLength(1);
    expect(BigInt(journaled![0]!.assetId)).toBe(result.assetId);
    expect(storedAssetDefinition(journaled![0]!)).toEqual(result.definition);
    expect(assetSecretCommitment(BigInt(journaled![0]!.assetSecret!))).toBe(result.definition.assetSecretCommitment);
    const delivered = deliveredOutput(built!, fixtureNetwork.pcashChainId, profile.mlKemSecretKey, 0)!;
    expect(delivered.note.amount).toBe(10n);
    expect(delivered.note).not.toHaveProperty("anchor");
    expect(recordValue(senderRegionOf(built!, fixtureNetwork.pcashChainId, profile.outgoingKey)?.records, assetDefinitionSchema)).toEqual(result.definition);
  });

  it("restores a creation's definition from its sender region into an empty asset store", async () => {
    const result = await create(creationNode(), walletStore(), adapter("mempool", []), []);
    const sim = new ChainSim(fixtureNetwork.pcashChainId, fixtureNetwork);
    sim.include(fromHex(result.transactionHex));
    const data = emptyWalletState({ address: profile.address, network: { chainId: fixtureNetwork.pcashChainId, genesisHash: sim.genesisHash } });
    await synchronizeWalletInventory(sim.client(), profile, fixtureNetwork.pcashChainId, data, {
      store: memoryWalletStateStore(data), target: { pcashNumber: sim.head.number, pcashHash: fieldToHex(sim.head.hash).toLowerCase() },
    });
    expect(data.notes).toMatchObject([{ assetId: `0x${result.assetId.toString(16)}`, amount: "10" }]);
    expect(data.sentOutputs).toBeUndefined();
    expect(data.assets?.map((asset) => [BigInt(asset.assetId), storedAssetDefinition(asset)])).toEqual([[result.assetId, result.definition]]);
  });

  it("drops new creation material when the creation is definitely never broadcast", async () => {
    const store = walletStore();
    const submission: DurableSubmissionAdapter<string, string> = {
      mode: "mempool",
      preflight: async () => "prepared",
      submit: async () => { throw new DurablePreBroadcastError("rejected"); },
    };
    await expect(create(creationNode(), store, submission, [])).rejects.toThrow("rejected");
    expect(store.snapshot()?.assets).toBeUndefined();
    expect(store.snapshot()?.pendingAssetActions).toBeUndefined();
  });

  it("proves an expired, never-included creation again under the same identity", async () => {
    const store = walletStore();
    const proofs: string[] = [];
    const first = await create(creationNode(), store, adapter("mempool", []), proofs);
    const metadata = { name: "Asset", symbol: "AST", decimals: 0, contentDigest: new Uint8Array(32) };
    const reprove = (node: PcashNodeClient, overrides: { initialSupply?: bigint } = {}) => runAssetCreationClient({
      node, store, wallet: profile, signer: privateKeyPcashActionSigner(privateKey), chainId: fixtureNetwork.pcashChainId,
      metadata, initialSupply: overrides.initialSupply ?? 10n, assetId: first.assetId,
      prover: { proveAndEncode: async (build) => {
        proofs.push("reproof");
        return encodePrivateValueTransaction({ publicInputs: build.publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData: build.outputData, arena: build.arena });
      } },
      submission: adapter("mempool", []), settlePollMaxAttempts: 1, settlePollIntervalMs: 0,
    });
    await expect(reprove(creationNode())).rejects.toThrow(/still pending/);
    // Reconciliation releases a creation whose deadline finalized without inclusion.
    await store.transaction((data) => {
      removePendingAssetAction(data!, first.contentHash);
      removeMempoolOutboxEntry(data!, first.contentHash);
      removePendingNotesForTransaction(data!, first.contentHash);
      return { data: data!, value: undefined };
    });
    await expect(reprove(creationNode(), { initialSupply: 11n })).rejects.toThrow(/differs from the reviewed terms/);
    const markerNode = (spent: boolean) => Object.assign(creationNode(), {
      getWitnessSnapshot: async (query: { nullifiers: string[] }) =>
        ({ status, nullifiers: { statuses: query.nullifiers.map((nullifier) => ({ nullifier, spent })) } }),
    });
    await expect(reprove(markerNode(true))).rejects.toThrow(/already created/);
    const again = await reprove(markerNode(false));
    expect(again.assetId).toBe(first.assetId);
    expect(again.contentHash).not.toBe(first.contentHash);
    expect(again.definition).toEqual(first.definition);
    expect(proofs).toEqual(["proof", "reproof"]);
    expect(store.snapshot()?.assets).toHaveLength(1);
  });

  it("retries exact asset creation bytes without regenerating an asset or proof", async () => {
    const node = creationNode();
    const store = walletStore();
    const proofs: string[] = [];
    const first = await create(node, store, adapter("mempool", []), proofs);
    const saved = store.snapshot()?.pendingAssetActions?.[0];
    expect(saved?.contentHash).toBe(first.contentHash);
    const metadata = { name: "Asset", symbol: "AST", decimals: 0, contentDigest: new Uint8Array(32) };
    const retry = {
      node, store, wallet: profile, signer: privateKeyPcashActionSigner(privateKey), chainId: fixtureNetwork.pcashChainId,
      metadata, initialSupply: 10n, retryContentHash: first.contentHash,
      prover: { proveAndEncode: async () => { throw new Error("retry must not prove again"); } },
      submission: adapter("mempool", []), settlePollMaxAttempts: 1, settlePollIntervalMs: 0,
    };
    const resumed = await runAssetCreationClient(retry);
    expect(resumed.contentHash).toBe(first.contentHash);
    expect(resumed.transactionHex).toBe(first.transactionHex);
    expect(proofs).toEqual(["proof"]);
    expect(store.snapshot()?.pendingAssetActions?.[0]?.transactionHex).toBe(first.transactionHex);
    await expect(runAssetCreationClient({ ...retry, metadata: { ...metadata, symbol: "NEW" } }))
      .rejects.toThrow(/differs from the reviewed terms/);
    await expect(runAssetCreationClient({ ...retry, initialSupply: 11n }))
      .rejects.toThrow(/differs from the reviewed terms/);
    await expect(runAssetCreationClient({ ...retry, openFeeAmount: 1n }))
      .rejects.toThrow(/differs from the reviewed terms/);
    await expect(runAssetCreationClient({ ...retry, submission: adapter("l1", []) }))
      .rejects.toThrow(/another publication mode/);
  });
});
