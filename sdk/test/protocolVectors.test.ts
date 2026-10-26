import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeBlockHash, computeStateRoot } from "../src/protocol/boundary.ts";
import {
  assetCreationMarker,
  assetSecretCommitment,
  standardFungibleAssetId,
} from "../src/protocol/asset.ts";
import {
  buildContractBody,
  contractAddress,
  contractFunctionCommitment,
  decodeContractBody,
  functionSelector,
  verifyContract,
} from "../src/protocol/contract.ts";
import {
  blockHeaderTree,
  payoutResultLeaf,
  transactionResultLeaf,
  transactionResultsRoot,
  transactionStatementHash,
  TRANSACTION_OUTCOME_CODE,
  contentHash,
  transactionId,
  transactionOutcomeFromCode,
  genesisParentHash,
  historyLeaf,
  openBlockHeaderKey,
  openStateKey,
  stateTree,
  TypedCommitmentTree,
  verifyBlockHeaderPath,
  verifyL1OriginPath,
  verifyHistoryPath,
  verifyStatePath,
} from "../src/protocol/block.ts";
import { l1OriginLeaf, normalizedL1LogLeaf } from "../src/protocol/l1Logs.ts";
import { poseidon } from "../src/crypto/poseidon2.ts";
import { BLOCK_HEADER_DOMAIN, STATE_COMMITMENT_DOMAIN } from "../src/constants/domainTags.ts";
import {
  outputCommitment,
  noteNk,
  noteSecret,
  noteSecretSeed,
  nullifier,
  dummyNullifier,
} from "../src/protocol/notes.ts";
import {
  isLowNullifierLeaf,
  NULLIFIER_TREE_DEPTH,
  nullifierLeafHash,
  nullifierProofRoot,
  nullifierProofSpent,
  type NullifierLeaf,
  type NullifierProof,
} from "../src/protocol/nullifierTree.ts";
import { emptyLadder, rootFromIndex } from "../src/crypto/merkle.ts";
import {
  BLOCK_HEADER_KEY_STATE_ROOT,
  BLOCK_HEADER_TREE_DEPTH,
  HISTORY_TREE_DEPTH,
  STATE_TREE_DEPTH,
} from "../src/constants/params.ts";
import {
  accountRuleEntryCommitment,
  buildAccountRuleSet,
  accountStateCommitment,
  accountUpdateCommitment,
  receiveKeyHash,
} from "../src/protocol/account.ts";
import { arenaHash, deliveryCommitmentFromHashes, outputDataHash } from "../src/protocol/transfer.ts";
import {
  accountUpdateActionCommitment,
  assetCreationActionCommitment,
  authorizationCommitment,
  contractFeeSponsorshipActionCommitment,
  sponsoredTransferActionCommitment,
  transferActionCommitment,
} from "../src/protocol/statement.ts";
import {
  SlotClass,
  privateValueCommitment,
  type PrivateValue,
  type PrivateValueInput,
  type PrivateValueOutput,
} from "../src/protocol/transaction.ts";

const V = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../vectors/protocol_vectors.json", import.meta.url)), "utf8"),
);
const chainId = BigInt(V.chainId);
const P = BigInt(V.fieldModulus);

function bytes(value: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    throw new Error("invalid hex fixture");
  }
  return Uint8Array.from(
    { length: (value.length - 2) / 2 },
    (_, index) => Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16),
  );
}

function bytes32(value: string): Uint8Array {
  const result = bytes(value);
  if (result.length !== 32) throw new Error("fixture is not bytes32");
  return result;
}

function fields(values: readonly string[]): bigint[] {
  return values.map((value) => BigInt(value));
}

interface NullifierLeafVector {
  value: string;
  nextValue: string;
  nextIndex: number;
}

function nullifierLeaf(vector: NullifierLeafVector): NullifierLeaf {
  return { value: BigInt(vector.value), nextValue: BigInt(vector.nextValue), nextIndex: BigInt(vector.nextIndex) };
}

function nullifierProof(vector: {
  nullifier: string;
  leaf: NullifierLeafVector;
  leafIndex: number;
  siblings: string[];
}): NullifierProof {
  return {
    nullifier: BigInt(vector.nullifier),
    leaf: nullifierLeaf(vector.leaf),
    leafIndex: BigInt(vector.leafIndex),
    siblings: fields(vector.siblings),
  };
}

describe("protocol conformance vectors", () => {
  it("accepts full-width native fees and rejects values beyond 128 bits", () => {
    const transaction: PrivateValue = {
      global: {
        openFeeAmount: (1n << 128n) - 1n,
        issuanceOwnerCommitment: 0n,
        notBeforeTimestamp: 0n,
        validUntilTimestamp: 1n,
        carrierContextHash: 0n,
        assetBurnAmount: 0n,
        deliveryCommitment: 0n,
      accountCreationCommitment: 0n,
      },
      inputs: Array.from({ length: 4 }, (_, index) => ({
        slotClass: SlotClass.DUMMY, inputCommitment: 0n, nullifier: BigInt(index + 1),
      })),
      outputs: Array.from({ length: 5 }, (_, index) => ({
        slotClass: SlotClass.DUMMY, outputBodyCommitment: BigInt(index + 1),
      })),
    };
    const withGlobal = (global: Partial<PrivateValue["global"]>): PrivateValue =>
      ({ ...transaction, global: { ...transaction.global, ...global } });
    expect(() => privateValueCommitment(transaction)).not.toThrow();
    expect(() => privateValueCommitment(withGlobal({ issuanceOwnerCommitment: 1n })))
      .toThrow(/cannot coexist/);
    expect(() => privateValueCommitment(withGlobal({ openFeeAmount: 1n << 128n })))
      .toThrow(/openFeeAmount/);
  });

  it("commits the fixed private-value slots", () => {
    const vector = V.privateValueCommitment;
    const inputs = vector.inputs.map((input: {
      slotClass: PrivateValueInput["slotClass"];
      inputCommitment: string;
      nullifier: string;
    }) => ({
      slotClass: input.slotClass,
      inputCommitment: BigInt(input.inputCommitment),
      nullifier: BigInt(input.nullifier),
    })) as PrivateValue["inputs"];
    const outputs = vector.outputs.map((output: {
      slotClass: PrivateValueOutput["slotClass"];
      outputBodyCommitment: string;
    }) => ({
      slotClass: output.slotClass,
      outputBodyCommitment: BigInt(output.outputBodyCommitment),
    })) as PrivateValue["outputs"];
    const transaction: PrivateValue = {
      global: {
        openFeeAmount: BigInt(vector.global.openFeeAmount),
        issuanceOwnerCommitment: BigInt(vector.global.issuanceOwnerCommitment),
        notBeforeTimestamp: BigInt(vector.global.notBeforeTimestamp),
        validUntilTimestamp: BigInt(vector.global.validUntilTimestamp),
        carrierContextHash: BigInt(vector.global.carrierContextHash),
        assetBurnAmount: BigInt(vector.global.assetBurnAmount),
        deliveryCommitment: BigInt(vector.global.deliveryCommitment),
        accountCreationCommitment: BigInt(vector.global.accountCreationCommitment),
      },
      inputs,
      outputs,
    };
    expect(transaction.global.carrierContextHash).not.toBe(0n);
    expect(privateValueCommitment(transaction)).toBe(BigInt(vector.value));
    expect(privateValueCommitment({ ...transaction, global: { ...transaction.global, carrierContextHash: 0n } }))
      .not.toBe(BigInt(vector.value));
  });

  it("hashes the exact output-data and arena bytes into the delivery commitment", () => {
    expect(outputDataHash(bytes(V.outputDataHash.outputData))).toBe(BigInt(V.outputDataHash.value));
    expect(arenaHash(bytes(V.arenaHash.arena))).toBe(BigInt(V.arenaHash.value));
    const delivery = V.deliveryCommitment;
    expect(BigInt(delivery.arenaHash)).toBe(BigInt(V.arenaHash.value));
    expect(deliveryCommitmentFromHashes(fields(delivery.outputDataHashes), BigInt(delivery.arenaHash)))
      .toBe(BigInt(delivery.value));
    expect(BigInt(V.privateValueCommitment.global.deliveryCommitment)).toBe(BigInt(delivery.value));
  });

  it("derives the authorization commitment and one action commitment per role", () => {
    const authorization = V.authorizationCommitment;
    expect(authorizationCommitment(BigInt(authorization.address), BigInt(authorization.configurationCommitment)))
      .toBe(BigInt(authorization.value));
    const actions = V.actionCommitments;
    const chain = BigInt(actions.pcashChainId);
    const commitment = BigInt(actions.privateValueCommitment);
    expect(BigInt(actions.transfer.extraData)).toBe(0n);
    expect(transferActionCommitment(chain, commitment)).toBe(BigInt(actions.transfer.value));
    expect(BigInt(actions.assetCreation.extraData)).toBe(BigInt(V.assetComposition.assetId));
    expect(assetCreationActionCommitment(chain, commitment, BigInt(actions.assetCreation.extraData)))
      .toBe(BigInt(actions.assetCreation.value));
    expect(BigInt(actions.assetCreation.value)).not.toBe(BigInt(actions.transfer.value));
    expect(BigInt(actions.sponsoredTransfer.extraData)).toBe(0n);
    expect(sponsoredTransferActionCommitment(chain, commitment)).toBe(BigInt(actions.sponsoredTransfer.value));
    expect(contractFeeSponsorshipActionCommitment(chain, commitment, BigInt(actions.contractFeeSponsorship.extraData)))
      .toBe(BigInt(actions.contractFeeSponsorship.value));
    expect(accountUpdateActionCommitment(chain, commitment, BigInt(actions.accountUpdate.extraData)))
      .toBe(BigInt(actions.accountUpdate.value));
  });

  it("derives the asset ID and creation marker", () => {
    const vector = V.assetComposition;
    expect(assetSecretCommitment(BigInt(vector.assetSecret))).toBe(
      BigInt(vector.assetSecretCommitment),
    );
    expect(standardFungibleAssetId({
      metadataCommitment: BigInt(vector.metadataCommitment),
      initialSupply: BigInt(vector.initialSupply),
      assetSecretCommitment: BigInt(vector.assetSecretCommitment),
    })).toBe(BigInt(vector.assetId));
    expect(assetCreationMarker(BigInt(vector.assetId), BigInt(vector.assetSecret))).toBe(
      BigInt(vector.marker),
    );
  });

  it("derives output note secrets from the complete transaction nullifier set", () => {
    const vector = V.outputNoteSecret;
    const seed = noteSecretSeed(BigInt(vector.noteNk));
    expect(seed).toBe(BigInt(vector.noteSecretSeed.value));
    expect(vector.noteSecretSeed.operands).toEqual([vector.noteNk]);
    expect(noteSecret(
      BigInt(vector.operands.noteSecretSeed),
      fields(vector.operands.nullifiers),
      BigInt(vector.operands.outputIndex),
      BigInt(vector.operands.outputEntropy),
    )).toBe(BigInt(vector.noteSecret));
  });

  it("derives note, account, and contract commitments", () => {
    expect(outputCommitment(
      BigInt(V.outputCommitment.outputBody),
      BigInt(V.outputCommitment.outputIndex),
    )).toBe(BigInt(V.outputCommitment.value));
    const vector = V.accountStateCommitment;
    const entry = accountRuleEntryCommitment(
      BigInt(vector.applicationVkHash),
      BigInt(vector.configurationCommitment),
      BigInt(vector.commitmentBlinder),
    );
    expect(entry).toBe(BigInt(vector.accountRuleEntryCommitment));
    const set = buildAccountRuleSet([{ entryIndex: 0, accountRuleEntryCommitment: entry }]);
    expect(set.accountRuleSetCommitment).toBe(BigInt(vector.accountRuleSetCommitment));
    expect(accountStateCommitment(
      BigInt(vector.address),
      BigInt(vector.nullifierKeyCommitment),
      set.accountRuleSetCommitment,
      0n,
      BigInt(vector.accountRevision),
      BigInt(vector.receiveKeyHash),
    )).toBe(BigInt(vector.userPresent));
    expect(accountStateCommitment(
      BigInt(vector.address),
      BigInt(vector.nullifierKeyCommitment),
      set.accountRuleSetCommitment,
      0n,
      BigInt(vector.accountRevision),
      0n,
    )).toBe(BigInt(vector.userAbsent));
    expect(accountStateCommitment(
      BigInt(V.contractAddress.address),
      BigInt(vector.nullifierKeyCommitment),
      BigInt(V.contractAddress.functionSetCommitment),
      1n,
      BigInt(vector.contractRevision),
      0n,
    )).toBe(BigInt(vector.contractAbsent));
    expect(contractAddress(
      BigInt(vector.nullifierKeyCommitment),
      BigInt(V.contractAddress.functionSetCommitment),
      BigInt(V.contractAddress.receiveKeyHash),
      V.contractAddress.publishesNkRoot,
    )).toBe(BigInt(V.contractAddress.address));
  });

  // Reconstructs the canonical type-0x03 body rather than consuming the
  // vector's own derived values. Feeding a published root back into
  // contractAddress cannot catch a vector built from the wrong root — which is
  // exactly how a user rule-set root with a nonzero blinder once reached the
  // contract-address vector.
  it("builds a canonical contract body whose derived identity equals the vector", () => {
    const V_C = V.contractAddress;
    const build = buildContractBody({
      nullifierKey: { publishesNkRoot: true, nkRoot: BigInt(V_C.nkRoot) },
      functions: [{
        selector: functionSelector(0),
        applicationVkHash: BigInt(V_C.applicationVkHash),
        configurationCommitment: BigInt(V_C.configurationCommitment),
      }],
    });
    expect(build.nullifierKeyCommitment).toBe(BigInt(V.accountStateCommitment.nullifierKeyCommitment));
    expect(build.functionSetCommitment).toBe(BigInt(V_C.functionSetCommitment));
    expect(build.address).toBe(BigInt(V_C.address));
    expect(build.accountStateCommitment).toBe(BigInt(V.accountStateCommitment.contractAbsent));

    // The published function commitment is the shared account-rule entry with
    // the canonical blinder 0.
    expect(contractFunctionCommitment({
      applicationVkHash: BigInt(V_C.applicationVkHash),
      configurationCommitment: BigInt(V_C.configurationCommitment),
    })).toBe(BigInt(V_C.functionCommitment));

    // The contract root is deliberately not the user rule-set root: the
    // user entry carries a nonzero blinder.
    expect(BigInt(V_C.functionSetCommitment)).not.toBe(BigInt(V.accountStateCommitment.accountRuleSetCommitment));

    // Decoding the canonical body reproduces the same derived identity.
    const decoded = decodeContractBody(build.body);
    const verified = verifyContract(decoded);
    expect(verified.functionSetCommitment).toBe(BigInt(V_C.functionSetCommitment));
    expect(verified.nullifierKeyCommitment).toBe(BigInt(V.accountStateCommitment.nullifierKeyCommitment));
    expect(verified.address).toBe(BigInt(V_C.address));
  });

  it("derives the receive-key digest from the exact key bytes", () => {
    const vector = V.accountStateCommitment;
    expect(receiveKeyHash(bytes(vector.receiveKey))).toBe(BigInt(vector.receiveKeyHash));
  });

  it("derives the published network-neutral account update commitment", () => {
    const vector = V.accountUpdateCommitment;
    const operands = vector.operands;
    const currentAccountStateCommitment = accountStateCommitment(
      BigInt(operands.address),
      BigInt(operands.nullifierKeyCommitment),
      BigInt(operands.currentRuleSetCommitment),
      BigInt(operands.currentAccountKind),
      BigInt(operands.currentAccountRevision),
      BigInt(operands.currentReceiveKeyHash),
    );
    const newAccountStateCommitment = accountStateCommitment(
      BigInt(operands.address),
      BigInt(operands.nullifierKeyCommitment),
      BigInt(operands.newRuleSetCommitment),
      BigInt(operands.newAccountKind),
      BigInt(operands.newAccountRevision),
      BigInt(operands.newReceiveKeyHash),
    );
    expect(currentAccountStateCommitment).toBe(BigInt(vector.derived.currentAccountStateCommitment));
    expect(newAccountStateCommitment).toBe(BigInt(vector.derived.newAccountStateCommitment));
    expect(accountUpdateCommitment({
      currentAccountStateCommitment,
      newAccountStateCommitment,
    })).toBe(BigInt(vector.value));
  });

  it("derives ordinary and dummy nullifiers", () => {
    const vector = V.nullifiers;
    const nk = noteNk(BigInt(vector.nkRoot));
    expect(nk).toBe(BigInt(vector.noteNk));
    expect(nullifier(BigInt(vector.inputCommitment), nk, BigInt(vector.noteSecret))).toBe(
      BigInt(vector.real),
    );
    expect(dummyNullifier(
      BigInt(vector.dummyInputSeed),
      BigInt(vector.inputIndex),
    )).toBe(BigInt(vector.dummy));

  });

  it("hashes indexed nullifier leaves and verifies membership and absence proofs", () => {
    const vector = V.nullifierTree;
    expect(vector.depth).toBe(NULLIFIER_TREE_DEPTH);
    const sentinel = { value: 0n, nextValue: 0n, nextIndex: 0n };
    expect(nullifierLeafHash(sentinel)).toBe(BigInt(vector.sentinel.leaf));
    const emptySiblings = emptyLadder(NULLIFIER_TREE_DEPTH).slice(0, NULLIFIER_TREE_DEPTH);
    expect(rootFromIndex(BigInt(vector.sentinel.leaf), 0n, emptySiblings)).toBe(BigInt(vector.sentinel.root));
    expect(vector.leaves).toHaveLength(vector.count + 1);
    for (const leaf of vector.leaves) {
      expect(nullifierLeafHash(nullifierLeaf(leaf))).toBe(BigInt(leaf.hash));
    }
    for (const entry of vector.proofs) {
      const proof = nullifierProof(entry);
      expect(nullifierProofSpent(proof)).toBe(entry.spent);
      expect(nullifierProofRoot(proof)).toBe(BigInt(entry.root));
    }
    for (const entry of vector.forgedProofs) {
      const proof = nullifierProof(entry);
      const opens = () => nullifierProofSpent(proof) !== null && nullifierProofRoot(proof) === BigInt(vector.root);
      // A word at or above p is not a field element, so hashing the leaf refuses it.
      if (entry.name === "nonCanonicalNextValue") expect(opens, entry.name).toThrow();
      else expect(opens(), entry.name).toBe(false);
    }
    for (const entry of vector.lowLeafCases) {
      expect(isLowNullifierLeaf(nullifierLeaf(entry.leaf), BigInt(entry.nullifier))).toBe(entry.isLowLeaf);
    }
    expect(BigInt(V.stateCommitment.input.nullifierRoot)).toBe(BigInt(vector.root));
    expect(BigInt(V.stateCommitment.input.nullifierCount)).toBe(BigInt(vector.count));
  });

  it("binds genesis configuration and full Ethereum block hashes", () => {
    const source = V.genesisParentHash;
    expect(BigInt(source.pcashChainId)).toBe(chainId);
    expect(genesisParentHash({
      pcashChainId: BigInt(source.pcashChainId),
      l1ChainId: BigInt(source.l1ChainId),
      inboxAddress: BigInt(source.inboxAddress),
    })).toBe(BigInt(source.value));

    const l1Origin = V.l1OriginLeaf;
    const ethereumHash = bytes32(l1Origin.blockHash);
    expect(BigInt(l1Origin.blockHash)).toBeGreaterThanOrEqual(P);
    expect(l1OriginLeaf({
      blockNumber: BigInt(l1Origin.blockNumber),
      blockHash: ethereumHash,
      timestamp: BigInt(l1Origin.blockTimestamp),
      logsRoot: BigInt(l1Origin.l1LogsRoot),
      logCount: BigInt(l1Origin.l1LogCount),
    })).toBe(BigInt(l1Origin.leaf));
    expect(verifyL1OriginPath(
      {
        root: BigInt(l1Origin.root),
        leafIndex: 0n,
        siblings: fields(l1Origin.siblings),
      },
      {
        blockNumber: BigInt(l1Origin.blockNumber),
        blockHash: ethereumHash,
        timestamp: BigInt(l1Origin.blockTimestamp),
        logsRoot: BigInt(l1Origin.l1LogsRoot),
        logCount: BigInt(l1Origin.l1LogCount),
      },
    )).toBe(true);
  });

  it("hashes L1 log leaves at and beyond eight data chunks", () => {
    expect(V.l1Logs.map((log: { data: string }) => bytes(log.data).length)).toEqual([128, 200]);
    for (const log of V.l1Logs) {
      expect(log.inputs).toHaveLength(log.inputCount);
      expect(poseidon(fields(log.inputs))).toBe(BigInt(log.leaf));
      expect(normalizedL1LogLeaf({
        transactionIndex: log.transactionIndex,
        logIndex: log.logIndex,
        emitter: BigInt(log.emitter),
        topics: log.topics.map(bytes32),
        data: bytes(log.data),
      })).toBe(BigInt(log.leaf));
    }
  });

  it("commits the typed depth-4 state and verifies every assigned opening", () => {
    const vector = V.stateCommitment;
    expect(vector.depth).toBe(STATE_TREE_DEPTH);
    const input = vector.input;
    const state = {
      outputRoot: BigInt(input.outputRoot),
      outputCount: BigInt(input.outputCount),
      issuedSoFar: BigInt(input.issuedSoFar),
      lagQ: BigInt(input.lagQ),
      accountStateRoot: BigInt(input.accountStateRoot),
      accountCount: BigInt(input.accountCount),
      nullifierRoot: BigInt(input.nullifierRoot),
      nullifierCount: BigInt(input.nullifierCount),
    };
    expect(stateTree(state).root).toBe(BigInt(vector.root));
    expect(computeStateRoot(state)).toBe(BigInt(vector.root));
    for (const opening of vector.openings) {
      const proof = openStateKey(state, opening.key);
      expect(proof.siblings).toEqual(fields(opening.siblings));
      expect(verifyStatePath(
        BigInt(vector.root),
        opening.key,
        BigInt(opening.value),
        fields(opening.siblings),
      )).toBe(true);
    }
  });

  it("preserves assigned state openings when an unassigned fact becomes nonzero", () => {
    const input = V.stateCommitment.input;
    const state = {
      outputRoot: BigInt(input.outputRoot),
      outputCount: BigInt(input.outputCount),
      issuedSoFar: BigInt(input.issuedSoFar),
      lagQ: BigInt(input.lagQ),
      accountStateRoot: BigInt(input.accountStateRoot),
      accountCount: BigInt(input.accountCount),
      nullifierRoot: BigInt(input.nullifierRoot),
      nullifierCount: BigInt(input.nullifierCount),
    };
    const tree = stateTree(state);
    tree.setLeaf(9, 0x1234n);
    const root = tree.root;
    const opening = tree.proof(0);
    expect(verifyStatePath(root, 0, BigInt(input.outputRoot), opening.siblings)).toBe(true);
  });

  it("domain-separates every internal state and header node", () => {
    const state = new TypedCommitmentTree(STATE_COMMITMENT_DOMAIN);
    const header = new TypedCommitmentTree(BLOCK_HEADER_DOMAIN);
    for (let key = 0; key < 8; key++) {
      state.setLeaf(key, BigInt(key + 1));
      header.setLeaf(key, BigInt(key + 1));
    }
    expect(state.root).not.toBe(header.root);
  });

  it("authenticates prior PCASH block hashes through the depth-40 history tree", () => {
    const vector = V.history;
    expect(vector.depth).toBe(HISTORY_TREE_DEPTH);
    expect(historyLeaf(BigInt(vector.blockHash))).toBe(BigInt(vector.leaf));
    expect(verifyHistoryPath(
      BigInt(vector.root),
      BigInt(vector.blockNumber),
      BigInt(vector.blockHash),
      fields(vector.siblings),
    )).toBe(true);
  });

  it("hashes the typed depth-4 block header and verifies every assigned opening", () => {
    const vector = V.blockHeader;
    expect(vector.depth).toBe(BLOCK_HEADER_TREE_DEPTH);
    expect(vector.stateRoot).toBe(V.stateCommitment.root);
    expect(vector.l1OriginRoot).toBe(V.l1OriginLeaf.root);
    expect(vector.historyRoot).toBe(V.history.root);
    const header = {
      parentHash: BigInt(vector.parentHash),
      number: BigInt(vector.number),
      timestamp: BigInt(vector.timestamp),
      transactionResultsRoot: BigInt(vector.transactionResultsRoot),
      stateRoot: BigInt(vector.stateRoot),
      l1OriginRoot: BigInt(vector.l1OriginRoot),
      historyRoot: BigInt(vector.historyRoot),
    };
    expect(blockHeaderTree(header).root).toBe(BigInt(vector.hash));
    expect(computeBlockHash(header)).toBe(BigInt(vector.hash));
    for (const opening of vector.openings) {
      const proof = openBlockHeaderKey(header, opening.key);
      expect(proof.siblings).toEqual(fields(opening.siblings));
      expect(verifyBlockHeaderPath(
        BigInt(vector.hash),
        opening.key,
        BigInt(opening.value),
        fields(opening.siblings),
      )).toBe(true);
    }
  });

  it("preserves assigned header openings when an unassigned fact becomes nonzero", () => {
    const vector = V.blockHeader;
    const header = {
      parentHash: BigInt(vector.parentHash),
      number: BigInt(vector.number),
      timestamp: BigInt(vector.timestamp),
      transactionResultsRoot: BigInt(vector.transactionResultsRoot),
      stateRoot: BigInt(vector.stateRoot),
      l1OriginRoot: BigInt(vector.l1OriginRoot),
      historyRoot: BigInt(vector.historyRoot),
    };
    const tree = blockHeaderTree(header);
    tree.setLeaf(9, 0x5678n);
    const hash = tree.root;
    const opening = tree.proof(BLOCK_HEADER_KEY_STATE_ROOT);
    expect(verifyBlockHeaderPath(hash, BLOCK_HEADER_KEY_STATE_ROOT, BigInt(vector.stateRoot), opening.siblings)).toBe(true);
  });

  it("commits transaction statements and payouts in the published results tree", () => {
    const vector = V.transactionResults;
    expect(vector.transactions.map((result: { statement: string[] | null }) => result.statement?.length ?? null))
      .toEqual([19, 74, 20, 19, 4, 4, null]);
    const results = vector.transactions.map((result: Record<string, unknown>) => {
      const outcome = transactionOutcomeFromCode(result.outcomeCode as number);
      if (!outcome.supported) throw new Error("vector outcome is unsupported");
      const statement = result.statement as string[] | null;
      if (statement !== null) {
        expect(transactionStatementHash(statement.map(BigInt))).toBe(BigInt(result.statementHash as string));
      }
      return {
        txType: result.txType as number,
        accountCreation: result.accountCreation as number,
        l1TransactionIndex: BigInt(result.l1TransactionIndex as number),
        batchItemIndex: BigInt(result.batchItemIndex as number),
        outcome: outcome.outcome,
        posterOwnerCommitment: BigInt(result.posterOwnerCommitment as string),
        outputStartIndex: BigInt(result.outputStartIndex as number),
        statementHash: BigInt(result.statementHash as string),
      };
    });
    results.forEach((result: Parameters<typeof transactionResultLeaf>[0], index: number) => {
      expect(transactionResultLeaf(result)).toBe(BigInt(vector.transactions[index].leaf));
    });
    const payouts = vector.payouts.map((payout: Record<string, string | number>) => ({
      outputIndex: BigInt(payout.outputIndex!),
      ownerCommitment: BigInt(payout.ownerCommitment!),
      openFeeAmount: BigInt(payout.openFeeAmount!),
      issuanceAmount: BigInt(payout.issuanceAmount!),
    }));
    payouts.forEach((payout: Parameters<typeof payoutResultLeaf>[0], index: number) => {
      expect(payoutResultLeaf(payout)).toBe(BigInt(vector.payouts[index].leaf));
    });
    expect(transactionResultsRoot(results, payouts)).toBe(BigInt(vector.root));
    expect(transactionResultsRoot([], [])).toBe(BigInt(vector.emptyRoot));
  });

  it("pins the complete outcome map and inclusion transaction ID", () => {
    expect(TRANSACTION_OUTCOME_CODE).toEqual({
      succeeded: 0,
      publicInputNotInField: 1,
      recentPcashBlockNotInWindow: 2,
      expired: 3,
      notYetValid: 4,
      zeroNullifier: 5,
      duplicateInputNullifier: 6,
      nullifierAlreadySpent: 7,
      proofRejected: 8,
      outputCapacity: 9,
      accountCapacity: 10,
      invalidAccountSignature: 11,
      accountNotFound: 12,
      accountAlreadyExists: 13,
      accountRevisionExhausted: 14,
      wrongAccountKind: 15,
      clearWithoutReceiveKey: 16,
      replaceWithIdenticalReceiveKey: 17,
      accountUpdateCommitmentMismatch: 18,
      nonCanonicalAccountField: 19,
      contractAddressExists: 20,
      nonCanonicalContractField: 21,
      emptyContractFunctionSet: 22,
      selectorsNotStrictlyIncreasing: 23,
      carrierContextMismatch: 24, accountCreationMismatch: 25,
    });
    expect(transactionOutcomeFromCode(18)).toEqual({
      supported: true,
      outcome: "accountUpdateCommitmentMismatch",
    });
    expect(transactionOutcomeFromCode(23)).toEqual({ supported: true, outcome: "selectorsNotStrictlyIncreasing" });
    expect(transactionOutcomeFromCode(24)).toEqual({ supported: true, outcome: "carrierContextMismatch" });
    expect(transactionOutcomeFromCode(26)).toEqual({ supported: false, code: 26 });
    const hash = contentHash(Uint8Array.from([0, 0x50, 0x43, 0x53, 0x48, 1, 2, 3]));
    expect(hash).toEqual(
      bytes32("0x59895f0b9c2ceb30539f7bf48ec8d12f32653d75f73191aad2ee19609d6f8078"),
    );
    expect(transactionId({
      l1BlockHash: bytes32(V.transactionId.l1BlockHash),
      l1TransactionIndex: BigInt(V.transactionId.l1TransactionIndex),
      batchItemIndex: BigInt(V.transactionId.batchItemIndex),
    })).toEqual(bytes32(V.transactionId.value));
  });
});
