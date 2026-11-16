import { EthereumAddress, FittedCode } from "../../components/EthereumAddress.tsx";
import { friendlyError } from "../../components/friendlyError.ts";
import { Children, Fragment, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { bytes32Hex } from "@pcash/sdk/utils";
import { addressPath } from "./paths.ts";
import { Notice } from "../../components/Notice.tsx";
import { CopyButton } from "../../components/CopyButton.tsx";
import { isFinalized, shortHex, type Tone } from "./format.ts";
import { useReadyExplorer } from "./ExplorerProvider.tsx";
import styles from "./ExplorerRoute.module.css";

/** Resource dependencies reset the read; refresh dependencies keep the displayed result. */
export function useRead<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
  options: { pollMs?: number; refreshDeps?: readonly unknown[] } = {},
): { value: T | undefined; error: string | undefined; reload(): void } {
  const [result, setResult] = useState<{ deps: readonly unknown[]; value?: T | undefined; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  const { pollMs, refreshDeps = [] } = options;
  const sameResource = (previous: readonly unknown[]) => previous.length === deps.length
    && previous.every((dependency, index) => Object.is(dependency, deps[index]));
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A hidden tab skips its polls and reads once when it is shown again.
    let waiting = false;
    const poll = () => {
      if (document.visibilityState === "hidden") waiting = true;
      else run();
    };
    const shown = () => {
      if (!waiting || document.visibilityState === "hidden") return;
      waiting = false;
      run();
    };
    const run = () => {
      load()
        .then((value) => {
          if (!cancelled) setResult({ deps, value });
        })
        .catch((cause) => {
          if (!cancelled) setResult((previous) => ({
            deps,
            ...(previous !== undefined && sameResource(previous.deps) ? { value: previous.value } : {}),
            error: friendlyError(cause),
          }));
        })
        .finally(() => {
          if (!cancelled && pollMs !== undefined) timer = setTimeout(poll, pollMs);
        });
    };
    if (pollMs !== undefined) document.addEventListener("visibilitychange", shown);
    run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", shown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, ...refreshDeps, attempt, pollMs]);
  const current = result !== undefined && sameResource(result.deps) ? result : undefined;
  return { value: current?.value, error: current?.error, reload: () => setAttempt((n) => n + 1) };
}

export function Loading({ children = "Loading…" }: { children?: ReactNode }) {
  return <div className={`panel ${styles.loading}`}>{children}</div>;
}

export function Failure({ children, onRetry }: { children: ReactNode; onRetry?: (() => void) | undefined }) {
  return <Notice tone="error">{children}{onRetry !== undefined && <> <button type="button" onClick={onRetry}>Retry</button></>}</Notice>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className={styles.emptyState}>{children}</p>;
}

/**
 * A hash with a copy affordance. Detail pages show these in full until the line
 * runs out, when the middle gives way; `mono` marks raw data such as public inputs.
 */
export function Hash({ value, short = false, mono = false }: { value: string | bigint; short?: boolean; mono?: boolean }) {
  const text = typeof value === "bigint" ? bytes32Hex(value) : value;
  return <span className={mono ? `${styles.hash} ${styles.mono}` : styles.hash} title={text}>
    {short ? <code>{shortHex(text)}</code> : <FittedCode text={text} />}
    <CopyButton value={text} label="Copy hash" />
  </span>;
}

/** An Ethereum address with name resolution and an address-copy affordance. */
export function AddressDisplay({ address, short = false, showAddress = false }: { address: string; short?: boolean; showAddress?: boolean }) {
  return <span className={styles.hash}><EthereumAddress address={address} short={short} showAddress={showAddress} /><CopyButton value={address} label="Copy address" /></span>;
}

export function Tag({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`${styles.tag} ${styles[tone]}`}>{children}</span>;
}

export function FinalityTag({ blockNumber, finalizedBlock }: { blockNumber: bigint; finalizedBlock?: bigint }) {
  const { status } = useReadyExplorer();
  const settled = isFinalized(blockNumber, finalizedBlock ?? status.finalizedBlock);
  return <Tag tone={settled ? "good" : "warn"}>{settled ? "Finalized" : "Unfinalized"}</Tag>;
}

export function Breadcrumb({ children }: { children: ReactNode }) {
  const trail = Children.toArray(children);
  return <div className={styles.breadcrumb}>
    {trail.map((item, index) => <Fragment key={index}>
      {index > 0 && <span aria-hidden="true"> / </span>}
      {item}
    </Fragment>)}
  </div>;
}

export function PageHeading({ eyebrow, title, description, action }: {
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return <div className={styles.pageHeading}>
    <div>
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {description !== undefined && <p>{description}</p>}
    </div>
    {action}
  </div>;
}

/** The card grid the detail pages lead with: three or four short fact panels. */
export function Cards({ children }: { children: ReactNode }) {
  return <div className={styles.cards}>{children}</div>;
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return <section className={styles.card}><h3>{title}</h3>{children}</section>;
}

export function Facts({ children }: { children: ReactNode }) {
  return <dl className={styles.facts}>{children}</dl>;
}

export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <div className={styles.fact}><dt>{label}</dt><dd>{children}</dd></div>;
}

export function TableScroll({ children }: { children: ReactNode }) {
  return <div className={styles.tableScroll}>{children}</div>;
}

/**
 * Keyset pagination over an opaque cursor. Page one is `undefined`; the stack
 * remembers where each page started so Newer can walk back.
 */
export function useCursorStack<C>() {
  const [stack, setStack] = useState<(C | undefined)[]>([undefined]);
  const cursor = stack[stack.length - 1];
  return {
    cursor,
    page: stack.length,
    hasPrevious: stack.length > 1,
    next(nextCursor: C) {
      setStack((current) => [...current, nextCursor]);
    },
    previous() {
      setStack((current) => current.length > 1 ? current.slice(0, -1) : current);
    },
    reset() {
      setStack([undefined]);
    },
  };
}

export function Pager({ hasPrevious, hasNext, onPrevious, onNext, children }: {
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious(): void;
  onNext(): void;
  children?: ReactNode;
}) {
  return <div className={styles.pagination}>
    <span className="muted">{children}</span>
    <button type="button" disabled={!hasPrevious} onClick={onPrevious}>Newer</button>
    <button type="button" disabled={!hasNext} onClick={onNext}>Older</button>
  </div>;
}

export function TransactionLink({ transactionId }: { transactionId: string }) {
  return <Link className={styles.figures} to={`/tx/${transactionId}`} title={transactionId}>{shortHex(transactionId)}</Link>;
}

export function AddressLink({ address, label }: { address: string; label?: string }) {
  return <Link className={styles.figures} to={addressPath(address)}>{label ?? <EthereumAddress address={address} short />}</Link>;
}

export function BatchLink({ l1TransactionHash }: { l1TransactionHash: string }) {
  return <Link className={styles.figures} to={`/batch/${l1TransactionHash}`} title={l1TransactionHash}>{shortHex(l1TransactionHash)}</Link>;
}

export function BlockLink({ number }: { number: bigint }) {
  return <Link className={styles.figures} to={`/block/${number}`}>{number.toString()}</Link>;
}
