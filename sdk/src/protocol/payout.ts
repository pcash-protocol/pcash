import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
import {
  PAYOUT_SEED_DOMAIN,
  PAYOUT_TX_CONTEXT_DOMAIN,
  PAYOUT_NOTE_SECRET_DOMAIN,
} from "../constants/domainTags.ts";
import { type FieldNumberish, toField } from "../crypto/field.ts";
import { poseidon } from "../crypto/poseidon2.ts";
import { uintBelow, U32_LIMIT, U160_LIMIT } from "../utils/validate.ts";
import { decodeTransactionForChain, transactionPublication } from "./codec.ts";
import { noteNk, ownerCommitment } from "./notes.ts";

export const PayoutRole = { POSTER: 2, ISSUANCE: 3 } as const;
export type PayoutRoleValue = typeof PayoutRole[keyof typeof PayoutRole];

/** Payout provenance: a designated transaction destination or a poster aggregate. */
export type PayoutSourceKind = "designatedIssuance" | "posterPayout";
export type PayoutComponent = "openFee" | "issuance";

export function payoutRoleForSourceKind(sourceKind: PayoutSourceKind): PayoutRoleValue {
  return sourceKind === "designatedIssuance" ? PayoutRole.ISSUANCE : PayoutRole.POSTER;
}

/** Recovery material for USER accounts whose nkRoot remains secret. */
export function payoutSeed(nkRoot: FieldNumberish): bigint {
  return poseidon([PAYOUT_SEED_DOMAIN, noteNk(nkRoot)]);
}

export function payoutTransactionContext(chainId: FieldNumberish, nullifiers: readonly FieldNumberish[], shape: PrivateValueShape = PRIVATE_VALUE_PROFILES.S.shapeId): bigint {
  const profile = privateValueProfile(shape);
  if (nullifiers.length !== profile.inputs) throw new Error(`payout context requires ${profile.inputs} nullifiers`);
  return poseidon([
    PAYOUT_TX_CONTEXT_DOMAIN,
    uintBelow(chainId, U32_LIMIT, "chainId"),
    BigInt(profile.shapeId), BigInt(profile.inputs), BigInt(profile.outputs),
    ...nullifiers.map((value) => toField(value, "nullifier")),
  ]);
}

export function payoutNoteSecret(seed: FieldNumberish, role: PayoutRoleValue, context: FieldNumberish): bigint {
  if (role !== PayoutRole.POSTER && role !== PayoutRole.ISSUANCE) {
    throw new Error("unknown payout role");
  }
  return poseidon([PAYOUT_NOTE_SECRET_DOMAIN, toField(seed), BigInt(role), toField(context)]);
}

export interface PayoutOpening {
  context: bigint;
  noteSecret: bigint;
  ownerCommitment: bigint;
}

export function issuancePayoutOpening(
  owner: FieldNumberish,
  nkRoot: FieldNumberish,
  chainId: FieldNumberish,
  nullifiers: readonly FieldNumberish[],
  shape: PrivateValueShape = PRIVATE_VALUE_PROFILES.S.shapeId,
): PayoutOpening {
  const context = payoutTransactionContext(chainId, nullifiers, shape);
  const noteSecret = payoutNoteSecret(payoutSeed(nkRoot), PayoutRole.ISSUANCE, context);
  return { context, noteSecret, ownerCommitment: ownerCommitment(owner, noteSecret) };
}

/** `posterContext` is any field element the poster chooses and carries in the batch header. */
export function posterPayoutOpening(owner: FieldNumberish, nkRoot: FieldNumberish, posterContext: FieldNumberish): PayoutOpening {
  const context = toField(posterContext, "posterContext");
  const noteSecret = payoutNoteSecret(payoutSeed(nkRoot), PayoutRole.POSTER, context);
  return { context, noteSecret, ownerCommitment: ownerCommitment(owner, noteSecret) };
}

/**
 * Seed-only recovery of one payout note: the first node-supplied context whose
 * derived commitment matches. Designated records carry their transaction
 * context; poster records carry every contributing batch context, including
 * copied ones, so each is tried.
 */
export function recoverPayoutOpening(
  recovery: { owner: FieldNumberish; seed: FieldNumberish },
  payout: { sourceKind: PayoutSourceKind; ownerCommitment: FieldNumberish; contexts: readonly FieldNumberish[] },
): { owner: bigint; noteSecret: bigint } | null {
  const owner = uintBelow(recovery.owner, U160_LIMIT, "owner");
  const target = toField(payout.ownerCommitment, "ownerCommitment");
  const role = payoutRoleForSourceKind(payout.sourceKind);
  for (const context of payout.contexts) {
    const noteSecret = payoutNoteSecret(recovery.seed, role, context);
    if (ownerCommitment(owner, noteSecret) === target) return { owner, noteSecret };
  }
  return null;
}

/**
 * The opening of a transaction designated to `recipient`'s seed-derived
 * issuance commitment for that transaction's own section context, or null when
 * the transaction is open, designated elsewhere, or has no private-value section.
 */
export function controlledIssuanceOpening(
  entry: Uint8Array,
  chainId: FieldNumberish,
  recipient: { address: FieldNumberish; nkRoot: FieldNumberish },
): PayoutOpening | null {
  const publication = transactionPublication(decodeTransactionForChain(entry, chainId));
  if (publication === null || publication.issuanceOwnerCommitment === 0n) return null;
  const opening = issuancePayoutOpening(recipient.address, recipient.nkRoot, chainId, publication.nullifiers, publication.shape);
  return opening.ownerCommitment === publication.issuanceOwnerCommitment ? opening : null;
}

/** One-time opening supplied by the issuance recipient through an authenticated quote. */
export interface DesignatedIssuanceOpening {
  recipientAddress: FieldNumberish;
  noteSecret: FieldNumberish;
  transactionContext: FieldNumberish;
}

export function authorizationIssuanceOpening(
  issuanceOwnerCommitment: FieldNumberish,
  chainId: FieldNumberish,
  nullifiers: readonly FieldNumberish[],
  opening?: DesignatedIssuanceOpening,
  shape: PrivateValueShape = PRIVATE_VALUE_PROFILES.S.shapeId,
): { issuanceRecipient: bigint; issuanceNoteSecret: bigint; transactionContext: bigint } {
  const commitment = toField(issuanceOwnerCommitment, "issuanceOwnerCommitment");
  const transactionContext = payoutTransactionContext(chainId, nullifiers, shape);
  if (commitment === 0n) {
    if (opening !== undefined) throw new Error("open issuance cannot contain a designated recipient opening");
    return { issuanceRecipient: 0n, issuanceNoteSecret: 0n, transactionContext };
  }
  if (opening === undefined) throw new Error("designated issuance requires its authenticated quote opening");
  const issuanceRecipient = uintBelow(opening.recipientAddress, U160_LIMIT, "issuance recipient address");
  const issuanceNoteSecret = toField(opening.noteSecret, "issuance note secret");
  if (ownerCommitment(issuanceRecipient, issuanceNoteSecret) !== commitment) {
    throw new Error("designated issuance opening does not match issuanceOwnerCommitment");
  }
  if (toField(opening.transactionContext) !== transactionContext) throw new Error("issuance quote transaction context mismatch");
  return { issuanceRecipient, issuanceNoteSecret, transactionContext };
}
