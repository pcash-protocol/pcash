import { useEthereumNetwork } from "../../lib/EthereumProvider.tsx";
import { Link } from "react-router-dom";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { ExternalLinkIcon } from "../../components/icons.tsx";
import styles from "./AccountSetupPanel.module.css";

/** Keep the blocking Ethereum submission visible where the user wants to mine. */
export function AccountActivationStatus() {
  const wallet = useWallet();
  const { l1Chain } = useEthereumNetwork();
  const { activation, activationBlocker: blocker, activationTransaction: transaction, phase } = wallet;
  const pending = phase === "activation-mining" || phase === "activation-pending"
    || phase === "activation-ambiguous" || phase === "activation-blocked";
  if (!pending) return null;
  if (!blocker && activation?.publication === "open") {
    const expired = wallet.status !== undefined && wallet.status.latestBlockTimestamp > BigInt(activation.validUntilTimestamp);
    return <div data-testid="activation-status">
      <p role="status" className={styles.status}>{expired
        ? "Your setup authorization expired before a relayer published it. Retry to sign and prove a fresh setup."
        : "Waiting for a relayer to publish your account setup. The relayer receives the mining reward."}</p>
      <p><Link to={`/tx/${activation.contentHash}`}>View setup transaction</Link></p>
      {expired && <button type="button" className="button" disabled={wallet.busy}
        onClick={() => void wallet.retryAccountSetup(activation.contentHash, "open").catch(() => undefined)}>{wallet.busy ? "Retrying setup…" : "Retry setup without ETH"}</button>}
      {wallet.error && <p role="alert">{wallet.error}</p>}
    </div>;
  }
  const hash = blocker ? blocker.transactionHash : activation?.l1TxHash ?? transaction?.hash;
  const expired = !blocker && activation !== undefined && wallet.status !== undefined
    && wallet.status.latestBlockTimestamp > BigInt(activation.validUntilTimestamp)
    && phase !== "activation-ambiguous" && phase !== "activation-pending" && transaction?.state !== "included";
  const message = blocker ? "An earlier Ethereum submission is blocking account setup. Review it to continue."
    : expired ? "Your account setup authorization expired. Check the Ethereum transaction before retrying setup."
    : phase === "activation-pending" || transaction?.state === "included" ? "Ethereum confirmed your account transaction. Waiting for PCASH to process it."
    : transaction?.state === "missing" ? "Ethereum cannot find your account transaction. Review it in your wallet before retrying."
    : !hash ? "Your wallet did not return a transaction hash. Check its activity before continuing."
    : "Waiting for Ethereum transaction inclusion…";
  const waiting = Boolean(hash) && !blocker && !expired && transaction?.state !== "missing"
    && phase !== "activation-ambiguous";
  return <div data-testid="activation-status">
    <p role="status" className={styles.status}>{waiting && <span className="spinner" aria-hidden="true" />}{message}</p>
    {hash && <>
      {!blocker && <p>This transaction sets up your account authorization and mines your first PCASH.</p>}
      <p className={styles.receipt}>Ethereum transaction<code>{l1Chain.blockExplorers
        ? <a href={`${l1Chain.blockExplorers.default.url}/tx/${hash}`} target="_blank" rel="noreferrer">{hash}<ExternalLinkIcon /></a>
        : hash}</code></p>
    </>}
    {transaction?.state === "queued" && <p>This transaction uses nonce {transaction.nonce}, but Ethereum is waiting for nonce {transaction.nextNonce}. Check pending transactions and nonce settings in your Ethereum wallet.</p>}
    {expired && <>
      <p>Retry checks the earlier Ethereum submission first. Setup can restart only after that submission is resolved.</p>
      <button type="button" className="button" disabled={wallet.busy} onClick={() => void wallet.retryAccountSetup(activation.contentHash, "self").catch(() => undefined)}>{wallet.busy ? "Retrying setup…" : "Retry setup"}</button>
    </>}
    <p><Link to="#ethereum-submission">Review Ethereum transaction</Link></p>
    {wallet.error && <p role="alert">{wallet.error}</p>}
  </div>;
}
