import { QueryClient } from "@tanstack/react-query";
import type { EthereumNameResolver } from "@pcash/sdk/names";
import { NameCache } from "./nameCache.ts";

export const NAMES_OFF_MESSAGE = "ENS names are off. Use an address, or turn on Show ENS names in wallet settings.";
export type NameResolverFactory = (signal: AbortSignal) => EthereumNameResolver;
type Snapshot = { enabled: boolean; resolver: EthereumNameResolver | undefined };
const PRIVATE: Snapshot = { enabled: false, resolver: undefined };

/** Owns the permission, transport lifetime, and both naming caches as one session. */
export class NameResolutionSession {
  // Defaults avoid GC timers during prerendering and collect unused browser queries.
  readonly queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  readonly cache: NameCache;
  private state = PRIVATE;
  private controller: AbortController | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly createResolver: NameResolverFactory | undefined, storage: () => Storage) {
    this.cache = new NameCache(storage);
  }

  getSnapshot = () => this.state;
  getServerSnapshot = () => PRIVATE;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  setEnabled = (enabled: boolean) => {
    this.stop();
    this.queryClient.clear();
    enabled &&= this.createResolver !== undefined;
    if (!enabled) {
      this.cache.clear();
      this.state = PRIVATE;
    } else {
      const controller = new AbortController();
      this.controller = controller;
      const resolver = this.createResolver!(controller.signal);
      const run = async <T>(lookup: () => Promise<T>): Promise<T> => {
        controller.signal.throwIfAborted();
        const value = await lookup();
        controller.signal.throwIfAborted();
        return value;
      };
      this.state = { enabled: true, resolver: {
        resolveName: (name) => run(() => resolver.resolveName(name)),
        reverseAddress: (address) => run(() => resolver.reverseAddress(address)),
        getAvatar: (identity) => run(() => resolver.getAvatar(identity)),
      } };
    }
    for (const listener of this.listeners) listener();
  };

  stop = () => {
    this.controller?.abort();
    this.controller = undefined;
    void this.queryClient.cancelQueries();
  };
}
