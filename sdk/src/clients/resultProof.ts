import { toField } from "../crypto/field.ts";
import { poseidon } from "../crypto/poseidon2.ts";
import { rootFromIndex } from "../crypto/merkle.ts";
import { TRANSACTION_RESULTS_ROOT_DOMAIN } from "../constants/domainTags.ts";
import { parseCurrentBoundaryEnvelope, type CurrentBoundaryEnvelopeRpc } from "../protocol/boundary.ts";
import { transactionOutcomeFromCode, payoutResultLeaf, transactionResultLeaf, transactionStatementHash, verifyBlockHeaderPath, verifyHistoryPath } from "../protocol/block.ts";
import { CONTRACT_CREATION_PUBLIC_INPUTS, decodeTransactionForChain, privateValuePublicInputs, USER_ACCOUNT_UPDATE_PUBLIC_INPUTS, userAccountUpdatePublicInputs, contractCreationPublicInputs } from "../protocol/codec.ts";
import { PRIVATE_VALUE_PROFILES } from "../constants/privateValueProfiles.ts";
import { decodeContractBody, verifyContract } from "../protocol/contract.ts";
import { noteBodyCommitment, outputCommitment } from "../protocol/notes.ts";
import { accountStateCommitment, accountUpdateCommitment, receiveKeyHash } from "../protocol/account.ts";
import { accountCreationTypedData, pcashSigningHash, recoverAddress } from "../eip712/eip712.ts";
import { type NetworkConfigLike } from "../protocol/network.ts";
import { bytesToBigInt } from "../utils/bytes.ts";
import { ACCOUNT_KIND_USER } from "../constants/params.ts";

export type ResultPosition = { pcashTransactionIndex: bigint } | { payoutIndex: bigint };
/** Prior row supplied by the node; authenticate it with verifySuccessfulTransactionStatement. */
export interface AccountUpdateOpeningRpc {
  currentAccountState: {
    nullifierKeyCommitment: string;
    ruleSetCommitment: string;
    revision: string;
    receiveKeyHash: string;
  };
}
export interface TransactionStatementRpc {
  words: string[];
  accountUpdateOpening: AccountUpdateOpeningRpc | null;
}
export interface ResultProofRpc {
  recentPcashBlockHash: string;
  block: { recentPcashBlockHash: string; boundary: CurrentBoundaryEnvelopeRpc };
  history: null | { recentPcashBlockHash: string; historicalBlockNumber: string; historicalBlockHash: string; historyRoot: string; historyRootSiblings: string[]; historySiblings: string[] };
  resultsRootSiblings: string[];
  transactionCount: string;
  payoutCount: string;
  resultsTreeRoot: string;
  leafIndex: string;
  siblings: string[];
  recentBoundary: CurrentBoundaryEnvelopeRpc;
  leaf: { kind: "transaction"; txType: number; fundingMode: number; l1TransactionIndex: string; batchItemIndex: string; outcome: number; posterOwnerCommitment: string; outputStartIndex: string; statementHash: string; statement: TransactionStatementRpc | null }
    | { kind: "payout"; outputIndex: string; ownerCommitment: string; openFeeAmount: string; issuanceAmount: string; outputSiblings: string[] };
}
function requireProof(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`result proof: ${message}`);
}
function u64(value: string): bigint {
  requireProof(/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value), "invalid quantity");
  const n = BigInt(value);
  requireProof(n < 1n << 64n, "quantity exceeds u64");
  return n;
}

const PRIVATE_VALUE_STATEMENT_LENGTHS = Object.values(PRIVATE_VALUE_PROFILES).map((profile) => profile.publicInputs);

function statementLengths(txType: number, fundingMode: number): readonly number[] {
  requireProof(Number.isInteger(txType) && txType >= 0 && txType < 1 << 8, "invalid transaction type");
  requireProof(Number.isInteger(fundingMode) && fundingMode >= 0 && fundingMode < 1 << 8, "invalid funding mode");
  switch (txType) {
    case 0:
      requireProof(fundingMode === 0, "unsupported transaction funding mode");
      return PRIVATE_VALUE_STATEMENT_LENGTHS;
    case 1:
      requireProof(fundingMode === 0, "unsupported transaction funding mode");
      return [4];
    case 2:
      requireProof(fundingMode === 0 || fundingMode === 1, "unsupported transaction funding mode");
      return [fundingMode === 0 ? 4 : CONTRACT_CREATION_PUBLIC_INPUTS];
    case 3:
      requireProof(fundingMode === 0, "unsupported transaction funding mode");
      return [USER_ACCOUNT_UPDATE_PUBLIC_INPUTS];
    default:
      throw new Error("result proof: unsupported transaction type");
  }
}

export interface AuthenticatedAccountState {
  address: bigint;
  nullifierKeyCommitment: bigint;
  ruleSetCommitment: bigint;
  revision: bigint;
  receiveKeyHash: bigint;
}

export type AuthenticatedSuccessfulTransactionStatement =
  | { kind: "privateValue"; shape: 0 | 1; publicInputs: readonly bigint[] }
  | { kind: "userAccountCreation"; account: AuthenticatedAccountState; publicInputs: readonly bigint[] }
  | { kind: "contractAccountCreation"; fundingMode: "unfunded" | "sponsored"; account: AuthenticatedAccountState; publicInputs: readonly bigint[] }
  | { kind: "userAccountUpdate"; receiveKeyOperation: "keep" | "clear" | "replace"; currentAccount: AuthenticatedAccountState; newAccount: AuthenticatedAccountState; publicInputs: readonly bigint[] };

function parseAccountUpdateOpening(opening: AccountUpdateOpeningRpc): Omit<AuthenticatedAccountState, "address"> {
  requireProof(opening !== null && typeof opening === "object" && opening.currentAccountState !== null && typeof opening.currentAccountState === "object", "invalid account update opening");
  const current = opening.currentAccountState;
  requireProof(
    typeof current.nullifierKeyCommitment === "string"
      && typeof current.ruleSetCommitment === "string"
      && typeof current.revision === "string"
      && typeof current.receiveKeyHash === "string",
    "invalid account update opening",
  );
  const revision = u64(current.revision);
  requireProof(revision > 0n && revision + 1n < 1n << 32n, "invalid account update revision");
  const nullifierKeyCommitment = toField(current.nullifierKeyCommitment, "current nullifier key commitment");
  requireProof(nullifierKeyCommitment !== 0n, "invalid account update nullifier key commitment");
  return {
    nullifierKeyCommitment,
    ruleSetCommitment: toField(current.ruleSetCommitment, "current rule set commitment"),
    revision,
    receiveKeyHash: toField(current.receiveKeyHash, "current receive key hash"),
  };
}
/** Verify the result and any payout output against the caller's trusted recent header. */
export function verifyResultProof(proof: ResultProofRpc, recentHash: bigint, blockNumber: bigint, position: ResultPosition): void {
  const recent = parseCurrentBoundaryEnvelope(proof.recentBoundary);
  const block = parseCurrentBoundaryEnvelope(proof.block.boundary);
  requireProof(recent.blockHash === recentHash && toField(proof.recentPcashBlockHash) === recentHash, "recent block mismatch");
  requireProof(block.header.number === blockNumber && toField(proof.block.recentPcashBlockHash) === block.blockHash, "result block mismatch");
  if (block.blockHash === recentHash) requireProof(proof.history === null, "unexpected history opening");
  else {
    const h = proof.history;
    requireProof(h !== null && blockNumber < recent.header.number, "missing historical opening");
    requireProof(toField(h.recentPcashBlockHash) === recentHash && u64(h.historicalBlockNumber) === blockNumber && toField(h.historicalBlockHash) === block.blockHash, "history identity mismatch");
    requireProof(verifyBlockHeaderPath(recentHash, 6, h.historyRoot, h.historyRootSiblings) && verifyHistoryPath(h.historyRoot, blockNumber, block.blockHash, h.historySiblings), "invalid history path");
  }
  const t = u64(proof.transactionCount), p = u64(proof.payoutCount), index = u64(proof.leafIndex);
  const expected = "pcashTransactionIndex" in position ? position.pcashTransactionIndex : t + position.payoutIndex;
  requireProof(index === expected && expected >= 0n && ("pcashTransactionIndex" in position ? expected < t : position.payoutIndex >= 0n && position.payoutIndex < p), "result position mismatch");
  const leaf = proof.leaf;
  let commitment: bigint;
  if (leaf.kind === "transaction") {
    requireProof("pcashTransactionIndex" in position, "wrong result kind");
    const outcome = transactionOutcomeFromCode(leaf.outcome);
    requireProof(outcome.supported, "unknown outcome");
    const expectedStatementLengths = statementLengths(leaf.txType, leaf.fundingMode);
    commitment = transactionResultLeaf({ ...leaf, outcome: outcome.outcome, l1TransactionIndex: u64(leaf.l1TransactionIndex), batchItemIndex: u64(leaf.batchItemIndex), outputStartIndex: u64(leaf.outputStartIndex) });
    if (leaf.outcome === 0) {
      const statement = leaf.statement;
      requireProof(statement !== null && typeof statement === "object" && Array.isArray(statement.words), "missing successful statement");
      requireProof(expectedStatementLengths.includes(statement.words.length), "invalid statement arity");
      if (leaf.txType === 3) {
        requireProof(statement.accountUpdateOpening !== null, "missing account update opening");
        parseAccountUpdateOpening(statement.accountUpdateOpening);
      } else {
        requireProof(statement.accountUpdateOpening === null, "unexpected account update opening");
      }
      requireProof(transactionStatementHash(statement.words) === toField(leaf.statementHash), "statement hash mismatch");
    } else {
      requireProof(toField(leaf.statementHash) === 0n && leaf.statement === null, "failed result has a statement");
    }
  } else {
    requireProof(leaf.kind === "payout" && "payoutIndex" in position, "wrong result kind");
    commitment = payoutResultLeaf({ ...leaf, outputIndex: u64(leaf.outputIndex), openFeeAmount: BigInt(leaf.openFeeAmount), issuanceAmount: BigInt(leaf.issuanceAmount) });
    const outputIndex = u64(leaf.outputIndex);
    requireProof(outputIndex < recent.state.outputCount && leaf.outputSiblings.length === 40, "invalid payout output position");
    const output = outputCommitment(noteBodyCommitment(leaf.ownerCommitment, 0n, BigInt(leaf.openFeeAmount) + BigInt(leaf.issuanceAmount)), outputIndex);
    requireProof(rootFromIndex(output, outputIndex, leaf.outputSiblings) === recent.state.outputRoot, "payout output mismatch");
  }
  requireProof(proof.siblings.length === 64 && rootFromIndex(commitment, index, proof.siblings) === toField(proof.resultsTreeRoot), "invalid result path");
  const binding = poseidon([TRANSACTION_RESULTS_ROOT_DOMAIN, t, p, toField(proof.resultsTreeRoot)]);
  requireProof(verifyBlockHeaderPath(block.blockHash, 3, binding, proof.resultsRootSiblings), "invalid results binding");
}

function requireDecodedStatement(statement: TransactionStatementRpc, words: readonly bigint[]): void {
  requireProof(
    words.length === statement.words.length
      && words.every((word, index) => word === toField(statement.words[index]!, `statement[${index}]`)),
    "decoded transaction statement mismatch",
  );
}

/** Authenticate a successful result and its semantic statement, not serialized proof or signature bytes. */
export function verifySuccessfulTransactionStatement(
  proof: ResultProofRpc,
  bytes: Uint8Array,
  network: NetworkConfigLike,
  trusted: { recentHash: bigint; blockNumber: bigint; pcashTransactionIndex: bigint },
  directSender?: bigint,
): AuthenticatedSuccessfulTransactionStatement {
  verifyResultProof(proof, trusted.recentHash, trusted.blockNumber, { pcashTransactionIndex: trusted.pcashTransactionIndex });
  const leaf = proof.leaf;
  requireProof(leaf.kind === "transaction", "expected transaction result");
  requireProof(leaf.outcome === 0 && leaf.statement !== null, "transaction did not succeed");
  const tx = decodeTransactionForChain(bytes, network.pcashChainId);
  requireProof(tx.kind === leaf.txType && leaf.fundingMode === (tx.kind === 2 && tx.funding.mode === "sponsored" ? 1 : 0), "transaction type mismatch");
  switch (tx.kind) {
    case 0: {
      const words = privateValuePublicInputs(tx);
      requireDecodedStatement(leaf.statement, words);
      return { kind: "privateValue", shape: tx.shape, publicInputs: words };
    }
    case 3: {
      const opening = leaf.statement.accountUpdateOpening;
      requireProof(opening !== null, "missing account update opening");
      const address = bytesToBigInt(tx.address);
      const openedCurrent = parseAccountUpdateOpening(opening);
      const currentAccount: AuthenticatedAccountState = { address, ...openedCurrent };
      let newReceiveKeyHash: bigint;
      switch (tx.receiveKey.operation) {
        case "keep":
          newReceiveKeyHash = currentAccount.receiveKeyHash;
          break;
        case "clear":
          requireProof(currentAccount.receiveKeyHash !== 0n, "clear without a current receive key");
          newReceiveKeyHash = 0n;
          break;
        case "replace":
          newReceiveKeyHash = receiveKeyHash(tx.receiveKey.mlKemPublicKey);
          requireProof(newReceiveKeyHash !== currentAccount.receiveKeyHash, "replacement receive key is unchanged");
          break;
      }
      const newAccount: AuthenticatedAccountState = {
        address,
        nullifierKeyCommitment: currentAccount.nullifierKeyCommitment,
        ruleSetCommitment: toField(bytesToBigInt(tx.newRuleSetCommitment), "new rule set commitment"),
        revision: currentAccount.revision + 1n,
        receiveKeyHash: newReceiveKeyHash,
      };
      const currentCommitment = accountStateCommitment(
        currentAccount.address,
        currentAccount.nullifierKeyCommitment,
        currentAccount.ruleSetCommitment,
        ACCOUNT_KIND_USER,
        currentAccount.revision,
        currentAccount.receiveKeyHash,
      );
      const newCommitment = accountStateCommitment(
        newAccount.address,
        newAccount.nullifierKeyCommitment,
        newAccount.ruleSetCommitment,
        ACCOUNT_KIND_USER,
        newAccount.revision,
        newAccount.receiveKeyHash,
      );
      const expectedUpdateCommitment = accountUpdateCommitment({
        currentAccountStateCommitment: currentCommitment,
        newAccountStateCommitment: newCommitment,
      });
      requireProof(expectedUpdateCommitment === toField(bytesToBigInt(tx.accountUpdateCommitment), "account update commitment"), "account update opening mismatch");
      const words = userAccountUpdatePublicInputs(tx);
      requireDecodedStatement(leaf.statement, words);
      return {
        kind: "userAccountUpdate",
        receiveKeyOperation: tx.receiveKey.operation,
        currentAccount,
        newAccount,
        publicInputs: words,
      };
    }
    case 2: {
      const material = verifyContract(decodeContractBody(tx.body));
      const words = tx.funding.mode === "sponsored" ? contractCreationPublicInputs(tx, material.address) : [material.address, material.nullifierKeyCommitment, material.functionSetCommitment, material.receiveKeyHash];
      requireDecodedStatement(leaf.statement, words);
      return {
        kind: "contractAccountCreation",
        fundingMode: tx.funding.mode,
        account: {
          address: material.address,
          nullifierKeyCommitment: material.nullifierKeyCommitment,
          ruleSetCommitment: material.functionSetCommitment,
          revision: 1n,
          receiveKeyHash: material.receiveKeyHash,
        },
        publicInputs: words,
      };
    }
    case 1: {
      const nk = toField(bytesToBigInt(tx.nullifierKeyCommitment), "nullifier key commitment");
      const rules = toField(bytesToBigInt(tx.ruleSetCommitment), "rule set commitment");
      const receive = tx.mlKemPublicKey === null ? 0n : receiveKeyHash(tx.mlKemPublicKey);
      let address = directSender;
      if (tx.authorization.kind === "signed") address = recoverAddress(pcashSigningHash(accountCreationTypedData(network, { pcashChainId: tx.pcashChainId, nullifierKeyCommitment: nk, ruleSetCommitment: rules, receiveKeyHash: receive, recentPcashBlockHash: bytesToBigInt(tx.recentPcashBlockHash), validUntilTimestamp: tx.validUntilTimestamp })), { r: bytesToBigInt(tx.authorization.sigR), s: bytesToBigInt(tx.authorization.sigS), yParity: tx.authorization.yParity });
      requireProof(address !== undefined, "direct creation requires its L1 sender");
      requireProof(address >= 0n && address < 1n << 160n, "account address is out of range");
      const words = [address, nk, rules, receive];
      requireDecodedStatement(leaf.statement, words);
      return {
        kind: "userAccountCreation",
        account: { address, nullifierKeyCommitment: nk, ruleSetCommitment: rules, revision: 1n, receiveKeyHash: receive },
        publicInputs: words,
      };
    }
  }
}
