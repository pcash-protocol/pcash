import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import type { AssetDefinition } from "@pcash/sdk/protocol";
import { Notice } from "../../components/Notice.tsx";
import { CopyButton } from "../../components/CopyButton.tsx";
import { RouteHeader } from "../../components/RouteHeader.tsx";
import { TokenAmount } from "../../components/TokenAmount.tsx";
import { useWallet } from "../../lib/WalletProvider.tsx";
import type { SubmissionMode } from "../../lib/WebsiteSettings.tsx";
import { Metadata } from "../Metadata.tsx";
import paper from "../PaperPage.module.css";
import {
  assetIdHex,
  checkDefinition,
  definitionFromHash,
  isZeroDigest,
  parseAssetIdSegment,
  sameDigest,
  sha256,
  shortAssetId,
  tokenShareLink,
  tokenUnit,
  TOKENS_PATH,
  UNVERIFIED_UNIT,
} from "./model.ts";
import { TokenBurn, TokenSend } from "./TokenActions.tsx";
import { TokenClaimLinks } from "./TokenClaimLinks.tsx";
import { TokenDistribute } from "./TokenDistribute.tsx";
import { TokenDrops } from "./TokenDrops.tsx";
import { TokenWalletPrompt, useImportDefinition, VerifiedDefinition } from "./TokenCommon.tsx";
import { checkedPublication, TokenPublicationFields, usePublicationDraft } from "./TokenPublicationFields.tsx";
import { SentTransaction, TokenProofProgress, UnknownTransaction } from "./TokenTransactionStatus.tsx";
import { usePageFragment } from "./usePageFragment.ts";
import { useTokenTransaction, type TokenPublication } from "./useTokenTransaction.ts";
import { TokenFailureNotice } from "./EthereumSubmission.tsx";
import styles from "./Tokens.module.css";

/** Carried in history state from the create page, so a reload keeps following the creation. */
export interface CreationState {
  contentHash: string;
  mode: SubmissionMode;
  l1Hash?: string;
  /** The exact bytes are journaled but the submission's answer never arrived. */
  unknown?: boolean;
}

/** The route checks the token ID before this chunk loads. */
export default function TokenPage() {
  const { assetId: segment = "" } = useParams();
  const assetId = parseAssetIdSegment(segment)!;
  return <TokenView key={assetId.toString()} assetId={assetId} />;
}

function TokenView({ assetId }: { assetId: bigint }) {
  const location = useLocation();
  const wallet = useWallet();
  const held = wallet.snapshot?.assets.find((asset) => asset.assetId === assetId);
  const fragment = usePageFragment();
  const shared = fragment === undefined ? undefined : definitionFromHash(fragment);
  const linkCheck = shared === undefined ? undefined : checkDefinition(shared, assetId);
  const definition = held?.definition ?? (linkCheck?.state === "verified" ? linkCheck.definition : null);
  const creation = (location.state as { creation?: CreationState } | null)?.creation;
  const unit = definition === null ? UNVERIFIED_UNIT : tokenUnit(definition);
  const title = definition?.metadata.name ?? "Unverified token";
  // Actions stay open after a transfer or burn empties the balance, so its result stays visible.
  const [holding, setHolding] = useState(() => (held?.private ?? 0n) > 0n);
  useEffect(() => { if ((held?.private ?? 0n) > 0n) setHolding(true); }, [held?.private]);
  return <section className={`${paper.page} ${styles.stack}`}>
    <Metadata title={title} description={definition === null ? `PCASH token ${assetIdHex(assetId)}.` : `${definition.metadata.name} (${definition.metadata.symbol}), a private token on PCASH.`} />
    <RouteHeader eyebrow={definition === null ? "Token" : `Token · ${definition.metadata.symbol}`} title={title}
      description={definition === null
        ? "This page knows only the token ID. Add the token’s definition to see its name, symbol and decimals."
        : "A private token with a fixed supply. Balances and transfers are private."} />
    <p><Link to={TOKENS_PATH}>← Tokens</Link></p>
    {linkCheck?.state === "mismatch" && <Notice tone="error">The definition in this link does not match this token ID. It describes a different token, so nothing it claims is shown here. Ask the sender for the link again.</Notice>}
    {linkCheck?.state === "invalid" && <Notice>This link’s token definition could not be read. Only the token ID below is known.</Notice>}
    <div className={styles.columns}>
      <section className="panel" aria-labelledby="definition-heading">
        <div className={styles.panelHeading}><h2 id="definition-heading">Definition</h2>
          {definition === null && <span className={`${styles.seal} ${styles.sealWarning}`}>Unverified token</span>}</div>
        {definition === null ? <UnknownDefinition assetId={assetId} /> : <>
          <VerifiedDefinition definition={definition} assetId={assetId} />
          {held?.definition == null && <ImportFromLink definition={definition} assetId={assetId} />}
          <div className={styles.outside}>
            <h3>Not part of the definition</h3>
            <dl className={styles.facts}>
              <dt>Current outstanding supply</dt><dd>Private — burns and holdings are not publicly enumerable.</dd>
              {held?.created === true && <><dt>Creator</dt><dd>You created this token.</dd></>}
            </dl>
            {!isZeroDigest(definition.metadata.contentDigest) && <ContentCheck digest={definition.metadata.contentDigest} />}
          </div>
        </>}
      </section>
      <div className={styles.stack}>
        {creation !== undefined && definition !== null && (held?.private ?? 0n) === 0n
          && <CreationStatus creation={creation} assetId={assetId} definition={definition} />}
        <section className="panel" aria-labelledby="balance-heading">
          <div className={styles.panelHeading}><h2 id="balance-heading">Your balance</h2></div>
          {wallet.phase === "ready" && <div className={styles.balanceLine}>
            <output aria-label="Token balance" data-testid="token-balance"><TokenAmount value={held?.private ?? 0n} unit={unit} rounding="down" /></output>
            {held !== undefined && held.spendable !== held.private && <span className={styles.muted}><TokenAmount value={held.spendable} unit={unit} rounding="down" /> available now</span>}
          </div>}
          <TokenWalletPrompt purpose="to hold and send this token" />
          {wallet.phase === "ready" && (held?.private ?? 0n) === 0n && <p className={styles.muted}>You hold none of this token.</p>}
          {wallet.phase === "ready" && holding && <TokenActionTabs assetId={assetId} unit={unit} spendable={held?.spendable ?? 0n} verified={held?.definition != null} />}
        </section>
        {definition !== null && <ShareToken definition={definition} />}
      </div>
    </div>
  </section>;
}

const ACTION_TABS = [["send", "Send"], ["drop", "Drop"]] as const;
type ActionTab = (typeof ACTION_TABS)[number][0];
const SEND_MODES = [["one", "One recipient"], ["many", "Many recipients"], ["links", "Claim links"], ["burn", "Burn"]] as const;
type SendMode = (typeof SEND_MODES)[number][0];

interface TokenActionProps { assetId: bigint; unit: { decimals: number; symbol: string }; spendable: bigint }

function TokenActionTabs({ verified, ...props }: TokenActionProps & { verified: boolean }) {
  const [tab, setTab] = useState<ActionTab>("send");
  // Claim links and drops deliver the definition with every claim, so they need one. The send
  // form stays in one place either way, so adding the definition keeps an action in progress.
  return <div>
    {verified && <div className={styles.tabs} role="tablist" aria-label="Token actions">
      {ACTION_TABS.map(([value, label]) =>
        <button key={value} type="button" role="tab" id={`token-tab-${value}`} aria-selected={tab === value} aria-controls={`token-panel-${value}`} onClick={() => setTab(value)}>{label}</button>)}
    </div>}
    <div {...verified ? { role: "tabpanel", id: `token-panel-${tab}`, "aria-labelledby": `token-tab-${tab}` } : {}}>
      {verified && tab === "drop" ? <TokenDrops {...props} /> : <TokenSendModes {...props} verified={verified} />}
    </div>
  </div>;
}

/** Every way to send from this balance: to one recipient, to a list, as claim links, or to no one by burning. */
function TokenSendModes({ verified, ...props }: TokenActionProps & { verified: boolean }) {
  const [mode, setMode] = useState<SendMode>("one");
  const modes = verified ? SEND_MODES : SEND_MODES.filter(([value]) => value !== "links");
  return <div className={styles.form}>
    <div className={styles.sources} role="radiogroup" aria-label="Send to">
      {modes.map(([value, label]) =>
        <label key={value}><input type="radio" name="send-mode" value={value} checked={mode === value} onChange={() => setMode(value)} />{label}</label>)}
    </div>
    {mode === "one" ? <TokenSend {...props} />
      : mode === "many" ? <TokenDistribute {...props} />
        : mode === "links" ? <TokenClaimLinks {...props} />
          : <TokenBurn {...props} />}
  </div>;
}

/** No definition from the wallet or a matching link: accept one, but only if it derives this ID. */
function UnknownDefinition({ assetId }: { assetId: bigint }) {
  const [text, setText] = useState("");
  const importer = useImportDefinition();
  const check = text.trim() === "" ? undefined : checkDefinition(text, assetId);
  return <div className={styles.form}>
    <dl className={styles.facts}><dt>Token ID</dt><dd><code>{assetIdHex(assetId)}</code></dd></dl>
    <p className={styles.hint}>Without its definition, amounts of this token are shown in base units. Anyone who shares the token can give you its definition or its link.</p>
    <label>Definition or token link<textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} spellCheck={false} placeholder="https://…/token/0x…#d=…" /></label>
    {check?.state === "invalid" && <p className={styles.fieldError}>{check.message}</p>}
    {check?.state === "mismatch" && <p className={styles.fieldError}>This definition belongs to a different token ({shortAssetId(check.assetId)}), not this one.</p>}
    {check?.state === "verified" && <>
      <VerifiedDefinition definition={check.definition} assetId={assetId} />
      {importer.available ? <div className={styles.actions}><button type="button" className="button primary" disabled={importer.importing}
        onClick={() => void importer.importDefinition(check.definition)}>{importer.importing ? "Adding…" : "Add to your wallet"}</button></div>
        : <p className={styles.hint}>Connect your wallet to keep this definition.</p>}
      {importer.error !== undefined && <Notice tone="error">{importer.error}</Notice>}
    </>}
  </div>;
}

/** A matching link is verified; keeping it in the wallet makes balances and transfers use it. */
function ImportFromLink({ definition, assetId }: { definition: AssetDefinition; assetId: bigint }) {
  const importer = useImportDefinition();
  if (!importer.available || importer.known(assetId)) return null;
  return <div className={styles.status}>
    <p>This definition came from the link and matches the token ID. Your wallet does not have it yet.</p>
    <div><button type="button" className="button primary" disabled={importer.importing} onClick={() => void importer.importDefinition(definition)}>
      {importer.importing ? "Adding…" : "Add to your wallet"}</button></div>
    {importer.error !== undefined && <Notice tone="error">{importer.error}</Notice>}
  </div>;
}

/** Hash a document here and compare it with the committed digest. */
function ContentCheck({ digest }: { digest: Uint8Array }) {
  const [result, setResult] = useState<{ source: string; matches: boolean }>();
  const [text, setText] = useState("");
  const compare = async (bytes: Uint8Array, source: string) => setResult({ source, matches: sameDigest(await sha256(bytes), digest) });
  return <details>
    <summary>Check content against the digest</summary>
    <div className={styles.form}>
      <label>File<input type="file" onChange={(event) => {
        const file = event.target.files?.[0];
        if (file !== undefined) void file.arrayBuffer().then((buffer) => compare(new Uint8Array(buffer), `The file ${file.name}`));
      }} /></label>
      <label>Or text<textarea value={text} rows={2} onChange={(event) => setText(event.target.value)} /></label>
      <div><button type="button" className="button" disabled={text === ""} onClick={() => void compare(new TextEncoder().encode(text), "This text")}>Check text</button></div>
      {result !== undefined && <p className={result.matches ? styles.fieldOk : styles.fieldError} role="status">
        {result.source} {result.matches ? "matches the content digest." : "does not match the content digest."}</p>}
      <p className={styles.hint}>The digest is SHA-256 of the exact bytes, hashed in this browser.</p>
    </div>
  </details>;
}

function ShareToken({ definition }: { definition: AssetDefinition }) {
  const link = tokenShareLink(window.location.origin, definition);
  return <section className="panel" aria-labelledby="share-heading">
    <div className={styles.panelHeading}><h2 id="share-heading">Share</h2></div>
    <p className={styles.lede}>This link carries the definition. Whoever opens it can verify the name, symbol, decimals and supply against the token ID, and add the token to their wallet.</p>
    <div className={styles.share}>
      <input readOnly value={link} aria-label="Token link" onFocus={(event) => event.currentTarget.select()} />
      <CopyButton className="button" value={link} label="Copy token link" />
    </div>
  </section>;
}

/** Follow a creation from the create page, and resubmit or re-prove it if it did not land. */
function CreationStatus({ creation, assetId, definition }: { creation: CreationState; assetId: bigint; definition: AssetDefinition }) {
  const wallet = useWallet();
  const navigate = useNavigate();
  const location = useLocation();
  const tx = useTokenTransaction();
  const [again, setAgain] = useState(false);
  const [draft, setDraft] = usePublicationDraft();
  const [problem, setProblem] = useState<string>();
  const terms = { metadata: definition.metadata, initialSupply: definition.initialSupply };
  const follow = (next: CreationState) => {
    setAgain(false);
    navigate({ pathname: location.pathname, hash: location.hash }, { replace: true, state: { creation: next } });
  };
  const exactRoute = ({ openFeeAmount: _open, ...route }: TokenPublication) => route;
  const resubmit = async () => {
    const opened = wallet.wallet;
    if (opened === undefined) return;
    const outcome = await tx.run({ mode: creation.mode, openFeeAmount: 0n },
      (publication) => opened.createAsset({ ...terms, retryContentHash: creation.contentHash, ...exactRoute(publication) }));
    if (outcome.state === "sent") follow({ contentHash: outcome.result.contentHash, mode: creation.mode, ...(outcome.l1Hash === undefined ? {} : { l1Hash: outcome.l1Hash }) });
  };
  const createAgain = async () => {
    const opened = wallet.wallet;
    if (opened === undefined) return;
    const checked = checkedPublication(draft, wallet.funds?.spendablePrivate);
    if ("problem" in checked) { setProblem(checked.problem); return; }
    setProblem(undefined);
    // The same token ID: the wallet kept the creation material when it journaled the first attempt.
    const outcome = await tx.run(checked.choice, (publication) => opened.createAsset({ ...terms, assetId, ...publication }),
      { kind: "token-created", amount: definition.initialSupply, unit: tokenUnit(definition) });
    if (outcome.state === "sent") follow({ contentHash: outcome.result.contentHash, mode: checked.choice.mode, ...(outcome.l1Hash === undefined ? {} : { l1Hash: outcome.l1Hash }) });
    else if (outcome.state === "unknown" || outcome.state === "broadcast") follow({ contentHash: outcome.contentHash, mode: checked.choice.mode, ...(outcome.state === "unknown" ? { unknown: true } : { l1Hash: outcome.l1Hash }) });
  };
  const againButton = <button type="button" className="button primary" disabled={wallet.phase !== "ready"} onClick={() => setAgain(true)}>Create it again</button>;
  const working = tx.stage.state === "working" || tx.stage.state === "submitting";
  return <section className="panel" aria-labelledby="creation-heading">
    <div className={styles.panelHeading}><h2 id="creation-heading">Creation</h2></div>
    {working ? <TokenProofProgress stage={tx.stage} label="Creating your token" />
      : again ? <div className={styles.form}>
        <p className={styles.hint}>This proves the same token again, with the same token ID and definition.</p>
        <TokenPublicationFields draft={draft} onChange={setDraft} />
        {problem !== undefined && <Notice tone="error">{problem}</Notice>}
        {tx.stage.state === "failed" && <TokenFailureNotice failure={tx.stage} />}
        <div className={styles.actions}>
          <button type="button" className="button" onClick={() => setAgain(false)}>Cancel</button>
          <button type="button" className="button primary" disabled={wallet.phase !== "ready" || wallet.busy} onClick={() => void createAgain()}>Create token</button>
        </div>
      </div>
      : creation.unknown === true ? <UnknownTransaction key={creation.contentHash} contentHash={creation.contentHash} noun="token creation" fast={creation.mode === "fast"} fate={tx.fate}
        onConfirmed={() => follow({ contentHash: creation.contentHash, mode: creation.mode })} onRetry={() => void resubmit()} onCleared={againButton} />
      : <SentTransaction key={creation.contentHash} contentHash={creation.contentHash} mode={creation.mode} l1Hash={creation.l1Hash} noun="token creation" onExpired={<div>{againButton}</div>}>
        {tx.stage.state === "failed" && <TokenFailureNotice failure={tx.stage} />}
      </SentTransaction>}
  </section>;
}
