// Restricted actions over a synthetic recent block whose L1 origin tree holds
// one deny-list publication, with the standard sender deny list as the asset's
// transfer rule. `restrictedTransferFixture`: the owner pays one recipient
// under its own rule. `restrictedSponsoredTransferFixture`: a contract's shared
// asset claim with a separate fee payer.

import {
  buildAssetAction,
  openedAssetActionOutput,
  ownerChangeAssetActionOutput,
  type AssetActionBuild,
  type AssetActionInput,
  type AssetActionOutput,
} from "@pcash/sdk/builders";
import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "@pcash/sdk/constants";
import { SparseMerkleTree } from "@pcash/sdk/crypto";
import { authorizePcashRequestWithPrivateKey } from "@pcash/sdk/eip712";
import {
  accountRuleEntryCommitment,
  accountStateCommitment,
  buildAccountRuleSet,
  DEFAULT_NETWORK_CONFIG,
  findAssetDescriptor,
  fullOutputCommitment,
  l1OriginLeaf,
  normalizeL1Logs,
  nullifierKeyCommitment,
  restrictedAssetOpening,
  sizeClassFiller,
  sponsoredTransferActionCommitment,
  transferActionCommitment,
  type L1LogGrounding,
  type L1LogInput,
  type TransferRule,
} from "@pcash/sdk/protocol";
import {
  buildDenyListTree,
  defaultUserAccountRuleSet,
  denyListConfigurationCommitment,
  ecdsaRuleConfigurationCommitment,
  PUBLICATION_TOPIC0,
  senderDenyListWitness,
} from "@pcash/sdk/rules";
import { beBytes } from "@pcash/sdk/utils";
import { syntheticRecentBlockFixture, TEST_DEFAULT_RULE_SECRETS, TEST_MINT_RULE } from "./protocolFixtures.ts";
import { sharedAssetClaimFixture } from "./sharedAssetClaimFixtures.ts";
import { deriveTestWallet } from "./testWallet.ts";

export const DENY_LIST_CONTRACT = 0x5fbdb2315678afecb367f032d93f642f64180aa3n;
export const DENY_LIST_ID = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
export const PUBLICATION_TIMESTAMP = 1_700_000_000n;
export const DELTA = 3_600n;
export const MAX_DELTA = 7_200n;
const DENIED = 0x1000000000000000000000000000000000000001n;

function publicationLog(root: bigint, paused: boolean): L1LogInput {
  const data = new Uint8Array(96);
  data.set(beBytes(root, 32), 0);
  data.set(beBytes(paused ? 1n : 0n, 32), 32);
  data.set(beBytes(DELTA, 32), 64);
  return { transactionIndex: 0, logIndex: 0, emitter: DENY_LIST_CONTRACT, topics: [PUBLICATION_TOPIC0, DENY_LIST_ID], data };
}

/** One publication of a deny list over `denied`, at index 0 of a synthetic L1 origin tree. */
function denyListPublication(denied: readonly bigint[], paused: boolean) {
  const tree = buildDenyListTree([...denied]);
  const log = publicationLog(tree.root, paused);
  const logs = normalizeL1Logs([log]);
  const l1BlockHash = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i);
  const l1Origin = new SparseMerkleTree(40);
  l1Origin.setLeaf(0, l1OriginLeaf({ blockNumber: 12n, blockHash: l1BlockHash, timestamp: PUBLICATION_TIMESTAMP, logsRoot: logs.root, logCount: 1 }));
  const configuration = { contractAddress: DENY_LIST_CONTRACT, listId: DENY_LIST_ID, maxDelta: MAX_DELTA };
  /** The transfer rule naming `policyVkHash` for both profiles. */
  const transferRule = (policyVkHash: bigint): TransferRule => ({
    sVkHash: policyVkHash, lVkHash: policyVkHash, configurationCommitment: denyListConfigurationCommitment(configuration),
  });
  /** The deny list's witness for `ownerAddress` and `actionCommitment` under `build`'s recent block. */
  const witness = (params: {
    build: AssetActionBuild;
    l1OriginRootSiblings: L1LogGrounding["l1OriginRootSiblings"];
    ownerAddress: bigint;
    actionCommitment: bigint;
  }) => senderDenyListWitness({
    assetId: params.build.assetId,
    ownerAddress: params.ownerAddress,
    validUntilTimestamp: BigInt(params.build.transaction.global.validUntilTimestamp),
    configuration,
    publicationLog: log,
    publicationOpening: {
      l1OriginRoot: l1Origin.root,
      l1OriginRootSiblings: params.l1OriginRootSiblings,
      l1BlockNumber: 12n,
      l1BlockHash,
      l1BlockTimestamp: PUBLICATION_TIMESTAMP,
      l1OriginIndex: 0,
      l1OriginSiblings: l1Origin.proof(0).siblings,
      logsRoot: logs.root,
      logCount: 1,
      logLeafIndex: 0,
      logSiblings: logs.proof(0),
      transactionIndex: 0,
      logIndex: 0,
    },
    gap: tree.gapOpening(params.ownerAddress),
    actionCommitment: params.actionCommitment,
    recentPcashBlockHash: params.build.recentPcashBlockHash,
    eventEntry: params.build.eventOpening.eventEntry,
  });
  return { tree, configuration, l1OriginRoot: l1Origin.root, transferRule, witness };
}

export function restrictedTransferFixture(params: {
  /** The owner's rule VK hash: the asset-payment rule for S, the large batch-transfer rule for L. */
  authorizationVkHash: bigint;
  /** The sender deny list's VK hash, which the asset's transfer rule names for both profiles. */
  policyVkHash: bigint;
  shape?: PrivateValueShape;
  /** Deny the owner in the published list. */
  ownerDenied?: boolean;
  paused?: boolean;
  validUntilTimestamp?: bigint;
}) {
  const shape = params.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId;
  const profile = privateValueProfile(shape);
  const chainId = BigInt(DEFAULT_NETWORK_CONFIG.pcashChainId);
  const wallet = deriveTestWallet({ mlKem: "deterministic" });
  const recipient = deriveTestWallet({ privKey: new Uint8Array(32).fill(7), nkRoot: 456n, mlKem: "deterministic" });

  const publication = denyListPublication([DENIED, ...(params.ownerDenied === true ? [wallet.address] : [])], params.paused === true);
  const { tree, configuration } = publication;
  const descriptor = findAssetDescriptor({
    metadataCommitment: 0x5ca1en,
    mintRule: TEST_MINT_RULE,
    transferRule: publication.transferRule(params.policyVkHash),
  }, 0n);
  const assetId = descriptor.assetId;

  const defaults = defaultUserAccountRuleSet({ wallet, secrets: TEST_DEFAULT_RULE_SECRETS });
  const defaultRule = shape === PRIVATE_VALUE_PROFILES.L.shapeId ? defaults.largeBatchTransferRule : defaults.assetPaymentRule;
  const configurationCommitment = ecdsaRuleConfigurationCommitment(DEFAULT_NETWORK_CONFIG, nullifierKeyCommitment(wallet.nkRoot));
  const set = buildAccountRuleSet([{ entryIndex: defaultRule.entryIndex, accountRuleEntryCommitment: accountRuleEntryCommitment(
    params.authorizationVkHash, configurationCommitment, defaultRule.commitmentBlinder,
  ) }]);
  const outputs = new SparseMerkleTree(40);
  const accounts = new SparseMerkleTree(40);
  const noteSecret = 0x5ec2n;
  const held = 100n;
  outputs.setLeaf(0, fullOutputCommitment({ owner: wallet.address, noteSecret, assetId, amount: held }, 0));
  accounts.setLeaf(0, accountStateCommitment(wallet.address, nullifierKeyCommitment(wallet.nkRoot), set.accountRuleSetCommitment, 0n, 1n, 0n));
  const recent = syntheticRecentBlockFixture({
    outputRoot: outputs.root, outputCount: 1, issuedSoFar: 0n, lagQ: 100n,
    accountStateRoot: accounts.root, accountCount: 1, l1OriginRoot: publication.l1OriginRoot, timestamp: PUBLICATION_TIMESTAMP + 60n,
  });
  const snapshot = {
    recentPcashBlockHash: recent.recentPcashBlockHash, stateRoot: recent.stateRoot,
    stateRootHeaderSiblings: recent.stateRootHeaderSiblings, outputRoot: outputs.root,
    outputRootStateSiblings: recent.outputRootStateSiblings, accountStateRoot: accounts.root,
    accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
  };

  const paid = 60n;
  const inputs: AssetActionInput[] = Array.from({ length: profile.inputs }, () => ({ kind: "dummy" }));
  inputs[0] = { kind: "asset", amount: held, noteSecret, leafIndex: 0, siblings: outputs.proof(0).siblings };
  const outputSlots: AssetActionOutput[] = Array.from({ length: profile.outputs }, (_, i) => ({
    kind: "dummy", dummySecret: BigInt(i + 321), amount: 0n, outputData: sizeClassFiller(),
  }));
  outputSlots[0] = openedAssetActionOutput({ kind: "asset", pcashChainId: chainId, assetId, outputIndex: 0, noteSecret: 0x777n, amount: paid,
    recipientAddress: recipient.address, recipientMlKemPublicKey: recipient.mlKemPublicKey!, authenticatedRecipient: true });
  outputSlots[1] = ownerChangeAssetActionOutput({ kind: "asset", pcashChainId: chainId, assetId, amount: held - paid, receiveKey: wallet.mlKemPublicKey! });
  const validUntilTimestamp = params.validUntilTimestamp ?? PUBLICATION_TIMESTAMP + 1_800n;
  const build = buildAssetAction({
    shape, pcashChainId: chainId, snapshot, assetId, restricted: restrictedAssetOpening(descriptor)!,
    owner: { address: wallet.address, nkRoot: wallet.nkRoot, accountIndex: 0, accountSiblings: accounts.proof(0).siblings,
      accountRuleSetCommitment: set.accountRuleSetCommitment, accountKind: 0n, accountRevision: 1n, receiveKeyHash: 0n,
      rule: { configurationCommitment, commitmentBlinder: defaultRule.commitmentBlinder, entryIndex: defaultRule.entryIndex,
        siblings: set.membership(defaultRule.entryIndex).siblings } },
    inputs, outputs: outputSlots, openFeeAmount: 0n, issuanceOwnerCommitment: 0n, validUntilTimestamp, dummyInputSeed: 0x5eedn,
  });
  const prepared = build.prepareOwnerAuthorization({ wallet });
  const signed = prepared.authorize(authorizePcashRequestWithPrivateKey(wallet.privKey, prepared.request));

  /** The deny list's witness for an owner and action; tests substitute either. */
  const policyWitness = (overrides: { ownerAddress?: bigint; actionCommitment?: bigint } = {}) => publication.witness({
    build,
    l1OriginRootSiblings: recent.l1OriginRootHeaderSiblings,
    ownerAddress: overrides.ownerAddress ?? wallet.address,
    actionCommitment: overrides.actionCommitment ?? transferActionCommitment(chainId, build.privateValueCommitment),
  });
  return { build, wallet, recipient, descriptor, assetId, prepared, signed, policyWitness, tree, configuration };
}

/**
 * `sharedAssetClaimFixture` with a fee payer, for an asset under the deny
 * list: the contract's claim is the primary rule, the sponsor's contract-fee
 * sponsorship the fee payer's, and the policy approves the contract's
 * sponsored-transfer action.
 */
export function restrictedSponsoredTransferFixture(params: {
  shape?: PrivateValueShape;
  /** The shared-asset-claim application's VK hash, the contract's installed function. */
  claimVkHash: bigint;
  /** The contract-fee-sponsorship rule's VK hash for this profile. */
  sponsorVkHash: bigint;
  /** The sender deny list's VK hash, which the asset's transfer rule names for both profiles. */
  policyVkHash: bigint;
  validUntilTimestamp?: bigint;
}) {
  const shape = params.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId;
  const chainId = BigInt(DEFAULT_NETWORK_CONFIG.pcashChainId);
  const publication = denyListPublication([DENIED], false);
  const claim = sharedAssetClaimFixture({
    shape, feePaid: true, claimVkHash: params.claimVkHash, sponsorVkHash: params.sponsorVkHash,
    validUntilTimestamp: params.validUntilTimestamp ?? PUBLICATION_TIMESTAMP + 1_800n,
    transferRule: publication.transferRule(params.policyVkHash),
    recentBlock: { l1OriginRoot: publication.l1OriginRoot, timestamp: PUBLICATION_TIMESTAMP + 60n },
  });
  /** The deny list's witness for an owner and action; tests substitute either. */
  const policyWitness = (overrides: { ownerAddress?: bigint; actionCommitment?: bigint } = {}) => publication.witness({
    build: claim.build,
    l1OriginRootSiblings: claim.recent.l1OriginRootHeaderSiblings,
    ownerAddress: overrides.ownerAddress ?? claim.contract.address,
    actionCommitment: overrides.actionCommitment ?? sponsoredTransferActionCommitment(chainId, claim.build.privateValueCommitment),
  });
  return { ...claim, prepared: claim.prepared!, signed: claim.signed!, policyWitness,
    tree: publication.tree, denyListConfiguration: publication.configuration };
}
