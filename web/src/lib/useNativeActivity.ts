import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "./WalletProvider.tsx";

const sessions = new WeakMap<object, number>();
let nextSession = 0;

/** One background history read, with its recovery, shared by every view of the signed-in wallet's history. */
export function useNativeActivity(requested = true) {
  const { wallet, snapshot, funds, connectedAccount, status } = useWallet();
  let session: number | undefined;
  if (wallet !== undefined) {
    session = sessions.get(wallet);
    if (session === undefined) { session = ++nextSession; sessions.set(wallet, session); }
  }
  const enabled = requested && wallet !== undefined && funds !== undefined && connectedAccount !== undefined
    && snapshot?.address.toLowerCase() === connectedAccount.toLowerCase();
  const query = useQuery({
    queryKey: ["native-activity", status?.pcashChainId.toString(), status?.inboxAddress, connectedAccount?.toLowerCase(), session],
    queryFn: () => wallet!.nativeActivity({ recoverHistory: true }),
    enabled,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchInterval: (current) => current.state.status === "error" || current.state.data?.state === "unavailable" ? 2_000 : false,
  });
  const previous = useRef({ session, snapshot });
  useEffect(() => {
    const changed = previous.current.session === session && previous.current.snapshot !== snapshot;
    previous.current = { session, snapshot };
    if (enabled && changed) void query.refetch({ cancelRefetch: false });
  }, [enabled, session, snapshot, query.refetch]);
  return {
    activity: enabled ? query.data : undefined,
    checking: enabled && query.isFetching,
    error: enabled && query.isError,
    failed: enabled && (query.isError || query.data?.state === "unavailable"),
    retry: () => { void query.refetch(); },
  };
}
