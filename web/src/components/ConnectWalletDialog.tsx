import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "react-router-dom";
import { useChains, useConfig, useConnectors, type Config, type Connector } from "wagmi";
import { connect } from "wagmi/actions";
import { WALLET_PANEL_HASHES } from "../lib/walletSurface.ts";
import { routeById } from "../routes/routeManifest.ts";
import { heldPageFragment } from "../routes/tokens/usePageFragment.ts";
import { CopyButton } from "./CopyButton.tsx";
import { friendlyError } from "./friendlyError.ts";
import { QrCode } from "./QrCode.tsx";
import styles from "./ConnectWalletDialog.module.css";
import ledgerIcon from "./walletIcons/ledgerWallet.svg";
import metaMaskIcon from "./walletIcons/metaMaskWallet.svg";
import okxIcon from "./walletIcons/okxWallet.svg";
import rabbyIcon from "./walletIcons/rabbyWallet.svg";
import rainbowIcon from "./walletIcons/rainbowWallet.svg";
import trustIcon from "./walletIcons/trustWallet.svg";
import uniswapIcon from "./walletIcons/uniswapWallet.svg";
import walletConnectIcon from "./walletIcons/walletConnectWallet.svg";
import zerionIcon from "./walletIcons/zerionWallet.svg";

/** A detected wallet's icon is the one it announces, and may be absent. */
type WalletOption = { id: string; name: string; icon?: string | undefined; connector: Connector } & (
  | { kind: "browser" }
  | { kind: "metaMask" }
  | { kind: "metaMaskBrowser" }
  | { kind: "app"; link: (uri: string) => string }
  | { kind: "qr" });

const encode = encodeURIComponent;
const android = () => /android/i.test(navigator.userAgent);
/** Wallet apps a phone browser opens over WalletConnect. On Android the bare `wc:` link lets the system pick the app. */
const WALLET_APPS: ReadonlyArray<{ id: string; name: string; icon: string; link: (uri: string) => string }> = [
  { id: "trust", name: "Trust Wallet", icon: trustIcon, link: (uri) => `trust://wc?uri=${encode(uri)}` },
  { id: "rainbow", name: "Rainbow", icon: rainbowIcon, link: (uri) => android() ? uri : `rainbow://wc?uri=${encode(uri)}` },
  { id: "uniswap", name: "Uniswap Wallet", icon: uniswapIcon, link: (uri) => `uniswap://wc?uri=${encode(uri)}` },
  { id: "okx", name: "OKX Wallet", icon: okxIcon, link: (uri) => android() ? uri : `okex://main/wc?uri=${encode(uri)}` },
  { id: "ledger", name: "Ledger Live", icon: ledgerIcon, link: (uri) => android() ? uri : `ledgerlive://wc?uri=${encode(uri)}` },
  { id: "zerion", name: "Zerion", icon: zerionIcon, link: (uri) => android() ? uri : `zerion://wc?uri=${encode(uri)}` },
];

function isPhone(): boolean {
  const { userAgent, platform, maxTouchPoints } = navigator;
  return /android|iphone|ipod|ipad/i.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
}

/**
 * MetaMask Connect's own test for MetaMask's in-app browser, where it reaches
 * MetaMask through the page. From any other phone browser it reaches the app
 * through MetaMask's relay, which drops messages over 64 KiB, and every
 * proof-bearing transaction is larger.
 */
const inMetaMaskBrowser = () => "ReactNativeWebView" in window && navigator.userAgent.endsWith("MetaMaskMobile");

/**
 * This site in MetaMask's browser, through MetaMask's link service, which so
 * sees the host only. The page itself is copied and pasted instead: its query
 * can name a private payment's recipient, and its fragment can be a claim
 * link's bearer secret.
 */
const metaMaskBrowserLink = () => `https://metamask.app.link/dapp/${window.location.host}`;

/** The page's full link. Its own fragment is in the address bar, or held by the page while the wallet panel's is there. */
function pageLink(): string {
  const { origin, hash, pathname, search } = window.location;
  const own = hash.length > 1 && !WALLET_PANEL_HASHES.includes(hash) ? hash : heldPageFragment(pathname + search);
  return `${origin}${pathname}${search}${own ?? hash}`;
}

/** Wallets found in this browser first, then MetaMask, then wallet apps on another device. */
function walletOptions(connectors: readonly Connector[], rabbyInstalled: boolean, phone: boolean): WalletOption[] {
  const announced = connectors.filter((connector) => connector.type === "injected" && connector.id !== "rabby");
  const rabby = connectors.find((connector) => connector.id === "rabby");
  const metaMask = connectors.find((connector) => connector.id === "metaMaskSDK");
  const walletConnect = connectors.find((connector) => connector.id === "walletConnect");
  return [
    ...announced.map((connector): WalletOption => ({ kind: "browser", id: connector.id, name: connector.name, icon: connector.icon, connector })),
    ...(rabby !== undefined && rabbyInstalled && !announced.some((connector) => connector.id === "io.rabby")
      ? [{ kind: "browser", id: "rabby", name: "Rabby Wallet", icon: rabbyIcon, connector: rabby } as const] : []),
    ...(metaMask === undefined ? [] : [{ kind: phone && !inMetaMaskBrowser() ? "metaMaskBrowser" : "metaMask", id: "metaMask", name: "MetaMask", icon: metaMaskIcon, connector: metaMask } as const]),
    ...(walletConnect === undefined ? [] : phone
      ? WALLET_APPS.map((app): WalletOption => ({ kind: "app", ...app, connector: walletConnect }))
      : [{ kind: "qr", id: "walletConnect", name: "WalletConnect", icon: walletConnectIcon, connector: walletConnect } as const]),
  ];
}

interface Attempt { option: WalletOption; uri?: string; error?: string }

const waitingMessage = (option: WalletOption) => option.kind === "browser" ? `Confirm in ${option.name}…`
  : option.kind === "metaMask" ? "Continue in MetaMask…"
  : option.kind === "app" ? `Opening ${option.name}…` : "Preparing the code…";

/** WalletConnect reads this to reopen the wallet app for later requests, such as the sign-in signature. */
const WALLETCONNECT_APP = "WALLETCONNECT_DEEPLINK_CHOICE";

/**
 * Disconnects a wallet approved after the user picked another one. wagmi's
 * disconnect action publishes the connections it read before waiting for the
 * wallet, which drops a connection made meanwhile; the connector's disconnect
 * event removes it from the current state instead.
 */
function retire(config: Config, connector: Connector) {
  connector.emitter.emit("disconnect");
  void connector.disconnect().catch(() => undefined);
  // connect() saved the retired wallet as the one to reconnect on the next page load.
  const { connections, current } = config.state;
  const next = current === null ? undefined : connections.get(current)?.connector;
  if (next !== undefined) void config.storage?.setItem("recentConnectorId", next.id);
}

function ConnectWalletDialog({ onClose, chosen }: {
  onClose: () => void;
  /** The connector picked last, across picker openings. */
  chosen: RefObject<string | undefined>;
}) {
  const config = useConfig();
  const [chain] = useChains();
  const connectors = useConnectors();
  const rabby = connectors.find((connector) => connector.id === "rabby");
  const [rabbyInstalled, setRabbyInstalled] = useState(false);
  useEffect(() => {
    let live = true;
    void rabby?.getProvider().then((provider) => { if (live) setRabbyInstalled(provider !== undefined); }, () => undefined);
    return () => { live = false; };
  }, [rabby]);
  const options = useMemo(() => walletOptions(connectors, rabbyInstalled, isPhone()), [connectors, rabbyInstalled]);
  const [attempt, setAttempt] = useState<Attempt>();
  const attemptNumber = useRef(0);
  const stopListening = useRef<() => void>(undefined);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const pressStartedOnBackdrop = useRef(false);
  // showModal focuses the close button, which Safari draws with the keyboard focus ring.
  useEffect(() => { dialog.current?.showModal(); heading.current?.focus(); }, []);
  // A closed picker's attempts no longer drive any picker.
  useEffect(() => () => { attemptNumber.current += 1; stopListening.current?.(); }, []);

  const choose = async (option: WalletOption) => {
    const number = ++attemptNumber.current;
    const current = () => attemptNumber.current === number;
    stopListening.current?.();
    setAttempt({ option });
    if (option.kind === "metaMaskBrowser") { chosen.current = undefined; return; }
    chosen.current = option.connector.uid;
    // WalletConnect and MetaMask Connect report a pairing link. A phone hands
    // WalletConnect's to the wallet app (MetaMask Connect opens MetaMask
    // itself); a computer shows the link as a QR code.
    const phone = isPhone();
    const onMessage = ({ type, data }: { type: string; data?: unknown }) => {
      if (type !== "display_uri" || typeof data !== "string" || !current()) return;
      if (option.kind === "app") {
        const link = option.link(data);
        localStorage.setItem(WALLETCONNECT_APP, JSON.stringify({ href: link.split("?")[0], name: option.name }));
        window.location.href = link;
      } else if (option.kind !== "browser" && !phone) setAttempt({ option, uri: data });
    };
    option.connector.emitter.on("message", onMessage);
    stopListening.current = () => option.connector.emitter.off("message", onMessage);
    try {
      await connect(config, { connector: option.connector, chainId: chain.id });
      if (chosen.current !== option.connector.uid) retire(config, option.connector);
      else if (current()) onClose();
    } catch (cause) {
      if (current()) setAttempt({ option, error: friendlyError(cause) });
    } finally {
      option.connector.emitter.off("message", onMessage);
    }
  };
  const back = () => { attemptNumber.current += 1; stopListening.current?.(); setAttempt(undefined); };
  const waiting = attempt !== undefined && attempt.error === undefined;

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="connect-wallet-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onMouseDown={(event) => { pressStartedOnBackdrop.current = event.target === event.currentTarget; }}
    onClick={(event) => { if (pressStartedOnBackdrop.current && event.target === event.currentTarget) onClose(); }}>
    <div className={styles.content}>
      <div className={styles.header}>
        <h2 id="connect-wallet-title" ref={heading} tabIndex={-1}>{attempt?.uri === undefined ? "Connect a wallet" : "Scan with your phone wallet"}</h2>
        <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>×</button>
      </div>
      {waiting ? <>
        {attempt.option.kind === "metaMaskBrowser" ? <>
          <p className={styles.status}>On a phone, use MetaMask through its own browser. To continue on this page there, copy its link, open MetaMask, and paste it into the address bar.</p>
          <CopyButton className={`button ${styles.openIn}`} value={pageLink()} label="Copy link" showLabel />
          <a className={`button primary ${styles.openIn}`} href={metaMaskBrowserLink()}>Open MetaMask</a>
        </> : attempt.uri === undefined
          ? <p className={styles.status} role="status">{waitingMessage(attempt.option)}</p>
          : <><QrCode value={attempt.uri} label={`${attempt.option.name} code`} />
            <p className={styles.status}>{attempt.option.kind === "metaMask" ? "Scan this code with your phone's camera to open MetaMask." : "Scan this code with a WalletConnect wallet."}</p></>}
        <button type="button" className="button" onClick={back}>Back</button>
      </> : <ul className={styles.options}>
        {options.map((option) => <li key={option.id}>
          <button type="button" className={styles.option} data-testid={`wallet-option-${option.id}`} onClick={() => void choose(option)}>
            {option.icon !== undefined && <img src={option.icon} alt="" />}
            <span>{option.name}</span>
          </button>
        </li>)}
      </ul>}
      {attempt?.error !== undefined && <p className={styles.error} role="alert">{attempt.error}</p>}
      <p className={styles.terms}>By connecting a wallet, you agree to the <Link to={routeById("terms").path} onClick={onClose}>Terms of Service</Link>.</p>
    </div>
  </dialog>;
}

const ConnectWalletContext = createContext<{ open: () => void; isOpen: boolean } | null>(null);

/** Opens the wallet picker; the wallet session takes over once wagmi reports the connection. */
export function useConnectWalletDialog() { return useContext(ConnectWalletContext)!; }

export function ConnectWalletProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const chosen = useRef<string>(undefined);
  const value = useMemo(() => ({ open: () => setOpen(true), isOpen }), [isOpen]);
  return <ConnectWalletContext.Provider value={value}>
    {children}
    {isOpen && <ConnectWalletDialog onClose={() => setOpen(false)} chosen={chosen} />}
  </ConnectWalletContext.Provider>;
}
