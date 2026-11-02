import { useCallback, useEffect, useState } from "react";
import type { LinkSetStatus } from "@pcash/tokens/app";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { routeById } from "../routeManifest.ts";
import { tokenFailure, TokenFailureNotice, type TokenFailure } from "../tokens/EthereumSubmission.tsx";
import { checkedLinkPublication, TokenPublicationFields, usePublicationDraft } from "../tokens/TokenPublicationFields.tsx";
import { TokensActionProgress } from "../tokens/TokenTransactionStatus.tsx";
import { useTokensApp } from "../tokens/useTokensApp.ts";
import styles from "../tokens/Tokens.module.css";

const linkSendListeners = new Set<() => void>();

/** Refresh any mounted Activity link-send feed after a local link action. */
export function notifyLinkSendsChanged(): void {
  for (const listener of linkSendListeners) listener();
}

/** The claim page a link opens on. */
export function claimPageUrl(): string {
  return `${globalThis.location?.origin ?? ""}${routeById("claim").path}`;
}

/** This wallet's PCASH link sets with each link's state, read again on every sync and after `reload`. */
export function useLinkSends(): { sends: readonly LinkSetStatus[]; reload(): void } {
  const { wallet, snapshot } = useWallet();
  const { app } = useTokensApp();
  const head = snapshot?.syncedThrough?.pcashHash;
  const pending = (snapshot?.pendingContentHashes ?? []).join(",");
  const [reads, setReads] = useState(0);
  const [sends, setSends] = useState<readonly LinkSetStatus[]>([]);
  const reload = useCallback(() => setReads((count) => count + 1), []);
  useEffect(() => {
    linkSendListeners.add(reload);
    return () => { linkSendListeners.delete(reload); };
  }, [reload]);
  useEffect(() => {
    if (wallet === undefined) { setSends([]); return; }
    let current = true;
    void (async () => {
      const tokens = await app();
      const views = (await tokens.linkSets()).filter((view) => view.assetId === 0n);
      // A set whose status cannot be read shows without its links; the others keep theirs.
      const statuses = await Promise.all(views.map((view) => tokens.linkSetStatus(view.key).catch((): LinkSetStatus => ({ ...view, claims: null }))));
      if (current) setSends(statuses);
    })()
      // Activity shows the rest; the links come back on the next read.
      .catch(() => undefined);
    return () => { current = false; };
  }, [app, wallet, head, pending, reads]);
  return { sends, reload };
}

/** Every link of a set, one per line, as the claim URLs that open them. */
export async function linkSendUrls(tokens: ReturnType<typeof useTokensApp>, key: string): Promise<string> {
  return (await (await tokens.app()).linkSetUrls(key, claimPageUrl())).join("\n");
}

/** Continue an interrupted PCASH link set from Activity. */
export function LinkContinue({ linkKey, onDone }: { linkKey: string; onDone(): void }) {
  const wallet = useWallet();
  const tokens = useTokensApp();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<TokenFailure>();
  const fast = wallet.selfPublication !== undefined;
  const resume = () => {
    setRunning(true);
    setError(undefined);
    tokens.clearProgress();
    void wallet.runAction(async () => {
      const app = await tokens.app(fast ? "fast" : "slow");
      await app.resumeLinkSet(linkKey, tokens.onProgress);
    }).then(onDone, (cause: unknown) => { setError(tokenFailure(cause, fast)); onDone(); })
      .finally(() => setRunning(false));
  };
  return <>
    <button type="button" className="button" disabled={wallet.busy || running} onClick={resume}>{running ? "Continuing…" : "Continue"}</button>
    {running && <TokensActionProgress progress={tokens.progress} />}
    {error !== undefined && <TokenFailureNotice failure={error} onCleared={() => setError(undefined)} />}
  </>;
}

/**
 * Take a set's unclaimed links back into this wallet. It claims them like
 * anyone holding the links would, so the fee comes out of the links, and a
 * claim that lands first keeps its link.
 */
export function LinkTakeBack({ linkKey, unclaimed, onDone }: { linkKey: string; unclaimed: bigint; onDone(): void }) {
  const wallet = useWallet();
  const tokens = useTokensApp();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = usePublicationDraft(true, 1, unclaimed);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<TokenFailure>();
  if (!open) return <button type="button" className="button" disabled={wallet.busy} onClick={() => setOpen(true)}>Take back</button>;
  const takeBack = () => {
    const checked = checkedLinkPublication(draft, unclaimed);
    if ("problem" in checked) { setError(tokenFailure(new Error(checked.problem))); return; }
    const { mode, openFeeAmount } = checked.choice;
    setRunning(true);
    setError(undefined);
    tokens.clearProgress();
    void wallet.runAction(async () => {
      const app = await tokens.app(mode);
      // One transaction takes back at most four links; repeat until none are left.
      for (let remaining = 1; remaining > 0;) {
        ({ remaining } = await app.claimUnclaimedLinks(linkKey, { onProgress: tokens.onProgress, ...(mode === "slow" ? { openFeeAmount } : {}) }));
      }
    }).then(() => { setOpen(false); onDone(); }, (cause: unknown) => { setError(tokenFailure(cause, mode === "fast")); onDone(); })
      .finally(() => setRunning(false));
  };
  return <div className={styles.form} data-testid="link-take-back">
    <p className={styles.hint}>Takes the unclaimed PCASH back into your wallet, and the link stops working. If someone claims it first, it stays theirs.</p>
    <TokenPublicationFields draft={draft} onChange={setDraft} disabled={running} linkValue={unclaimed} />
    {error !== undefined && <TokenFailureNotice failure={error} onCleared={() => setError(undefined)} />}
    {running ? <TokensActionProgress progress={tokens.progress} />
      : <div className={styles.actions}>
        <button type="button" className="button" onClick={() => { setOpen(false); setError(undefined); }}>Cancel</button>
        <button type="button" className="button primary" disabled={wallet.busy} onClick={takeBack}>Take back</button>
      </div>}
  </div>;
}
