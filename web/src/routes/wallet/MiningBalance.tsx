import { ETH_UNIT } from "../../components/EtherAmount.tsx";
import { PcashAmount } from "../../components/PcashAmount.tsx";
import { TokenAmount } from "../../components/TokenAmount.tsx";
import { useWallet } from "../../lib/WalletProvider.tsx";
import styles from "./Mining.module.css";

/** The balance includes only funds the wallet has recovered; ETH beside it pays Faster gas. */
export function MiningBalance({ testId }: { testId: string }) {
  const wallet = useWallet();
  const balance = wallet.profile === undefined ? undefined : wallet.funds?.total;
  return <div className={styles.metric} aria-label="Your PCASH balance">
    <span>Your balance</span>
    <div className={styles.balances}>
      <output data-testid={testId} aria-label="Your balance" aria-live="polite">
        {balance === undefined ? "—" : <PcashAmount value={balance} rounding="down" />}
      </output>
      {wallet.l1Balance !== undefined && <span className={styles.ether} data-testid="wallet-eth-balance"><TokenAmount value={wallet.l1Balance} unit={ETH_UNIT} rounding="down" /></span>}
    </div>
    {wallet.profile !== undefined && wallet.syncState.state === "error" && <div>
      <p role="status">{wallet.syncState.error ?? "Private payments could not be checked."}</p>
      <button type="button" className="button" disabled={wallet.busy} onClick={() => void wallet.synchronize().catch(() => undefined)}>Retry checking payments</button>
    </div>}
    {wallet.profile !== undefined && balance === undefined && wallet.syncState.state !== "error" && <p role="status">Checking for private payments…</p>}
  </div>;
}
