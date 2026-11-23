import {
  assetActionInputNullifiers,
  buildAssetAction,
  buildSharedAssetClaimWitness,
  buildSponsoredTransferWitness,
  openedAssetActionOutput,
  prepareContractFeeSponsorshipAuthorization,
  sharedAssetClaimConfigurationCommitment,
  sharedAssetClaimReplayId,
  sharedAssetClaimSecretCommitment,
  type AssetAccountAuthorization,
  type AssetActionInput,
  type AssetActionOutput,
} from "@pcash/sdk/builders";
import { privateValueProfile, type PrivateValueShape } from "@pcash/sdk/constants";
import { SparseMerkleTree } from "@pcash/sdk/crypto";
import { authorizePcashRequestWithPrivateKey } from "@pcash/sdk/eip712";
import {
  accountRuleEntryCommitment,
  accountStateCommitment,
  buildAccountRuleSet,
  buildContractBody,
  DEFAULT_NETWORK_CONFIG,
  findAssetDescriptor,
  fullOutputCommitment,
  functionSelector,
  nativeBurnAmount,
  noteNk,
  nullifierKeyCommitment,
  ownerChangeNoteSecret,
  restrictedAssetOpening,
  sizeClassFiller,
  type ChonkVkArtifacts,
  type NativeBurn,
  type PreparedEvent,
  type TransferRule,
} from "@pcash/sdk/protocol";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import { syntheticRecentBlockFixture, TEST_DEFAULT_RULE_SECRETS, TEST_MINT_RULE } from "./protocolFixtures.ts";
import { deriveTestWallet } from "./testWallet.ts";

/** Reachable immutable contract, two disjoint claim funding notes, and a real sponsor. */
export function sharedAssetClaimFixture(params: {
  shape: PrivateValueShape;
  preparedEvent?: PreparedEvent;
  claimVkHash: bigint;
  feePaid?: boolean;
  sponsorVkHash?: bigint;
  primaryConfigurationCommitment?: bigint;
  sponsorConfigurationCommitment?: bigint;
  validUntilTimestamp?: bigint;
  /** Burned from the sponsor's native input beside the open fee; the change shrinks by it. */
  burn?: NativeBurn;
  /** Makes the claimed asset restricted under this transfer rule. */
  transferRule?: TransferRule;
  /** The recent block's L1 origin root and timestamp. */
  recentBlock?: { l1OriginRoot: bigint; timestamp: bigint };
}) {
  const profile = privateValueProfile(params.shape);
  const burned = params.burn === undefined ? 0n : nativeBurnAmount(params.burn);
  if (profile.inputs < (params.feePaid ? 3 : 2) || profile.outputs < (params.feePaid ? 2 : 1)) throw new Error("profile cannot fit the claim fixture");
  const chainId = BigInt(DEFAULT_NETWORK_CONFIG.pcashChainId);
  const recipient = deriveTestWallet({ privKey: new Uint8Array(32).fill(9), nkRoot: 987n, mlKem: "deterministic" });
  const sponsor = deriveTestWallet({ mlKem: "deterministic" });
  const claimSecret = 12345n;
  const descriptor = findAssetDescriptor({
    metadataCommitment: 222n,
    mintRule: TEST_MINT_RULE,
    ...(params.transferRule === undefined ? {} : { transferRule: params.transferRule }),
  }, 0n);
  const assetId = descriptor.assetId;
  const restricted = restrictedAssetOpening(descriptor);
  const configuration = { assetId, recipient: recipient.address, amount: 1000n, maximumFee: 5n + burned,
    secretCommitment: sharedAssetClaimSecretCommitment(claimSecret) };
  const configurationCommitment = params.primaryConfigurationCommitment ?? sharedAssetClaimConfigurationCommitment(configuration);
  const selectedEntryCommitment = accountRuleEntryCommitment(params.claimVkHash, configurationCommitment, 0n);
  const primaryNkRoot = 777n;
  const contract = buildContractBody({
    nullifierKey: { publishesNkRoot: true, nkRoot: primaryNkRoot },
    functions: [{ selector: functionSelector(0), applicationVkHash: params.claimVkHash, configurationCommitment }],
  });
  const primaryRules = buildAccountRuleSet([{ entryIndex: 0, accountRuleEntryCommitment: selectedEntryCommitment }]);
  const accounts = new SparseMerkleTree(40);
  accounts.setLeaf(0, contract.accountStateCommitment);
  const defaults = defaultUserAccountRuleSet({ wallet: sponsor, secrets: TEST_DEFAULT_RULE_SECRETS });
  const sponsorRule = params.shape === 1 ? defaults.largeContractFeeSponsorshipRule : defaults.contractFeeSponsorshipRule;
  const sponsorConfigurationCommitment = params.sponsorConfigurationCommitment ?? sponsorRule.configurationCommitment;
  const sponsorRules = buildAccountRuleSet([{ entryIndex: sponsorRule.entryIndex, accountRuleEntryCommitment: accountRuleEntryCommitment(
    params.sponsorVkHash ?? sponsorRule.applicationVkHash, sponsorConfigurationCommitment, sponsorRule.commitmentBlinder,
  ) }]);
  if (params.feePaid) accounts.setLeaf(1, accountStateCommitment(sponsor.address, nullifierKeyCommitment(sponsor.nkRoot), sponsorRules.accountRuleSetCommitment, 0n, 1n, 0n));
  const outputs = new SparseMerkleTree(40);
  for (let i = 0; i < 2; i++) outputs.setLeaf(i, fullOutputCommitment({ owner: contract.address, noteSecret: BigInt(444 + i), assetId, amount: 1000n }, i));
  outputs.setLeaf(2, fullOutputCommitment({ owner: sponsor.address, noteSecret: 446n, assetId: 0n, amount: 15n }, 2));
  const recent = syntheticRecentBlockFixture({ outputRoot: outputs.root, outputCount: 3, issuedSoFar: 15n,
    lagQ: 100n, accountStateRoot: accounts.root, accountCount: params.feePaid ? 2 : 1, ...params.recentBlock });
  const snapshot = {
    recentPcashBlockHash: recent.recentPcashBlockHash, stateRoot: recent.stateRoot,
    stateRootHeaderSiblings: recent.stateRootHeaderSiblings, outputRoot: outputs.root,
    outputRootStateSiblings: recent.outputRootStateSiblings, accountStateRoot: accounts.root,
    accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
  };
  const primary: AssetAccountAuthorization = {
    address: contract.address, nkRoot: primaryNkRoot, accountIndex: 0, accountSiblings: accounts.proof(0).siblings,
    accountRuleSetCommitment: contract.functionSetCommitment, accountKind: 1n, accountRevision: 1n,
    receiveKeyHash: 0n,
    rule: { configurationCommitment, commitmentBlinder: 0n, entryIndex: 0, siblings: primaryRules.membership(0).siblings },
  };
  const feePayer: AssetAccountAuthorization = {
    address: sponsor.address, nkRoot: sponsor.nkRoot, accountIndex: 1, accountSiblings: accounts.proof(1).siblings,
    accountRuleSetCommitment: sponsorRules.accountRuleSetCommitment, accountKind: 0n, accountRevision: 1n,
    receiveKeyHash: 0n,
    rule: { configurationCommitment: sponsorConfigurationCommitment, commitmentBlinder: sponsorRule.commitmentBlinder,
      entryIndex: sponsorRule.entryIndex, siblings: sponsorRules.membership(sponsorRule.entryIndex).siblings },
  };
  const fundingIndex = params.shape;
  const assetInput = { slot: 0, noteSecret: BigInt(444 + fundingIndex), amount: 1000n, leafIndex: fundingIndex, siblings: outputs.proof(fundingIndex).siblings };
  const nativeInput = { slot: profile.inputs - 2, noteSecret: 446n, amount: 15n, leafIndex: 2, siblings: outputs.proof(2).siblings };
  const inputSlots: AssetActionInput[] = Array.from({ length: profile.inputs }, () => ({ kind: "dummy" }));
  inputSlots[0] = { kind: "asset", ...assetInput };
  inputSlots[profile.inputs - 1] = { kind: "application", selectedEntryCommitment, replayId: sharedAssetClaimReplayId(claimSecret) };
  if (params.feePaid) inputSlots[nativeInput.slot] = { kind: "native", ...nativeInput, owner: sponsor.address, nk: noteNk(sponsor.nkRoot) };
  const outputSlots: AssetActionOutput[] = Array.from({ length: profile.outputs }, (_, index) => ({
    kind: "dummy", dummySecret: BigInt(500 + index), amount: 0n, outputData: sizeClassFiller(),
  }));
  const deliverySecret = 888n;
  outputSlots[profile.outputs - 1] = openedAssetActionOutput({ kind: "asset", pcashChainId: chainId,
    assetId, outputIndex: profile.outputs - 1, noteSecret: deliverySecret, amount: 1000n,
    recipientAddress: recipient.address, recipientMlKemPublicKey: recipient.mlKemPublicKey!, authenticatedRecipient: true });
  const dummyInputSeed = BigInt(900 + params.shape);
  const nullifiers = assetActionInputNullifiers({ owner: primary, assetId, inputs: inputSlots, dummyInputSeed, nativeFeePayer: params.feePaid === true });
  const change = params.feePaid
    ? { slot: 0, noteSecret: ownerChangeNoteSecret(sponsor.nkRoot, nullifiers, 0, params.shape), amount: 10n - burned }
    : null;
  if (change) outputSlots[0] = openedAssetActionOutput({ kind: "native", pcashChainId: chainId,
    assetId: 0n, outputIndex: 0, noteSecret: change.noteSecret, amount: change.amount,
    recipientAddress: sponsor.address, recipientMlKemPublicKey: sponsor.mlKemPublicKey!, authenticatedRecipient: true });
  const build = buildAssetAction({
    ...(params.preparedEvent === undefined ? {} : { preparedEvent: params.preparedEvent }),
    shape: params.shape, pcashChainId: chainId, snapshot, owner: primary, assetId, nativeFeePayer: params.feePaid === true,
    ...(restricted === undefined ? {} : { restricted }),
    inputs: inputSlots, outputs: outputSlots, openFeeAmount: params.feePaid ? 5n : 0n, issuanceOwnerCommitment: 0n,
    ...(params.burn === undefined ? {} : { burn: params.burn }),
    validUntilTimestamp: params.validUntilTimestamp ?? 999_999n, dummyInputSeed,
  });
  const openings = Array.from({ length: profile.outputs }, (_, index) => index === profile.outputs - 1 ? { amount: 1000n, noteSecret: deliverySecret } : null);
  const claimWitnessMap = buildSharedAssetClaimWitness({
    build, configuration, claimSecret, selectedEntryCommitment, feePaid: params.feePaid === true, outputs: openings,
  });
  const prepared = params.feePaid ? prepareContractFeeSponsorshipAuthorization({
    build, primary, wallet: sponsor,
    sponsoredContract: contract.address,
  }) : null;
  const signed = prepared?.authorize(authorizePcashRequestWithPrivateKey(sponsor.privKey, prepared.request));
  const kernelWitnessMap = (primaryVk: ChonkVkArtifacts, feeVk: ChonkVkArtifacts, policyVk?: ChonkVkArtifacts) => buildSponsoredTransferWitness({
    build, snapshot, pcashChainId: chainId, assetId, primary, feePayer, primaryVk, feeVk,
    ...(policyVk === undefined ? {} : { policyVk }),
  }).witnessMap;
  return { build, contract, primary, feePayer, recipient, sponsor, snapshot, recent, descriptor, selectedEntryCommitment,
    claimWitnessMap, configuration, claimSecret, prepared, signed, kernelWitnessMap };
}
