import { type FieldNumberish, toField } from "../crypto/field.ts";
import { buildAccountRuleSet, accountRuleEntryCommitment } from "../protocol/account.ts";
import {
  ADMIN_RULE_VK_HASH,
  ASSET_BURN_RULE_VK_HASH,
  ASSET_CREATION_RULE_VK_HASH,
  ASSET_PAYMENT_RULE_VK_HASH,
  BATCH_TRANSFER_RULE_VK_HASH,
  CONTRACT_FEE_SPONSORSHIP_RULE_VK_HASH,
  LARGE_ASSET_CREATION_RULE_VK_HASH,
  LARGE_BATCH_TRANSFER_RULE_VK_HASH,
  LARGE_CONTRACT_FEE_SPONSORSHIP_RULE_VK_HASH,
  PAYMENT_RULE_VK_HASH,
} from "../constants/rulePins.ts";

/** WalletProfile interpretation of an inspected circuit and opened configuration. */
export type ReferenceWalletActionClass =
  | "native-payment"
  | "privateValue-account-wide"
  /**
   * Authorizes durable one-shot application state — an APPLICATION marker — in
   * addition to moving value. A rule in this class either cannot show the signer
   * what state effect they are approving, or approves any effect by design. It is
   * deliberately NOT part of `privateValue-account-wide`: the readable
   * full-transaction rule refuses these markers, and presenting the two as
   * equivalent would describe blind signing as ordinary spending.
   */
  | "application-state"
  | "account-admin"
  /** Pays the fee for an authenticated Contract Account's action. */
  | "contract-fee-sponsorship"
  /** Pays or burns one standard asset namespace. */
  | "asset-value"
  | "asset-creation";

export interface InspectedUserAccountRule {
  entryIndex: number;
  applicationVkHash: FieldNumberish;
  configurationCommitment: FieldNumberish;
  commitmentBlinder: FieldNumberish;
}

export interface ReferenceWalletRuleInspection {
  entries: readonly InspectedUserAccountRule[];
  /** The recovery contract the wallet may truthfully present for this rule set. */
  recovery:
    | {
        /** A built-in deterministic profile recovered from its Ethereum signer or mnemonic. */
        kind: "ethereum-signature-derived" | "seed-derived";
      }
    | {
        /** A separately exported seed or package intended to survive loss of the Ethereum key. */
        kind: "independent";
        /** True only after restoring all required material from that independent backup. */
        backupVerified: boolean;
      };
}

export interface IrreversibleRuleOverride {
  /** Exact actions the user acknowledges the resulting rule set cannot perform. */
  acknowledgedMissingActionClasses: readonly ReferenceWalletActionClass[];
  /** Required when an independent recovery profile has not passed a restore check. */
  acknowledgeUnverifiedIndependentRecovery?: true;
}

export interface ReferenceWalletRuleSafetyInput {
  expectedRuleSetCommitment: FieldNumberish;
  inspection: ReferenceWalletRuleInspection;
  irreversibleOverride?: IrreversibleRuleOverride;
}

export interface ValidatedReferenceWalletRuleSet {
  ruleSetCommitment: bigint;
  entries: ReadonlyArray<{
    entryIndex: number;
    accountRuleEntryCommitment: bigint;
    siblings: bigint[];
  }>;
  missingActionClasses: ReferenceWalletActionClass[];
}

const DEFAULT_REQUIRED_ACTION_CLASSES = [
  "privateValue-account-wide",
  "account-admin",
  "contract-fee-sponsorship",
] as const;
/** Coverage derived only from an exact repository-pinned implementation identity. */
export function referenceWalletActionCoverage(
  applicationVkHash: FieldNumberish,
): readonly ReferenceWalletActionClass[] {
  const hash = toField(applicationVkHash, "applicationVkHash");
  if (hash === ASSET_CREATION_RULE_VK_HASH || hash === LARGE_ASSET_CREATION_RULE_VK_HASH) return ["asset-creation"];
  if (hash === PAYMENT_RULE_VK_HASH) return ["native-payment"];
  if (hash === ASSET_PAYMENT_RULE_VK_HASH) return ["asset-value"];
  if (hash === ASSET_BURN_RULE_VK_HASH) return ["asset-value"];
  if (hash === BATCH_TRANSFER_RULE_VK_HASH || hash === LARGE_BATCH_TRANSFER_RULE_VK_HASH) {
    return ["privateValue-account-wide", "native-payment", "asset-value"];
  }
  if (hash === ADMIN_RULE_VK_HASH) return ["account-admin"];
  if (hash === CONTRACT_FEE_SPONSORSHIP_RULE_VK_HASH || hash === LARGE_CONTRACT_FEE_SPONSORSHIP_RULE_VK_HASH) {
    return ["contract-fee-sponsorship"];
  }
  return [];
}

function normalizedActionClasses(actions: readonly ReferenceWalletActionClass[]): ReferenceWalletActionClass[] {
  return [...new Set(actions)].sort();
}

/**
 * Reference-wallet lockout check. This consumes wallet inspection results only;
 * neither the action-class labels nor the override are part of consensus or wire data.
 */
export function validateReferenceWalletRuleSet(
  input: ReferenceWalletRuleSafetyInput,
): ValidatedReferenceWalletRuleSet {
  if (input.inspection.entries.length === 0) {
    throw new Error("inspected user rule set must contain at least one rule");
  }
  const entries = input.inspection.entries.map((entry) => ({
    entryIndex: entry.entryIndex,
    accountRuleEntryCommitment: accountRuleEntryCommitment(
      entry.applicationVkHash,
      entry.configurationCommitment,
      entry.commitmentBlinder,
    ),
    derivedActionClasses: referenceWalletActionCoverage(entry.applicationVkHash),
  }));
  const set = buildAccountRuleSet(entries);
  const expected = toField(
    input.expectedRuleSetCommitment,
    "expectedRuleSetCommitment",
  );
  if (set.accountRuleSetCommitment !== expected) {
    throw new Error("inspected entries do not reconstruct expectedRuleSetCommitment");
  }

  const availableActionClasses = new Set(entries.flatMap((entry) => entry.derivedActionClasses));
  const missingActionClasses = normalizedActionClasses(
    DEFAULT_REQUIRED_ACTION_CLASSES.filter((role) => !availableActionClasses.has(role)),
  );
  const overrideActionClasses = normalizedActionClasses(
    input.irreversibleOverride?.acknowledgedMissingActionClasses ?? [],
  );
  if (missingActionClasses.join(",") !== overrideActionClasses.join(",")) {
    throw new Error(
      missingActionClasses.length === 0
        ? "irreversible override names actions that are not missing"
        : `user rule set is missing verified ${missingActionClasses.join(", ")} path(s)`,
    );
  }
  if (
    input.inspection.recovery.kind === "independent"
    && !input.inspection.recovery.backupVerified
    && input.irreversibleOverride?.acknowledgeUnverifiedIndependentRecovery !== true
  ) {
    throw new Error("independent user rule set recovery backup has not been verified");
  }

  return {
    ruleSetCommitment: expected,
    entries: entries.map((entry) => ({
      entryIndex: entry.entryIndex,
      accountRuleEntryCommitment: entry.accountRuleEntryCommitment,
      siblings: set.membership(entry.entryIndex).siblings,
    })),
    missingActionClasses,
  };
}
