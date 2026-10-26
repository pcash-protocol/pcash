import type { BatchExclusionReason, ItemExclusionReason } from "@pcash/sdk/clients";
import { TRANSACTION_OUTCOMES, type TransactionOutcome } from "@pcash/sdk/protocol";

const DEFAULT_MARKETPLACE_ETH_PRICE_WEI = 1_000_000_000_000_000n;
/** One router buy pays and carries its claim's batch in calldata and in a log. */
const BUY_GAS_RESERVE = 2_000_000n;

/** What the node must report for one seed item: a transaction outcome, or the reason the item was never admitted. */
export type ExpectedOutcome = TransactionOutcome | ItemExclusionReason;

export function isItemExclusion(expected: ExpectedOutcome): expected is ItemExclusionReason {
  return !(TRANSACTION_OUTCOMES as readonly string[]).includes(expected);
}

export type SeedCarrier = "calldata" | "blobs";

export interface SeedWaveDescriptor {
  index: number;
  id: string;
  purpose: string;
  carrier: SeedCarrier;
  requiredLabels: readonly string[];
  entries: readonly SeedWavePlanEntry[];
}

export interface SeedWavePlanEntry {
  label: string;
  expectedOutcome: ExpectedOutcome;
  /** Override the wave carrier for controls whose bytes cannot use the wave default. */
  carrier?: SeedCarrier;
}

const entry = (
  label: string,
  expectedOutcome: ExpectedOutcome = "succeeded",
  carrier?: SeedCarrier,
): SeedWavePlanEntry => ({ label, expectedOutcome, ...(carrier === undefined ? {} : { carrier }) });

/**
 * Entry order within a wave is batch order. Several controls depend on it: an
 * entry that must reach a late check (proof verification, the identical
 * receive-key check) is placed before the succeeding entry whose state change
 * would make an earlier check fire instead.
 */
const SEED_WAVES: readonly SeedWaveDescriptor[] = [
  {
    index: 0,
    id: "accounts-contracts",
    purpose: "accounts, source contracts, a private vault, and creation controls",
    carrier: "calldata",
    requiredLabels: [
      "account-s",
      "account-r",
      "account-m",
      "account-o",
      "paid-offer:contract",
      "unpaid-offer:contract",
    ],
    entries: [
      entry("account-s"),
      entry("account-r"),
      entry("account-m"),
      entry("account-o"),
      entry("account-k"),
      entry("paid-offer:contract"),
      entry("unpaid-offer:contract"),
      entry("private-vault:contract"),
      entry("unfunded-vault:contract"),
      entry("control-account-already-exists", "accountAlreadyExists"),
      entry("control-account-bad-signature", "invalidAccountSignature"),
      entry("control-account-y-parity", "unknownYParity"),
      entry("control-account-receive-key-mode", "unknownReceiveKeyMode"),
      entry("control-account-stale-window", "recentPcashBlockNotInWindow"),
      entry("control-account-expired", "expired"),
      entry("control-contract-address-exists", "contractAddressExists"),
      entry("control-contract-attachment-tag", "unknownAccountCreationTag"),
      entry("control-contract-nk-root-flag", "unknownPublishesNkRootFlag"),
      entry("control-contract-noncanonical-field", "nonCanonicalContractField"),
      entry("control-contract-empty-functions", "emptyContractFunctionSet"),
      entry("control-contract-selector-order", "selectorsNotStrictlyIncreasing"),
      entry("control-unknown-kind", "unknownKind"),
    ],
  },
  {
    index: 1,
    id: "initial-funding",
    purpose: "S earns native issuance by publishing its own action, funds M with notes, and M makes a note-funded payment",
    carrier: "calldata",
    requiredLabels: ["earn-s", "fund-m", "transfer-m-self"],
    entries: [entry("earn-s"), entry("fund-m"), entry("transfer-m-self")],
  },
  {
    index: 2,
    id: "notes-repeated-earning",
    purpose: "parallel address deliveries, repeated self-published earning, and private-value controls",
    carrier: "calldata",
    requiredLabels: ["transfer-s-r", "transfer-m-r", "earn-s-again"],
    entries: [
      entry("transfer-s-r"),
      entry("control-proof-rejected", "proofRejected"),
      entry("control-transfer-output-byte-zero", "proofRejected"),
      entry("transfer-m-r"),
      entry("earn-s-again"),
      entry("control-nullifier-reuse", "nullifierAlreadySpent"),
      entry("control-transfer-stale-window", "recentPcashBlockNotInWindow"),
      entry("control-transfer-expired", "expired"),
      entry("control-transfer-not-yet-valid", "notYetValid"),
      entry("control-transfer-carrier-context", "carrierContextMismatch"),
      entry("control-transfer-zero-nullifier", "zeroNullifier"),
      entry("control-transfer-duplicate-nullifier", "duplicateInputNullifier"),
      entry("control-transfer-public-input-not-in-field", "publicInputNotInField"),
      entry("control-wrong-chain-id", "wrongChainId"),
      entry("control-empty-item", "empty"),
      entry("control-truncated-item", "truncated"),
      entry("control-trailing-bytes-item", "trailingBytes"),
      entry("control-item-too-large", "itemTooLarge", "blobs"),
    ],
  },
  {
    index: 3,
    id: "change-multi-paid-funding",
    purpose: "change, multi-input delivery to recordless X, and paid escrow funding",
    carrier: "calldata",
    requiredLabels: ["transfer-s-change-r", "transfer-r-x", "paid-offer:fund"],
    entries: [entry("transfer-s-change-r"), entry("transfer-r-x"), entry("paid-offer:fund")],
  },
  {
    index: 4,
    id: "x-activation-marketplace",
    purpose: "X activation, unpaid escrow funding, and account update controls before a real update",
    carrier: "calldata",
    requiredLabels: ["account-x", "unpaid-offer:fund", "update-r-receive-key"],
    entries: [
      entry("account-x"),
      entry("unpaid-offer:fund"),
      entry("control-update-noncanonical-field", "nonCanonicalAccountField"),
      entry("control-update-stale-window", "recentPcashBlockNotInWindow"),
      entry("control-update-expired", "expired"),
      entry("control-update-account-not-found", "accountNotFound"),
      entry("control-update-wrong-kind", "wrongAccountKind"),
      entry("control-update-clear-without-key", "clearWithoutReceiveKey"),
      entry("control-update-commitment", "accountUpdateCommitmentMismatch"),
      entry("control-update-proof-rejected", "proofRejected"),
      entry("update-r-receive-key"),
    ],
  },
  {
    index: 5,
    id: "x-spend",
    purpose: "post-activation X spend and identical receive-key replay",
    carrier: "blobs",
    requiredLabels: ["transfer-x-s"],
    entries: [
      entry("transfer-x-s"),
      entry("control-update-identical-key", "replaceWithIdenticalReceiveKey"),
    ],
  },
];

export const SEED_WAVE_COUNT = SEED_WAVES.length;

export function seedWave(index: number): SeedWaveDescriptor {
  const wave = SEED_WAVES[index];
  if (wave === undefined || wave.index !== index) throw new Error(`unknown rich seed wave ${index}`);
  return wave;
}

/** Whole L1 carriers the node must reject, posted after the waves. */
export const EXCLUDED_CARRIER_CONTROLS: readonly { label: string; reason: BatchExclusionReason }[] = [
  { label: "carrier-unsupported-version", reason: "unsupportedBatchVersion" },
  { label: "carrier-trailing-bytes", reason: "trailingBatchBytes" },
];

/** Every outcome the wave plan commits to observing. The asset lifecycle adds its own nullifier reuse. */
export function plannedOutcomes(): ReadonlySet<ExpectedOutcome> {
  return new Set(SEED_WAVES.flatMap((wave) => wave.entries.map((planned) => planned.expectedOutcome)));
}

export function nonzeroSeedQuotient(value: bigint, divisor: bigint): bigint | null {
  if (value < 0n || divisor < 1n) {
    throw new Error("rich seed quotient requires a nonnegative value and positive divisor");
  }
  const quotient = value / divisor;
  return quotient === 0n ? null : quotient;
}

/** One percent of the payment, or nothing when the payment is too small to carry a fee. */
export function seedFee(amount: bigint): bigint {
  return nonzeroSeedQuotient(amount, 100n) ?? 0n;
}

export function freshSeedActorFunding(params: {
  maxFeePerGas: bigint;
  marketplaceEthPriceWei?: bigint;
}): { M: bigint } {
  return {
    M: BUY_GAS_RESERVE * params.maxFeePerGas
      + (params.marketplaceEthPriceWei ?? DEFAULT_MARKETPLACE_ETH_PRICE_WEI),
  };
}
