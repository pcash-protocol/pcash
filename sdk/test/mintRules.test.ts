// The standard mint rules: configuration openings, recognition and labels, and
// the refusals of their witness builders. The rules' circuits are executed in
// restrictedKernel.test.ts and proved in recursiveComposition.proving.test.ts.

import { describe, expect, it } from "vitest";
import { buildAssetAction, type AssetActionBuild } from "../src/builders/assetAction.ts";
import { openedAssetActionOutput, type AssetActionInput, type AssetActionOutput } from "../src/builders/assetOutputs.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { REFERENCE_FIXED_SUPPLY_CONFIGURATION_DOMAIN } from "../src/constants/referenceRuleConstants.ts";
import { ACCOUNT_MINT_RULE_VK_HASH, FIXED_SUPPLY_RULE_VK_HASH } from "../src/constants/rulePins.ts";
import { fieldToHex } from "../src/crypto/field.ts";
import { poseidon } from "../src/crypto/poseidon2.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { accountRuleEntryCommitment, accountStateCommitment, buildAccountRuleSet } from "../src/protocol/account.ts";
import type { AssetDescriptor } from "../src/protocol/asset.ts";
import type { PortableMintRule } from "../src/protocol/assetDefinition.ts";
import { sizeClassFiller } from "../src/protocol/envelope.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { fullOutputCommitment, nullifierKeyCommitment } from "../src/protocol/notes.ts";
import { mintActionCommitment } from "../src/protocol/statement.ts";
import {
  accountMintRule,
  accountMintWitness,
  createAccountMintAsset,
  decodeAccountMintConfiguration,
} from "../src/rules/accountMint.ts";
import {
  MAX_FIXED_SUPPLY,
  decodeFixedSupplyConfiguration,
  deriveFixedSupplyAsset,
  fixedSupplyMintRule,
  fixedSupplyMintWitness,
  fixedSupplySecretCommitment,
} from "../src/rules/fixedSupply.ts";
import { mintRuleLabel, namesStandardMintRule, recognizeMintRule } from "../src/rules/mintRules.ts";
import { defaultUserAccountRuleSet, ecdsaRuleConfigurationCommitment } from "../src/rules/referenceRules.ts";
import { beBytes, concatBytes, field32 } from "../src/utils/bytes.ts";
import { syntheticRecentBlockFixture, TEST_DEFAULT_RULE_SECRETS } from "@pcash/test-support/protocol-fixtures";
import { assetProfileFixture } from "./assetProfileFixtures.ts";
import { deriveTestWallet } from "./testWallet.ts";

const secretCommitment = fixedSupplySecretCommitment(987n);
const fixed = fixedSupplyMintRule({ supply: 1_000n, secretCommitment });
const account = accountMintRule({ accountAddress: 0xab12n });

const withByte = (bytes: Uint8Array, index: number, value: number) => {
  const copy = Uint8Array.from(bytes);
  copy[index] = value;
  return copy;
};

describe("standard mint rule configurations", () => {
  it("opens a fixed supply as its 17-byte supply and 32-byte secret commitment", () => {
    expect(fixed.configuration).toEqual(concatBytes(beBytes(1_000n, 17), field32(secretCommitment)));
    expect(decodeFixedSupplyConfiguration(fixed.configuration)).toEqual({ supply: 1_000n, secretCommitment });
    expect(fixed.sVkHash).toBe(FIXED_SUPPLY_RULE_VK_HASH);
    expect(fixed.lVkHash).toBe(FIXED_SUPPLY_RULE_VK_HASH);
  });

  it("opens an account mint as the account's 20-byte address", () => {
    expect(account.configuration).toEqual(beBytes(0xab12n, 20));
    expect(decodeAccountMintConfiguration(account.configuration)).toEqual({ accountAddress: 0xab12n });
    expect(account.sVkHash).toBe(ACCOUNT_MINT_RULE_VK_HASH);
    expect(account.lVkHash).toBe(ACCOUNT_MINT_RULE_VK_HASH);
  });

  it("bounds a fixed supply to what one mint carries and an account to an address", () => {
    expect(fixedSupplyMintRule({ supply: MAX_FIXED_SUPPLY, secretCommitment }).configuration.length).toBe(49);
    expect(() => fixedSupplyMintRule({ supply: MAX_FIXED_SUPPLY + 1n, secretCommitment })).toThrow("supply exceeds what one mint can carry");
    expect(() => accountMintRule({ accountAddress: 1n << 160n })).toThrow(/accountAddress/);
  });
});

describe("mint rule recognition", () => {
  it("recognizes and labels each standard rule", () => {
    expect(recognizeMintRule(fixed)).toEqual({ kind: "fixed-supply", configuration: { supply: 1_000n, secretCommitment } });
    expect(mintRuleLabel(fixed)).toBe("fixed supply 1000");
    expect(recognizeMintRule(account)).toEqual({ kind: "account-mint", configuration: { accountAddress: 0xab12n } });
    expect(mintRuleLabel(account)).toBe("minted at the discretion of account 0x000000000000000000000000000000000000ab12");
    expect(namesStandardMintRule(fixed)).toBe(true);
    expect(namesStandardMintRule(account)).toBe(true);
  });

  const oversupply = concatBytes(beBytes(MAX_FIXED_SUPPLY + 1n, 17), field32(secretCommitment));
  it.each<[string, PortableMintRule]>([
    ["a fixed-supply opening with a changed byte", { ...fixed, configuration: withByte(fixed.configuration, 16, 0xe9) }],
    ["a fixed-supply opening one byte longer", { ...fixed, configuration: concatBytes(fixed.configuration, Uint8Array.of(0)) }],
    ["a fixed-supply opening one byte shorter", { ...fixed, configuration: fixed.configuration.subarray(1) }],
    // The commitment opens but for the supply bound.
    ["a supply above what one mint carries", {
      ...fixed,
      configurationCommitment: poseidon([REFERENCE_FIXED_SUPPLY_CONFIGURATION_DOMAIN, MAX_FIXED_SUPPLY + 1n, secretCommitment]),
      configuration: oversupply,
    }],
    ["a secret commitment outside the field", { ...fixed, configuration: concatBytes(beBytes(1_000n, 17), new Uint8Array(32).fill(0xff)) }],
    ["an account-mint opening with a changed byte", { ...account, configuration: withByte(account.configuration, 19, 0x13) }],
    ["an account-mint opening one byte longer", { ...account, configuration: concatBytes(Uint8Array.of(0), account.configuration) }],
    ["a fixed-supply configuration under the account-mint keys", { ...fixed, sVkHash: ACCOUNT_MINT_RULE_VK_HASH, lVkHash: ACCOUNT_MINT_RULE_VK_HASH }],
    ["an account-mint configuration under the fixed-supply keys", { ...account, sVkHash: FIXED_SUPPLY_RULE_VK_HASH, lVkHash: FIXED_SUPPLY_RULE_VK_HASH }],
  ])("treats a standard key pair with %s as custom", (_name, rule) => {
    expect(recognizeMintRule(rule)).toEqual({ kind: "custom" });
    expect(mintRuleLabel(rule)).toBe("custom mint rule");
    expect(namesStandardMintRule(rule)).toBe(true);
  });

  it.each<[string, PortableMintRule]>([
    ["only the S key of the fixed-supply rule", { ...fixed, lVkHash: 0n }],
    ["only the L key of the fixed-supply rule", { ...fixed, sVkHash: 0x1234n }],
    ["only the L key of the account-mint rule", { ...account, sVkHash: 0n }],
    ["one key of each standard rule", { ...fixed, lVkHash: ACCOUNT_MINT_RULE_VK_HASH }],
    ["no standard key", { ...fixed, sVkHash: 0x3131n, lVkHash: 0x3232n }],
  ])("treats a rule naming %s as custom", (_name, rule) => {
    expect(recognizeMintRule(rule)).toEqual({ kind: "custom" });
    expect(mintRuleLabel(rule)).toBe("custom mint rule");
    expect(namesStandardMintRule(rule)).toBe(false);
  });
});

const metadata = { name: "Mint Rules", symbol: "MNT", decimals: 0, contentDigest: new Uint8Array(32) };
const wallet = deriveTestWallet({ mlKem: "deterministic" });
const recipient = deriveTestWallet({ privKey: new Uint8Array(32).fill(7), nkRoot: 456n, mlKem: "deterministic" });
const chainId = BigInt(DEFAULT_NETWORK_CONFIG.pcashChainId);

/**
 * A profile S mint of `descriptor` by `wallet`, which pays the open fee from one
 * native note: one mint marker per replay ID and one asset output per amount.
 */
function mint(params: { descriptor: AssetDescriptor; replayIds: readonly bigint[]; amounts: readonly bigint[] }): AssetActionBuild {
  const profile = PRIVATE_VALUE_PROFILES.S;
  const rule = defaultUserAccountRuleSet({ wallet, secrets: TEST_DEFAULT_RULE_SECRETS }).mintRule;
  const configurationCommitment = ecdsaRuleConfigurationCommitment(DEFAULT_NETWORK_CONFIG, nullifierKeyCommitment(wallet.nkRoot));
  const set = buildAccountRuleSet([{ entryIndex: rule.entryIndex, accountRuleEntryCommitment: accountRuleEntryCommitment(
    rule.applicationVkHash, configurationCommitment, rule.commitmentBlinder,
  ) }]);
  const outputs = new SparseMerkleTree(40);
  const accounts = new SparseMerkleTree(40);
  outputs.setLeaf(0, fullOutputCommitment({ owner: wallet.address, noteSecret: 99n, assetId: 0n, amount: 10n }, 0));
  accounts.setLeaf(0, accountStateCommitment(wallet.address, nullifierKeyCommitment(wallet.nkRoot), set.accountRuleSetCommitment, 0n, 1n, 0n));
  const recent = syntheticRecentBlockFixture({ outputRoot: outputs.root, outputCount: 1, issuedSoFar: 10n,
    lagQ: 100n, accountStateRoot: accounts.root, accountCount: 1 });
  const inputs: AssetActionInput[] = Array.from({ length: profile.inputs }, () => ({ kind: "dummy" }));
  params.replayIds.forEach((replayId, slot) => { inputs[slot] = { kind: "mint-marker", replayId }; });
  inputs[profile.inputs - 1] = { kind: "native", noteSecret: 99n, amount: 10n, leafIndex: 0, siblings: outputs.proof(0).siblings };
  const outputSlots: AssetActionOutput[] = Array.from({ length: profile.outputs }, (_, slot) => ({
    kind: "dummy", dummySecret: BigInt(slot + 123), amount: 0n, outputData: sizeClassFiller(),
  }));
  params.amounts.forEach((amount, slot) => {
    outputSlots[slot] = openedAssetActionOutput({ kind: "asset", pcashChainId: chainId, assetId: params.descriptor.assetId,
      outputIndex: slot, noteSecret: 777n + BigInt(slot), amount, recipientAddress: recipient.address,
      recipientMlKemPublicKey: recipient.mlKemPublicKey!, authenticatedRecipient: true });
  });
  return buildAssetAction({
    shape: profile.shapeId, pcashChainId: chainId, mint: { descriptor: params.descriptor },
    snapshot: {
      recentPcashBlockHash: recent.recentPcashBlockHash, stateRoot: recent.stateRoot,
      stateRootHeaderSiblings: recent.stateRootHeaderSiblings, outputRoot: outputs.root,
      outputRootStateSiblings: recent.outputRootStateSiblings, accountStateRoot: accounts.root,
      accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
    },
    owner: { address: wallet.address, nkRoot: wallet.nkRoot, accountIndex: 0, accountSiblings: accounts.proof(0).siblings,
      accountRuleSetCommitment: set.accountRuleSetCommitment, accountKind: 0n, accountRevision: 1n, receiveKeyHash: 0n,
      rule: { configurationCommitment, commitmentBlinder: rule.commitmentBlinder, entryIndex: rule.entryIndex,
        siblings: set.membership(rule.entryIndex).siblings } },
    inputs, outputs: outputSlots, openFeeAmount: 10n, issuanceOwnerCommitment: 0n, validUntilTimestamp: 999_999n, dummyInputSeed: 345n,
  });
}

describe("fixed-supply mint witness", () => {
  const secret = 987n;
  const { descriptor } = deriveFixedSupplyAsset({ metadata, supply: 1_000n, secret });
  const configuration = { supply: 1_000n, secretCommitment };

  it("reads the secret and the outputs of a mint that carries the whole supply", () => {
    const build = mint({ descriptor, replayIds: [secret], amounts: [600n, 400n] });
    const witness = fixedSupplyMintWitness({ mint: build, configuration, secret });
    expect(witness.secret).toBe(fieldToHex(secret));
    expect(witness.configuration).toEqual({ supply: fieldToHex(1_000n), secret_commitment: fieldToHex(secretCommitment) });
    expect(witness.account_address).toBe(fieldToHex(wallet.address));
    expect((witness.output_amounts as string[]).slice(0, 2)).toEqual([fieldToHex(600n), fieldToHex(400n)]);
  });

  it("refuses a secret or configuration the asset's rule does not commit to", () => {
    const fixture = assetProfileFixture({ shape: PRIVATE_VALUE_PROFILES.L.shapeId });
    expect(fixture.mintRule.witnessMap.secret).toBe(fieldToHex(fixture.secret));
    expect(() => fixedSupplyMintWitness({ mint: fixture.build, configuration: fixture.configuration, secret: fixture.secret + 1n }))
      .toThrow("the secret does not open the asset's secret commitment");
    expect(() => fixedSupplyMintWitness({ mint: fixture.build, configuration: { ...fixture.configuration, supply: 999n }, secret: fixture.secret }))
      .toThrow("the configuration does not open the asset's mint rule");
  });

  it.each([
    ["a second marker", [secret, 5n]],
    ["a marker keyed by another replay ID", [5n]],
  ])("refuses a mint with %s", (_name, replayIds) => {
    const build = mint({ descriptor, replayIds, amounts: [1_000n] });
    expect(() => fixedSupplyMintWitness({ mint: build, configuration, secret }))
      .toThrow("a fixed-supply mint carries exactly one mint marker, keyed by its secret");
  });

  it.each([["less than", [999n]], ["more than", [600n, 401n]]])("refuses asset outputs totalling %s the supply", (_name, amounts) => {
    const build = mint({ descriptor, replayIds: [secret], amounts });
    expect(() => fixedSupplyMintWitness({ mint: build, configuration, secret }))
      .toThrow("a fixed-supply mint's asset outputs must total its supply");
  });
});

describe("account-mint witness", () => {
  it("reads the configured account's mint action", () => {
    const { descriptor } = createAccountMintAsset({ metadata, accountAddress: wallet.address, startSalt: 0n });
    const build = mint({ descriptor, replayIds: [1n, 2n], amounts: [5n] });
    const witness = accountMintWitness({ mint: build, configuration: { accountAddress: wallet.address } });
    expect(witness.account_address).toBe(fieldToHex(wallet.address));
    expect(witness.action_commitment).toBe(fieldToHex(mintActionCommitment(chainId, build.privateValueCommitment, descriptor.assetId)));
    expect(witness.valid_until_timestamp).toBe(fieldToHex(999_999n));
  });

  it("refuses a mint by an account other than the configured one", () => {
    const other = 0xab12n;
    const { descriptor } = createAccountMintAsset({ metadata, accountAddress: other, startSalt: 0n });
    const build = mint({ descriptor, replayIds: [1n], amounts: [5n] });
    expect(() => accountMintWitness({ mint: build, configuration: { accountAddress: other } }))
      .toThrow("only the asset's configured account mints it");
    expect(() => accountMintWitness({ mint: build, configuration: { accountAddress: wallet.address } }))
      .toThrow("the configuration does not open the asset's mint rule");
  });

  it("refuses a mint of an asset under another rule", () => {
    const fixture = assetProfileFixture({ shape: PRIVATE_VALUE_PROFILES.S.shapeId });
    expect(() => accountMintWitness({ mint: fixture.build, configuration: { accountAddress: fixture.wallet.address } }))
      .toThrow("the configuration does not open the asset's mint rule");
  });
});
