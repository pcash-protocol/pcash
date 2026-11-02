import { Link } from "react-router-dom";
import type { WalletAsset } from "@pcash/sdk/wallet";
import { TokenAmount } from "../../components/TokenAmount.tsx";
import { shortAssetId, tokenPath, tokenUnit, UNVERIFIED_UNIT } from "./model.ts";
import styles from "./Tokens.module.css";

/** A square stamp: the symbol when it is verified, a dashed mark when it is not. */
export function TokenMark({ symbol }: { symbol?: string | undefined }) {
  return <span className={symbol === undefined ? `${styles.mark} ${styles.markUnverified}` : styles.mark} aria-hidden="true">
    {symbol === undefined ? "?" : symbol.slice(0, 5)}
  </span>;
}

/** Each held or known token, linking to its page. Verified tokens read by symbol; others by ID. */
export function TokenBalanceRows({ assets, compact = false, onNavigate }: { assets: readonly WalletAsset[]; compact?: boolean; onNavigate?: () => void }) {
  return <ul className={styles.tokenList} aria-label="Token balances" data-compact={compact ? "true" : undefined}>
    {assets.map((asset) => {
      const definition = asset.definition;
      const unit = definition === null ? UNVERIFIED_UNIT : tokenUnit(definition);
      return <li key={asset.assetId.toString()}>
        <Link className={styles.tokenRow} to={tokenPath(asset.assetId)} onClick={onNavigate} data-token-row={definition?.metadata.symbol ?? "unverified"}>
          <TokenMark symbol={definition?.metadata.symbol} />
          <span className={styles.tokenText}>
            <strong>{definition?.metadata.name ?? "Unverified token"}</strong>
            <small>{definition === null ? <>{shortAssetId(asset.assetId)} · add its definition</> : <>{definition.metadata.symbol}{asset.created ? " · created by you" : ""}</>}</small>
          </span>
          <span className={styles.tokenBalance}>
            <TokenAmount value={asset.private} unit={unit} rounding="down" />
            {!compact && asset.spendable !== asset.private && <small><TokenAmount value={asset.spendable} unit={unit} rounding="down" /> available</small>}
          </span>
        </Link>
      </li>;
    })}
  </ul>;
}
