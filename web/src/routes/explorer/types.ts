// View-model types for the explorer. Every wire shape now comes from
// `@pcash/sdk/clients`; only what this page renders lives here.

export type Hex = `0x${string}`;

export type {
  ContractOrigin,
  ContractSourceBundle,
  ContractSourceView,
  ImplementationSourceFile,
  ImplementationSourceView,
  PublishedConfigurationOpening,
  PublishedConfigurationValue,
  PublishedImplementation,
  SourceVerificationInfo,
  StatusResult,
  VerifiedContract,
} from "@pcash/sdk/clients";

/** One installed function of a published contract. */
export type ContractFunctionRecord =
  import("@pcash/sdk/clients").VerifiedContract["functions"][number];
