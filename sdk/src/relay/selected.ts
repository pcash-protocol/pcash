import { privateValueProfile } from "../constants/privateValueProfiles.ts";
import type { StatusResult } from "../clients/nodeClient.ts";
import { decodeTransactionForChain, sectionPublicInput,
  TX_KIND_PRIVATE_VALUE, TX_KIND_USER_ACCOUNT_UPDATE,
  transactionPublication } from "../protocol/codec.ts";
import { decodePayload, decryptEnvelope } from "../protocol/envelope.ts";
import { noteBodyCommitment, ownerCommitment } from "../protocol/notes.ts";
import { issuancePayoutOpening } from "../protocol/payout.ts";

/**
 * Value a ready mempool transaction using only this relayer's private receive key.
 * Every counted note is an exact native output in the proof's public statement;
 * other encrypted outputs, including those to this relayer, are allowed.
 */
export function inspectPrivateRelayValue(params: {
  transactionBytes: Uint8Array;
  status: Pick<StatusResult, "pcashChainId">;
  recipient: { address: bigint; nkRoot: bigint; mlKemSecretKey: Uint8Array };
}): { nativeAmount: bigint; issuanceOwnerCommitment: bigint | null; nativeOutputSlots: number[] } {
  const decoded = decodeTransactionForChain(params.transactionBytes, params.status.pcashChainId);
  const section = decoded.kind === TX_KIND_PRIVATE_VALUE ? decoded
    : decoded.kind === TX_KIND_USER_ACCOUNT_UPDATE ? decoded.section : null;
  if (section === null) return { nativeAmount: 0n, issuanceOwnerCommitment: null, nativeOutputSlots: [] };
  const terms = transactionPublication(decoded)!;
  const profile = privateValueProfile(terms.shape);
  const owner = params.recipient.address;
  let nativeAmount = 0n;
  const nativeOutputSlots: number[] = [];
  for (const [slot, output] of section.outputData.entries()) {
    const plaintext = decryptEnvelope(params.recipient.mlKemSecretKey, output);
    if (plaintext === null) continue;
    let note: ReturnType<typeof decodePayload>;
    try { note = decodePayload(plaintext, { chainId: params.status.pcashChainId }); }
    catch { continue; }
    if (note.owner !== owner || note.outputIndex !== slot || note.assetId !== 0n) continue;
    const commitment = ownerCommitment(note.owner, note.noteSecret);
    if (noteBodyCommitment(commitment, 0n, note.amount) !== sectionPublicInput(section, profile.offsets.outputs + slot)) continue;
    nativeAmount += note.amount;
    nativeOutputSlots.push(slot);
  }
  const designated = decoded.kind === TX_KIND_PRIVATE_VALUE && terms.issuanceOwnerCommitment !== 0n
    ? issuancePayoutOpening(owner, params.recipient.nkRoot, params.status.pcashChainId, terms.nullifiers, terms.shape)
    : null;
  return {
    nativeAmount,
    issuanceOwnerCommitment: designated?.ownerCommitment === terms.issuanceOwnerCommitment
      ? designated.ownerCommitment : null,
    nativeOutputSlots,
  };
}
