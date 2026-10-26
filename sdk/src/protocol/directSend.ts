// The opening of a direct send: a native note paid to an address with no
// receive key, whose envelope is keyed by its note secret instead of an
// encapsulation to a receive key. The sender shares it as a link; the owner's
// wallet records it in its own sender region so a restore finds it. Every copy
// uses this encoding.
//
//   opening = version (1) ‖ chainId (4) ‖ contentHash (32) ‖ slot (1) ‖ owner (20) ‖ amount (16) ‖ noteSecret (32)
//
// The opening names the funding output by the content hash of the exact
// transaction bytes and the output slot, never by leaf: a reorganization can
// include the same bytes at another leaf, which changes the note's commitment
// and nullifier but not its opening. The leaf comes from the accepted receipt.

import { PRIVATE_VALUE_PROFILES } from "../constants/privateValueProfiles.ts";
import { toAddressField, toField } from "../crypto/field.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { beBytes, bytesToBigInt, concatBytes, field32, utf8 } from "../utils/bytes.ts";
import { fixedHex, toHex } from "../utils/hex.ts";
import { encapsulateEnvelope, generateMlKemKeyPair, type EnvelopeEncapsulation } from "./envelope.ts";
import { noteBodyCommitment, outputCommitment, ownerCommitment } from "./notes.ts";

export const DIRECT_SEND_OPENING_VERSION = 1;
export const DIRECT_SEND_OPENING_BYTES = 106;
const MAX_OUTPUTS = PRIVATE_VALUE_PROFILES.L.outputs;

export interface DirectSendOpening {
  chainId: bigint;
  /** Content hash of the funding transaction, lowercase 0x-hex. */
  contentHash: string;
  /** The funding transaction's output slot. */
  slot: number;
  owner: bigint;
  /** Native PCASH. */
  amount: bigint;
  noteSecret: bigint;
}

function assertOpening(opening: DirectSendOpening): void {
  if (opening.chainId < 0n || opening.chainId >= 1n << 32n) throw new Error("direct send chainId must fit in 32 bits");
  if (!Number.isInteger(opening.slot) || opening.slot < 0 || opening.slot >= MAX_OUTPUTS) {
    throw new Error(`direct send slot must be below ${MAX_OUTPUTS}`);
  }
  toAddressField(opening.owner, "direct send owner");
  if (opening.owner === 0n) throw new Error("direct send owner must be nonzero");
  if (opening.amount <= 0n || opening.amount >= 1n << 128n) throw new Error("direct send amount must be positive and below 2^128");
  toField(opening.noteSecret, "direct send noteSecret");
}

export function encodeDirectSendOpening(opening: DirectSendOpening): Uint8Array {
  assertOpening(opening);
  return concatBytes(
    Uint8Array.of(DIRECT_SEND_OPENING_VERSION),
    beBytes(opening.chainId, 4),
    beBytes(BigInt(fixedHex(opening.contentHash, 32, "direct send contentHash")), 32),
    Uint8Array.of(opening.slot),
    beBytes(opening.owner, 20),
    beBytes(opening.amount, 16),
    field32(opening.noteSecret),
  );
}

/** Parse untrusted opening bytes; throws on any malformed field. */
export function decodeDirectSendOpening(bytes: Uint8Array): DirectSendOpening {
  if (bytes.length !== DIRECT_SEND_OPENING_BYTES) throw new Error("direct send opening has the wrong length");
  if (bytes[0] !== DIRECT_SEND_OPENING_VERSION) throw new Error(`unknown direct send opening version ${bytes[0]}`);
  const opening: DirectSendOpening = {
    chainId: bytesToBigInt(bytes.subarray(1, 5)),
    contentHash: toHex(bytes.subarray(5, 37)).toLowerCase(),
    slot: bytes[37]!,
    owner: bytesToBigInt(bytes.subarray(38, 58)),
    amount: bytesToBigInt(bytes.subarray(58, 74)),
    noteSecret: bytesToBigInt(bytes.subarray(74, 106)),
  };
  assertOpening(opening);
  return opening;
}

/** The funding output an opening names: its transaction's content hash and slot. */
export function directSendOutputKey(opening: Pick<DirectSendOpening, "contentHash" | "slot">): string {
  return `${opening.contentHash.toLowerCase()}:${opening.slot}`;
}

const DIRECT_SEND_SECRET_LABEL = utf8("pcash.direct-send");

/**
 * The shared secret of a direct send's envelope and recipient region, in place
 * of an ML-KEM shared secret, so whoever holds the opening reads its records.
 */
export function directSendSharedSecret(noteSecret: bigint): Uint8Array {
  return sha256(concatBytes(DIRECT_SEND_SECRET_LABEL, field32(noteSecret)));
}

/** A direct send's encapsulation: its header encapsulates to a discarded key, as filler does. */
export function directSendEncapsulation(noteSecret: bigint): EnvelopeEncapsulation {
  return { header: encapsulateEnvelope(generateMlKemKeyPair().publicKey).header, sharedSecret: directSendSharedSecret(noteSecret) };
}

/** The note's output commitment when its funding output sits at `leafIndex`. */
export function directSendOutputCommitment(opening: DirectSendOpening, leafIndex: bigint): bigint {
  return outputCommitment(noteBodyCommitment(ownerCommitment(opening.owner, opening.noteSecret), 0n, opening.amount), leafIndex);
}
