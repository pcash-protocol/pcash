import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BN254_SCALAR_MODULUS } from "../src/crypto/field.ts";
import { toHex } from "../src/utils/hex.ts";
import { authorizationIssuanceOpening, issuancePayoutOpening, controlledIssuanceOpening, payoutRoleForSourceKind, payoutSeed, payoutTransactionContext, posterPayoutOpening, PayoutRole, recoverPayoutOpening } from "../src/protocol/payout.ts";
import { WIRE_PROOF_BYTES, decodeBatch, encodeBatch, encodeBatchItems, encodeContractAccountCreation, encodePrivateValueTransaction, encodeUserAccountCreation, encodeUserAccountUpdate, decodeTransaction, isUnpaidTransaction, privateValuePublicInputs, type PrivateValueOutputData } from "../src/protocol/codec.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { assertOutputDataItems, sizeClassFiller } from "../src/protocol/envelope.ts";
import { deliveryCommitment, randomArena } from "../src/protocol/transfer.ts";
import { ownerCommitment } from "../src/protocol/notes.ts";
const vectors = JSON.parse(readFileSync(new URL("../../vectors/protocol_vectors.json", import.meta.url), "utf8"));
const p = vectors.payouts;
const chainId = BigInt(vectors.chainId);
const entries = [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5)];
describe("seed-recoverable system payouts", () => {
  it("matches circuit seed, issuance and poster vectors", () => {
    expect(payoutSeed(p.nkRoot)).toBe(BigInt(p.seed));
    expect(payoutTransactionContext(chainId, p.nullifiers)).toBe(BigInt(p.transactionContext));
    const issuance = issuancePayoutOpening(p.owner, p.nkRoot, chainId, p.nullifiers);
    expect(PayoutRole.ISSUANCE).toBe(3);
    expect(issuance.noteSecret).toBe(BigInt(p.issuanceSecret));
    expect(issuance.ownerCommitment).toBe(BigInt(p.issuanceOwnerCommitment));
    expect(toHex(encodeBatchItems(entries))).toBe(p.batchItemBytes);
    const poster = posterPayoutOpening(p.owner, p.nkRoot, p.posterContext);
    expect(poster.context).toBe(BigInt(p.posterContext));
    expect(poster.noteSecret).toBe(BigInt(p.posterSecret));
    expect(poster.ownerCommitment).toBe(BigInt(p.posterOwnerCommitment));
  });
  it("separates issuance, chains and poster contexts", () => {
    const original = posterPayoutOpening(p.owner, p.nkRoot, p.posterContext);
    for (const changed of [BigInt(p.posterContext) - 1n, BigInt(p.posterContext) + 1n]) {
      expect(posterPayoutOpening(p.owner, p.nkRoot, changed).noteSecret).not.toBe(original.noteSecret);
    }
    expect(payoutTransactionContext(chainId + 1n, p.nullifiers)).not.toBe(BigInt(p.transactionContext));
    expect(BigInt(p.issuanceSecret)).not.toBe(BigInt(p.posterSecret));
  });
  it("requires the designated quote's exact opening and context", () => {
    const recipientAddress = 0x1234n, noteSecret = 111n;
    const commitment = ownerCommitment(recipientAddress, noteSecret);
    const opening = { recipientAddress, noteSecret, transactionContext: BigInt(p.transactionContext) };
    expect(authorizationIssuanceOpening(commitment, chainId, p.nullifiers, opening).issuanceRecipient).toBe(recipientAddress);
    expect(() => authorizationIssuanceOpening(commitment, chainId, p.nullifiers, { ...opening, noteSecret: 112n })).toThrow(/opening/);
    expect(() => authorizationIssuanceOpening(commitment, chainId, p.nullifiers, { ...opening, transactionContext: 1n })).toThrow(/context/);
    expect(() => authorizationIssuanceOpening(commitment, chainId, p.nullifiers)).toThrow(/quote/);
    expect(authorizationIssuanceOpening(0n, chainId, p.nullifiers).issuanceNoteSecret).toBe(0n);
  });
  it("accepts a designated opening whose note secret is zero", () => {
    const recipientAddress = 0x1234n;
    const commitment = ownerCommitment(recipientAddress, 0n);
    const opening = { recipientAddress, noteSecret: 0n, transactionContext: BigInt(p.transactionContext) };
    expect(authorizationIssuanceOpening(commitment, chainId, p.nullifiers, opening))
      .toEqual({ issuanceRecipient: recipientAddress, issuanceNoteSecret: 0n, transactionContext: BigInt(p.transactionContext) });
  });
  it("accepts a designated route to address zero", () => {
    const commitment = ownerCommitment(0n, 111n);
    const opening = { recipientAddress: 0n, noteSecret: 111n, transactionContext: BigInt(p.transactionContext) };
    expect(authorizationIssuanceOpening(commitment, chainId, p.nullifiers, opening))
      .toEqual({ issuanceRecipient: 0n, issuanceNoteSecret: 111n, transactionContext: BigInt(p.transactionContext) });
  });
  it("rejects both forms of invalid open-issuance opening", () => {
    const transactionContext = BigInt(p.transactionContext);
    expect(() => authorizationIssuanceOpening(0n, chainId, p.nullifiers, {
      recipientAddress: 0x1234n,
      noteSecret: 0n,
      transactionContext,
    })).toThrow(/open issuance/);
    expect(() => authorizationIssuanceOpening(0n, chainId, p.nullifiers, {
      recipientAddress: 0n,
      noteSecret: 111n,
      transactionContext,
    })).toThrow(/open issuance/);
  });
});
describe("notes-only wire", () => {
  it("requires canonical poster framing", () => {
    const batch = encodeBatch(entries, p.posterOwnerCommitment, 0n);
    expect(batch.length).toBe(67 + entries.reduce((n, e) => n + 4 + e.length, 0));
    expect(decodeBatch(batch)).toEqual({ version: 1, posterOwnerCommitment: BigInt(p.posterOwnerCommitment), posterContext: 0n, items: entries });
    expect(() => encodeBatch(entries, BN254_SCALAR_MODULUS, 0n)).toThrow();
    const nonCanonicalPoster = Uint8Array.from(batch); nonCanonicalPoster.fill(0xff, 1, 33);
    expect(() => decodeBatch(nonCanonicalPoster)).toThrow();
    expect(() => encodeBatch(entries, p.posterOwnerCommitment, BN254_SCALAR_MODULUS)).toThrow();
    const invalidContext = Uint8Array.from(batch); invalidContext.fill(0xff, 33, 65);
    expect(() => decodeBatch(invalidContext)).toThrow();
    const opening = posterPayoutOpening(p.owner, p.nkRoot, 42n);
    for (const items of [entries, [entries[1]!], [entries[1]!, entries[0]!]]) {
      const decoded = decodeBatch(encodeBatch(items, opening.ownerCommitment, opening.context));
      expect(decoded.posterContext).toBe(opening.context);
      expect(decoded.posterOwnerCommitment).toBe(opening.ownerCommitment);
    }
  });
  it("frames a zero poster commitment like any other canonical value", () => {
    const batch = encodeBatch(entries, 0n, 0n);
    expect(batch.subarray(1, 33)).toEqual(new Uint8Array(32));
    expect(decodeBatch(batch)).toEqual({ version: 1, posterOwnerCommitment: 0n, posterContext: 0n, items: entries });
  });
  it("round-trips 17 statement words for open and designated routes", () => {
    const outputData = Array.from({ length: 5 }, () => sizeClassFiller()) as unknown as PrivateValueOutputData;
    const arena = randomArena(PRIVATE_VALUE_PROFILES.S.shapeId);
    const base = [chainId, 9n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, deliveryCommitment(outputData, arena), 0n, 0n, 11n, 12n, 0n, 0n];
    const { offsets } = PRIVATE_VALUE_PROFILES.S;
    for (const [openFeeAmount, issuanceOwnerCommitment] of [[0n, 0n], [0n, BigInt(p.issuanceOwnerCommitment)], [1n, 0n], [1n, BigInt(p.issuanceOwnerCommitment)]] as const) {
      const publicInputs = [...base];
      publicInputs[offsets.openFeeAmount] = openFeeAmount;
      publicInputs[offsets.issuanceOwner] = issuanceOwnerCommitment;
      const entry = encodePrivateValueTransaction({ publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData, arena });
      const decoded = decodeTransaction(entry);
      if (decoded.kind !== 0) throw new Error("wrong decoded kind");
      expect(decoded.serializedPublicInputs).toHaveLength(16);
      expect(privateValuePublicInputs(decoded)).toEqual(publicInputs);
    }
  });
  it("requires fixed sizes and accepts opaque output-data contents", () => {
    const items = Array.from({ length: 5 }, () => sizeClassFiller());
    items[0]![0] = 2; items[4] = new Uint8Array(1212);
    expect(() => assertOutputDataItems(items)).toThrow(/outputData\[4\].*1213/);
    items[4] = sizeClassFiller();
    items[1]![0] = 0;
    items[2]![0] = 255;
    expect(() => assertOutputDataItems(items)).not.toThrow();
  });
});

function sectionInputs(shape: "S" | "L", openFeeAmount: bigint, issuanceOwnerCommitment: bigint, nullifiers?: readonly bigint[]) {
  const profile = PRIVATE_VALUE_PROFILES[shape];
  const outputData = Array.from({ length: profile.outputs }, () => sizeClassFiller()) as unknown as PrivateValueOutputData;
  const arena = randomArena(profile.shapeId);
  const spent = nullifiers ?? Array.from({ length: profile.inputs }, (_, index) => BigInt(1_000 + index));
  const publicInputs = [
    chainId, 9n, ...spent,
    ...Array.from({ length: profile.outputs }, (_, index) => BigInt(2_000 + index)),
    deliveryCommitment(outputData, arena), openFeeAmount, issuanceOwnerCommitment, 0n, 12n, 0n, 0n,
  ];
  return { shape: profile.shapeId, publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData, arena, nullifiers: spent };
}

function privateValueEntry(shape: "S" | "L", openFeeAmount: bigint, issuanceOwnerCommitment: bigint, nullifiers?: readonly bigint[]): Uint8Array {
  const { nullifiers: _nullifiers, ...section } = sectionInputs(shape, openFeeAmount, issuanceOwnerCommitment, nullifiers);
  return encodePrivateValueTransaction(section);
}

function accountUpdateEntry(openFeeAmount: bigint, issuanceOwnerCommitment: bigint, nullifiers?: readonly bigint[]): Uint8Array {
  const { nullifiers: _nullifiers, shape: _shape, ...section } = sectionInputs("S", openFeeAmount, issuanceOwnerCommitment, nullifiers);
  return encodeUserAccountUpdate({
    pcashChainId: chainId,
    proposedAccountFields: { address: 1n, newRuleSetCommitment: 1n, receiveKey: { operation: "keep" } },
    accountUpdateCommitment: 1n,
    section: { ...section, proof: new Uint8Array(WIRE_PROOF_BYTES) },
  });
}

function contractEntry(openFeeAmount: bigint, issuanceOwnerCommitment: bigint): Uint8Array {
  const { nullifiers: _nullifiers, shape: _shape, ...section } = sectionInputs("S", openFeeAmount, issuanceOwnerCommitment);
  // publishesNkRoot ‖ material ‖ receive-key mode ‖ function count.
  return encodeContractAccountCreation(chainId, new Uint8Array(1 + 32 + 1 + 1), { mode: "sponsored", section: { ...section, proof: new Uint8Array(WIRE_PROOF_BYTES) } });
}

function unfundedContractEntry(): Uint8Array {
  return encodeContractAccountCreation(chainId, new Uint8Array(1 + 32 + 1 + 1), { mode: "unfunded", recentPcashBlockHash: 1n, validUntilTimestamp: 2n });
}

function userCreationEntry(): Uint8Array {
  return encodeUserAccountCreation(chainId, new Uint8Array(1 + 32 + 32 + 1 + 32 + 8));
}

describe("seed-only issuance recovery", () => {
  const recovery = { owner: BigInt(p.owner), seed: payoutSeed(p.nkRoot) };
  const largeNullifiers = Array.from({ length: PRIVATE_VALUE_PROFILES.L.inputs }, (_, index) => BigInt(50 + index));

  it("maps each payout kind to its derivation role", () => {
    expect(payoutRoleForSourceKind("designatedIssuance")).toBe(PayoutRole.ISSUANCE);
    expect(payoutRoleForSourceKind("posterPayout")).toBe(PayoutRole.POSTER);
  });

  it.each([
    ["S", p.nullifiers.map(BigInt), PRIVATE_VALUE_PROFILES.S.shapeId],
    ["L", largeNullifiers, PRIVATE_VALUE_PROFILES.L.shapeId],
  ] as const)("recovers a designated %s payout from its transaction context", (_label, nullifiers, shape) => {
    const opening = issuancePayoutOpening(p.owner, p.nkRoot, chainId, nullifiers, shape);
    expect(recoverPayoutOpening(recovery, {
      sourceKind: "designatedIssuance", ownerCommitment: opening.ownerCommitment, contexts: [opening.context],
    })).toEqual({ owner: recovery.owner, noteSecret: opening.noteSecret });
  });

  it("recovers a poster payout whose first context is a copied unrelated one", () => {
    const own = posterPayoutOpening(p.owner, p.nkRoot, 77n);
    const foreign = 76n;
    const zeroFeeIssuanceBatch = 78n;
    expect(recoverPayoutOpening(recovery, {
      sourceKind: "posterPayout", ownerCommitment: own.ownerCommitment, contexts: [foreign, zeroFeeIssuanceBatch, own.context],
    })).toEqual({ owner: recovery.owner, noteSecret: own.noteSecret });
  });

  it("returns null for the wrong kind or a foreign owner", () => {
    const designated = issuancePayoutOpening(p.owner, p.nkRoot, chainId, p.nullifiers);
    expect(recoverPayoutOpening(recovery, {
      sourceKind: "posterPayout", ownerCommitment: designated.ownerCommitment, contexts: [designated.context],
    })).toBeNull();
    expect(recoverPayoutOpening({ ...recovery, owner: recovery.owner + 1n }, {
      sourceKind: "designatedIssuance", ownerCommitment: designated.ownerCommitment, contexts: [designated.context],
    })).toBeNull();
  });
});

describe("controlled issuance openings", () => {
  const recipient = { address: BigInt(p.owner), nkRoot: BigInt(p.nkRoot) };
  const largeNullifiers = Array.from({ length: PRIVATE_VALUE_PROFILES.L.inputs }, (_, index) => BigInt(50 + index));

  it.each([
    ["S", PRIVATE_VALUE_PROFILES.S.shapeId, p.nullifiers.map(BigInt)],
    ["L", PRIVATE_VALUE_PROFILES.L.shapeId, largeNullifiers],
  ] as const)("recognizes a %s action designated to this recipient", (shape, shapeId, nullifiers) => {
    const opening = issuancePayoutOpening(recipient.address, recipient.nkRoot, chainId, nullifiers, shapeId);
    expect(controlledIssuanceOpening(privateValueEntry(shape, 5n, opening.ownerCommitment, nullifiers), chainId, recipient)).toEqual(opening);
  });

  it("rejects designated account-operation fee sections", () => {
    expect(() => accountUpdateEntry(0n, 1n)).toThrow("cannot designate issuance");
    expect(() => contractEntry(0n, 1n)).toThrow("cannot designate issuance");
  });

  it("returns null for open routes, other destinations, and entries without a section", () => {
    expect(controlledIssuanceOpening(privateValueEntry("S", 5n, 0n), chainId, recipient)).toBeNull();
    expect(controlledIssuanceOpening(privateValueEntry("S", 5n, BigInt(p.issuanceOwnerCommitment) + 1n), chainId, recipient)).toBeNull();
    expect(controlledIssuanceOpening(userCreationEntry(), chainId, recipient)).toBeNull();
  });
});

describe("unpaid mempool entries", () => {
  const designated = BigInt(p.issuanceOwnerCommitment);
  it.each([
    ["zero-fee open type 0x00", () => privateValueEntry("S", 0n, 0n), false],
    ["zero-fee open L type 0x00", () => privateValueEntry("L", 0n, 0n), false],
    ["positive-fee open type 0x00", () => privateValueEntry("S", 1n, 0n), false],
    ["zero-fee designated type 0x00", () => privateValueEntry("S", 0n, designated), false],
    ["zero-fee designated L type 0x00", () => privateValueEntry("L", 0n, designated), false],
    ["positive-fee designated type 0x00", () => privateValueEntry("S", 1n, designated), false],
    ["zero-fee open account update", () => accountUpdateEntry(0n, 0n), true],
    ["positive-fee open account update", () => accountUpdateEntry(1n, 0n), false],
    ["zero-fee open contract creation", () => contractEntry(0n, 0n), true],
    ["unfunded contract creation", () => unfundedContractEntry(), true],
    ["user account creation", userCreationEntry, true],
  ] as const)("classifies %s", (_label, entry, unpaid) => {
    expect(isUnpaidTransaction(entry())).toBe(unpaid);
  });
});
