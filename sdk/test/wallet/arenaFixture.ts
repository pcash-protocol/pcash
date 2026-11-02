// Simulated transactions whose envelopes and arena come from the reference
// delivery path, so wallet tests can deliver records and sender regions
// without a full builder.

import { randomBytes } from "node:crypto";
import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "@pcash/sdk/constants";
import { fieldToHex } from "@pcash/sdk/crypto";
import {
  noteBodyCommitment,
  ownerCommitment,
  sealSectionDelivery,
  type ArenaSender,
  type AssetDefinition,
  type DataRecord,
  type SentOpening,
} from "@pcash/sdk/protocol";
import type { SimTransaction } from "@pcash/test-support/chain-sim";

/** An output sealed to `receiveKey` with these records in its region. */
export interface DeliveredOutput {
  receiveKey: Uint8Array;
  /** The note owner's address. */
  owner: bigint;
  amount: bigint;
  noteSecret?: bigint;
  assetId?: bigint;
  records?: readonly DataRecord[];
  /** Recorded in the sender region as a paid envelope to this address. */
  sentTo?: bigint;
}

const randomWord = (): string => fieldToHex(BigInt(`0x${randomBytes(31).toString("hex")}`)).toLowerCase();

/**
 * A simulated transaction: every delivered output sealed through
 * `sealSectionDelivery` against the transaction's own context. `nullifiers`
 * are completed with random words to the profile's input count.
 */
export function deliveredTransaction(params: {
  chainId: bigint;
  shape?: PrivateValueShape;
  nullifiers?: readonly string[];
  outputs: readonly (DeliveredOutput | { body: bigint; outputData: Uint8Array } | null)[];
  sender?: ArenaSender;
  sentOpenings?: readonly SentOpening[];
  assetDefinition?: AssetDefinition;
}): SimTransaction {
  const shape = params.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId;
  const profile = privateValueProfile(shape);
  const nullifiers = [...(params.nullifiers ?? [])];
  while (nullifiers.length < profile.inputs) nullifiers.push(randomWord());
  const notes = params.outputs.map((output) => output === null || "body" in output ? null : {
    ...output,
    noteSecret: output.noteSecret ?? BigInt(`0x${randomBytes(31).toString("hex")}`),
    assetId: output.assetId ?? 0n,
  });
  const delivery = sealSectionDelivery({
    shape,
    context: { chainId: params.chainId, transactionType: 0, nullifiers: nullifiers.map(BigInt) },
    envelopes: notes.flatMap((note, slot) => note === null ? [] : [{
      slot,
      receiveKey: note.receiveKey,
      note: { chainId: params.chainId, assetId: note.assetId, amount: note.amount, owner: note.owner, noteSecret: note.noteSecret },
      ...(note.records === undefined ? {} : { records: note.records }),
      ...(note.sentTo === undefined ? {} : { sentTo: note.sentTo }),
    }]),
    ...(params.sender === undefined ? {} : { sender: params.sender }),
    ...(params.sentOpenings === undefined ? {} : { sentOpenings: params.sentOpenings }),
    ...(params.assetDefinition === undefined ? {} : { assetDefinition: params.assetDefinition }),
  });
  return {
    shape,
    nullifiers,
    arena: delivery.arena,
    outputs: params.outputs.map((output, slot) => {
      const note = notes[slot];
      if (note === null || note === undefined) return output as { body: bigint; outputData: Uint8Array } | null;
      return {
        body: noteBodyCommitment(ownerCommitment(note.owner, note.noteSecret), note.assetId, note.amount),
        outputData: delivery.envelopes.get(slot)!,
      };
    }),
  };
}
