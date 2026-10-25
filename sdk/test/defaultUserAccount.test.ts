import { describe, expect, it } from "vitest";
import { defaultEcdsaRuleSet } from "../src/builders/index.ts";
import { buildAccountRuleSet } from "../src/protocol/account.ts";
import { nullifierKeyCommitment } from "../src/protocol/notes.ts";
import {
  DEFAULT_RULE_ENTRY_INDICES,
  DEFAULT_USER_RULE_ENTRY_INDEX,
  DEFAULT_ASSET_PAYMENT_RULE_ENTRY_INDEX,
  DEFAULT_ASSET_BURN_RULE_ENTRY_INDEX,
  DEFAULT_BATCH_TRANSFER_RULE_ENTRY_INDEX,
  DEFAULT_ACCOUNT_ADMIN_RULE_ENTRY_INDEX,
  DEFAULT_CONTRACT_FEE_RULE_ENTRY_INDEX,
  defaultUserAccountRuleSet,
  ecdsaRuleConfigurationCommitment,
} from "../src/rules/referenceRules.ts";
import {
  ADMIN_RULE_VK_HASH,
  ASSET_BURN_RULE_VK_HASH,
  ASSET_PAYMENT_RULE_VK_HASH,
  BATCH_TRANSFER_RULE_VK_HASH,
  CONTRACT_FEE_SPONSORSHIP_RULE_VK_HASH,
  PAYMENT_RULE_VK_HASH,
} from "../src/constants/rulePins.ts";
import { deriveTestWallet } from "./testWallet.ts";
import { TEST_DEFAULT_RULE_SECRETS } from "@pcash/test-support/protocol-fixtures";

import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
const wallet = deriveTestWallet({
  privKey: new Uint8Array(32).fill(7),
  nkRoot: 71n,
});

describe("default user account", () => {
  it("contains all default ECDSA rules", () => {
    const rules = defaultUserAccountRuleSet({
      wallet,
      secrets: TEST_DEFAULT_RULE_SECRETS,
    });
    // Every reference rule commits the same signing domain and nullifier key.
    const configurationCommitment = ecdsaRuleConfigurationCommitment(
      DEFAULT_NETWORK_CONFIG,
      nullifierKeyCommitment(wallet.nkRoot),
    );

    // One blinder per rule, every scalar independent.
    const secrets = Object.values(TEST_DEFAULT_RULE_SECRETS);
    expect(new Set(secrets).size).toBe(secrets.length);
    expect(secrets.length).toBe(DEFAULT_RULE_ENTRY_INDICES.length);

    // Payment rule at entry 0 — the wallet's default interactive signing path.
    expect(rules.rule.entryIndex).toBe(DEFAULT_USER_RULE_ENTRY_INDEX);
    expect(rules.rule.applicationVkHash).toBe(
      PAYMENT_RULE_VK_HASH,
    );
    expect(rules.rule.configurationCommitment).toBe(configurationCommitment);
    expect(rules.rule.commitmentBlinder).toBe(
      TEST_DEFAULT_RULE_SECRETS.paymentCommitmentBlinder,
    );
    expect(rules.rule.siblings).toHaveLength(8);

    // Batch rule uses an independently sampled blinder.
    expect(rules.batchTransferRule.entryIndex).toBe(DEFAULT_BATCH_TRANSFER_RULE_ENTRY_INDEX);
    expect(rules.batchTransferRule.applicationVkHash).toBe(
      BATCH_TRANSFER_RULE_VK_HASH,
    );
    expect(rules.batchTransferRule.configurationCommitment).toBe(configurationCommitment);
    expect(rules.batchTransferRule.commitmentBlinder).toBe(
      TEST_DEFAULT_RULE_SECRETS.batchTransferCommitmentBlinder,
    );
    expect(rules.batchTransferRule.siblings).toHaveLength(8);

    expect(rules.assetPaymentRule.entryIndex).toBe(DEFAULT_ASSET_PAYMENT_RULE_ENTRY_INDEX);
    expect(rules.assetPaymentRule.applicationVkHash).toBe(
      ASSET_PAYMENT_RULE_VK_HASH,
    );
    expect(rules.assetBurnRule.entryIndex).toBe(DEFAULT_ASSET_BURN_RULE_ENTRY_INDEX);
    expect(rules.assetBurnRule.applicationVkHash).toBe(
      ASSET_BURN_RULE_VK_HASH,
    );
    expect(rules.accountAdminRule.entryIndex).toBe(DEFAULT_ACCOUNT_ADMIN_RULE_ENTRY_INDEX);
    expect(rules.accountAdminRule.applicationVkHash).toBe(
      ADMIN_RULE_VK_HASH,
    );
    expect(rules.contractFeeSponsorshipRule.entryIndex).toBe(DEFAULT_CONTRACT_FEE_RULE_ENTRY_INDEX);
    expect(rules.contractFeeSponsorshipRule.applicationVkHash).toBe(
      CONTRACT_FEE_SPONSORSHIP_RULE_VK_HASH,
    );

    // Every reserved index is occupied exactly once.
    const allRules = [
      rules.rule,
      rules.assetPaymentRule,
      rules.assetBurnRule,
      rules.batchTransferRule,
      rules.largeBatchTransferRule,
      rules.largeAssetCreationRule,
      rules.largeContractFeeSponsorshipRule,
      rules.accountAdminRule,
      rules.contractFeeSponsorshipRule,
      rules.assetCreationRule,
    ];
    expect(allRules.map((rule) => rule.entryIndex).sort((a, b) => a - b))
      .toEqual([...DEFAULT_RULE_ENTRY_INDICES]);
    for (const rule of allRules) expect(rule.siblings).toHaveLength(8);

    // The set commitment is the depth-8 root over every installed rule.
    expect(
      buildAccountRuleSet(allRules.map((rule) => ({
        entryIndex: rule.entryIndex,
        accountRuleEntryCommitment: rule.accountRuleEntryCommitment,
      }))).accountRuleSetCommitment,
    ).toBe(rules.accountRuleSetCommitment);
  });

  it("is the root reconstructed by an ordinary native transfer", () => {
    const rules = defaultUserAccountRuleSet({
      wallet,
      secrets: TEST_DEFAULT_RULE_SECRETS,
    });
    const native = defaultEcdsaRuleSet({
      wallet,
      secrets: TEST_DEFAULT_RULE_SECRETS,
    });

    expect(native.ruleSetCommitment).toBe(rules.accountRuleSetCommitment);
    expect(native.ruleWitness.slot).toBe(rules.rule.entryIndex);
    expect(native.ruleWitness.siblings).toEqual(rules.rule.siblings);
  });

  it("reconstructs from durable secrets and changes when one instance secret changes", () => {
    const first = defaultUserAccountRuleSet({
      wallet,
      secrets: TEST_DEFAULT_RULE_SECRETS,
    });
    const restored = defaultUserAccountRuleSet({
      wallet,
      secrets: { ...TEST_DEFAULT_RULE_SECRETS },
    });
    const changed = defaultUserAccountRuleSet({
      wallet,
      secrets: {
        ...TEST_DEFAULT_RULE_SECRETS,
        batchTransferCommitmentBlinder: 0x1ffn,
      },
    });
    expect(restored).toEqual(first);
    expect(changed.accountRuleSetCommitment).not.toBe(first.accountRuleSetCommitment);
  });

  it("accepts a zero commitment blinder", () => {
    const rules = defaultUserAccountRuleSet({
      wallet,
      secrets: { ...TEST_DEFAULT_RULE_SECRETS, paymentCommitmentBlinder: 0n },
    });
    expect(rules.rule.commitmentBlinder).toBe(0n);
  });
});
