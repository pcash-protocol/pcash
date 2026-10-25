import type { PreparedEvent } from "../src/protocol/events.ts";
import { buildAssetAction } from "../src/builders/assetAction.ts";
import { openedAssetActionOutput, type AssetActionInput, type AssetActionOutput } from "../src/builders/assetOutputs.ts";
import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "../src/constants/privateValueProfiles.ts";
import { accountRuleEntryCommitment, accountStateCommitment, buildAccountRuleSet } from "../src/protocol/account.ts";
import { assetSecretCommitment, standardFungibleAssetId } from "../src/protocol/asset.ts";
import { fullOutputCommitment, nullifierKeyCommitment } from "../src/protocol/notes.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { sizeClassFiller } from "../src/protocol/envelope.ts";
import { defaultUserAccountRuleSet, ecdsaRuleConfigurationCommitment } from "../src/rules/referenceRules.ts";
import { syntheticRecentBlockFixture, TEST_DEFAULT_RULE_SECRETS } from "@pcash/test-support/protocol-fixtures";
import { deriveTestWallet } from "./testWallet.ts";
import { authorizePcashRequestWithPrivateKey } from "../src/eip712/authorization.ts";

/** Asset creation with native funding and delivery in the last slot of either profile. */
export function assetProfileFixture(params: { shape: PrivateValueShape; authorizationVkHash?: bigint; validUntilTimestamp?: bigint; preparedEvent?: PreparedEvent }) {
  const profile = privateValueProfile(params.shape);
  const wallet = deriveTestWallet({ mlKem: "deterministic" });
  const recipient = deriveTestWallet({ privKey: new Uint8Array(32).fill(7), nkRoot: 456n, mlKem: "deterministic" });
  const chainId = BigInt(DEFAULT_NETWORK_CONFIG.pcashChainId);
  const defaults = defaultUserAccountRuleSet({ wallet, secrets: TEST_DEFAULT_RULE_SECRETS });
  const defaultRule = params.shape === PRIVATE_VALUE_PROFILES.L.shapeId ? defaults.largeAssetCreationRule : defaults.assetCreationRule;
  const configurationCommitment = ecdsaRuleConfigurationCommitment(DEFAULT_NETWORK_CONFIG, nullifierKeyCommitment(wallet.nkRoot));
  const commitmentBlinder = defaultRule.commitmentBlinder;
  const entryIndex = defaultRule.entryIndex;
  const set = buildAccountRuleSet([{ entryIndex, accountRuleEntryCommitment: accountRuleEntryCommitment(
    params.authorizationVkHash ?? defaultRule.applicationVkHash, configurationCommitment, commitmentBlinder,
  ) }]);
  const outputs = new SparseMerkleTree(40);
  const accounts = new SparseMerkleTree(40);
  const noteSecret = 99n;
  outputs.setLeaf(0, fullOutputCommitment({ owner: wallet.address, noteSecret, assetId: 0n, amount: 10n }, 0));
  accounts.setLeaf(0, accountStateCommitment(wallet.address, nullifierKeyCommitment(wallet.nkRoot), set.accountRuleSetCommitment, 0n, 1n, 0n));
  const recent = syntheticRecentBlockFixture({ outputRoot: outputs.root, outputCount: 1, issuedSoFar: 10n,
    lagQ: 100n, accountStateRoot: accounts.root, accountCount: 1 });
  const snapshot = {
    recentPcashBlockHash: recent.recentPcashBlockHash, stateRoot: recent.stateRoot,
    stateRootHeaderSiblings: recent.stateRootHeaderSiblings, outputRoot: outputs.root,
    outputRootStateSiblings: recent.outputRootStateSiblings, accountStateRoot: accounts.root,
    accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
  };
  const assetSecret = 987n;
  const assetFields = { metadataCommitment: 765n, initialSupply: 1_000n,
    assetSecretCommitment: assetSecretCommitment(assetSecret) };
  const assetDescriptor = { ...assetFields, assetId: standardFungibleAssetId(assetFields) };
  const inputSlots: AssetActionInput[] = Array.from({ length: profile.inputs }, () => ({ kind: "dummy" }));
  inputSlots[0] = { kind: "creation-marker" };
  if (profile.inputs > 1) inputSlots[profile.inputs - 1] = { kind: "native", noteSecret, amount: 10n, leafIndex: 0, siblings: outputs.proof(0).siblings };
  const outputSlots: AssetActionOutput[] = Array.from({ length: profile.outputs }, (_, i) => ({
    kind: "dummy", dummySecret: BigInt(i + 123), amount: 0n, outputData: sizeClassFiller(),
  }));
  outputSlots[profile.outputs - 1] = openedAssetActionOutput({ kind: "asset", pcashChainId: chainId,
    assetId: assetDescriptor.assetId, outputIndex: profile.outputs - 1, noteSecret: 777n, amount: assetFields.initialSupply,
    recipientAddress: recipient.address, recipientMlKemPublicKey: recipient.mlKemPublicKey!, authenticatedRecipient: true });
  const build = buildAssetAction({
    ...(params.preparedEvent === undefined ? {} : { preparedEvent: params.preparedEvent }),
    shape: params.shape, pcashChainId: chainId, snapshot, assetDescriptor, assetSecret,
    owner: { address: wallet.address, nkRoot: wallet.nkRoot, accountIndex: 0, accountSiblings: accounts.proof(0).siblings,
      accountRuleSetCommitment: set.accountRuleSetCommitment, accountKind: 0n, accountRevision: 1n,
      receiveKeyHash: 0n,
      rule: { configurationCommitment, commitmentBlinder, entryIndex, siblings: set.membership(entryIndex).siblings } },
    inputs: inputSlots, outputs: outputSlots, openFeeAmount: profile.inputs > 1 ? 10n : 0n, issuanceOwnerCommitment: 0n, validUntilTimestamp: params.validUntilTimestamp ?? 999_999n, dummyInputSeed: 345n,
  });
  const prepared = build.prepareOwnerAuthorization({ wallet });
  const signed = prepared.authorize(authorizePcashRequestWithPrivateKey(wallet.privKey, prepared.request));
  return { build, wallet, recipient, assetDescriptor, assetSecret, snapshot, prepared, signed };
}
