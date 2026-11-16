import { describe, expect, it } from "vitest";
import {
  referenceWalletActionCoverage,
  validateReferenceWalletRuleSet,
  type InspectedUserAccountRule,
} from "../src/rules/ruleSafety.ts";
import { buildAccountRuleSet, accountRuleEntryCommitment } from "../src/protocol/account.ts";
import {
  ADMIN_RULE_VK_HASH,
  ASSET_BURN_RULE_VK_HASH,
  ASSET_PAYMENT_RULE_VK_HASH,
  BATCH_TRANSFER_RULE_VK_HASH,
  CONTRACT_FEE_SPONSORSHIP_RULE_VK_HASH,
  PAYMENT_RULE_VK_HASH,
} from "../src/constants/rulePins.ts";

function entry(entryIndex: number, applicationVkHash: bigint): InspectedUserAccountRule {
  return {
    entryIndex,
    applicationVkHash,
    configurationCommitment: BigInt(0x100 + entryIndex),
    commitmentBlinder: BigInt(0x200 + entryIndex),
  };
}

function root(entries: readonly InspectedUserAccountRule[]): bigint {
  return buildAccountRuleSet(entries.map((rule) => ({
    entryIndex: rule.entryIndex,
    accountRuleEntryCommitment: accountRuleEntryCommitment(
      rule.applicationVkHash,
      rule.configurationCommitment,
      rule.commitmentBlinder,
    ),
  }))).accountRuleSetCommitment;
}

const payment = entry(0, PAYMENT_RULE_VK_HASH);
const assetPayment = entry(1, ASSET_PAYMENT_RULE_VK_HASH);
const assetBurn = entry(2, ASSET_BURN_RULE_VK_HASH);
const batch = entry(3, BATCH_TRANSFER_RULE_VK_HASH);
const admin = entry(4, ADMIN_RULE_VK_HASH);
const sponsorship = entry(5, CONTRACT_FEE_SPONSORSHIP_RULE_VK_HASH);
const defaults = [payment, assetPayment, assetBurn, batch, admin, sponsorship];

describe("reference-wallet rule safety", () => {
  it("derives narrow and account-wide coverage from exact pinned rule identities", () => {
    expect(referenceWalletActionCoverage(PAYMENT_RULE_VK_HASH)).toEqual(["native-payment"]);
    expect(referenceWalletActionCoverage(BATCH_TRANSFER_RULE_VK_HASH))
      .toEqual(["privateValue-account-wide", "native-payment", "asset-value"]);
    expect(referenceWalletActionCoverage(ASSET_PAYMENT_RULE_VK_HASH)).toEqual(["asset-value"]);
    expect(referenceWalletActionCoverage(ASSET_BURN_RULE_VK_HASH)).toEqual(["asset-value"]);
    expect(referenceWalletActionCoverage(ADMIN_RULE_VK_HASH)).toEqual(["account-admin"]);
    expect(referenceWalletActionCoverage(CONTRACT_FEE_SPONSORSHIP_RULE_VK_HASH))
      .toEqual(["contract-fee-sponsorship"]);
  });

  it("rejects payment plus administration without account-wide spending", () => {
    const nativeOnly = [payment, admin, sponsorship];
    expect(() => validateReferenceWalletRuleSet({
      expectedRuleSetCommitment: root(nativeOnly),
      inspection: { entries: nativeOnly, recovery: { kind: "ethereum-signature-derived" } },
    })).toThrow(/missing verified privateValue-account-wide/);
  });

  it("accepts batch account-wide plus administration", () => {
    const accountWide = [batch, admin, sponsorship];
    expect(validateReferenceWalletRuleSet({
      expectedRuleSetCommitment: root(accountWide),
      inspection: { entries: accountWide, recovery: { kind: "ethereum-signature-derived" } },
    }).missingActionClasses).toEqual([]);
  });

  it("does not accept caller-asserted coverage for an unknown implementation", () => {
    const unknown = [{
      ...entry(7, 0x777n),
      verifiedActionClasses: ["privateValue-account-wide", "account-admin"],
    }];
    expect(referenceWalletActionCoverage(0x777n)).toEqual([]);
    expect(() => validateReferenceWalletRuleSet({
      expectedRuleSetCommitment: root(unknown),
      inspection: { entries: unknown, recovery: { kind: "ethereum-signature-derived" } },
    })).toThrow(/missing verified account-admin, contract-fee-sponsorship, privateValue-account-wide/);
  });

  it("requires the exact irreversible override for missing account-wide authority", () => {
    const nativeOnly = [payment, admin, sponsorship];
    expect(validateReferenceWalletRuleSet({
      expectedRuleSetCommitment: root(nativeOnly),
      inspection: { entries: nativeOnly, recovery: { kind: "ethereum-signature-derived" } },
      irreversibleOverride: {
        acknowledgedMissingActionClasses: ["privateValue-account-wide"],
      },
    }).missingActionClasses).toEqual(["privateValue-account-wide"]);
    expect(() => validateReferenceWalletRuleSet({
      expectedRuleSetCommitment: root(defaults),
      inspection: { entries: defaults, recovery: { kind: "ethereum-signature-derived" } },
      irreversibleOverride: {
        acknowledgedMissingActionClasses: ["privateValue-account-wide"],
      },
    })).toThrow(/actions that are not missing/);
  });

  it("rejects a mismatched root and an unverified independent recovery backup", () => {
    expect(() => validateReferenceWalletRuleSet({
      expectedRuleSetCommitment: root(defaults) + 1n,
      inspection: { entries: defaults, recovery: { kind: "ethereum-signature-derived" } },
    })).toThrow(/do not reconstruct/);
    expect(() => validateReferenceWalletRuleSet({
      expectedRuleSetCommitment: root(defaults),
      inspection: { entries: defaults, recovery: { kind: "independent", backupVerified: false } },
    })).toThrow(/recovery backup has not been verified/);
  });
});
