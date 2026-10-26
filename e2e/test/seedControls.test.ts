import { describe, expect, it } from "vitest";
import { ML_KEM_768_PUBLIC_KEY_LENGTH, OUTPUT_DATA_BYTES, PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import {
  buildContractBody,
  accountCreationAttachmentCommitment,
  decodeBatch,
  decodeTransaction,
  encodeBatch,
  encodeContractAccountCreation,
  encodePrivateValueTransaction,
  encodeUserAccountCreation,
  encodeUserAccountUpdate,
  functionSelector,
  MAX_TX_BYTES,
  deliveryCommitment,
  WIRE_PROOF_BYTES,
  DEFAULT_NETWORK_CONFIG,
  privateValueSectionBytes,
  privateValuePublicInputs,
  VERSION,
  userAccountUpdatePublicInputs,
} from "@pcash/sdk/protocol";
import * as controls from "../src/seed/seedControls.ts";

const CHAIN_ID = 1346589512;

function filled(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

/** Offsets where two equal-length entries differ. */
function changedOffsets(before: Uint8Array, after: Uint8Array): number[] {
  expect(after.length).toBe(before.length);
  return [...after].flatMap((byte, index) => byte === before[index] ? [] : [index]);
}

function word(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let index = 31; index >= 0; index -= 1) {
    out[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

const ARENA = filled(PRIVATE_VALUE_PROFILES.S.arenaBytes, 0x5a);
const UPDATE_BYTES = 5 + 20 + 32 + 1 + 1_184 + 32 + 15 * 32 + WIRE_PROOF_BYTES + 5 * OUTPUT_DATA_BYTES + PRIVATE_VALUE_PROFILES.S.arenaBytes;
const EMPTY_OUTPUT_DATA = Array.from({ length: 5 }, () => filled(OUTPUT_DATA_BYTES, 1));

function privateValueTemplate(): Uint8Array {
  const outputData = [1, 2, 3, 4, 5].map((seed) => Uint8Array.from({ length: OUTPUT_DATA_BYTES }, (_, i) => i === 0 ? 1 : seed));
  const publicInputs = [
    BigInt(CHAIN_ID),
    0x1234n,
    11n, 12n, 13n, 14n,
    21n, 22n, 23n, 24n, 25n,
    deliveryCommitment(outputData, ARENA),
    7n, 0n, 0n, 1_900_000_000n, 0n, 123n, 0n,
  ];
  return encodePrivateValueTransaction({ publicInputs, proof: filled(WIRE_PROOF_BYTES, 0xaa), outputData, arena: ARENA });
}

function creationTemplate(): Uint8Array {
  const body = new Uint8Array([
    1,
    ...word(5n),
    ...word(6n),
    1,
    ...filled(ML_KEM_768_PUBLIC_KEY_LENGTH, 0x22),
    ...word(0x1234n),
    0, 0, 0, 0, 0x71, 0x3f, 0xb3, 0x00,
    ...filled(32, 0x33),
    ...filled(32, 0x44),
    1,
  ]);
  return encodeUserAccountCreation(CHAIN_ID, body);
}

function contractTemplate(mlKemPublicKey?: Uint8Array): Uint8Array {
  const build = buildContractBody({
    nullifierKey: { publishesNkRoot: true, nkRoot: 0x99n },
    ...(mlKemPublicKey === undefined ? {} : { mlKemPublicKey }),
    functions: [
      { selector: functionSelector(0), applicationVkHash: 0x1000n, configurationCommitment: 0x2000n },
      { selector: functionSelector(1), applicationVkHash: 0x1001n, configurationCommitment: 0x2001n },
    ],
  });
  const accountCreation = { kind: "contract" as const, body: build.body };
  return encodePrivateValueTransaction({
    publicInputs: [CHAIN_ID, 0x4321n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n,
      deliveryCommitment(EMPTY_OUTPUT_DATA, ARENA), 0n, 0n, 0n, 1_900_000_000n, 0n, 123n,
      accountCreationAttachmentCommitment(accountCreation, CHAIN_ID)],
    proof: filled(WIRE_PROOF_BYTES, 0xcc), outputData: EMPTY_OUTPUT_DATA, arena: ARENA, accountCreation,
  });
}

/** envelope, shape, section, attachment tag, then body. */
const BODY_OFFSET = 7 + privateValueSectionBytes(WIRE_PROOF_BYTES);

function updateTemplate(): Uint8Array {
  return encodeUserAccountUpdate({
    pcashChainId: CHAIN_ID,
    proposedAccountFields: {
      address: BigInt(`0x${"55".repeat(20)}`),
      newRuleSetCommitment: 8n,
      receiveKey: { operation: "replace", mlKemPublicKey: filled(ML_KEM_768_PUBLIC_KEY_LENGTH, 0x66) },
    },
    accountUpdateCommitment: 0x77n,
    section: {
      publicInputs: [
        CHAIN_ID,
        0x4321n,
        1n, 2n, 3n, 4n,
        5n, 6n, 7n, 8n, 9n,
        deliveryCommitment(EMPTY_OUTPUT_DATA, ARENA),
        0n, 0n, 0n,
        1_900_000_000n, 0n, 123n, 0n,
      ],
      proof: filled(WIRE_PROOF_BYTES, 0xbb),
      outputData: EMPTY_OUTPUT_DATA,
      arena: ARENA,
    },
  });
}

function updateWords(entry: ReturnType<typeof update>) {
  return userAccountUpdatePublicInputs(entry);
}

function privateValue(entry: Uint8Array) {
  const decoded = decodeTransaction(entry);
  if (decoded.kind !== 0) throw new Error("expected a private-value entry");
  return decoded;
}

function update(entry: Uint8Array) {
  const decoded = decodeTransaction(entry);
  if (decoded.kind !== 3) throw new Error("expected an update entry");
  return decoded;
}

function contract(entry: Uint8Array) {
  const decoded = decodeTransaction(entry);
  if (decoded.kind === 2) return decoded;
  if (decoded.kind === 0 && decoded.accountCreation?.kind === "contract") {
    const body = decodeTransaction(encodeContractAccountCreation(decoded.pcashChainId, decoded.accountCreation.body, {
      recentPcashBlockHash: 0n, validUntilTimestamp: 1n,
    }));
    if (body.kind !== 2) throw new Error("contract body decoding failed");
    return body;
  }
  throw new Error("expected a contract entry or attachment");
}

function creation(entry: Uint8Array) {
  const decoded = decodeTransaction(entry);
  if (decoded.kind !== 1 || decoded.authorization.kind !== "signed") throw new Error("expected a signed creation entry");
  return { ...decoded, authorization: decoded.authorization };
}

describe("private-value controls", () => {
  const template = privateValueTemplate();
  const inputs = privateValuePublicInputs(privateValue(template));

  it("edit exactly the targeted public input and invalidate the proof", () => {
    const cases: Array<[Uint8Array, number, bigint]> = [
      [controls.staleWindowTransfer(template), 1, controls.UNKNOWN_RECENT_BLOCK_HASH],
      [controls.expiredTransfer(template), PRIVATE_VALUE_PROFILES.S.offsets.validUntil, 1n],
      [controls.notYetValidTransfer(template), PRIVATE_VALUE_PROFILES.S.offsets.notBefore, 1n << 40n],
      [controls.zeroNullifierTransfer(template), 2, 0n],
      [controls.duplicateNullifierTransfer(template), 3, inputs[2]!],
    ];
    for (const [edited, index, expected] of cases) {
      const decoded = privateValue(edited);
      const editedInputs = privateValuePublicInputs(decoded);
      expect(editedInputs[index]).toBe(expected);
      expect(editedInputs.filter((_value, position) => position !== index)).toEqual(inputs.filter((_value, position) => position !== index));
      expect(decoded.proof).not.toEqual(privateValue(template).proof);
      expect(decoded.proof.length).toBe(WIRE_PROOF_BYTES);
    }
    const rejected = privateValue(controls.proofRejectedTransfer(template));
    expect(privateValuePublicInputs(rejected)).toEqual(inputs);
    expect(rejected.proof).not.toEqual(privateValue(template).proof);
  });

  it("re-encodes the wrong chain id without touching the proof", () => {
    const decoded = privateValue(controls.wrongChainIdTransfer(template));
    expect(decoded.pcashChainId).toBe(CHAIN_ID + 1);
    expect(decoded.proof).toEqual(privateValue(template).proof);
  });

  it("writes a non-field word over the first serialized public input", () => {
    const edited = controls.publicInputNotInFieldTransfer(template);
    expect(edited.length).toBe(template.length);
    expect(privateValue(edited).serializedPublicInputs[0]).toEqual(filled(32, 0xff));
    expect(() => privateValuePublicInputs(privateValue(edited))).toThrow();
  });

  it("changes byte zero of the first output without touching the proof", () => {
    // type, chain id, shape, 16 words, proof, then five output-data items and the arena.
    expect(template.length).toBe(7 + 16 * 32 + WIRE_PROOF_BYTES + 5 * OUTPUT_DATA_BYTES + PRIVATE_VALUE_PROFILES.S.arenaBytes);
    const edited = controls.outputByteZeroProofMutationTransfer(template);
    expect(changedOffsets(template, edited)).toEqual([6 + 16 * 32 + WIRE_PROOF_BYTES]);
    const decoded = privateValue(edited);
    const original = privateValue(template);
    expect(decoded.outputData.map((item) => item[0])).toEqual([0, 1, 1, 1, 1]);
    expect(decoded.proof).toEqual(original.proof);
    expect(decoded.outputData[0]!.slice(1)).toEqual(original.outputData[0]!.slice(1));
    expect(decoded.outputData.slice(1)).toEqual(original.outputData.slice(1));
  });

  it("produces the parser-level exclusions", () => {
    expect(controls.emptyItem().length).toBe(0);
    expect(controls.truncatedItem(template).length).toBe(100);
    expect(() => decodeTransaction(controls.truncatedItem(template))).toThrow();
    expect(() => decodeTransaction(controls.trailingBytesItem(template))).toThrow(/trailing/);
    expect(controls.oversizedItem(template).length).toBe(MAX_TX_BYTES + 1);
    const unknownType = controls.unknownTypeItem(0x50435348n);
    expect(unknownType).toEqual(Uint8Array.of(0x04, 0x50, 0x43, 0x53, 0x48));
    expect(() => decodeTransaction(unknownType)).toThrow(/unknown transaction kind 4/);
  });
});

describe("account creation controls", () => {
  const template = creationTemplate();

  it("zeroes s and nothing else", () => {
    // type, chain id, mode, two words, key mode, key, recent block, u64, r, s, yParity.
    expect(template.length).toBe(1_360);
    const edited = controls.badSignatureCreation(template);
    const sStart = 1_360 - 1 - 32;
    expect(changedOffsets(template, edited)).toEqual(Array.from({ length: 32 }, (_, index) => sStart + index));
    const original = creation(template);
    const badSignature = creation(edited);
    expect(badSignature.authorization.sigS).toEqual(new Uint8Array(32));
    expect(badSignature.authorization.sigR).toEqual(original.authorization.sigR);
    expect(badSignature.authorization.yParity).toBe(original.authorization.yParity);
    expect(badSignature.mlKemPublicKey).toEqual(filled(ML_KEM_768_PUBLIC_KEY_LENGTH, 0x22));
  });

  it("sets one selector byte outside its set so the creation does not decode", () => {
    const yParity = controls.unknownYParityCreation(template);
    expect(changedOffsets(template, yParity)).toEqual([1_360 - 1]);
    expect(yParity[1_360 - 1]).toBe(2);
    expect(() => decodeTransaction(yParity)).toThrow(/yParity must be 0 or 1/);
    // type, chain id, authorization mode, nullifier-key commitment, rule-set commitment, then the key mode.
    const keyMode = controls.unknownReceiveKeyModeCreation(template);
    expect(changedOffsets(template, keyMode)).toEqual([5 + 1 + 64]);
    expect(template[5 + 1 + 64]).toBe(1);
    expect(keyMode[5 + 1 + 64]).toBe(2);
    expect(() => decodeTransaction(keyMode)).toThrow(/receive-key mode 2/);
  });

  it("derives the same control identity and address every run", () => {
    expect(controls.controlPrivateKey("a")).toBe(controls.controlPrivateKey("a"));
    expect(controls.controlPrivateKey("a")).not.toBe(controls.controlPrivateKey("b"));
    expect(controls.controlAddress("account-not-found")).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("places the creation window controls around the referenced head", () => {
    const head = { latestBlockHash: `0x${"0".repeat(63)}9`, latestBlockTimestamp: 1_000_000n };
    const windows = controls.creationWindowControls(head);
    expect(windows.staleWindow.recentPcashBlockHash).toBe(controls.UNKNOWN_RECENT_BLOCK_HASH);
    expect(windows.expired.recentPcashBlockHash).toBe(9n);
    expect(windows.expired.validUntilTimestamp).toBe(999_999n);
  });
});

describe("contract controls", () => {
  // The function count follows the funding, publishesNkRoot, the material word, the key mode, and any key;
  // two 65-byte functions close the body.
  const cases: Array<[string, Uint8Array | undefined, number, number]> = [
    ["without a receive key", undefined, BODY_OFFSET + 34, BODY_OFFSET + 35 + 2 * 65],
    ["with a receive key", filled(ML_KEM_768_PUBLIC_KEY_LENGTH, 0x77), BODY_OFFSET + 34 + 1_184, BODY_OFFSET + 35 + 1_184 + 2 * 65],
  ];

  it.each(cases)("edit the material and the function set %s", (_name, key, functionCount, length) => {
    const template = contractTemplate(key);
    expect(template.length).toBe(length);
    expect(template[functionCount]).toBe(2);
    expect(contract(controls.nonCanonicalFieldContract(template)).nullifierKeyMaterial).toEqual(filled(32, 0xff));
    const empty = controls.emptyFunctionsContract(template);
    expect(empty.length).toBe(length - 2 * 65);
    expect(empty[functionCount]).toBe(0);
    expect(contract(empty).functions).toEqual([]);
    expect(empty.slice(0, BODY_OFFSET)).toEqual(template.slice(0, BODY_OFFSET));
    const swappedBytes = controls.swappedSelectorsContract(template);
    expect(Math.min(...changedOffsets(template, swappedBytes))).toBe(functionCount + 1);
    expect(Math.max(...changedOffsets(template, swappedBytes))).toBeLessThan(functionCount + 1 + 2 * 65);
    const nkRootFlag = controls.unknownNkRootFlagContract(template);
    expect(changedOffsets(template, nkRootFlag)).toEqual([BODY_OFFSET]);
    expect(nkRootFlag[BODY_OFFSET]).toBe(2);
    expect(() => decodeTransaction(nkRootFlag)).toThrow(/publishesNkRoot must be 0 or 1/);
    expect(changedOffsets(template, controls.nonCanonicalFieldContract(template))).toEqual(
      Array.from({ length: 32 }, (_, index) => BODY_OFFSET + 1 + index).filter((offset) => template[offset] !== 0xff));
    const attachmentTag = controls.unknownAttachmentTagContract(template);
    expect(changedOffsets(template, attachmentTag)).toEqual([BODY_OFFSET - 1]);
    expect(attachmentTag[BODY_OFFSET - 1]).toBe(3);
    expect(() => decodeTransaction(attachmentTag)).toThrow(/unknown account creation attachment tag 3/);
    const swapped = contract(swappedBytes);
    expect(swapped.functions.map((fn) => fn.selector)).toEqual([1, 0]);
    expect(swapped.functions[0]!.applicationVkHash).toEqual(word(0x1001n));
    expect(swapped.functions[1]!.configurationCommitment).toEqual(word(0x2000n));
  });

  it("publishes the same body unfunded, with only a recent block and deadline", () => {
    const attached = contract(contractTemplate());
    const entry = controls.unfundedContractCreation({
      network: { ...DEFAULT_NETWORK_CONFIG, pcashChainId: BigInt(CHAIN_ID) },
      body: attached.body,
      recentPcashBlockHash: 9n,
      validUntilTimestamp: 10n,
    });
    expect(entry.length).toBe(5 + 32 + 8 + attached.body.length);
    const unfunded = decodeTransaction(entry);
    if (unfunded.kind !== 2) throw new Error("expected standalone creation");
    expect(unfunded.pcashChainId).toBe(CHAIN_ID);
    expect(unfunded.body).toEqual(attached.body);
    expect(unfunded.recentPcashBlockHash).toEqual(word(9n));
    expect(unfunded.validUntilTimestamp).toBe(10n);
  });
});

describe("account update controls", () => {
  const template = updateTemplate();
  const original = update(template);

  it("edit exactly the targeted field and invalidate the proof", () => {
    // type, chain id, address, rule-set word, REPLACE, key, action word, 15 words, proof, five items, arena.
    expect(template.length).toBe(UPDATE_BYTES);
    const proofStart = 5 + 20 + 32 + 1 + 1_184 + 32 + 15 * 32;
    const proofFlip = proofStart + WIRE_PROOF_BYTES / 2;
    expect(changedOffsets(template, controls.proofRejectedUpdate(template))).toEqual([proofFlip]);
    const expiredChanges = changedOffsets(template, controls.expiredUpdate(template));
    expect(expiredChanges.at(-1)).toBe(proofFlip);
    expect(expiredChanges.slice(0, -1).every((offset) => offset >= proofStart - 72 && offset < proofStart - 64)).toBe(true);
    expect(update(controls.nonCanonicalFieldUpdate(template)).newRuleSetCommitment).toEqual(filled(32, 0xff));
    expect(updateWords(update(controls.staleWindowUpdate(template)))[1]).toBe(controls.UNKNOWN_RECENT_BLOCK_HASH);
    const expired = updateWords(update(controls.expiredUpdate(template)));
    const expectedExpired = [...updateWords(original)];
    expectedExpired[PRIVATE_VALUE_PROFILES.S.offsets.validUntil] = 1n;
    expect(expired).toEqual(expectedExpired);
    const retargeted = update(controls.retargetedUpdate(template, `0x${"ab".repeat(20)}`, "test"));
    expect(retargeted.address).toEqual(filled(20, 0xab));
    expect(retargeted.newRuleSetCommitment).toEqual(original.newRuleSetCommitment);
    expect(update(controls.accountUpdateCommitmentMismatchUpdate(template)).accountUpdateCommitment).toEqual(word(1n));
    for (const edited of [
      controls.proofRejectedUpdate(template),
      controls.nonCanonicalFieldUpdate(template),
      controls.staleWindowUpdate(template),
      controls.expiredUpdate(template),
      controls.retargetedUpdate(template, `0x${"ab".repeat(20)}`, "test"),
      controls.accountUpdateCommitmentMismatchUpdate(template),
    ]) {
      const decoded = update(edited);
      expect(decoded.section.proof.length).toBe(WIRE_PROOF_BYTES);
      expect(decoded.section.proof).not.toEqual(original.section.proof);
    }
    const rejected = update(controls.proofRejectedUpdate(template));
    expect(rejected.proposedAccountFields).toEqual(original.proposedAccountFields);
    expect(updateWords(rejected)).toEqual(updateWords(original));
  });

  it("builds a CLEAR against another account from the template's proof", () => {
    const bytes = controls.clearWithoutReceiveKeyUpdate({
      template,
      address: `0x${"cd".repeat(20)}`,
      pcashChainId: CHAIN_ID,
      recentPcashBlockHash: 0x4321n,
      validUntilTimestamp: 1_900_000_000n,
    });
    expect(bytes.length).toBe(UPDATE_BYTES - 1_184);
    expect(bytes[5 + 20 + 32]).toBe(1);
    const cleared = update(bytes);
    expect(cleared.address).toEqual(filled(20, 0xcd));
    expect(cleared.newRuleSetCommitment).toEqual(original.newRuleSetCommitment);
    expect(cleared.receiveKey).toEqual({ operation: "clear" });
    expect(cleared.accountUpdateCommitment).toEqual(word(1n));
    expect(updateWords(cleared).slice(0, -1)).toEqual(updateWords(original).slice(0, -1));
    expect(cleared.section.proof).toEqual(original.section.proof);
    expect(cleared.section.outputData).toEqual(original.section.outputData);
  });
});

describe("carrier framing", () => {
  it("matches the SDK framing for ordinary items and accepts oversized ones", () => {
    const items = [privateValueTemplate(), Uint8Array.of(0xff), new Uint8Array(0)];
    expect(controls.frameSeedBatch(items, VERSION, 1n, 0n)).toEqual(encodeBatch(items, 1n, 0n));
    const oversized = controls.frameSeedBatch([controls.oversizedItem(privateValueTemplate())], VERSION, 1n, 0n);
    expect(oversized.length).toBe(67 + 4 + MAX_TX_BYTES + 1);
    expect(() => encodeBatch([controls.oversizedItem(privateValueTemplate())], 1n, 0n)).toThrow(/MAX_TX_BYTES/);
  });

  it("produces carriers the batch decoder rejects", () => {
    expect(controls.unsupportedVersionCarrier()).toEqual(Uint8Array.of(2, 0, 0));
    expect(() => decodeBatch(controls.unsupportedVersionCarrier())).toThrow(/unsupported batch version/);
    expect(() => decodeBatch(controls.trailingBytesCarrier(privateValueTemplate(), VERSION))).toThrow(/trailing/);
  });
});
