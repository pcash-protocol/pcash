import { applicationSchemaId } from "../../src/protocol/records.ts";
import { computeCircuitVkHash, VK_LEN } from "@pcash/sdk/protocol";
import { describe, expect, it } from "vitest";
import { fieldToHex } from "@pcash/sdk/crypto";
import {
  assetCovenantSuccessorConfigurationCommitment,
  assetCreationMarker,
  createStandardFungibleAsset,
  deriveStandardFungibleAssetFromEntropy,
  assetSecretCommitment,
  fungibleMetadataCommitment,
  standardFungibleAssetId,
  verifyAssetDescriptor,
} from "@pcash/sdk/protocol";
import {
  buildAssetAction,
  buildFixedSupplyCreationToCustomContract,
  createFixedSupplyCreationToCustomContract,
  type BuildStandardAssetCreationParams,
  type FixedSupplyCreationMaterial,
  openedAssetActionOutput,
  ownerChangeAssetActionOutput,
  outOfBandAssetActionOutput,
  recipientCommittedAssetActionOutput,
  unsafeRawAssetActionOutput,
} from "@pcash/sdk/builders";
import { buildAssetCovenantRuleWitness } from "@pcash/sdk/fixtures";
import { functionSelector, verifyContract, verifyContractManifest, type ContractBody } from "@pcash/sdk/protocol";
import { decryptEnvelope, generateMlKemKeyPair, sizeClassFiller } from "@pcash/sdk/protocol";
import { noteBodyCommitment, outputCommitment, ownerCommitment } from "@pcash/sdk/protocol";
import { accountStateCommitment } from "@pcash/sdk/protocol";
import { SlotClass } from "@pcash/sdk/protocol";
import { SparseMerkleTree } from "@pcash/sdk/crypto";
import { addressHex } from "@pcash/sdk/utils";
import { MERKLE_DEPTH, PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { recoverSentTransaction, scanFeed } from "../../src/wallet/actions/scan.ts";
import { spendableNotes, type WalletFileData } from "../../src/wallet/noteStore.ts";
import { buildExtendedCode } from "../../src/wallet/wallet.ts";
import { EMPTY_OUTPUT_ROOT, syntheticRecentBlockFixture } from "./builderTestHelpers.ts";

const testOwner = { address: 0x1234n, nkRoot: 123n, accountIndex: 0, accountSiblings: Array(40).fill(0n), accountRuleSetCommitment: 1n, accountKind: 0n, accountRevision: 0n, receiveKeyHash: 0n, rule: { configurationCommitment: 1n, commitmentBlinder: 0n, entryIndex: 0, siblings: Array(8).fill(0n) } };

const siblings4 = Array.from({ length: 4 }, () => 0n);
const assetSecret = 0x1234n;
const initialSupply = 1_000n;
const metadata = {
  name: "Example Dollar",
  symbol: "EXD",
  decimals: 6,
  contentDigest: new Uint8Array(32),
};
const metadataCommitment = fungibleMetadataCommitment(metadata);
const assetFields = {
  metadataCommitment,
  initialSupply,
  assetSecretCommitment: assetSecretCommitment(assetSecret),
};
const descriptor = {
  assetId: standardFungibleAssetId(assetFields),
  ...assetFields,
};
const deterministicAsset = deriveStandardFungibleAssetFromEntropy({
  metadata,
  initialSupply,
  assetSecret,
});

const snapshot = {
  recentPcashBlockHash: 1n,
  stateRoot: 2n,
  stateRootHeaderSiblings: siblings4,
  outputRoot: 3n,
  outputRootStateSiblings: siblings4,
  accountStateRoot: 4n,
  accountStateRootStateSiblings: siblings4,
};

function creation(overrides: Partial<BuildStandardAssetCreationParams> = {}) {
  return buildAssetAction({
    pcashChainId: 0x1ff6n,
    snapshot,
    owner: testOwner,
    assetDescriptor: descriptor,
    assetSecret,
    inputs: [
      { kind: "creation-marker" },
      { kind: "dummy" },
      { kind: "dummy" },
      { kind: "dummy" },
    ],
    outputs: [
      outOfBandAssetActionOutput({
        kind: "asset",
        recipientAddress: 0x1234n,
        noteSecret: 0x10n,
        amount: initialSupply,
        outputData: sizeClassFiller(),
      }),
      { kind: "dummy", dummySecret: 0x11n, amount: 0n, outputData: sizeClassFiller() },
      { kind: "dummy", dummySecret: 0x12n, amount: 0n, outputData: sizeClassFiller() },
      { kind: "dummy", dummySecret: 0x13n, amount: 0n, outputData: sizeClassFiller() },
      { kind: "dummy", dummySecret: 0x14n, amount: 0n, outputData: sizeClassFiller() },
    ],
    openFeeAmount: 0n,
    issuanceOwnerCommitment: 0n,
    validUntilTimestamp: 100n,
    dummyInputSeed: 0x99n,
    ...overrides,
  });
}

describe("standard fungible asset builder", () => {
  it("uses CSPRNG entropy by default and keeps deterministic derivation explicit", () => {
    const first = createStandardFungibleAsset({ metadata, initialSupply });
    const second = createStandardFungibleAsset({ metadata, initialSupply });
    expect(first.assetSecret).not.toBe(0n);
    expect(first.assetSecret).not.toBe(second.assetSecret);
    expect(first.descriptor.assetId).not.toBe(second.descriptor.assetId);
    expect(deterministicAsset.descriptor).toEqual(descriptor);
    expect(deterministicAsset.assetSecret).toBe(assetSecret);
  });

  it("canonicalizes the interoperable metadata profile", () => {
    expect(fungibleMetadataCommitment({
      name: "Example Dollar",
      symbol: "EXD",
      decimals: 6,
      contentDigest: new Uint8Array(32),
    })).toBe(metadataCommitment);
    expect(() => fungibleMetadataCommitment({
      name: "e\u0301",
      symbol: "EXD",
      decimals: 6,
      contentDigest: new Uint8Array(32),
    })).toThrow("NFC");
    expect(() => fungibleMetadataCommitment({
      name: "Example Dollar",
      symbol: "TOO-LONG-SYMBOL",
      decimals: 6,
      contentDigest: new Uint8Array(32),
    })).toThrow("printable ASCII");
  });

  it("builds one fixed 4-input/5-output asset creation", () => {
    const build = creation();
    expect(build.operation).toBe("assetCreation");
    expect(build.assetId).toBe(descriptor.assetId);
    expect(build.publicInputs).toHaveLength(PRIVATE_VALUE_PROFILES.S.publicInputs);
    expect(build.transaction.inputs.map((input) => input.slotClass)).toEqual([
      SlotClass.ASSET_CREATION,
      SlotClass.DUMMY,
      SlotClass.DUMMY,
      SlotClass.DUMMY,
    ]);
    expect(build.transaction.outputs.map((output) => output.slotClass)).toEqual([
      SlotClass.ASSET,
      SlotClass.DUMMY,
      SlotClass.DUMMY,
      SlotClass.DUMMY,
      SlotClass.DUMMY,
    ]);
    expect(build.transaction.inputs[0]!.nullifier).toBe(
      assetCreationMarker(descriptor.assetId, assetSecret),
    );
    expect(build.transaction.outputs[1]!.outputBodyCommitment).toBe(
      noteBodyCommitment(ownerCommitment(0n, 0x11n), 0n, 0n),
    );
  });

  it("binds the standard identity to every immutable asset field", () => {
    expect(verifyAssetDescriptor(descriptor)).toBe(descriptor.assetId);
    expect(() => verifyAssetDescriptor({ ...descriptor, assetId: descriptor.assetId + 1n }))
      .toThrow("asset descriptor does not match assetId");
    for (const changed of [
      { initialSupply: initialSupply + 1n },
      { metadataCommitment: metadataCommitment + 1n },
      { assetSecretCommitment: assetFields.assetSecretCommitment + 1n },
    ]) expect(standardFungibleAssetId({ ...assetFields, ...changed })).not.toBe(descriptor.assetId);
  });

  it("requires exactly the configured supply and asset secret", () => {
    expect(() => creation({ assetSecret: assetSecret + 1n })).toThrow(
      "asset secret does not match",
    );
    expect(() => creation({
      outputs: [
        outOfBandAssetActionOutput({ kind: "asset", recipientAddress: 1n, noteSecret: 2n, amount: initialSupply - 1n, outputData: sizeClassFiller() }),
        { kind: "dummy", dummySecret: 3n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 4n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 5n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 6n, amount: 0n, outputData: sizeClassFiller() },
      ],
    })).toThrow("outputs must equal initialSupply");
    expect(() => creation({
      inputs: [
        { kind: "dummy" },
        { kind: "dummy" },
        { kind: "dummy" },
        { kind: "dummy" },
      ],
    })).toThrow("exactly one creation marker");
  });

  it("uses the full existing 128-bit encrypted amount field for assets", () => {
    const maximalNote = (1n << 128n) - 1n;
    const maximalFields = {
      ...assetFields,
      initialSupply: maximalNote,
    };
    const maximalDescriptor = {
      assetId: standardFungibleAssetId(maximalFields),
      ...maximalFields,
    };
    expect(() => creation({
      assetDescriptor: maximalDescriptor,
      outputs: [
        outOfBandAssetActionOutput({ kind: "asset", recipientAddress: 1n, noteSecret: 2n, amount: maximalNote, outputData: sizeClassFiller() }),
        { kind: "dummy", dummySecret: 3n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 4n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 5n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 6n, amount: 0n, outputData: sizeClassFiller() },
      ],
    })).not.toThrow();
    expect(() => outOfBandAssetActionOutput({
      kind: "asset",
      recipientAddress: 1n,
      noteSecret: 2n,
      amount: 1n << 128n,
      outputData: sizeClassFiller(),
    })).not.toThrow();
    expect(() => creation({
      outputs: [
        outOfBandAssetActionOutput({ kind: "asset", recipientAddress: 1n, noteSecret: 2n, amount: 1n << 128n, outputData: sizeClassFiller() }),
        { kind: "dummy", dummySecret: 3n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 4n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 5n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 6n, amount: 0n, outputData: sizeClassFiller() },
      ],
    })).toThrow("2^128");
    expect(() => standardFungibleAssetId({
      ...assetFields,
      initialSupply: 5n * ((1n << 128n) - 1n) + 1n,
    })).toThrow("five maximal asset outputs");
  });

  it("builds canonical recipient delivery and spends the recovered note with assetId alone", async () => {
    const recipient = generateMlKemKeyPair();
    const recipientAddress = 0x1234n;
    const noteSecret = 0x5151n;
    const output = openedAssetActionOutput({
      kind: "asset",
      pcashChainId: 0x1ff6n,
      assetId: descriptor.assetId,
      outputIndex: 0,
      recipientExtendedCode: buildExtendedCode({
        chainId: 0x1ff6n,
        address: recipientAddress,
        mlKemPublicKey: recipient.publicKey,
      }),
      noteSecret,
      amount: initialSupply,
    });
    if (output.kind !== "asset" || output.delivery.kind !== "canonical-encrypted") throw new Error("opened asset output changed kind");
    // The builder seals the envelope once the arena exists.
    expect(output.outputData).toBeUndefined();
    expect(output.delivery.receiveKey).toEqual(recipient.publicKey);
    const build = creation({
      outputs: [
        output,
        { kind: "dummy", dummySecret: 0x31n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x32n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x33n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x34n, amount: 0n, outputData: sizeClassFiller() },
      ],
    });
    const leafIndex = 7n;
    const leaf = outputCommitment(build.transaction.outputs[0]!.outputBodyCommitment, leafIndex);
    const report = await scanFeed({
      chainId: 0x1ff6n,
      mlKemSecretKeys: [recipient.secretKey],
      owners: [recipientAddress],
      feed: [{
        kind: 0, shape: 0,
        outputData: build.outputData[0]!,
        outputIndex: 0,
        leafIndex,
        outputCommitment: leaf,
      }],
    });
    expect(decryptEnvelope(recipient.secretKey, build.outputData[0]!)).not.toBeNull();
    expect(report.recovered).toHaveLength(1);
    const recovered = report.recovered[0]!;
    const restartedWallet: WalletFileData = {
      address: addressHex(recipientAddress),
      network: { chainId: "8182", genesisHash: `0x${"11".repeat(32)}` },
      receiveKeys: [],
      notes: [{
        leafIndex: recovered.leafIndex.toString(),
        outputIndex: recovered.outputIndex,
        assetId: `0x${recovered.assetId.toString(16).padStart(64, "0")}`,
        amount: recovered.amount.toString(),
        owner: addressHex(recovered.owner),
        noteSecret: `0x${recovered.noteSecret.toString(16).padStart(64, "0")}`,
        commitment: `0x${recovered.outputCommitment.toString(16).padStart(64, "0")}`,
        spent: false,
        pending: false,
      }],
    };
    const restarted = spendableNotes(restartedWallet, recovered.assetId)[0]!;
    const transfer = buildAssetAction({
      pcashChainId: 0x1ff6n,
      snapshot,
      assetId: BigInt(restarted.assetId),
      owner: {
        address: recipientAddress,
        nkRoot: 0x7777n,
        accountIndex: 0,
        accountSiblings: Array.from({ length: MERKLE_DEPTH }, () => 0n),
        accountRuleSetCommitment: 0x8888n,
        accountKind: 0n,
        accountRevision: 1n,
        receiveKeyHash: 0n,
        rule: {
          configurationCommitment: 0x9999n,
          commitmentBlinder: 1n,
          entryIndex: 0,
          siblings: Array.from({ length: 8 }, () => 0n),
        },
      },
      inputs: [
        { kind: "asset", amount: BigInt(restarted.amount), noteSecret: BigInt(restarted.noteSecret), leafIndex: Number(restarted.leafIndex), siblings: Array.from({ length: MERKLE_DEPTH }, () => 0n) },
        { kind: "dummy" },
        { kind: "dummy" },
        { kind: "dummy" },
      ],
      outputs: [
        outOfBandAssetActionOutput({ kind: "asset", recipientAddress, noteSecret: 0x6161n, amount: initialSupply, outputData: sizeClassFiller() }),
        { kind: "dummy", dummySecret: 0x41n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x42n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x43n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x44n, amount: 0n, outputData: sizeClassFiller() },
      ],
      openFeeAmount: 0n,
      issuanceOwnerCommitment: 0n,
      validUntilTimestamp: 100n,
      dummyInputSeed: 0x123n,
    });
    expect(transfer.operation).toBe("transfer");
    expect(transfer.assetId).toBe(recovered.assetId);
  });

  it("accepts recipient-supplied opaque commitments but keeps the unsafe raw path explicit", () => {
    const opaque = 0x123456789n;
    const build = creation({
      outputs: [
        recipientCommittedAssetActionOutput({ kind: "asset", ownerCommitment: opaque, amount: initialSupply, outputData: sizeClassFiller(), recipientAcceptedDelivery: true }),
        { kind: "dummy", dummySecret: 0x41n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x42n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x43n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x44n, amount: 0n, outputData: sizeClassFiller() },
      ],
    });
    expect(build.transaction.outputs[0]!.outputBodyCommitment).not.toBe(0n);
    expect(() => unsafeRawAssetActionOutput({
      kind: "asset",
      ownerCommitment: opaque,
      amount: initialSupply,
      outputData: sizeClassFiller(),
      allowUnspendableOutput: false as true,
    })).toThrow("allowUnspendableOutput=true");
  });

  it("groups same-owner asset and native inputs under one exact authorization", () => {
    const owner = {
      address: 0x1234567890abcdef1234567890abcdef12345678n,
      nkRoot: 0x7777n,
      accountIndex: 0,
      accountSiblings: Array.from({ length: MERKLE_DEPTH }, () => 0n),
      accountRuleSetCommitment: 0x8888n,
      accountKind: 0n,
      accountRevision: 1n,
      receiveKeyHash: 0n,
      rule: {
        configurationCommitment: 0x9999n,
        commitmentBlinder: 1n,
        entryIndex: 0,
        siblings: Array.from({ length: 8 }, () => 0n),
      },
    };
    const build = buildAssetAction({
      pcashChainId: 0x1ff6n,
      snapshot,
      assetId: descriptor.assetId,
      owner,
      inputs: [
        { kind: "asset", amount: 100n, noteSecret: 0x11n, leafIndex: 0, siblings: Array.from({ length: MERKLE_DEPTH }, () => 0n) },
        { kind: "native", amount: 10n, noteSecret: 0x12n, leafIndex: 1, siblings: Array.from({ length: MERKLE_DEPTH }, () => 0n) },
        { kind: "dummy" },
        { kind: "dummy" },
      ],
      outputs: [
        outOfBandAssetActionOutput({ kind: "asset", recipientAddress: owner.address, noteSecret: 0x21n, amount: 100n, outputData: sizeClassFiller() }),
        outOfBandAssetActionOutput({ kind: "native", recipientAddress: owner.address, noteSecret: 0x22n, amount: 9n, outputData: sizeClassFiller() }),
        { kind: "dummy", dummySecret: 0x23n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x24n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x25n, amount: 0n, outputData: sizeClassFiller() },
      ],
      openFeeAmount: 1n,
      issuanceOwnerCommitment: 0n,
      validUntilTimestamp: 100n,
      dummyInputSeed: 0x123n,
    });
    expect(build.address).toBe(owner.address);
  });

  it("draws a fresh dummy input seed for every action", () => {
    const build = () => buildAssetAction({
      pcashChainId: 0x1ff6n,
      snapshot,
      assetId: descriptor.assetId,
      owner: testOwner,
      inputs: [
        { kind: "asset", amount: 100n, noteSecret: 0x11n, leafIndex: 0, siblings: Array.from({ length: MERKLE_DEPTH }, () => 0n) },
        { kind: "dummy" },
        { kind: "dummy" },
        { kind: "dummy" },
      ],
      outputs: [
        outOfBandAssetActionOutput({ kind: "asset", recipientAddress: testOwner.address, noteSecret: 0x21n, amount: 100n, outputData: sizeClassFiller() }),
        { kind: "dummy", dummySecret: 0x22n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x23n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x24n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x25n, amount: 0n, outputData: sizeClassFiller() },
      ],
      openFeeAmount: 0n,
      issuanceOwnerCommitment: 0n,
      validUntilTimestamp: 100n,
    });
    const first = build();
    const second = build();
    expect(first.dummyInputSeed).not.toBe(second.dummyInputSeed);
    const slotClasses = first.transaction.inputs.map((input) => input.slotClass);
    expect(slotClasses).toEqual([SlotClass.ASSET, SlotClass.DUMMY, SlotClass.DUMMY, SlotClass.DUMMY]);
    first.transaction.inputs.forEach((input, slot) => {
      const other = second.transaction.inputs[slot]!.nullifier;
      if (input.slotClass === SlotClass.DUMMY) expect(input.nullifier).not.toBe(other);
      else expect(input.nullifier).toBe(other);
    });
  });

  it("builds a zero-burn successor covenant that carries native reserve under a fee cap", () => {
    const successor = {
      address: 0x5678n,
      nullifierKeyCommitment: 0x2222n,
      ruleSetCommitment: 0x3333n,
      accountRevision: 1n,
      receiveKeyHash: 0n,
    };
    const accounts = new SparseMerkleTree(MERKLE_DEPTH);
    accounts.setLeaf(0, accountStateCommitment(
      successor.address,
      successor.nullifierKeyCommitment,
      successor.ruleSetCommitment,
      1n,
      successor.accountRevision,
      0n,
    ));
    const owner = {
      address: 0x1234n,
      nkRoot: 0x7777n,
      accountIndex: 1,
      accountSiblings: Array.from({ length: MERKLE_DEPTH }, () => 0n),
      accountRuleSetCommitment: 0x8888n,
      accountKind: 1n,
      accountRevision: 1n,
      receiveKeyHash: 0n,
      rule: {
        configurationCommitment: 0x9999n,
        commitmentBlinder: 1n,
        entryIndex: 0,
        siblings: Array.from({ length: 8 }, () => 0n),
      },
    };
    const covenantSnapshot = { ...snapshot, accountStateRoot: accounts.root };
    const build = buildAssetAction({
      pcashChainId: 0x1ff6n,
      snapshot: covenantSnapshot,
      assetId: descriptor.assetId,
      owner,
      inputs: [
        { kind: "asset", amount: 100n, noteSecret: 0x11n, leafIndex: 0, siblings: Array.from({ length: MERKLE_DEPTH }, () => 0n) },
        { kind: "native", amount: 10n, noteSecret: 0x12n, leafIndex: 1, siblings: Array.from({ length: MERKLE_DEPTH }, () => 0n) },
        { kind: "dummy" },
        { kind: "dummy" },
      ],
      outputs: [
        outOfBandAssetActionOutput({ kind: "asset", recipientAddress: successor.address, noteSecret: 0x21n, amount: 100n, outputData: sizeClassFiller() }),
        outOfBandAssetActionOutput({ kind: "native", recipientAddress: successor.address, noteSecret: 0x22n, amount: 9n, outputData: sizeClassFiller() }),
        { kind: "dummy", dummySecret: 0x23n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x24n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x25n, amount: 0n, outputData: sizeClassFiller() },
      ],
      openFeeAmount: 1n,
      issuanceOwnerCommitment: 0n,
      validUntilTimestamp: 100n,
      dummyInputSeed: 0x123n,
    });
    const witness = buildAssetCovenantRuleWitness({
      build,
      snapshot: covenantSnapshot,
      pcashChainId: 0x1ff6n,
      maxNativeOpenFeeAmount: 1n,
      successor: {
        ...successor,
        accountIndex: 0,
        accountSiblings: accounts.proof(0).siblings,
      },
      outputs: [
        { assetId: descriptor.assetId, amount: 100n, noteSecret: 0x21n },
        { assetId: 0n, amount: 9n, noteSecret: 0x22n },
        null,
        null,
        null,
      ],
    });
    expect(witness.configurationCommitment).toBe(assetCovenantSuccessorConfigurationCommitment({
      maxNativeOpenFeeAmount: 1n,
      successorAddress: successor.address,
      successorNullifierKeyCommitment: successor.nullifierKeyCommitment,
      successorRuleSetCommitment: successor.ruleSetCommitment,
      successorAccountRevision: successor.accountRevision,
      successorReceiveKeyHash: 0n,
    }));
    expect(witness.witnessMap.max_native_open_fee_amount).toBe(fieldToHex(1n));
    expect(() => buildAssetCovenantRuleWitness({
      ...{
        build,
        snapshot: covenantSnapshot,
        pcashChainId: 0x1ff6n,
        successor: { ...successor, accountIndex: 0, accountSiblings: accounts.proof(0).siblings },
        outputs: [
          { assetId: descriptor.assetId, amount: 100n, noteSecret: 0x21n },
          { assetId: 0n, amount: 9n, noteSecret: 0x22n },
          null,
          null,
          null,
        ] as const,
      },
      maxNativeOpenFeeAmount: 0n,
    })).toThrow("fee exceeds maxNativeOpenFeeAmount");
  });

  it("authenticates custom-contract liveness and persists fresh creation material before returning", async () => {
    const body: ContractBody = {
      nullifierKey: { publishesNkRoot: true, nkRoot: 0x7777n },
      functions: [{
        selector: functionSelector(0),
        applicationVkHash: 0x8888n,
        configurationCommitment: 0x9999n,
      }],
    };
    const verified = verifyContract(body);
    const manifest = verifyContractManifest(body, {
      schemaVersion: 1,
      contract: "distribution",
      functions: [{
        name: "release",
        selector: functionSelector(0),
        applicationVkHash: 0x8888n,
      }],
    });
    const accounts = new SparseMerkleTree(MERKLE_DEPTH);
    accounts.setLeaf(0, verified.accountStateCommitment);
    const recent = syntheticRecentBlockFixture({
      outputRoot: EMPTY_OUTPUT_ROOT,
      outputCount: 0,
      accountStateRoot: accounts.root,
      accountCount: 1,
    });
    const contractSnapshot = {
      recentPcashBlockHash: recent.recentPcashBlockHash,
      stateRoot: recent.stateRoot,
      stateRootHeaderSiblings: recent.stateRootHeaderSiblings,
      outputRoot: EMPTY_OUTPUT_ROOT,
      outputRootStateSiblings: recent.outputRootStateSiblings,
      accountStateRoot: accounts.root,
      accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
    };
    let persisted: FixedSupplyCreationMaterial | null = null;
    const result = await createFixedSupplyCreationToCustomContract({
      pcashChainId: 0x1ff6n,
      snapshot: contractSnapshot,
      owner: testOwner,
      metadata,
      initialSupply,
      contract: {
        body,
        manifest,
        assetFunctionName: "release",
        accountIndex: 0,
        accountSiblings: accounts.proof(0).siblings,
      },
      inventory: [{ noteSecret: 0xabcden, amount: initialSupply }],
      dummySecrets: [2n, 3n, 4n, 5n],
      validUntilTimestamp: 100n,
      dummyInputSeed: 0x123n,
      allowIrreversibleCustomContract: true,
      async persistCreationMaterial(material) {
        persisted = material;
      },
    });
    expect(persisted).not.toBeNull();
    expect(persisted!.assetSecret).toBe(result.asset.assetSecret);
    expect(persisted!.metadata).toEqual(metadata);
    expect(persisted!.inventoryOpenings).toEqual([{
      assetId: result.asset.descriptor.assetId,
      owner: verified.address,
      noteSecret: 0xabcden,
      amount: initialSupply,
      outputIndex: 0,
    }]);
    expect(result.build.operation).toBe("assetCreation");
    expect(result.build.address).toBe(testOwner.address);
    await expect(buildFixedSupplyCreationToCustomContract({
      pcashChainId: 0x1ff6n,
      owner: testOwner,
      snapshot: { ...contractSnapshot, recentPcashBlockHash: contractSnapshot.recentPcashBlockHash + 1n },
      asset: deterministicAsset,
      contract: {
        body,
        manifest,
        assetFunctionName: "release",
        accountIndex: 0,
        accountSiblings: accounts.proof(0).siblings,
      },
      inventory: [{ noteSecret: 1n, amount: initialSupply }],
      dummySecrets: [2n, 3n, 4n, 5n],
      validUntilTimestamp: 100n,
      allowIrreversibleCustomContract: true,
      persistCreationMaterial: async () => {},
    })).rejects.toThrow("not authenticated by recentPcashBlockHash");
  });
});

describe("asset account opening arity", () => {
  const vkFields = Array.from({ length: VK_LEN }, (_, i) => fieldToHex(BigInt(i + 1)));
  const vk = { vkFields, vkHash: fieldToHex(computeCircuitVkHash(vkFields)) };

  const ownerWith = (overrides: Record<string, unknown> = {}) => ({
    address: 0x1234n,
    nkRoot: 0x7777n,
    accountIndex: 0,
    accountSiblings: Array.from({ length: MERKLE_DEPTH }, () => 0n),
    accountRuleSetCommitment: 0x8888n,
    accountKind: 0n,
    accountRevision: 1n,
    receiveKeyHash: 0n,
    rule: {
      configurationCommitment: 0x9999n,
      commitmentBlinder: 1n,
      entryIndex: 0,
      siblings: Array.from({ length: 8 }, () => 0n),
    },
    ...overrides,
  });

  // An owner-authorized transfer: the only asset shape that opens an account.
  const transferWith = (owner: ReturnType<typeof ownerWith>) =>
    buildAssetAction({
      pcashChainId: 0x1ff6n,
      snapshot,
      assetId: creation().assetId,
      owner,
      inputs: [
        {
          kind: "asset",
          amount: initialSupply,
          noteSecret: 0x10n,
          leafIndex: 0,
          siblings: Array.from({ length: MERKLE_DEPTH }, () => 0n),
        },
        { kind: "dummy" },
        { kind: "dummy" },
        { kind: "dummy" },
      ],
      outputs: [
        outOfBandAssetActionOutput({
          kind: "asset",
          recipientAddress: 0x4321n,
          noteSecret: 0x20n,
          amount: initialSupply,
          outputData: sizeClassFiller(),
        }),
        { kind: "dummy", dummySecret: 0x21n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x22n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x23n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x24n, amount: 0n, outputData: sizeClassFiller() },
      ],
      openFeeAmount: 0n,
      issuanceOwnerCommitment: 0n,
      validUntilTimestamp: 100n,
      dummyInputSeed: 0x99n,
    } as never);

  it("rejects a short account path when building the kernel witness map", () => {
    const build = transferWith(
      ownerWith({ accountSiblings: Array.from({ length: MERKLE_DEPTH - 1 }, () => 0n) }),
    );
    expect(() => build.buildKernelWitnessMap(vk)).toThrow(/account siblings/);
  });

  it("rejects a short account-rule path when building the kernel witness map", () => {
    const build = transferWith(ownerWith({
      rule: {
        configurationCommitment: 0x9999n,
        commitmentBlinder: 1n,
        entryIndex: 0,
        siblings: [0n, 0n],
      },
    }));
    expect(() => build.buildKernelWitnessMap(vk)).toThrow(/account-rule siblings/);
  });

  it("accepts the correct arities", () => {
    const build = transferWith(ownerWith());
    expect(() => build.buildKernelWitnessMap(vk)).not.toThrow();
  });
});


it("recovers explicit data on reused asset change and private relay envelopes with only the outgoing key", () => {
  const outgoingKey = new Uint8Array(32).fill(19);
  const paidKey = generateMlKemKeyPair(), relayKey = generateMlKemKeyPair(), changeKey = generateMlKemKeyPair();
  const relayAddress = 0x5678n, paidAddress = 0x9999n, relaySecret = 0x123n, chainId = 0x1ff6n;
  const records = [{ schema: applicationSchemaId("com.example.private"), data: Uint8Array.of(8) }];
  const build = creation({
    sender: { outgoingKey },
    inputs: [
      { kind: "creation-marker" },
      { kind: "native", amount: 10n, noteSecret: 0x12n, leafIndex: 1, siblings: Array(40).fill(0n) },
      { kind: "dummy" }, { kind: "dummy" },
    ],
    outputs: [
      openedAssetActionOutput({ kind: "asset", pcashChainId: chainId, assetId: descriptor.assetId,
        outputIndex: 0, amount: 700n, recipientAddress: paidAddress, recipientMlKemPublicKey: paidKey.publicKey, authenticatedRecipient: true }),
      ownerChangeAssetActionOutput({ kind: "asset", pcashChainId: chainId, assetId: descriptor.assetId, amount: 300n, receiveKey: changeKey.publicKey }),
      ownerChangeAssetActionOutput({ kind: "native", pcashChainId: chainId, assetId: 0n, amount: 5n, receiveKey: changeKey.publicKey }),
      { kind: "dummy", dummySecret: 0x14n, amount: 0n },
      openedAssetActionOutput({ kind: "native", pcashChainId: chainId, assetId: 0n,
        outputIndex: 4, amount: 5n, noteSecret: relaySecret, recipientAddress: relayAddress, recipientMlKemPublicKey: relayKey.publicKey, authenticatedRecipient: true }),
    ],
    privateRelayPayment: { amount: 5n, ownerCommitment: ownerCommitment(relayAddress, relaySecret) },
    data: { recipients: [
      { recipientAddress: relayAddress, receiveKey: relayKey.publicKey, records },
      { recipientAddress: testOwner.address, receiveKey: changeKey.publicKey, records },
    ] },
  });
  const sent = recoverSentTransaction({ chainId, outgoingKey, transaction: {
    transactionType: 0, shape: build.shape,
    arena: { arena: build.arena, nullifiers: build.transaction.inputs.map(input => String(input.nullifier)) },
    outputs: build.outputData.map((outputData, slot) => ({ slot, leafIndex: BigInt(slot), outputData,
      outputCommitment: outputCommitment(build.transaction.outputs[slot]!.outputBodyCommitment, slot) })),
  } })!;
  expect(sent.messages.map(group => [group.slot, BigInt(group.to), group.records])).toEqual([
    [1, testOwner.address, records], [4, relayAddress, records],
  ]);
  expect(sent.outputs.map(output => [output.slot, output.amount, output.assetId])).toEqual([[0, 700n, descriptor.assetId]]);
});
