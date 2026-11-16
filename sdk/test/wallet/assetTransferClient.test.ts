import * as localChain from "../../src/wallet/actions/localChain.ts";
import { applicationSchemaId } from "../../src/protocol/records.ts";
import { orderedRecords, recordValue } from "../recordHelpers.ts";
import { storedReceiveKeyPair } from "../../src/wallet/receiveKeyring.ts";
import { describe, expect, it, vi } from "vitest";
import type { AssetActionBuild } from "@pcash/sdk/builders";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { buildExtendedCode, storeTransactionData } from "@pcash/sdk/delivery";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import {
  assetDefinitionSchema,
  buildContractBody,
  functionSelector,
  assetDefinitionAssetId,
  decodePayload,
  decryptEnvelope,
  generateMlKemKeyPair,
  type MlKemKeyPair,
  fullOutputCommitment,
  WIRE_PROOF_BYTES,
  type AssetDefinition,
} from "@pcash/sdk/protocol";
import { fieldToHex } from "@pcash/sdk/crypto";
import { addressHex, bytes32Hex } from "@pcash/sdk/utils";
import { runAssetTransferClient, type AssetTransferIntent } from "../../src/wallet/actions/assetTransferClient.ts";
import type { DurableSubmissionAdapter } from "../../src/wallet/actions/durableSubmission.ts";
import { synchronizeWalletInventory } from "../../src/wallet/actions/scan.ts";
import { derivePcashProfileFromPrivateKey } from "../../src/wallet/externalIdentity.ts";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import { addWalletAsset, storedAssetDefinition, type WalletFileData } from "../../src/wallet/noteStore.ts";
import { emptyWalletState } from "../../src/wallet/store.ts";
import { anchoredChain, ChainSim } from "./chainFixture.ts";
import { testStatus } from "./statusFixture.ts";
import { deliveredOutput, senderRegionOf } from "./deliveryHelpers.ts";

const network = { pcashChainId: 8182n, l1ChainId: 11155111n, inboxAddress: `0x${"66".repeat(20)}` };
const key = new Uint8Array(32).fill(19);
const wallet = derivePcashProfileFromPrivateKey(key, network);
const signer = privateKeyPcashActionSigner(key);
const code = buildExtendedCode({ address: wallet.address, chainId: network.pcashChainId, mlKemPublicKey: wallet.mlKemPublicKey });
const definition: AssetDefinition = {
  initialSupply: 1_000n,
  assetSecretCommitment: 0x72n,
  metadata: { name: "Transfer Token", symbol: "XFR", decimals: 2, contentDigest: new Uint8Array(32).fill(9) },
};
const assetId = assetDefinitionAssetId(definition);
const payee = { address: 0x5050n, keys: generateMlKemKeyPair(new Uint8Array(64).fill(41)) };
const payeeCode = buildExtendedCode({ address: payee.address, chainId: network.pcashChainId, mlKemPublicKey: payee.keys.publicKey });

function fixture(notes: { assetId: bigint; amount: bigint }[], options: {
  receiveKey?: MlKemKeyPair | null;
  ownsReceiveKey?: boolean;
  beforeSign?: () => Promise<void>;
  beforeProve?: () => Promise<void>;
} = {}) {
  const registered = options.receiveKey === undefined
    ? { publicKey: wallet.mlKemPublicKey, secretKey: wallet.mlKemSecretKey } : options.receiveKey;
  const data: WalletFileData = { address: addressHex(wallet.address), network: { chainId: "8182", genesisHash: `0x${"11".repeat(32)}` },
    receiveKeys: [storedReceiveKeyPair({ publicKey: wallet.mlKemPublicKey, secretKey: wallet.mlKemSecretKey })], notes: notes.map(({ amount, assetId }, index) => ({ leafIndex: String(index), outputIndex: 0,
      assetId: bytes32Hex(assetId), amount: amount.toString(), owner: addressHex(wallet.address),
      noteSecret: bytes32Hex(BigInt(index + 100)), commitment: bytes32Hex(fullOutputCommitment({
        owner: wallet.address, noteSecret: BigInt(index + 100), amount, assetId }, index)), spent: false, pending: false })) };
  if (options.receiveKey && options.ownsReceiveKey !== false) data.receiveKeys.push(storedReceiveKeyPair(options.receiveKey));
  addWalletAsset(data, { assetId, definition });
  const rules = defaultUserAccountRuleSet({ wallet, network, secrets: wallet.defaultUserRuleSecrets });
  const store = memoryWalletStateStore(data, anchoredChain({
    outputs: data.notes.map((note) => ({ leaf: BigInt(note.commitment!), mark: true })),
    accounts: [{ address: addressHex(wallet.address), nullifierKeyCommitment: wallet.nullifierKeyCommitment,
      accountRuleSetCommitment: rules.accountRuleSetCommitment, receiveKey: registered?.publicKey ?? null }],
  }).records);
  const status = testStatus({ pcashChainId: Number(network.pcashChainId), genesisHash: data.network.genesisHash, l1ChainId: network.l1ChainId, inboxAddress: network.inboxAddress });
  const node = {
    status: async () => status,
    getReceipt: async () => [], getMempoolTransaction: async () => null,
    estimateFee: async () => ({ tiers: { low: 2n, standard: 3n, fast: 4n } }),
  } as unknown as PcashNodeClient;
  const proofs: { build: AssetActionBuild; packageName: string }[] = [];
  const prover = { shapes: [0] as const, proveAndEncode: async (build: AssetActionBuild, authorization: { packageName: string }) => {
    proofs.push({ build, packageName: authorization.packageName });
    await options.beforeProve?.();
    return build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES));
  } };
  const entries: Uint8Array[] = [];
  const submission = { mode: "mempool" as const, preflight: async () => null,
    submit: async ({ transactionBytes: entry }: { transactionBytes: Uint8Array }) => {
      entries.push(entry);
      return { accepted: false, queued: true, output: null };
    } };
  const run = (intent: Pick<AssetTransferIntent, "outputs" | "burnAmount" | "retryContentHash" | "data" | "accountCreation"> & { submission?: DurableSubmissionAdapter<null, null> }) => runAssetTransferClient({
    assetId, openFeeAmount: 3n, node, store, wallet,
    signer: { address: signer.address, signTypedData: async request => {
      await options.beforeSign?.();
      return signer.signTypedData(request);
    } }, chainId: network.pcashChainId, prover, submission, ...intent,
  });
  return { store, run, proofs, entries };
}

/** The note at `slot` the wallet's own key opens, with any delivered asset definition. */
const delivered = (build: AssetActionBuild, slot: number) => {
  const output = deliveredOutput(build, network.pcashChainId, wallet.mlKemSecretKey, slot);
  return output === null ? null : {
    ...output.note,
    ...(recordValue(output.records, assetDefinitionSchema) === undefined ? {} : { assetDefinition: recordValue(output.records, assetDefinitionSchema) }),
  };
};

/** A new device's wallet restored from the recovery root alone through a chain holding only `entry`. */
async function restore(entry: Uint8Array): Promise<WalletFileData> {
  const sim = new ChainSim(network.pcashChainId, network);
  sim.include(entry);
  const data = emptyWalletState({ address: wallet.address, network: { chainId: network.pcashChainId, genesisHash: sim.genesisHash } });
  await synchronizeWalletInventory(sim.client(), wallet, network.pcashChainId, data, {
    store: memoryWalletStateStore(data), target: { pcashNumber: sim.head.number, pcashHash: fieldToHex(sim.head.hash).toLowerCase() },
  });
  return data;
}

describe("asset transfer client", () => {
  it("encrypts a bare-address self payment and both changes to the rotated key", async () => {
    const rotated = generateMlKemKeyPair(new Uint8Array(64).fill(31));
    const f = fixture([{ assetId, amount: 100n }, { assetId: 0n, amount: 10n }], { receiveKey: rotated });
    await f.run({ outputs: [{ to: addressHex(wallet.address), amount: 40n }] });
    const { build } = f.proofs[0]!;
    for (const slot of [0, 1, 2]) {
      expect(decryptEnvelope(wallet.mlKemSecretKey, build.outputData[slot]!)).toBeNull();
      expect(decodePayload(decryptEnvelope(rotated.secretKey, build.outputData[slot]!)!, { chainId: network.pcashChainId }).amount)
        .toBe([40n, 60n, 7n][slot]);
    }
  });

  it("preserves an explicit self code while automatic change uses the rotated key", async () => {
    const rotated = generateMlKemKeyPair(new Uint8Array(64).fill(32));
    const f = fixture([{ assetId, amount: 100n }, { assetId: 0n, amount: 10n }], { receiveKey: rotated });
    await f.run({ outputs: [{ to: code, amount: 40n }] });
    const { build } = f.proofs[0]!;
    expect(delivered(build, 0)?.amount).toBe(40n);
    expect(decryptEnvelope(rotated.secretKey, build.outputData[0]!)).toBeNull();
    expect(decryptEnvelope(wallet.mlKemSecretKey, build.outputData[1]!)).toBeNull();
    expect(decryptEnvelope(rotated.secretKey, build.outputData[1]!)).not.toBeNull();
  });

  it("records an explicit opening in its sender region under the outgoing key, whatever its receive key", async () => {
    const rotated = generateMlKemKeyPair(new Uint8Array(64).fill(33));
    const f = fixture([{ assetId, amount: 100n }, { assetId: 0n, amount: 10n }], { receiveKey: rotated });
    await f.run({ outputs: [{ to: code, amount: 40n, noteSecret: 123n }] });
    const { build } = f.proofs[0]!;
    for (const key of [wallet.mlKemSecretKey, rotated.secretKey]) expect(decryptEnvelope(key, build.outputData[0]!)).toBeNull();
    expect(senderRegionOf(build, network.pcashChainId, wallet.outgoingKey)?.sentOpenings)
      .toEqual([{ slot: 0, recipientAddress: wallet.address, assetId, amount: 40n, noteSecret: 123n }]);
  });

  it.each(["cleared", "unowned"] as const)("refuses %s self-change before proving", async mode => {
    const f = fixture([{ assetId, amount: 100n }, { assetId: 0n, amount: 10n }], {
      receiveKey: mode === "cleared" ? null : generateMlKemKeyPair(new Uint8Array(64).fill(34)), ownsReceiveKey: false,
    });
    await expect(f.run({ outputs: [{ to: code, amount: 40n }] })).rejects.toThrow(/registered receive key/);
    expect(f.proofs).toHaveLength(0);
  });

  it("allows a cleared-key burn that produces no encrypted self output", async () => {
    const f = fixture([{ assetId, amount: 100n }, { assetId: 0n, amount: 3n }], { receiveKey: null });
    await f.run({ outputs: [], burnAmount: 100n });
    expect(f.proofs).toHaveLength(1);
  });

  it("retains an explicit token opening and the caller's sender records in its sender region", async () => {
    const f = fixture([{ assetId, amount: 100n }, { assetId: 0n, amount: 10n }]);
    const senderRecords = [{ schema: applicationSchemaId("com.example.record009"), data: new TextEncoder().encode("offer terms") }, { schema: applicationSchemaId("com.example.record012"), data: Uint8Array.of(7) }];
    const outputs = [{ to: code, amount: 40n, noteSecret: 123n }];
    const first = await f.run({ outputs, data: { self: senderRecords } });
    const { build } = f.proofs[0]!;
    expect(decryptEnvelope(wallet.mlKemSecretKey, build.outputData[0]!)).toBeNull();
    expect(senderRegionOf(build, network.pcashChainId, wallet.outgoingKey)).toEqual({
      sentEnvelopes: [],
      sentOpenings: [{ slot: 0, recipientAddress: wallet.address, assetId, amount: 40n, noteSecret: 123n }],
      directSendOpenings: [],
      records: orderedRecords([...senderRecords, assetDefinitionSchema.encode(definition)]),
    });
    await f.run({ outputs, data: { self: senderRecords }, retryContentHash: first.contentHash });
    expect(f.proofs).toHaveLength(1);
    await expect(f.run({ outputs, data: { self: senderRecords.slice(0, 1) }, retryContentHash: first.contentHash })).rejects.toThrow(/reviewed terms/);
    await expect(f.run({ outputs, retryContentHash: first.contentHash })).rejects.toThrow(/reviewed terms/);
  });

  it.each(["lookup", "signer", "prover"] as const)("journals the data sealed before deferred %s", async stage => {
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = { promise: new Promise<void>(resolve => { enteredResolve = resolve; }), resolve: () => enteredResolve() };
    const release = { promise: new Promise<void>(resolve => { releaseResolve = resolve; }), resolve: () => releaseResolve() };
    const pause = async () => { entered.resolve(); await release.promise; };
    const f = fixture([{ assetId, amount: 100n }, { assetId: 0n, amount: 10n }], {
      ...(stage === "signer" ? { beforeSign: pause } : {}),
      ...(stage === "prover" ? { beforeProve: pause } : {}),
    });
    const schema = applicationSchemaId("com.example.snapshot");
    const data = { recipients: [{ to: addressHex(wallet.address), records: [{ schema, data: Uint8Array.of(0x41) }] }],
      self: [{ schema, data: Uint8Array.of(0x53) }] };
    const original = structuredClone(data);
    const outputs = [{ to: code, amount: 40n }];
    const snapshotOf = localChain.localWitnessSnapshot;
    const lookup = stage === "lookup" ? vi.spyOn(localChain, "localWitnessSnapshot").mockImplementation(async (...args) => {
      const snapshot = await snapshotOf(...args);
      return { ...snapshot, receiveKeyOf: async (address: string) => { await pause(); return snapshot.receiveKeyOf(address); } };
    }) : undefined;
    try {
      const operation = f.run({ outputs, data });
      await entered.promise;
      data.recipients[0]!.records[0]!.data[0] = 0x42;
      data.self[0]!.data[0] = 0x54;
      data.recipients[0]!.records.push({ schema: applicationSchemaId("com.example.extra"), data: Uint8Array.of(1) });
      release.resolve();
      const first = await operation;
      const { build } = f.proofs[0]!;
      expect(deliveredOutput(build, network.pcashChainId, wallet.mlKemSecretKey, 0)?.records?.find(record => record.schema === schema)?.data)
        .toEqual(Uint8Array.of(0x41));
      expect(senderRegionOf(build, network.pcashChainId, wallet.outgoingKey)?.records.find(record => record.schema === schema)?.data)
        .toEqual(Uint8Array.of(0x53));
      expect(f.store.snapshot()?.pendingAssetActions?.[0]?.assetTransferReview?.data).toEqual(storeTransactionData(original));
      await expect(f.run({ outputs, data, retryContentHash: first.contentHash })).rejects.toThrow(/reviewed terms/);
      const retry = await f.run({ outputs, data: original, retryContentHash: first.contentHash });
      expect(retry.transactionHex).toBe(first.transactionHex);
      expect(f.proofs).toHaveLength(1);
    } finally {
      release.resolve();
      lookup?.mockRestore();
    }
  });

  it("pays one recipient under the asset-payment rule and writes the definition for the payee and the sender, not on change", async () => {
    const f = fixture([{ assetId, amount: 100n }, { assetId: 0n, amount: 10n }]);
    const result = await f.run({ outputs: [{ to: payeeCode, amount: 40n }] });
    expect(result.assetId).toBe(assetId);
    const { build, packageName } = f.proofs[0]!;
    expect(packageName).toBe("account_rule_asset_payment_ecdsa");
    expect(build.outputAmounts.slice(0, 3)).toEqual([40n, 60n, 7n]);
    const paid = deliveredOutput(build, network.pcashChainId, payee.keys.secretKey, 0)!;
    expect(paid.note).toMatchObject({ assetId, amount: 40n, owner: payee.address });
    expect(paid.records).toEqual([assetDefinitionSchema.encode(definition)]);
    // Change names no recipient region at all.
    for (const [slot, changeAssetId, amount] of [[1, assetId, 60n], [2, 0n, 7n]] as const) {
      const change = decodePayload(decryptEnvelope(wallet.mlKemSecretKey, build.outputData[slot]!)!, { chainId: network.pcashChainId });
      expect(change).toMatchObject({ assetId: changeAssetId, amount });
      expect(change).not.toHaveProperty("anchor");
    }
    expect(recordValue(senderRegionOf(build, network.pcashChainId, wallet.outgoingKey)?.records, assetDefinitionSchema)).toEqual(definition);
    expect(f.store.snapshot()?.pendingAssetActions?.[0]?.ownedOutputs).toMatchObject([
      { outputIndex: 1, amount: "60" }, { outputIndex: 2, amount: "7" },
    ]);
  });

  it("burns under the asset-burn rule, keeping the definition in the sender region only", async () => {
    const f = fixture([{ assetId, amount: 100n }, { assetId: 0n, amount: 3n }]);
    await f.run({ outputs: [], burnAmount: 25n });
    const { build, packageName } = f.proofs[0]!;
    expect(packageName).toBe("account_rule_asset_burn_ecdsa");
    expect(build.assetBurnAmount).toBe(25n);
    expect(delivered(build, 0)).toMatchObject({ assetId, amount: 75n });
    expect(delivered(build, 0)).not.toHaveProperty("anchor");
    expect(recordValue(senderRegionOf(build, network.pcashChainId, wallet.outgoingKey)?.records, assetDefinitionSchema)).toEqual(definition);
  });

  it.each([
    ["a payment", { outputs: [{ to: payeeCode, amount: 40n }] }, 1],
    ["a burn that leaves only change", { outputs: [], burnAmount: 25n }, 0],
  ] as const)("restores the definition of %s into an empty asset store", async (_name, intent, paid) => {
    const f = fixture([{ assetId, amount: 100n }, { assetId: 0n, amount: 10n }]);
    await f.run({ ...intent, outputs: [...intent.outputs] });
    const data = await restore(f.entries[0]!);
    expect(data.notes.filter((note) => BigInt(note.assetId) === assetId)).toHaveLength(1);
    expect(data.sentOutputs ?? []).toHaveLength(paid);
    expect(data.assets?.map((asset) => [BigInt(asset.assetId), storedAssetDefinition(asset)])).toEqual([[assetId, definition]]);
  });

  it("pays several recipients as a batch and opens an explicit note secret without an envelope", async () => {
    const f = fixture([{ assetId, amount: 100n }, { assetId: 0n, amount: 3n }]);
    await f.run({ outputs: [{ to: code, amount: 10n }, { to: addressHex(wallet.address), amount: 90n, noteSecret: 0x77n }] });
    const { build, packageName } = f.proofs[0]!;
    expect(packageName).toBe("account_rule_batch_transfer_ecdsa");
    expect(build.outputNoteSecrets[1]).toBe(0x77n);
    expect(build.outputAmounts[1]).toBe(90n);
    expect(delivered(build, 1)).toBeNull();
  });

  it("matches an attached token payment from its retained bytes", async () => {
    const f = fixture([{ assetId, amount: 100n }, { assetId: 0n, amount: 10n }]);
    const body = (nkRoot: bigint) => buildContractBody({ nullifierKey: { publishesNkRoot: true, nkRoot },
      functions: [{ selector: functionSelector(0), applicationVkHash: 71n, configurationCommitment: 81n }] }).body;
    const accountCreation = { kind: "contract" as const, body: body(51n) };
    const outputs = [{ to: code, amount: 40n }];
    const first = await f.run({ outputs, accountCreation });
    const retry = await f.run({ outputs, accountCreation: { ...accountCreation, body: accountCreation.body.slice() }, retryContentHash: first.contentHash });
    expect(retry.transactionHex).toBe(first.transactionHex);
    expect(f.proofs).toHaveLength(1);
    await expect(f.run({ outputs, retryContentHash: first.contentHash })).rejects.toThrow(/reviewed terms/);
    await expect(f.run({ outputs, accountCreation: { kind: "contract", body: body(52n) }, retryContentHash: first.contentHash })).rejects.toThrow(/reviewed terms/);
  });

  it("resumes the exact journaled bytes by retryContentHash and refuses different terms", async () => {
    const f = fixture([{ assetId, amount: 100n }, { assetId: 0n, amount: 10n }]);
    const outputs = [{ to: code, amount: 10n }, { to: addressHex(wallet.address), amount: 20n, noteSecret: 0x77n }];
    const first = await f.run({ outputs });
    const resumed = await f.run({ outputs, retryContentHash: first.contentHash });
    expect(resumed).toMatchObject({ contentHash: first.contentHash, transactionHex: first.transactionHex, retried: true });
    expect(f.proofs).toHaveLength(1);
    expect(f.entries).toHaveLength(2);
    expect(f.entries[1]).toEqual(f.entries[0]);
    for (const changed of [
      [{ ...outputs[0]!, amount: 11n }, outputs[1]!],
      [outputs[0]!, { ...outputs[1]!, noteSecret: 0x78n }],
      [outputs[0]!],
    ]) {
      await expect(f.run({ outputs: changed, retryContentHash: first.contentHash })).rejects.toThrow(/differs from the reviewed terms/);
    }
    await expect(f.run({ outputs, burnAmount: 1n, retryContentHash: first.contentHash })).rejects.toThrow(/differs from the reviewed terms/);
    await expect(f.run({ outputs, retryContentHash: first.contentHash, submission: { mode: "l1", preflight: async () => null, submit: async () => ({ accepted: false, queued: true, output: null }) } }))
      .rejects.toThrow(/another publication mode/);
    await expect(f.run({ outputs, retryContentHash: `0x${"ee".repeat(32)}` })).rejects.toThrow(/does not name a journaled asset payment or burn/);
    expect(f.proofs).toHaveLength(1);
  });

  it("refuses more recipients than one action carries", async () => {
    const f = fixture([{ assetId, amount: 100n }]);
    await expect(f.run({ outputs: Array.from({ length: 6 }, () => ({ to: code, amount: 1n })) }))
      .rejects.toThrow(/at most 5 recipients/);
    expect(f.proofs).toHaveLength(0);
  });
});
