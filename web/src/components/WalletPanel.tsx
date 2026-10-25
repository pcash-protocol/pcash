import { useEffect, useRef, useState, type ReactNode } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { getAccount } from "wagmi/actions";
import { useEthereumNetwork } from "../lib/EthereumProvider.tsx";
import { confirmDiscardGetWork, useGetActivity } from "../lib/GetActivity.tsx";
import { useWallet } from "../lib/WalletProvider.tsx";
import { useEthereumIdentity } from "../names/useEthereumName.ts";
import { useWalletPanel, SendCard, ReceiveCard, AccountStatusNotices } from "../routes/wallet/OwnerPanels.tsx";
import { Activity } from "../routes/wallet/Activity.tsx";
import { AccountAvatar } from "./AccountAvatar.tsx";
import { ConnectWallet } from "./ConnectWallet.tsx";
import { Link } from "react-router-dom";
import { WalletSettings } from "./WalletSettings.tsx";
import { WalletSubmissionLock } from "./WalletSubmissionLock.tsx";
import { useWalletToasts, WalletToasts, WalletToastWatcher } from "./WalletPanelToasts.tsx";
import { PcashAmount } from "./PcashAmount.tsx";
import { MiningBalance } from "../routes/wallet/MiningBalance.tsx";
import { AccountSetupPanel } from "../routes/wallet/AccountSetupPanel.tsx";
import { CopyableAddress } from "./EthereumAddress.tsx";
import { TokenBalanceRows } from "../routes/tokens/TokenBalances.tsx";
import { TOKENS_PATH } from "../routes/tokens/model.ts";
import { shortValue } from "../routes/wallet/model.ts";
import styles from "./WalletPanel.module.css";

function ActivityRow({ title, detail, onView }: { title: ReactNode; detail: string; onView: () => void }) {
  return <div className={styles.inProgress} role="status">
    <div><strong>{title}</strong><span>{detail}</span></div>
    <button type="button" className="button" onClick={onView}>View</button>
  </div>;
}

/** A payment that continues after the user leaves the send view. */
function PaymentInProgress() {
  const { paymentStage } = useWallet();
  const panel = useWalletPanel();
  const amount = panel.review?.intent.amount;
  const title = amount === undefined ? "Payment" : <>Payment of <PcashAmount value={amount} /></>;
  if (panel.resultL1Hash !== undefined && !panel.confirmation.finished) return <ActivityRow title={title} detail="Posted, waiting for inclusion…" onView={panel.openSend} />;
  // A failed payment keeps its error until its Send view is left, even when the failure discarded its review.
  if (panel.review === undefined || paymentStage.state === "failed") return panel.paymentError === undefined ? null : <ActivityRow title={title} detail={panel.paymentError} onView={panel.openSend} />;
  const detail = {
    idle: "Ready to send",
    proving: "Generating proof…",
    canceling: "Canceling…",
    submitting: "Sending…",
    "l1-submitted": "Posted, waiting for inclusion…",
    "submission-unknown": "Status unknown. Check it before trying again.",
  }[paymentStage.state];
  return <ActivityRow title={title} detail={detail} onView={panel.openSend} />;
}

/** A profile's Send that waits for connect, sign-in or setup. */
function WaitingPayment() {
  const { phase } = useWallet();
  const { pendingRecipient } = useWalletPanel();
  if (pendingRecipient === undefined || phase === "ready") return null;
  const recipient = /^0x[0-9a-fA-F]{40}$/.test(pendingRecipient) ? shortValue(pendingRecipient, 6, 4) : pendingRecipient;
  const detail = phase === "disconnected" ? "Connect your wallet to continue."
    : phase === "sign-in-required" ? "Sign in to continue."
    : phase === "activation-required" || phase === "activation-prepared" ? "Set up PCASH to continue."
    : "Send opens when your wallet is ready.";
  return <div className={styles.inProgress} role="status" data-testid="waiting-payment">
    <div><strong>Payment to <span title={pendingRecipient}>{recipient}</span></strong><span>{detail}</span></div>
  </div>;
}

export function WalletPanel() {
  const wallet = useWallet();
  const getActivity = useGetActivity();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { ethereumConfig } = useEthereumNetwork();
  const { connectModalOpen } = useConnectModal();
  const pickerWasOpen = useRef(false);
  useEffect(() => {
    if (pickerWasOpen.current && !connectModalOpen && getAccount(ethereumConfig).status === "disconnected") wallet.cancelOnboarding();
    pickerWasOpen.current = connectModalOpen;
  }, [connectModalOpen, ethereumConfig, wallet.cancelOnboarding]);
  const panel = useWalletPanel();
  const dialog = useRef<HTMLDialogElement>(null);
  const pressStartedOnBackdrop = useRef(false);
  const open = panel.panelView !== "closed";
  const address = wallet.connectedAccount;
  const receiveAddress = panel.receiveAddress ?? address;
  const identity = useEthereumIdentity(address);
  const { toasts, show, dismiss } = useWalletToasts();
  const toastRegion = <WalletToasts toasts={toasts} onDismiss={dismiss} />;
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      if (connectModalOpen) element.show();
      else element.showModal();
    }
    else if (!open && element.open) element.close();
    return () => { if (element.open) element.close(); };
  }, [open, connectModalOpen]);
  useEffect(() => { if (!open) setSettingsOpen(false); }, [open]);
  useEffect(() => {
    if (!open || connectModalOpen) return;
    const frame = requestAnimationFrame(() => {
      dialog.current?.querySelector<HTMLElement>(!settingsOpen && panel.panelView === "send" ? "input" : "[data-wallet-heading]")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, panel.panelView, settingsOpen, connectModalOpen]);
  // Escape and a backdrop click hide the panel; any payment keeps running.
  // A press that starts inside the panel and ends over the backdrop (a drag-select)
  // is not a backdrop click. While the connect modal is open the panel is
  // non-modal and ignores both.
  // A modal panel sits above the page, so its toasts render inside it while it is open.
  return <><dialog ref={dialog} className={styles.panel} data-testid="wallet-panel" data-view={panel.panelView}
    aria-label={panel.panelView === "send" ? "Send PCASH" : panel.panelView === "ethereum-submission" ? "Ethereum submission" : panel.panelView === "receive" ? "Receive PCASH" : "Your wallet"}
    onCancel={(event) => { event.preventDefault(); if (!connectModalOpen) panel.closePanel(); }}
    onPointerDown={(event) => { pressStartedOnBackdrop.current = event.target === event.currentTarget; }}
    onClick={(event) => {
      const backdrop = pressStartedOnBackdrop.current && event.target === event.currentTarget;
      pressStartedOnBackdrop.current = false;
      if (backdrop && !connectModalOpen) panel.closePanel();
    }}>
    {open && <div className={styles.content}>
      <button type="button" className={styles.close} aria-label="Close wallet" onClick={panel.closePanel}>×</button>
      {!settingsOpen && <button type="button" className={styles.settingsButton} aria-label="Wallet settings" onClick={() => setSettingsOpen(true)}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m9 3-.6 2.3-2 .9-2.1-.6-2 3.4 1.6 1.8v2.4L2.3 15l2 3.4 2.1-.6 2 .9L9 21h4l.6-2.3 2-.9 2.1.6 2-3.4-1.6-1.8v-2.4L19.7 9l-2-3.4-2.1.6-2-.9L13 3Z"/><circle cx="11" cy="12" r="3"/></svg>
      </button>}
      {settingsOpen && <WalletSettings onBack={() => setSettingsOpen(false)} />}
      <div hidden={settingsOpen}>
      {panel.panelView === "send" ? <>
        <button className={styles.back} type="button" onClick={panel.openOverview}>← Wallet</button>
        <div className={styles.sendSurface}><SendCard onClose={panel.openOverview} /></div>
      </> : panel.panelView === "receive" ? <>
        <button className={styles.back} type="button" onClick={panel.openOverview}>← Wallet</button>
        {receiveAddress !== undefined && <ReceiveCard address={receiveAddress} />}
      </> : panel.panelView === "ethereum-submission" ? <>
        <button className={styles.back} type="button" onClick={panel.openOverview}>← Wallet</button>
        <h2 data-wallet-heading tabIndex={-1}>Ethereum submission</h2>
        <WalletSubmissionLock />
      </> : <>
        <div className={styles.identity}>{address !== undefined && <AccountAvatar address={address} avatar={identity.avatar} className={styles.avatar} />}<div><h2 data-wallet-heading tabIndex={-1}>{identity.name ?? "Your wallet"}</h2><div aria-label="Receive address">{address === undefined ? "Not connected" : <CopyableAddress address={address} />}</div></div></div>
        <WaitingPayment />
        <PaymentInProgress />
        <AccountSetupPanel />
        {wallet.accountRecord === "present" && <div className={styles.balance}><MiningBalance testId="wallet-sidebar-balance" /></div>}
        <div className={styles.actions}>
          {wallet.phase === "disconnected" ? <ConnectWallet onNavigate={panel.closePanel} />
            : wallet.phase === "ready" && <button type="button" className="button primary" disabled={wallet.busy} onClick={panel.openSend}>Send</button>}
          {wallet.accountRecord === "present" && <>
            <Link className="button" to="/get" onClick={panel.closePanel}>Get PCASH</Link>
            {wallet.phase !== "disconnected" && wallet.phase !== "wrong-network" && <button type="button" className="button" onClick={() => panel.openReceive()}>Receive</button>}
          </>}
        </div>
        {wallet.phase === "ready" && <AccountStatusNotices />}
        {(wallet.snapshot?.assets.length ?? 0) > 0 && <><div className={styles.tokensHeading}><h3 className={styles.sectionHeading}>Tokens</h3><Link to={TOKENS_PATH} onClick={panel.closePanel}>All tokens →</Link></div>
          <div className={styles.tokens}><TokenBalanceRows assets={wallet.snapshot!.assets} compact onNavigate={panel.closePanel} /></div></>}
        {wallet.profile !== undefined && <><h3 className={styles.sectionHeading}>Activity</h3><Activity compact onNavigate={panel.closePanel} /></>}
        {wallet.phase !== "disconnected" && <div className={styles.footer}>
          {address !== undefined && <Link className={styles.fullAccount} to={`/${address}`} onClick={panel.closePanel}>View account in explorer →</Link>}
          <button className={styles.back} type="button" onClick={() => { if (!getActivity.unsafeToLeave || confirmDiscardGetWork()) void wallet.disconnect().catch(() => undefined); }}>Disconnect</button>
        </div>}
      </>}
      </div>
      {toastRegion}
    </div>}
  </dialog>{!open && toastRegion}<WalletToastWatcher onToasts={show} /></>;
}
