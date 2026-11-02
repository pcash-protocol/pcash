import { RelativeTime } from "../../components/RelativeTime.tsx";
import { PcashAmount } from "../../components/PcashAmount.tsx";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { NAMES_OFF_MESSAGE } from "../../names/NameResolutionSession.ts";
import { PageSkeleton } from "../../components/PageSkeleton.tsx";
import { AccountAvatar } from "../../components/AccountAvatar.tsx";
import { ADDRESS_PATH_PREFIX, identityNameFromPath } from "../explorer/identityName.ts";
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { ExplorerCursor, TransactionPageResult } from "@pcash/sdk/clients";
import { Metadata } from "../Metadata.tsx";
import { useNameAddress, useEthereumIdentity } from "../../names/useEthereumName.ts";
import {
  ExplorerProvider,
  type AccountSnapshot,
  useExplorer,
  useReadyExplorer,
} from "../explorer/ExplorerProvider.tsx";
import { ContractView } from "../explorer/ContractView.tsx";
import { isAddressPath } from "../explorer/paths.ts";
import {
  formatKind,
  outcomeLabel,
  outcomeTone,
  shortHex,
} from "../explorer/format.ts";
import {
  BlockLink,
  Empty,
  Fact,
  Facts,
  Failure,
  AddressDisplay,
  Loading,
  Pager,
  Tag,
  TableScroll,
  TransactionLink,
  useRead,
} from "../explorer/ui.tsx";
import { useWalletPanel } from "../wallet/OwnerPanels.tsx";
import { CopyableAddress } from "../../components/EthereumAddress.tsx";
import { Activity } from "../wallet/Activity.tsx";
import explorer from "../explorer/ExplorerRoute.module.css";
import styles from "./AddressRoute.module.css";
import paper from "../PaperPage.module.css";

function AccountHistoryTable({ page }: { page: TransactionPageResult }) {
  if (page.items.length === 0) {
    return <Empty>
      No account events on this page.
    </Empty>;
  }
  return <>
    <TableScroll>
      <table>
        <thead>
          <tr>
            <th>Transaction</th><th className={explorer.num}>Block</th><th>Age</th><th>Event</th><th className={explorer.num}>Revision</th><th>Result</th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((item) => <tr key={item.transactionId}>
            <td><TransactionLink transactionId={item.transactionId} /></td>
            <td className={explorer.num}><BlockLink number={item.block.blockNumber} /></td>
            <td className="muted"><RelativeTime seconds={item.timestamp} /></td>
            <td>{formatKind(item.kind)}</td>
            <td className={explorer.num}>{item.account?.accountRevision.toString() ?? "—"}</td>
            <td><Tag tone={outcomeTone(item.outcome)}>{outcomeLabel(item.outcome)}</Tag></td>
          </tr>)}
        </tbody>
      </table>
    </TableScroll>

  </>;
}

function AccountHistory({ address }: { address: string }) {
  const { reader, status } = useReadyExplorer();
  const [cursors, setCursors] = useState<(ExplorerCursor | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const { value, error, reload } = useRead(() => reader.accountHistory({ address, limit: 25, ...(cursor === undefined ? {} : { cursor }) }), [reader, address, cursor], { refreshDeps: [status.latestBlockHash] });
  if (value === undefined) return error === undefined ? <Loading /> : <Failure onRetry={reload}>{error}</Failure>;
  return <section className="panel">{error !== undefined && <Failure>Update delayed. {error}</Failure>}<AccountHistoryTable page={value} /><Pager hasPrevious={cursors.length > 1} hasNext={value.nextCursor !== null} onPrevious={() => setCursors((old) => old.slice(0, -1))} onNext={() => { if (value.nextCursor !== null) setCursors((old) => [...old, value.nextCursor!]); }}>Page {cursors.length}</Pager></section>;
}

type AddressIdentity = { address: string; identityName?: string; avatar?: string | undefined; accountPathname: string };

function AddressPage(props: AddressIdentity) {
  const { reader, status } = useReadyExplorer();
  // An account changes only in a new block.
  const accountRead = useRead(() => reader.accountSnapshot(props.address), [reader, props.address], { refreshDeps: [status.latestBlockHash] });
  if (accountRead.value?.account?.accountKind === 1) return <ContractView address={props.address} activity={<AccountHistory address={props.address} />} />;
  if (accountRead.value === undefined) {
    return <div className={explorer.stack}><Metadata title={props.identityName ?? shortHex(props.address)} description="PCASH account" /><header><h1>{props.identityName ?? "Account"}</h1><AddressDisplay address={props.address} showAddress /></header>{accountRead.error === undefined ? <Loading>Loading account…</Loading> : <Failure onRetry={accountRead.reload}>{accountRead.error}</Failure>}</div>;
  }
  return <UserAddressPage {...props} accountRead={accountRead} />;
}

function UserAddressPage({ address, identityName, avatar, accountPathname, accountRead }: AddressIdentity & { accountRead: { value: AccountSnapshot | undefined; error: string | undefined } }) {
  const { status } = useReadyExplorer();
  const { profile, funds, connectedAccount, phase, signIn } = useWallet();
  const owner = connectedAccount?.toLowerCase() === address.toLowerCase();
  const signedIn = owner && profile !== undefined;
  const location = useLocation();
  const panel = useWalletPanel();
  const account = accountRead.value?.account;
  // Canonical account state; the derived index's copy of the key may lag.
  const receivable = account != null && BigInt(account.receiveKeyHash) !== 0n;
  // A name is resolved again when the payment is reviewed; the page's lookup may come from cache.
  const payee = isAddressPath(accountPathname) ? address : identityName ?? address;

  return <div className={`${explorer.stack} ${paper.page} ${styles.page}`}>
    <Metadata title={identityName ?? shortHex(address)} description={`PCASH account for ${identityName ?? address}.`} />
    <header className={styles.identity}>
      <AccountAvatar address={address} avatar={avatar} className={styles.avatar} />
      <div className={styles.identityText}>{identityName === undefined ? <h1 className={styles.hexHeading}>{shortHex(address)}</h1> : <h1>{identityName}</h1>}<div aria-label="Receive address"><CopyableAddress address={address} /></div></div>
      {account !== undefined && <span className={styles.registration}><span className={styles.statusDot} aria-hidden="true" />{account === null ? "Not registered" : "Account registered"}</span>}
    </header>
    <section aria-label="PCASH balance" className={styles.balanceLine}>
      <div><p className={styles.balanceLabel}>Balance</p><div className={styles.balance} data-testid="wallet-balance">{!signedIn ? <span className={styles.hidden} aria-label="Private">*****</span> : funds === undefined ? "—" : <PcashAmount value={funds.total} rounding="down" />}</div></div>
      {account !== undefined && <div className={styles.actions}>{!receivable ? account === null && owner
        ? <button type="button" className="button primary" onClick={() => panel.openOverview()}>Set up PCASH</button>
        : account === null ? <>
          <p className={styles.notReceivable}>This address hasn't set up PCASH yet.</p>
          {/* A payment to it is a direct send, delivered by a link the sender shares. */}
          <button type="button" className="button primary" onClick={() => panel.openSendTo(payee)}>Send</button>
        </>
        : <p className={styles.notReceivable}>This address hasn't set up PCASH yet.</p>
        : owner ? <button type="button" className="button primary" onClick={() => panel.openReceive(address)}>Receive</button>
        // The wallet opens Send once it is ready, after any connect, sign-in, or setup the visitor still needs.
        : <button type="button" className="button primary" onClick={() => panel.openSendTo(payee)}>Send</button>}</div>}
    </section>
    {signedIn ? <>
      <h2 className={styles.sectionHeading}>Activity</h2>
      <section className="panel"><Activity /></section>
    </> : <>
      <h2 className={styles.sectionHeading}>Account history</h2>
      {owner && <p className={styles.signIn}>Sign in to see your activity. {phase === "sign-in-required"
        ? <button type="button" className="button" onClick={() => void signIn().catch(() => undefined)}>Sign in</button>
        : <Link to={{ pathname: location.pathname, search: location.search, hash: "#wallet" }} preventScrollReset>Open your wallet</Link>}</p>}
      <AccountHistory key={address} address={address} />
    </>}
    <details className={styles.details}><summary>Account details</summary>
      {accountRead.error !== undefined && <p>Account details could not be updated.</p>}{account === undefined ? (accountRead.error === undefined && <p>Loading account…</p>) : <Facts>
        <Fact label="Kind">{account === null ? "Not registered" : "User"}</Fact>
        {account !== null && <Fact label="Revision">{account.accountRevision.toString()}</Fact>}
        <Fact label="Network">{status.pcashChainId.toString()}</Fact><Fact label="Inbox"><AddressDisplay address={status.inboxAddress} /></Fact>
      </Facts>}
    </details>
  </div>;
}

/** Resolves what the URL names, then renders the account page for it. */
function AddressContent() {
  const { pathname } = useLocation();
  const { connection } = useExplorer();
  const isHex = isAddressPath(pathname);
  const identity = isHex ? pathname.slice(ADDRESS_PATH_PREFIX.length) : identityNameFromPath(pathname) ?? pathname.slice(ADDRESS_PATH_PREFIX.length);
  const namedAddress = useNameAddress(isHex ? undefined : identity);
  const reverse = useEthereumIdentity(isHex ? identity : namedAddress.state === "resolved" ? namedAddress.address : undefined);

  if (connection.phase === "connecting") return <PageSkeleton />;
  if (connection.phase !== "ready") {
    return <div className={explorer.stack}>
      <section className={`panel ${explorer.statusPanel}`}>
        <p className="eyebrow">Connection</p>
        <h2>Explorer unavailable</h2>
        <p>{connection.message}</p>
      </section>
    </div>;
  }

  if (isHex) {
    return <AddressPage key={identity.toLowerCase()} address={identity} accountPathname={pathname} avatar={reverse.avatar} {...(reverse.name === undefined ? {} : { identityName: reverse.name })} />;
  }
  if (namedAddress.state === "disabled") return <Failure>{NAMES_OFF_MESSAGE}</Failure>;
  if (namedAddress.state === "resolving") return <Loading>Resolving {identity}…</Loading>;
  if (namedAddress.state === "error") return <Failure>Name resolution is temporarily unavailable. <button onClick={namedAddress.retry}>Retry</button></Failure>;
  if (namedAddress.state === "unresolved") {
    return <Failure>{identity} does not resolve to an Ethereum address.</Failure>;
  }
  return <AddressPage key={namedAddress.address.toLowerCase()} address={namedAddress.address} accountPathname={pathname} identityName={identity} avatar={reverse.avatar} />;
}

export default function AddressRoute() {
  return <ExplorerProvider><div className={`${paper.page} ${styles.shell}`}><AddressContent /></div></ExplorerProvider>;
}
