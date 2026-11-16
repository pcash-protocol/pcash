// Canonical PCASH payload packing inside Ethereum blobs.
//
// This is a pure codec for inspection, tooling, and cross-language vectors. The
// browser relayer remains calldata-only because its installed viem transaction
// surface does not construct post-Fusaka EIP-7594 sidecars.

export const BYTES_PER_PCASH_BLOB = 131_072;
const FIELD_ELEMENTS_PER_PCASH_BLOB = 4_096;
/** Fusaka's maximum blob count for one L1 transaction. */
export const MAX_PCASH_BATCH_BLOBS = 6;

const FIELD_ELEMENT_BYTES = 32;
const PAYLOAD_BYTES_PER_FIELD_ELEMENT = 31;
/** Exact payload capacity of `blobCount` blobs after reserving one field element for the length. */
export function pcashBlobPayloadCapacity(blobCount: number): number {
  return (blobCount * FIELD_ELEMENTS_PER_PCASH_BLOB - 1) * PAYLOAD_BYTES_PER_FIELD_ELEMENT;
}
export const MAX_PCASH_BATCH_BYTES = pcashBlobPayloadCapacity(MAX_PCASH_BATCH_BLOBS);

/** Minimal number of blobs for one canonical nonempty PCASH batch. */
export function requiredPcashBlobCount(payloadLength: number): number {
  if (!Number.isSafeInteger(payloadLength) || payloadLength < 0) {
    throw new Error("payload length must be a nonnegative safe integer");
  }
  if (payloadLength > MAX_PCASH_BATCH_BYTES) {
    throw new Error(`blob payload exceeds the ${MAX_PCASH_BATCH_BYTES}-byte batch limit`);
  }
  if (payloadLength === 0) return 0;
  const payloadElements = Math.ceil(payloadLength / PAYLOAD_BYTES_PER_FIELD_ELEMENT);
  return Math.ceil((payloadElements + 1) / FIELD_ELEMENTS_PER_PCASH_BLOB);
}

/** Encode exactly one nonempty batch into its canonical minimal blob list. */
export function encodePcashBlobs(payload: Uint8Array): Uint8Array[] {
  if (payload.length === 0) throw new Error("blob payload must not be empty");
  const blobCount = requiredPcashBlobCount(payload.length);
  const blobs = Array.from({ length: blobCount }, () => new Uint8Array(BYTES_PER_PCASH_BLOB));
  const first = blobs[0];
  if (first === undefined) throw new Error("blob allocation failed");

  let length = BigInt(payload.length);
  for (let offset = 8; offset >= 1; offset -= 1) {
    first[offset] = Number(length & 0xffn);
    length >>= 8n;
  }

  for (let index = 0; index < payload.length; index += 1) {
    const fieldIndex = 1 + Math.floor(index / PAYLOAD_BYTES_PER_FIELD_ELEMENT);
    const blobIndex = Math.floor(fieldIndex / FIELD_ELEMENTS_PER_PCASH_BLOB);
    const fieldInBlob = fieldIndex % FIELD_ELEMENTS_PER_PCASH_BLOB;
    const offset =
      fieldInBlob * FIELD_ELEMENT_BYTES + 1 + (index % PAYLOAD_BYTES_PER_FIELD_ELEMENT);
    const blob = blobs[blobIndex];
    if (blob === undefined) throw new Error("blob index overflow");
    blob[offset] = payload[index]!;
  }
  return blobs;
}

/** Decode only the one canonical PCASH representation of a nonempty batch. */
export function decodePcashBlobs(blobs: readonly Uint8Array[]): Uint8Array {
  if (blobs.length === 0) throw new Error("blob carrier contains no blobs");
  if (blobs.length > MAX_PCASH_BATCH_BLOBS) {
    throw new Error(`blob carrier contains more than ${MAX_PCASH_BATCH_BLOBS} blobs`);
  }
  for (const blob of blobs) {
    if (blob.length !== BYTES_PER_PCASH_BLOB) {
      throw new Error(`blob must contain exactly ${BYTES_PER_PCASH_BLOB} bytes`);
    }
  }

  const first = blobs[0]!;
  let encodedLength = 0n;
  for (let offset = 1; offset <= 8; offset += 1) {
    encodedLength = (encodedLength << 8n) | BigInt(first[offset]!);
  }
  if (encodedLength === 0n) throw new Error("blob payload must not be empty");
  if (encodedLength > BigInt(MAX_PCASH_BATCH_BYTES)) {
    throw new Error(`blob payload exceeds the ${MAX_PCASH_BATCH_BYTES}-byte batch limit`);
  }
  const length = Number(encodedLength);
  if (requiredPcashBlobCount(length) !== blobs.length) {
    throw new Error("blob carrier does not use the minimal blob count");
  }

  const payload = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    const fieldIndex = 1 + Math.floor(index / PAYLOAD_BYTES_PER_FIELD_ELEMENT);
    const blobIndex = Math.floor(fieldIndex / FIELD_ELEMENTS_PER_PCASH_BLOB);
    const fieldInBlob = fieldIndex % FIELD_ELEMENTS_PER_PCASH_BLOB;
    const offset =
      fieldInBlob * FIELD_ELEMENT_BYTES + 1 + (index % PAYLOAD_BYTES_PER_FIELD_ELEMENT);
    payload[index] = blobs[blobIndex]![offset]!;
  }

  const canonical = encodePcashBlobs(payload);
  for (let blobIndex = 0; blobIndex < blobs.length; blobIndex += 1) {
    const actual = blobs[blobIndex]!;
    const expected = canonical[blobIndex]!;
    for (let offset = 0; offset < BYTES_PER_PCASH_BLOB; offset += 1) {
      if (actual[offset] !== expected[offset]) {
        throw new Error("blob carrier is not the canonical PCASH encoding");
      }
    }
  }
  return payload;
}
