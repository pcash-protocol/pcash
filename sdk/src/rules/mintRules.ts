// Mint rules a wallet recognizes. A rule is standard only when its complete
// ordered VK pair and its configuration opening match a standard rule; any
// other rule is custom, even when one of its keys is familiar.

import { ACCOUNT_MINT_RULE_VK_HASH, DEPOSIT_MINT_RULE_VK_HASH, FIXED_SUPPLY_RULE_VK_HASH } from "../constants/rulePins.ts";
import type { MintRule } from "../protocol/asset.ts";
import type { PortableMintRule } from "../protocol/assetDefinition.ts";
import { addressHex } from "../utils/hex.ts";
import {
  accountMintConfigurationCommitment,
  decodeAccountMintConfiguration,
  type AccountMintConfiguration,
} from "./accountMint.ts";
import {
  decodeDepositMintConfiguration,
  depositMintConfigurationCommitment,
  type DepositMintConfiguration,
} from "./depositMint.ts";
import {
  decodeFixedSupplyConfiguration,
  fixedSupplyConfigurationCommitment,
  type FixedSupplyConfiguration,
} from "./fixedSupply.ts";

export type RecognizedMintRule =
  | { kind: "fixed-supply"; configuration: FixedSupplyConfiguration }
  | { kind: "account-mint"; configuration: AccountMintConfiguration }
  | { kind: "deposit-mint"; configuration: DepositMintConfiguration }
  | { kind: "custom" };

function standardPair(rule: MintRule, vkHash: bigint): boolean {
  return rule.sVkHash === vkHash && rule.lVkHash === vkHash;
}

/** The deposit-mint rule has an S key only. */
function depositMintPair(rule: MintRule): boolean {
  return rule.sVkHash === DEPOSIT_MINT_RULE_VK_HASH && rule.lVkHash === 0n;
}

/** Whether a rule names the VK pair of a standard mint rule, whatever its configuration. */
export function namesStandardMintRule(rule: MintRule): boolean {
  return standardPair(rule, FIXED_SUPPLY_RULE_VK_HASH) || standardPair(rule, ACCOUNT_MINT_RULE_VK_HASH) || depositMintPair(rule);
}

export function recognizeMintRule(rule: PortableMintRule): RecognizedMintRule {
  if (standardPair(rule, FIXED_SUPPLY_RULE_VK_HASH)) {
    const configuration = decodeFixedSupplyConfiguration(rule.configuration);
    if (configuration !== undefined && fixedSupplyConfigurationCommitment(configuration) === rule.configurationCommitment) {
      return { kind: "fixed-supply", configuration };
    }
  } else if (standardPair(rule, ACCOUNT_MINT_RULE_VK_HASH)) {
    const configuration = decodeAccountMintConfiguration(rule.configuration);
    if (configuration !== undefined && accountMintConfigurationCommitment(configuration) === rule.configurationCommitment) {
      return { kind: "account-mint", configuration };
    }
  } else if (depositMintPair(rule)) {
    const configuration = decodeDepositMintConfiguration(rule.configuration);
    if (configuration !== undefined && depositMintConfigurationCommitment(configuration) === rule.configurationCommitment) {
      return { kind: "deposit-mint", configuration };
    }
  }
  return { kind: "custom" };
}

/** How a wallet names an asset's mint rule. The supply is in base units. */
export function mintRuleLabel(rule: PortableMintRule): string {
  const recognized = recognizeMintRule(rule);
  if (recognized.kind === "fixed-supply") return `fixed supply ${recognized.configuration.supply}`;
  if (recognized.kind === "account-mint") {
    return `minted at the discretion of account ${addressHex(recognized.configuration.accountAddress)}`;
  }
  if (recognized.kind === "deposit-mint") return `minted once per deposit to vault ${addressHex(recognized.configuration.vault)}`;
  return "custom mint rule";
}
