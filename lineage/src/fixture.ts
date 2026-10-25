import { keccak_256 } from "@noble/hashes/sha3.js";
import { withSyntheticTransferOpenings, syntheticRecentBlockFixture } from "@pcash/test-support/protocol-fixtures";
import { deriveWalletIdentity, authorizePcashRequestWithPrivateKey } from "@pcash/sdk/eip712";
import { buildNativeTransfer } from "@pcash/sdk/builders";
import { generateMlKemKeyPair } from "@pcash/sdk/protocol";
import { accountRuleEntryCommitment, buildAccountRuleSet } from "@pcash/sdk/protocol";
import { lineageGateConfigurationCommitment, lineageGateWitness } from "./gated.ts";
import { ownerCommitment } from "@pcash/sdk/protocol";
import { openBlockHeaderKey, blockHash, payoutResultLeaf, transactionResultsRoot } from "@pcash/sdk/protocol";
import { l1OriginLeaf, normalizeL1Logs } from "@pcash/sdk/protocol";
import { SparseMerkleTree } from "@pcash/sdk/crypto";
import { fieldToHex as fm } from "@pcash/sdk/crypto";
import { beBytes, field32, utf8 } from "@pcash/sdk/utils";
import type { CurrentBoundaryEnvelope, CurrentBoundaryEnvelopeRpc } from "@pcash/sdk/protocol";
import type { L1LogProofResult } from "@pcash/sdk/clients";
import type { ResultProofRpc } from "@pcash/sdk/clients";
import { prepareEventApplication, type ChonkCircuitResolver } from "@pcash/sdk/prover";
import { buildPolicy, claimEvent } from "./policy.ts";
import { buildLineageWitness } from "./witness.ts";

const quantity = (value: bigint) => `0x${value.toString(16)}`;
export function boundaryRpc(boundary: CurrentBoundaryEnvelope): CurrentBoundaryEnvelopeRpc {
  return {
    state: { outputRoot: fm(boundary.state.outputRoot), outputCount: quantity(boundary.state.outputCount), issuedSoFar: quantity(boundary.state.issuedSoFar), lagQ: boundary.state.lagQ.toString(), accountStateRoot: fm(boundary.state.accountStateRoot), accountCount: quantity(boundary.state.accountCount), nullifierRoot: fm(boundary.state.nullifierRoot), nullifierCount: quantity(boundary.state.nullifierCount) },
    header: { parentHash: fm(boundary.header.parentHash), number: quantity(boundary.header.number), timestamp: quantity(boundary.header.timestamp), transactionResultsRoot: fm(boundary.header.transactionResultsRoot), stateRoot: fm(boundary.header.stateRoot), l1OriginRoot: fm(boundary.header.l1OriginRoot), historyRoot: fm(boundary.header.historyRoot) },
    blockHash: fm(boundary.blockHash),
  };
}

/** Benchmark-only synthetic anchor; the e2e scenario supplies actual accepted results. */
export async function lineageFixture(resolve: ChonkCircuitResolver, withEvent = true, gated = false) {
  const material = withEvent ? await resolve("event_lineage", "app") : undefined;
  const lineageVk = material === undefined ? 1n : BigInt(material.vkHash);
  const key = beBytes(123n, 32);
  const receive = generateMlKemKeyPair(new Uint8Array(64).fill(7));
  const wallet = { ...deriveWalletIdentity(key), privKey: key, nkRoot: 12345n, mlKemPublicKey: receive.publicKey, mlKemSecretKey: receive.secretKey };
  let params = withSyntheticTransferOpenings({
    wallet, authorizationResolver: request => authorizePcashRequestWithPrivateKey(key, request), chainId: 0x1ff6n, recipientAddress: wallet.address, recipientReceiveKey: receive.publicKey,
    inputAmount: 1000n, paymentAmount: 900n, openFeeAmount: 10n, issuanceOwnerCommitment: 0n,
    noteSecret: 100n, dummyInputEntropy: 17n, validUntilTimestamp: 999999n, eventSalt: 703n,
  });
  const initial = buildNativeTransfer(params);
  const sourceCommitment = BigInt(initial.transaction.inputs[0]!.inputCommitment);
  const policy = buildPolicy(0x703n, [sourceCommitment], [1n, 2n]);
  const gateConfiguration = { salt: 91n, policyRoot: policy.root, lineageVk };
  if (gated) {
    const gate = await resolve("lineage_gated", "app");
    const configurationCommitment = lineageGateConfigurationCommitment(gateConfiguration);
    const commitmentBlinder = 92n;
    const rules = buildAccountRuleSet([{ entryIndex: 0, accountRuleEntryCommitment: accountRuleEntryCommitment(BigInt(gate.vkHash), configurationCommitment, commitmentBlinder) }]);
    params = withSyntheticTransferOpenings({ ...params, inputAmount: 1000n, noteSecret: 100n, defaultRuleSecrets: undefined,
      accountKind: 1n, accountRuleSetCommitment: rules.accountRuleSetCommitment,
      accountRule: { configurationCommitment, commitmentBlinder, entryIndex: 0, siblings: rules.membership(0).siblings } });
  }
  const rootSequence = 1n;
  const logs = normalizeL1Logs([{ transactionIndex: 0, logIndex: 0, emitter: policy.provider, topics: [keccak_256(utf8("RootPublished(uint256,uint256)"))], data: Uint8Array.from([...field32(policy.root), ...field32(rootSequence)]) }]);
  const ethereumHash = new Uint8Array(32).fill(1);
  const origins = new SparseMerkleTree(40);
  origins.setLeaf(0, l1OriginLeaf({ blockNumber: 1n, blockHash: ethereumHash, timestamp: 1n, logsRoot: logs.root, logCount: 1 }));
  const payout = { outputIndex: 0n, ownerCommitment: ownerCommitment(wallet.address, 100n), openFeeAmount: 0n, issuanceAmount: 1000n };
  const resultTree = new SparseMerkleTree(64); resultTree.setLeaf(0, payoutResultLeaf(payout));
  const base = syntheticRecentBlockFixture({ outputRoot: params.outputRoot, outputCount: 1, accountStateRoot: params.accountStateRoot, accountCount: 1, l1OriginRoot: origins.root });
  const header = { ...base.boundary.header, transactionResultsRoot: transactionResultsRoot([], [payout]) };
  const recentHash = blockHash(header);
  const boundary = { ...base.boundary, header, blockHash: recentHash };
  const preparedEvent = withEvent ? await prepareEventApplication({ packageName: "event_lineage", event: claimEvent({ root: policy.root, applicationVkHash: lineageVk, qualificationMask: 3 }), eventSalt: 703n, resolve: async () => material! }) : undefined;
  const build = buildNativeTransfer({ ...params, preparedEvent, recentPcashBlockHash: recentHash, stateRootHeaderSiblings: openBlockHeaderKey(header, 4).siblings });
  const publication: L1LogProofResult = {
    recentPcashBlockHash: recentHash, l1OriginRoot: origins.root, l1OriginRootSiblings: openBlockHeaderKey(header, 5).siblings,
    l1BlockNumber: 1n, l1BlockHash: ethereumHash, l1BlockTimestamp: 1n, l1LogsRoot: logs.root, l1LogCount: 1n,
    l1OriginIndex: 0n, l1OriginSiblings: origins.proof(0).siblings, logLeafIndex: 0n, logSiblings: logs.proof(0), transactionIndex: 0n, logIndex: 0n, boundary,
  };
  const rpc = boundaryRpc(boundary);
  const proof: ResultProofRpc = {
    recentPcashBlockHash: fm(recentHash), recentBoundary: rpc, block: { recentPcashBlockHash: fm(recentHash), boundary: rpc }, history: null,
    transactionCount: "0x0", payoutCount: "0x1", resultsTreeRoot: fm(resultTree.root), resultsRootSiblings: openBlockHeaderKey(header, 3).siblings.map(fm), leafIndex: "0x0", siblings: resultTree.proof(0).siblings.map(fm),
    leaf: { kind: "payout", outputIndex: "0x0", ownerCommitment: fm(payout.ownerCommitment), openFeeAmount: "0x0", issuanceAmount: "0x3e8", outputSiblings: params.inputs![0]!.siblings.map(value => fm(value)) },
  };
  const eventApplication = preparedEvent === undefined ? undefined : buildLineageWitness({ build, preparedEvent, policy, lineageVk, publication, rootSequence, inputs: [{ commitment: sourceCommitment, proof }, null, null, null] });
  return { build, gateWitness: gated ? lineageGateWitness({ address: build.address, configuration: gateConfiguration, build }) : undefined, eventApplication, policy, proof, publication, wallet, params, sourceCommitment };
}
