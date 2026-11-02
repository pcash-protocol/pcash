import { Link } from "react-router-dom";
import { useConnectWallet } from "../lib/useConnectWallet.ts";
import { useWallet } from "../lib/WalletProvider.tsx";
import { useWebsiteSettings } from "../lib/WebsiteSettings.tsx";
import { routeById } from "../routes/routeManifest.ts";
import styles from "./ConnectWallet.module.css";

/** The signed-out step wherever a wallet is needed: Connect wallet, its error, the ENS choice and the terms. */
export function ConnectWallet({ onNavigate }: { onNavigate?: () => void }) {
  const wallet = useWallet();
  const connect = useConnectWallet();
  const { ensEnabled, setEnsEnabled } = useWebsiteSettings();
  return <div className={styles.connect}>
    {wallet.error && <p className={styles.error} role="alert">{wallet.error}</p>}
    <button type="button" className="button primary" disabled={wallet.busy} onClick={connect}>Connect wallet</button>
    <label className={styles.ensChoice}><input type="checkbox" checked={ensEnabled} onChange={(event) => setEnsEnabled(event.target.checked)} />Show ENS names</label>
    <p className={styles.terms}>By connecting a wallet, you agree to the <Link to={routeById("terms").path} onClick={onNavigate}>Terms of Service</Link>.</p>
  </div>;
}
