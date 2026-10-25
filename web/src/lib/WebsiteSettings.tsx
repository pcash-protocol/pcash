import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

export type SubmissionMode = "fast" | "slow";
export interface WebsitePreferences {
  ensEnabled: boolean;
  defaultSubmissionMode: SubmissionMode;
}
export const WEBSITE_SETTINGS_KEY = "pcash-website-settings";
const defaults: WebsitePreferences = { ensEnabled: true, defaultSubmissionMode: "slow" };

export class WebsiteSettingsStore {
  private state = defaults;
  private listeners = new Set<() => void>();
  constructor(private storage: () => Storage) {}
  getSnapshot = () => this.state;
  getServerSnapshot = () => defaults;
  getDefaultSubmissionMode = () => this.state.defaultSubmissionMode;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  restore = () => {
    let next = defaults;
    try {
      // Browser storage can be edited by the user or another tab.
      const saved: unknown = JSON.parse(this.storage().getItem(WEBSITE_SETTINGS_KEY) ?? "null");
      if (saved !== null && typeof saved === "object" && "ensEnabled" in saved && typeof saved.ensEnabled === "boolean"
        && "defaultSubmissionMode" in saved && (saved.defaultSubmissionMode === "fast" || saved.defaultSubmissionMode === "slow")) {
        next = { ensEnabled: saved.ensEnabled, defaultSubmissionMode: saved.defaultSubmissionMode };
      }
    } catch { /* Missing or unavailable storage uses the defaults. */ }
    this.publish(next);
  };
  private publish(next: WebsitePreferences) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  private update(change: Partial<WebsitePreferences>) {
    const next = { ...this.state, ...change };
    try { this.storage().setItem(WEBSITE_SETTINGS_KEY, JSON.stringify(next)); } catch { /* Preferences still apply in this tab. */ }
    this.publish(next);
  }
  setEnsEnabled = (ensEnabled: boolean) => this.update({ ensEnabled });
  setDefaultSubmissionMode = (defaultSubmissionMode: SubmissionMode) => this.update({ defaultSubmissionMode });
}

/** An Ethereum RPC in this browser's list. One that is off stays listed but is not read from. */
export interface L1RpcChoice { url: string; enabled: boolean }
/**
 * How this browser's Ethereum RPC list differs from the deployment's. Only the
 * differences are kept, so the rest of the list keeps following the deployment.
 */
export interface L1RpcChanges { added: L1RpcChoice[]; paused: string[]; removed: string[] }
/** Endpoints this browser uses in place of the deployment's defaults. */
export interface RpcEndpoints { pcashRpcUrl?: string; l1Rpcs?: L1RpcChanges }

/** The deployment's Ethereum RPCs as this browser changed them, then the ones it added. */
export function l1RpcList(deployment: readonly string[], changes: L1RpcChanges = { added: [], paused: [], removed: [] }): L1RpcChoice[] {
  return [
    ...deployment.filter((url) => !changes.removed.includes(url)).map((url) => ({ url, enabled: !changes.paused.includes(url) })),
    ...changes.added.filter((rpc) => !deployment.includes(rpc.url)),
  ];
}

/** What a list changes about the deployment's, or undefined when it changes nothing. */
export function l1RpcChanges(deployment: readonly string[], list: readonly L1RpcChoice[]): L1RpcChanges | undefined {
  const listed = (url: string) => list.find((rpc) => rpc.url === url);
  const changes = {
    added: list.filter((rpc) => !deployment.includes(rpc.url)),
    paused: deployment.filter((url) => listed(url)?.enabled === false),
    removed: deployment.filter((url) => listed(url) === undefined),
  };
  return changes.added.length + changes.paused.length + changes.removed.length === 0 ? undefined : changes;
}
export const RPC_ENDPOINTS_KEY = "pcash-rpc-endpoints";

export function savedRpcEndpoints(storage: () => Storage = () => localStorage): RpcEndpoints {
  try {
    // Browser storage can be edited by the user or another tab.
    const saved: unknown = JSON.parse(storage().getItem(RPC_ENDPOINTS_KEY) ?? "null");
    if (saved === null || typeof saved !== "object") return {};
    const endpoints: RpcEndpoints = {};
    const { pcashRpcUrl, l1Rpcs } = saved as Record<string, unknown>;
    if (typeof pcashRpcUrl === "string" && pcashRpcUrl !== "") endpoints.pcashRpcUrl = pcashRpcUrl;
    if (l1Rpcs !== null && typeof l1Rpcs === "object") {
      const { added, paused, removed } = l1Rpcs as Record<string, unknown>;
      const entries = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
      const urls = (value: unknown) => entries(value).filter((url): url is string => typeof url === "string");
      endpoints.l1Rpcs = {
        added: entries(added).flatMap((rpc) => {
          if (rpc === null || typeof rpc !== "object") return [];
          const { url, enabled } = rpc as Record<string, unknown>;
          return typeof url === "string" && url !== "" && typeof enabled === "boolean" ? [{ url, enabled }] : [];
        }),
        paused: urls(paused),
        removed: urls(removed),
      };
    }
    return endpoints;
  } catch { return {}; }
}

/** Takes effect on the next page load, which starts every client on the new endpoints. */
export function saveRpcEndpoints(endpoints: RpcEndpoints, storage: () => Storage = () => localStorage): void {
  if (endpoints.pcashRpcUrl === undefined && endpoints.l1Rpcs === undefined) storage().removeItem(RPC_ENDPOINTS_KEY);
  else storage().setItem(RPC_ENDPOINTS_KEY, JSON.stringify(endpoints));
}

const fallback = new WebsiteSettingsStore(() => localStorage);
export const WebsiteSettingsContext = createContext(fallback);
export function WebsiteSettingsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => { const value = new WebsiteSettingsStore(() => localStorage); value.restore(); return value; });
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === WEBSITE_SETTINGS_KEY || event.key === null) store.restore(); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [store]);
  return <WebsiteSettingsContext.Provider value={store}>{children}</WebsiteSettingsContext.Provider>;
}
export function useWebsiteSettings() {
  const store = useContext(WebsiteSettingsContext);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return { ...state, setEnsEnabled: store.setEnsEnabled,
    setDefaultSubmissionMode: store.setDefaultSubmissionMode, getDefaultSubmissionMode: store.getDefaultSubmissionMode };
}
