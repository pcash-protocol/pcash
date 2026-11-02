// Stateless recovery primitives for callers that do not own a Wallet instance,
// including synthetic contract wallets. Stateful applications should prefer
// Wallet.sync() and Wallet.notes().

export {
  assertPcashProfileAccount,
  outputScanBoundary,
  recoverSentTransaction,
  scanFeed,
  scanOutputPages,
  scanWallet,
  synchronizedThrough,
  type OutputScanReport,
  type RecoveredSentOutput,
  type RecoveredSentTransaction,
  type ScanArena,
  type ScanFeedItem,
  type ScanParams,
  type ScanReport,
  type ScanTransaction,
  type SpendableNote,
} from "./actions/scan.ts";
