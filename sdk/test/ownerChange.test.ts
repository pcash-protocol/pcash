import { recordValue } from "./recordHelpers.ts";
import { assetDefinitionSchema } from "@pcash/sdk/protocol";
// Owner change under the readable rules opens under the owner's implicit note
// secret for both native and custom-asset notes.
// These tests pin the builder side of both facts: the derivation itself, the
// secrets the native and asset builders choose, and the early rejections that
// keep a proof from ever being attempted for a transaction the rule refuses.

import { describe, expect, it } from "vitest";
import { buildAssetAction } from "../src/builders/assetAction.ts";
import { authorizePcashRequestWithPrivateKey } from "../src/eip712/authorization.ts";
import {
  ownerChangeAssetActionOutput,
  type AssetActionInput,
  type AssetActionOutput,
} from "../src/builders/assetOutputs.ts";
import { ACCOUNT_KIND_USER, MERKLE_DEPTH } from "../src/constants/params.ts";
import { PCASH_CHAIN_ID } from "../src/constants/networkProfile.ts";
import { toField } from "../src/crypto/field.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { buildNativeTransfer, defaultEcdsaRuleSet } from "../src/builders/nativeTransfer.ts";
import { ecdsaRuleConfigurationCommitment } from "../src/rules/referenceRules.ts";
import {
  accountRuleEntryCommitment,
  accountStateCommitment,
  buildAccountRuleSet,
  computeCircuitVkHash,
  VK_LEN,
} from "../src/protocol/account.ts";
import { decodePayload, sizeClassFiller, trialOpenEnvelope } from "../src/protocol/envelope.ts";
import { outputRecords } from "../src/protocol/sectionDelivery.ts";
import { TX_KIND_PRIVATE_VALUE } from "../src/protocol/codec.ts";
import { assetDefinitionAssetId, type AssetDefinition } from "../src/protocol/assetDefinition.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import {
  fullOutputCommitment,
  noteBodyCommitment,
  noteNk,
  noteSecret,
  noteSecretSeed,
  nullifierKeyCommitment,
  ownerChangeNoteSecret,
  ownerCommitment,
} from "../src/protocol/notes.ts";
import { syntheticRecentBlockOpenings, TEST_DEFAULT_RULE_SECRETS } from "@pcash/test-support/protocol-fixtures";
import { deriveTestWallet } from "./testWallet.ts";

const wallet = deriveTestWallet({ mlKem: "deterministic" });
const chainId = PCASH_CHAIN_ID;
const RECIPIENT = 0x1234567890123456789012345678901234567890n;

function nullifiersOf(transaction: { inputs: readonly { nullifier: unknown }[] }): bigint[] {
  return transaction.inputs.map((input) => toField(input.nullifier as bigint));
}

describe("owner-change note secret", () => {
  it("is the owner's implicit note secret for the slot with zero entropy", () => {
    const nullifiers = [0x81n, 0x82n, 0x83n, 0x84n];
    expect(ownerChangeNoteSecret(wallet.nkRoot, nullifiers, 2)).toBe(
      noteSecret(noteSecretSeed(noteNk(wallet.nkRoot)), nullifiers, 2n, 0n),
    );
  });
});

describe("native transfer owner change", () => {
  function fourInputTransfer() {
    const secrets = [0x11n, 0x12n, 0x13n, 0x14n];
    const amounts = [400n, 300n, 200n, 100n];
    const outputTree = new SparseMerkleTree(MERKLE_DEPTH);
    secrets.forEach((secret, index) => {
      outputTree.setLeaf(index, fullOutputCommitment({
        owner: wallet.address,
        noteSecret: secret,
        assetId: 0n,
        amount: amounts[index]!,
      }, index));
    });
    const rules = defaultEcdsaRuleSet({ wallet, secrets: TEST_DEFAULT_RULE_SECRETS });
    const accountTree = new SparseMerkleTree(MERKLE_DEPTH);
    accountTree.setLeaf(0, accountStateCommitment(
      wallet.address,
      nullifierKeyCommitment(wallet.nkRoot),
      rules.ruleSetCommitment,
      0n,
      1n,
      0n,
    ));
    const recent = syntheticRecentBlockOpenings({
      outputRoot: outputTree.root,
      outputCount: 4,
      issuedSoFar: 0n,
      lagQ: 100n * 10n ** 18n * 2n ** 64n,
      accountStateRoot: accountTree.root,
      accountCount: 1,
    });
    return buildNativeTransfer({
      chainId,
      wallet,
      recipientAddress: RECIPIENT,
      paymentAmount: 700n,
      openFeeAmount: 10n,
      issuanceOwnerCommitment: 0n,
      inputs: secrets.map((secret, index) => ({
        amount: amounts[index]!,
        noteSecret: secret,
        outputIndex: index,
        siblings: outputTree.proof(index).siblings,
      })),
      defaultRuleSecrets: TEST_DEFAULT_RULE_SECRETS,
      outputRoot: outputTree.root,
      accountStateRoot: accountTree.root,
      accountSiblings: accountTree.proof(0).siblings,
      accountRevision: 1n,
      receiveKeyHash: 0n,
      validUntilTimestamp: 9_999_999n,
      outputData: [sizeClassFiller(), sizeClassFiller()],
      ...recent,
    });
  }

  it("derives the change secret from the published nullifiers even with four real inputs", () => {
    const build = fourInputTransfer();
    const expected = ownerChangeNoteSecret(wallet.nkRoot, nullifiersOf(build.transaction), 1);
    expect(build.outputNoteSecrets[1]).toBe(expected);
    expect(build.transaction.outputs[1]!.outputBodyCommitment).toBe(
      noteBodyCommitment(ownerCommitment(wallet.address, expected), 0n, 290n),
    );
    expect(build.outputNoteSecrets[0]).not.toBe(
      ownerChangeNoteSecret(wallet.nkRoot, nullifiersOf(build.transaction), 0),
    );
  });
});

describe("asset action owner change", () => {
  const definition: AssetDefinition = {
    initialSupply: 10n,
    assetSecretCommitment: 0x52n,
    metadata: { name: "Change Token", symbol: "CHG", decimals: 0, contentDigest: new Uint8Array(32) },
  };
  const assetId = assetDefinitionAssetId(definition);
  const assetSecret = 0x111n;
  const nativeSecret = 0x112n;
  const commitmentBlinder = 0x333n;
  const openFeeAmount = 3n;
  const authorizationVk = {
    vkFields: Array.from({ length: VK_LEN }, (_, index) => `0x${BigInt(index + 1).toString(16)}`),
  };
  const ruleEntry = accountRuleEntryCommitment(
    computeCircuitVkHash(authorizationVk.vkFields),
    ecdsaRuleConfigurationCommitment(DEFAULT_NETWORK_CONFIG, nullifierKeyCommitment(wallet.nkRoot)),
    commitmentBlinder,
  );
  const rules = buildAccountRuleSet([
    { entryIndex: 1, accountRuleEntryCommitment: ruleEntry },
    { entryIndex: 2, accountRuleEntryCommitment: ruleEntry },
    { entryIndex: 3, accountRuleEntryCommitment: ruleEntry },
  ]);

  function noteFundedBurn(params: {
    nativeInputAmount?: bigint;
    /** Asset input notes, at most three; the burn takes 3 of their total. */
    assetInputAmounts?: readonly bigint[];
    assetChange: AssetActionOutput;
    /** A second asset change note, in output slot 2. */
    secondAssetChange?: AssetActionOutput;
    nativeChange?: AssetActionOutput;
    /** Installed rule entry: 2 selects the burn rule, 3 the batch rule. */
    ruleEntry?: 2 | 3;
  }) {
    const entryIndex = params.ruleEntry ?? 2;
    const nativeInputAmount = params.nativeInputAmount ?? (openFeeAmount + (params.nativeChange?.kind === "native" ? params.nativeChange.amount : 0n));
    const assetInputAmounts = params.assetInputAmounts ?? [10n];
    const nativeLeaf = assetInputAmounts.length;
    const outputTree = new SparseMerkleTree(MERKLE_DEPTH);
    assetInputAmounts.forEach((amount, leaf) => {
      outputTree.setLeaf(leaf, fullOutputCommitment({
        owner: wallet.address,
        noteSecret: assetSecret + BigInt(leaf),
        assetId,
        amount,
      }, leaf));
    });
    if (nativeInputAmount !== 0n) {
      outputTree.setLeaf(nativeLeaf, fullOutputCommitment({
        owner: wallet.address,
        noteSecret: nativeSecret,
        assetId: 0n,
        amount: nativeInputAmount,
      }, nativeLeaf));
    }
    const accountTree = new SparseMerkleTree(MERKLE_DEPTH);
    accountTree.setLeaf(0, accountStateCommitment(
      wallet.address,
      nullifierKeyCommitment(wallet.nkRoot),
      rules.accountRuleSetCommitment,
      ACCOUNT_KIND_USER,
      1n,
      0n,
    ));
    const recent = syntheticRecentBlockOpenings({
      outputRoot: outputTree.root,
      outputCount: nativeLeaf + (nativeInputAmount === 0n ? 0 : 1),
      issuedSoFar: 0n,
      lagQ: 100n * 10n ** 18n * 2n ** 64n,
      accountStateRoot: accountTree.root,
      accountCount: 1,
    });
    const inputs: AssetActionInput[] = assetInputAmounts.map((amount, leaf) => ({
      kind: "asset", amount, noteSecret: assetSecret + BigInt(leaf), leafIndex: leaf, siblings: outputTree.proof(leaf).siblings,
    }));
    if (nativeInputAmount !== 0n) {
      inputs.push({ kind: "native", amount: nativeInputAmount, noteSecret: nativeSecret, leafIndex: nativeLeaf, siblings: outputTree.proof(nativeLeaf).siblings });
    }
    while (inputs.length < 4) inputs.push({ kind: "dummy" });
    const dummy = (dummySecret: bigint): AssetActionOutput => ({
      kind: "dummy",
      dummySecret,
      amount: 0n,
      outputData: sizeClassFiller(),
    });
    return buildAssetAction({
      pcashChainId: chainId,
      snapshot: {
        recentPcashBlockHash: recent.recentPcashBlockHash,
        stateRoot: recent.stateRoot,
        stateRootHeaderSiblings: recent.stateRootHeaderSiblings,
        outputRoot: outputTree.root,
        outputRootStateSiblings: recent.outputRootStateSiblings,
        accountStateRoot: accountTree.root,
        accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
      },
      assetId,
      assetBurnAmount: 3n,
      owner: {
        address: wallet.address,
        nkRoot: wallet.nkRoot,
        accountIndex: 0,
        accountSiblings: accountTree.proof(0).siblings,
        accountRuleSetCommitment: rules.accountRuleSetCommitment,
        accountKind: ACCOUNT_KIND_USER,
        accountRevision: 1n,
        receiveKeyHash: 0n,
        rule: {
          configurationCommitment: ecdsaRuleConfigurationCommitment(
            DEFAULT_NETWORK_CONFIG,
            nullifierKeyCommitment(wallet.nkRoot),
          ),
          commitmentBlinder,
          entryIndex,
          siblings: rules.membership(entryIndex).siblings,
        },
      },
      inputs,
      outputs: [
        params.assetChange,
        params.nativeChange ?? dummy(0x312n),
        params.secondAssetChange ?? dummy(0x313n),
        dummy(0x314n),
        dummy(0x315n),
      ],
      openFeeAmount,
      issuanceOwnerCommitment: 0n,
      validUntilTimestamp: 999_999n,
      dummyInputSeed: 0x999n,
    });
  }

  const ownerChange = (kind: "asset" | "native", amount: bigint) => ownerChangeAssetActionOutput({
    kind,
    pcashChainId: chainId,
    assetId: kind === "asset" ? assetId : 0n,
    amount,
    receiveKey: wallet.mlKemPublicKey,
  });

  it("resolves an owner-change output under the derived secret and exposes it", () => {
    const build = noteFundedBurn({ assetChange: ownerChange("asset", 7n) });
    const expected = ownerChangeNoteSecret(wallet.nkRoot, nullifiersOf(build.transaction), 0);
    expect(build.outputNoteSecrets[0]).toBe(expected);
    expect(build.transaction.outputs[0]!.outputBodyCommitment).toBe(
      noteBodyCommitment(ownerCommitment(wallet.address, expected), assetId, 7n),
    );
    expect(build.outputData[0]).toHaveLength(build.outputData[2]!.length);
    expect(() => build.prepareOwnerAuthorization({ wallet })).not.toThrow();
  });

  it("delivers the asset definition in the owner-change recipient region", () => {
    const build = noteFundedBurn({
      assetChange: ownerChangeAssetActionOutput({
        kind: "asset", pcashChainId: chainId, assetId, amount: 7n, receiveKey: wallet.mlKemPublicKey, assetDefinition: definition,
      }),
    });
    const opened = trialOpenEnvelope(wallet.mlKemSecretKey, build.outputData[0]!)!;
    const payload = decodePayload(opened.plaintext, { chainId });
    expect(payload.noteSecret).toBe(build.outputNoteSecrets[0]);
    expect(payload.anchor).toBeDefined();
    const records = outputRecords(payload, opened.sharedSecret, {
      arena: build.arena,
      shape: build.shape,
      context: { chainId, transactionType: TX_KIND_PRIVATE_VALUE, nullifiers: nullifiersOf(build.transaction) },
    });
    expect(recordValue(records, assetDefinitionSchema)).toEqual(definition);
  });

  it("signs an explicit native self-payment funded by notes", () => {
    const build = noteFundedBurn({
      assetChange: ownerChange("asset", 7n),
      nativeChange: {
        kind: "native",
        destination: { kind: "opening", recipientAddress: wallet.address, noteSecret: 0x212n },
        amount: 50n,
        outputData: sizeClassFiller(),
        delivery: { kind: "out-of-band" },
      },
      ruleEntry: 3,
    });
    const prepared = build.prepareOwnerAuthorization({ wallet });
    expect(prepared.authorizationKind).toBe("batch-transfer");
    const { witnessMap } = prepared.authorize(
      authorizePcashRequestWithPrivateKey(wallet.privKey, prepared.request),
    );
    const declared = witnessMap.outputs as Array<Record<string, string>>;
    expect(BigInt(declared[1]!.recipient!)).toBe(wallet.address);
    expect(BigInt(declared[1]!.amount!)).toBe(50n);
    expect(BigInt(declared[0]!.recipient!)).toBe(0n);
    const secrets = witnessMap.output_note_secrets as string[];
    expect(BigInt(secrets[0]!)).toBe(0n);
    expect(BigInt(secrets[1]!)).toBe(0x212n);
  });

  it("derives native change from an ordinary native input", () => {
    const build = noteFundedBurn({ nativeInputAmount: 7n, assetChange: ownerChange("asset", 7n), nativeChange: ownerChange("native", 4n) });
    expect(build.outputNoteSecrets[1]).toBe(ownerChangeNoteSecret(wallet.nkRoot, nullifiersOf(build.transaction), 1));
    expect(() => build.prepareOwnerAuthorization({ wallet })).not.toThrow();
  });
  // The readable rules prove one split of owner change per namespace: full-size
  // notes, then one remainder.
  const MAX_NOTE_AMOUNT = (1n << 128n) - 1n;

  it("refuses to request a signature for owner change split any other way", () => {
    const build = noteFundedBurn({ assetChange: ownerChange("asset", 3n), secondAssetChange: ownerChange("asset", 4n) });
    expect(() => build.prepareOwnerAuthorization({ wallet })).toThrow(
      "outputs[2] is asset owner change after outputs[0], which is below the largest note amount; "
      + "split owner change into full-size notes followed by one remainder",
    );
  });

  it.each([
    ["a full-size note and a remainder", [MAX_NOTE_AMOUNT, 10n], 7n],
    ["two full-size notes", [MAX_NOTE_AMOUNT, MAX_NOTE_AMOUNT, 3n], MAX_NOTE_AMOUNT],
  ] as const)("prepares owner change split into %s", (_label, assetInputAmounts, lastChange) => {
    const build = noteFundedBurn({
      assetInputAmounts,
      assetChange: ownerChange("asset", MAX_NOTE_AMOUNT),
      secondAssetChange: ownerChange("asset", lastChange),
    });
    const prepared = build.prepareOwnerAuthorization({ wallet });
    const { witnessMap } = prepared.authorize(authorizePcashRequestWithPrivateKey(wallet.privKey, prepared.request));
    expect((witnessMap.owner_change_amounts as string[]).map(BigInt)).toEqual([MAX_NOTE_AMOUNT, 0n, lastChange, 0n, 0n]);
  });

  it("rejects native input that cannot cover the fee", () => {
    expect(() => noteFundedBurn({ nativeInputAmount: 2n, assetChange: ownerChange("asset", 7n) })).toThrow();
  });

});
