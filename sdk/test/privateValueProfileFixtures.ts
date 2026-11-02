import { buildNativeTransfer, type BuildNativeTransferParams } from "../src/builders/nativeTransfer.ts";
import { privateValueProfile, type PrivateValueShape } from "../src/constants/privateValueProfiles.ts";
import { ACCOUNT_KIND_USER, MERKLE_DEPTH } from "../src/constants/params.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { fullOutputCommitment, nullifierKeyCommitment } from "../src/protocol/notes.ts";
import { buildAccountRuleSet, accountRuleEntryCommitment } from "../src/protocol/account.ts";
import { ecdsaRuleConfigurationCommitment } from "../src/rules/referenceRules.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { beBytes } from "../src/utils/bytes.ts";
import { deriveTestWallet, testAuthorizationResolver } from "./testWallet.ts";
import { syntheticRecentBlockOpenings, withSyntheticTransferOpenings } from "@pcash/test-support/protocol-fixtures";

export type ProfileProofScenario = "minimal" | "consolidation" | "distribution";

/** Real signatures, membership openings, and encrypted delivery, usable by unit and native proof tests. */
export function privateValueProfileFixture(params: {
  shape: PrivateValueShape;
  scenario: ProfileProofScenario;
  /** A benchmark can install the actual key compiled from its experimental profile. */
  authorizationVkHash?: bigint;
  ruleConfigurationCommitment?: bigint;
}) {
  const profile = privateValueProfile(params.shape);
  const wallet = deriveTestWallet({ mlKem: "deterministic" });
  const chainId = BigInt(DEFAULT_NETWORK_CONFIG.pcashChainId);
  const inputCount = params.scenario === "consolidation" ? profile.inputs : 1;
  const inputAmount = params.scenario === "distribution" ? 100_000n : 1_000n;
  const openFeeAmount = 1n;
  const recipients = params.scenario === "consolidation"
    ? [wallet]
    : Array.from({ length: params.scenario === "distribution" ? Math.max(1, profile.outputs - 1) : 1 }, (_, i) =>
      deriveTestWallet({ privKey: beBytes(BigInt(i + 1), 32), nkRoot: BigInt(i + 50), mlKem: "deterministic" }));
  const paymentAmount = params.scenario === "consolidation" || profile.outputs <= 1 ? BigInt(inputCount) * inputAmount - openFeeAmount : 100n;
  let explicitRule: Pick<BuildNativeTransferParams, "accountKind" | "accountRuleSetCommitment" | "accountRule" | "buildEcdsaApplicationWitness"> = {};
  if (params.authorizationVkHash !== undefined) {
    const configurationCommitment = params.ruleConfigurationCommitment ?? ecdsaRuleConfigurationCommitment(DEFAULT_NETWORK_CONFIG, nullifierKeyCommitment(wallet.nkRoot));
    const commitmentBlinder = 790n;
    const entry = accountRuleEntryCommitment(params.authorizationVkHash, configurationCommitment, commitmentBlinder);
    const set = buildAccountRuleSet([{ entryIndex: 0, accountRuleEntryCommitment: entry }]);
    explicitRule = {
      accountKind: ACCOUNT_KIND_USER,
      accountRuleSetCommitment: set.accountRuleSetCommitment,
      accountRule: { configurationCommitment, commitmentBlinder, entryIndex: 0, siblings: set.membership(0).siblings },
      buildEcdsaApplicationWitness: params.ruleConfigurationCommitment === undefined,
    };
  }
  const base = withSyntheticTransferOpenings({
    shape: params.shape,
    chainId, wallet, ...explicitRule,
    authorizationResolver: testAuthorizationResolver(wallet),
    recipientAddress: recipients[0]!.address,
    recipientReceiveKey: recipients[0]!.mlKemPublicKey!,
    additionalOutputs: recipients.slice(1).map((recipient) => ({
      address: recipient.address, amount: 100n, receiveKey: recipient.mlKemPublicKey!,
    })),
    inputAmount, noteSecret: 100n,
    paymentAmount, openFeeAmount, issuanceOwnerCommitment: 0n,
    dummyInputEntropy: 42n,
    validUntilTimestamp: 9_999_999n,
  });
  const tree = new SparseMerkleTree(MERKLE_DEPTH);
  for (let i = 0; i < inputCount; i++) {
    tree.setLeaf(i, fullOutputCommitment({ owner: wallet.address, noteSecret: BigInt(100 + i), assetId: 0n, amount: inputAmount }, i));
  }
  const inputs = Array.from({ length: inputCount }, (_, i) => ({
    amount: inputAmount, noteSecret: BigInt(100 + i), outputIndex: i, siblings: tree.proof(i).siblings,
  }));
  const buildParams = {
    ...base, inputs, outputRoot: tree.root,
    ...syntheticRecentBlockOpenings({ outputRoot: tree.root, outputCount: inputCount, accountStateRoot: base.accountStateRoot, accountCount: 1 }),
  };
  return { build: buildNativeTransfer(buildParams), params: buildParams, wallet, recipients };
}
