import { privateValueTransactionSize } from "@pcash/sdk/protocol";
import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "@pcash/sdk/constants";
import { BATCH_HEADER_BYTES, ITEM_LENGTH_PREFIX_BYTES } from "@pcash/sdk/relay";
import { U128_LIMIT } from "@pcash/sdk/utils";

export interface ConsolidationPlan {
  shape: PrivateValueShape;
  transactions: number;
  /** Dependency depth; independent merges within a round can share a batch. */
  rounds: number;
  feePerTransaction: bigint;
  estimatedFees: bigint;
  maximumSpendableAfter: bigint;
  remainingNotes: number;
  requiredAmount: bigint | null;
  canCover: boolean;
  batchBytesPerTransaction: number;
  /** A self-published merge adds one issuance note to this wallet. */
  issuanceNotePerTransaction: boolean;
}

/**
 * Plan profile-bounded merges. A self-published merge names this wallet's own
 * commitment, which one issuance note pays; it counts toward inventory but
 * contributes zero forecast funding.
 */
export function planNativeConsolidation(amounts: readonly bigint[], feePerTransaction: bigint, requiredAmount?: bigint, assumptions: { shape?: PrivateValueShape; issuanceNote?: boolean; targetNotes?: number } = {}): ConsolidationPlan {
  const shape = assumptions.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId;
  const profile = privateValueProfile(shape);
  const targetNotes = assumptions.targetNotes ?? PRIVATE_VALUE_PROFILES.S.inputs;
  if (!Number.isSafeInteger(targetNotes) || targetNotes < 1) throw new Error("targetNotes must be a positive integer");
  const issuanceNote = assumptions.issuanceNote === true;
  if (feePerTransaction < 0n || (requiredAmount !== undefined && requiredAmount < 0n)) throw new Error("consolidation amounts must be nonnegative");
  const inventory = amounts.filter((amount) => amount > 0n).map((amount) => ({ amount, round: 0 }));
  let transactions = 0;
  let rounds = 0;
  const maximumSpendable = () => inventory.slice(0, PRIVATE_VALUE_PROFILES.S.inputs)
    .reduce((sum, note) => sum + note.amount, 0n);
  const done = () => requiredAmount === undefined ? inventory.length <= targetNotes : maximumSpendable() >= requiredAmount;
  while (true) {
    // done() and the group below both take the largest notes first.
    inventory.sort((a, b) => a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0);
    if (done() || inventory.length <= 1) break;
    if (requiredAmount !== undefined && inventory.reduce((sum, note) => sum + note.amount, 0n) < requiredAmount) break;
    const group = inventory.slice(0, profile.inputs);
    const merged = group.reduce((sum, note) => sum + note.amount, 0n) - feePerTransaction;
    if (merged <= 0n) break;
    const maximumAmount = U128_LIMIT - 1n;
    const outputCount = Number((merged + maximumAmount - 1n) / maximumAmount);
    const resultingCount = outputCount + Number(issuanceNote);
    if (outputCount > profile.outputs || resultingCount >= group.length) break;
    const round = 1 + Math.max(...group.map(note => note.round));
    rounds = Math.max(rounds, round);
    let remainder = merged;
    const outputs = Array.from({ length: outputCount }, () => {
      const amount = remainder > maximumAmount ? maximumAmount : remainder;
      remainder -= amount;
      return { amount, round };
    });
    inventory.splice(0, group.length, ...outputs);
    if (issuanceNote) inventory.push({ amount: 0n, round });
    transactions += 1;
  }
  return { shape, transactions, rounds, feePerTransaction, estimatedFees: BigInt(transactions) * feePerTransaction,
    maximumSpendableAfter: maximumSpendable(), remainingNotes: inventory.length,
    requiredAmount: requiredAmount ?? null, canCover: done(), issuanceNotePerTransaction: issuanceNote, batchBytesPerTransaction: Number(BATCH_HEADER_BYTES + ITEM_LENGTH_PREFIX_BYTES) + privateValueTransactionSize(shape) };
}

export class ConsolidationRequiredError extends Error {
  readonly plan: ConsolidationPlan;
  constructor(plan: ConsolidationPlan) {
    super(`This spend needs note consolidation (${plan.transactions} ordinary transactions estimated).`);
    this.name = "ConsolidationRequiredError";
    this.plan = plan;
  }
}
