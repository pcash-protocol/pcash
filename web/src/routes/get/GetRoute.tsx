import { Link } from "react-router-dom";
import { Metadata } from "../Metadata.tsx";
import { MAC_WALLET_DOWNLOAD_URL, MAC_WALLET_SETUP_PATH } from "../docs/publicDocuments.ts";
import { routeById } from "../routeManifest.ts";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { ReceiveCard, SendCard } from "../wallet/OwnerPanels.tsx";
import { useAccountReady } from "../try/TryLayout.tsx";
import styles from "./GetRoute.module.css";

/** Try PCASH's Pay tab: send a private payment or a claim link, and the link others pay you at. */
export default function GetRoute() {
  const { phase, connectedAccount } = useWallet();
  const accountReady = useAccountReady();
  return <div className={styles.pay}>
    <Metadata {...routeById("get").metadata} />
    {accountReady
      ? <div className={styles.payGrid}>
        <section className="panel" aria-label="Send PCASH">{phase === "ready" ? <SendCard /> : <p role="status">Send opens when your wallet is ready.</p>}</section>
        {connectedAccount !== undefined && <ReceiveCard address={connectedAccount} />}
      </div>
      : <section className={`panel ${styles.payPreview}`} aria-labelledby="pay-heading">
        <h2 id="pay-heading">Send PCASH</h2>
        <p>Pay any Ethereum address, or send a link anyone can claim, even someone without PCASH. Your device makes the proof, and the recipient needs nothing to receive it.</p>
        <p className={styles.setupFirst}>Set up your account above to send.</p>
      </section>}
    <p className={styles.walletDownload}>
      <a href={MAC_WALLET_DOWNLOAD_URL}>Download PCASH Wallet for Mac</a>
      <span>Apple Silicon · Testnet</span>
      <Link to={MAC_WALLET_SETUP_PATH}>Setup instructions</Link>
    </p>
  </div>;
}
