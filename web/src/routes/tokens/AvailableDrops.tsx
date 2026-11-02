import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AvailableDrop } from "@pcash/tokens/app";
import { TokenAmount } from "../../components/TokenAmount.tsx";
import { errorMessage, useWallet } from "../../lib/WalletProvider.tsx";
import { tokenUnit } from "./model.ts";
import { TokenMark } from "./TokenBalances.tsx";
import { dropPath, formatTimestamp } from "./TokenDrops.tsx";
import { useTokensApp } from "./useTokensApp.ts";
import styles from "./Tokens.module.css";

/** Drops this node's catalog lists, each rebuilt from its terms and its token's verified definition. */
export function AvailableDrops() {
  const { status } = useWallet();
  const tokens = useTokensApp();
  const [drops, setDrops] = useState<AvailableDrop[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    setError(undefined);
    void tokens.availableDrops()
      .then((found) => { if (current) setDrops(found); })
      .catch((cause) => { if (current) setError(errorMessage(cause)); });
    return () => { current = false; };
  }, [tokens.availableDrops]);
  const now = status?.latestBlockTimestamp;
  return <section className="panel" aria-labelledby="available-drops">
    <div className={styles.panelHeading}><h2 id="available-drops">Drops</h2></div>
    <p className={styles.lede}>Token drops listed on this node. Accounts that existed before a drop’s cutoff can each claim once.</p>
    {error !== undefined ? <p className={styles.fieldError}>{error}</p>
      : drops === undefined ? <p className={styles.hint} role="status">Looking for drops…</p>
      : drops.length === 0 ? <p className={styles.hint}>No drops are listed right now.</p>
      : <ul className={styles.tokenList} aria-label="Available drops">{drops.map((drop) => {
        const unit = tokenUnit(drop.definition);
        const terms = drop.drop.configuration;
        const ended = now !== undefined && now >= terms.claimEndTimestamp;
        return <li key={drop.id}><Link className={styles.dropRow} to={dropPath(drop.id)} data-drop-row={drop.id}>
          <TokenMark symbol={drop.definition.metadata.symbol} />
          <span className={styles.tokenText}>
            <strong>{drop.definition.metadata.name}</strong>
            <small>{ended ? "Ended" : `Ends ${formatTimestamp(terms.claimEndTimestamp)}`} · accounts from block {terms.cutoffBlockNumber.toString()}</small>
          </span>
          <span className={styles.tokenBalance}><TokenAmount value={terms.claimAmount} unit={unit} /><small>per account</small></span>
        </Link></li>;
      })}</ul>}
  </section>;
}
