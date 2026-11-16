import { useState } from "react";
import { useEthereumNetwork } from "../lib/EthereumProvider.tsx";
import { errorMessage, useWallet } from "../lib/WalletProvider.tsx";
import { ExternalLinkIcon } from "./icons.tsx";
import styles from "./WalletPanel.module.css";

/**
 * Whether the Ethereum wallet prompt of `running` work is open. Another
 * screen's prompt does not count, because that screen's work is not `running` here.
 */
export function useConfirmInWallet(running: boolean): boolean {
  const { walletPromptOpen } = useWallet();
  return running && walletPromptOpen;
}

/** The status line under a button whose Ethereum wallet prompt is open. */
export function ConfirmInWallet({ className }: { className?: string | undefined }) {
  return <p role="status" className={`${styles.confirmInWallet} ${className ?? ""}`}><span className="spinner" aria-hidden="true" />Confirm in your wallet</p>;
}

/** A pending Ethereum submission blocks the next one; Refresh releases it once it can no longer land. */
export function WalletSubmissionLock() {
  const { submissionLock, refreshSubmissionLock } = useWallet();
  const { l1Chain } = useEthereumNetwork();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const hash = submissionLock?.transactionHash;
  const refresh = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await refreshSubmissionLock();
      setMessage(result.waiting.length === 0 ? "Cleared. You can submit again."
        : result.awaitingDerivation.length === result.waiting.length ? "Ethereum confirmed your transaction. Waiting for PCASH to process it."
        : result.awaitingDerivation.length > 0 ? "Some transactions are confirmed on Ethereum and waiting for PCASH. Other Ethereum submissions are still unresolved."
        : result.waiting.some((entry) => entry.transactionHash === null) ? "Your Ethereum wallet has not returned a transaction for this submission."
        : "Still pending on Ethereum.");
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return <section id="ethereum-submission" className={styles.lockView} aria-label="Ethereum submission">
    {submissionLock === undefined ? message === undefined && <p>No Ethereum submission is blocking your wallet.</p> : <>
      <p>{hash === null ? "Your Ethereum wallet has not returned a transaction for this submission." : "This submission is awaiting Ethereum confirmation or PCASH processing."} New Ethereum submissions wait until it is resolved.</p>
      {hash && <p>{l1Chain.blockExplorers
        ? <a href={`${l1Chain.blockExplorers.default.url}/tx/${hash}`} target="_blank" rel="noreferrer">View on {l1Chain.blockExplorers.default.name}<ExternalLinkIcon /></a>
        : hash}</p>}
      <button type="button" className="button" disabled={busy} onClick={() => void refresh()}>{busy ? "Checking…" : "Refresh"}</button>
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
