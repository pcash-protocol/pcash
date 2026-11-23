import { Suspense, useState, type ReactNode } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { CheckIcon, ExternalLinkIcon } from "../../components/icons.tsx";
import { ConnectWallet } from "../../components/ConnectWallet.tsx";
import { NetworkFeeFunding } from "../../components/NetworkFeeFunding.tsx";
import { PageSkeleton } from "../../components/PageSkeleton.tsx";
import { PcashAmount } from "../../components/PcashAmount.tsx";
import { SubpageHeadings } from "../../components/RouteHeader.tsx";
import { useEthereumNetwork } from "../../lib/EthereumProvider.tsx";
import { S_ACTION_WITH_ACCOUNT_UNITS, useNetworkFee } from "../../lib/useNetworkFee.ts";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { useFirstPcash, type FirstPcash } from "../get/useFirstPcash.ts";
import { AccountSetupPanel } from "../wallet/AccountSetupPanel.tsx";
import { useWalletPanel } from "../wallet/OwnerPanels.tsx";
import { routeById } from "../routeManifest.ts";
import { TRY_TABS, tryTabFor } from "./paths.ts";
import getStyles from "../get/GetRoute.module.css";
import styles from "./TryLayout.module.css";

const accountRoute = routeById("account");
const payRoute = routeById("get");

/** What setup needs besides ETH for gas: nothing while the network fee is zero, PCASH to burn while it is not. */
export function feeFree(networkFeeEach: bigint | undefined): boolean {
  return networkFeeEach === undefined || networkFeeEach === 0n;
}

/** Whether the signed-in wallet has an account, the condition every Try PCASH action starts from. */
export function useAccountReady(): boolean {
  const { wallet, profile, selfPublication, accountRecord } = useWallet();
  return wallet !== undefined && profile !== undefined && selfPublication !== undefined && accountRecord === "present";
}

const STEPS = [
  ["Get PCASH", "One Ethereum transaction sets up your account and gets your first PCASH."],
  ["Send it", "Pay an Ethereum address, or send a link anyone can claim, even without PCASH."],
  ["Earn more", "Post pending payments to Ethereum and collect new PCASH and fees."],
] as const;

/** Widths of the engraved numerals in public/brand, each drawn 200 pixels tall. */
const NUMERAL_WIDTHS = [127, 173, 170] as const;

/** What a newcomer does first and next. */
function SetupSteps({ received }: { received: boolean }) {
  return <ol className={getStyles.steps}>{STEPS.map(([title, body], index) => {
    const done = received && index === 0;
    return <li key={title} className={done ? getStyles.done : index === (received ? 1 : 0) ? getStyles.current : undefined}>
      <span aria-hidden="true"><img src={`/brand/numeral-${index + 1}.webp`} alt="" width={NUMERAL_WIDTHS[index]} height={200} />{done && <span className={getStyles.check}><CheckIcon size={14} /></span>}</span>
      <div><strong>{title}</strong><p>{done ? "Done." : body}</p></div>
    </li>;
  })}</ol>;
}

/** Until the account is ready, the wallet's own next step: connect, sign in, or the setup that gets the first PCASH. */
export function NextStep() {
  const { phase } = useWallet();
  const networkFeeEach = useNetworkFee(S_ACTION_WITH_ACCOUNT_UNITS, phase === "disconnected");
  // Until the saved connection and sign-in resolve, any step shown would be a guess.
  if (phase === "initializing") return null;
  if (phase !== "disconnected") return <AccountSetupPanel />;
  return <>
    <h2>Get your first PCASH</h2>
    <p className={getStyles.intro}>Connect an Ethereum wallet to get your first PCASH. Ethereum gas is paid in ETH.</p>
    {!feeFree(networkFeeEach) && <NetworkFeeFunding action="Setup" createsAccount />}
    <ConnectWallet />
  </>;
}

/** The setup's result: what arrived, and the payment to try next. */
function FirstPcashReady({ first, onDone, ethereumLink }: { first: FirstPcash; onDone: () => void; ethereumLink: (hash: string) => ReactNode }) {
  const panel = useWalletPanel();
  const navigate = useNavigate();
  // Send opens only once the wallet is ready; it can still be syncing, or off its network.
  const canSend = useWallet().phase === "ready";
  const send = (byLink: boolean) => { panel.chooseByLink(byLink); onDone(); navigate(payRoute.path); };
  return <div className={getStyles.first} data-testid="first-pcash">
    <p className="eyebrow">Received</p>
    <h2>Your PCASH is ready.</h2>
    <p className={getStyles.firstAmount} aria-live="polite">{first.amount === undefined ? <><span className="spinner" aria-hidden="true" /><span className="sr-only">Reading the amount received</span></> : <PcashAmount value={first.amount} />}</p>
    <p>Now try a private payment.</p>
    <div className={getStyles.firstActions}>
      <button type="button" className="button primary" disabled={!canSend} onClick={() => send(false)}>Send PCASH</button>
    </div>
    <button type="button" className={getStyles.linkCallout} disabled={!canSend} onClick={() => send(true)}>
      <strong>Send it by link</strong>
      <span>Whoever opens the link can claim it, even without PCASH. You don’t need their address.</span>
    </button>
    <p className={getStyles.firstFooter}>{first.l1TransactionHash !== undefined && <>{ethereumLink(first.l1TransactionHash)} · </>}<button type="button" className={getStyles.textButton} onClick={onDone}>Done</button></p>
  </div>;
}

/** Account setup, the first step whatever a visitor tries; once the account exists, a line that links to it. */
function AccountGate() {
  const wallet = useWallet();
  const accountReady = useAccountReady();
  const { l1Chain } = useEthereumNetwork();
  const [done, setDone] = useState(false);
  const first = useFirstPcash(accountReady && !done);
  const ethereumLink = (hash: string) => l1Chain.blockExplorers === undefined ? <code>{hash}</code>
    : <a href={`${l1Chain.blockExplorers.default.url}/tx/${hash}`} target="_blank" rel="noreferrer">View Ethereum transaction<ExternalLinkIcon /></a>;
  if (accountReady && first === undefined) {
    const balance = wallet.funds?.total;
    return <div className={styles.ready} data-testid="account-ready">
      <span className={styles.readyMark} aria-hidden="true"><CheckIcon size={14} /></span>
      <p><strong>Your account is ready.</strong>{balance !== undefined && <> <PcashAmount value={balance} rounding="down" /></>}</p>
      <Link to={accountRoute.path}>View your account →</Link>
    </div>;
  }
  return <section className={`panel ${getStyles.acquire}`} aria-label="Get your first PCASH">
    <SetupSteps received={first !== undefined} />
    <div className={getStyles.action}>
      {first !== undefined ? <FirstPcashReady first={first} onDone={() => setDone(true)} ethereumLink={ethereumLink} /> : <NextStep />}
    </div>
  </section>;
}

/** Try PCASH: account setup on top, then a tab for each thing to try. */
export function TryLayout() {
  const { pathname } = useLocation();
  const { connectedAccount, status, profile } = useWallet();
  const current = tryTabFor(pathname);
  return <div className={styles.page}>
    <header className={styles.heading}><h1>Try PCASH</h1></header>
    <AccountGate key={`${connectedAccount}:${status?.genesisHash}:${profile === undefined ? "locked" : "unlocked"}`} />
    <nav className={styles.tabs} aria-label="Try PCASH">
      {TRY_TABS.map((tab) => <Link key={tab.id} to={tab.path} className={tab.id === current?.id ? styles.active : undefined} aria-current={tab.id === current?.id ? "page" : undefined}>{tab.label}</Link>)}
    </nav>
    {/* Switching tabs keeps the account step and tabs in place while the next tab loads. */}
    <SubpageHeadings.Provider value={true}><Suspense fallback={<PageSkeleton />}><Outlet /></Suspense></SubpageHeadings.Provider>
  </div>;
}
