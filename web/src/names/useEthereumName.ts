import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { isAddress } from "viem/utils";
import { normalizeIdentityName, type EthereumName, type ReverseNameResult } from "@pcash/sdk/names";
import { FAILURE_TTL, type NameCacheEntry } from "./nameCache.ts";

import { NameResolutionSession } from "./NameResolutionSession.ts";

const privateSession = new NameResolutionSession(undefined, () => localStorage);
export const NameResolutionContext = createContext(privateSession);
function useNameSession() {
  const session = useContext(NameResolutionContext);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getServerSnapshot);
  return { ...snapshot, setEnabled: session.setEnabled };
}
export const useEthereumNameResolver = () => useNameSession().resolver;

function useNameLookup(key: string | undefined, load: (() => Promise<ReverseNameResult>) | undefined) {
  const session = useContext(NameResolutionContext);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const enabled = mounted && key !== undefined && load !== undefined && import.meta.env.VITE_PCASH_MODE !== "fixtures";
  const query = useQuery<NameCacheEntry>({
    queryKey: ["ethereum-names", key],
    enabled,
    notifyOnChangeProps: ["data", "isFetching"],
    staleTime: (query) => Math.max(0, (query.state.data?.expiresAt ?? 0) - query.state.dataUpdatedAt),
    refetchInterval: (query) => query.state.fetchStatus === "fetching" || query.state.data === undefined ? false : Math.max(1, query.state.data.expiresAt - Date.now()),
    queryFn: async ({ signal }): Promise<NameCacheEntry> => {
      try {
        const stored = session.cache.read(key!);
        if (stored !== undefined) return stored;
        const result = await load!();
        signal.throwIfAborted();
        return session.cache.write(key!, result);
      } catch {
        signal.throwIfAborted();
        return { identity: null, failed: true, expiresAt: Date.now() + FAILURE_TTL };
      }
    },
  }, session.queryClient);
  // Observe fetch status so expiry refreshes also clear an expired display label.
  const data = enabled && query.data !== undefined && query.data.expiresAt > Date.now() ? query.data : undefined;
  return { data, retry: () => query.refetch() };
}

export function useEthereumName(address: string | undefined): EthereumName | undefined {
  const resolver = useEthereumNameResolver();
  const key = resolver !== undefined && address !== undefined && isAddress(address, { strict: false }) ? address.toLowerCase() : undefined;
  return useNameLookup(key === undefined ? undefined : `1:reverse:${key}`, resolver === undefined ? undefined : () => resolver.reverseAddress(key!)).data?.identity ?? undefined;
}

export function useEthereumIdentity(address: string | undefined): { name?: string; avatar?: string } {
  const session = useContext(NameResolutionContext);
  const resolver = useEthereumNameResolver();
  const identity = useEthereumName(address);
  const avatar = useQuery({
    queryKey: ["ethereum-name-avatar", identity?.name],
    enabled: resolver !== undefined && identity?.system === "ens",
    staleTime: 5 * 60_000,
    queryFn: () => resolver!.getAvatar(identity!),
  }, session.queryClient);
  return { ...(identity === undefined ? {} : { name: identity.name }), ...(resolver === undefined || identity === undefined || avatar.data == null ? {} : { avatar: avatar.data }) };
}

export type NameAddress =
  | { state: "disabled" }
  | { state: "resolving" }
  | { state: "resolved"; address: string }
  | { state: "unresolved" }
  | { state: "error"; retry(): void };

export function useNameAddress(input: string | undefined): NameAddress {
  const resolver = useEthereumNameResolver();
  const name = input === undefined ? undefined : normalizeIdentityName(input);
  const query = useNameLookup(name === undefined || resolver === undefined ? undefined : `1:forward:${name}`, resolver === undefined ? undefined : async () => ({ identity: await resolver.resolveName(name!), complete: true }));
  if (name === undefined || import.meta.env.VITE_PCASH_MODE === "fixtures") return { state: "unresolved" };
  if (resolver === undefined) return { state: "disabled" };
  if (query.data?.failed) return { state: "error", retry: () => { void query.retry(); } };
  if (query.data === undefined) return { state: "resolving" };
  return query.data.identity === null ? { state: "unresolved" } : { state: "resolved", address: query.data.identity.address };
}
