import { claimedSenderSchema } from "../src/protocol/arena.ts";
import { RECORD_SCHEMA, type ResolvedTransactionData } from "../src/protocol/records.ts";
import { parseExtendedCode } from "../src/delivery/extendedCode.ts";
import type { FieldNumberish } from "../src/crypto/field.ts";

export function memoData(params: { recipientAddress?: FieldNumberish; recipientReceiveKey?: Uint8Array; recipientExtendedCode?: string; wallet: { address: bigint; mlKemPublicKey?: Uint8Array } }, memo?: Uint8Array, includeSender = false): ResolvedTransactionData {
  const code = params.recipientExtendedCode === undefined ? undefined : parseExtendedCode(params.recipientExtendedCode);
  return { recipients: [{ recipientAddress: BigInt(params.recipientAddress ?? code!.address), receiveKey: params.recipientReceiveKey ?? code?.mlKemPublicKey ?? params.wallet.mlKemPublicKey!, records: [
    ...memo === undefined ? [] : [{ schema: RECORD_SCHEMA.memo, data: memo }], ...includeSender ? [claimedSenderSchema.encode(params.wallet.address)] : [],
  ] }] };
}
