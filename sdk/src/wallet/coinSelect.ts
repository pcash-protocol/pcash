import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";

// Profile-bounded coin selection. A transfer spends up to its input capacity,
// so a wallet can cover a target from several notes and consolidate dust. This
// picks the subset (size 1..maxInputs) that covers `need` with the least overage,
// preferring MORE notes on ties so small notes are opportunistically consolidated.
// Reused by the CLI, the browser wallet, and marketplace funding.

/** Any note with a spendable `amount`; carries whatever identity the caller needs. */
interface AmountNote {
  amount: bigint;
}

/** Maximum spendable in one transfer: the sum of the largest `maxInputs` notes. */
export function maxSpendable<T extends AmountNote>(notes: readonly T[], maxInputs: number = PRIVATE_VALUE_PROFILES.S.inputs): bigint {
  return [...notes]
    .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0))
    .slice(0, maxInputs)
    .reduce((s, n) => s + n.amount, 0n);
}

interface Best<T> {
  overage: bigint;
  count: number;
  total: bigint;
  selected: T[];
}

/**
 * Select 0..`maxInputs` notes covering `need`, minimizing overage (total − need)
 * and, on ties, preferring more notes (dust consolidation). A zero need selects
 * nothing: an action that spends and pays nothing conserves value with an empty
 * input set, whatever the wallet holds. Returns `null` when
 * the largest `maxInputs` notes still can't cover `need`. The candidate pool is
 * bounded (largest few + smallest many) so the exact search stays fast for large
 * inventories while keeping both coverage (largest) and tightness/dust (smallest).
 * Up to four inputs use exact search within this pool. Larger capacities use
 * bounded greedy trials, not exponential subset enumeration; coverage remains
 * guaranteed by the largest-input baseline, but optimal overage is not promised.
 */
export function selectNotes<T extends AmountNote>(
  notes: readonly T[],
  need: bigint,
  maxInputs: number = PRIVATE_VALUE_PROFILES.S.inputs,
): { selected: T[]; total: bigint } | null {
  if (need < 0n) throw new Error("coin selection need must be nonnegative");
  if (!Number.isSafeInteger(maxInputs) || maxInputs < 1 || maxInputs > 64) throw new Error("maxInputs must be an integer in 1..64");
  if (need === 0n) return { selected: [], total: 0n };
  const desc = [...notes].sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
  if (desc.length === 0) return null;
  if (desc.slice(0, maxInputs).reduce((sum, note) => sum + note.amount, 0n) < need) return null; // infeasible

  // Bounded candidate pool: the maxInputs largest (guarantee coverage) plus the
  // smallest notes (tighten overage / consolidate dust), capped so the exact
  // subset search is O(pool^maxInputs) with a small pool.
  const CAP = Math.max(48, maxInputs);
  let pool = desc;
  if (desc.length > CAP) {
    const smallCount = CAP - maxInputs;
    pool = [...desc.slice(0, maxInputs), ...desc.slice(desc.length - smallCount)];
  }
  const n = pool.length;
  let best: Best<T> | null = null;
  const consider = (idxs: number[]): void => {
    let total = 0n;
    for (const i of idxs) total += pool[i]!.amount;
    if (total < need) return;
    const overage = total - need;
    if (
      best === null ||
      overage < best.overage ||
      (overage === best.overage && idxs.length > best.count)
    ) {
      best = { overage, count: idxs.length, total, selected: idxs.map((i) => pool[i]!) };
    }
  };
  if (maxInputs > 4) {
    // The baseline guarantees coverage even when no heuristic finds a tight set.
    consider(Array.from({ length: Math.min(maxInputs, n) }, (_, i) => i));
    for (let start = 0; start < n; start++) {
      for (const reverse of [false, true]) {
        const order = Array.from({ length: n }, (_, i) => reverse ? n - 1 - i : i);
        const selected = [start];
        let total = pool[start]!.amount;
        for (const index of order) {
          if (total >= need || selected.length === maxInputs) break;
          if (index === start) continue;
          selected.push(index);
          total += pool[index]!.amount;
        }
        consider(selected);
      }
    }
    return best === null ? null : { selected: (best as Best<T>).selected, total: (best as Best<T>).total };
  }
  for (let i = 0; i < n; i++) {
    consider([i]);
    if (maxInputs < 2) continue;
    for (let j = i + 1; j < n; j++) {
      consider([i, j]);
      if (maxInputs < 3) continue;
      for (let k = j + 1; k < n; k++) {
        consider([i, j, k]);
        if (maxInputs < 4) continue;
        for (let l = k + 1; l < n; l++) consider([i, j, k, l]);
      }
    }
  }
  return best === null ? null : { selected: (best as Best<T>).selected, total: (best as Best<T>).total };
}
