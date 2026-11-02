import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Wallet } from "@pcash/sdk/wallet";
import { useNativeActivity } from "../lib/useNativeActivity.ts";
import { useWallet } from "../lib/WalletProvider.tsx";
import { sentTitle } from "../routes/wallet/activityRows.tsx";
import { PcashAmount } from "./PcashAmount.tsx";
import styles from "./WalletPanel.module.css";

const TOAST_MS = 6_000;
const MAX_TOASTS = 3;

export interface WalletToast {
  id: string;
  message: ReactNode;
}

/** The wallet's toasts: each dismisses itself after a few seconds, and only the newest few stay. */
export function useWalletToasts() {
  const [toasts, setToasts] = useState<WalletToast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const show = useCallback((added: readonly WalletToast[]) => {
    for (const toast of added) timers.current.set(toast.id, setTimeout(() => dismiss(toast.id), TOAST_MS));
    setToasts((current) => [...current, ...added].slice(-MAX_TOASTS));
  }, [dismiss]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return { toasts, show, dismiss };
}

/** How a completed action of this session other than a payment or a mine is announced, by its wallet action name. */
const ACTION_TITLES: Readonly<Record<string, string>> = {
  "asset-creation": "Token created",
  "asset-send": "Token payment confirmed",
  "asset-burn": "Token burn confirmed",
  bulk: "Token payments confirmed",
};

interface ToastSession {
  wallet: Wallet;
  /** Fresh actions this session journaled, by content hash, with their wallet action name. */
  started: Map<string, string>;
  announced: Set<string>;
  /** The block the initial sync reached: history at or below it was there before the session. */
  historyThrough?: bigint;
  settingUp: boolean;
}

/**
 * Announces what lands during the session: an incoming payment or a mine,
 * account setup, and the completion of an action this session started. It
 * reads only what the wallet provider and the shared history query already
 * hold. An action counts as started here only when this session journaled its
 * bytes fresh, so earlier pending work stays quiet, as does history up to the
 * block the session's initial sync reached. Renders nothing.
 */
export function WalletToastWatcher({ onToasts }: { onToasts(toasts: readonly WalletToast[]): void }) {
  const { wallet, snapshot, funds, phase, paymentActivity } = useWallet();
  const native = useNativeActivity();
  const history = native.activity?.state === "ready" ? native.activity : undefined;
  const session = useRef<ToastSession | undefined>(undefined);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const onToastsRef = useRef(onToasts);
  onToastsRef.current = onToasts;
  const current = (opened: Wallet) => {
    if (session.current?.wallet !== opened) session.current = { wallet: opened, started: new Map(), announced: new Set(), settingUp: false };
    return session.current;
  };
  const announce = (opened: Wallet, toasts: readonly WalletToast[]) => {
    const { announced } = current(opened);
    const fresh = toasts.filter((toast) => !announced.has(toast.id));
    fresh.forEach((toast) => announced.add(toast.id));
    if (fresh.length > 0) onToastsRef.current(fresh);
  };

  // A retry's bytes are already pending, so only a fresh action's journaling starts one.
  useEffect(() => {
    if (wallet === undefined) return;
    const names = new Map<string, string>();
    const unsubscribe = [
      wallet.on("action:started", (event) => { names.set(event.action.id, event.action.name); }),
      wallet.on("action:before-journal", (event) => {
        const contentHash = event.contentHash.toLowerCase();
        if (snapshotRef.current?.pendingContentHashes.some((id) => id.toLowerCase() === contentHash) === true) return;
        current(wallet).started.set(contentHash, names.get(event.action.id) ?? "");
      }),
    ];
    return () => unsubscribe.forEach((off) => void off());
  }, [wallet]);

  // The provider already watches each pending payment's receipt.
  useEffect(() => {
    if (wallet === undefined) return;
    const { started } = current(wallet);
    announce(wallet, paymentActivity.flatMap((payment) => payment.kind === "payment" && started.get(payment.contentHash.toLowerCase()) === "send"
      && (payment.status === "confirmed" || payment.status === "finalized")
      ? [{ id: payment.contentHash.toLowerCase(), message: sentTitle(payment.amount, payment.recipientAddress) }] : []));
  }, [wallet, paymentActivity]);

  useEffect(() => {
    if (wallet === undefined) return;
    const setup = current(wallet);
    if (phase === "activating") setup.settingUp = true;
    else if (phase === "ready" && setup.settingUp) {
      setup.settingUp = false;
      announce(wallet, [{ id: "account-setup", message: "Your PCASH account is set up" }]);
    }
  }, [wallet, phase]);

  // The baseline waits for the initial sync to reach every block the node serves, so
  // payments that arrived while this wallet was offline sit at or below it.
  useEffect(() => {
    if (wallet !== undefined && funds?.synchronized === true) current(wallet).historyThrough ??= funds.pcashNumber;
  }, [wallet, funds]);

  useEffect(() => {
    const through = wallet === undefined ? undefined : current(wallet).historyThrough;
    if (wallet === undefined || history === undefined || through === undefined) return;
    const { started } = current(wallet);
    announce(wallet, history.entries.flatMap((entry): WalletToast[] => {
      if (entry.blockNumber <= through) return [];
      if (entry.direction === "received") {
        // The notes it created, unlike its transaction id, survive a reorg that re-includes it.
        return [{ id: `received:${[...entry.commitments].sort().join(",")}`, message: entry.payout !== null && entry.payout.issuanceAmount > 0n
          ? <>Mined <PcashAmount value={entry.amount} /></> : <>Received <PcashAmount value={entry.amount} /></> }];
      }
      const contentHash = entry.contentHash?.toLowerCase();
      const name = contentHash === undefined ? undefined : started.get(contentHash);
      // Payments are announced from their receipts above.
      return contentHash === undefined || name === undefined || name === "send" ? []
        : [{ id: contentHash, message: ACTION_TITLES[name] ?? (name.startsWith("marketplace:") ? "Marketplace transaction confirmed" : "Transaction confirmed") }];
    }));
  }, [wallet, history]);
  return null;
}

/** One small region for the wallet's toasts. */
export function WalletToasts({ toasts, onDismiss }: { toasts: readonly WalletToast[]; onDismiss(id: string): void }) {
  return <div className={styles.toasts} role="status" aria-live="polite">
    {toasts.map((toast) => <div key={toast.id} className={styles.toast}>
      <span>{toast.message}</span>
      <button type="button" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>×</button>
    </div>)}
  </div>;
}
