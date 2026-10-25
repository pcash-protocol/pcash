import { useCallback, useEffect, useState } from "react";
import type { LinkSetStatus } from "@pcash/tokens/app";
import { Notice } from "../../components/Notice.tsx";
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

export const CLAIM_PAGE_PATH = "/claim";
const MAX_LINKS = 100;

/** Link amounts from "count × amount" or a list of amounts separated by commas, spaces or lines. */
export function linkAmounts(input: { shape: "same" | "list"; count: string; amount: string; list: string }, decimals: number): bigint[] {
  if (input.shape === "same") {
    const count = Number(input.count);
    if (!/^\d+$/.test(input.count.trim()) || count < 1 || count > MAX_LINKS) throw new Error(`Number of links must be a whole number from 1 to ${MAX_LINKS}.`);
    const amount = parseTokenAmount(input.amount, decimals, { label: "Amount per link" });
    return Array.from({ length: count }, () => amount);
  }
  // Grouping commas are not accepted here: a comma separates amounts.
  const parts = input.list.split(/[\s,;]+/).filter((part) => part !== "");
  if (parts.length === 0 || parts.length > MAX_LINKS) throw new Error(`Enter from 1 to ${MAX_LINKS} amounts.`);
  return parts.map((part, index) => parseTokenAmount(part, decimals, { label: `Amount ${index + 1}` }));
}

/** Claim URLs with the warning that goes with them: each link is a bearer secret. */
function LinkList({ urls, claims, unit }: { urls: string[]; claims: LinkSetStatus["claims"]; unit: AmountUnit }) {
  return <div className={styles.form}>
    <Notice>Each link holds its tokens: anyone who opens it can claim them. Send each link privately, only to the person it is for.</Notice>
    <ol className={styles.linkList}>{urls.map((url, index) => {
      const claim = claims?.[index];
      const linkNumber = (claim?.index ?? index) + 1;
      return <li key={url}>
        <span className={styles.linkMeta}>Link {linkNumber}{claim !== undefined && <> · <TokenAmount value={claim.amount} unit={unit} /> · <span className={`${styles.chip} ${claim.state === "claimed" ? styles.chipDone : ""}`}>{claim.state === "claimed" ? "Claimed" : "Unclaimed"}</span></>}</span>
        <div className={styles.share}><input readOnly value={url} aria-label={`Claim link ${linkNumber}`} onFocus={(event) => event.currentTarget.select()} /><CopyButton className="button" value={url} label={`Copy claim link ${linkNumber}`} /></div>
      </li>;
    })}</ol>
    {urls.length > 1 && <div><CopyButton className="button" value={urls.join("\n")} label="Copy all links" showLabel /></div>}
  </div>;
}

export function TokenClaimLinks({ assetId, unit, spendable }: { assetId: bigint; unit: AmountUnit; spendable: bigint }) {
  const wallet = useWallet();
  const tokens = useTokensApp();
  const [shape, setShape] = useState<"same" | "list">("same");
  const [count, setCount] = useState("1");
  const [amount, setAmount] = useState("");
  const [list, setList] = useState("");
  const [draft, setDraft] = usePublicationDraft(false);
  const [running, setRunning] = useState<string>();
  const [error, setError] = useState<TokenFailure>();
  const [sets, setSets] = useState<LinkSetStatus[]>();
  const [shown, setShown] = useState<{ key: string; urls: string[] }>();
  const claimPageUrl = `${window.location.origin}${CLAIM_PAGE_PATH}`;

  const refresh = useCallback(async () => {
    const app = await tokens.app();
    const views = (await app.linkSets()).filter((view) => view.assetId === assetId);
    setSets(await Promise.all(views.map((view) => app.linkSetStatus(view.key))));
  }, [assetId, tokens.app]);
  useEffect(() => { void refresh().catch((cause) => setError(tokenFailure(cause))); }, [refresh]);

  /** One long creator action: publish, fund and claiming unclaimed links all report progress and end with a fresh status. */
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
  const route = (claiming = false) => {
    const publication = (claiming ? templatePublication : contractPublication)(draft, wallet.funds?.spendablePrivate);
    if ("problem" in publication) throw new Error(publication.problem);
    return publication;
  };
  const showLinks = async (key: string) => {
    const app = await tokens.app();
    setShown({ key, urls: await app.linkSetUrls(key, claimPageUrl) });
  };

  const create = () => {
    let amounts: bigint[];
    let publication: ReturnType<typeof route>;
    try {
      amounts = linkAmounts({ shape, count, amount, list }, unit.decimals);
      const total = amounts.reduce((sum, value) => sum + value, 0n);
      if (total > spendable) throw new Error(`The links total ${formatTokenAmount(total, unit, { rounding: "up" })}, more than the ${formatTokenAmount(spendable, unit, { rounding: "down" })} you have available.`);
      publication = route();
    } catch (cause) {
      setError(tokenFailure(cause));
      return;
    }
    void perform("new", publication.mode === "fast", async () => {
      const app = await tokens.app(publication.mode);
      const view = await app.createLinkSet({ assetId, amounts, onProgress: tokens.onProgress,
        ...(publication.openFeeAmount === undefined ? {} : { openFeeAmount: publication.openFeeAmount }) });
      setShown({ key: view.key, urls: await app.linkSetUrls(view.key, claimPageUrl) });
    });
  };
  const resume = (key: string) => {
    let publication: ReturnType<typeof route>;
    try { publication = route(); } catch (cause) { setError(tokenFailure(cause)); return; }
    void perform(key, publication.mode === "fast", async () => {
      const app = await tokens.app(publication.mode);
      const view = await app.resumeLinkSet(key, tokens.onProgress);
      setShown({ key: view.key, urls: await app.linkSetUrls(view.key, claimPageUrl) });
    });
  };
  const claimUnclaimed = (key: string) => {
    let publication: ReturnType<typeof route>;
    try { publication = route(true); } catch (cause) { setError(tokenFailure(cause)); return; }
    void perform(key, publication.mode === "fast", async () => {
      const app = await tokens.app(publication.mode);
      // One transaction claims at most four links; repeat until none are left.
      for (let remaining = 1; remaining > 0;) {
        ({ remaining } = await app.claimUnclaimedLinks(key, { onProgress: tokens.onProgress,
          ...(publication.openFeeAmount === undefined ? {} : { openFeeAmount: publication.openFeeAmount }) }));
      }
    });
  };

  let total: bigint | undefined;
  try { total = linkAmounts({ shape, count, amount, list }, unit.decimals).reduce((sum, value) => sum + value, 0n); } catch { total = undefined; }
  return <div className={styles.form}>
    <p className={styles.hint}>Make links that each hold an amount of this token. Whoever has a link can claim its tokens into their own wallet, even with no PCASH. You have every link too, so you can claim any that are still unclaimed; once someone claims a link, its tokens are theirs.</p>
    <div className={styles.sources} role="radiogroup" aria-label="Link amounts">
      {([["same", "Same amount"], ["list", "List of amounts"]] as const).map(([value, label]) =>
        <label key={value}><input type="radio" name="link-shape" value={value} checked={shape === value} onChange={() => setShape(value)} />{label}</label>)}
    </div>
    {shape === "same" ? <div className={styles.fieldRow}>
      <label>Number of links<input value={count} onChange={(event) => setCount(event.target.value)} inputMode="numeric" /></label>
      <label>Amount per link ({unit.symbol})<input value={amount} onChange={(event) => setAmount(withLeadingZero(event.target.value))} inputMode="decimal" placeholder="0" /></label>
    </div> : <label>Amounts ({unit.symbol}), one per link<textarea value={list} onChange={(event) => setList(event.target.value)} rows={3} placeholder="10, 25, 5.5" /></label>}
    {total !== undefined && <p className={styles.hint} role="status">Total held by the links: <TokenAmount value={total} unit={unit} /></p>}
    <TokenPublicationFields draft={draft} onChange={setDraft} disabled={running !== undefined} contract="creator" />
    <p className={styles.hint}>Creating publishes a small contract, then funds it with one note per link. Your wallet approves each transaction.</p>
    {error !== undefined && <TokenFailureNotice failure={error} onCleared={() => setError(undefined)} />}
    {running === "new" ? <TokensActionProgress progress={tokens.progress} />
      : <div className={styles.actions}><button type="button" className="button primary" disabled={wallet.busy || running !== undefined || total === undefined} onClick={create}>Create claim links</button></div>}
    {shown !== undefined && <section aria-label="New claim links">
      <h3 className={styles.subheading}>Your links are ready</h3>
      <LinkList urls={shown.urls} claims={sets?.find((set) => set.key === shown.key)?.claims ?? null} unit={unit} />
    </section>}
    <section aria-label="Your claim links">
      <div className={styles.panelHeading}><h3 className={styles.subheading}>Your claim links</h3>
        <button type="button" className={styles.linkButton} disabled={running !== undefined} onClick={() => void refresh().catch((cause) => setError(tokenFailure(cause)))}>Refresh</button></div>
      {sets === undefined ? <p className={styles.hint}>Loading…</p> : sets.length === 0 ? <p className={styles.hint}>No claim links for this token yet.</p>
        : sets.map((set) => {
          const claimed = set.claims?.filter((claim) => claim.state === "claimed").length ?? 0;
          const setTotal = set.links.reduce((sum, link) => sum + link.amount, 0n);
          return <div key={set.key} className={styles.job} data-link-set={set.key}>
            <div className={styles.jobHead}>
              <strong>{set.links.length} {set.links.length === 1 ? "link" : "links"} · <TokenAmount value={setTotal} unit={unit} /></strong>
              <span className={`${styles.chip} ${set.phase === "ready" ? styles.chipDone : styles.chipWarn}`}>
                {set.phase === "ready" ? `${claimed} of ${set.links.length} claimed` : set.phase === "funding" ? "Funding" : "Creating"}</span>
            </div>
            <p className={styles.hint}>Created {new Date(set.createdAt).toLocaleString()}</p>
            {running === set.key && <TokensActionProgress progress={tokens.progress} />}
            <div className={styles.actions}>
              {set.phase !== "ready" && <button type="button" className="button primary" disabled={wallet.busy || running !== undefined} onClick={() => resume(set.key)}>Continue creating</button>}
              {set.phase === "ready" && shown?.key !== set.key && <button type="button" className="button" disabled={running !== undefined} onClick={() => void showLinks(set.key).catch((cause) => setError(tokenFailure(cause)))}>Show links</button>}
              {set.phase === "ready" && claimed < set.links.length && <button type="button" className="button" disabled={wallet.busy || running !== undefined} onClick={() => claimUnclaimed(set.key)}>Claim unclaimed yourself ({set.links.length - claimed})</button>}
            </div>
          </div>;
        })}
    </section>
  </div>;
}
