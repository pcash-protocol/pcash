// WalletProfile output-secret policy. Consensus receives opaque owner commitments,
// while the reference wallet keeps owner change recoverable and randomizes
// padding plus every output whose note key may be public.

import { describe, expect, it } from "vitest";
import {
  buildNativeTransfer,
  defaultEcdsaRuleSet,
  type NativeTransferBuild,
} from "../src/builders/index.ts";
import {
  fullOutputCommitment,
  noteNk,
  noteSecret,
  noteSecretSeed,
  nullifierKeyCommitment,
} from "../src/protocol/notes.ts";
import {
  BLOCK_HEADER_KEY_STATE_ROOT,
  MERKLE_DEPTH,
  ACCOUNT_KIND_CONTRACT,
  STATE_KEY_OUTPUT_ROOT,
  STATE_KEY_ACCOUNT_STATE_ROOT,
} from "../src/constants/params.ts";
import { accountStateCommitment } from "../src/protocol/account.ts";
import { sizeClassFiller } from "../src/protocol/envelope.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { blockHash, openBlockHeaderKey, openStateKey, stateRoot } from "../src/protocol/block.ts";
import { deriveTestWallet } from "./testWallet.ts";
import { TEST_DEFAULT_RULE_SECRETS, transferFixture } from "@pcash/test-support/protocol-fixtures";

const chainId = 0x1ff6n;
const wallet = deriveTestWallet();
const recipientAddress = 0x1234567890123456789012345678901234567890n;
// slot0 recipient(1_000_000), slot1 change(250_500), slots2-4 dummy.
const build = (overrides: Record<string, unknown> = {}) =>
  buildNativeTransfer(transferFixture({
    chainId,
    wallet,
    recipientAddress,
    inputAmount: 1_250_500n,
    paymentAmount: 1_000_000n,
    openFeeAmount: 0n,
    issuanceOwnerCommitment: 0n,
    dummyInputEntropy: 1n,
    validUntilTimestamp: 999n,
    noteSecret: 0xabcn,
    ...overrides,
  }));

const buildContract = (
  publicNkRoot = false,
  overrides: Record<string, unknown> = {},
): NativeTransferBuild => {
  const set = defaultEcdsaRuleSet({
    wallet,
    secrets: TEST_DEFAULT_RULE_SECRETS,
  });
  const userParams = transferFixture({
    chainId,
    wallet,
    recipientAddress,
    inputAmount: 1_250_500n,
    paymentAmount: 1_000_000n,
    openFeeAmount: 0n,
    issuanceOwnerCommitment: 0n,
    dummyInputEntropy: 1n,
    validUntilTimestamp: 999n,
    noteSecret: 0xabcn,
    accountKind: ACCOUNT_KIND_CONTRACT,
    accountRuleSetCommitment: set.ruleSetCommitment,
  });
  const {
    ruleSetCommitment: _ruleSetCommitment,
    rule: _rule,
    otherRules: _otherRules,
    defaultRuleSecrets: _defaultRuleSecrets,
    ...transfer
  } = userParams;
  return buildNativeTransfer({
    ...transfer,
    accountKind: ACCOUNT_KIND_CONTRACT,
    accountRuleSetCommitment: set.ruleSetCommitment,
    accountRule: {
      configurationCommitment: set.ruleWitness.configurationCommitment,
      commitmentBlinder: set.ruleWitness.commitmentBlinder,
      entryIndex: set.ruleWitness.slot,
      siblings: set.ruleWitness.siblings,
    },
    publicNkRoot,
    ...overrides,
  });
};

const outSecrets = (b: NativeTransferBuild): bigint[] => b.outputNoteSecrets;
const expectedSecret = (b: NativeTransferBuild, slot: number, entropy: bigint): bigint =>
  noteSecret(noteSecretSeed(noteNk(wallet.nkRoot)), b.transaction.inputs.map((input) => input.nullifier), slot, entropy);

const buildFourInput = (
  dummyInputEntropy: bigint,
  overrides: Partial<Pick<Parameters<typeof buildNativeTransfer>[0],
    "outputEntropies"
  >> = {},
): NativeTransferBuild => {
  const inputSpecs = [
    { amount: 400n, noteSecret: 0xa1n, leafIndex: 0 },
    { amount: 300n, noteSecret: 0xa2n, leafIndex: 1 },
    { amount: 200n, noteSecret: 0xa3n, leafIndex: 2 },
    { amount: 100n, noteSecret: 0xa4n, leafIndex: 3 },
  ];
  const noteTree = new SparseMerkleTree(MERKLE_DEPTH);
  for (const input of inputSpecs) {
    noteTree.setLeaf(input.leafIndex, fullOutputCommitment(
      { owner: wallet.address, noteSecret: input.noteSecret, assetId: 0n, amount: input.amount },
      input.leafIndex,
    ));
  }
  const ruleSetCommitment = defaultEcdsaRuleSet({
    wallet,
    secrets: TEST_DEFAULT_RULE_SECRETS,
  }).ruleSetCommitment;
  const accountStateTree = new SparseMerkleTree(MERKLE_DEPTH);
  accountStateTree.setLeaf(
    0,
    accountStateCommitment(
      wallet.address,
      nullifierKeyCommitment(wallet.nkRoot),
      ruleSetCommitment,
      0n,
      1n,
      0n,
    ),
  );
  const accountOpening = accountStateTree.proof(0);
  const state = {
    outputRoot: noteTree.root,
    outputCount: 4n,
    issuedSoFar: 0n,
    lagQ: 100n * 10n ** 18n * 2n ** 64n,
    accountStateRoot: accountOpening.root,
    accountCount: 1n,
    nullifierRoot: 0n,
    nullifierCount: 0n,
  };
  const committedStateRoot = stateRoot(state);
  const noteStateOpening = openStateKey(state, STATE_KEY_OUTPUT_ROOT);
  const accountStateOpening = openStateKey(state, STATE_KEY_ACCOUNT_STATE_ROOT);
  const header = {
    parentHash: 1n,
    number: 1n,
    timestamp: 1n,
    transactionResultsRoot: 0n,
    stateRoot: committedStateRoot,
    l1OriginRoot: 1n,
    historyRoot: 1n,
  };
  const headerOpening = openBlockHeaderKey(header, BLOCK_HEADER_KEY_STATE_ROOT);
  return buildNativeTransfer({
    chainId,
    wallet,
    recipientAddress,
    paymentAmount: 1_000n,
    inputs: inputSpecs.map((input) => ({
      ...input,
      siblings: noteTree.proof(input.leafIndex).siblings,
    })),
    outputRoot: noteTree.root,
    outputRootStateSiblings: noteStateOpening.siblings,
    recentPcashBlockHash: blockHash(header),
    stateRoot: committedStateRoot,
    stateRootHeaderSiblings: headerOpening.siblings,
    accountStateRootStateSiblings: accountStateOpening.siblings,
    openFeeAmount: 0n,
    issuanceOwnerCommitment: 0n,
    dummyInputEntropy,
    validUntilTimestamp: 999n,
    ruleSetCommitment,
    defaultRuleSecrets: TEST_DEFAULT_RULE_SECRETS,
    accountStateRoot: accountOpening.root,
    accountSiblings: accountOpening.siblings,
    accountRevision: 1n,
    receiveKeyHash: 0n,
    outputData: [sizeClassFiller()],

    ...overrides,
  });
};

describe("wallet output-secret policy", () => {
  it("private-root user spend randomizes padding but keeps recipient and owner change deterministic", () => {
    const first = build();
    const second = build();
    expect(first.transaction.inputs.map((input) => input.nullifier))
      .toEqual(second.transaction.inputs.map((input) => input.nullifier));
    for (const b of [first, second]) {
      expect(b.outputNoteSecrets[0]).toBe(expectedSecret(b, 0, 0n));
      expect(b.outputNoteSecrets[1]).toBe(expectedSecret(b, 1, 0n));
      for (let slot = 2; slot < 5; slot++) {
        expect(b.outputNoteSecrets[slot]).not.toBe(expectedSecret(b, slot, 0n));
      }
    }
    expect(second.outputNoteSecrets.slice(2)).not.toEqual(first.outputNoteSecrets.slice(2));
  });

  it("published-root contract spend randomizes all five output openings", () => {
    const e = outSecrets(buildContract(true));
    expect(new Set(e).size).toBe(5);
    // Fresh per build (CSPRNG) — two builds differ.
    const e2 = outSecrets(buildContract(true));
    expect(new Set(e2).size).toBe(5);
    expect(e2).not.toEqual(e);
  });

  it("account kind alone does not publish nkRoot", () => {
    const b = buildContract();
    expect(b.outputNoteSecrets[0]).toBe(expectedSecret(b, 0, 0n));
    expect(b.outputNoteSecrets[1]).toBe(expectedSecret(b, 1, 0n));
    for (let slot = 2; slot < 5; slot++) {
      expect(b.outputNoteSecrets[slot]).not.toBe(expectedSecret(b, slot, 0n));
    }
  });

  it("rejects a published root under the readable rules", () => {
    expect(() => build({ publicNkRoot: true })).toThrow(/publicNkRoot is not supported/);
  });

  it("four real inputs randomize outputs even when nkRoot stays private", () => {
    const a = buildFourInput(1n);
    const b = buildFourInput(2n);
    expect(a.transaction.inputs.map((input) => input.nullifier)).toEqual(
      b.transaction.inputs.map((input) => input.nullifier),
    );
    expect(new Set(outSecrets(a)).size).toBe(5);
    expect(new Set(outSecrets(b)).size).toBe(5);
    expect(a.outputNoteSecrets).not.toEqual(b.outputNoteSecrets);
  });

  it("rejects zero or duplicate entropy overrides with four real inputs", () => {
    expect(() => buildFourInput(1n, { outputEntropies: [0n] })).toThrow(
      "outputEntropies[0] must be nonzero",
    );
    expect(() => buildFourInput(1n, {
      outputEntropies: [0x55n, 0x55n],
    })).toThrow("must be distinct");
  });

  it("secondOutput.entropy applies to its slot", () => {
    const b = build({
      paymentAmount: 500_000n,
      secondOutput: {
        address: 0xbeefn,
        amount: 250_000n,
        entropy: 0x777n,
        outputData: sizeClassFiller(),
      },
      outputData: [undefined, undefined, sizeClassFiller()], // deliver the change (slot 2 real, to self)
    });
    expect(b.outputNoteSecrets[1]).toBe(expectedSecret(b, 1, 0x777n));
    expect(b.outputNoteSecrets[0]).toBe(expectedSecret(b, 0, 0n));
    expect(b.outputNoteSecrets[2]).toBe(expectedSecret(b, 2, 0n));
  });

  it("per-slot outputEntropy override wins over the default", () => {
    const b = build({ outputEntropies: [0x5n, undefined, 0x6n, 0x7n, 0x8n] });
    expect(b.outputNoteSecrets[0]).toBe(expectedSecret(b, 0, 0x5n));
    expect(b.outputNoteSecrets[1]).toBe(expectedSecret(b, 1, 0n));
    for (let slot = 2; slot < 5; slot++) {
      expect(b.outputNoteSecrets[slot]).toBe(expectedSecret(b, slot, BigInt(slot + 4)));
    }
  });

  it("rejects zero or duplicate entropy overrides for private-root padding", () => {
    expect(() => build({ outputEntropies: [undefined, undefined, 0n] })).toThrow(
      "outputEntropies[2] must be nonzero",
    );
    expect(() => build({
      outputEntropies: [undefined, undefined, 0x55n, 0x55n],
    })).toThrow("must be distinct");
  });

  it("rejects zero or duplicate entropy overrides for a published root", () => {
    expect(() => buildContract(true, { outputEntropies: [0n] })).toThrow(
      "outputEntropies[0] must be nonzero",
    );
    expect(() => buildContract(true, { outputEntropies: [0x55n, 0x55n],})).toThrow(
      "must be distinct",
    );
  });
});
