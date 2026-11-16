// Demonstration-only account rules. These helpers deliberately remain outside
// the SDK's product barrels: their opaque action approvals are useful circuit
// examples, not signing patterns PCASH products recommend or install.

export * from "../builders/authorizationRules.ts";
export * from "../builders/assetCovenant.ts";
export * from "../builders/multisigRule.ts";
export {
  multisigRuleConfigurationCommitment,
  referenceMultisigApprovalDigest,
} from "../rules/referenceRules.ts";
