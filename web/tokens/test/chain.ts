// A synthetic PCASH chain for native-proving tests. It keeps the four trees
// the proofs open (outputs, accounts, history, and the typed header and state
// commitments) and applies a transaction's effects the way execution does:
// the recent block must be known, the validity window must hold, and every
// nullifier must be fresh and distinct. It also answers the node reads the
// token templates make, from the same state.

import { SparseMerkleTree } from "@pcash/sdk/crypto";
import {
  accountStateCommitment,
  blockHash,
  historyLeaf,
  nullifierKeyCommitment,
  openBlockHeaderKey,
  openStateKey,
  outputCommitment,
  receiveKeyHash,
  stateRoot,
  type PcashBlockHeader,
  type StateComponents,
} from "@pcash/sdk/protocol";
import {
  OutputOpeningMismatchError,
  type AccountProofResult,
  type BlockHeaderResult,
  type HistoryProofResult,
  type WitnessSnapshotQuery,
  type WitnessSnapshotResult,
} from "@pcash/sdk/clients";
import {
  BLOCK_HEADER_KEY_HISTORY_ROOT,
  BLOCK_HEADER_KEY_STATE_ROOT,
  PRIVATE_VALUE_PROFILES,
  STATE_KEY_ACCOUNT_STATE_ROOT,
  STATE_KEY_OUTPUT_ROOT,
} from "@pcash/sdk/constants";
import type { AssetSnapshot } from "@pcash/sdk/builders";
import { addressHex, bytes32Hex, toHex } from "@pcash/sdk/utils";
import { fieldToHex } from "@pcash/sdk/crypto";

export const CHAIN_ID = 1346589512n;

interface Account {
  address: bigint;
  index: number;
  nkRoot?: bigint;
  nullifierKeyCommitment: bigint;
  accountRuleSetCommitment: bigint;
  kind: 0n | 1n;
  receiveKey?: Uint8Array;
}

interface Block {
  header: PcashBlockHeader;
  state: StateComponents;
  hash: bigint;
}

/** A rejected transaction, named by the outcome execution would record. */
export class ExecutionFailure extends Error {
  readonly outcome: string;
  constructor(outcome: string) {
    super(outcome);
    this.outcome = outcome;
  }
}

export class SyntheticChain {
  readonly outputs = new SparseMerkleTree(40);
  readonly outputCommitments: bigint[] = [];
  readonly outputData: Uint8Array[] = [];
  outputCount = 0;
  readonly accounts = new SparseMerkleTree(40);
  readonly accountsByAddress = new Map<bigint, Account>();
  accountCount = 0;
  readonly spent = new Set<bigint>();
  readonly history = new SparseMerkleTree(40);
  readonly blocks: Block[] = [];
  timestamp = 1_000n;

  constructor() {
    this.seal();
  }

  get head(): Block {
    return this.blocks.at(-1)!;
  }

  addAccount(params: {
    address: bigint;
    nullifierKeyCommitment: bigint;
    accountRuleSetCommitment: bigint;
    kind: 0n | 1n;
    receiveKey?: Uint8Array;
  }): number {
    const index = this.accountCount++;
    const account: Account = { ...params, index };
    this.accounts.setLeaf(index, this.leaf(account));
    this.accountsByAddress.set(params.address, account);
    return index;
  }

  private leaf(account: Account): bigint {
    return accountStateCommitment(
      account.address,
      account.nullifierKeyCommitment,
      account.accountRuleSetCommitment,
      account.kind,
      1n,
      account.receiveKey === undefined ? 0n : receiveKeyHash(account.receiveKey),
    );
  }

  addUser(wallet: { address: bigint; nkRoot: bigint; mlKemPublicKey: Uint8Array }, accountRuleSetCommitment: bigint): number {
    return this.addAccount({
      address: wallet.address,
      nullifierKeyCommitment: nullifierKeyCommitment(wallet.nkRoot),
      accountRuleSetCommitment,
      kind: 0n,
      receiveKey: wallet.mlKemPublicKey,
    });
  }

  addContract(contract: { address: bigint; nkRoot: bigint; functionSetCommitment: bigint }): number {
    return this.addAccount({
      address: contract.address,
      nullifierKeyCommitment: nullifierKeyCommitment(contract.nkRoot),
      accountRuleSetCommitment: contract.functionSetCommitment,
      kind: 1n,
    });
  }

  /** Append a note body directly, as an earlier transaction would have. */
  appendBody(body: bigint, data: Uint8Array = new Uint8Array()): number {
    const index = this.outputCount++;
    this.outputCommitments[index] = outputCommitment(body, index);
    this.outputs.setLeaf(index, this.outputCommitments[index]);
    this.outputData[index] = data;
    return index;
  }

  /** Close the current block: its header commits every earlier block through history. */
  seal(advanceSeconds = 12n): Block {
    this.timestamp += advanceSeconds;
    const number = BigInt(this.blocks.length);
    const state: StateComponents = {
      outputRoot: this.outputs.root,
      outputCount: BigInt(this.outputCount),
      issuedSoFar: 0n,
      lagQ: 0n,
      accountStateRoot: this.accounts.root,
      accountCount: BigInt(this.accountCount),
      nullifierRoot: 0n,
      nullifierCount: 0n,
    };
    const header: PcashBlockHeader = {
      parentHash: this.blocks.at(-1)?.hash ?? 0n,
      number,
      timestamp: this.timestamp,
      transactionResultsRoot: 0n,
      stateRoot: stateRoot(state),
      l1OriginRoot: 1n,
      historyRoot: this.history.root,
    };
    const hash = blockHash(header);
    this.history.setLeaf(number, historyLeaf(hash));
    const block = { header, state, hash };
    this.blocks.push(block);
    return block;
  }

  /**
   * Apply one private-value transaction's public effects. Nothing here checks
   * the proof; the native prover verifies it before a test submits.
   */
  apply(publicInputs: readonly bigint[], outputData: readonly Uint8Array[]): number[] {
    const { inputs, outputs, offsets } = PRIVATE_VALUE_PROFILES.S;
    const recent = publicInputs[offsets.recentBlockHash]!;
    const nullifiers = publicInputs.slice(offsets.nullifiers, offsets.nullifiers + inputs);
    const bodies = publicInputs.slice(offsets.outputs, offsets.outputs + outputs);
    const notBefore = publicInputs[offsets.notBefore]!;
    const validUntil = publicInputs[offsets.validUntil]!;
    const block = this.blocks.find((candidate) => candidate.hash === recent);
    if (block === undefined) throw new ExecutionFailure("RecentPcashBlockNotInWindow");
    if (this.timestamp > validUntil) throw new ExecutionFailure("Expired");
    if (notBefore !== 0n && notBefore > this.timestamp) throw new ExecutionFailure("NotYetValid");
    if (new Set(nullifiers).size !== nullifiers.length) throw new ExecutionFailure("DuplicateInputNullifier");
    if (nullifiers.some((value) => this.spent.has(value!))) throw new ExecutionFailure("NullifierAlreadySpent");
    for (const value of nullifiers) this.spent.add(value!);
    return bodies.map((body, slot) => this.appendBody(body!, outputData[slot]));
  }

  snapshot(block: Block = this.head): AssetSnapshot {
    return {
      recentPcashBlockHash: block.hash,
      stateRoot: block.header.stateRoot,
      stateRootHeaderSiblings: openBlockHeaderKey(block.header, BLOCK_HEADER_KEY_STATE_ROOT).siblings,
      outputRoot: block.state.outputRoot,
      outputRootStateSiblings: openStateKey(block.state, STATE_KEY_OUTPUT_ROOT).siblings,
      accountStateRoot: block.state.accountStateRoot,
      accountStateRootStateSiblings: openStateKey(block.state, STATE_KEY_ACCOUNT_STATE_ROOT).siblings,
    };
  }

  /** Output openings are taken against the head, as a witness snapshot does. */
  outputSiblings(index: number): bigint[] {
    return this.outputs.proof(index).siblings;
  }

  accountSiblings(index: number): bigint[] {
    return this.accounts.proof(index).siblings;
  }

  private boundary(block: Block) {
    return { state: block.state, header: block.header, blockHash: block.hash };
  }

  private accountProof(address: bigint, block: Block): AccountProofResult {
    const account = this.accountsByAddress.get(address);
    if (account === undefined || BigInt(account.index) >= block.state.accountCount) {
      return { status: "notFound", address: addressHex(address), authenticated: false };
    }
    return {
      status: "present",
      account: {
        address: addressHex(address),
        index: BigInt(account.index),
        accountRevision: 1n,
        nullifierKeyCommitment: fieldToHex(account.nullifierKeyCommitment),
        accountRuleSetCommitment: fieldToHex(account.accountRuleSetCommitment),
        accountKind: Number(account.kind),
        receiveKeyHash: fieldToHex(account.receiveKey === undefined ? 0n : receiveKeyHash(account.receiveKey)),
        material: account.receiveKey === undefined
          ? { status: "notPresent" }
          : { status: "available", mlKem768PublicKey: toHex(account.receiveKey) },
      },
      accountStateRoot: block.state.accountStateRoot,
      accountSiblings: this.accountSiblings(account.index),
      accountCount: block.state.accountCount,
      stateRootHeaderSiblings: openBlockHeaderKey(block.header, BLOCK_HEADER_KEY_STATE_ROOT).siblings,
      accountStateRootStateSiblings: openStateKey(block.state, STATE_KEY_ACCOUNT_STATE_ROOT).siblings,
      boundary: this.boundary(block),
    };
  }

  /** The node reads the templates make, answered from the sealed head. */
  node() {
    const chain = this;
    const byHash = (hash: bigint): Block => {
      const block = chain.blocks.find((candidate) => candidate.hash === hash);
      if (block === undefined) throw new Error("unknown block hash");
      return block;
    };
    return {
      async getWitnessSnapshot(query: WitnessSnapshotQuery): Promise<WitnessSnapshotResult> {
        const block = chain.head;
        const outputs = query.outputs ?? [];
        let outputPaths: WitnessSnapshotResult["outputs"] = null;
        if (outputs.every((output) => BigInt(output.outputIndex) < block.state.outputCount)) {
          outputPaths = {
            root: bytes32Hex(block.state.outputRoot),
            count: block.state.outputCount,
            paths: outputs.map((output) => {
              const index = Number(output.outputIndex);
              if (chain.outputCommitments[index] !== output.outputCommitment) {
                throw new OutputOpeningMismatchError("batched output path mismatch");
              }
              const proof = chain.outputs.proof(index);
              if (proof.root !== block.state.outputRoot) throw new Error("synthetic head is stale");
              return { outputIndex: BigInt(index), siblings: proof.siblings };
            }),
            boundary: chain.boundary(block),
          };
        }
        const nullifiers = query.nullifiers ?? [];
        return {
          status: {} as WitnessSnapshotResult["status"],
          blockHeader: { recentPcashBlockHash: block.hash, boundary: chain.boundary(block) },
          block: null,
          accounts: (query.accounts ?? []).map((address) => chain.accountProof(BigInt(address), block)),
          contracts: [],
          outputs: outputPaths,
          nullifiers: nullifiers.length === 0
            ? { statuses: [], boundary: null }
            : {
                statuses: nullifiers.map((value) => ({ nullifier: value, spent: chain.spent.has(BigInt(value)) })),
                boundary: chain.boundary(block),
              },
          l1Logs: [],
        };
      },
      async getAccountProof(address: string): Promise<AccountProofResult> {
        return chain.accountProof(BigInt(address), chain.head);
      },
      async getCurrentNullifierStatuses(values: readonly string[]) {
        return {
          statuses: values.map((value) => ({ nullifier: value, spent: chain.spent.has(BigInt(value)) })),
          boundary: chain.boundary(chain.head),
        };
      },
      async getHistoryProof(recent: bigint, historical: bigint | number): Promise<HistoryProofResult> {
        const block = byHash(recent);
        const number = BigInt(historical);
        if (number >= block.header.number) throw new Error("history proof beyond the recent block");
        // Rebuild the history tree as of the recent block: leaves 0..number-1.
        const tree = new SparseMerkleTree(40);
        for (let i = 0n; i < block.header.number; i += 1n) tree.setLeaf(i, historyLeaf(chain.blocks[Number(i)]!.hash));
        return {
          recentPcashBlockHash: recent,
          historyRoot: block.header.historyRoot,
          historyRootSiblings: openBlockHeaderKey(block.header, BLOCK_HEADER_KEY_HISTORY_ROOT).siblings,
          historicalBlockNumber: number,
          historicalBlockHash: chain.blocks[Number(number)]!.hash,
          historySiblings: tree.proof(number).siblings,
          boundary: chain.boundary(block),
        };
      },
      async getBlockHeader(tag: { hash: bigint }): Promise<BlockHeaderResult> {
        const block = byHash(tag.hash);
        return { recentPcashBlockHash: block.hash, boundary: chain.boundary(block) };
      },
    };
  }
}
