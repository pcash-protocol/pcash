// Wire codec (batch calldata, txBytes): encode -> decode must be an
// exact round-trip, and batch framing must reject malformed calldata.

import { describe, expect, it } from "vitest";
import { beBytes, bytesEqual, concatBytes } from "../src/utils/bytes.ts";
import {
  privateValueTransactionSize,
  contractAccountCreationSize,
  contractFundingBytes,
  privateValueSectionBytes,
  userAccountUpdateSize,
  WIRE_PROOF_BYTES,
  MAX_BATCH_ENTRIES,
  MAX_TX_BYTES,
  PRIVATE_VALUE_PUBLIC_INPUTS,
  PRIVATE_VALUE_WIRE_PUBLIC_INPUTS,
  PRIVATE_VALUE_MAX_TX_BYTES,
  VERSION,
  decodeBatch,
  decodeBatchForVersion,
  decodeBatchVersioned,
  decodeTransaction,
  decodeTransactionForChain,
  encodeBatch as encodeBatchWithPoster,
  encodeBatchForVersion as encodeBatchWithPosterForVersion,
  type PrivateValueOutputData,
  type PrivateValueSectionInput,
  contractCreationPublicInputs,
  encodeContractAccountCreation,
  encodeUserAccountUpdate,
  transactionOpenFee,
  encodePrivateValueTransaction,
  encodeUserAccountCreation,
  privateValuePublicInputs,
  sectionPublicInput,
  userAccountUpdatePublicInputs,
  type RawPrivateValueSection,
  type UserAccountReceiveKeyUpdate,
} from "../src/protocol/codec.ts";
import { OUTPUT_DATA_BYTES } from "../src/constants/params.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { deliveryCommitment } from "../src/protocol/transfer.ts";

const { S, L } = PRIVATE_VALUE_PROFILES;
const bytes = (n: number, seed = 1): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 0xff);
const data = (seed = 1): Uint8Array => {
  const item = bytes(OUTPUT_DATA_BYTES, seed); item[0] = 1; return item;
};
const ARENA = bytes(S.arenaBytes, 13);
const encodeBatch = encodeBatchWithPoster;
const encodeBatchForVersion = encodeBatchWithPosterForVersion;
const CHAIN_ID = 0x50435348n;

// mode ‖ nullifierKeyCommitment ‖ ruleSetCommitment ‖ receive key ‖
// recentPcashBlockHash ‖ validUntilTimestamp ‖ signature when signed.
function userCreationBody(receiveKey: Uint8Array = new Uint8Array(), mode = 1): Uint8Array {
  return concatBytes(
    Uint8Array.of(mode),
    bytes(32, 3),
    bytes(32, 4),
    Uint8Array.of(receiveKey.length === 0 ? 0 : 1),
    receiveKey,
    bytes(32, 5),
    beBytes(123n, 8),
    ...(mode === 1 ? [bytes(32, 6), bytes(32, 7), Uint8Array.of(1)] : []),
  );
}

// publishesNkRoot ‖ nullifierKeyMaterial ‖ receive key ‖ functionCount.
function contractBody(receiveKey: Uint8Array = new Uint8Array()): Uint8Array {
  return concatBytes(
    Uint8Array.of(0),
    bytes(32, 8),
    Uint8Array.of(receiveKey.length === 0 ? 0 : 1),
    receiveKey,
    Uint8Array.of(0),
  );
}

const transferPubs = Array.from({ length: PRIVATE_VALUE_PUBLIC_INPUTS }, (_, i) => BigInt(i + 1) * 0x0123456789abcdefn);

function privateValueInputs(outputData: readonly Uint8Array[], arena = ARENA): bigint[] {
  const inputs = [...transferPubs];
  inputs[S.offsets.chainId] = CHAIN_ID;
  inputs[S.offsets.deliveryCommitment] = deliveryCommitment(outputData, arena);
  return inputs;
}

const CONTRACT_FEE_OUTPUT_DATA = [data(3), data(), data(7), data(9), data(11)] as const;

function contractFee(proofByte = 4) {
  return {
    publicInputs: privateValueInputs(CONTRACT_FEE_OUTPUT_DATA).map((value, i) => i === S.offsets.issuanceOwner ? 0n : value),
    proof: bytes(WIRE_PROOF_BYTES, proofByte),
    outputData: CONTRACT_FEE_OUTPUT_DATA,
    arena: ARENA,
  };
}

function sponsored(section: PrivateValueSectionInput = contractFee()) {
  return { mode: "sponsored", section } as const;
}

/** envelope(5) ‖ fundingMode(1) ‖ the sponsor's section, then the body. */
const SPONSORED_BODY_OFFSET = 6 + privateValueSectionBytes(WIRE_PROOF_BYTES, { kind: "contractAccountCreation" });

const KEEP: UserAccountReceiveKeyUpdate = { operation: "keep" };

function updateEntry(receiveKey: UserAccountReceiveKeyUpdate = KEEP): Uint8Array {
  return encodeUserAccountUpdate({
    pcashChainId: CHAIN_ID,
    proposedAccountFields: { address: 0x1234n, newRuleSetCommitment: 5n, receiveKey },
    accountUpdateCommitment: 1n,
    section: { ...contractFee(), proof: bytes(WIRE_PROOF_BYTES, 9) },
  });
}

function largePrivateValueEntry(): Uint8Array {
  const outputData = Array.from({ length: L.outputs }, (_, slot) => data(slot + 1));
  const arena = bytes(L.arenaBytes, 17);
  const publicInputs = Array.from({ length: L.publicInputs }, (_, i) => BigInt(i + 1));
  publicInputs[L.offsets.chainId] = CHAIN_ID;
  publicInputs[L.offsets.deliveryCommitment] = deliveryCommitment(outputData, arena);
  return encodePrivateValueTransaction({ shape: L.shapeId, publicInputs, proof: bytes(WIRE_PROOF_BYTES, 3), outputData, arena });
}

describe("txBytes entry round-trips", () => {
  it("privateValue entry (kind 0) with five outputData", () => {
    const proof = bytes(WIRE_PROOF_BYTES, 2);
    const data0 = data(3);
    const data1 = data(1);
    const data2 = data(7);
    const data3 = data(9);
    const data4 = data(11);
    const outputData = [data0, data1, data2, data3, data4] as const;
    const publicInputs = privateValueInputs(outputData);
    const entry = encodePrivateValueTransaction({ publicInputs, proof, outputData, arena: ARENA });
    const d = decodeTransaction(entry);
    expect(d.kind).toBe(0);
    if (d.kind !== 0) throw new Error("type");
    expect(privateValuePublicInputs(d)).toEqual(publicInputs);
    expect(bytesEqual(d.proof, proof)).toBe(true);
    expect(d.outputData).toEqual([data0, data1, data2, data3, data4]);
    expect(d.arena).toEqual(ARENA);
    // envelope(5) ‖ shape(1) ‖ 16 words ‖ proof ‖ 5 output-data items ‖ arena, with no length prefixes.
    expect(entry).toHaveLength(6 + 16 * 32 + 22_432 + 5 * OUTPUT_DATA_BYTES + S.arenaBytes);
    expect(bytesEqual(entry.subarray(6 + 16 * 32, 6 + 16 * 32 + WIRE_PROOF_BYTES), proof)).toBe(true);
    const arenaStart = entry.length - S.arenaBytes;
    expect(bytesEqual(entry.subarray(arenaStart - OUTPUT_DATA_BYTES, arenaStart), data4)).toBe(true);
    expect(bytesEqual(entry.subarray(arenaStart), ARENA)).toBe(true);
  });

  it("carries a nonzero carrierContextHash in the word after validUntilTimestamp in every section layout", () => {
    const VALID_UNTIL = 0x0102030405060708n;
    const CARRIER_CONTEXT = 0x2c0ffee000000000000000000000000000000000000000000000000000000ccn;
    const EVENTS = 0x0e0e0en;
    const bound = (publicInputs: readonly bigint[], profile: typeof S | typeof L = S) => {
      const edited = [...publicInputs];
      edited[profile.offsets.validUntil] = VALID_UNTIL;
      edited[profile.offsets.carrierContextHash] = CARRIER_CONTEXT;
      edited[profile.offsets.eventsCommitment] = EVENTS;
      return edited;
    };
    // The time bounds, the carrier context, and the events commitment are the last three words.
    const expectTail = (section: RawPrivateValueSection, profile: typeof S | typeof L = S) => {
      expect(sectionPublicInput(section, profile.offsets.carrierContextHash)).toBe(CARRIER_CONTEXT);
      expect(section.serializedPublicInputs.slice(-3)).toEqual([VALID_UNTIL, CARRIER_CONTEXT, EVENTS].map((value) => beBytes(value, 32)));
    };

    const smallOutputData = [data(3), data(1), data(7), data(9), data(11)] as const;
    const small = bound(privateValueInputs(smallOutputData));
    const smallEntry = decodeTransaction(encodePrivateValueTransaction({ publicInputs: small, proof: bytes(WIRE_PROOF_BYTES), outputData: smallOutputData, arena: ARENA }));
    if (smallEntry.kind !== 0) throw new Error("type");
    expectTail(smallEntry);
    expect(privateValuePublicInputs(smallEntry)).toEqual(small);

    const largeOutputData = Array.from({ length: L.outputs }, (_, slot) => data(slot + 1));
    const largeArena = bytes(L.arenaBytes, 17);
    const large = Array.from({ length: L.publicInputs }, (_, i) => BigInt(i + 1));
    large[L.offsets.chainId] = CHAIN_ID;
    large[L.offsets.deliveryCommitment] = deliveryCommitment(largeOutputData, largeArena);
    const largeInputs = bound(large, L);
    const largeEntry = decodeTransaction(encodePrivateValueTransaction({ shape: L.shapeId, publicInputs: largeInputs, proof: bytes(WIRE_PROOF_BYTES, 3), outputData: largeOutputData, arena: largeArena }));
    if (largeEntry.kind !== 0) throw new Error("type");
    expectTail(largeEntry, L);
    expect(privateValuePublicInputs(largeEntry)).toEqual(largeInputs);

    const fee = { ...contractFee(), publicInputs: bound(contractFee().publicInputs) };
    const update = decodeTransaction(encodeUserAccountUpdate({
      pcashChainId: CHAIN_ID,
      proposedAccountFields: { address: 0x1234n, newRuleSetCommitment: 5n, receiveKey: KEEP },
      accountUpdateCommitment: 1n,
      section: fee,
    }));
    if (update.kind !== 3) throw new Error("type");
    expectTail(update.section);
    expect(userAccountUpdatePublicInputs(update)).toEqual([...fee.publicInputs, 1n]);

    const creation = decodeTransaction(encodeContractAccountCreation(CHAIN_ID, contractBody(), sponsored(fee)));
    if (creation.kind !== 2 || creation.funding.mode !== "sponsored") throw new Error("type");
    expectTail(creation.funding.section);
    expect(contractCreationPublicInputs(creation, 0x99n)).toEqual([...fee.publicInputs, 0x99n]);
  });

  it("reconstructs the delivery commitment from every output-data item and the arena", () => {
    const outputData = [data(3), data(1), data(7), data(9), data(11)] as const;
    const entry = encodePrivateValueTransaction({ publicInputs: privateValueInputs(outputData), proof: bytes(WIRE_PROOF_BYTES), outputData, arena: ARENA });
    const statement = (bytesOf: Uint8Array) => {
      const d = decodeTransaction(bytesOf);
      if (d.kind !== 0) throw new Error("type");
      return privateValuePublicInputs(d);
    };
    const base = statement(entry);
    expect(base[S.offsets.deliveryCommitment]).toBe(deliveryCommitment(outputData, ARENA));
    for (const offset of [entry.length - S.arenaBytes - 1, entry.length - S.arenaBytes, entry.length - 1]) {
      const edited = Uint8Array.from(entry);
      edited[offset]! ^= 1;
      const changed = statement(edited);
      expect(changed[S.offsets.deliveryCommitment]).not.toBe(base[S.offsets.deliveryCommitment]);
      expect(changed.filter((_, index) => index !== S.offsets.deliveryCommitment))
        .toEqual(base.filter((_, index) => index !== S.offsets.deliveryCommitment));
    }
  });

  it("rejects a serialized public input that is not a canonical field element", () => {
    const proof = bytes(WIRE_PROOF_BYTES, 2);
    const outputData = [data(3), data(), data(7), data(9), data(11)] as const;
    const entry = encodePrivateValueTransaction({
      publicInputs: privateValueInputs(outputData),
      proof,
      outputData,
      arena: ARENA,
    });
    // Overwrite the first payload public input (offset 6..38) with 0xff*32:
    // a big-endian integer >= p that the writer would never emit.
    const tampered = Uint8Array.from(entry);
    tampered.fill(0xff, 6, 38);
    const raw = decodeTransaction(tampered);
    expect(raw.kind).toBe(0);
    if (raw.kind !== 0) throw new Error("type");
    expect(raw.serializedPublicInputs[0]).toEqual(new Uint8Array(32).fill(0xff));
    expect(() => privateValuePublicInputs(raw)).toThrow(/public input 1/);
  });

  it("user-account entry (kind 1) is the raw body", () => {
    const body = userCreationBody();
    const entry = encodeUserAccountCreation(CHAIN_ID, body);
    const d = decodeTransaction(entry);
    expect(d.kind).toBe(1);
    if (d.kind !== 1) throw new Error("type");
    expect(bytesEqual(d.body, body)).toBe(true);
  });

  it("decodes direct creation without signature bytes and signed creation with them", () => {
    for (const key of [new Uint8Array(), bytes(1184, 9)]) {
      const direct = encodeUserAccountCreation(CHAIN_ID, userCreationBody(key, 0));
      const signed = encodeUserAccountCreation(CHAIN_ID, userCreationBody(key, 1));
      expect(direct[5]).toBe(0);
      expect(signed[5]).toBe(1);
      // envelope ‖ mode ‖ two words ‖ receive-key mode ‖ key ‖ recent block ‖ deadline.
      expect(direct).toHaveLength(5 + 1 + 64 + 1 + key.length + 32 + 8);
      expect(signed.length - direct.length).toBe(65);
      expect(signed[5 + 1 + 64]).toBe(key.length === 0 ? 0 : 1);
      const mlKemPublicKey = key.length === 0 ? null : key;
      expect(decodeTransaction(direct)).toMatchObject({ kind: 1, authorization: { kind: "direct" }, mlKemPublicKey });
      expect(decodeTransaction(signed)).toMatchObject({ kind: 1, authorization: { kind: "signed", yParity: 1 }, mlKemPublicKey });
      expect(decodeTransaction(signed)).not.toHaveProperty("address");
      expect(() => decodeTransaction(concatBytes(direct, new Uint8Array(65)))).toThrow(/trailing bytes/);
      expect(() => decodeTransaction(signed.slice(0, -1))).toThrow(/unexpected end/);
    }
  });

  it("rejects unknown authorization modes structurally", () => {
    for (const mode of [2, 7, 255]) {
      expect(() => decodeTransaction(encodeUserAccountCreation(CHAIN_ID, userCreationBody(new Uint8Array(), mode))))
        .toThrow(/unknown user account creation authorization mode/);
    }
  });

  it("sponsored contract entry carries the funding mode at byte 5, then the section, then the raw body", () => {
    const body = contractBody();
    const fee = contractFee();
    const entry = encodeContractAccountCreation(CHAIN_ID, body, sponsored(fee));
    expect(entry[0]).toBe(2);
    expect(entry[5]).toBe(1);
    expect(entry).toHaveLength(SPONSORED_BODY_OFFSET + body.length);
    expect(bytesEqual(entry.subarray(SPONSORED_BODY_OFFSET), body)).toBe(true);
    expect(bytesEqual(entry.subarray(6 + 15 * 32, 6 + 15 * 32 + WIRE_PROOF_BYTES), fee.proof)).toBe(true);
    const d = decodeTransaction(entry);
    expect(d.kind).toBe(2);
    if (d.kind !== 2 || d.funding.mode !== "sponsored") throw new Error("type");
    expect(bytesEqual(d.body, body)).toBe(true);
    expect(d.funding.section.serializedPublicInputs).toHaveLength(15);
    expect(bytesEqual(d.funding.section.proof, fee.proof)).toBe(true);
    const publicInputs = contractCreationPublicInputs(d, 0x1234n);
    expect(publicInputs).toHaveLength(S.publicInputs + 1);
    expect(publicInputs[S.publicInputs]).toBe(0x1234n);
    expect(publicInputs).toEqual([...fee.publicInputs, 0x1234n]);
    expect(() => decodeTransaction(concatBytes(entry, new Uint8Array(1)))).toThrow(/trailing bytes/);
    expect(() => encodeContractAccountCreation(CHAIN_ID, body, sponsored({
      ...fee,
      publicInputs: [CHAIN_ID + 1n, ...fee.publicInputs.slice(1)],
    }))).toThrow(/chain id does not match/);
  });

  it("encodes both funding modes over the same body at fixed body offsets", () => {
    const body = contractBody(bytes(1184));
    const unfunded = encodeContractAccountCreation(CHAIN_ID, body, { mode: "unfunded", recentPcashBlockHash: 0x66n, validUntilTimestamp: 0x0102030405060708n });
    const funded = encodeContractAccountCreation(CHAIN_ID, body, sponsored());
    expect(unfunded[5]).toBe(0);
    expect(bytesEqual(unfunded.subarray(6, 38), beBytes(0x66n, 32))).toBe(true);
    expect(bytesEqual(unfunded.subarray(38, 46), beBytes(0x0102030405060708n, 8))).toBe(true);
    expect(bytesEqual(unfunded.subarray(46), body)).toBe(true);
    expect(bytesEqual(funded.subarray(SPONSORED_BODY_OFFSET), body)).toBe(true);
    const [a, b] = [decodeTransaction(unfunded), decodeTransaction(funded)];
    if (a.kind !== 2 || b.kind !== 2) throw new Error("type");
    expect(a.body).toEqual(b.body);
    expect(a.functions).toEqual(b.functions);
    expect(a.mlKemPublicKey).toEqual(b.mlKemPublicKey);
    expect(() => contractCreationPublicInputs(a, 0x1234n)).toThrow(/unfunded/);
  });

  it("rejects funding modes outside {unfunded, sponsored} structurally", () => {
    for (const funding of [{ mode: "unfunded", recentPcashBlockHash: 1n, validUntilTimestamp: 2n } as const, sponsored()]) {
      const entry = encodeContractAccountCreation(CHAIN_ID, contractBody(), funding);
      for (const mode of [2, 9, 255]) {
        const edited = Uint8Array.from(entry);
        edited[5] = mode;
        expect(() => decodeTransaction(edited)).toThrow(new RegExp(`unknown contract creation funding mode ${mode}`));
      }
    }
    expect(() => decodeTransaction(Uint8Array.of(2, 0x50, 0x43, 0x53, 0x48))).toThrow(/unexpected end/);
  });

  it("carries a zero-fee creation with fixed-size dummy output data", () => {
    const outputData = [data(), data(), data(), data(), data()] as const;
    const publicInputs = privateValueInputs(outputData);
    publicInputs[S.offsets.openFeeAmount] = 0n;
    publicInputs[S.offsets.issuanceOwner] = 0n;
    const entry = encodeContractAccountCreation(CHAIN_ID, contractBody(), sponsored({
      publicInputs,
      proof: bytes(WIRE_PROOF_BYTES, 5),
      outputData,
      arena: ARENA,
    }));
    const d = decodeTransaction(entry);
    if (d.kind !== 2 || d.funding.mode !== "sponsored") throw new Error("type");
    expect(contractCreationPublicInputs(d, 0x99n)[S.offsets.openFeeAmount]).toBe(0n);
    expect(d.funding.section.outputData).toEqual(outputData);
  });

  it("rejects a sponsored contract creation cut short in its body or section", () => {
    const entry = encodeContractAccountCreation(CHAIN_ID, contractBody(), sponsored());
    for (const cut of [1, 40, 300]) {
      expect(() => decodeTransaction(entry.subarray(0, entry.length - cut))).toThrow(/unexpected end/);
    }
  });

  it("rejects selector bytes outside their sets structurally", () => {
    const creation = userCreationBody();
    for (const mode of [2, 9, 255]) {
      const edited = Uint8Array.from(creation);
      edited[1 + 64] = mode;
      expect(() => decodeTransaction(encodeUserAccountCreation(CHAIN_ID, edited))).toThrow(/receive-key mode/);
    }
    for (const yParity of [2, 27, 255]) {
      const edited = Uint8Array.from(creation);
      edited[edited.length - 1] = yParity;
      expect(() => decodeTransaction(encodeUserAccountCreation(CHAIN_ID, edited))).toThrow(/yParity/);
    }

    const contract = encodeContractAccountCreation(CHAIN_ID, contractBody(), sponsored());
    const nkRootFlag = Uint8Array.from(contract);
    nkRootFlag[SPONSORED_BODY_OFFSET] = 2;
    expect(() => decodeTransaction(nkRootFlag)).toThrow(/publishesNkRoot/);
    const contractKeyMode = Uint8Array.from(contract);
    contractKeyMode[SPONSORED_BODY_OFFSET + 1 + 32] = 2;
    expect(() => decodeTransaction(contractKeyMode)).toThrow(/receive-key mode/);

    const update = Uint8Array.from(updateEntry());
    expect(update[5 + 20 + 32]).toBe(0);
    update[5 + 20 + 32] = 3;
    expect(() => decodeTransaction(update)).toThrow(/receive-key operation/);
  });

  it("checks the envelope chain ID independently of semantic decoding", () => {
    const entry = encodeUserAccountCreation(CHAIN_ID, userCreationBody());
    expect(decodeTransactionForChain(entry, CHAIN_ID).pcashChainId).toBe(Number(CHAIN_ID));
    expect(() => decodeTransactionForChain(entry, CHAIN_ID + 1n)).toThrow(/wrong PCASH chain ID/);
  });

  it("rejects wrong public-input counts", () => {
    expect(() => encodePrivateValueTransaction({ publicInputs: transferPubs.slice(1), proof: bytes(WIRE_PROOF_BYTES), outputData: [data(), data(), data(), data(), data()], arena: ARENA })).toThrow();
  });

  it("requires exact output-data arity and the fixed delivery shape", () => {
    const privateValueOutputData = [data(), data(), data(), data(), data()] as const;
    const privateValuePublicInputs = privateValueInputs(privateValueOutputData);
    for (const wrongLength of [[], [bytes(0)], [...privateValueOutputData, bytes(0)]]) {
      expect(() => encodePrivateValueTransaction({
        publicInputs: privateValuePublicInputs,
        proof: bytes(WIRE_PROOF_BYTES),
        outputData: wrongLength as unknown as PrivateValueOutputData,
        arena: ARENA,
      })).toThrow(/requires 5 outputData items/);
    }
  });

  it("refuses caller buffers that would misframe the following fields", () => {
    const outputData = [data(), data(), data(), data(), data()] as const;
    const publicInputs = privateValueInputs(outputData);
    for (const size of [OUTPUT_DATA_BYTES - 1, OUTPUT_DATA_BYTES + 1]) {
      expect(() => encodePrivateValueTransaction({
        publicInputs, proof: bytes(WIRE_PROOF_BYTES), outputData: [bytes(size), data(), data(), data(), data()], arena: ARENA,
      })).toThrow(new RegExp(`exactly ${OUTPUT_DATA_BYTES} bytes`));
    }
    for (const size of [0, S.arenaBytes - 1, S.arenaBytes + 1, L.arenaBytes]) {
      expect(() => encodePrivateValueTransaction({ publicInputs, proof: bytes(WIRE_PROOF_BYTES), outputData, arena: bytes(size) }))
        .toThrow(new RegExp(`arena must have exactly ${S.arenaBytes} bytes`));
    }
    for (const size of [0, WIRE_PROOF_BYTES - 1, WIRE_PROOF_BYTES + 1]) {
      expect(() => encodePrivateValueTransaction({ publicInputs, proof: bytes(size), outputData, arena: ARENA }))
        .toThrow(new RegExp(`proof must be ${WIRE_PROOF_BYTES} bytes`));
    }
    expect(() => encodeContractAccountCreation(CHAIN_ID, contractBody(), sponsored({ ...contractFee(), arena: bytes(S.arenaBytes - 1) })))
      .toThrow(/arena must have exactly/);
    expect(() => encodeContractAccountCreation(CHAIN_ID, contractBody(), sponsored({ ...contractFee(), proof: bytes(WIRE_PROOF_BYTES - 1) })))
      .toThrow(new RegExp(`proof must be ${WIRE_PROOF_BYTES} bytes`));
    expect(() => encodeUserAccountUpdate({
      pcashChainId: CHAIN_ID,
      proposedAccountFields: { address: 1n, newRuleSetCommitment: 1n, receiveKey: KEEP },
      accountUpdateCommitment: 1n,
      section: { ...contractFee(), proof: bytes(WIRE_PROOF_BYTES - 1) },
    })).toThrow(new RegExp(`proof must be ${WIRE_PROOF_BYTES} bytes`));
    expect(() => updateEntry({ operation: "replace", mlKemPublicKey: bytes(1183) })).toThrow(/1184 bytes/);
  });

  it("rejects entries above the consensus wire limits", () => {
    expect(() => encodeUserAccountCreation(CHAIN_ID, bytes(MAX_TX_BYTES))).toThrow(/MAX_TX_BYTES/);
    expect(() => encodeBatch([bytes(MAX_TX_BYTES + 1)], 1n, 0n)).toThrow(/MAX_TX_BYTES/);
  });

  it("reads each section layout's pinned proof size and fails structurally on any other total length", () => {
    const layouts = [
      { name: "private value S", entry: encodePrivateValueTransaction({ ...contractFee(), proof: bytes(WIRE_PROOF_BYTES, 2) }), proofBytes: 22_432, outputs: 5, arenaBytes: S.arenaBytes },
      { name: "private value L", entry: largePrivateValueEntry(), proofBytes: 22_432, outputs: 32, arenaBytes: L.arenaBytes },
      { name: "account update", entry: updateEntry(), proofBytes: 22_432, outputs: 5, arenaBytes: S.arenaBytes },
      { name: "contract creation", entry: encodeContractAccountCreation(CHAIN_ID, contractBody(), sponsored()), proofBytes: 22_432, outputs: 5, arenaBytes: S.arenaBytes },
    ];
    for (const { name, entry, proofBytes, outputs, arenaBytes } of layouts) {
      const decoded = decodeTransaction(entry);
      const section = decoded.kind === 0 ? decoded
        : decoded.kind === 2 && decoded.funding.mode === "sponsored" ? decoded.funding.section
          : decoded.kind === 3 ? decoded.section : null;
      if (section === null) throw new Error(name);
      expect(section.proof, name).toHaveLength(proofBytes);
      expect(section.outputData, name).toHaveLength(outputs);
      expect(section.outputData.every((item) => item.length === OUTPUT_DATA_BYTES), name).toBe(true);
      expect(section.arena, name).toHaveLength(arenaBytes);
      expect(() => decodeTransaction(entry.subarray(0, entry.length - 1)), name).toThrow(/unexpected end/);
      expect(() => decodeTransaction(concatBytes(entry, Uint8Array.of(0))), name).toThrow(/trailing bytes/);
    }
  });

  it("accepts the type-0 per-output data maximum and matches the derived size bound", () => {
    const outputData = [
      data(),
      data(),
      data(),
      data(),
      data(),
    ] as const;
    const entry = encodePrivateValueTransaction({
      publicInputs: privateValueInputs(outputData),
      proof: bytes(WIRE_PROOF_BYTES),
      outputData,
      arena: ARENA,
    });
    expect(entry.length).toBe(privateValueTransactionSize());
    expect(entry.length).toBeLessThanOrEqual(PRIVATE_VALUE_MAX_TX_BYTES);
    expect(PRIVATE_VALUE_WIRE_PUBLIC_INPUTS).toBe(16);
    expect(entry.length).toBeLessThanOrEqual(MAX_TX_BYTES);
    expect(decodeTransaction(entry).kind).toBe(0);
  });

  it("rejects a type byte outside the defined transaction types", () => {
    const outputData = [data(), data(), data(), data(), data()] as const;
    const entry = encodePrivateValueTransaction({
      publicInputs: privateValueInputs(outputData),
      proof: bytes(WIRE_PROOF_BYTES),
      outputData,
      arena: ARENA,
    });
    expect(decodeTransaction(entry).kind).toBe(0);
    const unknown = Uint8Array.from(entry);
    for (const type of [4, 5, 255]) {
      unknown[0] = type;
      expect(() => decodeTransaction(unknown)).toThrow(new RegExp(`unknown transaction kind ${type}`));
    }
  });
});

describe("batch calldata round-trips", () => {
  const privateValueOutputData = [data(8), data(), data(), data(), data()] as const;
  const e0 = encodePrivateValueTransaction({ publicInputs: privateValueInputs(privateValueOutputData), proof: bytes(WIRE_PROOF_BYTES, 1), outputData: privateValueOutputData, arena: ARENA });
  const e1 = encodeUserAccountCreation(CHAIN_ID, userCreationBody());
  const e2 = encodeContractAccountCreation(CHAIN_ID, contractBody(), sponsored());

  it("uses 16 serialized words while reconstructing the complete 18-field statement", () => {
    expect(PRIVATE_VALUE_WIRE_PUBLIC_INPUTS).toBe(16);
    expect(PRIVATE_VALUE_PUBLIC_INPUTS).toBe(18);
    const privateValue = decodeTransaction(e0);
    expect(privateValue.kind === 0 && privateValuePublicInputs(privateValue)).toHaveLength(18);
  });

  it("VERSION/count framing and exact entry recovery", () => {
    const calldata = encodeBatch([e0, e1, e2], 1n, 0n);
    // header: VERSION(1) poster(32) count(2)
    expect(calldata[0]).toBe(VERSION);
    expect((calldata[65]! << 8) | calldata[66]!).toBe(3);

    const decoded = decodeBatch(calldata);
    expect(decoded.version).toBe(VERSION);
    expect(decoded.items.length).toBe(3);
    for (const [i, e] of [e0, e1, e2].entries()) {
      expect(bytesEqual(decoded.items[i]!, e)).toBe(true);
    }
  });

  it("round-trips the full byte string", () => {
    const calldata = encodeBatch([e0, e1, e2], 1n, 0n);
    const re = encodeBatch(decodeBatch(calldata).items, 1n, 0n);
    expect(bytesEqual(re, calldata)).toBe(true);
  });

  it("keeps the V1 default byte-for-byte identical to explicit version-1 framing", () => {
    expect(bytesEqual(encodeBatch([e0, e1], 1n, 0n), encodeBatchForVersion([e0, e1], VERSION, 1n, 0n))).toBe(true);
    expect(encodeBatch([e0], 1n, 0n)[0]).toBe(VERSION);
  });

  it("mixes transaction types in batch version 1", () => {
    const contractEntry = encodeContractAccountCreation(CHAIN_ID, contractBody(), { mode: "unfunded", recentPcashBlockHash: 1n, validUntilTimestamp: 2n });
    const calldata = encodeBatchForVersion([contractEntry, e1, e2], VERSION, 1n, 0n);
    expect(calldata[0]).toBe(VERSION);

    const decoded = decodeBatchVersioned(calldata);
    expect(decoded.version).toBe(VERSION);
    expect(decoded.items).toHaveLength(3);
    expect(bytesEqual(decoded.items[0]!, contractEntry)).toBe(true);
    expect(
      bytesEqual(
        encodeBatchForVersion(decoded.items, decoded.version, 1n, 0n),
        calldata,
      ),
    ).toBe(true);
    expect(decodeBatchForVersion(calldata, VERSION).version).toBe(VERSION);
    expect(decodeTransaction(decoded.items[0]!).kind).toBe(2);
  });

  it("empty batch", () => {
    const calldata = encodeBatch([], 1n, 0n);
    expect(decodeBatch(calldata).items.length).toBe(0);
  });

  it("accepts the framing bounds and rejects the first value above each bound", () => {
    const maxCountEntries = Array.from({ length: MAX_BATCH_ENTRIES }, () => new Uint8Array());
    expect(
      decodeBatchForVersion(
        encodeBatchForVersion(maxCountEntries, VERSION, 1n, 0n),
        VERSION,
      ).items,
    ).toHaveLength(MAX_BATCH_ENTRIES);
    expect(() =>
      encodeBatchForVersion([...maxCountEntries, new Uint8Array()], VERSION, 1n, 0n),
    ).toThrow(/too many batch items/);

    const maxEntry = bytes(MAX_TX_BYTES, 12);
    const framed = encodeBatchForVersion([maxEntry], VERSION, 1n, 0n);
    expect(decodeBatchForVersion(framed, VERSION).items[0]).toHaveLength(MAX_TX_BYTES);
    expect(() =>
      encodeBatchForVersion([bytes(MAX_TX_BYTES + 1)], VERSION, 1n, 0n),
    ).toThrow(/MAX_TX_BYTES/);
  });

  it("rejects bad version and trailing bytes", () => {
    const good = encodeBatch([e0], 1n, 0n);
    const badVersion = Uint8Array.from(good);
    badVersion[0] = 0x03;
    expect(() => decodeBatchVersioned(badVersion)).toThrow(/unsupported batch version/);

    const trailing = Uint8Array.from([...good, 0xff]);
    expect(() => decodeBatch(trailing)).toThrow(/trailing/);
  });

  it("preserves compact account transaction kinds in mixed-type batches", () => {
    const calldata = encodeBatchForVersion([e1, e2], VERSION, 1n, 0n);
    const decoded = decodeBatchForVersion(calldata, VERSION);
    expect(decodeTransaction(decoded.items[0]!).kind).toBe(1);
    expect(decodeTransaction(decoded.items[1]!).kind).toBe(2);
  });
});

it.each([0n, 7n])("reads the actual %s fee for every proof-bearing transaction kind", (fee) => {
  const section = contractFee();
  section.publicInputs[S.offsets.openFeeAmount] = fee;
  const entries = [
    encodePrivateValueTransaction({ ...section, proof: bytes(WIRE_PROOF_BYTES) }),
    encodeContractAccountCreation(CHAIN_ID, contractBody(), sponsored(section)),
    encodeUserAccountUpdate({
      pcashChainId: CHAIN_ID,
      proposedAccountFields: { address: 1n, newRuleSetCommitment: 1n, receiveKey: KEEP },
      accountUpdateCommitment: 1n,
      section: { ...section, proof: bytes(WIRE_PROOF_BYTES) },
    }),
  ];
  for (const entry of entries) expect(transactionOpenFee(entry)).toBe(fee);
  expect(transactionOpenFee(encodeUserAccountCreation(CHAIN_ID, userCreationBody()))).toBe(0n);
  expect(transactionOpenFee(encodeContractAccountCreation(CHAIN_ID, contractBody(), { mode: "unfunded", recentPcashBlockHash: 1n, validUntilTimestamp: 2n }))).toBe(0n);
});

describe("planned entry sizes", () => {
  const outputData = Array.from({ length: 5 }, (_, index) => data(index)) as unknown as PrivateValueOutputData;
  const publicInputs = privateValueInputs(outputData);
  publicInputs[S.offsets.issuanceOwner] = 0n;

  it("matches the private-value encoder for both profiles", () => {
    const entry = encodePrivateValueTransaction({ publicInputs, outputData, proof: bytes(WIRE_PROOF_BYTES), arena: ARENA });
    expect(privateValueTransactionSize()).toBe(entry.length);
    expect(privateValueTransactionSize(PRIVATE_VALUE_PROFILES.L.shapeId)).toBe(largePrivateValueEntry().length);
  });

  it.each([0, 1184])("matches contract body length with %i receive-key bytes in both funding modes", (keyLength) => {
    const body = contractBody(bytes(keyLength));
    const funded = encodeContractAccountCreation(CHAIN_ID, body, sponsored({
      publicInputs, outputData, proof: bytes(WIRE_PROOF_BYTES), arena: ARENA,
    }));
    expect(contractAccountCreationSize(body.length, "sponsored")).toBe(funded.length);
    const unfunded = encodeContractAccountCreation(CHAIN_ID, body, { mode: "unfunded", recentPcashBlockHash: 1n, validUntilTimestamp: 2n });
    expect(contractAccountCreationSize(body.length, "unfunded")).toBe(unfunded.length);
    expect(contractFundingBytes("unfunded")).toBe(40);
    expect(contractFundingBytes("sponsored")).toBe(15 * 32 + 22_432 + 5 * OUTPUT_DATA_BYTES + S.arenaBytes);
  });

  it.each<UserAccountReceiveKeyUpdate>([
    { operation: "keep" },
    { operation: "clear" },
    { operation: "replace", mlKemPublicKey: bytes(1184) },
  ])("matches the account-update encoder for $operation", (receiveKey) => {
    const entry = updateEntry(receiveKey);
    const keyLength = receiveKey.operation === "replace" ? 1184 : 0;
    expect(userAccountUpdateSize(keyLength)).toBe(entry.length);
    // envelope ‖ address ‖ rule set ‖ operation ‖ key ‖ action ‖ 15 words ‖ proof ‖ 5 output-data items ‖ arena.
    expect(entry.length).toBe(5 + 20 + 32 + 1 + keyLength + 32 + 15 * 32 + 22_432 + 5 * OUTPUT_DATA_BYTES + S.arenaBytes);
    const decoded = decodeTransaction(entry);
    if (decoded.kind !== 3) throw new Error("type");
    expect(decoded.receiveKey).toEqual(receiveKey);
    expect(decoded.proposedAccountFields).toHaveLength(53 + keyLength);
  });
});
