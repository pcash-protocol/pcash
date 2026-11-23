import { Link } from "react-router-dom";
import { AccountAvatar } from "../../components/AccountAvatar.tsx";
import { CopyableAddress } from "../../components/EthereumAddress.tsx";
import { PaymentInProgress, WaitingPayment } from "../../components/WalletPanel.tsx";
import { WalletSettings } from "../../components/WalletSettings.tsx";
import { confirmDiscardGetWork, useGetActivity } from "../../lib/GetActivity.tsx";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { useEthereumIdentity } from "../../names/useEthereumName.ts";
import { Metadata } from "../Metadata.tsx";
import { useMarketplaceTodoCount } from "../marketplace/MarketplaceProvider.tsx";
import { routeById } from "../routeManifest.ts";
import { TokenBalanceRows } from "../tokens/TokenBalances.tsx";
import { NextStep, useAccountReady } from "../try/TryLayout.tsx";
import { Activity } from "../wallet/Activity.tsx";
import { MiningBalance } from "../wallet/MiningBalance.tsx";
import { AccountStatusNotices, ReceiveCard } from "../wallet/OwnerPanels.tsx";
import styles from "./AccountRoute.module.css";

const route = routeById("account");
const pay = routeById("get");
const earn = routeById("get-earn");
const tokens = routeById("tokens");
const newToken = routeById("token-new");
const marketplace = routeById("marketplace");

const SECTIONS = [["tokens", "Tokens"], ["activity", "Activity"], ["trades", "Trades"], ["receive", "Receive"], ["settings", "Settings"]] as const;

/** Everything that is yours: balances, activity, tokens, trades, how to be paid, and this browser's wallet settings. */
export default function AccountRoute() {
  const wallet = useWallet();
  const accountReady = useAccountReady();
  const address = wallet.connectedAccount;
  const identity = useEthereumIdentity(address);
  const getActivity = useGetActivity();
  const todos = useMarketplaceTodoCount();
  const assets = wallet.snapshot?.assets ?? [];
  const disconnect = () => { if (!getActivity.unsafeToLeave || confirmDiscardGetWork()) void wallet.disconnect().catch(() => undefined); };
  return <div className={styles.page}>
    <Metadata {...route.metadata} />
    <header className={styles.head}>
      <div className={styles.who}>
        {address !== undefined && <AccountAvatar address={address} avatar={identity.avatar} className={styles.avatar} />}
        <div><h1>{identity.name ?? "Your account"}</h1>{address === undefined ? <span className={styles.muted}>Not connected</span> : <CopyableAddress address={address} />}</div>
      </div>
      {accountReady && <div className={styles.balance}><MiningBalance testId="account-balance" /></div>}
      {accountReady && <div className={styles.actions}>
        <Link className="button primary" to={pay.path}>Send</Link>
        <a className="button" href="#receive">Receive</a>
        <Link className="button" to={earn.path}>Earn more</Link>
      </div>}
    </header>
    {!accountReady ? <section className={`panel ${styles.setup}`} aria-label="Set up your account">
      <NextStep />
      <p className={styles.muted}>Or start on <Link to={pay.path}>Try PCASH</Link>, which walks through setup and your first payment.</p>
    </section> : <div className={styles.layout}>
      <nav className={styles.index} aria-label="On this page">{SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</nav>
      <div className={styles.sections}>
        <WaitingPayment />
        <PaymentInProgress />
        {wallet.phase === "ready" && <AccountStatusNotices />}
        <section id="tokens" aria-labelledby="tokens-heading">
          <div className={styles.sectionHead}><h2 id="tokens-heading">Tokens</h2><span><Link to={newToken.path}>Create a token</Link> · <Link to={tokens.path}>Check a token</Link></span></div>
          {assets.length === 0
            ? <p className={styles.muted}>Tokens you create or receive appear here. Open a token link to add one.</p>
            : <TokenBalanceRows assets={assets} />}
        </section>
        <section id="activity" aria-labelledby="activity-heading">
          <div className={styles.sectionHead}><h2 id="activity-heading">Activity</h2></div>
          <Activity />
        </section>
        <section id="trades" aria-labelledby="trades-heading">
          <div className={styles.sectionHead}><h2 id="trades-heading">Trades</h2><Link to={marketplace.path}>Open the Marketplace →</Link></div>
          <p>{todos === 0 ? "No trades are waiting on you." : `${todos} ${todos === 1 ? "trade is" : "trades are"} waiting on you in the Marketplace.`}</p>
        </section>
        {/* The receive card carries the #receive anchor itself. */}
        {address !== undefined && <section className={styles.receive}><ReceiveCard address={address} /></section>}
        <section id="settings" className={styles.settings}>
          <WalletSettings />
        </section>
        <footer className={styles.footer}>
          {address !== undefined && <Link to={`/${address}`}>View your account in the explorer →</Link>}
          <button type="button" className="button" onClick={disconnect}>Disconnect</button>
        </footer>
      </div>
    </div>}
  </div>;
}
