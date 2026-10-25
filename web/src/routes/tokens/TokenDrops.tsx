import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { DropStatus } from "@pcash/tokens/app";
import { TokenAmount } from "../../components/TokenAmount.tsx";
import { formatTokenAmount, parseTokenAmount, type AmountUnit } from "../../components/tokenAmount.ts";
import { withLeadingZero } from "../../components/pcashAmount.ts";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { contractPublication, templatePublication, TokenPublicationFields, usePublicationDraft } from "./TokenPublicationFields.tsx";
import { tokenFailure, TokenFailureNotice, type TokenFailure } from "./EthereumSubmission.tsx";
import { TokensActionProgress } from "./TokenTransactionStatus.tsx";
import { CopyButton } from "../../components/CopyButton.tsx";
import { useTokensApp } from "./useTokensApp.ts";
import styles from "./Tokens.module.css";

const WEEK_SECONDS = 7n * 24n * 60n * 60n;

export function dropPath(contractAddress: string): string {
  return `/drop/${contractAddress.toLowerCase()}`;
}

/** A `datetime-local` value in this browser's time zone. */
export function localDateTime(seconds: bigint): string {
  const date = new Date(Number(seconds) * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function secondsFromLocal(value: string): bigint {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("Choose when claims end.");
  return BigInt(Math.floor(milliseconds / 1000));
}

export function formatTimestamp(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toLocaleString();
}

export interface DropTerms {
  claimAmount: bigint;
  count: number;
  cutoffBlockNumber: bigint;
  claimEndTimestamp: bigint;
}

export function dropTerms(fields: { amount: string; count: string; cutoff: string; end: string }, decimals: number, latestTimestamp: bigint): DropTerms {
  const claimAmount = parseTokenAmount(fields.amount, decimals, { label: "Amount per claim" });
  const count = Number(fields.count);
  if (!/^\d+$/.test(fields.count.trim()) || count < 1 || count > 1_000) throw new Error("Number of claims must be a whole number from 1 to 1,000.");
  if (!/^\d+$/.test(fields.cutoff.trim())) throw new Error("The account cutoff is a block number.");
  const claimEndTimestamp = secondsFromLocal(fields.end);
  if (claimEndTimestamp <= latestTimestamp) throw new Error("Claims must end after the latest block’s time.");
  return { claimAmount, count, cutoffBlockNumber: BigInt(fields.cutoff.trim()), claimEndTimestamp };
}

export function TokenDrops({ assetId, unit, spendable }: { assetId: bigint; unit: AmountUnit; spendable: bigint }) {
  const wallet = useWallet();
  const tokens = useTokensApp();
  const [amount, setAmount] = useState("");
  const [count, setCount] = useState("10");
  const [cutoff, setCutoff] = useState("");
  const [end, setEnd] = useState("");
  const [chain, setChain] = useState<{ block: bigint; timestamp: bigint }>();
  const [draft, setDraft] = usePublicationDraft(false);
  const [running, setRunning] = useState<string>();
  const [error, setError] = useState<TokenFailure>();
  const [drops, setDrops] = useState<DropStatus[]>();

  useEffect(() => {
    void wallet.readStatus().then((status) => {
      setChain({ block: status.latestBlock, timestamp: status.latestBlockTimestamp });
      setCutoff((current) => current === "" ? status.latestBlock.toString() : current);
      setEnd((current) => current === "" ? localDateTime(status.latestBlockTimestamp + WEEK_SECONDS) : current);
    }).catch((cause) => setError(tokenFailure(cause)));
  }, [wallet.readStatus]);

  const refresh = useCallback(async () => {
    const app = await tokens.app();
    const views = (await app.drops()).filter((view) => view.assetId === assetId);
    setDrops(await Promise.all(views.map((view) => app.dropStatus(view.key))));
  }, [assetId, tokens.app]);
  useEffect(() => { void refresh().catch((cause) => setError(tokenFailure(cause))); }, [refresh]);

  const perform = async (label: string, fast: boolean, action: () => Promise<void>) => {
    setRunning(label);
    setError(undefined);
    tokens.clearProgress();
    try {
      await wallet.runAction(action);
    } catch (cause) {
      setError(tokenFailure(cause, fast));
    } finally {
      setRunning(undefined);
      await refresh().catch(() => undefined);
    }
  };
  const route = (reclaiming = false) => {
    const publication = (reclaiming ? templatePublication : contractPublication)(draft, wallet.funds?.spendablePrivate);
    if ("problem" in publication) throw new Error(publication.problem);
    return publication;
  };
  const fee = (publication: ReturnType<typeof route>) => publication.openFeeAmount === undefined ? {} : { openFeeAmount: publication.openFeeAmount };

  const create = () => {
    let terms: DropTerms;
    let publication: ReturnType<typeof route>;
    try {
      terms = dropTerms({ amount, count, cutoff, end }, unit.decimals, chain?.timestamp ?? 0n);
      const total = terms.claimAmount * BigInt(terms.count);
      if (total > spendable) throw new Error(`The drop needs ${formatTokenAmount(total, unit, { rounding: "up" })}, more than the ${formatTokenAmount(spendable, unit, { rounding: "down" })} you have available.`);
      publication = route();
    } catch (cause) {
      setError(tokenFailure(cause));
      return;
    }
    void perform("new", publication.mode === "fast", async () => {
      const app = await tokens.app(publication.mode);
      await app.createDrop({ assetId, ...terms, ...fee(publication), onProgress: tokens.onProgress });
    });
  };
  const resume = (key: string) => {
    let publication: ReturnType<typeof route>;
    try { publication = route(); } catch (cause) { setError(tokenFailure(cause)); return; }
    void perform(key, publication.mode === "fast", async () => { await (await tokens.app(publication.mode)).resumeDrop(key, tokens.onProgress); });
  };
  const reclaim = (key: string) => {
    let publication: ReturnType<typeof route>;
    try { publication = route(true); } catch (cause) { setError(tokenFailure(cause)); return; }
    void perform(key, publication.mode === "fast", async () => {
      const app = await tokens.app(publication.mode);
      // One transaction returns at most four notes; repeat until none are left.
      for (let remaining = 1; remaining > 0;) ({ remaining } = await app.reclaimDrop(key, { ...fee(publication), onProgress: tokens.onProgress }));
    });
  };

  let total: bigint | undefined;
  try { total = parseTokenAmount(amount, unit.decimals) * BigInt(/^\d+$/.test(count) ? count : "0"); } catch { total = undefined; }
  return <div className={styles.form}>
    <p className={styles.hint}>A drop lets existing PCASH accounts claim a fixed amount each, once, until the claim window closes. It is listed publicly on this node, so anyone can find it. After it closes you can reclaim what is left.</p>
    <div className={styles.fieldRow}>
      <label>Amount per claim ({unit.symbol})<input value={amount} onChange={(event) => setAmount(withLeadingZero(event.target.value))} inputMode="decimal" placeholder="0" /></label>
      <label>Number of claims<input value={count} onChange={(event) => setCount(event.target.value)} inputMode="numeric" /></label>
    </div>
    <div className={styles.fieldRow}>
      <label>Accounts registered by block<input value={cutoff} onChange={(event) => setCutoff(event.target.value)} inputMode="numeric" /></label>
      <label>Claims end<input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
    </div>
    <p className={styles.hint}>Only accounts that existed at block {/^\d+$/.test(cutoff.trim()) ? cutoff.trim() : "N"} can claim; accounts created later cannot. {chain !== undefined && `The latest block is ${chain.block}, so the default admits accounts that exist now.`}</p>
    {total !== undefined && total > 0n && <p className={styles.hint} role="status">Total held by the drop: <TokenAmount value={total} unit={unit} /></p>}
    <TokenPublicationFields draft={draft} onChange={setDraft} disabled={running !== undefined} contract="creator" />
    <p className={styles.hint}>Creating publishes the drop’s contract, funds one note per claim, and lists it on this node. Your wallet approves each transaction.</p>
    {error !== undefined && <TokenFailureNotice failure={error} onCleared={() => setError(undefined)} />}
    {running === "new" ? <TokensActionProgress progress={tokens.progress} />
      : <div className={styles.actions}><button type="button" className="button primary" disabled={wallet.busy || running !== undefined || chain === undefined} onClick={create}>Create drop</button></div>}
    <section aria-label="Your drops">
      <div className={styles.panelHeading}><h3 className={styles.subheading}>Your drops</h3>
        <button type="button" className={styles.linkButton} disabled={running !== undefined} onClick={() => void refresh().catch((cause) => setError(tokenFailure(cause)))}>Refresh</button></div>
      {drops === undefined ? <p className={styles.hint}>Loading…</p> : drops.length === 0 ? <p className={styles.hint}>No drops for this token yet.</p>
        : drops.map((drop) => {
          const open = chain === undefined || chain.timestamp < drop.claimEndTimestamp;
          return <div key={drop.key} className={styles.job} data-drop={drop.contractAddress}>
            <div className={styles.jobHead}>
              <strong>{drop.count} claims of <TokenAmount value={drop.claimAmount} unit={unit} /></strong>
              <span className={`${styles.chip} ${drop.phase !== "ready" ? styles.chipWarn : open ? styles.chipDone : ""}`}>
                {drop.phase === "ready" ? `${drop.claimed ?? 0} of ${drop.count} claimed` : drop.phase === "publishing" ? "Publishing" : drop.phase === "funding" ? "Funding" : "Creating"}</span>
            </div>
            <p className={styles.hint}>Accounts registered by block {drop.cutoffBlockNumber.toString()} · {open ? "Claims end" : "Closed"} {formatTimestamp(drop.claimEndTimestamp)}{drop.phase === "ready" && <> · <Link to={dropPath(drop.contractAddress)}>Drop page</Link></>}</p>
            {drop.phase === "ready" && open && <>
              <div className={styles.share}><input readOnly value={`${window.location.origin}${dropPath(drop.contractAddress)}`} aria-label="Drop link" onFocus={(event) => event.currentTarget.select()} /><CopyButton className="button" value={`${window.location.origin}${dropPath(drop.contractAddress)}`} label="Copy drop link" /></div>
              <p className={styles.hint}>Share this link. Anyone whose account existed at block {drop.cutoffBlockNumber.toString()} can claim once. The drop is also listed on the Tokens page of this site.</p>
            </>}
            {running === drop.key && <TokensActionProgress progress={tokens.progress} />}
            <div className={styles.actions}>
              {drop.phase !== "ready" && <button type="button" className="button primary" disabled={wallet.busy || running !== undefined} onClick={() => resume(drop.key)}>Continue creating</button>}
              {(drop.phase === "ready" || drop.phase === "publishing") && (drop.remaining ?? 0) > 0 && (open
                ? <span className={styles.hint}>You can reclaim the {drop.remaining} unclaimed after claims end.</span>
                : <button type="button" className="button" disabled={wallet.busy || running !== undefined} onClick={() => reclaim(drop.key)}>Reclaim unclaimed ({drop.remaining})</button>)}
            </div>
          </div>;
        })}
    </section>
  </div>;
}
