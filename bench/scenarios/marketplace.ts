import {
  claimConfigurationCommitment as marketplaceClaimConfigurationCommitment,
  claimKeyCommitment as marketplaceClaimKeyCommitment,
  paymentCarrierContextHash,
} from "@pcash/marketplace";
import { MARKETPLACE_CIRCUITS, buildClaimWitnessMap } from "@pcash/marketplace/proofs";
import {
  MERKLE_DEPTH,
  SparseMerkleTree,
  fullOutputCommitment,
  nullifier, noteNk, dummyNullifier,
  generateMlKemKeyPair,
} from "@pcash/sdk/browser";
import { CIRCUIT_URLS, type ChonkProofStep } from "@pcash/sdk/browser-prover";
import { buildContractFunctionCall } from "@pcash/sdk/builders";
import { buildContractBody, decodeContractBody } from "@pcash/sdk/protocol";
import { syntheticRecentBlockFixture } from "@pcash/test-support/protocol-fixtures";
import {
  noOpEventApplicationStep,
  noOpEventApplicationWitness,
  NO_OP_EVENT_APPLICATION,
  hidingKernelWitness,
  selector,
  type PerformanceScenario,
  type PreparedScenario,
  type ScenarioContext,
} from "./common.ts";

/** A Marketplace escrow claim that requires the payment router's carrier context. */
export const marketplaceClaimScenario: PerformanceScenario = {
  id: "marketplaceClaim",
  label: "Marketplace claim",
  description: "An escrow claim bound to the payment router's PcashBatch context for its payment.",
  circuits: ["contracts/escrow/claim", NO_OP_EVENT_APPLICATION, "private_value_transfer_kernel", "private_value_hiding_kernel"],
  prepare,
};

async function prepare(context: ScenarioContext): Promise<PreparedScenario> {
  const [claimVk, noOpEventApplicationVk, transferKernelVk, hidingKernelVk] = await Promise.all([
    context.vk("contracts/escrow/claim"),
    context.vk(NO_OP_EVENT_APPLICATION),
    context.vk("private_value_transfer_kernel"),
    context.vk("private_value_hiding_kernel"),
  ]);
  const terms = {
    router: 0x5fbdb2315678afecb367f032d93f642f64180aa3n,
    seller: 0xd0d0n,
    id: 0x0ffe100000000001n,
    assetId: 0n,
    amount: 0x3782dace9d90000n,
    ethPriceWei: 1_000_000_000_000_000_000n,
    deadlineT: 2_000_000_000n,
  };
  const chainId = 0x50435348n;
  const configurationSalt = 1n;
  const configurationCommitment = marketplaceClaimConfigurationCommitment(configurationSalt, terms);
  const contractAccount = buildContractBody({
    nullifierKey: { publishesNkRoot: true, nkRoot: 0xc1a1c1a1n },
    functions: [{
      selector,
      applicationVkHash: BigInt(claimVk.hash),
      configurationCommitment,
    }],
  });
  const contract = decodeContractBody(contractAccount.body);

  const claimKey = 0x1234567890abcdefn;
  const escrowNoteSecret = 0x123n;
  const outputTree = new SparseMerkleTree(MERKLE_DEPTH);
  const escrowOutputCommitment = fullOutputCommitment({
    owner: contractAccount.address,
    noteSecret: escrowNoteSecret,
    assetId: 0n,
    amount: terms.amount,
  }, 0);
  outputTree.setLeaf(0, escrowOutputCommitment);
  const accountStateTree = new SparseMerkleTree(MERKLE_DEPTH);
  accountStateTree.setLeaf(0, contractAccount.accountStateCommitment);

  // The open route sends issuance to the successful poster.
  const issuanceOwnerCommitment = 0n;
  const nullifiers = [nullifier(escrowOutputCommitment, noteNk(0xc1a1c1a1n), escrowNoteSecret), dummyNullifier(0xc1a1n, 1n), dummyNullifier(0xc1a1n, 2n), dummyNullifier(0xc1a1n, 3n)];
  const claimCommitment = marketplaceClaimKeyCommitment(claimKey, escrowOutputCommitment);

  const recent = syntheticRecentBlockFixture({
    outputRoot: outputTree.root,
    outputCount: 1,
    issuedSoFar: 0n,
    lagQ: 0n,
    accountStateRoot: accountStateTree.root,
    accountCount: 1,
  });
  const recipientAddress = 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266n;
  const recipientReceiveKey = generateMlKemKeyPair();
  const build = buildContractFunctionCall({
    chainId,
    contract,
    selector,
    recipientAddress,
    recipientReceiveKey: recipientReceiveKey.publicKey,
    paymentAmount: terms.amount,
    inputs: [{
      amount: terms.amount,
      noteSecret: escrowNoteSecret,
      outputIndex: 0,
      siblings: outputTree.proof(0).siblings,
    }],
    openFeeAmount: 0n,
    issuanceOwnerCommitment,
    dummyInputEntropy: 0xc1a1n,
    validUntilTimestamp: terms.deadlineT,
    carrierContextHash: paymentCarrierContextHash(terms, claimCommitment),
    recentPcashBlockHash: recent.recentPcashBlockHash,
    stateRoot: recent.stateRoot,
    stateRootHeaderSiblings: recent.stateRootHeaderSiblings,
    outputRoot: outputTree.root,
    outputRootStateSiblings: recent.outputRootStateSiblings,
    accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
    accountIndex: 0,
    accountStateRoot: accountStateTree.root,
    accountSiblings: accountStateTree.proof(0).siblings,
    outputNoteSecrets: [0xc1a2n],
    outputEntropies: [0xc1b0n, 0xc1b1n, 0xc1b2n, 0xc1b3n, 0xc1b4n],
  });

  const claimWitness = buildClaimWitnessMap({
    configurationSalt,
    recentPcashBlockHash: build.recentPcashBlockHash,
    address: build.address,
    pcashChainId: chainId,
    feePaid: false,
    claimKey,
    offer: terms,
    transaction: build.transaction,
    escrowNote: {
      noteSecret: escrowNoteSecret,
      outputIndex: 0n,
    },
    payoutOwner: recipientAddress,
    payoutNoteSecret: build.outputNoteSecrets[0],
    relayFeeAmount: 0n,
    relayFeeOwnerCommitment: 0n,
  });
  const kernelWitness = build.buildKernelWitnessMap({ vkFields: claimVk.fields, vkHash: claimVk.hash });
  const steps: ChonkProofStep[] = [
    {
      circuitUrl: MARKETPLACE_CIRCUITS.claim,
      vkUrl: claimVk.url,
      kind: "app",
      witnessMap: claimWitness,
      label: "Marketplace claim",
    },
    noOpEventApplicationStep(noOpEventApplicationVk, kernelWitness),
    {
      circuitUrl: CIRCUIT_URLS.private_value_transfer_kernel,
      vkUrl: transferKernelVk.url,
      kind: "kernel",
      witnessMap: {
        ...kernelWitness,
        ...noOpEventApplicationWitness(noOpEventApplicationVk, kernelWitness),
      },
      label: "transfer kernel",
    },
    {
      circuitUrl: CIRCUIT_URLS.private_value_hiding_kernel,
      vkUrl: hidingKernelVk.url,
      kind: "hiding",
      witnessMap: hidingKernelWitness(build.publicInputs, transferKernelVk),
      label: "hiding kernel",
    },
  ];
  return {
    privateValueCommitment: build.privateValueCommitment,
    run: (prover, onStatus) => prover.proveChonk({ steps, expectedPublicInputs: build.publicInputs }, onStatus),
  };
}
