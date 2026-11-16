import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ProveStatus } from "@pcash/sdk/browser-prover/requests";
import styles from "./TransactionDetails.module.css";

/** The same visible proof and submission details for private payments and marketplace trades. */
export function TransactionDetails({ proof, message, contentHash, children }: {
  proof?: ProveStatus | undefined;
  message?: string | undefined;
  contentHash?: string | undefined;
  children?: ReactNode;
}) {
  if (!proof && !message && !contentHash && !children) return null;
  return <section className={styles.details} aria-label="Transaction details">
    <h3>Transaction details</h3>
    {message && message !== proof?.message && <p>{message}</p>}
    {proof && <dl>
      <dt>Proof</dt><dd>{proof.message}</dd>
      {proof.durationMs !== undefined && <><dt>Duration</dt><dd>{(proof.durationMs / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} seconds</dd></>}
    </dl>}
    {contentHash && <Link to={`/tx/${contentHash}`}>View PCASH transaction</Link>}
    {children}
  </section>;
}
