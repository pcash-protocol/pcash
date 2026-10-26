import { applicationDataRecords, recordValue } from "../recordHelpers.ts";
import { storedReceiveKeyPair } from "../../src/wallet/receiveKeyring.ts";
import { describe, expect, it } from "vitest";
import { BULK_RECOVERY_MAX_APP_TAG_BYTES, BULK_RECOVERY_OBSERVATION_SECONDS, bulkRecoveryRecord, bulkRecoverySchema, createBulkJob, freshBulkJobRecovery, planNextBulkChunk, reconcileBulkRecoveryObservations, recoveredBulkGroups } from "../../src/wallet/bulkJobs.ts";
import { runBulkJobStep, startBulkJob } from "../../src/wallet/actions/bulkJobClient.ts";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import { derivePcashProfileFromPrivateKey } from "../../src/wallet/externalIdentity.ts";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import {
  encodeRecords,
  buildContractBody,
  functionSelector,
  decodeTransaction,
  assetDefinitionSchema,
  sentOpeningsSchema,
  sentEnvelopesSchema,
  transactionIdentity as submissionIdentity,
  receiveKeyHash,
  generateMlKemKeyPair,
  type MlKemKeyPair,
  accountStateCommitment,
  assetDefinitionAssetId,
  controlledIssuanceOpening,
  decryptEnvelope,
  type AssetDefinition,
  fullOutputCommitment,
  WIRE_PROOF_BYTES,
  noteBodyCommitment,
  ownerCommitment,
  planArena,
  SlotClass,
} from "@pcash/sdk/protocol";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { fieldToHex, SparseMerkleTree } from "@pcash/sdk/crypto";
import { createSelectedRelayQuote, privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import { buildExtendedCode } from "@pcash/sdk/delivery";
import { addressHex, bytes32Hex, fromHex, toHex } from "@pcash/sdk/utils";
import type { PcashNodeClient, ReceiptResult } from "@pcash/sdk/clients";
import { addWalletAsset, type WalletFileData } from "../../src/wallet/noteStore.ts";
import { synchronizeWalletInventory } from "../../src/wallet/actions/scan.ts";
import { emptyWalletState } from "../../src/wallet/store.ts";
import { syntheticRecentBlockFixture } from "./builderTestHelpers.ts";
import { testStatus } from "./statusFixture.ts";
import { anchoredChain, ChainSim, chainRecords, consumedIn, syncStoreTo } from "./chainFixture.ts";
import type { NullifierConsumption } from "../../src/wallet/chainState.ts";
import { DurablePreBroadcastError } from "../../src/wallet/actions/durableSubmission.ts";
import { deliveredOutput, senderRegionOf } from "./deliveryHelpers.ts";
import { paddedPrivateValueByteSize } from "../../src/wallet/actions/publication.ts";

const network = { pcashChainId: 8182n, l1ChainId: 11155111n, inboxAddress: `0x${"66".repeat(20)}` };
const key = new Uint8Array(32).fill(17);
const wallet = derivePcashProfileFromPrivateKey(key, network);
const signer = privateKeyPcashActionSigner(key);
const code = buildExtendedCode({ address: wallet.address, chainId: network.pcashChainId, mlKemPublicKey: wallet.mlKemPublicKey });

function inventory(amounts: bigint[], assetId = 0n, nativeAmounts: bigint[] = []): WalletFileData {
  const notes = [...amounts.map(amount => ({ amount, assetId })), ...nativeAmounts.map(amount => ({ amount, assetId: 0n }))];
  return { address: addressHex(wallet.address), network: { chainId: "8182", genesisHash: `0x${"11".repeat(32)}` },
    receiveKeys: [storedReceiveKeyPair({ publicKey: wallet.mlKemPublicKey, secretKey: wallet.mlKemSecretKey })], notes: notes.map(({ amount, assetId }, index) => ({ leafIndex: String(index), outputIndex: 0,
      assetId: bytes32Hex(assetId), amount: amount.toString(), owner: addressHex(wallet.address),
      noteSecret: bytes32Hex(BigInt(index + 100)), commitment: bytes32Hex(fullOutputCommitment({
        owner: wallet.address, noteSecret: BigInt(index + 100), amount, assetId }, index)), spent: false, pending: false })) };
}
const fees = (amount: string) => ({ 0: amount, 1: amount });
const payment = (count: number, shape?: 0 | 1) => createBulkJob({ kind: "payment", recipients: Array.from({ length: count }, () => ({ to: code, amount: 1n })),
  openFeeAmount: 0n, maxTransactions: 100, ...(shape === undefined ? {} : { shape }) });

describe("profile-aware bulk allocation", () => {
  it("uses S when it fits and permits a deliberate L", () => {
    expect(planNextBulkChunk(inventory([5n]), payment(4))).toMatchObject({ shape: 0, recipientCount: 4, change: [{ amount: 1n }] });
    expect(planNextBulkChunk(inventory([5n]), payment(4, 1))).toMatchObject({ shape: 1, recipientCount: 4 });
  });
  it("reserves Small's final output for a selected private relay fee", () => {
    const selected = { fundingFeeAmount: 1n, reservedOutputs: 1 };
    expect(planNextBulkChunk(inventory([5n]), payment(4), selected)).toMatchObject({
      shape: 0, recipientCount: 4, change: [],
    });
    expect(planNextBulkChunk(inventory([6n]), payment(4, 0), selected)).toMatchObject({
      shape: 0, recipientCount: 3, change: [{ amount: 2n }],
    });
  });
  it("plans only shapes the executing prover supports", () => {
    expect(planNextBulkChunk(inventory([32n]), payment(64), { shapes: [0] })).toMatchObject({ shape: 0, recipientCount: 4, change: [{ amount: 28n }] });
    expect(planNextBulkChunk(inventory([32n]), payment(4, 1), { shapes: [0] })).toBeNull();
  });
  it("fits 32 exact-funded recipients, or 31 plus change", () => {
    expect(planNextBulkChunk(inventory([32n]), payment(64))).toMatchObject({ shape: 1, recipientCount: 32, change: [] });
    expect(planNextBulkChunk(inventory([100n]), payment(64))).toMatchObject({ shape: 1, recipientCount: 31, change: [{ amount: 69n }] });
  });
  it("reserves both custom and native change slots", () => {
    const data = inventory([100n], 99n);
    data.notes.push({ ...inventory([100n]).notes[0]!, leafIndex: "1", commitment: bytes32Hex(1234n) });
    const job = { ...payment(64), assetId: "99", openFeeAmounts: fees("1") };
    expect(planNextBulkChunk(data, job)).toMatchObject({ shape: 1, recipientCount: 30, inputs: [{ assetId: bytes32Hex(99n) }, { assetId: bytes32Hex(0n) }],
      change: [{ assetId: 99n, amount: 70n }, { assetId: 0n, amount: 99n }] });
  });
  it.each([
    { profile: "S", shape: 0, units: 4, larger: 3n, inputCount: 3 },
    { profile: "L", shape: 1, units: 32, larger: 10n, inputCount: 24 },
  ])("reserves native fee capacity before consolidating asset dust in $profile", ({ shape, units, larger, inputCount }) => {
    const data = inventory([...Array<bigint>(units).fill(1n), larger], 99n, [1n]);
    const job = createBulkJob({ kind: "payment", assetId: 99n, recipients: [{ to: code, amount: BigInt(units) }],
      openFeeAmount: 1n, maxTransactions: 1 });
    const plan = planNextBulkChunk(data, job);
    expect(plan).toMatchObject({ shape, firstRecipient: 0, recipientCount: 1, change: [] });
    expect(plan!.inputs).toHaveLength(inputCount);
    expect(plan!.inputs.filter(note => BigInt(note.assetId) === 99n).reduce((total, note) => total + BigInt(note.amount), 0n)).toBe(BigInt(units));
    expect(plan!.inputs.filter(note => BigInt(note.assetId) === 0n)).toMatchObject([{ amount: "1" }]);
  });
  it.each([
    { nativeAmounts: [1n, 1n], openFeeAmount: 2n, inputCount: 4 },
    { nativeAmounts: [1n, 1n, 1n, 1n, 4n], openFeeAmount: 4n, inputCount: 3 },
  ])("reserves the minimum fee capacity for $nativeAmounts", ({ nativeAmounts, openFeeAmount, inputCount }) => {
    const data = inventory([1n, 1n, 1n, 1n, 3n], 99n, nativeAmounts);
    const job = createBulkJob({ kind: "payment", assetId: 99n, recipients: [{ to: code, amount: 4n }],
      openFeeAmount, maxTransactions: 1 });
    const plan = planNextBulkChunk(data, job);
    expect(plan).toMatchObject({ shape: 0, recipientCount: 1, change: [] });
    expect(plan!.inputs).toHaveLength(inputCount);
    expect(plan!.inputs.filter(note => BigInt(note.assetId) === 0n).reduce((total, note) => total + BigInt(note.amount), 0n)).toBe(openFeeAmount);
  });
  it("does not reserve fee inputs for a zero-fee custom-asset payment", () => {
    expect(planNextBulkChunk(inventory([1n, 1n, 1n, 1n], 99n), { ...payment(4), assetId: "99" }))
      .toMatchObject({ shape: 0, recipientCount: 4, change: [] });
  });
  it.each([
    { reason: "insufficient asset value", assets: [31n], native: [1n], openFeeAmount: 1n },
    { reason: "insufficient native value", assets: [32n], native: [1n], openFeeAmount: 2n },
    { reason: "missing native notes", assets: [32n], native: [], openFeeAmount: 1n },
    { reason: "insufficient combined input capacity", assets: Array<bigint>(32).fill(1n), native: [1n], openFeeAmount: 1n },
  ])("returns no plan for $reason", ({ assets, native, openFeeAmount }) => {
    const job = createBulkJob({ kind: "payment", assetId: 99n, recipients: [{ to: code, amount: 32n }],
      openFeeAmount, maxTransactions: 1 });
    expect(planNextBulkChunk(inventory(assets, 99n, native), job)).toBeNull();
  });
  it("does not count pending outputs, reserved notes or future rewards as funding", () => {
    const data = inventory([100n]);
    data.notes[0]!.pending = true;
    expect(planNextBulkChunk(data, payment(1))).toBeNull();
    expect(planNextBulkChunk(inventory([1n]), { ...payment(2), openFeeAmounts: fees("1") })).toBeNull();
  });
  it("bounds consolidation, splits amounts and requires a net inventory reduction", () => {
    const maximum = (1n << 128n) - 1n;
    const job = createBulkJob({ kind: "consolidation", maxTransactions: 10, openFeeAmount: 1n });
    expect(planNextBulkChunk(inventory(Array(32).fill(100n)), job)).toMatchObject({ shape: 1, change: [{ amount: 3199n }] });
    expect(planNextBulkChunk(inventory(Array(32).fill(maximum / 16n)), job)?.change).toHaveLength(2);
    expect(planNextBulkChunk(inventory(Array(32).fill(maximum)), job)).toBeNull();
    expect(planNextBulkChunk(inventory([100n, 100n]), { ...job, targetNotes: 1 }, { issuanceNote: true })).toBeNull();
  });
  it.each([0, 16, 32])("funds native consolidation with the large note at inventory index %s", largeIndex => {
    const amounts = Array<bigint>(32).fill(1n);
    amounts.splice(largeIndex, 0, 100n);
    const data = inventory(amounts);
    const originalNotes = [...data.notes];
    const job = createBulkJob({ kind: "consolidation", openFeeAmount: 33n, targetNotes: 4, maxTransactions: 1 });
    const plan = planNextBulkChunk(data, job);
    expect(plan).toMatchObject({ shape: 1, recipientCount: 0, change: [{ assetId: 0n, amount: 98n }] });
    expect(plan!.inputs).toHaveLength(32);
    expect(plan!.inputs.filter(note => note.amount === "100")).toHaveLength(1);
    expect(new Set(plan!.inputs.map(note => note.commitment)).size).toBe(32);
    expect(amounts.length - plan!.inputs.length + plan!.change.length).toBeLessThanOrEqual(job.targetNotes);
    expect(data.notes).toEqual(originalNotes);
  });
  it.each([
    { profile: "S", shape: 0 as const, units: 4, openFeeAmount: 5n, largeAmount: 10n, change: 8n },
    { profile: "L", shape: 1 as const, units: 32, openFeeAmount: 35n, largeAmount: 3n, change: 1n },
    { profile: "L at exact fee coverage", shape: 1 as const, units: 32, openFeeAmount: 34n, largeAmount: 3n, change: 2n },
  ])("replaces enough native dust to cover the fee with a positive output in $profile", ({ shape, units, openFeeAmount, largeAmount, change }) => {
    const amounts = [...Array<bigint>(units).fill(1n), largeAmount, largeAmount];
    const job = createBulkJob({ kind: "consolidation", shape, openFeeAmount, targetNotes: 1, maxTransactions: 1 });
    const plan = planNextBulkChunk(inventory(amounts), job);
    expect(plan).toMatchObject({ shape, change: [{ assetId: 0n, amount: change }] });
    expect(plan!.inputs).toHaveLength(units);
    expect(new Set(plan!.inputs.map(note => note.commitment)).size).toBe(units);
  });
  it.each([0, 16, 31])("reserves one fee input with the fee-sized native note at index %s", feeIndex => {
    const native = Array<bigint>(31).fill(1n);
    native.splice(feeIndex, 0, 31n);
    const job = createBulkJob({ kind: "consolidation", assetId: 99n, openFeeAmount: 31n, targetNotes: 4, maxTransactions: 1 });
    const plan = planNextBulkChunk(inventory(Array<bigint>(32).fill(1n), 99n, native), job);
    expect(plan).toMatchObject({ shape: 1, change: [{ assetId: 99n, amount: 31n }] });
    const assetInputs = plan!.inputs.filter(note => BigInt(note.assetId) === 99n);
    expect(assetInputs).toHaveLength(31);
    expect(plan!.inputs.filter(note => BigInt(note.assetId) === 0n)).toMatchObject([{ amount: "31" }]);
    expect(32 - assetInputs.length + plan!.change.filter(note => note.assetId === 99n).length).toBe(2);
  });
  it.each([
    { native: [2n, 2n, 2n], openFeeAmount: 3n, assetInputs: 30, nativeInputs: 2, nativeChange: 1n },
    { native: [], openFeeAmount: 0n, assetInputs: 32, nativeInputs: 0, nativeChange: 0n },
  ])("budgets custom consolidation fee funding for $native", ({ native, openFeeAmount, assetInputs, nativeInputs, nativeChange }) => {
    const job = createBulkJob({ kind: "consolidation", assetId: 99n, openFeeAmount, targetNotes: 4, maxTransactions: 1 });
    const plan = planNextBulkChunk(inventory(Array<bigint>(32).fill(1n), 99n, native), job)!;
    expect(plan.shape).toBe(1);
    expect(plan.inputs.filter(note => BigInt(note.assetId) === 99n)).toHaveLength(assetInputs);
    expect(plan.inputs.filter(note => BigInt(note.assetId) === 0n)).toHaveLength(nativeInputs);
    expect(plan.change).toEqual([{ assetId: 99n, amount: BigInt(assetInputs) },
      ...(nativeChange > 0n ? [{ assetId: 0n, amount: nativeChange }] : [])]);
  });
  it("does not spend native fees when only the native inventory would shrink", () => {
    const maximum = (1n << 128n) - 1n;
    const job = createBulkJob({ kind: "consolidation", assetId: 99n, openFeeAmount: 3n, targetNotes: 4, maxTransactions: 1 });
    expect(planNextBulkChunk(inventory(Array<bigint>(5).fill(maximum), 99n, [1n, 1n, 1n]), job)).toBeNull();
  });
  it("prefers target-asset dust and uses S when L gives no more target progress", () => {
    const maximum = (1n << 128n) - 1n;
    const job = createBulkJob({ kind: "consolidation", assetId: 99n, openFeeAmount: 1n, targetNotes: 4, maxTransactions: 1 });
    const plan = planNextBulkChunk(inventory([maximum, maximum, 1n, 1n, 1n], 99n, [1n]), job);
    expect(plan).toMatchObject({ shape: 0, change: [{ assetId: 99n, amount: 3n }] });
    expect(plan!.inputs.filter(note => BigInt(note.assetId) === 99n)).toHaveLength(3);
  });
  it.each([
    { reason: "fee consumes the full bounded native selection", assets: Array<bigint>(33).fill(1n), assetId: 0n, native: [], openFeeAmount: 32n },
    { reason: "native value is insufficient", assets: Array<bigint>(32).fill(1n), assetId: 0n, native: [], openFeeAmount: 33n },
    { reason: "custom-asset fee is unfunded", assets: Array<bigint>(32).fill(1n), assetId: 99n, native: [30n], openFeeAmount: 31n },
    { reason: "fee exhausts input capacity", assets: Array<bigint>(32).fill(1n), assetId: 99n, native: Array<bigint>(32).fill(1n), openFeeAmount: 32n },
  ])("does not consolidate when $reason", ({ assets, assetId, native, openFeeAmount }) => {
    const job = createBulkJob({ kind: "consolidation", assetId, openFeeAmount, targetNotes: 4, maxTransactions: 1 });
    expect(planNextBulkChunk(inventory(assets, assetId, native), job)).toBeNull();
  });
  it("does not use a pending fee-covering note or consolidate an already-reached target", () => {
    const data = inventory([...Array<bigint>(32).fill(1n), 100n]);
    data.notes[32]!.pending = true;
    const job = createBulkJob({ kind: "consolidation", openFeeAmount: 33n, targetNotes: 4, maxTransactions: 1 });
    expect(planNextBulkChunk(data, job)).toBeNull();
    expect(planNextBulkChunk(inventory([100n, 100n, 100n, 100n]), { ...job, openFeeAmounts: fees("0") })).toBeNull();
  });
  it("reserves an issuance note only for a self-published chunk", () => {
    const job = createBulkJob({ kind: "consolidation", openFeeAmount: 1n, targetNotes: 1, maxTransactions: 1 });
    expect(planNextBulkChunk(inventory([100n, 100n, 100n]), job)).toMatchObject({ shape: 0, change: [{ amount: 299n }] });
    expect(planNextBulkChunk(inventory([100n, 100n]), job)).toMatchObject({ shape: 0, change: [{ amount: 199n }] });
    expect(planNextBulkChunk(inventory([100n, 100n]), job, { issuanceNote: true })).toBeNull();
    expect(planNextBulkChunk(inventory([100n, 100n, 100n]), job, { issuanceNote: true })).toMatchObject({ change: [{ amount: 299n }] });
  });
  it("never coalesces or reorders duplicate recipient instructions", () => {
    const job = payment(3);
    expect(job.recipients.map(item => item.to)).toEqual([code, code, code]);
    expect(() => createBulkJob({ kind: "payment", maxTransactions: 1, openFeeAmount: 0n, recipients: [{ to: code, amount: 1n << 128n }] })).toThrow("uint128");
  });
  it("keeps an explicit zero note secret on a recipient", () => {
    const job = createBulkJob({ kind: "payment", maxTransactions: 1, openFeeAmount: 0n, recipients: [{ to: code, amount: 1n, noteSecret: 0n }] });
    expect(job.recipients[0]!.noteSecret).toBe(fieldToHex(0n));
  });
});

function fixture(amounts: bigint[] = [100n, 100n], assetId = 0n, nativeAmounts: bigint[] = [],
  standardFee: (byteSize: bigint) => bigint = () => 3n) {
  const data = inventory(amounts, assetId, nativeAmounts);
  const tree = new SparseMerkleTree(40);
  for (const note of data.notes) tree.setLeaf(Number(note.leafIndex), BigInt(note.commitment!));
  const rules = defaultUserAccountRuleSet({ wallet, network, secrets: wallet.defaultUserRuleSecrets });
  const accounts = new SparseMerkleTree(40);
  accounts.setLeaf(0, accountStateCommitment(wallet.address, wallet.nullifierKeyCommitment, rules.accountRuleSetCommitment, 0n, 1n, receiveKeyHash(wallet.mlKemPublicKey)));
  const recent = syntheticRecentBlockFixture({ outputRoot: tree.root, outputCount: data.notes.length, accountStateRoot: accounts.root, accountCount: 1 });
  const chain = (consumed: readonly (readonly [string, NullifierConsumption])[] = []) => chainRecords({
    anchor: recent.boundary, consumed,
    outputs: data.notes.map(note => ({ leaf: BigInt(note.commitment!), mark: true })),
    accounts: [{ address: addressHex(wallet.address), nullifierKeyCommitment: wallet.nullifierKeyCommitment,
      accountRuleSetCommitment: rules.accountRuleSetCommitment, receiveKey: wallet.mlKemPublicKey }],
  });
  const store = memoryWalletStateStore(data, chain());
  const status = testStatus({ pcashChainId: Number(network.pcashChainId), genesisHash: data.network.genesisHash, l1ChainId: network.l1ChainId, inboxAddress: network.inboxAddress });
  const node = {
    status: async () => status,
    getReceipt: async () => [], getMempoolTransaction: async () => null,
    estimateFee: async ({ byteSize }: { byteSize: bigint }) => ({ tiers: { low: 2n, standard: standardFee(byteSize), fast: 4n } }),
  } as unknown as PcashNodeClient;
  let proofs = 0;
  const builds: import("@pcash/sdk/builders").AssetActionBuild[] = [];
  const prover = { shapes: [0, 1] as const, proveAndEncode: async (build: import("@pcash/sdk/builders").AssetActionBuild) => {
    proofs++;
    builds.push(build);
    return build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES));
  } };
  const setReceiveKey = async (pair: MlKemKeyPair | null) => {
    await store.transaction(current => {
      if (pair !== null) current!.receiveKeys.push(storedReceiveKeyPair(pair));
      return { data: current!, value: undefined };
    });
    await syncStoreTo(store, anchoredChain({
      outputs: data.notes.map(note => ({ leaf: BigInt(note.commitment!), mark: true })),
      accounts: [{ address: addressHex(wallet.address), nullifierKeyCommitment: wallet.nullifierKeyCommitment,
        accountRuleSetCommitment: rules.accountRuleSetCommitment, accountRevision: 2, receiveKey: pair?.publicKey ?? null }],
    }).records);
  };
  return { store, node, prover, status, chain, boundary: recent.boundary, proofs: () => proofs, builds, setReceiveKey };
}

describe("bulk account creation attachments", () => {
  it("retains the body in every independent chunk and exact retry", async () => {
    const f = fixture([100n, 100n]);
    const contract = buildContractBody({ nullifierKey: { publishesNkRoot: true, nkRoot: 71n },
      functions: [{ selector: functionSelector(0), applicationVkHash: 72n, configurationCommitment: 73n }] });
    const accountCreation = { kind: "contract" as const, body: contract.body };
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment", shape: 0,
      accountCreation, recipients: Array.from({ length: 6 }, (_, i) => ({ to: addressHex(contract.address), amount: 1n, noteSecret: BigInt(i + 1) })),
      openFeeAmount: 0n, maxTransactions: 2 });
    const entries: Uint8Array[] = [];
    const submission = { mode: "mempool" as const, preflight: async () => null,
      submit: async ({ transactionBytes }: { transactionBytes: Uint8Array }) => {
        entries.push(transactionBytes); return { accepted: false, queued: true, output: null };
      } };
    const params = { ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId, submission };
    await runBulkJobStep(params);
    await runBulkJobStep({ ...params, chunkIndex: 1 });
    await runBulkJobStep({ ...params, chunkIndex: 0 });
    expect(f.proofs()).toBe(2);
    expect(entries[2]).toEqual(entries[0]);
    for (const entry of entries) {
      const decoded = decodeTransaction(entry);
      expect(decoded.kind).toBe(0);
      if (decoded.kind !== 0) throw new Error("expected a value transaction");
      expect(decoded.accountCreation).toEqual(accountCreation);
    }
    expect((await f.store.load())!.bulkJobs![0]!.accountCreation).toEqual({ kind: "contract", body: toHex(contract.body) });
  });
});

describe("bulk job self delivery", () => {
  it("refreshes a later bare-address self chunk after rotation while preserving journaled bytes after CLEAR", async () => {
    const f = fixture([100n, 100n]);
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment", shape: 0,
      recipients: Array.from({ length: 6 }, () => ({ to: addressHex(wallet.address), amount: 1n })),
      openFeeAmount: 0n, maxTransactions: 2 });
    const entries: Uint8Array[] = [];
    const submission = { mode: "mempool" as const, preflight: async () => null,
      submit: async ({ transactionBytes }: { transactionBytes: Uint8Array }) => {
        entries.push(transactionBytes);
        return { accepted: false, queued: true, output: null };
      } };
    const params = { ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId, submission };
    await runBulkJobStep(params);
    expect(decryptEnvelope(wallet.mlKemSecretKey, f.builds[0]!.outputData[0]!)).not.toBeNull();
    const rotated = generateMlKemKeyPair(new Uint8Array(64).fill(51));
    await f.setReceiveKey(rotated);
    await runBulkJobStep({ ...params, chunkIndex: 1 });
    for (const slot of [0, 1, 2]) {
      expect(decryptEnvelope(wallet.mlKemSecretKey, f.builds[1]!.outputData[slot]!)).toBeNull();
      expect(decryptEnvelope(rotated.secretKey, f.builds[1]!.outputData[slot]!)).not.toBeNull();
    }
    await f.setReceiveKey(null);
    await runBulkJobStep({ ...params, chunkIndex: 0 });
    expect(entries[2]).toEqual(entries[0]);
    expect(f.proofs()).toBe(2);
  });

  it("keeps an explicitly supplied self code when a job builds after rotation", async () => {
    const f = fixture([100n]);
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment",
      recipients: [{ to: code, amount: 1n }], openFeeAmount: 0n, maxTransactions: 1 });
    const rotated = generateMlKemKeyPair(new Uint8Array(64).fill(52));
    await f.setReceiveKey(rotated);
    await runBulkJobStep({ ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId,
      submission: { mode: "mempool", preflight: async () => null,
        submit: async () => ({ accepted: false, queued: true, output: null }) } });
    expect(decryptEnvelope(wallet.mlKemSecretKey, f.builds[0]!.outputData[0]!)).not.toBeNull();
    expect(decryptEnvelope(rotated.secretKey, f.builds[0]!.outputData[0]!)).toBeNull();
    expect(decryptEnvelope(wallet.mlKemSecretKey, f.builds[0]!.outputData[1]!)).toBeNull();
    expect(decryptEnvelope(rotated.secretKey, f.builds[0]!.outputData[1]!)).not.toBeNull();
  });

  it("seals a bare-address recipient's output to the key in the chunk's snapshot, not the key at approval", async () => {
    const f = fixture([100n]);
    const rules = defaultUserAccountRuleSet({ wallet, network, secrets: wallet.defaultUserRuleSecrets });
    const outputs = (await f.store.load())!.notes.map(note => ({ leaf: BigInt(note.commitment!), mark: true }));
    const self = { address: addressHex(wallet.address), nullifierKeyCommitment: wallet.nullifierKeyCommitment,
      accountRuleSetCommitment: rules.accountRuleSetCommitment, receiveKey: wallet.mlKemPublicKey };
    const bob = `0x${"77".repeat(20)}`;
    const approved = generateMlKemKeyPair(new Uint8Array(64).fill(53));
    const current = generateMlKemKeyPair(new Uint8Array(64).fill(54));
    const bobRow = (receiveKey: Uint8Array, accountRevision: number) =>
      ({ address: bob, nullifierKeyCommitment: 5n, accountRuleSetCommitment: 9n, accountRevision, receiveKey });
    await syncStoreTo(f.store, anchoredChain({ outputs, accounts: [self, bobRow(approved.publicKey, 1)] }).records);
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment",
      recipients: [{ to: bob, amount: 1n }], openFeeAmount: 0n, maxTransactions: 1 });
    await syncStoreTo(f.store, anchoredChain({ outputs, accounts: [self, bobRow(current.publicKey, 2)], blockNumber: 2n }).records);
    await runBulkJobStep({ ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId,
      submission: { mode: "mempool", preflight: async () => null,
        submit: async () => ({ accepted: false, queued: true, output: null }) } });
    expect(decryptEnvelope(current.secretKey, f.builds[0]!.outputData[0]!)).not.toBeNull();
    expect(decryptEnvelope(approved.secretKey, f.builds[0]!.outputData[0]!)).toBeNull();
  });

  it("refuses a chunk whose recipient commits a rotated key the feed did not deliver", async () => {
    const f = fixture([100n]);
    const rules = defaultUserAccountRuleSet({ wallet, network, secrets: wallet.defaultUserRuleSecrets });
    const outputs = (await f.store.load())!.notes.map(note => ({ leaf: BigInt(note.commitment!), mark: true }));
    const self = { address: addressHex(wallet.address), nullifierKeyCommitment: wallet.nullifierKeyCommitment,
      accountRuleSetCommitment: rules.accountRuleSetCommitment, receiveKey: wallet.mlKemPublicKey };
    const bob = `0x${"79".repeat(20)}`;
    const approved = generateMlKemKeyPair(new Uint8Array(64).fill(56));
    const rotated = generateMlKemKeyPair(new Uint8Array(64).fill(57));
    const bobRow = (receiveKey: Uint8Array, accountRevision: number) =>
      ({ address: bob, nullifierKeyCommitment: 5n, accountRuleSetCommitment: 9n, accountRevision, receiveKey });
    await syncStoreTo(f.store, anchoredChain({ outputs, accounts: [self, bobRow(approved.publicKey, 1)] }).records);
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment",
      recipients: [{ to: bob, amount: 1n }], openFeeAmount: 0n, maxTransactions: 1 });
    // The anchored account commits the rotated key's digest, but its bytes were withheld.
    await syncStoreTo(f.store, anchoredChain({ outputs, accounts: [self, bobRow(rotated.publicKey, 2)], blockNumber: 2n,
      withheldKeys: [bob] }).records);
    await expect(runBulkJobStep({ ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId,
      submission: { mode: "mempool", preflight: async () => null,
        submit: async () => ({ accepted: false, queued: true, output: null }) } })).rejects.toThrow(/was not synced/);
    expect(f.builds).toHaveLength(0);
  });

  it("keeps the approved key for a bare-address recipient that has since cleared its key", async () => {
    const f = fixture([100n]);
    const rules = defaultUserAccountRuleSet({ wallet, network, secrets: wallet.defaultUserRuleSecrets });
    const outputs = (await f.store.load())!.notes.map(note => ({ leaf: BigInt(note.commitment!), mark: true }));
    const self = { address: addressHex(wallet.address), nullifierKeyCommitment: wallet.nullifierKeyCommitment,
      accountRuleSetCommitment: rules.accountRuleSetCommitment, receiveKey: wallet.mlKemPublicKey };
    const bob = `0x${"78".repeat(20)}`;
    const approved = generateMlKemKeyPair(new Uint8Array(64).fill(55));
    const bobRow = (receiveKey: Uint8Array | null, accountRevision: number) =>
      ({ address: bob, nullifierKeyCommitment: 5n, accountRuleSetCommitment: 9n, accountRevision, receiveKey });
    await syncStoreTo(f.store, anchoredChain({ outputs, accounts: [self, bobRow(approved.publicKey, 1)] }).records);
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment",
      recipients: [{ to: bob, amount: 1n }], openFeeAmount: 0n, maxTransactions: 1 });
    await syncStoreTo(f.store, anchoredChain({ outputs, accounts: [self, bobRow(null, 2)], blockNumber: 2n }).records);
    await runBulkJobStep({ ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId,
      submission: { mode: "mempool", preflight: async () => null,
        submit: async () => ({ accepted: false, queued: true, output: null }) } });
    expect(decryptEnvelope(approved.secretKey, f.builds[0]!.outputData[0]!)).not.toBeNull();
  });

  it("writes its chunk record and every recipient to the sender region", async () => {
    const f = fixture([100n]);
    const appTag = new Uint8Array(BULK_RECOVERY_MAX_APP_TAG_BYTES).fill(7);
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment", shape: 0,
      recipients: Array.from({ length: 5 }, () => ({ to: code, amount: 1n })), openFeeAmount: 0n,
      maxTransactions: 5, recovery: { appTag } });
    await runBulkJobStep({ ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId,
      submission: { mode: "mempool", preflight: async () => null,
        submit: async () => ({ accepted: false, queued: true, output: null }) } });

    const saved = (await f.store.load())!.bulkJobs![0]!;
    expect(saved.chunks[0]).toMatchObject({ shape: 0, firstRecipient: 0, recipientCount: 4 });
    expect(saved.recovery).toMatchObject({ originalRecipientCount: 5, originalIndexes: [0, 1, 2, 3, 4] });
    const region = senderRegionOf(f.builds[0]!, network.pcashChainId, wallet.outgoingKey)!;
    expect(region.sentEnvelopes.map(({ slot, recipientAddress }) => ({ slot, recipientAddress }))).toEqual(
      [0, 1, 2, 3].map(slot => ({ slot, recipientAddress: wallet.address })));
    expect(region.sentOpenings).toEqual([]);
    expect(applicationDataRecords(region.records ?? [])).toHaveLength(1);
    const record = applicationDataRecords(region.records ?? [])[0]!;
    expect(record.schema).toBe(bulkRecoverySchema.id);
    // Job ID (32) ‖ digest (32) ‖ count 5 (1) ‖ tag length 255 (2) ‖ tag ‖ index count (1) ‖ four indexes below 128 (1 each).
    expect(record.data).toHaveLength(32 + 32 + 1 + 2 + 255 + 1 + 4);
    expect(bulkRecoverySchema.decode(record.data)).toEqual({
      recoveryJobId: fromHex(saved.recovery!.recoveryJobId), manifestDigest: fromHex(saved.recovery!.manifestDigest),
      originalRecipientCount: 5, appTag, originalIndexes: [0, 1, 2, 3],
    });
  });

  it("delivers a maximal token definition to recoverable recipients and its sender region", async () => {
    const definition: AssetDefinition = {
      initialSupply: 100n,
      assetSecretCommitment: 0xa3n,
      metadata: { name: "N".repeat(64), symbol: "S".repeat(12), decimals: 18, contentDigest: new Uint8Array(32).fill(9) },
    };
    const assetId = assetDefinitionAssetId(definition);
    const f = fixture([100n], assetId);
    await f.store.transaction(data => {
      addWalletAsset(data!, { assetId, definition });
      return { data: data!, value: undefined };
    });
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment", assetId, shape: 0,
      recipients: Array.from({ length: 4 }, () => ({ to: code, amount: 1n })), openFeeAmount: 0n,
      maxTransactions: 4, recovery: { appTag: new Uint8Array(BULK_RECOVERY_MAX_APP_TAG_BYTES).fill(7) } });
    await runBulkJobStep({ ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId,
      submission: { mode: "mempool", preflight: async () => null,
        submit: async () => ({ accepted: false, queued: true, output: null }) } });
    // The token change takes the fifth slot.
    expect((await f.store.load())!.bulkJobs![0]!.chunks[0]).toMatchObject({ recipientCount: 4 });
    const region = senderRegionOf(f.builds[0]!, network.pcashChainId, wallet.outgoingKey)!;
    expect(region.sentEnvelopes.map(({ slot }) => slot)).toEqual([0, 1, 2, 3]);
    expect(recordValue(region.records, assetDefinitionSchema)).toEqual(definition);
    expect(applicationDataRecords(region.records ?? [])?.map(({ schema }) => schema)).toEqual([bulkRecoverySchema.id]);
    for (const slot of [0, 1, 2, 3]) {
      expect(recordValue(deliveredOutput(f.builds[0]!, network.pcashChainId, wallet.mlKemSecretKey, slot)?.records, assetDefinitionSchema)).toEqual(definition);
    }
    // The wallet's own change carries no copy; the sender region holds the wallet's.
    const change = deliveredOutput(f.builds[0]!, network.pcashChainId, wallet.mlKemSecretKey, 4)!;
    expect(change.note.assetId).toBe(assetId);
    expect(recordValue(change.records, assetDefinitionSchema)).toBeUndefined();
  });

  it("fits the fullest S and L chunk with the longest tag in the arena", () => {
    const definition: AssetDefinition = {
      initialSupply: 100n,
      assetSecretCommitment: 0xa4n,
      metadata: { name: "N".repeat(64), symbol: "S".repeat(12), decimals: 18, contentDigest: new Uint8Array(32).fill(9) },
    };
    for (const profile of [PRIVATE_VALUE_PROFILES.S, PRIVATE_VALUE_PROFILES.L]) {
      const slots = Array.from({ length: profile.outputs }, (_, slot) => slot);
      const recovery = freshBulkJobRecovery({ appTag: new Uint8Array(BULK_RECOVERY_MAX_APP_TAG_BYTES).fill(1),
        manifestDigest: bytes32Hex(1n), originalRecipientCount: 10_000, originalIndexes: slots.map(slot => 9_999 - slot) });
      const applicationRecords = [bulkRecoveryRecord(recovery, 0, slots.length)];
      // A count of 10,000 and the tag length take 2 bytes each, as does every index from 9,999 down past 128.
      expect(applicationRecords[0]!.data).toHaveLength(32 + 32 + 2 + 2 + BULK_RECOVERY_MAX_APP_TAG_BYTES + 1 + 2 * profile.outputs);
      // Every slot pays a recipient: opened out of band, or by envelope with its own copy of the definition in its region.
      const openings = (encodeRecords([...applicationRecords, assetDefinitionSchema.encode(definition), sentOpeningsSchema.encode(slots.map(slot => ({ slot, recipientAddress: 1n, assetId: 1n, amount: (1n << 128n) - 1n, noteSecret: 1n })))]).length);
      const envelopes = (encodeRecords([...applicationRecords, assetDefinitionSchema.encode(definition), sentEnvelopesSchema.encode(slots.map(slot => ({ slot, sharedSecret: new Uint8Array(32), recipientAddress: 1n })))]).length);
      expect(planArena({ shape: profile.shapeId, sender: openings, regions: [] }).fits).toBe(true);
      expect(planArena({ shape: profile.shapeId, sender: envelopes,
        regions: slots.map(() => encodeRecords([assetDefinitionSchema.encode(definition)]).length) }).fits).toBe(true);
    }
  });
});

describe("bulk recovery", () => {
  it("continues expired and unallocated recipients under the same lineage exactly once", async () => {
    const f = fixture([100n, 100n]);
    const appTag = new TextEncoder().encode("distribution");
    const recipients = Array.from({ length: 5 }, (_, index) => ({ to: code, amount: BigInt(index + 1) }));
    const source = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment", shape: 0,
      recipients, openFeeAmount: 0n, maxTransactions: 5, recovery: { appTag } });
    const submission = { mode: "mempool" as const, preflight: async () => null,
      submit: async () => ({ accepted: false, queued: true, output: null }) };
    const step = { ...f, jobId: source.jobId, wallet, signer, chainId: network.pcashChainId, submission };
    await runBulkJobStep(step);
    await f.store.transaction(data => {
      data!.bulkJobs![0]!.chunks[0]!.outcome = "expired";
      delete data!.pendingAssetActions;
      return { data: data!, value: undefined };
    });

    const continueJob = () => startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment", shape: 0,
      recipients, openFeeAmount: 0n, maxTransactions: 5,
      recovery: { appTag, continueLocalJobId: source.jobId } });
    await expect(startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment", shape: 0,
      recipients: recipients.map((recipient, index) => index === 4 ? { ...recipient, amount: 99n } : recipient),
      openFeeAmount: 0n, maxTransactions: 5,
      recovery: { appTag, continueLocalJobId: source.jobId } })).rejects.toThrow(/repairable positions/);
    const replacement = await continueJob();
    expect(replacement.recovery).toMatchObject({
      recoveryJobId: source.recovery!.recoveryJobId,
      manifestDigest: source.recovery!.manifestDigest,
      originalRecipientCount: 5,
      originalIndexes: [0, 1, 2, 3, 4],
      baselineContentHashes: [],
    });
    const saved = (await f.store.load())!.bulkJobs!;
    expect(saved.find(job => job.jobId === source.jobId)!.recovery?.supersededByJobId).toBe(replacement.jobId);
    await expect(continueJob()).rejects.toThrow(/already continued/);
    await expect(runBulkJobStep(step)).resolves.toMatchObject({ state: "needs-review" });
  });

  it("blocks a local continuation while an unresolved chunk is not canonical", async () => {
    const f = fixture([100n]);
    const appTag = new TextEncoder().encode("distribution");
    const recipients = Array.from({ length: 3 }, (_, index) => ({ to: code, amount: BigInt(index + 1) }));
    const source = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment", shape: 0,
      recipients, openFeeAmount: 0n, maxTransactions: 3, recovery: { appTag } });
    await runBulkJobStep({ ...f, jobId: source.jobId, wallet, signer, chainId: network.pcashChainId,
      submission: { mode: "mempool", preflight: async () => null,
        submit: async () => ({ accepted: false, queued: true, output: null }) } });
    await expect(startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment", shape: 0,
      recipients, openFeeAmount: 0n, maxTransactions: 3,
      recovery: { appTag, continueLocalJobId: source.jobId } })).rejects.toThrow(/unresolved noncanonical/);
  });

  it("preserves an original index through repeated subset repairs", async () => {
    const f = fixture([100n]);
    const template = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment", shape: 0,
      recipients: [{ to: code, amount: 4n }], openFeeAmount: 0n, maxTransactions: 1 });
    await runBulkJobStep({ ...f, jobId: template.jobId, wallet, signer, chainId: network.pcashChainId,
      submission: { mode: "mempool", preflight: async () => null,
        submit: async () => ({ accepted: false, queued: true, output: null }) } });
    const action = (await f.store.load())!.bulkJobs![0]!.chunks[0]!.action;
    const appTag = new TextEncoder().encode("distribution");
    const lineage = {
      recoveryJobId: bytes32Hex(0x730n), appTag: toHex(appTag), manifestDigest: bytes32Hex(0x731n),
      originalRecipientCount: 4, originalIndexes: [3],
    };
    const source = createBulkJob({ kind: "payment", shape: 0, recipients: [{ to: code, amount: 4n }],
      openFeeAmount: 0n, maxTransactions: 1, recovery: lineage });
    source.recipients[0]!.delivery = { address: wallet.address.toString(), receiveKey: toHex(wallet.mlKemPublicKey) };
    source.chunks.push({ shape: 0, firstRecipient: 0, recipientCount: 1, action, outcome: "expired" });
    await f.store.transaction(data => {
      data!.bulkJobs = [source];
      delete data!.pendingAssetActions;
      return { data: data!, value: undefined };
    });
    const continueJob = (jobId: string) => startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment", shape: 0,
      recipients: [{ to: code, amount: 4n }], openFeeAmount: 0n, maxTransactions: 1,
      recovery: { appTag, continueLocalJobId: jobId } });

    const first = await continueJob(source.jobId);
    expect(first.recovery?.originalIndexes).toEqual([3]);
    await f.store.transaction(data => {
      const saved = data!.bulkJobs!.find(job => job.jobId === first.jobId)!;
      saved.chunks.push({ shape: 0, firstRecipient: 0, recipientCount: 1, action, outcome: "expired" });
      return { data: data!, value: undefined };
    });
    const second = await continueJob(first.jobId);
    expect(second.recovery).toMatchObject({ recoveryJobId: lineage.recoveryJobId, originalRecipientCount: 4, originalIndexes: [3] });
  });

  it("invalidates a local repair when a canonical baseline chunk is reorganized away", async () => {
    const f = fixture([100n]);
    const appTag = new TextEncoder().encode("distribution");
    const lineage = {
      recoveryJobId: bytes32Hex(0x740n), appTag: toHex(appTag), manifestDigest: bytes32Hex(0x741n),
      originalRecipientCount: 2,
    };
    const source = createBulkJob({ kind: "payment", shape: 0, recipients: [{ to: code, amount: 2n }],
      openFeeAmount: 0n, maxTransactions: 1, recovery: { ...lineage, originalIndexes: [1] } });
    source.recipients[0]!.delivery = { address: wallet.address.toString(), receiveKey: toHex(wallet.mlKemPublicKey) };
    const contentHash = bytes32Hex(0x742n);
    const record = bulkRecoveryRecord({ ...lineage, originalIndexes: [0] }, 0, 1);
    await f.store.transaction(data => {
      data!.bulkJobs = [source];
      data!.sentOutputs = [{
        transactionId: bytes32Hex(0x743n), contentHash, privateValueShape: 0, slot: 0, leafIndex: "20",
        recipientAddress: addressHex(wallet.address), assetId: "0x0", amount: "1", noteSecret: bytes32Hex(0x744n),
        senderIncluded: false, senderRecords: [{ schema: record.schema, data: toHex(record.data) }],
        blockNumber: "10", blockHash: bytes32Hex(0x745n), blockTimestamp: "100",
      }];
      reconcileBulkRecoveryObservations(data!, 100n, 100n);
      return { data: data!, value: undefined };
    });
    const replacement = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment", shape: 0,
      recipients: [{ to: code, amount: 2n }], openFeeAmount: 0n, maxTransactions: 1,
      recovery: { appTag, continueLocalJobId: source.jobId } });
    expect(replacement.recovery).toMatchObject({ originalIndexes: [1], baselineContentHashes: [contentHash] });

    await f.store.transaction(data => {
      delete data!.sentOutputs;
      reconcileBulkRecoveryObservations(data!, 200n, 200n);
      return { data: data!, value: undefined };
    });
    const saved = (await f.store.load())!.bulkJobs!;
    expect(saved.find(job => job.jobId === replacement.jobId)!.recovery?.invalidated).toBe(true);
    expect(saved.find(job => job.jobId === source.jobId)!.recovery?.supersededByJobId).toBe(replacement.jobId);
    await expect(runBulkJobStep({ ...f, jobId: replacement.jobId, wallet, signer, chainId: network.pcashChainId,
      submission: { mode: "mempool", preflight: async () => null,
        submit: async () => ({ accepted: false, queued: true, output: null }) } })).resolves.toMatchObject({ state: "needs-review" });
  });

  it("groups canonical chunk rows and resumes only unpaid original indexes after the observation hold", async () => {
    const source = fixture([100n]);
    const recipients = Array.from({ length: 3 }, (_, index) => ({ to: code, amount: BigInt(index + 1) }));
    const original = await startBulkJob({ ...source, wallet, chainId: network.pcashChainId, kind: "payment", shape: 0,
      recipients, openFeeAmount: 0n, maxTransactions: 3, recovery: { appTag: new TextEncoder().encode("distribution") } });
    const recovery = (await source.store.load())!.bulkJobs![0]!.recovery!;
    const duplicate = await startBulkJob({ ...source, wallet, chainId: network.pcashChainId, kind: "payment", shape: 0,
      recipients, openFeeAmount: 0n, maxTransactions: 3, recovery: { appTag: new TextEncoder().encode("distribution") } });
    expect(duplicate.recovery!.manifestDigest).toBe(recovery.manifestDigest);
    expect(duplicate.recovery!.recoveryJobId).not.toBe(recovery.recoveryJobId);
    const record = bulkRecoveryRecord(recovery, 0, 2);
    const contentHash = bytes32Hex(0x700n), transactionId = bytes32Hex(0x701n);
    const restored = fixture([100n]);
    await restored.store.transaction(data => {
      data!.sentOutputs = [0, 1].map(slot => ({
        transactionId, contentHash, privateValueShape: 0, slot, leafIndex: String(20 + slot),
        recipientAddress: addressHex(wallet.address), assetId: "0x0", amount: String(slot + 1),
        noteSecret: bytes32Hex(BigInt(900 + slot)), senderIncluded: false, senderRecords: [{ schema: record.schema, data: toHex(record.data) }],
        blockNumber: "10", blockHash: bytes32Hex(0x702n), blockTimestamp: "100",
      }));
      // The canonical head can be newer than the derived-output cursor. The hold starts at the head upper bound.
      reconcileBulkRecoveryObservations(data!, 500n, 100n);
      return { data: data!, value: undefined };
    });
    expect(recoveredBulkGroups((await restored.store.load())!.sentOutputs!)[0]).toMatchObject({
      recoveryJobId: recovery.recoveryJobId, paidOriginalIndexes: [0, 1],
      chunks: [{ contentHash, recipients: [{ originalIndex: 0, amount: "1" }, { originalIndex: 1, amount: "2" }] }],
    });
    const resume = () => startBulkJob({ ...restored, wallet, chainId: network.pcashChainId, kind: "payment", shape: 0,
      recipients, openFeeAmount: 0n, maxTransactions: 3,
      recovery: { appTag: new TextEncoder().encode("distribution"), resumeRecoveryJobId: recovery.recoveryJobId } });
    await expect(resume()).rejects.toThrow(/observing possible in-flight chunks/);
    await restored.store.transaction(data => {
      reconcileBulkRecoveryObservations(data!, 2_300n, 2_300n);
      return { data: data!, value: undefined };
    });
    await expect(resume()).rejects.toThrow(/observing possible in-flight chunks/);
    await restored.store.transaction(data => {
      reconcileBulkRecoveryObservations(data!, 2_301n, 2_301n);
      return { data: data!, value: undefined };
    });
    const resumed = await resume();
    expect(resumed.recipients).toMatchObject([{ amount: "3" }]);
    expect(resumed.recovery).toMatchObject({ recoveryJobId: recovery.recoveryJobId, originalRecipientCount: 3, originalIndexes: [2] });
    expect(resumed.jobId).not.toBe(original.jobId);
    await restored.store.transaction(data => {
      delete data!.sentOutputs;
      reconcileBulkRecoveryObservations(data!, 3_000n, 3_000n);
      return { data: data!, value: undefined };
    });
    expect((await restored.store.load())!.bulkJobs!.find(job => job.jobId === resumed.jobId)!.recovery?.invalidated).toBe(true);
    await expect(resume()).rejects.toThrow(/observing possible in-flight chunks/);
    await restored.store.transaction(data => {
      reconcileBulkRecoveryObservations(data!, 4_801n, 4_801n);
      return { data: data!, value: undefined };
    });
    const restarted = await resume();
    expect(restarted.recovery).toMatchObject({ recoveryJobId: recovery.recoveryJobId, originalIndexes: [0, 1, 2] });
  });

  it.each([
    { name: "S", shape: 0 as const, total: 6, chunk: 4 },
    { name: "L", shape: 1 as const, total: 40, chunk: 31 },
  ])("recovers a full $name chunk from the chain alone and resumes only its unpaid recipients", async ({ shape, total, chunk }) => {
    const f = fixture([10_000n]);
    const appTag = new Uint8Array(BULK_RECOVERY_MAX_APP_TAG_BYTES).fill(7);
    const recipients = Array.from({ length: total }, (_, index) => ({ to: code, amount: BigInt(index + 1) }));
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment", shape,
      recipients, openFeeAmount: 0n, maxTransactions: total, recovery: { appTag } });
    const entries: Uint8Array[] = [];
    await runBulkJobStep({ ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId,
      submission: { mode: "mempool", preflight: async () => null,
        submit: async ({ transactionBytes }: { transactionBytes: Uint8Array }) => {
          entries.push(transactionBytes);
          return { accepted: false, queued: true, output: null };
        } } });
    // Every recipient slot but the change.
    expect((await f.store.load())!.bulkJobs![0]!.chunks[0]).toMatchObject({ shape, firstRecipient: 0, recipientCount: chunk });

    // Every local store is lost; a fresh wallet scans the chain that includes the chunk.
    const sim = new ChainSim(network.pcashChainId, { l1ChainId: network.l1ChainId, inboxAddress: network.inboxAddress });
    sim.include(entries[0]!);
    const scanned = emptyWalletState({ address: wallet.address, network: { chainId: network.pcashChainId, genesisHash: sim.genesisHash } });
    await synchronizeWalletInventory(sim.client(), wallet, network.pcashChainId, scanned, { store: memoryWalletStateStore(scanned),
      target: { pcashNumber: sim.head.number, pcashHash: fieldToHex(sim.head.hash).toLowerCase() } });
    const groups = recoveredBulkGroups(scanned.sentOutputs ?? []);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ recoveryJobId: job.recovery!.recoveryJobId, manifestDigest: job.recovery!.manifestDigest,
      appTag, originalRecipientCount: total, paidOriginalIndexes: recipients.slice(0, chunk).map((_, index) => index) });
    expect(groups[0]!.chunks.map(({ shape, recipients: paid }) => ({ shape, amounts: paid.map(recipient => recipient.amount) })))
      .toEqual([{ shape, amounts: recipients.slice(0, chunk).map(recipient => recipient.amount.toString()) }]);

    const restored = fixture([10_000n]);
    await restored.store.transaction(data => {
      data!.sentOutputs = scanned.sentOutputs!;
      reconcileBulkRecoveryObservations(data!, 100n, 100n);
      reconcileBulkRecoveryObservations(data!, 101n + BULK_RECOVERY_OBSERVATION_SECONDS, 101n + BULK_RECOVERY_OBSERVATION_SECONDS);
      return { data: data!, value: undefined };
    });
    const resumed = await startBulkJob({ ...restored, wallet, chainId: network.pcashChainId, kind: "payment", shape,
      recipients, openFeeAmount: 0n, maxTransactions: total,
      recovery: { appTag, resumeRecoveryJobId: job.recovery!.recoveryJobId } });
    expect(resumed.recipients.map(recipient => recipient.amount)).toEqual(recipients.slice(chunk).map(recipient => recipient.amount.toString()));
    expect(resumed.recovery).toMatchObject({ recoveryJobId: job.recovery!.recoveryJobId, originalRecipientCount: total,
      originalIndexes: recipients.slice(chunk).map((_, offset) => chunk + offset), baselineContentHashes: [groups[0]!.chunks[0]!.contentHash] });
  });

  it("resets the hold when another canonical chunk appears", async () => {
    const data = inventory([100n]);
    const recovery = {
      recoveryJobId: bytes32Hex(0x710n), appTag: toHex(new TextEncoder().encode("drop")), manifestDigest: bytes32Hex(0x711n),
      originalRecipientCount: 2, originalIndexes: [0, 1],
    };
    const row = (slot: number, transaction: bigint, first: number) => ({
      transactionId: bytes32Hex(transaction), contentHash: bytes32Hex(transaction + 100n), privateValueShape: 0 as const,
      slot, leafIndex: String(30 + slot), recipientAddress: addressHex(wallet.address), assetId: "0x63", amount: "1",
      noteSecret: bytes32Hex(BigInt(800 + slot)),
      senderIncluded: false, senderRecords: [{ schema: bulkRecoverySchema.id, data: toHex(bulkRecoveryRecord(recovery, first, 1).data) }], blockNumber: String(transaction), blockHash: bytes32Hex(transaction + 200n), blockTimestamp: String(transaction),
    });
    data.sentOutputs = [row(0, 20n, 0)];
    reconcileBulkRecoveryObservations(data, 100n, 100n);
    reconcileBulkRecoveryObservations(data, 1_900n, 1_900n);
    expect(data.bulkRecoveryObservations![0]!.observedAtTimestamp).toBe("100");
    data.sentOutputs.push(row(0, 21n, 1));
    reconcileBulkRecoveryObservations(data, 2_000n, 2_000n);
    expect(data.bulkRecoveryObservations![0]).toMatchObject({ observedAtTimestamp: "2000", observedThroughTimestamp: "2000" });
    data.bulkJobs = [createBulkJob({
      kind: "payment", shape: 0, recipients: [{ to: code, amount: 1n }], openFeeAmount: 0n, maxTransactions: 1,
      recovery: { ...recovery, originalIndexes: [1], baselineContentHashes: [row(0, 20n, 0).contentHash] },
    })];
    data.sentOutputs = [row(0, 21n, 1)];
    reconcileBulkRecoveryObservations(data, 2_100n, 2_100n);
    expect(data.bulkJobs[0]!.recovery?.invalidated).toBe(true);
  });
});

describe("bulk job fee approval", () => {
  it("fixes an absent fee once per shape at approval to the node's suggested fee, and keeps an explicit zero", async () => {
    const f = fixture(Array<bigint>(8).fill(10n), 0n, [], (byteSize) => byteSize);
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "consolidation", maxTransactions: 2 });
    expect(job.openFeeAmounts).toEqual({
      0: paddedPrivateValueByteSize(0).toString(),
      1: paddedPrivateValueByteSize(1).toString(),
    });
    expect((await f.store.load())!.bulkJobs).toHaveLength(1);
    await expect(startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "consolidation", openFeeAmount: 0n, maxTransactions: 2 }))
      .resolves.toMatchObject({ openFeeAmounts: fees("0") });
  });

  it("funds and journals an L chunk with the fee approved for L", async () => {
    const f = fixture([1_000_000n], 0n, [], (byteSize) => byteSize);
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment",
      recipients: Array.from({ length: 6 }, () => ({ to: code, amount: 1n })), maxTransactions: 1 });
    const submission = { mode: "mempool" as const, preflight: async () => null,
      submit: async ({  }: {  }) => ({ accepted: false, queued: true, output: null }) };
    expect(await runBulkJobStep({ ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId, submission }))
      .toMatchObject({ state: "submitted" });
    const chunk = (await f.store.load())!.bulkJobs![0]!.chunks[0]!;
    const largeFee = paddedPrivateValueByteSize(1);
    expect(chunk).toMatchObject({ shape: 1, recipientCount: 6, action: { openFeeAmount: largeFee.toString() } });
    expect(chunk.action.ownedOutputs).toMatchObject([{ amount: (1_000_000n - 6n - largeFee).toString() }]);
  });
});

describe("durable bulk job execution (mock proofs)", () => {
  it("proves an exact private relay output and retries the saved selected chunk", async () => {
    const f = fixture([5n]);
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment",
      recipients: Array.from({ length: 4 }, () => ({ to: code, amount: 1n })), openFeeAmount: 0n, maxTransactions: 1 });
    const relayKey = new Uint8Array(32).fill(23);
    const relaySigner = privateKeyPcashActionSigner(relayKey);
    const quote = {
      recipient: relaySigner.address,
      requestQuote: (request: Parameters<import("@pcash/sdk/eip712").SelectedRelayQuoteProvider["requestQuote"]>[0]) =>
        createSelectedRelayQuote({ ...request, network, nkRoot: 23n, receiveKey: wallet.mlKemPublicKey, signer: relaySigner }),
    };
    const entries: Uint8Array[] = [];
    const submission = { mode: "mempool" as const, preflight: async () => null,
      submit: async ({ transactionBytes: entry }: { transactionBytes: Uint8Array }) => {
        entries.push(entry);
        return { accepted: false, queued: true, output: null };
      } };
    let built: import("@pcash/sdk/builders").AssetActionBuild | null = null;
    const prover = { shapes: f.prover.shapes, proveAndEncode: async (build: import("@pcash/sdk/builders").AssetActionBuild) => {
      built = build;
      return f.prover.proveAndEncode(build);
    } };
    const params = { ...f, prover, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId,
      privateRelayFeeAmount: 1n, selectedRelayQuote: quote, submission };
    expect(await runBulkJobStep(params)).toMatchObject({ state: "submitted" });
    expect(built).not.toBeNull();
    const feeSlot = built!.transaction.outputs[4]!;
    const feeOwner = ownerCommitment(relaySigner.address, built!.outputNoteSecrets[4]!);
    expect(feeSlot.slotClass).toBe(SlotClass.NATIVE);
    expect(feeSlot.outputBodyCommitment).toBe(noteBodyCommitment(feeOwner, 0n, 1n));
    expect(feeOwner).not.toBe(built!.transaction.global.issuanceOwnerCommitment);
    const chunk = (await f.store.load())!.bulkJobs![0]!.chunks[0]!;
    expect(chunk).toMatchObject({ shape: 0, recipientCount: 4,
      action: { openFeeAmount: "0", privateRelayFeeAmount: "1" } });
    expect(chunk.action.privateRelayRecipient).toBe(`0x${relaySigner.address.toString(16).padStart(40, "0")}`);
    expect(f.proofs()).toBe(1);
    expect(entries).toHaveLength(1);
    expect(await runBulkJobStep(params)).toMatchObject({ state: "submitted" });
    expect(f.proofs()).toBe(1);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual(entries[0]);
    await expect(runBulkJobStep({ ...params, privateRelayFeeAmount: 2n }))
      .rejects.toThrow(/selected bulk retry names another relayer/);
  });

  it("attaches a known definition to asset outputs and opens explicit note secrets without an envelope", async () => {
    const definition: AssetDefinition = {
      initialSupply: 100n,
      assetSecretCommitment: 0xa2n,
      metadata: { name: "Bulk Token", symbol: "BLK", decimals: 0, contentDigest: new Uint8Array(32) },
    };
    const assetId = assetDefinitionAssetId(definition);
    const f = fixture([100n], assetId);
    await f.store.transaction((data) => {
      addWalletAsset(data!, { assetId, definition });
      return { data: data!, value: undefined };
    });
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment", assetId, openFeeAmount: 0n,
      recipients: [{ to: code, amount: 10n }, { to: addressHex(wallet.address), amount: 20n, noteSecret: 0x55n }], maxTransactions: 1 });
    let built: import("@pcash/sdk/builders").AssetActionBuild | undefined;
    const prover = { shapes: f.prover.shapes, proveAndEncode: async (build: import("@pcash/sdk/builders").AssetActionBuild) => {
      built = build;
      return f.prover.proveAndEncode(build);
    } };
    const submission = { mode: "mempool" as const, preflight: async () => null,
      submit: async ({  }: {  }) => ({ accepted: false, queued: true, output: null }) };
    expect(await runBulkJobStep({ ...f, prover, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId, submission }))
      .toMatchObject({ state: "submitted" });
    const payload = (slot: number) => {
      const output = deliveredOutput(built!, network.pcashChainId, wallet.mlKemSecretKey, slot);
      return output === null ? null : { ...output.note, assetDefinition: recordValue(output.records, assetDefinitionSchema) };
    };
    expect(payload(0)).toMatchObject({ amount: 10n, assetDefinition: definition });
    expect(built!.outputNoteSecrets[1]).toBe(0x55n);
    expect(payload(1)).toBeNull();
    // The change carries no copy of the definition; the sender region holds the wallet's.
    expect(payload(2)).toMatchObject({ amount: 70n, assetDefinition: undefined });
    const region = senderRegionOf(built!, network.pcashChainId, wallet.outgoingKey)!;
    expect(region.sentOpenings).toEqual([{ slot: 1, recipientAddress: wallet.address, assetId, amount: 20n, noteSecret: 0x55n }]);
    expect(recordValue(region.records, assetDefinitionSchema)).toEqual(definition);
  });

  it("chunks an unfixed job in the prover's shapes and refuses a fixed shape it cannot prove", async () => {
    const f = fixture([100n]);
    const smallOnly = { ...f.prover, shapes: [0] as const };
    const submission = { mode: "mempool" as const, preflight: async () => null,
      submit: async ({  }: {  }) => ({ accepted: false, queued: true, output: null }) };
    const recipients = Array.from({ length: 64 }, () => ({ to: code, amount: 1n }));
    const unfixed = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment", recipients, openFeeAmount: 0n, maxTransactions: 1 });
    expect(await runBulkJobStep({ ...f, prover: smallOnly, jobId: unfixed.jobId, wallet, signer, chainId: network.pcashChainId, submission }))
      .toMatchObject({ state: "submitted" });
    expect((await f.store.load())!.bulkJobs![0]!.chunks[0]).toMatchObject({ shape: 0, recipientCount: 4 });
    const large = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment", recipients, shape: 1, openFeeAmount: 0n, maxTransactions: 1 });
    await expect(runBulkJobStep({ ...f, prover: smallOnly, jobId: large.jobId, wallet, signer, chainId: network.pcashChainId, submission }))
      .rejects.toThrow(/uses L chunks, which this wallet's prover cannot prove/);
    expect(f.proofs()).toBe(1);
  });

  it("self-publishes a chunk with zero PCASH fee even when its open job fee is positive", async () => {
    const f = fixture([5n]);
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId, kind: "payment",
      recipients: [{ to: code, amount: 1n }], openFeeAmount: 3n, maxTransactions: 1 });
    const submission = { mode: "l1" as const, preflight: async () => null,
      submit: async ({  }: {  }) => ({ accepted: false, queued: true, output: null }) };
    expect(await runBulkJobStep({ ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId, submission }))
      .toMatchObject({ state: "submitted" });
    const action = (await f.store.load())!.bulkJobs![0]!.chunks[0]!.action;
    expect(action.openFeeAmount).toBe("0");
    expect(action.ownedOutputs).toMatchObject([{ amount: "4" }]);
    expect(BigInt(action.issuanceOwnerCommitment)).not.toBe(0n);
  });
  it.each([
    { name: "native fee-covering note last", assetId: 0n, amounts: [...Array<bigint>(32).fill(1n), 100n], native: [], openFeeAmount: 33n, inputCount: 32, change: "98", remaining: 2 },
    { name: "native fee-covering note first", assetId: 0n, amounts: [100n, ...Array<bigint>(32).fill(1n)], native: [], openFeeAmount: 33n, inputCount: 32, change: "98", remaining: 2 },
    { name: "custom asset with fee-sized native note last", assetId: 99n, amounts: Array<bigint>(32).fill(1n), native: [...Array<bigint>(31).fill(1n), 31n], openFeeAmount: 31n, inputCount: 31, change: "31", remaining: 2 },
    { name: "custom asset with fee-sized native note first", assetId: 99n, amounts: Array<bigint>(32).fill(1n), native: [31n, ...Array<bigint>(31).fill(1n)], openFeeAmount: 31n, inputCount: 31, change: "31", remaining: 2 },
  ])("submits a single chunk projected to meet the consolidation target: $name", async ({ assetId, amounts, native, openFeeAmount, inputCount, change, remaining }) => {
    const f = fixture(amounts, assetId, native);
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId,
      kind: "consolidation", assetId, openFeeAmount, targetNotes: 4, maxTransactions: 1 });
    let submissions = 0;
    const submission = { mode: "mempool" as const, preflight: async () => null,
      submit: async ({  }: {  }) => {
        submissions++;
        return { accepted: false, queued: true, output: null };
      } };
    const params = { ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId, submission };
    expect(await runBulkJobStep(params)).toMatchObject({ state: "submitted" });
    const saved = (await f.store.load())!;
    expect(saved.bulkJobs![0]!.chunks).toHaveLength(1);
    const chunk = saved.bulkJobs![0]!.chunks[0]!;
    expect(chunk).toMatchObject({ shape: 1, recipientCount: 0 });
    expect(chunk.action.inputs.filter(input => input.spentCommitment !== null)).toHaveLength(32);
    const spent = new Set(chunk.action.inputs.map(input => input.spentCommitment));
    expect(saved.notes.filter(note => BigInt(note.assetId) === assetId && spent.has(note.commitment!))).toHaveLength(inputCount);
    expect(chunk.action.ownedOutputs).toMatchObject([{ amount: change }]);
    expect(chunk.action.ownedOutputs).toHaveLength(1);
    const resultingNotes = amounts.length - inputCount + chunk.action.ownedOutputs.length;
    expect(resultingNotes).toBe(remaining);
    expect(resultingNotes + (assetId === 0n ? 2 : 0)).toBeLessThanOrEqual(job.targetNotes);
    expect(await runBulkJobStep({ ...params, chunkIndex: 1 })).toMatchObject({ state: "waiting-for-confirmation" });
    expect(f.proofs()).toBe(1);
    expect(submissions).toBe(1);
  });

  it.each([
    { reason: "native fee cannot be funded", assetId: 0n, amounts: Array<bigint>(32).fill(1n), native: [], openFeeAmount: 33n },
    { reason: "target asset cannot be reduced", assetId: 99n, amounts: Array<bigint>(5).fill((1n << 128n) - 1n), native: [1n, 1n, 1n], openFeeAmount: 3n },
  ])("does not prove, submit or consume a consolidation chunk when $reason", async ({ assetId, amounts, native, openFeeAmount }) => {
    const f = fixture(amounts, assetId, native);
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId,
      kind: "consolidation", assetId, openFeeAmount, targetNotes: 4, maxTransactions: 1 });
    let submissions = 0;
    const submission = { mode: "mempool" as const, preflight: async () => null,
      submit: async ({  }: {  }) => {
        submissions++;
        return { accepted: false, queued: true, output: null };
      } };
    expect(await runBulkJobStep({ ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId, submission }))
      .toMatchObject({ state: "waiting-for-funding" });
    expect((await f.store.load())!.bulkJobs![0]!.chunks).toEqual([]);
    expect(f.proofs()).toBe(0);
    expect(submissions).toBe(0);
  });

  it.each([true, false])("submits fragmented custom-asset funding only when the native fee is funded (%s)", async funded => {
    const f = fixture([...Array<bigint>(32).fill(1n), 10n], 99n, funded ? [1n] : []);
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId,
      kind: "payment", assetId: 99n, recipients: [{ to: code, amount: 32n }], openFeeAmount: 1n, maxTransactions: 1 });
    let submissions = 0;
    const submission = { mode: "mempool" as const, preflight: async () => null,
      submit: async ({  }: {  }) => {
        submissions++;
        return { accepted: false, queued: true, output: null };
      } };
    expect(await runBulkJobStep({ ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId, submission }))
      .toMatchObject({ state: funded ? "submitted" : "waiting-for-funding" });
    expect(f.proofs()).toBe(funded ? 1 : 0);
    expect(submissions).toBe(funded ? 1 : 0);
    const chunks = (await f.store.load())!.bulkJobs![0]!.chunks;
    expect(chunks).toHaveLength(funded ? 1 : 0);
    if (funded) {
      expect(chunks[0]).toMatchObject({ shape: 1, recipientCount: 1 });
      expect(chunks[0]!.action.inputs.filter(input => input.spentCommitment !== null)).toHaveLength(24);
      expect(chunks[0]!.action.ownedOutputs).toEqual([]);
    }
  });

  it.each([
    { mode: "l1", assetId: 99n }, { mode: "l1", assetId: 0n }, { mode: "mempool", assetId: 99n },
  ] as const)("names the wallet's own issuance commitment only on a self-published chunk: $mode, asset $assetId", async ({ mode, assetId }) => {
    const f = fixture([100n, 100n], assetId);
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId,
      kind: "payment", assetId, recipients: [{ to: code, amount: 1n }], openFeeAmount: 0n, maxTransactions: 1 });
    const entries: Uint8Array[] = [];
    const submission = { mode, preflight: async () => null,
      submit: async ({ transactionBytes: entry }: { transactionBytes: Uint8Array }) => {
        entries.push(entry);
        return { accepted: false, queued: true, output: null };
      } };
    expect(await runBulkJobStep({ ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId, submission }))
      .toMatchObject({ state: "submitted" });
    const action = (await f.store.load())!.bulkJobs![0]!.chunks[0]!.action;
    if (mode === "l1") {
      expect(BigInt(action.issuanceOwnerCommitment)).not.toBe(0n);
      expect(controlledIssuanceOpening(entries[0]!, network.pcashChainId, wallet)?.ownerCommitment)
        .toBe(BigInt(action.issuanceOwnerCommitment));
      expect(action.issuanceRecipient).toBe(addressHex(wallet.address));
    } else {
      expect(action.issuanceOwnerCommitment).toBe("0");
      expect(action.issuanceRecipient).toBeUndefined();
    }
  });

  it("journals a consolidation with every selected input and its change opening", async () => {
    const f = fixture(Array(32).fill(100n));
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId,
      kind: "consolidation", openFeeAmount: 1n, maxTransactions: 1 });
    const submission = { mode: "mempool" as const, preflight: async () => null,
      submit: async ({  }: {  }) => ({ accepted: false, queued: true, output: null }) };
    const params = { ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId, submission };
    expect(await runBulkJobStep(params)).toMatchObject({ state: "submitted" });
    const saved = (await f.store.load())!;
    const chunk = saved.bulkJobs![0]!.chunks[0]!;
    expect(chunk.shape).toBe(1);
    expect(chunk.action.inputs.filter(input => input.spentCommitment !== null)).toHaveLength(32);
    expect(chunk.action.ownedOutputs).toMatchObject([{ outputIndex: 0, amount: "3199" }]);
    expect(saved.notes.filter(note => note.pending)).toHaveLength(1);
    expect(await runBulkJobStep({ ...params, chunkIndex: 1 })).toMatchObject({ state: "waiting-for-confirmation" });
    expect(f.proofs()).toBe(1);
  });

  it.each([1, 10])("waits for confirmation, not funding or the ceiling, once every recipient is assigned (maxTransactions %s)", async maxTransactions => {
    const f = fixture();
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId,
      kind: "payment", recipients: [{ to: code, amount: 1n }], openFeeAmount: 0n, maxTransactions });
    const submission = { mode: "mempool" as const, preflight: async () => null,
      submit: async ({  }: {  }) => ({ accepted: false, queued: true, output: null }) };
    const params = { ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId, submission };
    expect(await runBulkJobStep({ ...params, chunkIndex: 0 })).toMatchObject({ state: "submitted" });
    expect(await runBulkJobStep({ ...params, chunkIndex: 1 })).toMatchObject({ state: "waiting-for-confirmation" });
    expect(f.proofs()).toBe(1);
  });

  it("halts at finalized expiry without authorizing a replacement chunk", async () => {
    const f = fixture();
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId,
      kind: "payment", recipients: [{ to: code, amount: 1n }], openFeeAmount: 0n, maxTransactions: 10 });
    const submission = { mode: "mempool" as const, preflight: async () => null,
      submit: async ({  }: {  }) => ({ accepted: false, queued: true, output: null }) };
    const params = { ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId, submission };
    await runBulkJobStep(params);
    const pending = (await f.store.load())!.bulkJobs![0]!.chunks[0]!.action;
    f.status.finalizedBlockTimestamp = BigInt(pending.validUntilTimestamp) + 1n;
    expect(await runBulkJobStep(params)).toMatchObject({ state: "needs-review" });
    const saved = (await f.store.load())!;
    expect(saved.bulkJobs![0]!.chunks[0]!.outcome).toBe("expired");
    expect(saved.pendingAssetActions).toBeUndefined();
    expect(f.proofs()).toBe(1);
  });

  it("keeps an unfinalized inclusion unresolved and retries the same bytes after a reorg", async () => {
    const f = fixture();
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId,
      kind: "payment", recipients: [{ to: code, amount: 1n }], openFeeAmount: 0n, maxTransactions: 10 });
    const entries: string[] = [];
    const submission = { mode: "mempool" as const, preflight: async () => null,
      submit: async ({ transactionBytes: entry }: { transactionBytes: Uint8Array }) => {
        entries.push(Buffer.from(entry).toString("hex"));
        return { accepted: false, queued: true, output: null };
      } };
    const params = { ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId, submission };
    await runBulkJobStep(params);
    const pending = (await f.store.load())!.bulkJobs![0]!.chunks[0]!.action;
    const receipt: ReceiptResult = { contentHash: pending.contentHash, transactionId: bytes32Hex(500n), outcome: "succeeded", kind: "privateValue", accountCreation: 0 as const,
      failureDetail: null, l1Sender: `0x${"11".repeat(20)}`, issuanceOwnerCommitment: null, settledOpenFeeAmount: 0n, settledIssuanceAmount: 0n, outputsAdded: 5n, account: null,
      inclusion: { l1BlockNumber: 1n, l1BlockHash: bytes32Hex(1n), l1TransactionIndex: 0n, l1TransactionHash: bytes32Hex(2n), batchItemIndex: 0n }, outputLeafStart: 2n,
      nullifiers: pending.inputs.map(input => input.nullifier) };
    f.node.getReceipt = async () => [receipt];
    await syncStoreTo(f.store, f.chain(consumedIn(f.boundary, pending.contentHash, pending.inputs.map(input => input.nullifier))));
    expect(f.status.finalizedBlock).toBeLessThan(f.boundary.header.number);
    await runBulkJobStep(params);
    expect((await f.store.load())!.bulkJobs![0]!.chunks[0]!.outcome).toBe("unresolved");
    f.node.getReceipt = async () => [];
    await syncStoreTo(f.store, f.chain());
    await runBulkJobStep(params);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toBe(entries[0]);
    expect(f.proofs()).toBe(1);
  });

  it.each([true, false])("resolves a chunk from a finalized consumption of its inputs (ours: %s)", async ours => {
    const f = fixture();
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId,
      kind: "payment", recipients: [{ to: code, amount: 1n }], openFeeAmount: 0n, maxTransactions: 10 });
    const submission = { mode: "mempool" as const, preflight: async () => null,
      submit: async ({  }: {  }) => ({ accepted: false, queued: true, output: null }) };
    const params = { ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId, submission };
    await runBulkJobStep(params);
    const pending = (await f.store.load())!.bulkJobs![0]!.chunks[0]!.action;
    await syncStoreTo(f.store, f.chain(consumedIn(f.boundary, ours ? pending.contentHash : bytes32Hex(7n),
      pending.inputs.map(input => input.nullifier))));
    f.status.finalizedBlock = f.boundary.header.number;
    expect(await runBulkJobStep(params)).toMatchObject({ state: ours ? "complete" : "needs-review" });
    const saved = (await f.store.load())!;
    expect(saved.bulkJobs![0]!.chunks[0]).toMatchObject(ours
      ? { outcome: "succeeded", inclusion: { blockNumber: f.boundary.header.number.toString(), blockHash: bytes32Hex(f.boundary.blockHash) } }
      : { outcome: "unresolved" });
    expect(saved.pendingAssetActions).toBeUndefined();
    expect(f.proofs()).toBe(1);
  });

  it.each(["ambiguous", "definite"] as const)("retains exact L bytes after a %s failure and retries without proving again", async mode => {
    const f = fixture();
    const job = await startBulkJob({ ...f, wallet, chainId: network.pcashChainId,
      kind: "payment", recipients: Array.from({ length: 64 }, () => ({ to: code, amount: 1n })), openFeeAmount: 0n, maxTransactions: 10 });
    let fail = true;
    const entries: string[] = [];
    const submission = { mode: "mempool" as const, preflight: async () => null,
      submit: async ({ transactionBytes: entry }: { transactionBytes: Uint8Array }) => {
        const { contentHash } = submissionIdentity(entry);

        const saved = await f.store.load();
        expect(saved?.bulkJobs?.[0]?.chunks.some(chunk => chunk.action.contentHash === contentHash)).toBe(true);
        expect(saved?.pendingAssetActions?.some(action => action.contentHash === contentHash)).toBe(true);
        entries.push(Buffer.from(entry).toString("hex"));
        if (fail) throw mode === "definite" ? new DurablePreBroadcastError("offline") : new Error("timeout");
        return { accepted: false, queued: true, output: null };
      } };
    const params = { ...f, jobId: job.jobId, wallet, signer, chainId: network.pcashChainId, submission };
    await expect(runBulkJobStep(params)).rejects.toThrow(mode === "definite" ? "offline" : "timeout");
    const saved = await f.store.load();
    expect(saved?.bulkJobs?.[0]?.chunks[0]).toMatchObject({ shape: 1, recipientCount: 31, outcome: "unresolved" });
    expect(saved?.pendingAssetActions).toHaveLength(1);
    fail = false;
    expect(await runBulkJobStep(params)).toMatchObject({ state: "submitted", result: { retried: true, queued: true } });
    expect(f.proofs()).toBe(1);
    expect(entries[1]).toBe(entries[0]);
    // A second independently-funded chunk cannot use the first chunk's change.
    expect(await runBulkJobStep({ ...params, chunkIndex: 1 })).toMatchObject({ state: "submitted" });
    const chunks = (await f.store.load())!.bulkJobs![0]!.chunks;
    expect(chunks).toHaveLength(2);
    const spent = chunks.map(chunk => chunk.action.inputs.filter(input => input.spentCommitment !== null).map(input => input.spentCommitment));
    expect(spent[0]).not.toEqual(spent[1]);
    expect(f.proofs()).toBe(2);
  });
});
