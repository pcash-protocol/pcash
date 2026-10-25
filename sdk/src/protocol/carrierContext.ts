import { CARRIER_CONTEXT_DOMAIN } from "../constants/domainTags.ts";
import { poseidon } from "../crypto/poseidon2.ts";
import { bytesToBigInt } from "../utils/bytes.ts";
import { fromHexSized } from "../utils/hex.ts";
import { logDataChunks } from "./l1Logs.ts";

/** A transaction posted by an Inbox transaction: the sender vouches, with an empty context. */
export const CARRIER_KIND_INBOX = 0;
/** A transaction posted by a `PcashBatch` event: the emitter vouches, with the event's context. */
export const CARRIER_KIND_EVENT = 1;

export type CarrierKind = typeof CARRIER_KIND_INBOX | typeof CARRIER_KIND_EVENT;

/**
 * The carrier context a transaction can require: one sponge over the kind, the
 * vouching address, the context length, and the context as log-data chunks.
 */
export function carrierContextHash(kind: CarrierKind, address: `0x${string}`, context: Uint8Array): bigint {
  return poseidon([
    CARRIER_CONTEXT_DOMAIN,
    BigInt(kind),
    bytesToBigInt(fromHexSized(address, 20, "address")),
    BigInt(context.length),
    ...logDataChunks(context),
  ]);
}
