import { buildAssetAction } from "../src/builders/assetAction.ts";
import type { AssetAccountAuthorization, AssetActionInput, AssetActionOutput } from "../src/builders/assetOutputs.ts";
import { privateValueProfile, type PrivateValueShape } from "../src/constants/privateValueProfiles.ts";
import { MERKLE_DEPTH } from "../src/constants/params.ts";
import { poseidon } from "../src/crypto/poseidon2.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { accountRuleEntryCommitment, buildAccountRuleSet } from "../src/protocol/account.ts";
import { buildContractBody, functionSelector } from "../src/protocol/contract.ts";
import { sizeClassFiller } from "../src/protocol/envelope.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { compositePrivateValueMap, fm } from "../src/protocol/witness.ts";
import { syntheticRecentBlockFixture } from "@pcash/test-support/protocol-fixtures";

/** Installed secret-controlled contract, an empty note tree, and one marker. */
export function markerAuthorityFixture(shape: PrivateValueShape, applicationVkHash: bigint) {
  const profile = privateValueProfile(shape);
  const secret = 12345n;
  const configurationCommitment = poseidon([1n, secret]);
  const replayId = poseidon([2n, secret]);
  const selectedEntryCommitment = accountRuleEntryCommitment(applicationVkHash, configurationCommitment, 0n);
  const rules = buildAccountRuleSet([{ entryIndex: 0, accountRuleEntryCommitment: selectedEntryCommitment }]);
  const nkRoot = 777n;
  const contract = buildContractBody({
    nullifierKey: { publishesNkRoot: true, nkRoot },
    functions: [{ selector: functionSelector(0), applicationVkHash, configurationCommitment }],
  });
  const accounts = new SparseMerkleTree(MERKLE_DEPTH);
  accounts.setLeaf(0, contract.accountStateCommitment);
  const outputs = new SparseMerkleTree(MERKLE_DEPTH);
  const recent = syntheticRecentBlockFixture({ outputRoot: outputs.root, outputCount: 0,
    issuedSoFar: 0n, lagQ: 100n, accountStateRoot: accounts.root, accountCount: 1 });
  const snapshot = {
    recentPcashBlockHash: recent.recentPcashBlockHash, stateRoot: recent.stateRoot,
    stateRootHeaderSiblings: recent.stateRootHeaderSiblings, outputRoot: outputs.root,
    outputRootStateSiblings: recent.outputRootStateSiblings, accountStateRoot: accounts.root,
    accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
  };
  const owner: AssetAccountAuthorization = {
    address: contract.address, nkRoot, accountIndex: 0, accountSiblings: accounts.proof(0).siblings,
    accountRuleSetCommitment: contract.functionSetCommitment, accountKind: 1n, accountRevision: 1n,
    receiveKeyHash: 0n, rule: { configurationCommitment, commitmentBlinder: 0n,
      entryIndex: 0, siblings: rules.membership(0).siblings },
  };
  const inputs: AssetActionInput[] = Array.from({ length: profile.inputs }, () => ({ kind: "dummy" }));
  inputs[profile.inputs - 1] = { kind: "application", selectedEntryCommitment, replayId };
  const outputSlots: AssetActionOutput[] = Array.from({ length: profile.outputs }, (_, index) => ({
    kind: "dummy", dummySecret: BigInt(500 + index), amount: 0n, outputData: sizeClassFiller(),
  }));
  const chainId = BigInt(DEFAULT_NETWORK_CONFIG.pcashChainId);
  const build = buildAssetAction({ shape, pcashChainId: chainId, snapshot, owner, assetId: 0n,
    inputs, outputs: outputSlots, openFeeAmount: 0n, issuanceOwnerCommitment: 0n,
    validUntilTimestamp: 999_999n, dummyInputSeed: 900n });
  const witnessMap = {
    pcash_chain_id: fm(chainId),
    recent_pcash_block_hash: fm(recent.recentPcashBlockHash),
    event_entry: fm(build.eventOpening.eventEntry),
    address: fm(build.address),
    shape, private_value: compositePrivateValueMap(build.transaction, shape),
    secret: fm(secret), selected_entry_commitment: fm(selectedEntryCommitment),
  };
  return { build, witnessMap, selectedEntryCommitment, replayId, contract, rules };
}
