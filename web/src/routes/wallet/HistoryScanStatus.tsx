import { ProgressIndicator } from "../../components/ProgressIndicator.tsx";
import { useWallet } from "../../lib/WalletProvider.tsx";
import styles from "./Mining.module.css";

/** The balance leaves out payments from before the block the wallet opened at until the background scan finds them. */
export function HistoryScanStatus() {
  const { history } = useWallet();
  if (!history.pending) return null;
  if (history.error !== undefined) return <div className={styles.history}><p>Searching for earlier payments failed. {history.error}</p></div>;
  const outputs = history.outputs;
  const percent = outputs === undefined || outputs.total === 0n ? undefined : Number(outputs.scanned * 100n / outputs.total);
  const text = percent === undefined ? "Searching for earlier payments…" : `Searching for earlier payments… ${percent}%`;
  return <div className={styles.history}>
    <p>{text}</p>
    <ProgressIndicator label="Searching for earlier payments" detail={text} value={percent === undefined ? undefined : percent / 100} />
  </div>;
}
