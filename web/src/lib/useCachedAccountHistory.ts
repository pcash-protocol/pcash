import { useEffect, useMemo, useState } from "react";
import type { Wallet, WalletNativeFunds, WalletSnapshot } from "@pcash/sdk/wallet";
import { networkConfigFromStatus } from "@pcash/sdk/protocol";
import { useNetwork } from "../components/NetworkContext.tsx";
import { createProfileSessionStore, profileSessionIdentity, profileSessionKey } from "./ProfileSessionStore.ts";
import { networkInstanceKey } from "./networks.ts";
import { errorMessage, useWallet } from "./WalletProvider.tsx";
import { useNativeActivity } from "./useNativeActivity.ts";

type History = {
  key: string;
  phase: "loading" | "locked" | "ready" | "error";
  activity?: Awaited<ReturnType<Wallet["nativeActivity"]>>;
  snapshot?: WalletSnapshot;
  funds?: WalletNativeFunds;
  checking: boolean;
  error?: string;
};

/** Read private history for the URL's account without acquiring signing capabilities. */
export function useCachedAccountHistory(address: string) {
  const { network } = useNetwork();
  const { node, status, snapshot: ownSnapshot, funds: ownFunds, connectedAccount } = useWallet();
  // The signed-in wallet already keeps its own account current; a second wallet
  // on the same store would sync it again and echo every write back.
  const own = ownFunds !== undefined && ownSnapshot?.address.toLowerCase() === address.toLowerCase()
    && connectedAccount?.toLowerCase() === address.toLowerCase();
  const ownActivity = useNativeActivity(own);
  const scope = networkInstanceKey(network);
  const store = useMemo(() => createProfileSessionStore(scope), [scope]);
  const { pcashChainId, l1ChainId, genesisHash, inboxAddress } = status ?? {};
  const identity = useMemo(() => pcashChainId === undefined || l1ChainId === undefined || genesisHash === undefined || inboxAddress === undefined
    ? undefined
    : profileSessionIdentity({ pcashChainId, l1ChainId, genesisHash, inboxAddress }, address),
  [pcashChainId, l1ChainId, genesisHash, inboxAddress, address]);
  const key = `${scope}:${identity === undefined ? address.toLowerCase() : profileSessionKey(identity)}`;
  const [result, setResult] = useState<History>({ key, phase: "loading", checking: true });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (own || identity === undefined) return;
    let canceled = false;
    let opened: Wallet | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      canceled = true;
      clearTimeout(timer);
      void opened?.close().catch(() => undefined);
    };
    const unsubscribe = store.subscribeToChanges((changedKey) => {
      if (changedKey !== profileSessionKey(identity)) return;
      stop();
      setResult({ key, phase: "loading", checking: true });
      setAttempt((value) => value + 1);
    });
    setResult({ key, phase: "loading", checking: true });

    const refresh = async () => {
      if (canceled) return;
      setResult((previous) => ({ ...previous, checking: true }));
      let delay = 12_000;
      try {
        await opened!.sync({ awaitFunds: true });
        if (canceled) return;
        const activity = await opened!.nativeActivity({ recoverHistory: true });
        if (canceled) return;
        const [snapshot, funds] = await Promise.all([opened!.snapshot(), opened!.nativeFunds()]);
        if (canceled) return;
        setResult({ key, phase: "ready", checking: false, activity, snapshot, funds });
        if (activity.state === "unavailable") delay = 2_000;
      } catch (cause) {
        if (canceled) return;
        setResult((previous) => ({ ...previous, key, phase: "error", checking: false, error: errorMessage(cause) }));
        delay = 2_000;
      }
      if (!canceled) timer = setTimeout(() => void refresh(), delay);
    };

    void (async () => {
      try {
        const cached = await store.loadProfileSession(identity);
        if (canceled) return;
        if (cached.state === "absent") {
          setResult({ key, phase: "locked", checking: false });
          return;
        }
        const [{ derivePcashProfileFromSignature }, { openBrowserWallet, browserWalletDatabaseName }] = await Promise.all([
          import("@pcash/sdk/wallet"), import("@pcash/sdk/wallet/web"),
        ]);
        if (canceled) return;
        const current = { pcashChainId: Number(identity.pcashChainId), l1ChainId: BigInt(identity.l1ChainId), genesisHash: identity.genesisHash, inboxAddress: identity.inboxAddress };
        opened = await openBrowserWallet({
          name: browserWalletDatabaseName("pcash-wallet-state", current),
          node,
          profile: derivePcashProfileFromSignature(cached.signature, networkConfigFromStatus(current), identity.account),
        });
        if (canceled) { await opened.close(); return; }
        await refresh();
      } catch (cause) {
        if (!canceled) setResult({ key, phase: "error", checking: false, error: errorMessage(cause) });
      }
    })();
    return () => { stop(); unsubscribe(); };
  }, [own, identity, key, node, store, attempt]);

  if (own) {
    return {
      key, phase: "ready" as const, checking: ownActivity.checking, activity: ownActivity.activity,
      snapshot: ownSnapshot, funds: ownFunds, failed: ownActivity.failed, retry: ownActivity.retry,
    };
  }
  const current: History = result.key === key ? result : { key, phase: "loading", checking: true };
  return {
    ...current,
    activity: current.activity,
    failed: current.phase === "error" || current.activity?.state === "unavailable",
    retry: () => setAttempt((value) => value + 1),
  };
}
