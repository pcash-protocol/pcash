import { RelativeTime } from "../../../components/RelativeTime.tsx";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { BlockResult, TransactionSummaryResult } from "@pcash/sdk/clients";
import { PcashAmount } from "../../../components/PcashAmount.tsx";
import { useReadyExplorer } from "../ExplorerProvider.tsx";
import {
  describeEffect,
  formatCount,
  formatKind,
  outcomeLabel,
  outcomeTone,
} from "../format.ts";
import {
  Empty,
  Failure,
  Loading,
  TableScroll,
  Tag,
  TransactionLink,
  useRead,
} from "../ui.tsx";
import styles from "../ExplorerRoute.module.css";

/** Blocks either side of the head the dashboard window covers. */
const WINDOW = 9n;
const DASHBOARD_POLL_MS = 8_000;
const PRIVACY_NOTE =
  "Amounts and parties are encrypted. What each transaction did to the note set is public.";

function failedCount(block: BlockResult): number {
  return block.transactionResults.filter((result) => result.outcome !== "succeeded").length;
}

function Metric({ label, value, caption }: { label: string; value: ReactNode; caption?: string | undefined }) {
  return <div className={styles.metric}>
    <span>{label}</span>
    <strong>{value}</strong>
    {caption !== undefined && <small>{caption}</small>}
  </div>;
}

function BlockRows({ blocks }: { blocks: BlockResult[] }) {
  if (blocks.length === 0) return <Empty>No blocks have been derived yet.</Empty>;
  return <TableScroll><table><thead><tr>
    <th>Block</th><th>Age</th><th className={styles.num}>Transactions</th><th className={styles.num}>Failed</th>
  </tr></thead><tbody>{blocks.map((block) => {
    const failed = failedCount(block);
    return <tr key={block.hash}>
      <td><strong><Link className={styles.figures} to={`/block/${block.number}`}>{block.number.toString()}</Link></strong></td>
      <td><RelativeTime seconds={block.timestamp} /></td>
      <td className={styles.num}>{formatCount(block.transactionResults.length)}</td>
      <td className={styles.num}>{failed === 0 ? "—" : formatCount(failed)}</td>
    </tr>;
  })}</tbody></table></TableScroll>;
}

function TransactionRows({ items }: { items: TransactionSummaryResult[] }) {
  if (items.length === 0) return <Empty>No transactions have been admitted yet.</Empty>;
  return <TableScroll><table><thead><tr>
    <th>Transaction</th><th>Age</th><th>Kind</th><th>Effect</th><th>Outcome</th>
  </tr></thead><tbody>{items.map((item) => <tr key={item.transactionId}>
    <td><TransactionLink transactionId={item.transactionId} /></td>
    <td><RelativeTime seconds={item.timestamp} /></td>
    <td>{formatKind(item.kind)}</td>
    <td>{describeEffect(item)}</td>
    <td><Tag tone={outcomeTone(item.outcome)}>{outcomeLabel(item.outcome)}</Tag></td>
  </tr>)}</tbody></table></TableScroll>;
}

export function DashboardPage() {
  const { reader, status } = useReadyExplorer();
  const to = status.latestBlock;
  const from = to > WINDOW ? to - WINDOW : 0n;
  const { value, error, reload } = useRead(
    () => reader.dashboard(from, to),
    [reader],
    { pollMs: DASHBOARD_POLL_MS, refreshDeps: [from, to] },
  );
  const blocks = value?.[0];
  const transactions = value?.[1];

  // The four running totals come from the index, which reports null until it
  // has caught up. They are absent together, so one guard covers the strip.
  const totals = status.totalTransactions !== null
    && status.totalSucceeded !== null
    && status.totalFailed !== null
    ? { all: status.totalTransactions, succeeded: status.totalSucceeded, failed: status.totalFailed }
    : null;

  return <div className={styles.stack}>
    {error !== undefined && <Failure onRetry={reload}>{error}</Failure>}

    <section className={styles.metrics}>
      <Metric
        label="Transactions"
        value={totals === null ? "—" : formatCount(totals.all)}
        caption={totals === null ? undefined : `${formatCount(totals.succeeded)} succeeded · ${formatCount(totals.failed)} failed`}
      />
      <Metric label="Notes created" value={formatCount(status.outputCount)} caption="since genesis" />
      <Metric label="Gross issued" value={<PcashAmount value={status.issuedSoFar} />} />
    </section>

    <div className={styles.dashboardLists}>
      <section>
        <div className={styles.panelHeading}>
          <div><p className="eyebrow">Chain</p><h2>Latest blocks</h2></div>
          <Link to="/blocks">View all →</Link>
        </div>
        {blocks === undefined ? <Loading /> : <BlockRows blocks={[...blocks].reverse()} />}
      </section>
      <section>
        <div className={styles.panelHeading}>
          <div><p className="eyebrow">Activity</p><h2>Latest transactions</h2></div>
          <Link to="/transactions">View all →</Link>
        </div>
        <p className={styles.privacyNote}>{PRIVACY_NOTE}</p>
        {transactions === undefined ? <Loading /> : <TransactionRows items={transactions.items} />}
      </section>
    </div>
  </div>;
}
