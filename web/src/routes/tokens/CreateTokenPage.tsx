import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fungibleMetadataCommitment, type FungibleMetadata } from "@pcash/sdk/protocol";
import { Notice } from "../../components/Notice.tsx";
import { friendlyError } from "../../components/friendlyError.ts";
import { RouteHeader } from "../../components/RouteHeader.tsx";
import { formatTokenExact, parseTokenAmount } from "../../components/tokenAmount.ts";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { Metadata } from "../Metadata.tsx";
import { routeById } from "../routeManifest.ts";
import paper from "../PaperPage.module.css";
import { contentDigestHex, parseContentDigest, sha256, tokenPath, TOKENS_PATH, ZERO_CONTENT_DIGEST } from "./model.ts";
import { TokenWalletPrompt } from "./TokenCommon.tsx";
import { checkedPublication, TokenPublicationFields, usePublicationDraft } from "./TokenPublicationFields.tsx";
import { TokenProofProgress } from "./TokenTransactionStatus.tsx";
import { useTokenTransaction, type TokenPublicationChoice } from "./useTokenTransaction.ts";
import { useSubmitLock } from "./useSubmitLock.ts";
import type { CreationState } from "./TokenPage.tsx";
import { TokenFailureNotice } from "./EthereumSubmission.tsx";
import styles from "./Tokens.module.css";

const route = routeById("token-new");
const MAX_NOTE_AMOUNT = (1n << 128n) - 1n;

type ContentSource = "text" | "file" | "digest" | "none";

/** A content digest together with plain words for what produced it. */
interface ContentReference {
  digest: Uint8Array;
  description: string;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The typed fields as the definition will commit to them, or the first reason they cannot. */
export function tokenTerms(fields: { name: string; symbol: string; decimals: string; supply: string }, contentDigest: Uint8Array): { metadata: FungibleMetadata; initialSupply: bigint } {
  const name = fields.name.trim().normalize("NFC");
  if (name === "" || utf8Length(name) > 64) throw new Error("Name must be 1 to 64 bytes of text.");
  const symbol = fields.symbol.trim();
  if (!/^[\x20-\x7e]{1,12}$/.test(symbol)) throw new Error("Symbol must be 1 to 12 plain ASCII characters.");
  const decimals = Number(fields.decimals);
  if (!/^\d{1,2}$/.test(fields.decimals) || decimals > 18) throw new Error("Decimals must be a whole number from 0 to 18.");
  const initialSupply = parseTokenAmount(fields.supply, decimals, { label: "Total supply" });
  if (initialSupply > MAX_NOTE_AMOUNT) {
    throw new Error(`Total supply can be at most ${formatTokenExact(MAX_NOTE_AMOUNT, { decimals, symbol })}.`);
  }
  const metadata = { name, symbol, decimals, contentDigest };
  fungibleMetadataCommitment(metadata);
  return { metadata, initialSupply };
}

function useContentReference(source: ContentSource, text: string, digestText: string, file: File | undefined) {
  const [hashed, setHashed] = useState<{ key: string; reference: ContentReference }>();
  const [error, setError] = useState<string>();
  const key = source === "text" ? `text:${text}` : source === "file" && file !== undefined ? `file:${file.name}:${file.size}:${file.lastModified}` : undefined;
  useEffect(() => {
    setError(undefined);
    if (key === undefined) return;
    if (source === "text" && text === "") return;
    let current = true;
    void (async () => {
      const bytes = source === "text" ? new TextEncoder().encode(text) : new Uint8Array(await file!.arrayBuffer());
      const digest = await sha256(bytes);
      const description = source === "text"
        ? `SHA-256 of the text “${text.length > 60 ? `${text.slice(0, 57)}…` : text}” exactly as entered, as UTF-8 (${bytes.length.toLocaleString()} bytes)${/^https?:\/\//i.test(text.trim()) ? ". This is the text of the link, not the page it points to" : ""}.`
        : `SHA-256 of the file ${file!.name} (${bytes.length.toLocaleString()} bytes).`;
      if (current) setHashed({ key: key!, reference: { digest, description } });
    })().catch((cause) => { if (current) setError(`Could not hash the ${source === "file" ? "file" : "text"}: ${cause instanceof Error ? cause.message : String(cause)}`); });
    return () => { current = false; };
  }, [key]);
  if (source === "none") return { reference: { digest: ZERO_CONTENT_DIGEST, description: "No content. The digest is 32 zero bytes." } };
  if (source === "digest") {
    if (digestText.trim() === "") return {};
    try {
      return { reference: { digest: parseContentDigest(digestText), description: "The digest you pasted, used as given." } };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  if (error !== undefined) return { error };
  return hashed !== undefined && hashed.key === key ? { reference: hashed.reference } : {};
}

export default function CreateTokenPage() {
  const wallet = useWallet();
  const navigate = useNavigate();
  const tx = useTokenTransaction();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [decimals, setDecimals] = useState("18");
  const [supply, setSupply] = useState("");
  const [source, setSource] = useState<ContentSource>("text");
  const [contentText, setContentText] = useState("");
  const [digestText, setDigestText] = useState("");
  const [file, setFile] = useState<File>();
  const [draft, setDraft] = usePublicationDraft();
  const [formError, setFormError] = useState<string>();
  const content = useContentReference(source, contentText, digestText, file);
  const ready = wallet.phase === "ready";
  const submission = useSubmitLock();
  // The lock covers the read of existing tokens before the proof starts.
  const working = submission.locked || tx.stage.state === "working" || tx.stage.state === "submitting";

  const create = async (terms: { metadata: FungibleMetadata; initialSupply: bigint }, choice: TokenPublicationChoice) => {
    const opened = wallet.wallet;
    if (opened === undefined) return;
    const before = new Set((await opened.assets()).filter((asset) => asset.created).map((asset) => asset.assetId));
    const outcome = await tx.run(choice, (publication) => opened.createAsset({ ...terms, ...publication }),
      { kind: "token-created", amount: terms.initialSupply, unit: { symbol: terms.metadata.symbol, decimals: terms.metadata.decimals } });
    const creation = (contentHash: string, extra: Partial<CreationState> = {}): { creation: CreationState } =>
      ({ creation: { contentHash, mode: choice.mode, ...extra } });
    if (outcome.state === "sent") {
      navigate(tokenPath(outcome.result.assetId), { state: creation(outcome.result.contentHash, outcome.l1Hash === undefined ? {} : { l1Hash: outcome.l1Hash }) });
    } else if (outcome.state === "broadcast" || outcome.state === "unknown") {
      // The creation material was journaled with the transaction, so the new token is known by now.
      const created = (await opened.assets()).find((asset) => asset.created && !before.has(asset.assetId));
      if (created !== undefined) {
        navigate(tokenPath(created.assetId), { state: creation(outcome.contentHash, outcome.state === "broadcast" ? { l1Hash: outcome.l1Hash } : { unknown: true }) });
      }
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(undefined);
    tx.reset();
    try {
      if (content.reference === undefined) throw new Error(content.error ?? "Choose the content this token refers to, or choose None.");
      const terms = tokenTerms({ name, symbol, decimals, supply }, content.reference.digest);
      const publication = checkedPublication(draft, wallet.funds?.spendablePrivate);
      if ("problem" in publication) throw new Error(publication.problem);
      submission.hold(() => create(terms, publication.choice).catch((cause) => setFormError(friendlyError(cause))));
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return <section className={`${paper.page} ${styles.stack}`}>
    <Metadata {...route.metadata} />
    <RouteHeader eyebrow="New token" title="Create a token" description="Name it, fix its total supply, and it is yours. Every unit goes to your wallet, and no one can ever create more." />
    <p><Link to={TOKENS_PATH}>← Tokens</Link></p>
    <div className={styles.columns}>
      <section className="panel" aria-labelledby="create-heading">
        <div className={styles.panelHeading}><h2 id="create-heading">Token details</h2></div>
        <form className={styles.form} onSubmit={submit}>
          <fieldset className={styles.fields} disabled={working}>
            <div className={styles.fieldRow}>
              <label>Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Harbor Credit" autoComplete="off" required /></label>
              <label>Symbol<input value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="HARBOR" autoComplete="off" required /></label>
            </div>
            <div className={styles.fieldRow}>
              <label>Decimals<select value={decimals} onChange={(event) => setDecimals(event.target.value)}>
                {Array.from({ length: 19 }, (_, value) => <option key={value} value={String(value)}>{value}</option>)}
              </select></label>
              <label>Total supply<input value={supply} onChange={(event) => setSupply(event.target.value)} inputMode="decimal" placeholder="1,000,000" autoComplete="off" required /></label>
            </div>
            <p className={styles.hint}>Enter the total supply in tokens. Decimals only set how finely each token divides: with 2, the smallest amount is 0.01.</p>
            <fieldset className={styles.fieldset}>
              <legend className={styles.legend}>Content</legend>
              <div className={styles.sources} role="radiogroup" aria-label="Content source">
                {([["text", "Text or link"], ["file", "File"], ["digest", "Digest"], ["none", "None"]] as const).map(([value, label]) =>
                  <label key={value}><input type="radio" name="content-source" value={value} checked={source === value} onChange={() => setSource(value)} />{label}</label>)}
              </div>
              {source === "text" && <label>Text or link to hash<textarea value={contentText} onChange={(event) => setContentText(event.target.value)} placeholder="https://example.org/terms" rows={3} /></label>}
              {source === "file" && <label>File to hash<input type="file" onChange={(event) => setFile(event.target.files?.[0])} /></label>}
              {source === "digest" && <label>SHA-256 digest<input value={digestText} onChange={(event) => setDigestText(event.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} /></label>}
              {content.reference !== undefined && <div className={styles.digest} aria-live="polite"><code>{contentDigestHex(content.reference.digest)}</code><span>{content.reference.description}</span></div>}
              {content.error !== undefined && <p className={styles.fieldError}>{content.error}</p>}
              <p className={styles.hint}>The token commits to a 32-byte digest of its content, such as terms or a description. Anyone holding the content can check it against the token. Hashing happens in this browser; nothing is uploaded.</p>
            </fieldset>
            <TokenPublicationFields draft={draft} onChange={setDraft} />
          </fieldset>
          <p className={styles.fixed}><strong>The supply is fixed forever.</strong> All of it goes to your wallet when the token is created. There is no later minting: no one, including you, can ever create more. The name, symbol, decimals and content digest can never change.</p>
          <div className={styles.actions}><button className="button primary" type="submit" disabled={!ready || wallet.busy || working}>
            {working ? "Creating…" : tx.stage.state === "failed" ? "Try again" : "Create token"}</button></div>
          {formError !== undefined && <Notice tone="error">{formError}</Notice>}
          {tx.stage.state === "failed" && <TokenFailureNotice failure={tx.stage} />}
          <TokenProofProgress stage={tx.stage} label="Creating your token" />
        </form>
        <TokenWalletPrompt purpose="to create a token" />
      </section>
      <aside className="panel" aria-label="What a token is">
        <h2 className={styles.panelHeading}>What you are making</h2>
        <p className={styles.lede}>A private token on PCASH. Balances and transfers are private, like PCASH itself.</p>
        <dl className={styles.facts}>
          <dt>Token ID</dt><dd>Derived from everything you enter here. Sharing the token’s link lets anyone verify its name, symbol, decimals, content and supply against the ID.</dd>
          <dt>Supply</dt><dd>Fixed at creation, in one transaction, to you.</dd>
          <dt>Cost</dt><dd>Choose Faster to post it yourself for Ethereum gas, or More private to let a relayer post it. Relayers earn issuance for posting, so a zero relayer fee works and needs no PCASH.</dd>
        </dl>
      </aside>
    </div>
  </section>;
}
