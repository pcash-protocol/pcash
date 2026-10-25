// The reference account-rule profile: readable signing rules, the default rule
// set built from them, and the lockout-safety checks a wallet runs before it
// installs a rule set. A wallet choice, not consensus.

export {
  PAYMENT_EIP712_TYPE,
  paymentTypedData,
  buildPaymentRuleWitness,
} from "./readableRules.ts";
export type {
  PaymentMessage,
  PaymentRuleWitnessParams,
} from "./readableRules.ts";
export * from "./semanticRules.ts";
export * from "./semanticWitnesses.ts";
export {
  DEFAULT_USER_RULE_ENTRY_INDEX,
  DEFAULT_ASSET_CREATION_RULE_ENTRY_INDEX,
  DEFAULT_ASSET_PAYMENT_RULE_ENTRY_INDEX,
  DEFAULT_ASSET_BURN_RULE_ENTRY_INDEX,
  DEFAULT_BATCH_TRANSFER_RULE_ENTRY_INDEX,
  DEFAULT_LARGE_BATCH_TRANSFER_RULE_ENTRY_INDEX,
  DEFAULT_LARGE_ASSET_CREATION_RULE_ENTRY_INDEX,
  DEFAULT_LARGE_CONTRACT_FEE_RULE_ENTRY_INDEX,
  DEFAULT_ACCOUNT_ADMIN_RULE_ENTRY_INDEX,
  DEFAULT_CONTRACT_FEE_RULE_ENTRY_INDEX,
  DEFAULT_RULE_ENTRY_INDICES,
  ecdsaRuleConfigurationCommitment,
  referenceDomainSeparatorHalves,
  generateDefaultUserRuleSecrets,
  defaultUserAccountRuleSet,
  referenceConfigurationCommitment,
} from "./referenceRules.ts";
export type {
  DefaultUserAccountRule,
  DefaultUserAccountRuleSet,
  DefaultUserRuleSecrets,
} from "./referenceRules.ts";
export * from "./ruleSafety.ts";
