import type { WalletMetrics } from "@pcash/sdk/wallet";

export type WalletHttpMetricMethod = "GET" | "POST" | "OTHER";

export type WalletHttpMetricRoute =
  | "/health"
  | "/status"
  | "/mempool"
  | "/relay-journal"
  | "/relay-journal/reconcile"
  | "/relay-journal/resolve"
  | "/code"
  | "/wallet"
  | "/wallets"
  | "/wallets/import"
  | "/receive-keys"
  | "/scan"
  | "/transfer"
  | "/bulk"
  | "/bulk/step"
  | "/assets"
  | "/assets/send"
  | "/assets/burn"
  | "/assets/import"
  | "/account"
  | "/relay"
  | "/unknown";

const WALLET_HTTP_ROUTES = new Set<WalletHttpMetricRoute>([
  "/health",
  "/status",
  "/mempool",
  "/relay-journal",
  "/relay-journal/reconcile",
  "/relay-journal/resolve",
  "/code",
  "/wallet",
  "/wallets",
  "/wallets/import",
  "/receive-keys",
  "/scan",
  "/transfer",
  "/bulk",
  "/bulk/step",
  "/assets",
  "/assets/send",
  "/assets/burn",
  "/assets/import",
  "/account",
  "/relay",
]);

export interface WalletHttpMetricResult {
  readonly method: WalletHttpMetricMethod;
  readonly route: WalletHttpMetricRoute;
  readonly status: number;
  readonly durationSeconds: number;
}

export interface WalletServiceMetrics extends WalletMetrics {
  setServiceHealth(healthy: boolean): void;
  setLoadedAccounts(count: number): void;
  recordHttpRequest(result: WalletHttpMetricResult): void;
}

export function normalizeWalletHttpMethod(method: string | undefined): WalletHttpMetricMethod {
  const normalized = method?.toUpperCase();
  return normalized === "GET" || normalized === "POST" ? normalized : "OTHER";
}

export function normalizeWalletHttpRoute(requestUrl: string | undefined): WalletHttpMetricRoute {
  let pathname: string;
  try {
    pathname = new URL(requestUrl ?? "/", "http://wallet.local").pathname;
  } catch {
    return "/unknown";
  }
  return WALLET_HTTP_ROUTES.has(pathname as WalletHttpMetricRoute)
    ? pathname as WalletHttpMetricRoute
    : "/unknown";
}
