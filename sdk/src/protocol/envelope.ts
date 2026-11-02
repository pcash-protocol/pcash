// PCASH reference-profile note delivery. Entirely
// non-consensus: the node treats each `env_i` as opaque bytes and only checks
// its exact length and hash. This module implements the reference suite with these
// components:
//
//   Suite: ML-KEM-768 + HKDF-SHA-256 + AES-256-GCM
//   envelope = version(1) ‖ kemCiphertext(1088) ‖ ciphertext(108) ‖ tag(16)
//   header   = version ‖ kemCiphertext
//   ikm      = ML-KEM-768 shared secret
//   salt     = SHA-256(utf8("pcash.envelope-salt") ‖ header)
//   key      = HKDF-SHA-256(ikm, salt, utf8("pcash.note-key"), 32)
//   AES-256-GCM(key, nonce = 12 zero bytes, plaintext, aad = empty) with a 128-bit tag.
//
// The plaintext carries the note opening only. Records (memo, asset
// definition, sender, application data) live in the section's arena, in a
// recipient region whose anchor cell the plaintext names; the envelope's
// shared secret derives that region's keys, so it is the output's disclosure key.
//
// The envelope carries NO plaintext recipient identifier; recipients trial-
// decrypt. Each envelope uses a fresh encapsulation and encrypts once per derived key.
// decryptEnvelope returns null on ANY failure (a non-match) and never throws to
// an untrusted caller.

import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { beBytes, bytesToBigInt, concatBytes, field32, utf8 } from "../utils/bytes.ts";
import { BN254_SCALAR_MODULUS, type FieldNumberish, toAddressField, toField, toNonnegativeBigInt } from "../crypto/field.ts";
import { AMOUNT_BITS, ML_KEM_768_PUBLIC_KEY_LENGTH, OUTPUT_DATA_BYTES } from "../constants/params.ts";

// --- Suite constants ---
export const ENVELOPE_VERSION = 1;
export const ML_KEM_768_SECRET_KEY_LENGTH = 2400;
export const ML_KEM_768_CIPHERTEXT_LENGTH = 1088;
export const ML_KEM_768_SEED_LENGTH = 64;
const ENVELOPE_NONCE = new Uint8Array(12);
export const AES_GCM_TAG_LENGTH = 16;
/** version(1) + kemCiphertext(1088). */
export const ENVELOPE_HEADER_LENGTH = 1 + ML_KEM_768_CIPHERTEXT_LENGTH; // 1089
const SHARED_SECRET_LENGTH = 32;

const ENVELOPE_SALT_LABEL = utf8("pcash.envelope-salt");
const NOTE_KEY_INFO = utf8("pcash.note-key");

// --- Payload constants ---
const NOTE_PAYLOAD_VERSION = 1;
/** `kind` 0: the output has no recipient region. */
const KIND_NO_REGION = 0;
/** `kind` 1: the output's recipient region is anchored at `anchor`. */
const KIND_REGION = 1;
const MAX_OUTPUT_SLOTS = Math.max(...Object.values(PRIVATE_VALUE_PROFILES).map((p) => p.outputs));
const AMOUNT_MAX = 1n << BigInt(AMOUNT_BITS);
/** version(1)+kind(1)+chainId(4)+assetId(32)+amount(16)+owner(20)+noteSecret(32)+outputIndex(1)+anchor(1). */
export const NOTE_PAYLOAD_LENGTH = 1 + 1 + 4 + 32 + 16 + 20 + 32 + 1 + 1; // 108

// ===========================================================================
// Payload plaintext
// ===========================================================================

export interface NotePayload {
  version: number;
  chainId: bigint;
  assetId: bigint;
  amount: bigint;
  /** The note owner's uint160 address. */
  owner: bigint;
  noteSecret: bigint;
  outputIndex: number; // Ordinary output slot in the source profile.
  /** Anchor cell of this output's recipient region; absent when the envelope names no region. */
  anchor?: number;
}

export interface NotePayloadInput {
  version?: number;
  chainId: FieldNumberish;
  assetId?: FieldNumberish;
  amount: bigint;
  owner: FieldNumberish;
  noteSecret: FieldNumberish;
  outputIndex: number;
  /** Anchor cell of the output's recipient region, when it has one. */
  anchor?: number;
}

/**
 * Serialize a payload plaintext (big-endian). Range-checks every field so
 * a produced payload always round-trips through `decodePayload`.
 */
export function encodePayload(p: NotePayloadInput): Uint8Array {
  const version = p.version ?? NOTE_PAYLOAD_VERSION;
  if (version !== NOTE_PAYLOAD_VERSION) throw new Error(`payload version must be ${NOTE_PAYLOAD_VERSION}`);
  const amount = toNonnegativeBigInt(p.amount, "amount");
  if (amount === 0n) throw new Error("amount must be positive");
  if (amount >= AMOUNT_MAX) throw new Error(`amount must be < 2^${AMOUNT_BITS}`);
  const assetId = toField(p.assetId ?? 0n, "assetId");
  const owner = toAddressField(p.owner, "owner");
  const noteSecret = toField(p.noteSecret, "noteSecret"); // enforces noteSecret < p
  if (!Number.isInteger(p.outputIndex) || p.outputIndex < 0 || p.outputIndex >= MAX_OUTPUT_SLOTS)
    throw new Error(`outputIndex must be below ${MAX_OUTPUT_SLOTS}`);
  if (p.anchor !== undefined && (!Number.isInteger(p.anchor) || p.anchor < 0 || p.anchor > 0xff)) {
    throw new Error("anchor must be a cell index below 256");
  }
  return concatBytes(
    Uint8Array.of(version, p.anchor === undefined ? KIND_NO_REGION : KIND_REGION),
    beBytes(p.chainId, 4), // u32; throws if chainId >= 2^32
    field32(assetId),
    beBytes(amount, 16), // u128
    beBytes(owner, 20),
    field32(noteSecret),
    Uint8Array.of(p.outputIndex, p.anchor ?? 0),
  );
}

/**
 * Parse a payload plaintext, applying every validity reject. `chainId` is
 * the wallet's PCASH_CHAIN_ID (the payload's must equal it). Throws on any reject;
 * callers that trial-decode untrusted bytes (scan) catch and treat as a
 * non-match.
 */
export function decodePayload(bytes: Uint8Array, opts: { chainId: FieldNumberish }): NotePayload {
  const expectedChainId = toNonnegativeBigInt(opts.chainId, "chainId");
  if (bytes.length !== NOTE_PAYLOAD_LENGTH) throw new Error("payload length mismatch");
  const version = bytes[0]!;
  if (version !== NOTE_PAYLOAD_VERSION) throw new Error(`unknown payload version ${version}`);
  const kind = bytes[1]!;
  if (kind !== KIND_NO_REGION && kind !== KIND_REGION) throw new Error(`unknown payload kind ${kind}`);
  const chainId = bytesToBigInt(bytes.subarray(2, 6));
  if (chainId !== expectedChainId) throw new Error("payload chainId mismatch");
  const assetId = bytesToBigInt(bytes.subarray(6, 38));
  if (assetId >= BN254_SCALAR_MODULUS) throw new Error("payload assetId >= p");
  const amount = bytesToBigInt(bytes.subarray(38, 54));
  if (amount === 0n) throw new Error("payload amount must be positive");
  const owner = bytesToBigInt(bytes.subarray(54, 74));
  const noteSecret = bytesToBigInt(bytes.subarray(74, 106));
  if (noteSecret >= BN254_SCALAR_MODULUS) throw new Error("payload noteSecret >= p");
  const outputIndex = bytes[106]!;
  if (outputIndex >= MAX_OUTPUT_SLOTS) throw new Error(`payload outputIndex must be below ${MAX_OUTPUT_SLOTS}`);
  const anchor = bytes[107]!;
  if (kind === KIND_NO_REGION && anchor !== 0) throw new Error("a payload without a region must have anchor 0");
  return {
    version, chainId, assetId, amount, owner, noteSecret, outputIndex,
    ...(kind === KIND_REGION ? { anchor } : {}),
  };
}

// ===========================================================================
// ML-KEM-768 key pairs (CSPRNG-generated, stored in the keystore)
// ===========================================================================

export interface MlKemKeyPair {
  publicKey: Uint8Array; // 1184 bytes
  secretKey: Uint8Array; // 2400 bytes
}

/** Generate an ML-KEM-768 receive key pair. Optional 64-byte seed for determinism. */
export function generateMlKemKeyPair(seed?: Uint8Array): MlKemKeyPair {
  if (seed !== undefined && seed.length !== ML_KEM_768_SEED_LENGTH) {
    throw new Error(`ML-KEM-768 seed must be ${ML_KEM_768_SEED_LENGTH} bytes`);
  }
  const kp = seed === undefined ? ml_kem768.keygen() : ml_kem768.keygen(seed);
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

// ===========================================================================
// Envelope encrypt / decrypt
// ===========================================================================

/** key = HKDF-SHA-256(ikm, salt = SHA-256(saltLabel ‖ header), info, 32). */
function deriveKey(sharedSecret: Uint8Array, header: Uint8Array): Uint8Array {
  const salt = sha256(concatBytes(ENVELOPE_SALT_LABEL, header));
  return hkdf(sha256, sharedSecret, salt, NOTE_KEY_INFO, 32);
}

/**
 * One fresh encapsulation to a recipient key, before its plaintext exists.
 * The shared secret keys the recipient's arena region, so a builder
 * encapsulates first, builds the arena, then seals each plaintext with its anchor.
 */
export interface EnvelopeEncapsulation {
  header: Uint8Array;
  /** ML-KEM shared secret of this envelope; whoever holds it can open the envelope. */
  sharedSecret: Uint8Array;
}

export function encapsulateEnvelope(recipientMlKemPublicKey: Uint8Array): EnvelopeEncapsulation {
  if (recipientMlKemPublicKey.length !== ML_KEM_768_PUBLIC_KEY_LENGTH) {
    throw new Error(`recipient ML-KEM-768 public key must be ${ML_KEM_768_PUBLIC_KEY_LENGTH} bytes`);
  }
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(recipientMlKemPublicKey);
  return { header: concatBytes(Uint8Array.of(ENVELOPE_VERSION), cipherText), sharedSecret };
}

/** The envelope of one plaintext under an encapsulation. Each encapsulation seals one plaintext. */
export function sealEncapsulatedEnvelope(encapsulation: EnvelopeEncapsulation, payload: Uint8Array): Uint8Array {
  // noble's gcm.encrypt returns ciphertext ‖ tag (16-byte tag), which is exactly
  // the tail after the header.
  const key = deriveKey(encapsulation.sharedSecret, encapsulation.header);
  return concatBytes(encapsulation.header, gcm(key, ENVELOPE_NONCE).encrypt(payload));
}

export interface SealedEnvelope {
  envelope: Uint8Array;
  /** ML-KEM shared secret of this envelope; whoever holds it can open the envelope. */
  sharedSecret: Uint8Array;
}

/**
 * Encrypt a payload to a recipient ML-KEM-768 public key. A fresh
 * encapsulation gives each call its own derived key.
 */
export function sealEnvelope(recipientMlKemPublicKey: Uint8Array, payload: Uint8Array): SealedEnvelope {
  const encapsulation = encapsulateEnvelope(recipientMlKemPublicKey);
  return { envelope: sealEncapsulatedEnvelope(encapsulation, payload), sharedSecret: encapsulation.sharedSecret };
}

/** The envelope bytes of `sealEnvelope`. */
export function encryptEnvelope(recipientMlKemPublicKey: Uint8Array, payload: Uint8Array): Uint8Array {
  return sealEnvelope(recipientMlKemPublicKey, payload).envelope;
}

/**
 * Open an envelope with its ML-KEM shared secret. Returns the payload
 * plaintext, or null on any failure.
 */
export function openEnvelope(sharedSecret: Uint8Array, envelope: Uint8Array): Uint8Array | null {
  try {
    if (envelope.length < ENVELOPE_HEADER_LENGTH + AES_GCM_TAG_LENGTH) return null;
    if (envelope[0] !== ENVELOPE_VERSION) return null;
    if (sharedSecret.length !== SHARED_SECRET_LENGTH) return null;
    const header = envelope.subarray(0, ENVELOPE_HEADER_LENGTH);
    const ciphertextAndTag = envelope.subarray(ENVELOPE_HEADER_LENGTH);
    return gcm(deriveKey(sharedSecret, header), ENVELOPE_NONCE).decrypt(ciphertextAndTag);
  } catch {
    return null;
  }
}

/**
 * Decapsulate an envelope's ML-KEM ciphertext with a secret receive key. A
 * wrong key yields a pseudo-random secret (implicit rejection), so only
 * `openEnvelope` under the result distinguishes a match. Null on malformed input.
 */
export function envelopeSharedSecret(mlKemSecretKey: Uint8Array, envelope: Uint8Array): Uint8Array | null {
  try {
    if (envelope.length < ENVELOPE_HEADER_LENGTH + AES_GCM_TAG_LENGTH) return null;
    if (envelope[0] !== ENVELOPE_VERSION) return null;
    if (mlKemSecretKey.length !== ML_KEM_768_SECRET_KEY_LENGTH) return null;
    return ml_kem768.decapsulate(envelope.subarray(1, ENVELOPE_HEADER_LENGTH), mlKemSecretKey);
  } catch {
    return null;
  }
}

/** A trial-decrypted envelope and the shared secret that opened it. */
export interface OpenedEnvelope {
  plaintext: Uint8Array;
  /** Opens the envelope and keys its recipient region: the output's disclosure key. */
  sharedSecret: Uint8Array;
}

/** Trial-decrypt with a secret receive key, keeping the shared secret. Null on ANY failure. */
export function trialOpenEnvelope(mlKemSecretKey: Uint8Array, envelope: Uint8Array): OpenedEnvelope | null {
  const sharedSecret = envelopeSharedSecret(mlKemSecretKey, envelope);
  if (sharedSecret === null) return null;
  const plaintext = openEnvelope(sharedSecret, envelope);
  return plaintext === null ? null : { plaintext, sharedSecret };
}

/**
 * Trial-decrypt an envelope with an ML-KEM-768 secret key. Returns the
 * payload plaintext, or null on ANY failure (bad length/version, decapsulation,
 * or AEAD tag) — a non-match. Never throws to an untrusted caller.
 */
export function decryptEnvelope(mlKemSecretKey: Uint8Array, envelope: Uint8Array): Uint8Array | null {
  return trialOpenEnvelope(mlKemSecretKey, envelope)?.plaintext ?? null;
}

// ===========================================================================
// Size-class filler for dummy / out-of-band slots
// ===========================================================================

/** Envelope byte length for a plaintext of `payloadLength` bytes. */
export function envelopeLength(payloadLength: number): number {
  return ENVELOPE_HEADER_LENGTH + payloadLength + AES_GCM_TAG_LENGTH;
}

export function assertOutputDataItems(items: readonly Uint8Array[], shape: PrivateValueShape = PRIVATE_VALUE_PROFILES.S.shapeId): void {
  const profile = privateValueProfile(shape);
  if (items.length !== profile.outputs) throw new Error(`private value requires ${profile.outputs} outputData items`);
  for (const [slot, item] of items.entries()) {
    if (item.length !== OUTPUT_DATA_BYTES) throw new Error(`outputData[${slot}] must have exactly ${OUTPUT_DATA_BYTES} bytes`);
  }
}

/**
 * Envelope-distributed filler for a slot without in-band delivery. The fresh
 * throwaway secret key is discarded, so no recipient can open the envelope.
 */
export function sizeClassFiller(): Uint8Array {
  const { publicKey } = generateMlKemKeyPair();
  return encryptEnvelope(publicKey, randomBytes(NOTE_PAYLOAD_LENGTH));
}

/** Message delivery uses an envelope slot but creates no note opening. */
export interface MessagePayload { kind: "message"; chainId: bigint; outputIndex: number; anchor: number }
export function encodeMessagePayload(p: Omit<MessagePayload, "kind">): Uint8Array {
  if (p.chainId < 0n || p.chainId >= 1n << 32n || !Number.isInteger(p.outputIndex) || p.outputIndex < 0 || p.outputIndex >= MAX_OUTPUT_SLOTS
    || !Number.isInteger(p.anchor) || p.anchor < 0 || p.anchor > 255) throw new Error("invalid message delivery address");
  const bytes = new Uint8Array(NOTE_PAYLOAD_LENGTH);
  bytes[0] = NOTE_PAYLOAD_VERSION;
  bytes[1] = 2;
  bytes.set(beBytes(p.chainId, 4), 2);
  bytes[106] = p.outputIndex;
  bytes[107] = p.anchor;
  return bytes;
}
export function decodeDeliveryPayload(bytes: Uint8Array, expected: { chainId: bigint }): NotePayload | MessagePayload {
  if (bytes[1] !== 2) return decodePayload(bytes, expected);
  if (bytes.length !== NOTE_PAYLOAD_LENGTH || bytes[0] !== NOTE_PAYLOAD_VERSION || bytesToBigInt(bytes.subarray(2, 6)) !== expected.chainId
    || bytes.subarray(6, 106).some(byte => byte !== 0) || bytes[106]! >= MAX_OUTPUT_SLOTS) throw new Error("invalid message payload");
  return { kind: "message", chainId: expected.chainId, outputIndex: bytes[106]!, anchor: bytes[107]! };
}
