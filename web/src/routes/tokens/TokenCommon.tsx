import { useState } from "react";
import type { AssetDefinition } from "@pcash/sdk/protocol";
import { TokenAmount } from "../../components/TokenAmount.tsx";
import { errorMessage, useWallet } from "../../lib/WalletProvider.tsx";
import { useWalletPanel } from "../wallet/OwnerPanels.tsx";
import { assetIdHex, contentDigestHex, durationText, isZeroDigest, tokenTerms, tokenUnit } from "./model.ts";
import styles from "./Tokens.module.css";

/** Token actions need the shared wallet; the sidebar owns connecting and setup. */
export function TokenWalletPrompt({ purpose }: { purpose: string }) {
  const { phase, connectionStep } = useWallet();
  if (phase === "ready") return null;
  const working = phase === "initializing" || phase === "connecting" || phase === "signing-in" || phase === "opening" || phase === "syncing";
  return <div className={styles.status} aria-label="Wallet setup">
    <p role="status">{working ? connectionStep ?? "Opening your wallet…"
      : phase === "disconnected" ? `Connect a wallet ${purpose}.` : phase === "sign-in-required" ? `Sign in to your wallet ${purpose}.` : `Finish setting up your wallet ${purpose}.`}</p>
    {!working && <WalletPromptButton />}
  </div>;
}

/** Signs in right here when the Ethereum wallet is connected but PCASH is locked; anything else opens the sidebar. */
export function WalletPromptButton() {
  const { phase, signIn } = useWallet();
  const panel = useWalletPanel();
  // A declined signature leaves the wallet locked and this button in place.
  const action = phase === "sign-in-required" ? () => void signIn().catch(() => undefined) : panel.openOverview;
  return <div><button type="button" className="button primary" onClick={action}>
    {phase === "disconnected" ? "Connect wallet" : phase === "sign-in-required" ? "Sign in" : "Open wallet"}</button></div>;
}

/** Only values the token ID commits to. Anything else on the page is rendered outside this box. */
export function VerifiedDefinition({ definition, assetId }: { definition: AssetDefinition; assetId: bigint }) {
  const unit = tokenUnit(definition);
  const terms = tokenTerms(definition);
  const digest = definition.metadata.contentDigest;
  return <section className={styles.verified} aria-label="Verified definition">
    <span className={styles.seal}><span aria-hidden="true">✓</span> Verified against the token ID</span>
    <dl className={styles.facts}>
      <dt>Name</dt><dd className={styles.bigName}>{definition.metadata.name}</dd>
      <dt>Symbol</dt><dd><code>{definition.metadata.symbol}</code></dd>
      <dt>Decimals</dt><dd>{definition.metadata.decimals}</dd>
      <dt>Supply</dt><dd>{terms.mint.kind === "fixed-supply"
        ? <><TokenAmount value={terms.mint.supply} unit={unit} /> · fixed, no more can ever be created</>
        : terms.mint.kind === "account-mint"
          ? <>Minted at the discretion of account <code>{terms.mint.account}</code></>
          : terms.mint.kind === "deposit-mint"
            ? <>Minted once per deposit to vault <code>{terms.mint.vault}</code> on Ethereum</>
            : "Minted under a custom mint rule"}</dd>
      {terms.transfers.kind !== "unrestricted" && <><dt>Transfers</dt><dd>{terms.transfers.kind === "sender-deny-list"
        ? <>The issuer can freeze accounts within {durationText(terms.transfers.maxDelta)} through deny list <code>{terms.transfers.listId}</code> of the contract at <code>{terms.transfers.contract}</code> on Ethereum</>
        : "Restricted by a custom transfer rule"}</dd></>}
      <dt>Content digest</dt><dd>{isZeroDigest(digest) ? "None" : <code>{contentDigestHex(digest)}</code>}</dd>
      <dt>Token ID</dt><dd><code>{assetIdHex(assetId)}</code></dd>
    </dl>
    <p className={styles.verifiedNote}>The token ID is derived from these values, so they cannot be changed or forged for this ID.</p>
  </section>;
}

/** Keep a verified definition in this browser's wallet. */
export function useImportDefinition() {
  const { wallet, refresh, snapshot } = useWallet();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string>();
  const known = (assetId: bigint) => snapshot?.assets.some((asset) => asset.assetId === assetId && asset.definition !== null) === true;
  const importDefinition = async (definition: AssetDefinition) => {
    if (wallet === undefined) return;
    setImporting(true);
    setError(undefined);
    try {
      await wallet.importAssetDefinition(definition);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setImporting(false);
    }
  };
  return { available: wallet !== undefined, importing, error, known, importDefinition };
}
