// Narrow browser-application surface: the wallet-bound token application and
// its read models. Low-level template builders stay on the package root.

export {
  TokensApp,
  defaultTokensProver,
  type TokensActionOptions,
  type TokensAppOptions,
} from "./client/session.ts";
export {
  MemoryTokensStore,
  type DropRecord,
  type LinkSetRecord,
  type TokensRecord,
  type TokensStore,
} from "./client/store.ts";
export { TokensError, isTokensError, type TokensErrorCode } from "./client/errors.ts";
export type {
  TemplateSubmission,
  TokensPhase,
  TokensProgress,
  TokensProgressCallback,
} from "./client/action.ts";
export type {
  ClaimLinkInspection,
  ClaimLinkStatus,
  LinkClaimState,
  UnclaimedLinksClaim,
  LinkSetPhase,
  LinkSetStatus,
  LinkSetView,
  TokenClaimResult,
} from "./client/links.ts";
export { inspectLinkAtNode } from "./client/links.ts";
export type {
  AvailableDrop,
  DropEligibilityResult,
  DropEligibilityStatus,
  DropPhase,
  DropReclaimResult,
  DropStatus,
  DropView,
} from "./client/drops.ts";
export { availableDropsFromNode, dropEligibilityFromNode } from "./client/drops.ts";
export { TOKENS_CIRCUIT_PROFILES } from "./circuits.ts";
