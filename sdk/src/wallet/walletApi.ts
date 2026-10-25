// High-level wallet entry point. Mutable persistence and aggregate documents
// stay behind Wallet; this surface contains only capabilities and read models.

export {
  Wallet,
  OPEN_WALLET_INTERNAL,
  type WalletAsset,
  type WalletAssetBurnIntent,
  type WalletAssetSendIntent,
  type WalletAuthorityOptions,
  type WalletBalance,
  type WalletBulkJob,
  type WalletBulkRecovery,
  type WalletBulkRecoveryChunk,
  type WalletBulkRecoveryRecipient,
  type WalletClientOptions,
  type WalletExecutionContext,
  type WalletNoteFilter,
  type WalletNoteSummary,
  type WalletNativeFunds,
  type WalletNotePayout,
  type WalletSnapshot,
  type WalletTransactionRecords,
  type WalletPaymentHistory,
  type SpendableWalletExecutionContext,
} from "./actions/walletClient.ts";
export {
  NOOP_WALLET_METRICS,
  type WalletAccountMetricState,
  type WalletActionMetricContext,
  type WalletActionMetricResult,
  type WalletActionMetricType,
  type WalletMetricOutcome,
  type WalletMetrics,
  type WalletSyncMetricContext,
  type WalletSyncMetricMode,
  type WalletSyncMetricResult,
} from "./metrics.ts";
export type {
  WalletActionEventContext,
  WalletActionLifecycle,
  WalletEventContext,
  WalletEventListener,
  WalletEventMap,
  WalletEventName,
  WalletEventWallet,
  WalletHookListener,
  WalletHookMap,
  WalletHookName,
  WalletPreparedEvent,
} from "./walletEvents.ts";
export {
  WalletCapabilityError,
  WalletReviewStaleError,
  type WalletBulkJobStepIntent,
  type WalletTransferPreflight,
  type WalletRuntimeProvers,
} from "./actions/walletRuntime.ts";
export type { AssetActionSubmissionResult } from "./actions/assetActionClient.ts";
export type { AssetSendOutput } from "./actions/assetTransferClient.ts";
export type { BulkJobRecoveryIntent, BulkJobStep } from "./actions/bulkJobClient.ts";
export {
  controlsSystemPayout,
  publicationOf,
  type ActionPublication,
  type IssuanceBeneficiary,
  type PublicationPlan,
  type PublicationMode,
} from "./actions/publication.ts";
export {
  isWalletSyncConflict,
  retryWhileSyncConflict,
} from "./actions/syncConflictRetry.ts";
export {
  waitForDefaultAccount,
} from "./actions/accountReady.ts";
export {
  assertPcashProfileAccount,
} from "./actions/scan.ts";
export type {
  DurableSubmissionAdapter,
  DurableSubmissionCallbacks,
  DurableSubmissionPhase,
  DurableSubmissionResult,
} from "./actions/durableSubmission.ts";
export {
  DurablePreBroadcastError,
  deferSubmission,
} from "./actions/durableSubmission.ts";
export {
  awaitingAcceptance,
  createL1SubmissionAdapter,
  createMempoolSubmissionAdapter,
  type AcceptanceWait,
  type L1Prepared,
  type L1SubmissionAdapter,
  type L1SubmissionHooks,
  type L1SubmissionOptions,
  type MempoolPrepared,
  type SubmissionOutput,
  type SubmissionPrepared,
} from "./submission.ts";
export {
  WalletConflictError,
} from "./store.ts";
export {
  walletAction,
  type WalletAction,
} from "./walletAction.ts";
export {
  EXTENDED_CODE_VERSION,
  buildExtendedCode,
  deterministicMlKemKeysFromApplicationSeed,
  parseExtendedCode,
  requireReceiveKeys,
  walletExtendedCode,
} from "./wallet.ts";
export type {
  WalletProfile,
  WalletProfileWithReceiveKeys,
} from "@pcash/sdk/protocol";
export type { PendingUserAccountCreation } from "./noteStore.ts";
export {
  assertPcashProfileMatchesAccount,
  assertPcashProfileMatchesAccountIdentity,
  derivePcashProfileFromPrivateKey,
  derivePcashProfileFromSignature,
  profileDerivationSigningRequest,
  requestPcashProfile,
  type PcashProfile,
} from "./externalIdentity.ts";
export {
  deriveSeedWalletIdentity,
  generateWalletMnemonic,
  normalizeWalletMnemonic,
  validateWalletMnemonic,
  WALLET_ETHEREUM_DERIVATION_PATH,
  type SeedWalletIdentity,
} from "./seedIdentity.ts";
export {
  receiveKeyHashHex,
} from "./receiveKeyring.ts";
export { keyedResourcePool } from "./resourcePool.ts";

export type { WalletSystemPayoutActivity, WalletNativeActivity, WalletNativeActivityEntry, WalletReceivedMessage, WalletSentOutput } from "./actions/nativeActivity.ts";

export { planNativeConsolidation, ConsolidationRequiredError, type ConsolidationPlan } from "./consolidation.ts";
