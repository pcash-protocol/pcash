// The wallet's local chain state on its own: steps fed from the simulated
// chain's public feeds reproduce each block's roots, reload from their records
// unchanged, prune checkpoints behind finality, rewind reorganized steps, and
// forget consumption nobody watches once it is final.

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fieldToHex, rootFromIndex } from "@pcash/sdk/crypto";
import { receiveKeyHash } from "@pcash/sdk/protocol";
import { toHex } from "@pcash/sdk/utils";
import { MISMATCHED_RECEIVE_KEY, WalletChainState, genesisChainState, type ChainCommit } from "../../src/wallet/chainState.ts";
import { ChainSim, type AccountRow } from "./chainFixture.ts";

const CHAIN_ID = 0x1ff6n;
const randomWord = (): string => toHex(randomBytes(32));
const checkpointKey = (pcashNumber: bigint): string => `checkpoint:${pcashNumber.toString(16).padStart(16, "0")}`;
const EMPTY = [null, null, null, null, null] as const;

type SimBlock = ReturnType<ChainSim["addBlock"]>;

function accountRow(seed: number, revision = 1, receiveKey: Uint8Array | null = new Uint8Array(32).fill(seed)): AccountRow {
  return {
    address: `0x${seed.toString(16).padStart(2, "0").repeat(20)}`,
    nullifierKeyCommitment: BigInt(seed) + 100n,
    accountRuleSetCommitment: 7n,
    accountRevision: revision,
    receiveKey,
  };
}

function applyCommit(records: Map<string, unknown>, commit: ChainCommit): void {
  if (commit.replace) records.clear();
  for (const [key, value] of commit.writes) {
    if (value === null) records.delete(key);
    else records.set(key, structuredClone(value));
  }
}

/** Feed blocks' account changes and outputs as synchronization does, then seal the step at the last one. */
function step(
  state: WalletChainState,
  records: Map<string, unknown>,
  blocks: readonly SimBlock[],
  options: { finalizedBlock?: bigint; watched?: readonly string[]; marks?: readonly bigint[] } = {},
): ChainCommit {
  const watched = new Set(options.watched ?? []);
  const marks = new Set(options.marks ?? []);
  for (const block of blocks) {
    for (const change of block.changes) state.applyAccountChange(change);
    for (const output of block.outputs) {
      if (output.kind === "ordinary") {
        for (const consumed of output.nullifiers) {
          if (!watched.has(consumed)) continue;
          state.recordConsumption(consumed, {
            pcashNumber: output.origin.pcashNumber,
            pcashHash: output.origin.pcashHash,
            timestamp: output.origin.timestamp,
            transactionId: output.transactionId,
            contentHash: output.contentHash,
            nullifiers: [...output.nullifiers],
          });
        }
      }
      state.outputs.append(BigInt(output.outputCommitment), marks.has(output.outputIndex));
    }
  }
  const anchor = blocks.at(-1)!.envelope;
  const commit = state.finishStep({ anchor, finalizedBlock: options.finalizedBlock ?? 0n, watched });
  applyCommit(records, commit);
  expect(state.outputs.root()).toBe(anchor.state.outputRoot);
  expect(state.accountRoot()).toBe(anchor.state.accountStateRoot);
  return commit;
}

function expectSameState(actual: WalletChainState, expected: WalletChainState, addresses: readonly string[]): void {
  expect(actual.revision).toBe(expected.revision);
  expect(actual.birthday).toEqual(expected.birthday);
  expect(actual.synced).toEqual(expected.synced);
  expect(actual.anchor).toEqual(expected.anchor);
  expect(actual.checkpoints()).toEqual(expected.checkpoints());
  expect(actual.outputs.count).toBe(expected.outputs.count);
  expect(actual.outputs.root()).toBe(expected.outputs.root());
  expect(actual.outputs.markedIndices()).toEqual(expected.outputs.markedIndices());
  for (const index of expected.outputs.markedIndices()) {
    expect(actual.outputs.witness(index)).toEqual(expected.outputs.witness(index));
  }
  expect(actual.accountCount).toBe(expected.accountCount);
  expect(actual.accountRoot()).toBe(expected.accountRoot());
  for (const address of addresses) {
    expect(actual.accountResult(address)).toEqual(expected.accountResult(address));
    expect(actual.receiveKey(address)).toEqual(expected.receiveKey(address));
  }
  expect(actual.consumed).toEqual(expected.consumed);
}

function fresh(sim: ChainSim): { state: WalletChainState; records: Map<string, unknown> } {
  return { state: genesisChainState({ pcashNumber: 0n, pcashHash: sim.genesisHash }), records: new Map() };
}

describe("wallet chain state", () => {
  it("reloads from its records after several steps and continues identically", () => {
    const sim = new ChainSim(CHAIN_ID);
    const { state, records } = fresh(sim);
    const [alice, bob, carol] = [accountRow(0xa1), accountRow(0xb2, 1, null), accountRow(0xc3)];
    const [spent, other] = [randomWord(), randomWord()];
    const watched = [spent, other];
    step(state, records, [sim.addBlock({ accounts: [alice, bob], transactions: [{ nullifiers: [randomWord()], outputs: EMPTY }] })], { marks: [1n], watched });
    step(state, records, [
      sim.addBlock({ accounts: [accountRow(0xa1, 2, new Uint8Array(32).fill(0xa2))], transactions: [{ nullifiers: [spent], outputs: EMPTY }] }),
      sim.addBlock({ transactions: [{ outputs: EMPTY }] }),
    ], { marks: [7n], watched });
    step(state, records, [sim.addBlock({ accounts: [carol], transactions: [{ nullifiers: [other, randomWord()], outputs: EMPTY }] })], { marks: [13n], watched });
    expect(state.consumption(watched).map((consumption) => consumption?.pcashNumber)).toEqual([2n, 4n]);

    const reloaded = WalletChainState.fromRecords(records)!;
    const addresses = [alice, bob, carol].map((row) => row.address);
    expectSameState(reloaded, state, addresses);

    const next = sim.addBlock({ accounts: [accountRow(0xb2, 2)], transactions: [{ outputs: EMPTY }] });
    const reloadedRecords = new Map(records);
    const expected = step(state, records, [next], { marks: [16n], watched });
    const actual = step(reloaded, reloadedRecords, [next], { marks: [16n], watched });
    expect(actual).toEqual(expected);

    const oldest = state.checkpoints().at(-1)!;
    state.rewindTo(oldest);
    reloaded.rewindTo(oldest);
    expectSameState(reloaded, state, addresses);
  });

  it("keeps every checkpoint above finality and the newest at or below it", () => {
    const sim = new ChainSim(CHAIN_ID);
    const { state, records } = fresh(sim);
    const checkpoints = () => state.checkpoints().map((checkpoint) => checkpoint.pcashNumber);
    const undoOf = (pcashNumber: bigint) => (records.get(checkpointKey(pcashNumber)) as { accountUndo: unknown[] }).accountUndo;
    step(state, records, [sim.addBlock({ accounts: [accountRow(1)] }), sim.addBlock({ accounts: [accountRow(1, 2)] })]);
    step(state, records, [sim.addBlock({ accounts: [accountRow(2)] }), sim.addBlock()]);
    step(state, records, [sim.addBlock({ accounts: [accountRow(2, 2)] }), sim.addBlock()]);
    expect(checkpoints()).toEqual([6n, 4n, 2n]);
    expect(undoOf(2n)).toEqual([]);
    expect(undoOf(4n)).toHaveLength(1);

    // Finality between checkpoints keeps the one just below it.
    const between = step(state, records, [sim.addBlock({ accounts: [accountRow(3)] }), sim.addBlock()], { finalizedBlock: 5n });
    expect(checkpoints()).toEqual([8n, 6n, 4n]);
    expect(between.writes.get(checkpointKey(2n))).toBeNull();
    expect(records.has(checkpointKey(2n))).toBe(false);
    expect(undoOf(4n)).toEqual([]);
    expect(undoOf(6n)).toHaveLength(1);

    const onCheckpoint = step(state, records, [sim.addBlock()], { finalizedBlock: 6n });
    expect(checkpoints()).toEqual([9n, 8n, 6n]);
    expect(onCheckpoint.writes.get(checkpointKey(4n))).toBeNull();
    expect(undoOf(6n)).toEqual([]);
    expect(undoOf(8n)).toHaveLength(1);
    expect([...records.keys()].filter((key) => key.startsWith("checkpoint:")).sort())
      .toEqual([6n, 8n, 9n].map(checkpointKey));
  });

  it("rewinds accounts, receive keys, consumption, and the output frontier to a checkpoint", () => {
    const sim = new ChainSim(CHAIN_ID);
    const { state, records } = fresh(sim);
    const alice = accountRow(0xa1);
    const bob = accountRow(0xb2);
    const spent = randomWord();
    const b1 = sim.addBlock({ accounts: [alice], transactions: [{ outputs: EMPTY }] });
    step(state, records, [b1], { marks: [1n], watched: [spent] });
    const aliceBefore = state.accountResult(alice.address);
    const leaf = BigInt(b1.outputs[1]!.outputCommitment);

    step(state, records, [sim.addBlock({
      accounts: [accountRow(0xa1, 2, new Uint8Array(32).fill(0xa2)), bob],
      transactions: [{ nullifiers: [spent], outputs: EMPTY }],
    })], { marks: [6n], watched: [spent] });
    expect(state.accountResult(alice.address)!.accountRevision).toBe(2n);
    expect(state.account(bob.address)).not.toBeNull();
    expect(state.consumption([spent])[0]).not.toBeNull();

    state.rewindTo({ pcashNumber: 1n, pcashHash: state.checkpoints().at(-1)!.pcashHash });
    expect(state.anchor).toBeNull();
    expect(state.synced).toEqual(state.checkpoints()[0]);
    expect(state.synced.pcashNumber).toBe(1n);
    expect(state.accountResult(alice.address)).toEqual(aliceBefore);
    expect(state.receiveKey(alice.address)).toEqual(alice.receiveKey);
    expect(state.account(bob.address)).toBeNull();
    expect(state.receiveKey(bob.address)).toBeNull();
    expect(state.accountCount).toBe(1n);
    expect(state.accountRoot()).toBe(b1.envelope.state.accountStateRoot);
    expect(state.consumption([spent])).toEqual([null]);
    expect(state.outputs.count).toBe(5n);
    expect(state.outputs.root()).toBe(b1.envelope.state.outputRoot);
    expect(state.outputs.markedIndices()).toEqual([1n]);
    expect(rootFromIndex(leaf, 1n, state.outputs.witness(1n))).toBe(b1.envelope.state.outputRoot);

    sim.reorg(1n, [{ accounts: [accountRow(0xc3)], transactions: [{ outputs: EMPTY }] }]);
    step(state, records, [sim.head], { watched: [spent] });
    const reloaded = WalletChainState.fromRecords(records)!;
    expectSameState(reloaded, state, [alice.address, bob.address, accountRow(0xc3).address]);
    expect(reloaded.account(bob.address)).toBeNull();
    expect(reloaded.receiveKey(bob.address)).toBeNull();
    expect(reloaded.consumption([spent])).toEqual([null]);
  });

  it("drops consumption that is final and no longer watched", () => {
    const sim = new ChainSim(CHAIN_ID);
    const { state, records } = fresh(sim);
    const [dropped, watched, recent] = [randomWord(), randomWord(), randomWord()];
    step(state, records, [sim.addBlock({ transactions: [{ nullifiers: [dropped, watched], outputs: EMPTY }] })], { watched: [dropped, watched] });
    step(state, records, [sim.addBlock(), sim.addBlock({ transactions: [{ nullifiers: [recent], outputs: EMPTY }] })], { watched: [dropped, watched, recent] });

    const commit = step(state, records, [sim.addBlock()], { finalizedBlock: 2n, watched: [watched] });
    expect(commit.writes.get(`nullifier:${dropped}`)).toBeNull();
    expect(state.consumption([dropped, watched, recent]).map((consumption) => consumption?.pcashNumber ?? null))
      .toEqual([null, 1n, 3n]);
    expect(WalletChainState.fromRecords(records)!.consumed).toEqual(state.consumed);
  });

  it("keeps a receive key only while it matches the account's committed digest", () => {
    const state = genesisChainState({ pcashNumber: 0n, pcashHash: randomWord() });
    const origin = { pcashNumber: 1n, pcashHash: randomWord() };
    const key = new Uint8Array(1_184).fill(1);
    const address = `0x${"ab".repeat(20)}`;
    const row = {
      origin,
      accountIndex: 0n,
      address: address as `0x${string}`,
      nullifierKeyCommitment: 101n,
      accountRuleSetCommitment: 7n,
      accountKind: 0 as const,
      accountRevision: 1,
      receiveKeyHash: fieldToHex(receiveKeyHash(key)),
      receiveKey: key,
    };
    state.applyAccountChange(row);
    state.applyAccountChange({ ...row, accountRevision: 2, receiveKey: null });
    expect(state.receiveKey(address)).toEqual(key);
    state.applyAccountChange({ ...row, accountRevision: 3, receiveKeyHash: fieldToHex(receiveKeyHash(new Uint8Array(1_184).fill(2))), receiveKey: null });
    expect(state.receiveKey(address)).toBeNull();
    expect(state.accountResult(address)!.material.status).toBe("unavailable");
  });

  it("refuses a synced receive key that does not hash to the committed digest, not its account", () => {
    const address = `0x${"cd".repeat(20)}`;
    const change = {
      origin: { pcashNumber: 1n, pcashHash: randomWord() },
      accountIndex: 0n,
      address: address as `0x${string}`,
      nullifierKeyCommitment: 101n,
      accountRuleSetCommitment: 7n,
      accountKind: 0 as const,
      accountRevision: 1,
      receiveKeyHash: fieldToHex(receiveKeyHash(new Uint8Array(1_184).fill(1))),
      receiveKey: new Uint8Array(1_184).fill(2),
    };
    const checked = genesisChainState({ pcashNumber: 0n, pcashHash: randomWord() });
    expect(() => checked.applyAccountChange(change, { checkReceiveKey: true }))
      .toThrow("does not match its committed digest");
    expect(checked.account(address)).toBeNull();

    const replayed = genesisChainState({ pcashNumber: 0n, pcashHash: randomWord() });
    replayed.applyAccountChange(change);
    expect(replayed.receiveKey(address)).toBeNull();
    expect(replayed.accountResult(address)!.material).toEqual({ status: "unavailable", lifecycle: MISMATCHED_RECEIVE_KEY });
    expect(replayed.accountResult(address)!.accountRevision).toBe(1n);
  });
});
