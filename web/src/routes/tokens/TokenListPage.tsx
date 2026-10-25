import { useState } from "react";
import { Link } from "react-router-dom";
import { formatAssetDefinition } from "@pcash/sdk/protocol";
import { Notice } from "../../components/Notice.tsx";
import { RouteHeader } from "../../components/RouteHeader.tsx";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { Metadata } from "../Metadata.tsx";
import { routeById } from "../routeManifest.ts";
import paper from "../PaperPage.module.css";
import { checkDefinition, NEW_TOKEN_PATH, tokenPath } from "./model.ts";
import { AvailableDrops } from "./AvailableDrops.tsx";
import { TokenBalanceRows } from "./TokenBalances.tsx";
import { TokenWalletPrompt, useImportDefinition, VerifiedDefinition } from "./TokenCommon.tsx";
import styles from "./Tokens.module.css";

const route = routeById("tokens");

export default function TokenListPage() {
  const wallet = useWallet();
  const assets = wallet.snapshot?.assets ?? [];
  return <section className={`${paper.page} ${styles.stack}`}>
    <Metadata {...route.metadata} />
    <RouteHeader eyebrow="Private tokens" title="Tokens"
      description="Make a token with a fixed supply, send it privately, and check any token’s definition before you trust it."
      aside={<Link className="button primary" to={NEW_TOKEN_PATH}>Create token</Link>} />
    <div className={styles.columns}>
      <section className="panel" aria-labelledby="your-tokens">
        <div className={styles.panelHeading}><h2 id="your-tokens">Your tokens</h2></div>
        <TokenWalletPrompt purpose="to see your tokens" />
        {wallet.phase === "ready" && (assets.length === 0
          ? <div className={styles.empty}><strong>No tokens yet</strong><span className={styles.muted}>Tokens you create or receive appear here. Open a token link to add one.</span></div>
          : <TokenBalanceRows assets={assets} />)}
      </section>
      <VerifyDefinitionBox />
    </div>
    <AvailableDrops />
  </section>;
}

/** Check a pasted definition or token link against the token ID it derives. */
export function VerifyDefinitionBox() {
  const [text, setText] = useState("");
  const importer = useImportDefinition();
  const check = text.trim() === "" ? undefined : checkDefinition(text);
  return <section className="panel" aria-labelledby="verify-heading">
    <div className={styles.panelHeading}><h2 id="verify-heading">Check a token</h2></div>
    <p className={styles.lede}>Paste a token link or its definition. The name, symbol, decimals, content and supply are checked against the token ID they derive.</p>
    <div className={styles.form}>
      <label>Token link or definition<textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} spellCheck={false} placeholder="https://…/token/0x…#d=…" /></label>
      {check?.state === "invalid" && <p className={styles.fieldError}>{check.message}</p>}
      {check?.state === "verified" && <>
        <VerifiedDefinition definition={check.definition} assetId={check.assetId} />
        <div className={styles.actions}>
          <Link className="button" to={`${tokenPath(check.assetId)}#d=${formatAssetDefinition(check.definition)}`}>Open token page</Link>
          {importer.available && (importer.known(check.assetId)
            ? <span className={styles.fieldOk}>In your wallet</span>
            : <button type="button" className="button primary" disabled={importer.importing} onClick={() => void importer.importDefinition(check.definition)}>{importer.importing ? "Adding…" : "Add to your wallet"}</button>)}
        </div>
        {importer.error !== undefined && <Notice tone="error">{importer.error}</Notice>}
      </>}
    </div>
  </section>;
}
