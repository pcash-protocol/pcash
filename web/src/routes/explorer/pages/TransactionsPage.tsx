import { RelativeTime } from "../../../components/RelativeTime.tsx";
import { useState } from "react";
import type { ExplorerCursor, TransactionQuery, TransactionSummaryResult } from "@pcash/sdk/clients";
import { PcashAmount } from "../../../components/PcashAmount.tsx";
import { useReadyExplorer } from "../ExplorerProvider.tsx";
import {
  describeEffect,
  formatBytes,
  formatKind,
  outcomeLabel,
  outcomeTone,
} from "../format.ts";
import {
  AddressLink,
  BlockLink,
  Empty,
  Failure,
  Loading,
  PageHeading,
  Pager,
  TableScroll,
  Tag,
  TransactionLink,
  useCursorStack,
  useRead,
} from "../ui.tsx";
import styles from "../ExplorerRoute.module.css";

const PAGE_LIMIT = 25;

const KINDS = [
  "privateValue",
  "userAccountCreation",
  "userAccountUpdate",
  "contractAccount",
] as const;

/**
 * The effect string is the account address only for a succeeded account
 * transaction; a failure describes itself instead, and is not a link.
 */
function Effect({ summary }: { summary: TransactionSummaryResult }) {
  const text = describeEffect(summary);
  const { account } = summary;
  if (account !== null && text === account.address) return <AddressLink address={account.address} />;
  return <>{text}</>;
}

function Fee({ summary }: { summary: TransactionSummaryResult }) {
  if (summary.declaredOpenFeeAmount === null) return <>—</>;
  return <>
    <PcashAmount value={summary.declaredOpenFeeAmount} rounding="up" />
    {summary.issuanceRoute === "designated" && <span className={styles.muted}> designated</span>}
  </>;
}

/**
 * Consensus transactions only. A pending transaction has no transaction id,
 * because that derives from the L1 coordinates it does not have yet, so it
 * cannot appear in a list keyed by inclusion identity.
 */
export function TransactionsPage() {
  const { reader } = useReadyExplorer();
  const [kind, setKind] = useState("");
  const { cursor, hasPrevious, next, previous, reset } = useCursorStack<ExplorerCursor>();

  const { value: page, error, reload } = useRead(() => {
    const query: TransactionQuery = { limit: PAGE_LIMIT };
    if (cursor !== undefined) query.cursor = cursor;
    if (kind !== "") query.kind = kind;
    return reader.transactions(query);
  }, [reader, cursor, kind]);

  const changeKind = (value: string) => {
    setKind(value);
    reset();
  };

  return <div className={styles.stack}>
    <PageHeading eyebrow="Consensus" title="Transactions" />
    <p className={styles.privacyNote}>
      Amounts and parties are encrypted. What each transaction did to the note set is public.
    </p>

    <div className={styles.filters}>
      <label className={styles.filterControl}>
        Kind
        <select value={kind} onChange={(event) => changeKind(event.target.value)}>
          <option value="">All kinds</option>
          {KINDS.map((value) => <option key={value} value={value}>{formatKind(value)}</option>)}
        </select>
      </label>
    </div>

    {error !== undefined && <Failure onRetry={reload}>{error}</Failure>}
    {error === undefined && page === undefined && <Loading />}
    {page !== undefined && <>
      {page.items.length === 0
        ? <Empty>No transactions match this filter.</Empty>
        : <TableScroll>
        <table>
          <thead>
            <tr>
              <th>Transaction</th>
              <th className={styles.num}>Block</th>
              <th className={styles.num}>Age</th>
              <th>Kind</th>
              <th>Effect</th>
              <th className={styles.num}>Fee</th>
              <th className={styles.num}>Size</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((summary) => <tr key={summary.transactionId}>
              <td><TransactionLink transactionId={summary.transactionId} /></td>
              <td className={styles.num}><BlockLink number={summary.block.blockNumber} /></td>
              <td className={styles.num}><RelativeTime seconds={summary.timestamp} /></td>
              <td>{formatKind(summary.kind)}</td>
              <td><Effect summary={summary} /></td>
              <td className={styles.num}><Fee summary={summary} /></td>
              <td className={styles.num}>{formatBytes(summary.byteSize)}</td>
              <td>
                <Tag tone={outcomeTone(summary.outcome)}>{outcomeLabel(summary.outcome)}</Tag>
              </td>
            </tr>)}
          </tbody>
        </table>
      </TableScroll>}
      <Pager
        hasPrevious={hasPrevious}
        hasNext={page.nextCursor !== null}
        onPrevious={previous}
        onNext={() => page.nextCursor !== null && next(page.nextCursor)}
      />
    </>}
  </div>;
}
