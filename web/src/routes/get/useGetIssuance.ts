import { useEffect, useRef, useState } from "react";
import { nextBlockIssuanceQuote, recentBlockEconomics } from "@pcash/sdk/relay";
import { useWallet } from "../../lib/WalletProvider.tsx";
import type { DisplayIssuanceInputs } from "../../lib/usePaymentIssuance.ts";
import { readIssuanceWindows, type IssuanceHistory } from "./issuanceOverviewModel.ts";

export const GET_DISPLAY_REFRESH_MS = 36_000;
export const GET_HISTORY_REFRESH_MS = 300_000;
export function useGetIssuance() {
  const { node, status } = useWallet();
  const current = useRef(status); current.current = status;
  const identity = status === undefined ? undefined : `${status.pcashChainId}:${status.genesisHash}`;
  const [display, setDisplay] = useState<{ identity: string; node: typeof node; inputs: DisplayIssuanceInputs; error?: string }>();
  const [historyState, setHistory] = useState<{ identity: string; node: typeof node; value?: IssuanceHistory; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (identity === undefined) return;
    let cancelled = false, busy = false;
    const read = async () => {
      if (busy || current.current === undefined) return;
      busy = true;
      const latest = current.current;
      const [quote, economics] = await Promise.allSettled([nextBlockIssuanceQuote(node, latest), recentBlockEconomics(node, latest.latestBlock)]);
      busy = false;
      if (cancelled) return;
      setDisplay(previous => {
        const prior = previous?.identity === identity && previous.node === node ? previous : undefined;
        return { identity, node, inputs: { quote: quote.status === "fulfilled" ? quote : prior?.inputs.quote ?? quote, economics: economics.status === "fulfilled" ? economics : prior?.inputs.economics ?? economics },
          ...(quote.status === "rejected" || economics.status === "rejected" ? { error: "Issuance update delayed. Showing the last available information where possible." } : {}) };
      });
    };
    void read(); const timer = setInterval(() => void read(), GET_DISPLAY_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [node, identity, attempt]);
  useEffect(() => {
    if (identity === undefined) return;
    let cancelled = false, busy = false;
    const read = async () => {
      if (busy) return; busy = true;
      try {
        const value = await readIssuanceWindows(node);
        if (!cancelled) setHistory({ node, identity, value });
      } catch {
        if (!cancelled) setHistory(previous => ({ node, identity, ...(previous?.node === node && previous.identity === identity && previous.value !== undefined ? { value: previous.value } : {}), error: "Recent activity update delayed." }));
      } finally { busy = false; }
    };
    void read(); const timer = setInterval(() => void read(), GET_HISTORY_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [node, identity, attempt]);
  const active = display !== undefined && display.identity === identity && display.node === node ? display : undefined;
  const history = historyState !== undefined && historyState.identity === identity && historyState.node === node ? historyState : undefined;
  return { inputs: active?.inputs, history: history?.value, error: active?.error ?? history?.error, refresh: () => setAttempt(value => value + 1) };
}
