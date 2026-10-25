import { describe, expect, it } from "vitest";
import { verifyResultProof, verifySuccessfulTransactionStatement, type AccountUpdateOpeningRpc, type ResultProofRpc } from "../src/clients/resultProof.ts";
import { DenseMerkleTree } from "../src/crypto/denseMerkleTree.ts";
import { emptyRoot } from "../src/crypto/merkle.ts";
import { fieldToHex } from "../src/crypto/field.ts";
import { historyLeaf, blockHash, blockHeaderTree, stateRoot, transactionResultsRoot, transactionResultLeaf, payoutResultLeaf, transactionStatementHash } from "../src/protocol/block.ts";
import { noteBodyCommitment, outputCommitment } from "../src/protocol/notes.ts";
import { accountStateCommitment, accountUpdateCommitment, receiveKeyHash } from "../src/protocol/account.ts";
import { decodeTransaction, encodeUserAccountUpdate, RECEIVE_KEY_OPERATION_CLEAR, WIRE_PROOF_BYTES, userAccountUpdatePublicInputs, type UserAccountReceiveKeyUpdate } from "../src/protocol/codec.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { ACCOUNT_KIND_USER, ML_KEM_768_PUBLIC_KEY_LENGTH, OUTPUT_DATA_BYTES } from "../src/constants/params.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { privateValueProfileFixture } from "./privateValueProfileFixtures.ts";
const hex = (n: bigint) => `0x${n.toString(16)}`;

function fixture() {
  const payout = { outputIndex: 0n, ownerCommitment: 9n, openFeeAmount: 3n, issuanceAmount: 0n };
  const result = { txType: 0, fundingMode: 0, l1TransactionIndex: 2n, batchItemIndex: 0n, outcome: "proofRejected" as const, posterOwnerCommitment: 9n, outputStartIndex: 0n, statementHash: 0n };
  const results = new DenseMerkleTree(64, [transactionResultLeaf(result), payoutResultLeaf(payout)]);
  const outputs = new DenseMerkleTree(40, [outputCommitment(noteBodyCommitment(9n, 0n, 3n), 0n)]);
  const state = { outputRoot: outputs.root(), outputCount: 1n, issuedSoFar: 0n, lagQ: 0n, accountStateRoot: emptyRoot(40), accountCount: 0n, nullifierRoot: emptyRoot(40), nullifierCount: 0n };
  const header = { parentHash: 0n, number: 0n, timestamp: 1n, transactionResultsRoot: transactionResultsRoot([result], [payout]), stateRoot: stateRoot(state), l1OriginRoot: emptyRoot(40), historyRoot: emptyRoot(40) };
  const hash = blockHash(header);
  const boundary = { state: { ...Object.fromEntries(Object.entries(state).map(([k,v]) => [k, k === "lagQ" ? v.toString() : hex(v)])) }, header: Object.fromEntries(Object.entries(header).map(([k,v]) => [k, ["number","timestamp"].includes(k) ? hex(v) : fieldToHex(v)])), blockHash: fieldToHex(hash) } as unknown as ResultProofRpc["recentBoundary"];
  // Boundary field roots use fixed-width field words.
  for (const key of ["outputRoot", "accountStateRoot", "nullifierRoot"] as const) boundary.state[key] = fieldToHex(state[key]);
  const proof: ResultProofRpc = { recentPcashBlockHash: fieldToHex(hash), block: { recentPcashBlockHash: fieldToHex(hash), boundary }, history: null, resultsRootSiblings: blockHeaderTree(header).proof(3).siblings.map(fieldToHex), transactionCount: "0x1", payoutCount: "0x1", resultsTreeRoot: fieldToHex(results.root()), leafIndex: "0x0", siblings: results.path(0).map(fieldToHex), recentBoundary: boundary, leaf: { kind: "transaction", txType: 0, fundingMode: 0, l1TransactionIndex: "0x2", batchItemIndex: "0x0", outcome: 8, posterOwnerCommitment: fieldToHex(9n), outputStartIndex: "0x0", statementHash: fieldToHex(0n), statement: null } };
  return { proof, hash, results, outputs };
}

function successfulFixture(
  words: readonly bigint[],
  txType: number,
  fundingMode: number,
  accountUpdateOpening: AccountUpdateOpeningRpc | null = null,
) {
  const { proof } = fixture();
  const statementHash = transactionStatementHash(words);
  const result = { txType, fundingMode, l1TransactionIndex: 2n, batchItemIndex: 0n, outcome: "succeeded" as const, posterOwnerCommitment: 9n, outputStartIndex: 0n, statementHash };
  const results = new DenseMerkleTree(64, [transactionResultLeaf(result)]);
  const header = { parentHash: 0n, number: 0n, timestamp: 1n, transactionResultsRoot: transactionResultsRoot([result], []), stateRoot: BigInt(proof.recentBoundary.header.stateRoot), l1OriginRoot: emptyRoot(40), historyRoot: emptyRoot(40) };
  const hash = blockHash(header);
  proof.leaf = { kind: "transaction", txType, fundingMode, l1TransactionIndex: "0x2", batchItemIndex: "0x0", outcome: 0, posterOwnerCommitment: fieldToHex(9n), outputStartIndex: "0x0", statementHash: fieldToHex(statementHash), statement: { words: words.map(fieldToHex), accountUpdateOpening } };
  proof.recentBoundary.header.transactionResultsRoot = fieldToHex(header.transactionResultsRoot);
  proof.recentBoundary.blockHash = fieldToHex(hash);
  proof.block.recentPcashBlockHash = fieldToHex(hash);
  proof.recentPcashBlockHash = fieldToHex(hash);
  proof.payoutCount = "0x0";
  proof.resultsTreeRoot = fieldToHex(results.root());
  proof.siblings = results.path(0).map(fieldToHex);
  proof.resultsRootSiblings = blockHeaderTree(header).proof(3).siblings.map(fieldToHex);
  return { proof, trusted: { recentHash: hash, blockNumber: 0n, pcashTransactionIndex: 0n } };
}

describe("authenticated results", () => {
  it("opens a failed transaction and rejects changed counts, position, leaf, and path", () => {
    const { proof, hash } = fixture();
    expect(() => verifyResultProof(proof, hash, 0n, { pcashTransactionIndex: 0n })).not.toThrow();
    for (const mutate of [
      (p: ResultProofRpc) => { p.transactionCount = "0x2"; },
      (p: ResultProofRpc) => { p.leafIndex = "0x1"; },
      (p: ResultProofRpc) => { p.siblings[0] = fieldToHex(0n); },
      (p: ResultProofRpc) => { if (p.leaf.kind === "transaction") p.leaf.outcome = 0; },
    ]) {
      const changed = structuredClone(proof); mutate(changed);
      expect(() => verifyResultProof(changed, hash, 0n, { pcashTransactionIndex: 0n })).toThrow();
    }
  });
  it("authenticates a payout against the output tree and rejects an altered output path", () => {
    const { proof, hash, results, outputs } = fixture();
    proof.leafIndex = "0x1"; proof.siblings = results.path(1).map(fieldToHex);
    proof.leaf = { kind: "payout", outputIndex: "0x0", ownerCommitment: fieldToHex(9n), openFeeAmount: "0x3", issuanceAmount: "0x0", outputSiblings: outputs.path(0).map(fieldToHex) };
    expect(() => verifyResultProof(proof, hash, 0n, { payoutIndex: 0n })).not.toThrow();
    proof.leaf.outputSiblings[0] = fieldToHex(1n);
    expect(() => verifyResultProof(proof, hash, 0n, { payoutIndex: 0n })).toThrow(/payout output/);
  });
});

for (const shape of [0, 1] as const) {
  it(`authenticates profile ${shape} semantics, rejects altered inputs, and ignores proof bytes`, () => {
    const { build } = privateValueProfileFixture({ shape, scenario: "minimal" });
    const { proof, trusted } = successfulFixture(build.publicInputs, 0, 0);
    const bytes = build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES));
    expect(verifySuccessfulTransactionStatement(proof, bytes, DEFAULT_NETWORK_CONFIG, trusted)).toMatchObject({ kind: "privateValue", shape });
    const forged = structuredClone(proof); forged.siblings[0] = fieldToHex(1n);
    expect(() => verifySuccessfulTransactionStatement(forged, bytes, DEFAULT_NETWORK_CONFIG, trusted)).toThrow(/result path/);
    const changed = bytes.slice(); changed[37] = changed[37]! ^ 1;
    expect(() => verifySuccessfulTransactionStatement(proof, changed, DEFAULT_NETWORK_CONFIG, trusted)).toThrow();
    const changedArena = bytes.slice(); changedArena[bytes.length - 1] = changedArena[bytes.length - 1]! ^ 1;
    expect(() => verifySuccessfulTransactionStatement(proof, changedArena, DEFAULT_NETWORK_CONFIG, trusted)).toThrow(/statement mismatch/);
    const changedProof = bytes.slice();
    const proofOffset = changedProof.length - WIRE_PROOF_BYTES - build.outputData.length * OUTPUT_DATA_BYTES - build.arena.length;
    changedProof[proofOffset] = changedProof[proofOffset]! ^ 1;
    expect(verifySuccessfulTransactionStatement(proof, changedProof, DEFAULT_NETWORK_CONFIG, trusted)).toMatchObject({ kind: "privateValue", shape });
  });
}

it("rejects failed results and oversized successful statements before hashing", () => {
  const { build } = privateValueProfileFixture({ shape: 0, scenario: "minimal" });
  const bytes = build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES));
  const failed = fixture();
  expect(() => verifySuccessfulTransactionStatement(failed.proof, bytes, DEFAULT_NETWORK_CONFIG, { recentHash: failed.hash, blockNumber: 0n, pcashTransactionIndex: 0n })).toThrow(/did not succeed/);
  const oversized = successfulFixture(build.publicInputs, 0, 0);
  if (oversized.proof.leaf.kind !== "transaction" || oversized.proof.leaf.statement === null) throw new Error("successful statement fixture");
  oversized.proof.leaf.statement.words.push(...Array<string>(10_000).fill(fieldToHex(0n)));
  expect(() => verifyResultProof(oversized.proof, oversized.trusted.recentHash, 0n, { pcashTransactionIndex: 0n })).toThrow(/statement arity/);
});

function accountUpdateFixture(options: { currentReceiveKeyHash?: bigint; receiveKey?: UserAccountReceiveKeyUpdate } = {}) {
  const address = 0x1234n;
  const nullifierKeyCommitment = 11n;
  const currentRuleSetCommitment = 12n;
  const newRuleSetCommitment = 13n;
  const revision = 7n;
  const currentReceiveKeyHash = options.currentReceiveKeyHash ?? 14n;
  const receiveKey = options.receiveKey ?? { operation: "keep" as const };
  const newReceiveKeyHash = receiveKey.operation === "keep"
    ? currentReceiveKeyHash
    : receiveKey.operation === "clear"
      ? 0n
      : receiveKeyHash(receiveKey.mlKemPublicKey);
  const currentCommitment = accountStateCommitment(address, nullifierKeyCommitment, currentRuleSetCommitment, ACCOUNT_KIND_USER, revision, currentReceiveKeyHash);
  const newCommitment = accountStateCommitment(address, nullifierKeyCommitment, newRuleSetCommitment, ACCOUNT_KIND_USER, revision + 1n, newReceiveKeyHash);
  const updateCommitment = accountUpdateCommitment({ currentAccountStateCommitment: currentCommitment, newAccountStateCommitment: newCommitment });
  const sectionInputs = Array<bigint>(PRIVATE_VALUE_PROFILES.S.publicInputs).fill(0n);
  sectionInputs[0] = DEFAULT_NETWORK_CONFIG.pcashChainId;
  const bytes = encodeUserAccountUpdate({
    pcashChainId: DEFAULT_NETWORK_CONFIG.pcashChainId,
    proposedAccountFields: { address, newRuleSetCommitment, receiveKey },
    accountUpdateCommitment: updateCommitment,
    section: {
      publicInputs: sectionInputs,
      proof: new Uint8Array(WIRE_PROOF_BYTES),
      outputData: Array.from({ length: 5 }, () => new Uint8Array(OUTPUT_DATA_BYTES)),
      arena: new Uint8Array(PRIVATE_VALUE_PROFILES.S.arenaBytes),
    },
  });
  const decoded = decodeTransaction(bytes);
  if (decoded.kind !== 3) throw new Error("account update fixture");
  const opening: AccountUpdateOpeningRpc = {
    currentAccountState: {
      nullifierKeyCommitment: fieldToHex(nullifierKeyCommitment),
      ruleSetCommitment: fieldToHex(currentRuleSetCommitment),
      revision: hex(revision),
      receiveKeyHash: fieldToHex(currentReceiveKeyHash),
    },
  };
  return { ...successfulFixture(userAccountUpdatePublicInputs(decoded), 3, 0, opening), bytes, address, nullifierKeyCommitment, currentRuleSetCommitment, newRuleSetCommitment, revision, currentReceiveKeyHash };
}

function updateOpening(proof: ResultProofRpc): AccountUpdateOpeningRpc {
  if (proof.leaf.kind !== "transaction" || proof.leaf.statement?.accountUpdateOpening === null || proof.leaf.statement?.accountUpdateOpening === undefined) throw new Error("account update opening fixture");
  return proof.leaf.statement.accountUpdateOpening;
}

it("authenticates a successful account update and rejects substituted proposal fields", () => {
  const { proof, trusted, bytes, address, currentRuleSetCommitment, newRuleSetCommitment, revision, currentReceiveKeyHash } = accountUpdateFixture();
  expect(verifySuccessfulTransactionStatement(proof, bytes, DEFAULT_NETWORK_CONFIG, trusted)).toMatchObject({
    kind: "userAccountUpdate",
    receiveKeyOperation: "keep",
    currentAccount: { address, ruleSetCommitment: currentRuleSetCommitment, revision, receiveKeyHash: currentReceiveKeyHash },
    newAccount: { address, ruleSetCommitment: newRuleSetCommitment, revision: revision + 1n, receiveKeyHash: currentReceiveKeyHash },
  });
  for (const mutate of [
    (changed: Uint8Array) => { changed[5] = changed[5]! ^ 1; },
    (changed: Uint8Array) => { changed[25] = changed[25]! ^ 1; },
    (changed: Uint8Array) => { changed[57] = RECEIVE_KEY_OPERATION_CLEAR; },
  ]) {
    const changed = bytes.slice();
    mutate(changed);
    expect(() => verifySuccessfulTransactionStatement(proof, changed, DEFAULT_NETWORK_CONFIG, trusted)).toThrow(/account update opening/);
  }
});

it("rejects a substituted replacement key and every changed current-account opening field", () => {
  const replacementKey = new Uint8Array(ML_KEM_768_PUBLIC_KEY_LENGTH).fill(7);
  const { proof, trusted, bytes } = accountUpdateFixture({ receiveKey: { operation: "replace", mlKemPublicKey: replacementKey } });
  expect(verifySuccessfulTransactionStatement(proof, bytes, DEFAULT_NETWORK_CONFIG, trusted)).toMatchObject({ kind: "userAccountUpdate", receiveKeyOperation: "replace" });
  const changedKey = bytes.slice();
  changedKey[58] = changedKey[58]! ^ 1;
  expect(() => verifySuccessfulTransactionStatement(proof, changedKey, DEFAULT_NETWORK_CONFIG, trusted)).toThrow(/account update opening/);

  for (const mutate of [
    (opening: AccountUpdateOpeningRpc) => { opening.currentAccountState.nullifierKeyCommitment = fieldToHex(21n); },
    (opening: AccountUpdateOpeningRpc) => { opening.currentAccountState.ruleSetCommitment = fieldToHex(22n); },
    (opening: AccountUpdateOpeningRpc) => { opening.currentAccountState.revision = "0x8"; },
    (opening: AccountUpdateOpeningRpc) => { opening.currentAccountState.receiveKeyHash = fieldToHex(23n); },
  ]) {
    const changed = structuredClone(proof);
    mutate(updateOpening(changed));
    expect(() => verifySuccessfulTransactionStatement(changed, bytes, DEFAULT_NETWORK_CONFIG, trusted)).toThrow(/account update opening/);
  }
});

it("enforces canonical CLEAR and REPLACE operation preconditions", () => {
  const clear = accountUpdateFixture({ currentReceiveKeyHash: 0n, receiveKey: { operation: "clear" } });
  expect(() => verifySuccessfulTransactionStatement(clear.proof, clear.bytes, DEFAULT_NETWORK_CONFIG, clear.trusted)).toThrow(/clear without/);

  const replacementKey = new Uint8Array(ML_KEM_768_PUBLIC_KEY_LENGTH).fill(9);
  const replace = accountUpdateFixture({ currentReceiveKeyHash: receiveKeyHash(replacementKey), receiveKey: { operation: "replace", mlKemPublicKey: replacementKey } });
  expect(() => verifySuccessfulTransactionStatement(replace.proof, replace.bytes, DEFAULT_NETWORK_CONFIG, replace.trusted)).toThrow(/unchanged/);
});

it("binds an older result block through history and rejects a different trusted recent header", () => {
  const { proof, hash } = fixture();
  const history = new DenseMerkleTree(40, [historyLeaf(hash)]);
  const header = { parentHash: hash, number: 1n, timestamp: 2n, transactionResultsRoot: BigInt(proof.block.boundary.header.transactionResultsRoot), stateRoot: BigInt(proof.block.boundary.header.stateRoot), l1OriginRoot: BigInt(proof.block.boundary.header.l1OriginRoot), historyRoot: history.root() };
  const recentHash = blockHash(header);
  proof.recentBoundary = { ...structuredClone(proof.block.boundary), header: { parentHash: fieldToHex(hash), number: "0x1", timestamp: "0x2", transactionResultsRoot: fieldToHex(header.transactionResultsRoot), stateRoot: fieldToHex(header.stateRoot), l1OriginRoot: fieldToHex(header.l1OriginRoot), historyRoot: fieldToHex(header.historyRoot) }, blockHash: fieldToHex(recentHash) };
  proof.recentPcashBlockHash = fieldToHex(recentHash);
  proof.history = { recentPcashBlockHash: fieldToHex(recentHash), historicalBlockNumber: "0x0", historicalBlockHash: fieldToHex(hash), historyRoot: fieldToHex(history.root()), historyRootSiblings: blockHeaderTree(header).proof(6).siblings.map(fieldToHex), historySiblings: history.path(0).map(fieldToHex) };
  expect(() => verifyResultProof(proof, recentHash, 0n, { pcashTransactionIndex: 0n })).not.toThrow();
  expect(() => verifyResultProof(proof, hash, 0n, { pcashTransactionIndex: 0n })).toThrow(/recent block/);
  proof.history.historySiblings[0] = fieldToHex(55n);
  expect(() => verifyResultProof(proof, recentHash, 0n, { pcashTransactionIndex: 0n })).toThrow(/history path/);
});
