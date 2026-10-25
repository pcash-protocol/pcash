import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { RelayJournalEntry } from "@pcash/sdk/relay";
import { Notice } from "../../components/Notice.tsx";
import { errorMessage, useWallet } from "../../lib/WalletProvider.tsx";
import styles from "./Tokens.module.css";

/** A failed token action as a page shows it. */
export interface TokenFailure {
  message: string;
  /** Published from the connected Ethereum wallet, where an unresolved earlier submission blocks the next one. */
  fast?: boolean;
  /** It failed only because an earlier Ethereum submission is unresolved. */
  blocked?: boolean;
}

export function tokenFailure(cause: unknown, fast = false): TokenFailure {
  let blocked = false;
  for (let error: unknown = cause; error instanceof Error && !blocked; error = error.cause) {
    blocked = error.name === "RelayJournalConflictError";
  }
  return { message: errorMessage(cause), ...(fast ? { fast } : {}), ...(blocked ? { blocked } : {}) };
}

/**
 * The connected wallet's unresolved Ethereum submission, when there is one.
 * The browser relay journal holds one transaction in flight, so it blocks every
 * Fast action: one that was sent until PCASH derives it, one the wallet never
 * confirmed sending until it can no longer land. Check releases it. It is what
 * `failure` was, so it replaces that message.
 */
export function EthereumSubmissionLock({ failure, onCleared }: {
  failure?: TokenFailure | undefined;
  onCleared?: (() => void) | undefined;
}) {
  const { selfPublication, refreshSubmissionLock } = useWallet();
  const [lock, setLock] = useState<RelayJournalEntry | null>();
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    let current = true;
    void Promise.resolve(selfPublication?.l1Recovery?.()).then((recovery) => recovery?.show())
      .then((view) => { if (current) setLock(blocking(view?.entries ?? [])); })
      .catch(() => { if (current) setLock(null); });
    return () => { current = false; };
  }, [selfPublication]);
  if (lock === undefined) return null;
  if (lock === null) {
    return message !== undefined ? <p className={styles.muted} role="status">{message}</p>
      : failure === undefined ? null
      : failure.blocked ? <Notice>An earlier Ethereum submission from this wallet was unresolved. It is settled now; try again.</Notice>
      : <Notice tone="error">{failure.message}</Notice>;
  }
  const check = () => {
    setChecking(true);
    setMessage(undefined);
    void refreshSubmissionLock().then((result) => {
      const waiting = blocking(result.waiting);
      if (waiting !== null) {
        setLock(waiting);
        setMessage("Still unresolved on Ethereum. Check again in a minute.");
      } else {
        setLock(null);
        setMessage("Cleared. You can continue.");
        onCleared?.();
      }
    }).catch((cause) => setMessage(errorMessage(cause))).finally(() => setChecking(false));
  };
  return <div className={styles.status} data-testid="ethereum-submission-lock">
    <Notice>{lock.transactionHash === null
      ? "Your Ethereum wallet did not confirm whether it sent your last transaction. Nothing more is sent from this wallet until that is settled. Check it: if it was never sent, you can continue."
      : "Your last Ethereum transaction was sent and is still landing. Nothing more is sent from this wallet until PCASH includes it. Check again in a minute."}</Notice>
    {message !== undefined && <p className={styles.muted} role="status">{message}</p>}
    <div className={styles.actions}>
      <button type="button" className="button" disabled={checking} onClick={check}>{checking ? "Checking…" : "Check Ethereum submission"}</button>
      <Link to="#ethereum-submission">Review Ethereum submission</Link>
    </div>
  </div>;
}

/** A failed action; a Fast one blocked by an unresolved Ethereum submission gets plain words and the check. */
export function TokenFailureNotice({ failure, onCleared }: { failure: TokenFailure; onCleared?: (() => void) | undefined }) {
  return failure.fast === true ? <EthereumSubmissionLock failure={failure} onCleared={onCleared} /> : <Notice tone="error">{failure.message}</Notice>;
}

/** The entry to explain: one never confirmed sent comes first, since it may never land. */
function blocking(entries: readonly RelayJournalEntry[]): RelayJournalEntry | null {
  return entries.find((entry) => entry.transactionHash === null) ?? entries[0] ?? null;
}
