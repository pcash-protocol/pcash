import { useState } from "react";
import { Link } from "react-router-dom";
import { formatAssetDefinition } from "@pcash/sdk/protocol";
import { Notice } from "../../components/Notice.tsx";
import { RouteHeader } from "../../components/RouteHeader.tsx";
import { Metadata } from "../Metadata.tsx";
import { routeById } from "../routeManifest.ts";
import paper from "../PaperPage.module.css";
import { checkDefinition, NEW_TOKEN_PATH, tokenPath } from "./model.ts";
import { AvailableDrops } from "./AvailableDrops.tsx";
import { useImportDefinition, VerifiedDefinition } from "./TokenCommon.tsx";
import styles from "./Tokens.module.css";

const route = routeById("tokens");
const accountRoute = routeById("account");

/** Try PCASH's Tokens tab: the public token tools. Tokens a wallet holds are on its account page. */
export default function TokenListPage() {
  return <section className={`${paper.page} ${styles.stack}`}>
    <Metadata {...route.metadata} />
    <RouteHeader eyebrow="Private tokens" title="Tokens"
      description="Make a token with a fixed supply, send it privately, and check any token’s definition before you trust it."
      aside={<Link className="button primary" to={NEW_TOKEN_PATH}>Create token</Link>} />
    <div className={styles.columns}>
      <VerifyDefinitionBox />
      <section className="panel" aria-labelledby="your-tokens">
        <div className={styles.panelHeading}><h2 id="your-tokens">Your tokens</h2></div>
        <p className={styles.lede}>Tokens you create or receive are in your account, beside your PCASH.</p>
        <div className={styles.actions}><Link className="button" to={`${accountRoute.path}#tokens`}>View your tokens</Link></div>
      </section>
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
