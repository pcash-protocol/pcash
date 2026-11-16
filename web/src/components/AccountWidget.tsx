import { EthereumAddress } from "./EthereumAddress.tsx";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AccountAvatar } from "./AccountAvatar.tsx";
import { useWalletPanel } from "../routes/wallet/OwnerPanels.tsx";
import { useWallet } from "../lib/WalletProvider.tsx";
import { useEthereumIdentity } from "../names/useEthereumName.ts";
import { useWalletActivity } from "../routes/wallet/activity.ts";
import styles from "./AccountWidget.module.css";

/** Phases where the wallet is mid-flight and the widget should show a spinner. */
const workingPhases = new Set(["connecting", "signing-in", "opening", "activating", "syncing"]);

function Avatar({ address, avatar, large }: { address: string | undefined; avatar?: string | undefined; large?: boolean }) {
  const className = large ? `${styles.avatar} ${styles.lg}` : styles.avatar;
  return <AccountAvatar address={address} avatar={avatar} className={className} />;
}

export function AccountWidget() {
  const {
    phase,
    connectedAccount,
    accountRecord,
    busy,
    error,
    syncState,
    submissionLock,
    awaitingSignature,
  } = useWallet();

  // The public pages are prerendered, so the first client render must match the
  // server's markup exactly. Everything wallet-dependent waits for mount.
  const [mounted, setMounted] = useState(false);
  const panel = useWalletPanel();
  const activity = useWalletActivity();
  const address = connectedAccount;
  const identity = useEthereumIdentity(mounted ? address : undefined);

  useEffect(() => setMounted(true), []);

  const staticShell = <div className={styles.slot}>
    <span className={`${styles.skeleton} ${styles.triggerSkeleton}`} aria-hidden="true" />
  </div>;

  if (import.meta.env.VITE_PCASH_MODE === "fixtures") return <div className={styles.slot}><Link className={styles.trigger} to="/__states">Recorded preview</Link></div>;
  if (!mounted || phase === "initializing") return staticShell;

  const working = workingPhases.has(phase);
  const needsAttention = Boolean(error) || syncState.state === "error" || submissionLock !== undefined || awaitingSignature
    || (accountRecord === "absent" && phase !== "ready")
    || (!working && phase !== "ready" && phase !== "disconnected");

  const stateStyle = phase === "disconnected" ? styles.plain : "";
  return <div className={styles.slot}><button type="button" data-testid="wallet-trigger" data-wallet-phase={phase} data-wallet-busy={busy}
    className={`${styles.trigger} ${stateStyle}`} onClick={panel.showPanel} aria-haspopup="dialog" aria-expanded={panel.panelView !== "closed"}>
    {phase === "disconnected" ? "Connect wallet"
      : working && address === undefined ? <><span className="spinner" aria-hidden="true" /><span>{phase === "signing-in" ? "Check your wallet…" : phase === "syncing" ? "Syncing…" : "Connecting…"}</span></> : <>
      <Avatar address={address} avatar={identity.avatar} />
      <span>{address === undefined ? "Your account" : <EthereumAddress address={address} short head={6} tail={4} />}</span>
      <span className={styles.chevron} aria-hidden="true">▾</span>
    </>}
    {needsAttention ? <span className={styles.attentionBadge} role="img" aria-label="Wallet needs attention" title="Open your wallet for details" />
      : activity.sending || activity.mining ? <span className={styles.activityBadge} role="img" aria-label={activity.sending ? "Payment in progress" : "Mining in progress"} title={activity.sending ? "Your payment is being prepared" : "Your mining transaction is in progress"} />
      : activity.unseenOutcome && <span className={styles.doneBadge} role="img" aria-label="Wallet activity finished" title="Open your wallet to see the result" />}
  </button></div>;
}
