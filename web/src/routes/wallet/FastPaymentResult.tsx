import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getPublicClient } from "wagmi/actions";
import { TransactionReceiptNotFoundError, type Hash } from "viem";
import { pollReceipt, type ReceiptResult } from "@pcash/sdk/clients";
import { useEthereumNetwork } from "../../lib/EthereumProvider.tsx";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { describeFailure, etherscanTransactionUrl } from "../explorer/format.ts";
import { transactionPath } from "../explorer/paths.ts";
import { CopyButton } from "../../components/CopyButton.tsx";
import { ExternalLinkIcon } from "../../components/icons.tsx";
import styles from "./OwnerPanels.module.css";

export interface PaymentConfirmation {
  l1State: "pending" | "included";
  receipt: ReceiptResult | null;
  /** The last status read failed; checks continue. */
  unavailable: boolean;
  /** The carrier is included and PCASH has decided the payment. */
  finished: boolean;
}

/**
 * Tracks a broadcast payment until Ethereum and PCASH have both decided it,
 * even when the send action's own receipt wait times out.
 */
export function usePaymentConfirmation(hash: string | undefined, contentHash: string | undefined): PaymentConfirmation {
  const { ethereumConfig, l1ChainId } = useEthereumNetwork();
  const { node } = useWallet();
  // Keyed by hash so a new payment never shows the previous one's state.
  const [observed, setObserved] = useState<{ hash: string; l1State: PaymentConfirmation["l1State"]; receipt: ReceiptResult | null; unavailable: boolean }>();
  useEffect(() => {
    if (hash === undefined) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const client = getPublicClient(ethereumConfig, { chainId: l1ChainId });
    const check = async () => {
      const [ethereum, pcash] = await Promise.allSettled([
        (async () => {
          if (client === undefined) throw new Error("Ethereum client is unavailable");
          try { return await client.getTransactionReceipt({ hash: hash as Hash }); }
          catch (cause) {
            if (cause instanceof TransactionReceiptNotFoundError) return null;
            throw cause;
          }
        })(),
        contentHash === undefined ? Promise.resolve(null) : pollReceipt(node, contentHash),
      ]);
      if (stopped) return;
      setObserved((previous) => {
        const current = previous?.hash === hash ? previous : { hash, l1State: "pending" as const, receipt: null, unavailable: false };
        return {
          hash,
          l1State: ethereum.status === "fulfilled" ? ethereum.value === null ? "pending" : "included" : current.l1State,
          receipt: pcash.status === "fulfilled" ? pcash.value : current.receipt,
          unavailable: ethereum.status === "rejected" || pcash.status === "rejected",
        };
      });
      const finished = ethereum.status === "fulfilled" && ethereum.value !== null
        && pcash.status === "fulfilled" && pcash.value !== null;
      if (!finished) timer = setTimeout(() => { void check(); }, 3_000);
    };
    void check();
    return () => { stopped = true; clearTimeout(timer); };
  }, [ethereumConfig, hash, l1ChainId, node, contentHash]);
  const { l1State, receipt, unavailable } = observed !== undefined && observed.hash === hash ? observed
    : { l1State: "pending" as const, receipt: null, unavailable: false };
  return { l1State, receipt, unavailable, finished: l1State === "included" && receipt !== null };
}

/** A broadcast payment's progress through Ethereum and PCASH. */
export function FastPaymentResult({ hash, confirmation, onDone, onSendAnother }: {
  hash: string;
  confirmation: PaymentConfirmation;
  onDone: (() => void) | undefined;
  onSendAnother: () => void;
}) {
  const { l1ChainId } = useEthereumNetwork();
  const { busy } = useWallet();
  const { l1State, receipt, unavailable, finished } = confirmation;
  const href = etherscanTransactionUrl(l1ChainId, hash);
  const included = l1State === "included";
  const rejected = receipt !== null && receipt.outcome !== "succeeded";
  return <div className={styles.review} data-testid="fast-payment-status">
    <p role="status" className={included ? styles.confirmed : undefined}>
      {l1State === "pending" ? <><span className="spinner" aria-hidden="true" />Posted to Ethereum, waiting for inclusion…</>
        : <><span aria-hidden="true">✓ </span>Included on Ethereum.</>}
    </p>
    <p role="status" className={receipt?.outcome === "succeeded" ? styles.confirmed : undefined}>
      {receipt === null ? included ? <><span className="spinner" aria-hidden="true" />Waiting for PCASH to process your payment…</>
        : "Your payment has been broadcast. Confirmation is checked automatically."
        : receipt.outcome === "succeeded" ? <><span aria-hidden="true">✓ </span>Payment confirmed in PCASH.</>
          : `PCASH did not accept this payment. ${describeFailure(receipt.outcome)}`}
    </p>
    {unavailable && !finished && <p role="status">Status checks are temporarily unavailable. We’ll keep checking.</p>}
    <dl>
      <dt>Sent to</dt><dd>Ethereum (L1)</dd>
      <dt>Ethereum transaction</dt><dd className={styles.transactionHash}>{href === undefined ? <code>{hash}</code>
        : <a href={href} target="_blank" rel="noreferrer"><code>{hash}</code><ExternalLinkIcon /></a>} <CopyButton value={hash} label="Copy Ethereum transaction hash" className={styles.copyHash} /></dd>
      {receipt !== null && <><dt>PCASH transaction</dt><dd><Link to={transactionPath(receipt.transactionId)}>View payment in explorer →</Link></dd></>}
    </dl>
    <p><Link to="#ethereum-submission">Review transaction status</Link></p>
    {/* A rejected payment's form unlocks above with Try again. */}
    <div className="actions">
      {!rejected && <button className="button" disabled={busy || !finished} onClick={onSendAnother}>Send another</button>}
      {onDone !== undefined && <button className="button primary" onClick={onDone}>Done</button>}
    </div>
    {!finished && <p className={styles.formHint}>You can send another payment once this one is confirmed.</p>}
  </div>;
}
