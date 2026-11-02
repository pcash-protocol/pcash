import { Link } from "react-router-dom";
import styles from "./MarketplaceRoute.module.css";
import { Notice } from "../../components/Notice.tsx";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { useConnectWallet } from "../../lib/useConnectWallet.ts";
import { useWalletPanel } from "../wallet/OwnerPanels.tsx";

/** Keep the selected trade visible while the shared wallet finishes setup. */
export function TradeWalletSetup() {
  const { phase, busy, error, activation, activationBlocker, activationContentHash, connectionStep, switchNetwork,
    checkAccountActivation, signIn } = useWallet();
  const panel = useWalletPanel();
  const connectWallet = useConnectWallet();
  if (phase === "ready") return null;

  let label: string | undefined;
  let action: (() => unknown) | undefined;
  let explanation = "Your listing details will stay here while you set up your wallet.";
  switch (phase) {
    case "disconnected": label = "Connect wallet"; action = connectWallet; break;
    case "wrong-network": label = "Switch network"; action = switchNetwork; break;
    case "sign-in-required":
      label = "Sign in"; action = signIn;
      explanation = "Sign in with a free signature to unlock your PCASH.";
      break;
    case "activation-required":
    case "activation-prepared":
      label = "Open wallet"; action = panel.openOverview;
      explanation = "Choose Set up and mine in the wallet panel to register and mine your first PCASH. Gas is paid in ETH.";
      break;
    case "activation-ambiguous":
      label = "Check status"; action = checkAccountActivation;
      explanation = "Your wallet hasn’t returned a transaction hash. Check its transaction activity.";
      break;
    case "activation-blocked":
      label = "Check status"; action = checkAccountActivation;
      explanation = "An earlier Ethereum transaction is unresolved. Review it before continuing setup.";
      break;
    case "activation-mining":
      label = busy ? "Checking status…" : "Check status"; action = checkAccountActivation;
      explanation = "Waiting for Ethereum confirmation…";
      break;
    case "activation-pending":
      label = busy ? "Checking status…" : "Check status"; action = checkAccountActivation;
      explanation = "Ethereum confirmed. PCASH is processing your account…";
      break;
    case "error": label = "Reconnect wallet"; action = connectWallet; break;
    default: explanation = connectionStep ?? "Preparing your wallet…";
  }
  const activationInProgress = phase === "activating" || phase.startsWith("activation-");
  const transactionHash = activationBlocker ? activationBlocker.transactionHash : activation?.l1TxHash;
  return <div aria-label="Wallet setup">
    {activationInProgress && <><strong>Set up and mine</strong><p>This enables spending from your wallet. It does not submit a trade.</p></>}
    <p role="status">{explanation}</p>
    {transactionHash && <p className={styles.progressTransaction}>Ethereum transaction<br /><code>{transactionHash}</code></p>}
    {activationBlocker && <p><Link to="#ethereum-submission">Review Ethereum transaction</Link></p>}
    {activationContentHash && <p><Link to={`/tx/${activationContentHash}`}>View PCASH activation transaction →</Link></p>}
    {error && <Notice tone="error">{error}</Notice>}
    {label && <button className="button primary" type="button" disabled={busy || action === undefined}
      onClick={() => { void Promise.resolve(action?.()).catch(() => undefined); }}>{label}</button>}
  </div>;
}
