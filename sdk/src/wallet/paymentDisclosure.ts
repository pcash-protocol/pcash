// A payment disclosure opens one output of a payment for someone else. Its key
// is the output's envelope secret, which the payer's sender region records and
// the recipient derives when it decrypts, so either party can hand it out. The
// holder reads that output's note and records and nothing else of either
// wallet, and checks the opening against the output commitment on chain.

import { isFinalized, OutputOpeningMismatchError, pollReceipt, type PcashNodeClient } from "@pcash/sdk/clients";
import {
  claimedSenderSchema,
  decodeTransaction,
  discloseOutput,
  memoSchema,
  noteBodyCommitment,
  outputCommitment,
  ownerCommitment,
  RECORD_SCHEMA,
  TX_KIND_PRIVATE_VALUE,
  TX_KIND_USER_ACCOUNT_UPDATE,
  type DataRecord,
} from "@pcash/sdk/protocol";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { addressHex, fromHex } from "@pcash/sdk/utils";

/** One output of a payment, opened for someone else. */
export interface PaymentDisclosure {
  /** Keccak-256 of the paying transaction's exact bytes. */
  contentHash: string;
  /** The output's slot in that transaction. */
  slot: number;
  /** The output's disclosure key (0x-hex), which opens its envelope and records. */
  disclosureKey: string;
}

/** What a node shows of a disclosed output; needs no wallet. */
export type DisclosedPayment =
  | { status: "pending" }
  /** Included without succeeding; a later inclusion of the same bytes can still succeed. */
  | { status: "rejected" }
  | {
    status: "landed";
    transactionId: string;
    /** Ethereum finalized the block that included the payment. */
    finalized: boolean;
    /** The address the output pays, lowercase 0x-hex. */
    recipient: string;
    assetId: bigint;
    amount: bigint;
    memo?: string;
    /** The address the payer wrote as its own. Unauthenticated: a payer can write any address. */
    sender?: string;
  }
  /** The key does not open that output, or what it opens does not match the chain. */
  | { status: "invalid" };

const BYTES_32 = /^0x[0-9a-fA-F]{64}$/;

export async function inspectPaymentDisclosure(node: PcashNodeClient, disclosure: PaymentDisclosure): Promise<DisclosedPayment> {
  const { contentHash, slot, disclosureKey } = disclosure;
  if (!BYTES_32.test(contentHash) || !BYTES_32.test(disclosureKey) || !Number.isInteger(slot) || slot < 0) return { status: "invalid" };
  // Finality read first: a receipt read later is final only below it, so a
  // reorganization between the reads can't mark a newer inclusion final.
  const status = await node.status();
  const receipt = await pollReceipt(node, contentHash);
  if (receipt === null) return { status: "pending" };
  if (receipt.outcome !== "succeeded" || receipt.outputLeafStart === null || receipt.nullifiers === null) return { status: "rejected" };
  if (BigInt(slot) >= receipt.outputsAdded) return { status: "invalid" };
  const found = await node.getTransaction(receipt.transactionId);
  if (found === null) return { status: "pending" };
  const transaction = decodeTransaction(fromHex(found.rawTransaction));
  // An account update pays its fee from a private-value section in the S profile.
  const section = transaction.kind === TX_KIND_PRIVATE_VALUE
    ? { transactionType: transaction.kind, shape: transaction.shape, arena: transaction.arena, outputData: transaction.outputData }
    : transaction.kind === TX_KIND_USER_ACCOUNT_UPDATE
      ? { transactionType: transaction.kind, shape: PRIVATE_VALUE_PROFILES.S.shapeId, arena: transaction.section.arena, outputData: transaction.section.outputData }
      : null;
  if (section === null) return { status: "invalid" };
  const opened = discloseOutput({
    arena: section.arena,
    shape: section.shape,
    context: { chainId: BigInt(status.pcashChainId), transactionType: section.transactionType, nullifiers: receipt.nullifiers.map(BigInt) },
    sharedSecret: fromHex(disclosureKey),
    slot,
    outputData: section.outputData,
  });
  if (opened === null) return { status: "invalid" };
  const { note } = opened;
  const leafIndex = receipt.outputLeafStart + BigInt(slot);
  try {
    const commitment = outputCommitment(noteBodyCommitment(ownerCommitment(note.owner, note.noteSecret), note.assetId, note.amount), leafIndex);
    if (await node.getOutputPaths([{ outputIndex: leafIndex, outputCommitment: commitment }]) === null) return { status: "pending" };
  } catch (error) {
    if (error instanceof OutputOpeningMismatchError) return { status: "invalid" };
    throw error;
  }
  return {
    status: "landed",
    transactionId: receipt.transactionId,
    finalized: isFinalized(receipt.inclusion.l1BlockNumber, status),
    recipient: addressHex(note.owner),
    assetId: note.assetId,
    amount: note.amount,
    ...disclosedMessage(opened.records ?? []),
  };
}

function disclosedMessage(records: readonly DataRecord[]): { memo?: string; sender?: string } {
  const memo = records.find((record) => record.schema === RECORD_SCHEMA.memo);
  const sender = records.find((record) => record.schema === RECORD_SCHEMA.sender);
  try {
    return {
      ...(memo === undefined ? {} : { memo: memoSchema.decode(memo.data) }),
      ...(sender === undefined ? {} : { sender: addressHex(claimedSenderSchema.decode(sender.data)) }),
    };
  } catch {
    // The payer wrote these records; one that does not decode shows nothing.
    return {};
  }
}
