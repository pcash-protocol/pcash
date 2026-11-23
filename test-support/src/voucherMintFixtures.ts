import {
  buildAssetAction,
  compositePrivateValueMap,
  fieldArrayMap,
  fm,
  openedAssetActionOutput,
  type AssetActionInput,
  type AssetActionOutput,
  type WitnessMap,
} from "@pcash/sdk/builders";
import { PRIVATE_VALUE_PROFILES, privateValueProfile, REFERENCE_ASSET_CONFIGURATION_DOMAIN } from "@pcash/sdk/constants";
import { poseidon, SparseMerkleTree } from "@pcash/sdk/crypto";
import { authorizePcashRequestWithPrivateKey } from "@pcash/sdk/eip712";
import {
  accountRuleEntryCommitment,
  accountStateCommitment,
  buildAccountRuleSet,
  DEFAULT_NETWORK_CONFIG,
  findAssetDescriptor,
  fullOutputCommitment,
  mintMarker,
  nullifierKeyCommitment,
  sizeClassFiller,
  SlotClass,
} from "@pcash/sdk/protocol";
import { defaultUserAccountRuleSet, ecdsaRuleConfigurationCommitment, paddedOutputMap, requireMintRuleConfiguration, type MintWitnessInputs } from "@pcash/sdk/rules";
import { syntheticRecentBlockFixture, TEST_DEFAULT_RULE_SECRETS } from "./protocolFixtures.ts";
import { deriveTestWallet } from "./testWallet.ts";

export const VOUCHER_RULE_CIRCUIT = "mint_rule_voucher";

// The rule's sub-tags under REFERENCE_ASSET_CONFIGURATION_DOMAIN, as in
// circuits/fixtures/voucher_minter.
const VOUCHER_CONFIGURATION_TAG = 7n;
const VOUCHER_TAG = 8n;
const VOUCHER_REPLAY_TAG = 9n;
const VOUCHER_TREE_DEPTH = 4;
const VOUCHER_AMOUNT = 100n;
const VOUCHER_SECRETS = Array.from({ length: 1 << VOUCHER_TREE_DEPTH }, (_, index) => 7000n + BigInt(index));

const voucherCommitment = (secret: bigint) => poseidon([REFERENCE_ASSET_CONFIGURATION_DOMAIN, VOUCHER_TAG, secret]);
export const voucherReplayId = (secret: bigint) => poseidon([REFERENCE_ASSET_CONFIGURATION_DOMAIN, VOUCHER_REPLAY_TAG, secret]);

export interface VoucherConfiguration {
  voucherRoot: bigint;
  amount: bigint;
}

export const voucherConfigurationCommitment = (configuration: VoucherConfiguration) =>
  poseidon([REFERENCE_ASSET_CONFIGURATION_DOMAIN, VOUCHER_CONFIGURATION_TAG, configuration.voucherRoot, configuration.amount]);

/** The witness of `mint_rule_voucher` for one voucher's mint. */
export function voucherMintWitness(params: {
  mint: MintWitnessInputs;
  configuration: VoucherConfiguration;
  voucherSecret: bigint;
  voucherIndex: number;
  voucherSiblings: readonly bigint[];
}): WitnessMap {
  const { mint, configuration } = params;
  requireMintRuleConfiguration(mint, voucherConfigurationCommitment(configuration));
  const marker = mintMarker(mint.assetId, voucherReplayId(params.voucherSecret));
  const markers = mint.transaction.inputs.filter((input) => input.slotClass === SlotClass.MINT);
  if (markers.length !== 1 || markers[0]!.nullifier !== marker) throw new Error("a voucher mint carries its voucher's one marker");
  return {
    pcash_chain_id: fm(mint.pcashChainId),
    recent_pcash_block_hash: fm(mint.recentPcashBlockHash),
    asset_id: fm(mint.assetId),
    account_address: fm(mint.address),
    shape: mint.shape,
    private_value: compositePrivateValueMap(mint.transaction, mint.shape),
    configuration: { voucher_root: fm(configuration.voucherRoot), amount: fm(configuration.amount) },
    voucher_secret: fm(params.voucherSecret),
    voucher_index: fm(BigInt(params.voucherIndex)),
    voucher_siblings: fieldArrayMap(params.voucherSiblings),
    ...paddedOutputMap(mint),
    event_entry: fm(mint.eventOpening.eventEntry),
  };
}

/**
 * A voucher redemption. The voucher rule names no account, so any account may
 * submit the mint: here an ordinary user account, the claimant, approves it
 * with its readable mint rule, pays the open fee from one native note, and
 * takes the minted units.
 */
export function voucherMintFixture(params: {
  voucherVkHash: bigint;
  /** The claimant's readable mint rule; the release pin unless given. */
  authorizationVkHash?: bigint;
  /** Selects another claimant account. */
  claimantKey?: number;
  voucherIndex?: number;
  validUntilTimestamp?: bigint;
}) {
  const shape = PRIVATE_VALUE_PROFILES.S.shapeId;
  const profile = privateValueProfile(shape);
  const chainId = BigInt(DEFAULT_NETWORK_CONFIG.pcashChainId);
  const claimant = params.claimantKey === undefined
    ? deriveTestWallet({ mlKem: "deterministic" })
    : deriveTestWallet({ privKey: new Uint8Array(32).fill(params.claimantKey), nkRoot: BigInt(params.claimantKey) + 1000n, mlKem: "deterministic" });
  const vouchers = new SparseMerkleTree(VOUCHER_TREE_DEPTH);
  VOUCHER_SECRETS.forEach((secret, index) => vouchers.setLeaf(index, voucherCommitment(secret)));
  const voucherIndex = params.voucherIndex ?? 5;
  const voucherSecret = VOUCHER_SECRETS[voucherIndex]!;
  const configuration = { voucherRoot: vouchers.root, amount: VOUCHER_AMOUNT };
  const descriptor = findAssetDescriptor({ metadataCommitment: 222n, mintRule: {
    sVkHash: params.voucherVkHash, lVkHash: params.voucherVkHash, configurationCommitment: voucherConfigurationCommitment(configuration),
  } }, 0n);
  const assetId = descriptor.assetId;

  const mintRule = defaultUserAccountRuleSet({ wallet: claimant, secrets: TEST_DEFAULT_RULE_SECRETS }).mintRule;
  const ruleConfiguration = ecdsaRuleConfigurationCommitment(DEFAULT_NETWORK_CONFIG, nullifierKeyCommitment(claimant.nkRoot));
  const rules = buildAccountRuleSet([{ entryIndex: mintRule.entryIndex, accountRuleEntryCommitment: accountRuleEntryCommitment(
    params.authorizationVkHash ?? mintRule.applicationVkHash, ruleConfiguration, mintRule.commitmentBlinder,
  ) }]);
  const accounts = new SparseMerkleTree(40);
  accounts.setLeaf(0, accountStateCommitment(claimant.address, nullifierKeyCommitment(claimant.nkRoot),
    rules.accountRuleSetCommitment, 0n, 1n, 0n));
  const outputs = new SparseMerkleTree(40);
  outputs.setLeaf(0, fullOutputCommitment({ owner: claimant.address, noteSecret: 446n, assetId: 0n, amount: 5n }, 0));
  const recent = syntheticRecentBlockFixture({ outputRoot: outputs.root, outputCount: 1, issuedSoFar: 5n,
    lagQ: 100n, accountStateRoot: accounts.root, accountCount: 1 });
  const snapshot = {
    recentPcashBlockHash: recent.recentPcashBlockHash, stateRoot: recent.stateRoot,
    stateRootHeaderSiblings: recent.stateRootHeaderSiblings, outputRoot: outputs.root,
    outputRootStateSiblings: recent.outputRootStateSiblings, accountStateRoot: accounts.root,
    accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
  };

  const inputSlots: AssetActionInput[] = Array.from({ length: profile.inputs }, () => ({ kind: "dummy" }));
  inputSlots[0] = { kind: "mint-marker", replayId: voucherReplayId(voucherSecret) };
  inputSlots[1] = { kind: "native", noteSecret: 446n, amount: 5n, leafIndex: 0, siblings: outputs.proof(0).siblings };
  const outputSlots: AssetActionOutput[] = Array.from({ length: profile.outputs }, (_, index) => ({
    kind: "dummy", dummySecret: BigInt(500 + index), amount: 0n, outputData: sizeClassFiller(),
  }));
  outputSlots[0] = openedAssetActionOutput({ kind: "asset", pcashChainId: chainId,
    assetId, outputIndex: 0, noteSecret: 888n, amount: VOUCHER_AMOUNT,
    recipientAddress: claimant.address, recipientMlKemPublicKey: claimant.mlKemPublicKey!, authenticatedRecipient: true });
  const build = buildAssetAction({
    shape, pcashChainId: chainId, snapshot, mint: { descriptor },
    owner: {
      address: claimant.address, nkRoot: claimant.nkRoot, accountIndex: 0, accountSiblings: accounts.proof(0).siblings,
      accountRuleSetCommitment: rules.accountRuleSetCommitment, accountKind: 0n, accountRevision: 1n, receiveKeyHash: 0n,
      rule: { configurationCommitment: ruleConfiguration, commitmentBlinder: mintRule.commitmentBlinder,
        entryIndex: mintRule.entryIndex, siblings: rules.membership(mintRule.entryIndex).siblings },
    },
    inputs: inputSlots, outputs: outputSlots, openFeeAmount: 5n, issuanceOwnerCommitment: 0n,
    validUntilTimestamp: params.validUntilTimestamp ?? 999_999n, dummyInputSeed: 901n,
  });
  const prepared = build.prepareOwnerAuthorization({ wallet: claimant });
  const signed = prepared.authorize(authorizePcashRequestWithPrivateKey(claimant.privKey, prepared.request));
  const voucherWitnessMap = voucherMintWitness({
    mint: build, configuration, voucherSecret, voucherIndex, voucherSiblings: vouchers.proof(voucherIndex).siblings,
  });
  return { build, descriptor, claimant, snapshot, configuration, voucherSecret, prepared, signed,
    mintRule: { packageName: VOUCHER_RULE_CIRCUIT, witnessMap: voucherWitnessMap } };
}
