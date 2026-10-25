// Reference note-delivery envelope: the 108-byte note plaintext with every
// reject, the ML-KEM-768 + HKDF-SHA-256 + AES-256-GCM suite against a frozen
// vector, the two-step encapsulate-then-seal path a builder uses, the shared
// secret as the per-output disclosure key, and CROSS-WALLET delivery (a
// foreign wallet must get a non-match).

import { describe, expect, it, vi } from "vitest";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import envelopeVector from "./envelope.vector.json" with { type: "json" };
import {
  AES_GCM_TAG_LENGTH,
  ENVELOPE_HEADER_LENGTH,
  ENVELOPE_VERSION,
  ML_KEM_768_CIPHERTEXT_LENGTH,
  ML_KEM_768_SECRET_KEY_LENGTH,
  NOTE_PAYLOAD_LENGTH,
  assertOutputDataItems,
  decodePayload,
  decryptEnvelope,
  encapsulateEnvelope,
  encodePayload,
  encryptEnvelope,
  envelopeLength,
  envelopeSharedSecret,
  generateMlKemKeyPair,
  openEnvelope,
  sealEncapsulatedEnvelope,
  sealEnvelope,
  sizeClassFiller,
  trialOpenEnvelope,
} from "../src/protocol/envelope.ts";
import { OUTPUT_DATA_BYTES, ML_KEM_768_PUBLIC_KEY_LENGTH } from "../src/constants/params.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { EXTENDED_CODE_VERSION, buildExtendedCode, parseExtendedCode, walletExtendedCode } from "../src/delivery/extendedCode.ts";
import { deriveTestWallet } from "./testWallet.ts";
import { bytesEqual } from "../src/utils/bytes.ts";
import { fromHex, toHex } from "../src/utils/hex.ts";
import { BN254_SCALAR_MODULUS } from "../src/crypto/field.ts";

vi.mock("@noble/post-quantum/ml-kem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@noble/post-quantum/ml-kem.js")>();
  return {
    ...actual,
    ml_kem768: {
      ...actual.ml_kem768,
      keygen: vi.fn(actual.ml_kem768.keygen),
      encapsulate: vi.fn(actual.ml_kem768.encapsulate),
    },
  };
});

const chainId = 0x1ff6n;
const p = BN254_SCALAR_MODULUS;

const validPayloadInput = {
  chainId,
  assetId: 0x123n,
  amount: 123456789n,
  owner: 0x87c018ef78005f118c53fa9cadf0a4fd367a77a9n,
  noteSecret: 0xdeadbeefcafe0011n,
  outputIndex: 0,
};
/** The frozen vector's plaintext: a recipient region anchored at cell 0x27. */
const vectorPayloadInput = { ...validPayloadInput, outputIndex: 2, anchor: 0x27 };

async function actualMlKem() {
  return (await vi.importActual<typeof import("@noble/post-quantum/ml-kem.js")>("@noble/post-quantum/ml-kem.js")).ml_kem768;
}

describe("payload codec", () => {
  it("round-trips a payload that names a recipient region", () => {
    const bytes = encodePayload({ ...validPayloadInput, outputIndex: 31, anchor: 255 });
    expect(bytes.length).toBe(NOTE_PAYLOAD_LENGTH);
    expect(Array.from(bytes.subarray(0, 6))).toEqual([1, 1, 0, 0, 0x1f, 0xf6]);
    expect(Array.from(bytes.subarray(106))).toEqual([31, 255]);
    expect(decodePayload(bytes, { chainId })).toEqual({
      version: 1,
      chainId,
      assetId: validPayloadInput.assetId,
      amount: validPayloadInput.amount,
      owner: validPayloadInput.owner,
      noteSecret: validPayloadInput.noteSecret,
      outputIndex: 31,
      anchor: 255,
    });
  });

  it("round-trips a payload without a region as kind 0 and anchor 0", () => {
    const bytes = encodePayload(validPayloadInput);
    expect(bytes.length).toBe(NOTE_PAYLOAD_LENGTH);
    expect(Array.from(bytes.subarray(0, 6))).toEqual([1, 0, 0, 0, 0x1f, 0xf6]);
    expect(Array.from(bytes.subarray(106))).toEqual([0, 0]);
    const back = decodePayload(bytes, { chainId });
    expect(back).not.toHaveProperty("anchor");
    expect(back.amount).toBe(validPayloadInput.amount);
  });

  it("distinguishes a region anchored at cell 0 from no region", () => {
    const anchored = encodePayload({ ...validPayloadInput, anchor: 0 });
    expect(anchored[1]).toBe(1);
    expect(decodePayload(anchored, { chainId }).anchor).toBe(0);
    expect(bytesEqual(anchored.subarray(2), encodePayload(validPayloadInput).subarray(2))).toBe(true);
  });

  const valid = () => encodePayload({ ...validPayloadInput, anchor: 9 });

  // Each row corrupts one field of an otherwise valid payload. The decoder must
  // name the field it rejected, so a mutation that starts passing for the wrong
  // reason still fails the pattern.
  it.each([
    ["an unknown version", (b: Uint8Array) => { b[0] = 2; }, /version/],
    ["kind 2", (b: Uint8Array) => { b[1] = 2; }, /kind/],
    ["kind 255", (b: Uint8Array) => { b[1] = 255; }, /kind/],
    ["kind 0 with a nonzero anchor", (b: Uint8Array) => { b[1] = 0; }, /anchor 0/],
    ["assetId >= p", (b: Uint8Array) => { b.fill(0xff, 6, 38); }, /assetId >= p/],
    ["a zero amount", (b: Uint8Array) => { b.fill(0, 38, 54); }, /positive/],
    ["noteSecret >= p", (b: Uint8Array) => { b.fill(0xff, 74, 106); }, /noteSecret >= p/],
    ["outputIndex outside 0 through 31", (b: Uint8Array) => { b[106] = 32; }, /outputIndex/],
  ])("rejects %s", (_name, corrupt, pattern) => {
    const b = valid();
    expect(() => decodePayload(b, { chainId })).not.toThrow();
    corrupt(b);
    expect(() => decodePayload(b, { chainId })).toThrow(pattern);
  });

  it("accepts any anchor byte under kind 1; the arena reader checks its range", () => {
    const b = valid();
    b[107] = 255;
    expect(decodePayload(b, { chainId }).anchor).toBe(255);
  });

  it("carries the owner as the full 20-byte address", () => {
    const owner = (1n << 160n) - 1n;
    const bytes = encodePayload({ ...validPayloadInput, owner });
    expect(Array.from(bytes.subarray(54, 74))).toEqual(Array(20).fill(0xff));
    expect(decodePayload(bytes, { chainId }).owner).toBe(owner);
    const zero = encodePayload({ ...validPayloadInput, owner: 0n });
    expect(Array.from(zero.subarray(54, 74))).toEqual(Array(20).fill(0));
    expect(decodePayload(zero, { chainId }).owner).toBe(0n);
  });

  it("round-trips a zero note secret, which opens an ordinary spendable note", () => {
    const bytes = encodePayload({ ...validPayloadInput, noteSecret: 0n });
    expect(Array.from(bytes.subarray(74, 106))).toEqual(Array(32).fill(0));
    expect(decodePayload(bytes, { chainId }).noteSecret).toBe(0n);
  });

  it("rejects a chainId mismatch", () => {
    expect(() => decodePayload(valid(), { chainId: chainId + 1n })).toThrow(/chainId/);
  });

  it("rejects trailing and truncated bytes", () => {
    const extra = new Uint8Array(NOTE_PAYLOAD_LENGTH + 1);
    extra.set(valid());
    expect(() => decodePayload(extra, { chainId })).toThrow(/length/);
    expect(() => decodePayload(valid().slice(0, NOTE_PAYLOAD_LENGTH - 1), { chainId })).toThrow(/length/);
  });

  it.each([0n, 1n])("uses the full 128-bit amount field for assetId %s", (assetId) => {
    const amount = (1n << 128n) - 1n;
    expect(decodePayload(encodePayload({ ...validPayloadInput, assetId, amount }), { chainId }).amount).toBe(amount);
    expect(() => encodePayload({ ...validPayloadInput, assetId, amount: 1n << 128n })).toThrow(/2\^128/);
  });

  it.each([
    ["a zero amount", { amount: 0n }, /positive/],
    ["an amount of 2^128", { amount: 1n << 128n }, /2\^128/],
    ["noteSecret >= p", { noteSecret: p }, /noteSecret/],
    ["an owner of 2^160", { owner: 1n << 160n }, /owner must fit in 160 bits/],
    ["assetId >= p", { assetId: p }, /assetId/],
    ["another version", { version: 2 }, /version/],
    ["outputIndex 32", { outputIndex: 32 }, /outputIndex/],
    ["a negative outputIndex", { outputIndex: -1 }, /outputIndex/],
    ["a fractional outputIndex", { outputIndex: 1.5 }, /outputIndex/],
    ["anchor 256", { anchor: 256 }, /anchor/],
    ["a negative anchor", { anchor: -1 }, /anchor/],
    ["a fractional anchor", { anchor: 2.5 }, /anchor/],
    ["a chainId of 2^32", { chainId: 1n << 32n }, /32-bit/],
  ])("encodePayload refuses %s", (_name, override, pattern) => {
    expect(() => encodePayload({ ...validPayloadInput, ...override })).toThrow(pattern);
  });
});

describe("envelope suite", () => {
  it("pins the envelope and payload sizes", () => {
    expect(ENVELOPE_HEADER_LENGTH).toBe(1089);
    expect(NOTE_PAYLOAD_LENGTH).toBe(108);
    expect(AES_GCM_TAG_LENGTH).toBe(16);
    expect(envelopeLength(NOTE_PAYLOAD_LENGTH)).toBe(1213);
    expect(OUTPUT_DATA_BYTES).toBe(1213);
  });

  it("matches a frozen envelope vector", async () => {
    // The fixture uses deterministic ML-KEM inputs, Node's HKDF/AES-GCM, and a
    // hand-assembled plaintext, without SDK codecs.
    const actual = await actualMlKem();
    const { publicKey, secretKey } = generateMlKemKeyPair(fromHex(envelopeVector.keySeed));
    vi.mocked(ml_kem768.encapsulate).mockImplementationOnce((key) =>
      actual.encapsulate(key, fromHex(envelopeVector.encapsulationMessage)));
    const payload = encodePayload(vectorPayloadInput);
    expect(toHex(payload)).toBe(`0x${envelopeVector.plaintext}`);
    const envelope = encryptEnvelope(publicKey, payload);
    expect(ml_kem768.encapsulate).toHaveBeenLastCalledWith(publicKey);
    expect(toHex(envelope)).toBe(`0x${envelopeVector.envelope}`);
    expect(envelope.length).toBe(OUTPUT_DATA_BYTES);
    expect(decryptEnvelope(secretKey, fromHex(envelopeVector.envelope))).toEqual(payload);
    expect(decodePayload(payload, { chainId })).toMatchObject({ owner: validPayloadInput.owner, outputIndex: 2, anchor: 0x27 });
  });

  it("seals the frozen vector in two steps and returns the ML-KEM shared secret", async () => {
    const actual = await actualMlKem();
    const { publicKey, secretKey } = generateMlKemKeyPair(fromHex(envelopeVector.keySeed));
    const expected = actual.encapsulate(publicKey, fromHex(envelopeVector.encapsulationMessage));
    const deterministic = (key: Uint8Array) => actual.encapsulate(key, fromHex(envelopeVector.encapsulationMessage));
    const payload = fromHex(envelopeVector.plaintext);

    vi.mocked(ml_kem768.encapsulate).mockImplementationOnce(deterministic);
    const encapsulation = encapsulateEnvelope(publicKey);
    expect(toHex(encapsulation.header)).toBe(`0x${envelopeVector.envelope.slice(0, 2 * ENVELOPE_HEADER_LENGTH)}`);
    expect(bytesEqual(encapsulation.sharedSecret, expected.sharedSecret)).toBe(true);
    expect(toHex(sealEncapsulatedEnvelope(encapsulation, payload))).toBe(`0x${envelopeVector.envelope}`);

    vi.mocked(ml_kem768.encapsulate).mockImplementationOnce(deterministic);
    const sealed = sealEnvelope(publicKey, payload);
    expect(toHex(sealed.envelope)).toBe(`0x${envelopeVector.envelope}`);
    expect(bytesEqual(sealed.sharedSecret, expected.sharedSecret)).toBe(true);

    const envelope = fromHex(envelopeVector.envelope);
    expect(bytesEqual(envelopeSharedSecret(secretKey, envelope)!, expected.sharedSecret)).toBe(true);
    const opened = trialOpenEnvelope(secretKey, envelope)!;
    expect(bytesEqual(opened.plaintext, payload)).toBe(true);
    expect(bytesEqual(opened.sharedSecret, expected.sharedSecret)).toBe(true);
    expect(bytesEqual(openEnvelope(expected.sharedSecret, envelope)!, payload)).toBe(true);
  });

  it("constructs filler through the ML-KEM envelope path", async () => {
    const actual = await actualMlKem();
    const keygen = vi.mocked(ml_kem768.keygen);
    const encapsulate = vi.mocked(ml_kem768.encapsulate);
    keygen.mockRestore();
    encapsulate.mockRestore();

    const keyPair = actual.keygen(fromHex(envelopeVector.keySeed));
    const sealed = actual.encapsulate(keyPair.publicKey, fromHex(envelopeVector.encapsulationMessage));
    keygen.mockImplementationOnce(() => keyPair);
    encapsulate.mockImplementationOnce(() => sealed);

    try {
      const filler = sizeClassFiller();
      expect(keygen).toHaveBeenCalledTimes(1);
      expect(keygen.mock.calls[0]).toEqual([]);
      expect(encapsulate).toHaveBeenCalledTimes(1);
      expect(bytesEqual(encapsulate.mock.calls[0]![0], keyPair.publicKey)).toBe(true);
      expect(bytesEqual(filler.subarray(1, ENVELOPE_HEADER_LENGTH), sealed.cipherText)).toBe(true);
      expect(filler.length).toBe(OUTPUT_DATA_BYTES);
      expect(filler[0]).toBe(ENVELOPE_VERSION);
      // The plaintext is random bytes under the discarded key: it opens with the
      // throwaway secret but is not a note.
      const plaintext = openEnvelope(sealed.sharedSecret, filler)!;
      expect(plaintext.length).toBe(NOTE_PAYLOAD_LENGTH);
      expect(decryptEnvelope(keyPair.secretKey, filler)).toEqual(plaintext);
    } finally {
      keygen.mockRestore();
      encapsulate.mockRestore();
    }
  });

  it("generates an ML-KEM-768 key pair of the spec lengths", () => {
    const kp = generateMlKemKeyPair();
    expect(kp.publicKey.length).toBe(ML_KEM_768_PUBLIC_KEY_LENGTH);
    expect(kp.secretKey.length).toBe(ML_KEM_768_SECRET_KEY_LENGTH);
    expect(() => generateMlKemKeyPair(new Uint8Array(32))).toThrow(/64 bytes/);
  });

  it("encrypt -> decrypt round-trips and lays out version||kemCt||ct||tag", () => {
    const { publicKey, secretKey } = generateMlKemKeyPair();
    const payload = encodePayload({ ...validPayloadInput, anchor: 3 });
    const env = encryptEnvelope(publicKey, payload);
    expect(env[0]).toBe(ENVELOPE_VERSION);
    expect(env.length).toBe(ENVELOPE_HEADER_LENGTH + payload.length + AES_GCM_TAG_LENGTH);
    expect(env.length).toBe(OUTPUT_DATA_BYTES);
    expect(ENVELOPE_HEADER_LENGTH).toBe(1 + ML_KEM_768_CIPHERTEXT_LENGTH);
    const back = decryptEnvelope(secretKey, env);
    expect(back).not.toBeNull();
    expect(bytesEqual(back!, payload)).toBe(true);
  });

  it("returns null on a tampered KEM ciphertext, ciphertext, tag, version, or truncation", () => {
    const { publicKey, secretKey } = generateMlKemKeyPair();
    const { envelope: env, sharedSecret } = sealEnvelope(publicKey, encodePayload(validPayloadInput));
    const tampered = (index: number) => {
      const copy = Uint8Array.from(env);
      copy[index] = copy[index]! ^ 0xff;
      return copy;
    };
    for (const index of [1, ENVELOPE_HEADER_LENGTH, env.length - 1, 0]) {
      expect(decryptEnvelope(secretKey, tampered(index))).toBeNull();
      expect(trialOpenEnvelope(secretKey, tampered(index))).toBeNull();
      expect(openEnvelope(sharedSecret, tampered(index))).toBeNull();
    }
    expect(decryptEnvelope(secretKey, env.slice(0, ENVELOPE_HEADER_LENGTH))).toBeNull();
    expect(decryptEnvelope(secretKey, env.slice(0, env.length - 1))).toBeNull();
    expect(decryptEnvelope(new Uint8Array(10), env)).toBeNull();
  });

  it("opens an envelope with its shared secret and nothing else", () => {
    const { publicKey, secretKey } = generateMlKemKeyPair();
    const payload = encodePayload(validPayloadInput);
    const { envelope, sharedSecret } = sealEnvelope(publicKey, payload);
    expect(bytesEqual(openEnvelope(sharedSecret, envelope)!, payload)).toBe(true);
    expect(bytesEqual(decryptEnvelope(secretKey, envelope)!, payload)).toBe(true);
    const wrong = Uint8Array.from(sharedSecret);
    wrong[0] = wrong[0]! ^ 1;
    expect(openEnvelope(wrong, envelope)).toBeNull();
    expect(openEnvelope(sharedSecret.subarray(0, 31), envelope)).toBeNull();
    expect(openEnvelope(sharedSecret, sizeClassFiller())).toBeNull();
  });

  it("seals one encapsulation's plaintext after the fact, as a builder does once the arena exists", () => {
    const { publicKey, secretKey } = generateMlKemKeyPair();
    const encapsulation = encapsulateEnvelope(publicKey);
    expect(encapsulation.header.length).toBe(ENVELOPE_HEADER_LENGTH);
    expect(encapsulation.header[0]).toBe(ENVELOPE_VERSION);
    expect(encapsulation.sharedSecret.length).toBe(32);
    const payload = encodePayload({ ...validPayloadInput, anchor: 17 });
    const envelope = sealEncapsulatedEnvelope(encapsulation, payload);
    expect(bytesEqual(envelope.subarray(0, ENVELOPE_HEADER_LENGTH), encapsulation.header)).toBe(true);
    expect(envelope.length).toBe(OUTPUT_DATA_BYTES);
    const opened = trialOpenEnvelope(secretKey, envelope)!;
    expect(bytesEqual(opened.plaintext, payload)).toBe(true);
    expect(bytesEqual(opened.sharedSecret, encapsulation.sharedSecret)).toBe(true);
    expect(() => encapsulateEnvelope(publicKey.subarray(1))).toThrow(/1184 bytes/);
  });

  it("decapsulates any well-formed envelope but only the right key's secret opens it", () => {
    const alice = generateMlKemKeyPair();
    const carol = generateMlKemKeyPair();
    const { envelope, sharedSecret } = sealEnvelope(alice.publicKey, encodePayload(validPayloadInput));
    expect(bytesEqual(envelopeSharedSecret(alice.secretKey, envelope)!, sharedSecret)).toBe(true);
    // ML-KEM implicit rejection: a foreign key yields an unrelated secret, not an error.
    const foreign = envelopeSharedSecret(carol.secretKey, envelope)!;
    expect(foreign.length).toBe(32);
    expect(bytesEqual(foreign, sharedSecret)).toBe(false);
    expect(openEnvelope(foreign, envelope)).toBeNull();
    expect(trialOpenEnvelope(carol.secretKey, envelope)).toBeNull();

    const badVersion = Uint8Array.from(envelope);
    badVersion[0] = 2;
    expect(envelopeSharedSecret(alice.secretKey, badVersion)).toBeNull();
    expect(envelopeSharedSecret(alice.secretKey, envelope.slice(0, ENVELOPE_HEADER_LENGTH))).toBeNull();
    expect(envelopeSharedSecret(alice.secretKey.subarray(1), envelope)).toBeNull();
  });

  it("fresh encapsulations make two envelopes of the same payload differ", () => {
    const { publicKey, secretKey } = generateMlKemKeyPair();
    const payload = encodePayload(validPayloadInput);
    const a = sealEnvelope(publicKey, payload);
    const b = sealEnvelope(publicKey, payload);
    expect(bytesEqual(a.envelope.subarray(1, ENVELOPE_HEADER_LENGTH), b.envelope.subarray(1, ENVELOPE_HEADER_LENGTH))).toBe(false);
    expect(bytesEqual(a.sharedSecret, b.sharedSecret)).toBe(false);
    expect(bytesEqual(decryptEnvelope(secretKey, a.envelope)!, decryptEnvelope(secretKey, b.envelope)!)).toBe(true);
  });

  it.each([PRIVATE_VALUE_PROFILES.S, PRIVATE_VALUE_PROFILES.L])("requires $outputs items of exactly 1,213 bytes for $name", (profile) => {
    const items = Array.from({ length: profile.outputs }, () => new Uint8Array(OUTPUT_DATA_BYTES));
    expect(() => assertOutputDataItems(items, profile.shapeId)).not.toThrow();
    expect(() => assertOutputDataItems(items.slice(1), profile.shapeId)).toThrow(`requires ${profile.outputs}`);
    const short = [...items.slice(0, -1), new Uint8Array(OUTPUT_DATA_BYTES - 1)];
    expect(() => assertOutputDataItems(short, profile.shapeId)).toThrow(`outputData[${profile.outputs - 1}] must have exactly 1213 bytes`);
  });
});

describe("CROSS-WALLET delivery", () => {
  it("Bob encrypts to Alice; Alice recovers; a different wallet gets a non-match", () => {
    const alice = generateMlKemKeyPair();
    const carol = generateMlKemKeyPair();

    // Bob (the sender) only needs Alice's public key.
    const payload = encodePayload({ ...validPayloadInput, amount: 777n, anchor: 5 });
    const envelope = encryptEnvelope(alice.publicKey, payload);

    // Alice recovers the exact payload.
    const recovered = decryptEnvelope(alice.secretKey, envelope);
    expect(recovered).not.toBeNull();
    expect(bytesEqual(recovered!, payload)).toBe(true);
    expect(decodePayload(recovered!, { chainId })).toMatchObject({ amount: 777n, anchor: 5 });

    // A DIFFERENT wallet (Carol) gets null — a non-match — on the same envelope.
    expect(decryptEnvelope(carol.secretKey, envelope)).toBeNull();
    expect(trialOpenEnvelope(carol.secretKey, envelope)).toBeNull();
  });

  it("delivers the recipient's 20-byte address through encryption and decryption", () => {
    const alice = generateMlKemKeyPair();
    const owner = 0xff00000000000000000000000000000000000001n;
    const envelope = encryptEnvelope(alice.publicKey, encodePayload({ ...validPayloadInput, owner, anchor: 7 }));
    expect(envelope.length).toBe(OUTPUT_DATA_BYTES);
    expect(decodePayload(decryptEnvelope(alice.secretKey, envelope)!, { chainId })).toEqual({
      version: 1,
      chainId,
      assetId: validPayloadInput.assetId,
      amount: validPayloadInput.amount,
      owner,
      noteSecret: validPayloadInput.noteSecret,
      outputIndex: 0,
      anchor: 7,
    });
  });
});

describe("extended code (delivery target 2)", () => {
  it("round-trips version||chainId||address||mlKemPub with its checksum", () => {
    const { publicKey } = generateMlKemKeyPair();
    const address = 0x87c018ef78005f118c53fa9cadf0a4fd367a77a9n;
    const code = buildExtendedCode({ chainId, address, mlKemPublicKey: publicKey });
    const parsed = parseExtendedCode(code);
    expect(parsed.version).toBe(EXTENDED_CODE_VERSION);
    expect(parsed.version).toBe(2);
    expect(parsed.chainId).toBe(chainId);
    expect(parsed.address).toBe(address);
    expect(bytesEqual(parsed.mlKemPublicKey, publicKey)).toBe(true);
  });

  it("rejects a single flipped byte via the checksum", () => {
    const { publicKey } = generateMlKemKeyPair();
    const address = 0x87c018ef78005f118c53fa9cadf0a4fd367a77a9n;
    const code = buildExtendedCode({ chainId, address, mlKemPublicKey: publicKey });
    const bytes = Uint8Array.from(Buffer.from(code, "base64url"));
    bytes[30]! ^= 0x01; // flip one bit inside the ML-KEM key body
    const tampered = Buffer.from(bytes).toString("base64url");
    expect(() => parseExtendedCode(tampered)).toThrow(/checksum/);
  });

  it("round-trips walletExtendedCode for a profile with receive keys", () => {
    const wallet = deriveTestWallet({ mlKem: "deterministic" });
    const parsed = parseExtendedCode(walletExtendedCode(wallet, chainId));
    expect(parsed.chainId).toBe(chainId);
    expect(parsed.address).toBe(wallet.address);
    expect(bytesEqual(parsed.mlKemPublicKey, wallet.mlKemPublicKey)).toBe(true);
  });

  it("rejects a malformed code and a wrong-length key", () => {
    expect(() => parseExtendedCode("not-a-code")).toThrow();
    expect(() =>
      buildExtendedCode({ chainId, address: 0n, mlKemPublicKey: new Uint8Array(10) }),
    ).toThrow(/1184/);
  });
});
