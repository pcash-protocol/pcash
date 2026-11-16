/** Closed metric labels shared by browser and Node wallet implementations. */
export type WalletMetricOutcome = "success" | "error";
export type WalletSyncMetricMode = "full" | "incremental";
export type WalletActionMetricType = "send" | "account" | "receive_key" | "custom";

export interface WalletSyncMetricContext {
  readonly account: string;
  readonly mode: WalletSyncMetricMode;
}

export interface WalletSyncMetricResult extends WalletSyncMetricContext {
  readonly outcome: WalletMetricOutcome;
  readonly durationSeconds: number;
  readonly outputsScanned: number;
  readonly trialDecryptAttempts: number;
  readonly decryptions: number;
  readonly recoveredNotes: number;
}

export interface WalletActionMetricContext {
  readonly account: string;
  readonly action: WalletActionMetricType;
}

export interface WalletActionMetricResult extends WalletActionMetricContext {
  readonly outcome: WalletMetricOutcome;
  readonly durationSeconds: number;
}

export interface WalletAccountMetricState {
  readonly account: string;
  readonly scanCursor: bigint | null;
  readonly nodeTip: bigint;
  readonly finalizedCursor: bigint | null;
  readonly noteCount: number;
  readonly pendingActionCount: number;
  readonly receiveKeyCount: number;
}

/**
 * Local operational instrumentation. Implementations must not transmit data or
 * throw into wallet work; the built-in browser default records nothing.
 */
export interface WalletMetrics {
  recordSyncStarted(context: WalletSyncMetricContext): void;
  recordSyncFinished(result: WalletSyncMetricResult): void;
  recordActionStarted(context: WalletActionMetricContext): void;
  recordActionFinished(result: WalletActionMetricResult): void;
  recordAccountState(state: WalletAccountMetricState): void;
  removeAccount(account: string): void;
}

export const NOOP_WALLET_METRICS: WalletMetrics = Object.freeze({
  recordSyncStarted: () => undefined,
  recordSyncFinished: () => undefined,
  recordActionStarted: () => undefined,
  recordActionFinished: () => undefined,
  recordAccountState: () => undefined,
  removeAccount: () => undefined,
});

/** Convert public extension names to a bounded metrics label. */
export function walletActionMetricType(name: string): WalletActionMetricType {
  switch (name) {
    case "send":
      return "send";
    case "account":
      return "account";
    case "receive-key":
      return "receive_key";
    default:
      return "custom";
  }
}
