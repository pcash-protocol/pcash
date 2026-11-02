import {
  Counter,
  collectDefaultMetrics,
  Gauge,
  Histogram,
  Registry,
  type RegistryContentType,
} from "prom-client";
import type {
  WalletAccountMetricState,
  WalletActionMetricContext,
  WalletActionMetricResult,
  WalletMetrics,
  WalletSyncMetricContext,
  WalletSyncMetricResult,
} from "@pcash/sdk/wallet";
import type {
  WalletHttpMetricResult,
  WalletServiceMetrics,
} from "./metricsTypes.ts";

const DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
const SYNC_MODES = ["full", "incremental"] as const;
const OUTCOMES = ["success", "error"] as const;
const ACTION_TYPES = ["send", "account", "receive_key", "custom"] as const;

function metricNumber(value: bigint | number): number {
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : Number.MAX_VALUE;
}

/** Node-only Prometheus/OpenMetrics recorder for wallet and service operation. */
export class PrometheusWalletMetrics implements WalletMetrics, WalletServiceMetrics {
  readonly registry: Registry<RegistryContentType>;

  readonly #syncAttempts: Counter<"account" | "mode">;
  readonly #syncOutcomes: Counter<"account" | "mode" | "outcome">;
  readonly #syncDuration: Histogram<"account" | "mode" | "outcome">;
  readonly #syncOutputs: Counter<"account" | "mode">;
  readonly #syncTrialDecryptAttempts: Counter<"account" | "mode">;
  readonly #syncDecryptions: Counter<"account" | "mode">;
  readonly #syncRecoveredNotes: Counter<"account" | "mode">;
  readonly #actionOutcomes: Counter<"account" | "action" | "outcome">;
  readonly #actionDuration: Histogram<"account" | "action" | "outcome">;
  readonly #actionsInFlight: Gauge<"account" | "action">;
  readonly #accountScanCursor: Gauge<"account">;
  readonly #accountNodeTipLag: Gauge<"account">;
  readonly #accountFinalizedCursor: Gauge<"account">;
  readonly #accountNotes: Gauge<"account">;
  readonly #accountPendingActions: Gauge<"account">;
  readonly #accountReceiveKeys: Gauge<"account">;
  readonly #serviceUp: Gauge;
  readonly #serviceLoadedAccounts: Gauge;
  readonly #httpRequests: Counter<"method" | "route">;
  readonly #httpResponses: Counter<"method" | "route" | "status">;
  readonly #httpErrors: Counter<"method" | "route" | "status">;
  readonly #httpDuration: Histogram<"method" | "route">;

  constructor(options: { registry?: Registry<RegistryContentType> } = {}) {
    this.registry = options.registry ?? new Registry<RegistryContentType>();
    this.registry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
    // @prometheus-io/client's stable releases postdate the configured package
    // resolution cutoff; keep this registry API isolated for the later swap.
    collectDefaultMetrics({ register: this.registry });
    const registers = [this.registry];
    this.#syncAttempts = new Counter({
      name: "pcash_wallet_sync_attempts_total",
      help: "Wallet synchronization attempts.",
      labelNames: ["account", "mode"],
      registers,
    });
    this.#syncOutcomes = new Counter({
      name: "pcash_wallet_sync_outcomes_total",
      help: "Completed wallet synchronizations by outcome.",
      labelNames: ["account", "mode", "outcome"],
      registers,
    });
    this.#syncDuration = new Histogram({
      name: "pcash_wallet_sync_duration_seconds",
      help: "Wallet synchronization duration in seconds.",
      labelNames: ["account", "mode", "outcome"],
      buckets: DURATION_BUCKETS,
      registers,
    });
    this.#syncOutputs = new Counter({
      name: "pcash_wallet_sync_outputs_scanned_total",
      help: "Canonical outputs inspected by wallet synchronization.",
      labelNames: ["account", "mode"],
      registers,
    });
    this.#syncTrialDecryptAttempts = new Counter({
      name: "pcash_wallet_sync_trial_decrypt_attempts_total",
      help: "ML-KEM envelope trial decryptions attempted by wallet synchronization.",
      labelNames: ["account", "mode"],
      registers,
    });
    this.#syncDecryptions = new Counter({
      name: "pcash_wallet_sync_decryptions_total",
      help: "Wallet scan outputs that decrypted and decoded.",
      labelNames: ["account", "mode"],
      registers,
    });
    this.#syncRecoveredNotes = new Counter({
      name: "pcash_wallet_sync_recovered_notes_total",
      help: "Notes recovered by wallet synchronization.",
      labelNames: ["account", "mode"],
      registers,
    });
    this.#actionOutcomes = new Counter({
      name: "pcash_wallet_action_outcomes_total",
      help: "Completed wallet actions by bounded action type and outcome.",
      labelNames: ["account", "action", "outcome"],
      registers,
    });
    this.#actionDuration = new Histogram({
      name: "pcash_wallet_action_duration_seconds",
      help: "Wallet action duration in seconds.",
      labelNames: ["account", "action", "outcome"],
      buckets: DURATION_BUCKETS,
      registers,
    });
    this.#actionsInFlight = new Gauge({
      name: "pcash_wallet_actions_in_flight",
      help: "Wallet actions currently in flight.",
      labelNames: ["account", "action"],
      registers,
    });
    this.#accountScanCursor = new Gauge({
      name: "pcash_wallet_account_scan_cursor",
      help: "Last canonical block folded by an account, or -1 before genesis.",
      labelNames: ["account"],
      registers,
    });
    this.#accountNodeTipLag = new Gauge({
      name: "pcash_wallet_account_node_tip_lag_blocks",
      help: "Number of blocks between an account scan cursor and the observed node tip.",
      labelNames: ["account"],
      registers,
    });
    this.#accountFinalizedCursor = new Gauge({
      name: "pcash_wallet_account_finalized_cursor",
      help: "Last finalized wallet cursor, or -1 before genesis.",
      labelNames: ["account"],
      registers,
    });
    this.#accountNotes = new Gauge({
      name: "pcash_wallet_account_notes",
      help: "Notes retained in an account inventory.",
      labelNames: ["account"],
      registers,
    });
    this.#accountPendingActions = new Gauge({
      name: "pcash_wallet_account_pending_actions",
      help: "Distinct pending actions retained by an account.",
      labelNames: ["account"],
      registers,
    });
    this.#accountReceiveKeys = new Gauge({
      name: "pcash_wallet_account_receive_keys",
      help: "Receive keys retained by an account for recovery.",
      labelNames: ["account"],
      registers,
    });
    this.#serviceUp = new Gauge({
      name: "pcash_wallet_service_up",
      help: "Whether the wallet HTTP service is accepting requests.",
      registers,
    });
    this.#serviceLoadedAccounts = new Gauge({
      name: "pcash_wallet_service_loaded_accounts",
      help: "Wallet accounts currently loaded by the service.",
      registers,
    });
    this.#httpRequests = new Counter({
      name: "pcash_wallet_http_requests_total",
      help: "Wallet HTTP requests by normalized method and route.",
      labelNames: ["method", "route"],
      registers,
    });
    this.#httpResponses = new Counter({
      name: "pcash_wallet_http_responses_total",
      help: "Wallet HTTP responses by normalized method, route, and status code.",
      labelNames: ["method", "route", "status"],
      registers,
    });
    this.#httpErrors = new Counter({
      name: "pcash_wallet_http_errors_total",
      help: "Wallet HTTP error responses by normalized method, route, and status code.",
      labelNames: ["method", "route", "status"],
      registers,
    });
    this.#httpDuration = new Histogram({
      name: "pcash_wallet_http_request_duration_seconds",
      help: "Wallet HTTP request duration in seconds.",
      labelNames: ["method", "route"],
      buckets: DURATION_BUCKETS,
      registers,
    });
    this.#serviceUp.set(0);
    this.#serviceLoadedAccounts.set(0);
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  recordSyncStarted(context: WalletSyncMetricContext): void {
    this.#syncAttempts.inc(context);
  }

  recordSyncFinished(result: WalletSyncMetricResult): void {
    const labels = { account: result.account, mode: result.mode, outcome: result.outcome };
    this.#syncOutcomes.inc(labels);
    this.#syncDuration.observe(labels, Math.max(0, result.durationSeconds));
    if (result.outcome === "success") {
      const context = { account: result.account, mode: result.mode };
      this.#syncOutputs.inc(context, Math.max(0, result.outputsScanned));
      this.#syncTrialDecryptAttempts.inc(context, Math.max(0, result.trialDecryptAttempts));
      this.#syncDecryptions.inc(context, Math.max(0, result.decryptions));
      this.#syncRecoveredNotes.inc(context, Math.max(0, result.recoveredNotes));
    }
  }

  recordActionStarted(context: WalletActionMetricContext): void {
    this.#actionsInFlight.inc(context);
  }

  recordActionFinished(result: WalletActionMetricResult): void {
    const context = { account: result.account, action: result.action };
    const labels = { ...context, outcome: result.outcome };
    this.#actionsInFlight.dec(context);
    this.#actionOutcomes.inc(labels);
    this.#actionDuration.observe(labels, Math.max(0, result.durationSeconds));
  }

  recordAccountState(state: WalletAccountMetricState): void {
    const labels = { account: state.account };
    const scanCursor = state.scanCursor ?? -1n;
    this.#accountScanCursor.set(labels, metricNumber(scanCursor));
    this.#accountNodeTipLag.set(labels, metricNumber(
      state.nodeTip > scanCursor ? state.nodeTip - scanCursor : 0n,
    ));
    this.#accountFinalizedCursor.set(labels, metricNumber(state.finalizedCursor ?? -1n));
    this.#accountNotes.set(labels, state.noteCount);
    this.#accountPendingActions.set(labels, state.pendingActionCount);
    this.#accountReceiveKeys.set(labels, state.receiveKeyCount);
  }

  removeAccount(account: string): void {
    for (const mode of SYNC_MODES) {
      const context = { account, mode };
      this.#syncAttempts.remove(context);
      this.#syncOutputs.remove(context);
      this.#syncTrialDecryptAttempts.remove(context);
      this.#syncDecryptions.remove(context);
      this.#syncRecoveredNotes.remove(context);
      for (const outcome of OUTCOMES) {
        const labels = { ...context, outcome };
        this.#syncOutcomes.remove(labels);
        this.#syncDuration.remove(labels);
      }
    }
    for (const action of ACTION_TYPES) {
      const context = { account, action };
      this.#actionsInFlight.remove(context);
      for (const outcome of OUTCOMES) {
        const labels = { ...context, outcome };
        this.#actionOutcomes.remove(labels);
        this.#actionDuration.remove(labels);
      }
    }
    const labels = { account };
    this.#accountScanCursor.remove(labels);
    this.#accountNodeTipLag.remove(labels);
    this.#accountFinalizedCursor.remove(labels);
    this.#accountNotes.remove(labels);
    this.#accountPendingActions.remove(labels);
    this.#accountReceiveKeys.remove(labels);
  }

  setServiceHealth(healthy: boolean): void {
    this.#serviceUp.set(healthy ? 1 : 0);
  }

  setLoadedAccounts(count: number): void {
    this.#serviceLoadedAccounts.set(Math.max(0, count));
  }

  recordHttpRequest(result: WalletHttpMetricResult): void {
    const context = { method: result.method, route: result.route };
    const status = Number.isInteger(result.status) && result.status >= 100 && result.status <= 599
      ? String(result.status)
      : "unknown";
    const labels = { ...context, status };
    this.#httpRequests.inc(context);
    this.#httpResponses.inc(labels);
    if (result.status >= 400) this.#httpErrors.inc(labels);
    this.#httpDuration.observe(context, Math.max(0, result.durationSeconds));
  }
}

export function createPrometheusWalletMetrics(
  options: { registry?: Registry<RegistryContentType> } = {},
): PrometheusWalletMetrics {
  return new PrometheusWalletMetrics(options);
}
