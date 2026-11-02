import { join } from "node:path";
import { Noir } from "@noir-lang/noir_js";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAssetAction } from "../src/builders/assetAction.ts";
import type { AssetActionInput, AssetActionOutput } from "../src/builders/assetOutputs.ts";
import { PRIVATE_VALUE_PROFILES, type PrivateValueShape } from "../src/constants/privateValueProfiles.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { fieldToHex } from "../src/crypto/field.ts";
import { authorizePcashRequestWithPrivateKey } from "../src/eip712/authorization.ts";
import { createChonkCircuitResolver } from "../src/node/chonkMaterial.ts";
import { defaultUserAccountRuleSet } from "../src/rules/referenceRules.ts";
import { accountRuleEntryCommitment, accountStateCommitment, buildAccountRuleSet } from "../src/protocol/account.ts";
import { assetSecretCommitment, standardFungibleAssetId } from "../src/protocol/asset.ts";
import { sizeClassFiller } from "../src/protocol/envelope.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { fullOutputCommitment, nullifierKeyCommitment, ownerCommitment } from "../src/protocol/notes.ts";
import { SlotClass } from "../src/protocol/transaction.ts";
import type { WitnessMap } from "../src/protocol/witness.ts";
import type { ChonkCircuitMaterial } from "../src/prover/stacks.ts";
import { syntheticRecentBlockFixture, TEST_DEFAULT_RULE_SECRETS } from "@pcash/test-support/protocol-fixtures";
import { proverAssetsDir } from "./circuitBundle.ts";
import { deriveTestWallet } from "./testWallet.ts";
import { noOpEventApplicationWitness } from "./noOpEventApplication.ts";

const resolve = createChonkCircuitResolver({
  artifactDirectory: proverAssetsDir(),
  verificationKeyDirectory: join(process.env.PCASH_CIRCUIT_BUNDLE!, "vks"),
});

// Like assetProfileFixture, use real account/output memberships and signed SDK
// authorization, but spend an existing asset entirely instead of creating one.
function fullBurnFixture(shape: PrivateValueShape, authorizationVkHash: bigint) {
  const profile = shape === 0 ? PRIVATE_VALUE_PROFILES.S : PRIVATE_VALUE_PROFILES.L;
  const wallet = deriveTestWallet({ mlKem: "deterministic" });
  const chainId = BigInt(DEFAULT_NETWORK_CONFIG.pcashChainId);
  const defaults = defaultUserAccountRuleSet({ wallet, secrets: TEST_DEFAULT_RULE_SECRETS });
  const rule = shape === 0 ? defaults.assetBurnRule : defaults.largeBatchTransferRule;
  const rules = buildAccountRuleSet([{ entryIndex: rule.entryIndex, accountRuleEntryCommitment: accountRuleEntryCommitment(
    authorizationVkHash, rule.configurationCommitment, rule.commitmentBlinder,
  ) }]);
  const assetId = standardFungibleAssetId({
    metadataCommitment: 765n, initialSupply: 987n,
    assetSecretCommitment: assetSecretCommitment(654n),
  });
  const assetNote = { owner: wallet.address, noteSecret: 456n, assetId, amount: 987n };
  const assetLeafIndex = 3;
  const outputs = new SparseMerkleTree(40);
  outputs.setLeaf(assetLeafIndex, fullOutputCommitment(assetNote, assetLeafIndex));
  outputs.setLeaf(0, fullOutputCommitment({ owner: wallet.address, noteSecret: 123n, assetId: 0n, amount: 10n }, 0));
  const accounts = new SparseMerkleTree(40);
  accounts.setLeaf(0, accountStateCommitment(wallet.address, nullifierKeyCommitment(wallet.nkRoot), rules.accountRuleSetCommitment, 0n, 1n, 0n));
  const recent = syntheticRecentBlockFixture({ outputRoot: outputs.root, outputCount: 4, issuedSoFar: 10n,
    lagQ: 100n, accountStateRoot: accounts.root, accountCount: 1 });
  const inputs: AssetActionInput[] = Array.from({ length: profile.inputs }, () => ({ kind: "dummy" }));
  const assetSlot = shape === 0 ? 0 : profile.inputs - 1;
  inputs[assetSlot] = { kind: "asset", noteSecret: assetNote.noteSecret, amount: assetNote.amount,
    leafIndex: assetLeafIndex, siblings: outputs.proof(assetLeafIndex).siblings };
  inputs[shape === 0 ? profile.inputs - 1 : 0] = { kind: "native", noteSecret: 123n, amount: 10n,
    leafIndex: 0, siblings: outputs.proof(0).siblings };
  const outputSlots: AssetActionOutput[] = Array.from({ length: profile.outputs }, (_, i) => ({
    kind: "dummy", dummySecret: BigInt(i + 123), amount: 0n, outputData: sizeClassFiller(),
  }));
  const build = buildAssetAction({
    shape, pcashChainId: chainId, assetId, assetBurnAmount: assetNote.amount,
    snapshot: {
      recentPcashBlockHash: recent.recentPcashBlockHash, stateRoot: recent.stateRoot,
      stateRootHeaderSiblings: recent.stateRootHeaderSiblings, outputRoot: outputs.root,
      outputRootStateSiblings: recent.outputRootStateSiblings, accountStateRoot: accounts.root,
      accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
    },
    owner: { address: wallet.address, nkRoot: wallet.nkRoot, accountIndex: 0, accountSiblings: accounts.proof(0).siblings,
      accountRuleSetCommitment: rules.accountRuleSetCommitment, accountKind: 0n, accountRevision: 1n, receiveKeyHash: 0n,
      rule: { configurationCommitment: rule.configurationCommitment, commitmentBlinder: rule.commitmentBlinder,
        entryIndex: rule.entryIndex, siblings: rules.membership(rule.entryIndex).siblings } },
    inputs, outputs: outputSlots, openFeeAmount: 10n, issuanceOwnerCommitment: 0n,
    validUntilTimestamp: 999_999n, dummyInputSeed: 345n,
  });
  const prepared = build.prepareOwnerAuthorization({ wallet });
  const signed = prepared.authorize(authorizePcashRequestWithPrivateKey(wallet.privKey, prepared.request));
  return { build, prepared, signed, assetSlot, expectedOpening: {
    owner_commitment: fieldToHex(ownerCommitment(wallet.address, assetNote.noteSecret)),
    amount: fieldToHex(assetNote.amount), output_index: fieldToHex(BigInt(assetLeafIndex)),
  } };
}

const execute = (material: ChonkCircuitMaterial, witness: WitnessMap) =>
  new Noir(material.artifact as never).execute(witness as never);

for (const profile of Object.values(PRIVATE_VALUE_PROFILES)) {
  describe(`${profile.name} SDK full-burn namespace opening`, () => {
    let rule: ChonkCircuitMaterial;
    let kernel: ChonkCircuitMaterial;
    let fixture: ReturnType<typeof fullBurnFixture>;
    beforeAll(async () => {
      rule = await resolve(profile.name === "S" ? "account_rule_asset_burn_ecdsa" : "account_rule_large_batch_transfer_ecdsa", "app");
      kernel = await resolve(profile.name === "S" ? "private_value_transfer_kernel" : "private_value_large_transfer_kernel", "kernel");
      fixture = fullBurnFixture(profile.shapeId, BigInt(rule.vkHash));
    }, 120_000);

    it("maps the asset input opening and executes the signed rule and kernel", async () => {
      const { build, prepared, signed, assetSlot, expectedOpening } = fixture;
      expect(prepared.authorizationKind).toBe(profile.name === "S" ? "asset-burn" : "batch-transfer");
      expect(prepared.authorizationCircuit).toBe(profile.name === "S" ? "account_rule_asset_burn_ecdsa" : "account_rule_large_batch_transfer_ecdsa");
      expect(build.transaction.inputs.filter(input => input.slotClass === SlotClass.ASSET)).toHaveLength(1);
      expect(build.transaction.inputs[assetSlot]!.slotClass).toBe(SlotClass.ASSET);
      expect(build.transaction.outputs.every(output => output.slotClass === SlotClass.DUMMY)).toBe(true);
      expect(signed.witnessMap.asset_namespace_opening).toEqual(expectedOpening);
      if (profile.name === "L") {
        expect(assetSlot).toBe(31);
        expect(build.transaction.inputs[0]!.slotClass).toBe(SlotClass.NATIVE);
        expect(build.transaction.inputs.slice(1, assetSlot).every(input => input.slotClass === SlotClass.DUMMY)).toBe(true);
      }
      const kernelMap = { ...build.buildKernelWitnessMap(rule), ...await noOpEventApplicationWitness(resolve, build.buildKernelWitnessMap(rule)) };
      const ruleResult = await execute(rule, signed.witnessMap);
      expect((ruleResult.returnValue as string[]).map(BigInt)).toEqual((kernelMap.rule_statement as string[]).map(BigInt));
      // ACVM checks kernel constraints and returns the SDK statement; recursive
      // proof verification is exercised separately by the proving tests.
      const kernelResult = await execute(kernel, kernelMap);
      expect((kernelResult.returnValue as string[]).map(BigInt)).toEqual(build.publicInputs);
    }, 120_000);

    it.each(["owner_commitment", "output_index", "amount"])("rejects a changed namespace-opening %s", async (field) => {
      const witness = structuredClone(fixture.signed.witnessMap);
      const opening = witness.asset_namespace_opening as Record<string, string>;
      expect(opening[field]).toBeDefined();
      opening[field] = fieldToHex(BigInt(opening[field]!) + 1n);
      await expect(execute(rule, witness)).rejects.toThrow("first asset input must open in the signed asset");
    }, 120_000);
  });
}
