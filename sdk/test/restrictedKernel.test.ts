// Constraint tests for the restricted-transfer, restricted sponsored-transfer
// and mint kernels, and the standard mint rules, with real builder witnesses. ACVM execution does NOT check recursive proofs, so these
// cover statement and field constraints, not VK splicing.
import { join } from "node:path";
import { Noir } from "@noir-lang/noir_js";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAssetAction, type AssetActionBuild } from "../src/builders/assetAction.ts";
import { openedAssetActionOutput, ownerChangeAssetActionOutput, type AssetActionInput, type AssetActionOutput } from "../src/builders/assetOutputs.ts";
import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "../src/constants/privateValueProfiles.ts";
import { fieldToHex } from "../src/crypto/field.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { createChonkCircuitResolver } from "../src/node/chonkMaterial.ts";
import type { ChonkCircuitMaterial } from "../src/prover/stacks.ts";
import { accountRuleEntryCommitment, accountStateCommitment, buildAccountRuleSet } from "../src/protocol/account.ts";
import {
  assetCoreCommitment, assetIdOf, findAssetDescriptor, mintContext, policyContext, restrictedAssetOpening, transferRuleCommitment,
  type AssetDescriptor, type RestrictedAssetOpening, type TransferRule,
} from "../src/protocol/asset.ts";
import { sizeClassFiller } from "../src/protocol/envelope.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { fullOutputCommitment, nullifierKeyCommitment } from "../src/protocol/notes.ts";
import { mintActionCommitment, ruleStatement, sponsoredTransferActionCommitment, transferActionCommitment } from "../src/protocol/statement.ts";
import { SlotClass } from "../src/protocol/transaction.ts";
import type { LocalWalletProfile, WalletProfileWithReceiveKeys } from "../src/protocol/types.ts";
import type { WitnessMap } from "../src/protocol/witness.ts";
import { defaultUserAccountRuleSet, ecdsaRuleConfigurationCommitment, type DefaultUserAccountRule } from "../src/rules/referenceRules.ts";
import { ACCOUNT_MINT_RULE_CIRCUIT, accountMintConfigurationCommitment, accountMintWitness } from "../src/rules/accountMint.ts";
import { FIXED_SUPPLY_RULE_CIRCUIT } from "../src/rules/fixedSupply.ts";
import { DEPOSIT_MINT_RULE_CIRCUIT } from "../src/rules/depositMint.ts";
import { syntheticRecentBlockFixture, TEST_DEFAULT_RULE_SECRETS, TEST_MINT_RULE } from "@pcash/test-support/protocol-fixtures";
import { VOUCHER_RULE_CIRCUIT, voucherMintFixture } from "@pcash/test-support/voucher-mint-fixtures";
import { depositMintFixture } from "@pcash/test-support/deposit-mint-fixtures";
import { assetProfileFixture } from "./assetProfileFixtures.ts";
import { proverAssetsDir } from "./circuitBundle.ts";
import { noOpEventApplicationWitness } from "./noOpEventApplication.ts";
import { restrictedSponsoredTransferFixture } from "@pcash/test-support/restricted-fixtures";
import { deriveTestWallet } from "./testWallet.ts";

const resolve = createChonkCircuitResolver({
  artifactDirectory: proverAssetsDir(),
  verificationKeyDirectory: join(process.env.PCASH_CIRCUIT_BUNDLE!, "vks"),
});

function replace(map: WitnessMap, path: string, value?: unknown): WitnessMap {
  const copy = structuredClone(map);
  const keys = path.split(".");
  let parent = copy;
  for (const key of keys.slice(0, -1)) parent = parent[key] as WitnessMap;
  const key = keys.at(-1)!;
  // Fail in the test, not in ABI encoding, if a witness field is renamed.
  expect(parent[key], path).not.toBeUndefined();
  parent[key] = value ?? `0x${(BigInt(parent[key] as string) + 1n).toString(16)}`;
  return copy;
}

async function execute(material: ChonkCircuitMaterial, map: WitnessMap) {
  return new Noir(material.artifact as never).execute(map as never);
}

const STATEMENT_MISMATCH = /rule statement must match the kernel's statement/;
const EVENT_MISMATCH = /event must bind the transaction action/;
const NOTE_MISMATCH = /input note must be in the output tree/;
const VK_HASH_MISMATCH = /verification key hash must match the key/;
const MARKER_COUNT = /a mint carries at least one mint marker/;
// The asset-class range checks fail with Noir's own message for assert_max_bit_size.
const CLASS_CHECK = /call to assert_max_bit_size/;

const CLASS_BOUND = 1n << 252n;
type AssetClass = "unrestricted" | "restricted" | "neither";
function assetClass(id: bigint): AssetClass {
  if (id !== 0n && id < CLASS_BOUND) return "unrestricted";
  if (id >= CLASS_BOUND && id < 2n * CLASS_BOUND) return "restricted";
  return "neither";
}

const CHAIN_ID = BigInt(DEFAULT_NETWORK_CONFIG.pcashChainId);
const POLICY_PACKAGE = "transfer_rule_sender_deny_list";
const POLICY_CONFIGURATION = 0xc0f16n;
// The transfer rule's VK hash for the profile the kernel does not fold.
const OTHER_PROFILE_VK_HASH = 0xa11cen;
const HELD = 100n;
const NOTE_SECRET = 0x5ec2n;
const VALID_UNTIL = 1_700_001_800n;

const kernelName = (shape: PrivateValueShape, kernel: string) =>
  `${shape === PRIVATE_VALUE_PROFILES.L.shapeId ? "private_value_large" : "private_value"}_${kernel}_kernel`;

type Wallet = LocalWalletProfile & WalletProfileWithReceiveKeys;

/** One account with one installed rule entry, as a leaf and as the builder's owner. */
function installedAccount(wallet: Wallet, rule: DefaultUserAccountRule, vkHash: bigint) {
  const configurationCommitment = ecdsaRuleConfigurationCommitment(DEFAULT_NETWORK_CONFIG, nullifierKeyCommitment(wallet.nkRoot));
  const set = buildAccountRuleSet([{ entryIndex: rule.entryIndex, accountRuleEntryCommitment: accountRuleEntryCommitment(
    vkHash, configurationCommitment, rule.commitmentBlinder,
  ) }]);
  return {
    leaf: accountStateCommitment(wallet.address, nullifierKeyCommitment(wallet.nkRoot), set.accountRuleSetCommitment, 0n, 1n, 0n),
    owner: (accounts: SparseMerkleTree, accountIndex: number) => ({
      address: wallet.address, nkRoot: wallet.nkRoot, accountIndex, accountSiblings: accounts.proof(accountIndex).siblings,
      accountRuleSetCommitment: set.accountRuleSetCommitment, accountKind: 0n, accountRevision: 1n, receiveKeyHash: 0n,
      rule: { configurationCommitment, commitmentBlinder: rule.commitmentBlinder, entryIndex: rule.entryIndex,
        siblings: set.membership(rule.entryIndex).siblings },
    }),
  };
}

function snapshotOf(outputs: SparseMerkleTree, outputCount: number, accounts: SparseMerkleTree, accountCount: number) {
  const recent = syntheticRecentBlockFixture({ outputRoot: outputs.root, outputCount, issuedSoFar: 0n, lagQ: 100n,
    accountStateRoot: accounts.root, accountCount });
  return {
    recentPcashBlockHash: recent.recentPcashBlockHash, stateRoot: recent.stateRoot,
    stateRootHeaderSiblings: recent.stateRootHeaderSiblings, outputRoot: outputs.root,
    outputRootStateSiblings: recent.outputRootStateSiblings, accountStateRoot: accounts.root,
    accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
  };
}

const dummyOutputs = (count: number): AssetActionOutput[] => Array.from({ length: count }, (_, i) => ({
  kind: "dummy", dummySecret: BigInt(i + 321), amount: 0n, outputData: sizeClassFiller(),
}));

/** The owner's rule the readable-rule builder selects for a restricted payment or burn. */
function restrictedRule(shape: PrivateValueShape, burn: boolean, wallet: Wallet) {
  const defaults = defaultUserAccountRuleSet({ wallet, secrets: TEST_DEFAULT_RULE_SECRETS });
  if (shape === PRIVATE_VALUE_PROFILES.L.shapeId) return { rule: defaults.largeBatchTransferRule, circuit: "account_rule_large_batch_transfer_ecdsa" };
  return burn
    ? { rule: defaults.assetBurnRule, circuit: "account_rule_asset_burn_ecdsa" }
    : { rule: defaults.assetPaymentRule, circuit: "account_rule_asset_payment_ecdsa" };
}

/** This profile's transfer rule with `ownVkHash` for the folded policy and a distinct hash for the other profile. */
function transferRuleFor(shape: PrivateValueShape, ownVkHash: bigint): TransferRule {
  return shape === PRIVATE_VALUE_PROFILES.L.shapeId
    ? { sVkHash: OTHER_PROFILE_VK_HASH, lVkHash: ownVkHash, configurationCommitment: POLICY_CONFIGURATION }
    : { sVkHash: ownVkHash, lVkHash: OTHER_PROFILE_VK_HASH, configurationCommitment: POLICY_CONFIGURATION };
}

/**
 * The owner spends one restricted note of HELD: a payment of 60 with change of
 * 40, or a burn of all of it with no outputs.
 */
function restrictedAction(params: { shape: PrivateValueShape; authorizationVkHash: bigint; transferRule: TransferRule; burn?: boolean }) {
  const profile = privateValueProfile(params.shape);
  const burn = params.burn === true;
  const wallet = deriveTestWallet({ mlKem: "deterministic" });
  const recipient = deriveTestWallet({ privKey: new Uint8Array(32).fill(7), nkRoot: 456n, mlKem: "deterministic" });
  const descriptor = findAssetDescriptor({
    metadataCommitment: 0x5ca1en,
    mintRule: TEST_MINT_RULE,
    transferRule: params.transferRule,
  }, 0n);
  const assetId = descriptor.assetId;
  // Held by reference: the zero-hash test builds the witness from this object.
  const opening: RestrictedAssetOpening = { ...restrictedAssetOpening(descriptor)!, transferRule: { ...params.transferRule } };
  const { rule, circuit } = restrictedRule(params.shape, burn, wallet);
  const account = installedAccount(wallet, rule, params.authorizationVkHash);
  const outputs = new SparseMerkleTree(40);
  outputs.setLeaf(0, fullOutputCommitment({ owner: wallet.address, noteSecret: NOTE_SECRET, assetId, amount: HELD }, 0));
  const accounts = new SparseMerkleTree(40);
  accounts.setLeaf(0, account.leaf);
  const inputs: AssetActionInput[] = Array.from({ length: profile.inputs }, () => ({ kind: "dummy" }));
  inputs[0] = { kind: "asset", amount: HELD, noteSecret: NOTE_SECRET, leafIndex: 0, siblings: outputs.proof(0).siblings };
  const outputSlots = dummyOutputs(profile.outputs);
  if (!burn) {
    outputSlots[0] = openedAssetActionOutput({ kind: "asset", pcashChainId: CHAIN_ID, assetId, outputIndex: 0, noteSecret: 0x777n, amount: 60n,
      recipientAddress: recipient.address, recipientMlKemPublicKey: recipient.mlKemPublicKey!, authenticatedRecipient: true });
    outputSlots[1] = ownerChangeAssetActionOutput({ kind: "asset", pcashChainId: CHAIN_ID, assetId, amount: HELD - 60n, receiveKey: wallet.mlKemPublicKey! });
  }
  const build = buildAssetAction({
    shape: params.shape, pcashChainId: CHAIN_ID, snapshot: snapshotOf(outputs, 1, accounts, 1), assetId, restricted: opening,
    owner: account.owner(accounts, 0), inputs, outputs: outputSlots, openFeeAmount: 0n, issuanceOwnerCommitment: 0n,
    validUntilTimestamp: VALID_UNTIL, dummyInputSeed: 0x5eedn, ...(burn ? { assetBurnAmount: HELD } : {}),
  });
  expect(build.prepareOwnerAuthorization({ wallet }).authorizationCircuit).toBe(circuit);
  return { build, opening, wallet };
}

async function restrictedKernelMap(build: AssetActionBuild, authorization: ChonkCircuitMaterial, policy: ChonkCircuitMaterial) {
  const map = build.buildRestrictedKernelWitnessMap(authorization, policy);
  return { ...map, ...await noOpEventApplicationWitness(resolve, map) };
}

/** The same action presented to the unrestricted kernel: the derived asset ID in place of the opening and policy. */
function asTransferKernelMap(map: WitnessMap, assetId: bigint): WitnessMap {
  const { asset: _asset, policy_statement: _statement, policy_vk: _vk, ...rest } = map;
  return { ...rest, asset_id: fieldToHex(assetId) };
}

/** The first candidate after `value` that derives another ID in the restricted class. */
function inClassSubstitute(value: bigint, derive: (candidate: bigint) => bigint, original: bigint): bigint {
  for (let candidate = value + 1n; ; candidate += 1n) {
    const id = derive(candidate);
    if (id !== original && assetClass(id) === "restricted") return candidate;
  }
}

const MINTER = deriveTestWallet({ mlKem: "deterministic" });
const OTHER_ACCOUNT = deriveTestWallet({ privKey: new Uint8Array(32).fill(9), nkRoot: 789n, mlKem: "deterministic" });
const MINT_REPLAY_ID = 0x77n;

/**
 * Two installed accounts, MINTER and OTHER_ACCOUNT, each with the readable mint
 * rule, in one snapshot; `mint` builds a mint of 5 units by either account.
 */
function accountMintSetting(shape: PrivateValueShape, authorizationVkHash: bigint) {
  const large = shape === PRIVATE_VALUE_PROFILES.L.shapeId;
  const profile = privateValueProfile(shape);
  const recipient = deriveTestWallet({ privKey: new Uint8Array(32).fill(7), nkRoot: 456n, mlKem: "deterministic" });
  const ruleOf = (wallet: Wallet) => {
    const defaults = defaultUserAccountRuleSet({ wallet, secrets: TEST_DEFAULT_RULE_SECRETS });
    return large ? defaults.largeMintRule : defaults.mintRule;
  };
  const installed = [MINTER, OTHER_ACCOUNT].map((wallet) => installedAccount(wallet, ruleOf(wallet), authorizationVkHash));
  const accounts = new SparseMerkleTree(40);
  installed.forEach((account, index) => accounts.setLeaf(index, account.leaf));
  const snapshot = snapshotOf(new SparseMerkleTree(40), 0, accounts, installed.length);
  const mint = (minter: Wallet, descriptor: AssetDescriptor) => {
    const index = minter === MINTER ? 0 : 1;
    const inputs: AssetActionInput[] = Array.from({ length: profile.inputs }, () => ({ kind: "dummy" }));
    inputs[0] = { kind: "mint-marker", replayId: MINT_REPLAY_ID };
    const outputSlots = dummyOutputs(profile.outputs);
    outputSlots[0] = openedAssetActionOutput({ kind: "asset", pcashChainId: CHAIN_ID, assetId: descriptor.assetId, outputIndex: 0,
      noteSecret: 0x778n, amount: 5n, recipientAddress: recipient.address, recipientMlKemPublicKey: recipient.mlKemPublicKey!,
      authenticatedRecipient: true });
    const build = buildAssetAction({
      shape, pcashChainId: CHAIN_ID, snapshot, mint: { descriptor }, owner: installed[index]!.owner(accounts, index),
      inputs, outputs: outputSlots, openFeeAmount: 0n, issuanceOwnerCommitment: 0n, validUntilTimestamp: VALID_UNTIL,
      dummyInputSeed: 0x5eedn,
    });
    expect(build.prepareOwnerAuthorization({ wallet: minter }).authorizationCircuit)
      .toBe(large ? "account_rule_large_mint_ecdsa" : "account_rule_mint_ecdsa");
    return build;
  };
  return { mint };
}

/** The first salt, from `start`, whose ID lands in `target`. */
function saltInClass(fields: Omit<AssetDescriptor, "assetId" | "instanceSalt">, target: AssetClass, start = 0n): bigint {
  for (let salt = start; ; salt += 1n) {
    const id = assetIdOf(assetCoreCommitment({ ...fields, instanceSalt: salt }), transferRuleCommitment(fields.transferRule));
    if (assetClass(id) === target) return salt;
  }
}

for (const profile of Object.values(PRIVATE_VALUE_PROFILES)) {
  const shape = profile.shapeId;
  const ownVkKey = shape === PRIVATE_VALUE_PROFILES.L.shapeId ? "lVkHash" : "sVkHash";

  describe(`${profile.name} restricted-transfer kernel constraints`, () => {
    let kernel: ChonkCircuitMaterial;
    let transferKernel: ChonkCircuitMaterial;
    let authorization: ChonkCircuitMaterial;
    let policy: ChonkCircuitMaterial;
    let fixture: ReturnType<typeof restrictedAction>;
    let map: WitnessMap;
    beforeAll(async () => {
      policy = await resolve(POLICY_PACKAGE, "app");
      authorization = await resolve(restrictedRule(shape, false, deriveTestWallet({ mlKem: "deterministic" })).circuit, "app");
      kernel = await resolve(kernelName(shape, "restricted_transfer"), "kernel");
      transferKernel = await resolve(kernelName(shape, "transfer"), "kernel");
      fixture = restrictedAction({ shape, authorizationVkHash: BigInt(authorization.vkHash), transferRule: transferRuleFor(shape, BigInt(policy.vkHash)) });
      map = await restrictedKernelMap(fixture.build, authorization, policy);
    }, 120_000);

    it("accepts the untampered control and returns exactly the SDK public statement", async () => {
      expect(assetClass(fixture.build.assetId)).toBe("restricted");
      const result = await execute(kernel, map);
      expect((result.returnValue as string[]).map(BigInt)).toEqual(fixture.build.publicInputs);
    }, 120_000);

    // With an unrestricted ID in its place the class check passes and the
    // asset input rejects it instead.
    const rejectsInTransferKernel = async (restrictedMap: WitnessMap, assetId: bigint) => {
      await expect(execute(transferKernel, asTransferKernelMap(restrictedMap, assetId))).rejects.toThrow(CLASS_CHECK);
      await expect(execute(transferKernel, asTransferKernelMap(restrictedMap, 5n))).rejects.toThrow(NOTE_MISMATCH);
    };

    it("rejects the restricted asset in the transfer kernel", async () => {
      await rejectsInTransferKernel(map, fixture.build.assetId);
    }, 120_000);

    it("rejects a restricted burn with no asset outputs in the transfer kernel and accepts it in the restricted kernel", async () => {
      const burnAuthorization = await resolve(restrictedRule(shape, true, fixture.wallet).circuit, "app");
      const burn = restrictedAction({ shape, authorizationVkHash: BigInt(burnAuthorization.vkHash),
        transferRule: transferRuleFor(shape, BigInt(policy.vkHash)), burn: true });
      expect(burn.build.transaction.outputs.every((output) => output.slotClass === SlotClass.DUMMY)).toBe(true);
      const burnMap = await restrictedKernelMap(burn.build, burnAuthorization, policy);
      const result = await execute(kernel, burnMap);
      expect((result.returnValue as string[]).map(BigInt)).toEqual(burn.build.publicInputs);
      await rejectsInTransferKernel(burnMap, burn.build.assetId);
    }, 120_000);

    it("rejects an all-dummy action", async () => {
      const changed = structuredClone(map);
      const choices = changed.choices as WitnessMap;
      choices.input_slot_classes = (choices.input_slot_classes as string[]).map(() => fieldToHex(BigInt(SlotClass.DUMMY)));
      choices.output_slot_classes = (choices.output_slot_classes as string[]).map(() => fieldToHex(BigInt(SlotClass.DUMMY)));
      await expect(execute(kernel, changed)).rejects.toThrow(/restricted transfer must spend an asset input/);
    }, 120_000);

    it.each([0, 1, 2, 3])("rejects a substituted policy statement element %i", async (index) => {
      await expect(execute(kernel, replace(map, `policy_statement.${index}`))).rejects.toThrow(STATEMENT_MISMATCH);
    }, 120_000);

    it("rejects a policy approval for an owner other than the asset-input owner", async () => {
      const action = BigInt((map.rule_statement as string[])[1]!);
      const statement = fixture.build.policyStatement(OTHER_ACCOUNT.address, action);
      expect(statement.slice(1)).toEqual(fixture.build.policyStatement(fixture.wallet.address, action).slice(1));
      await expect(execute(kernel, { ...map, policy_statement: statement.map(fieldToHex) })).rejects.toThrow(STATEMENT_MISMATCH);
    }, 120_000);

    it("rejects a policy approval for another deadline", async () => {
      const context = policyContext({ assetId: fixture.build.assetId, configurationCommitment: POLICY_CONFIGURATION,
        ownerAddress: fixture.wallet.address, validUntilTimestamp: VALID_UNTIL + 1n });
      await expect(execute(kernel, replace(map, "policy_statement.0", fieldToHex(context)))).rejects.toThrow(STATEMENT_MISMATCH);
    }, 120_000);

    // Each substitution is chosen so the derived ID stays in the restricted
    // class: the asset input, not the class check, rejects it.
    it.each(["configuration_commitment", "other_profile_vk_hash"] as const)(
      "derives another asset from a substituted %s",
      async (field) => {
        const asset = map.asset as Record<string, string>;
        const core = BigInt(asset.core_commitment!);
        const derive = (candidate: bigint) => {
          const rule = { ...fixture.opening.transferRule };
          if (field === "configuration_commitment") rule.configurationCommitment = candidate;
          else if (ownVkKey === "sVkHash") rule.lVkHash = candidate;
          else rule.sVkHash = candidate;
          return assetIdOf(core, transferRuleCommitment(rule));
        };
        const substitute = inClassSubstitute(BigInt(asset[field]!), derive, fixture.build.assetId);
        await expect(execute(kernel, replace(map, `asset.${field}`, fieldToHex(substitute)))).rejects.toThrow(NOTE_MISMATCH);
      },
      120_000,
    );

    it("derives another asset from another folded policy", async () => {
      const rule = { ...fixture.opening.transferRule, [ownVkKey]: BigInt(authorization.vkHash) };
      const id = assetIdOf(BigInt((map.asset as Record<string, string>).core_commitment!), transferRuleCommitment(rule));
      // Out of class the derived ID fails the class check; in class, the inputs do not open under it.
      await expect(execute(kernel, { ...map, policy_vk: structuredClone(map.authorization_vk) }))
        .rejects.toThrow(assetClass(id) === "restricted" ? NOTE_MISMATCH : CLASS_CHECK);
    }, 120_000);

    it("rejects an asset whose transfer rule has a zero VK hash for this profile", async () => {
      const zero = restrictedAction({ shape, authorizationVkHash: BigInt(authorization.vkHash), transferRule: transferRuleFor(shape, 0n) });
      expect(() => zero.build.buildRestrictedKernelWitnessMap(authorization, policy)).toThrow(/does not support this profile/);
      // The builder refuses this rule; it reads the opening it was given when
      // building the witness, so the map is built with the policy's hash and
      // the kernel's own-profile hash is then set to the rule's zero.
      zero.opening.transferRule[ownVkKey] = BigInt(policy.vkHash);
      const built = await restrictedKernelMap(zero.build, authorization, policy);
      zero.opening.transferRule[ownVkKey] = 0n;
      const changed = replace(built, "policy_vk.hash", "0x0");
      await expect(execute(kernel, changed)).rejects.toThrow(VK_HASH_MISMATCH);
    }, 120_000);
  });

  describe(`${profile.name} restricted sponsored-transfer kernel constraints`, () => {
    const large = shape === PRIVATE_VALUE_PROFILES.L.shapeId;
    let kernel: ChonkCircuitMaterial;
    let sponsoredKernel: ChonkCircuitMaterial;
    let policy: ChonkCircuitMaterial;
    let fixture: ReturnType<typeof restrictedSponsoredTransferFixture>;
    let map: WitnessMap;
    let action: bigint;
    beforeAll(async () => {
      const primary = await resolve("account_rule_shared_asset_claim", "app");
      const fee = await resolve(large ? "account_rule_large_contract_fee_sponsorship_ecdsa" : "account_rule_contract_fee_sponsorship_ecdsa", "app");
      policy = await resolve(POLICY_PACKAGE, "app");
      kernel = await resolve(kernelName(shape, "restricted_sponsored_transfer"), "kernel");
      sponsoredKernel = await resolve(kernelName(shape, "sponsored_transfer"), "kernel");
      fixture = restrictedSponsoredTransferFixture({ shape, claimVkHash: BigInt(primary.vkHash),
        sponsorVkHash: BigInt(fee.vkHash), policyVkHash: BigInt(policy.vkHash) });
      const built = fixture.kernelWitnessMap(primary, fee, policy);
      map = { ...built, ...await noOpEventApplicationWitness(resolve, built) };
      action = sponsoredTransferActionCommitment(CHAIN_ID, fixture.build.privateValueCommitment);
    }, 120_000);

    it("accepts the untampered control and returns exactly the SDK public statement", async () => {
      expect(assetClass(fixture.build.assetId)).toBe("restricted");
      const result = await execute(kernel, map);
      expect((result.returnValue as string[]).map(BigInt)).toEqual(fixture.build.publicInputs);
    }, 120_000);

    it("folds the deny list's statement for the contract and its sponsored action", async () => {
      const result = await execute(policy, fixture.policyWitness());
      expect((result.returnValue as string[]).map(BigInt)).toEqual((map.policy_statement as string[]).map(BigInt));
    }, 120_000);

    it("rejects a policy approval for the fee payer instead of the contract", async () => {
      const statement = fixture.build.policyStatement(fixture.sponsor.address, action);
      expect(statement.slice(1)).toEqual(fixture.build.policyStatement(fixture.contract.address, action).slice(1));
      await expect(execute(kernel, { ...map, policy_statement: statement.map(fieldToHex) })).rejects.toThrow(STATEMENT_MISMATCH);
    }, 120_000);

    it("rejects a policy approval of the transfer action instead of the sponsored action", async () => {
      const statement = fixture.build.policyStatement(fixture.contract.address,
        transferActionCommitment(CHAIN_ID, fixture.build.privateValueCommitment));
      await expect(execute(kernel, { ...map, policy_statement: statement.map(fieldToHex) })).rejects.toThrow(STATEMENT_MISMATCH);
    }, 120_000);

    // With an unrestricted ID in its place the class check passes and the
    // asset input rejects it instead.
    it("rejects the restricted asset in the sponsored-transfer kernel", async () => {
      await expect(execute(sponsoredKernel, asTransferKernelMap(map, fixture.build.assetId))).rejects.toThrow(CLASS_CHECK);
      await expect(execute(sponsoredKernel, asTransferKernelMap(map, 5n))).rejects.toThrow(NOTE_MISMATCH);
    }, 120_000);
  });

  describe(`${profile.name} mint kernel constraints`, () => {
    let kernel: ChonkCircuitMaterial;
    let authorization: ChonkCircuitMaterial;
    let fixedSupply: ChonkCircuitMaterial;
    let fixed: ReturnType<typeof assetProfileFixture>;
    let fixedMap: WitnessMap;
    const kernelMap = async (build: AssetActionBuild, mintRule: ChonkCircuitMaterial) => {
      const map = build.buildMintKernelWitnessMap(authorization, mintRule);
      return { ...map, ...await noOpEventApplicationWitness(resolve, map) };
    };
    beforeAll(async () => {
      kernel = await resolve(kernelName(shape, "mint"), "kernel");
      fixedSupply = await resolve(FIXED_SUPPLY_RULE_CIRCUIT, "app");
      fixed = assetProfileFixture({ shape, mintRuleVkHash: BigInt(fixedSupply.vkHash) });
      authorization = await resolve(fixed.prepared.authorizationCircuit, "app");
      fixedMap = await kernelMap(fixed.build, fixedSupply);
    }, 120_000);

    it("accepts the untampered fixed-supply control and returns exactly the SDK public statement", async () => {
      const result = await execute(kernel, fixedMap);
      expect((result.returnValue as string[]).map(BigInt)).toEqual(fixed.build.publicInputs);
    }, 120_000);

    it("folds the fixed-supply rule's statement for the minting account", async () => {
      const result = await execute(fixedSupply, fixed.mintRule.witnessMap);
      expect((result.returnValue as string[]).map(BigInt)).toEqual((fixedMap.mint_statement as string[]).map(BigInt));
    }, 120_000);

    it("rejects fixed-supply outputs that do not total the supply", async () => {
      const witness = fixed.mintRule.witnessMap;
      for (const supply of [fixed.configuration.supply - 1n, fixed.configuration.supply + 1n]) {
        await expect(execute(fixedSupply, replace(witness, "configuration.supply", fieldToHex(supply))))
          .rejects.toThrow(/asset outputs must total the fixed supply/);
      }
    }, 120_000);

    it("rejects a fixed-supply mint with a second marker or another secret", async () => {
      const witness = fixed.mintRule.witnessMap;
      const marker = ((witness.private_value as WitnessMap).nullifiers as string[])[0]!;
      let second = replace(witness, "private_value.input_slot_classes.1", fieldToHex(BigInt(SlotClass.MINT)));
      second = replace(second, "private_value.nullifiers.1", marker);
      await expect(execute(fixedSupply, second)).rejects.toThrow(/exactly one mint marker/);
      await expect(execute(fixedSupply, replace(witness, "secret"))).rejects.toThrow(/secret must open the configured commitment/);
    }, 120_000);

    it("rejects a mint with no marker", async () => {
      await expect(execute(kernel, replace(fixedMap, "choices.input_slot_classes.0", fieldToHex(BigInt(SlotClass.DUMMY))))).rejects.toThrow(MARKER_COUNT);
    }, 120_000);

    it("rejects a mint rule statement for another account or deadline", async () => {
      const { build } = fixed;
      const statement = (accountAddress: bigint, validUntilTimestamp: bigint) => ruleStatement(
        mintContext({ assetId: build.assetId, configurationCommitment: build.mintRule!.configurationCommitment, accountAddress, validUntilTimestamp }),
        mintActionCommitment(build.pcashChainId, build.privateValueCommitment, build.assetId),
        build.recentPcashBlockHash, build.eventOpening.eventEntry,
      ).map(fieldToHex);
      expect(statement(build.address, VALID_UNTIL)).not.toEqual(fixedMap.mint_statement);
      expect(statement(build.address, BigInt(build.transaction.global.validUntilTimestamp))).toEqual(fixedMap.mint_statement);
      await expect(execute(kernel, { ...fixedMap, mint_statement: statement(OTHER_ACCOUNT.address, BigInt(build.transaction.global.validUntilTimestamp)) }))
        .rejects.toThrow(STATEMENT_MISMATCH);
      await expect(execute(kernel, { ...fixedMap, mint_statement: statement(build.address, VALID_UNTIL) })).rejects.toThrow(STATEMENT_MISMATCH);
    }, 120_000);

    it("derives another asset from another folded mint rule", async () => {
      const ownVk = shape === PRIVATE_VALUE_PROFILES.L.shapeId ? "lVkHash" : "sVkHash";
      const rule = { ...fixed.assetDescriptor.mintRule, [ownVk]: BigInt(authorization.vkHash) };
      const id = assetIdOf(assetCoreCommitment({ ...fixed.assetDescriptor, mintRule: rule }), 0n);
      expect(id).not.toBe(fixed.build.assetId);
      // Out of class the derived ID fails the class check; in class, the event binds another action.
      await expect(execute(kernel, { ...fixedMap, mint_rule_vk: structuredClone(fixedMap.authorization_vk) }))
        .rejects.toThrow(assetClass(id) === "unrestricted" ? EVENT_MISMATCH : CLASS_CHECK);
    }, 120_000);

    // The wrong-class salt fails at the class check; an in-class salt of the
    // same definition passes it and fails only at the event binding.
    it("rejects a definition without a transfer rule whose ID is in the restricted class", async () => {
      const fields = { metadataCommitment: fixed.assetDescriptor.metadataCommitment, mintRule: fixed.assetDescriptor.mintRule };
      const wrong = saltInClass(fields, "restricted");
      const right = saltInClass(fields, "unrestricted", fixed.assetDescriptor.instanceSalt + 1n);
      await expect(execute(kernel, replace(fixedMap, "definition.instance_salt", fieldToHex(wrong)))).rejects.toThrow(CLASS_CHECK);
      await expect(execute(kernel, replace(fixedMap, "definition.instance_salt", fieldToHex(right)))).rejects.toThrow(EVENT_MISMATCH);
    }, 120_000);

    it("rejects a definition with a transfer rule whose ID is in the unrestricted class", async () => {
      const transferRule = transferRuleFor(shape, 0x5eedn);
      const fields = { metadataCommitment: fixed.assetDescriptor.metadataCommitment, mintRule: fixed.assetDescriptor.mintRule, transferRule };
      const withRule = (salt: bigint) => {
        let changed = replace(fixedMap, "definition.instance_salt", fieldToHex(salt));
        changed = replace(changed, "definition.transfer_rule_commitment", fieldToHex(transferRuleCommitment(transferRule)));
        return changed;
      };
      await expect(execute(kernel, withRule(saltInClass(fields, "unrestricted")))).rejects.toThrow(CLASS_CHECK);
      await expect(execute(kernel, withRule(saltInClass(fields, "restricted")))).rejects.toThrow(EVENT_MISMATCH);
    }, 120_000);

    describe("account mint", () => {
      let accountMint: ChonkCircuitMaterial;
      let setting: ReturnType<typeof accountMintSetting>;
      let descriptor: AssetDescriptor;
      let build: AssetActionBuild;
      let map: WitnessMap;
      beforeAll(async () => {
        accountMint = await resolve(ACCOUNT_MINT_RULE_CIRCUIT, "app");
        setting = accountMintSetting(shape, BigInt(authorization.vkHash));
        const vkHash = BigInt(accountMint.vkHash);
        descriptor = findAssetDescriptor({ metadataCommitment: 0x6d1n, mintRule: { sVkHash: vkHash, lVkHash: vkHash,
          configurationCommitment: accountMintConfigurationCommitment({ accountAddress: MINTER.address }) } }, 0n);
        build = setting.mint(MINTER, descriptor);
        map = await kernelMap(build, accountMint);
      }, 120_000);

      it("accepts a mint by the configured account and folds the rule's statement", async () => {
        const result = await execute(kernel, map);
        expect((result.returnValue as string[]).map(BigInt)).toEqual(build.publicInputs);
        const rule = await execute(accountMint, accountMintWitness({ mint: build, configuration: { accountAddress: MINTER.address } }));
        expect((rule.returnValue as string[]).map(BigInt)).toEqual((map.mint_statement as string[]).map(BigInt));
      }, 120_000);

      it("rejects a mint of the asset by another account whose own rule approved it", async () => {
        const other = setting.mint(OTHER_ACCOUNT, descriptor);
        expect(() => accountMintWitness({ mint: other, configuration: { accountAddress: MINTER.address } }))
          .toThrow(/only the asset's configured account mints it/);
        // Run by another account, the rule derives that account's configuration, so its statement names another context.
        const rule = await execute(accountMint, {
          recent_pcash_block_hash: fieldToHex(other.recentPcashBlockHash), asset_id: fieldToHex(other.assetId),
          account_address: fieldToHex(OTHER_ACCOUNT.address),
          valid_until_timestamp: fieldToHex(BigInt(other.transaction.global.validUntilTimestamp)),
          action_commitment: fieldToHex(mintActionCommitment(other.pcashChainId, other.privateValueCommitment, other.assetId)),
          event_entry: fieldToHex(other.eventOpening.eventEntry),
        });
        // ACVM does not verify the fold, so the kernel is given the rule's actual statement in place of the one it expects.
        const otherMap = await kernelMap(other, accountMint);
        const statement = rule.returnValue as string[];
        expect(BigInt(statement[0]!)).not.toBe(BigInt((otherMap.mint_statement as string[])[0]!));
        expect(statement.slice(1).map(BigInt)).toEqual((otherMap.mint_statement as string[]).slice(1).map(BigInt));
        await expect(execute(kernel, { ...otherMap, mint_statement: statement })).rejects.toThrow(STATEMENT_MISMATCH);
      }, 120_000);
    });

    if (shape === PRIVATE_VALUE_PROFILES.S.shapeId) {
      describe("voucher mint", () => {
        it("accepts a voucher mint by any ordinary account", async () => {
          const voucher = await resolve(VOUCHER_RULE_CIRCUIT, "app");
          for (const claimantKey of [undefined, 9]) {
            const fixture = voucherMintFixture({ voucherVkHash: BigInt(voucher.vkHash), authorizationVkHash: BigInt(authorization.vkHash),
              ...(claimantKey === undefined ? {} : { claimantKey }) });
            const map = await kernelMap(fixture.build, voucher);
            const result = await execute(kernel, map);
            expect((result.returnValue as string[]).map(BigInt)).toEqual(fixture.build.publicInputs);
            const rule = await execute(voucher, fixture.mintRule.witnessMap);
            expect((rule.returnValue as string[]).map(BigInt)).toEqual((map.mint_statement as string[]).map(BigInt));
          }
        }, 120_000);
      });

      // The deposit's log is in the L1 origin tree of the action's recent block.
      describe("deposit mint", () => {
        let depositRule: ChonkCircuitMaterial;
        let fixture: ReturnType<typeof depositMintFixture>;
        let map: WitnessMap;
        beforeAll(async () => {
          depositRule = await resolve(DEPOSIT_MINT_RULE_CIRCUIT, "app");
          fixture = depositMintFixture({ authorizationVkHash: BigInt(authorization.vkHash) });
          map = await kernelMap(fixture.build, depositRule);
        }, 120_000);

        it("accepts a deposit mint by its recipient and folds the rule's statement", async () => {
          const result = await execute(kernel, map);
          expect((result.returnValue as string[]).map(BigInt)).toEqual(fixture.build.publicInputs);
          const rule = await execute(depositRule, fixture.mintRule.witnessMap);
          expect((rule.returnValue as string[]).map(BigInt)).toEqual((map.mint_statement as string[]).map(BigInt));
        }, 120_000);

        it("rejects the deposit under another anchor, at another position, of another amount, or to another recipient or asset", async () => {
          const witness = fixture.mintRule.witnessMap;
          await expect(execute(depositRule, replace(witness, "recent_pcash_block_hash")))
            .rejects.toThrow(/block header field must be in the block header tree/);
          await expect(execute(depositRule, replace(witness, "deposit.log.log_index")))
            .rejects.toThrow(/block header field must be in the block header tree/);
          await expect(execute(depositRule, replace(witness, "deposit.log.log_leaf_index", "0x8")))
            .rejects.toThrow(/block header field must be in the block header tree/);
          await expect(execute(depositRule, replace(witness, "deposit.amount")))
            .rejects.toThrow(/block header field must be in the block header tree/);
          const commitment = /recipient commitment must open to the chain, asset, recipient address and salt/;
          await expect(execute(depositRule, replace(witness, "recipient_address"))).rejects.toThrow(commitment);
          await expect(execute(depositRule, replace(witness, "asset_id"))).rejects.toThrow(commitment);
          await expect(execute(depositRule, replace(witness, "pcash_chain_id"))).rejects.toThrow(commitment);
        }, 120_000);
      });
    }
  });
}
