import { keccak_256 } from "@noble/hashes/sha3.js";
import { encodeRecords, decodeRecords, type TransactionData, type DataRecord, type ResolvedTransactionData } from "../protocol/records.ts";
import { validateDataRecords, validatePublicRecords } from "../protocol/arena.ts";
import { fromHex, toHex } from "../utils/hex.ts";
import { utf8 } from "../utils/bytes.ts";
import { resolveRecipientDelivery, type ReceiveKeyLookup } from "./recipient.ts";
import { parseExtendedCode } from "./extendedCode.ts";

export interface StoredTransactionData {
  recipients: { to: string; records: string }[];
  self: string;
  public: string;
}
/** Application boundary: reject ambiguous audiences and SDK-owned routing/recovery records. */
export function storeTransactionData(data: TransactionData | undefined): StoredTransactionData | undefined {
  if (data === undefined) return undefined;
  const records = (items: readonly DataRecord[] = []) => {
    validateDataRecords(items);
    return toHex(encodeRecords(items));
  };
  const seen = new Set<string>();
  const recipients = (data.recipients ?? []).map(({ to, records: items }) => {
    const identity = /^0x[0-9a-fA-F]{40}$/.test(to) ? to.toLowerCase() : to;
    if (seen.has(identity)) throw new Error("duplicate transaction data recipient");
    seen.add(identity);
    if (items.length === 0) throw new Error("recipient must have records");
    return { to: identity, records: records(items) };
  });
  if (recipients.length > 32) throw new Error("transaction data exceeds recipient capacity");
  validatePublicRecords(data.public ?? []);
  return { recipients, self: records(data.self), public: records(data.public) };
}
/** JSON stores may reorder object keys; retry identity depends only on record content and audience order. */
export function sameTransactionData(stored: StoredTransactionData | undefined, requested: TransactionData | undefined): boolean {
  const candidate = storeTransactionData(requested);
  if (stored === undefined || candidate === undefined) return stored === candidate;
  return stored.self === candidate.self
    && stored.public === candidate.public
    && stored.recipients.length === candidate.recipients.length
    && stored.recipients.every((recipient, index) => recipient.to === candidate.recipients[index]!.to
      && recipient.records === candidate.recipients[index]!.records);
}
export function restoreTransactionData(data: StoredTransactionData | undefined): TransactionData | undefined {
  return data === undefined ? undefined : {
    recipients: data.recipients.map(({ to, records }) => ({ to, records: decodeRecords(fromHex(records)) })),
    self: decodeRecords(fromHex(data.self)),
    public: decodeRecords(fromHex(data.public)),
  };
}
export function transactionDataHash(data: TransactionData | undefined): string | undefined {
  const stored = storeTransactionData(data);
  return stored === undefined ? undefined : toHex(keccak_256(utf8(JSON.stringify(stored))));
}
export async function resolveTransactionData(data: TransactionData | undefined, chainId: bigint, lookup: ReceiveKeyLookup): Promise<ResolvedTransactionData | undefined> {
  if (data === undefined) return undefined;
  data = restoreTransactionData(storeTransactionData(data))!;
  return { ...data, recipients: await Promise.all((data.recipients ?? []).map(async ({ to, records }) => {
    const resolved = await resolveRecipientDelivery(to, chainId, lookup);
    return { recipientAddress: resolved.recipientAddress, receiveKey: resolved.recipientReceiveKey ?? parseExtendedCode(resolved.recipientExtendedCode!).mlKemPublicKey, records };
  })) };
}
