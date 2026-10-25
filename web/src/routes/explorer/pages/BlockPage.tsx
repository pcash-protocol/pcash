import { RelativeTime } from "../../../components/RelativeTime.tsx";
import { useMemo, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  BlockPayoutsResult,
  BlockTransactionResult,
  InclusionIdResult,
  PayoutSourceResult,
} from "@pcash/sdk/clients";
import { PcashAmount } from "../../../components/PcashAmount.tsx";
import { useReadyExplorer } from "../ExplorerProvider.tsx";
import {
  formatCount,
  outcomeLabel,
  formatTime,
  outcomeTone,
  shortHex,
} from "../format.ts";
import { blockPath } from "../paths.ts";
import {
  BatchLink,
  Breadcrumb,
  Empty,
  Failure,
  FinalityTag,
  Hash,
  Loading,
  TableScroll,
  Tag,
  TransactionLink,
  useRead,
} from "../ui.tsx";
import styles from "../ExplorerRoute.module.css";
import detailStyles from "./DetailPage.module.css";

/**
 * One block can be derived from several L1 delivery transactions, so the
 * origins are the distinct carriers across its results, in first-seen order.
 */
function deliveryOrigins(inclusions: InclusionIdResult[]): InclusionIdResult[] {
  const carriers = new Map<string, InclusionIdResult>();
  for (const inclusion of inclusions) {
    if (!carriers.has(inclusion.l1TransactionHash)) carriers.set(inclusion.l1TransactionHash, inclusion);
  }
  return [...carriers.values()];
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className={detailStyles.row}><dt>{label}</dt><dd>{children}</dd></div>;
}

/**
 * What this block's own results say about the L1 deliveries a payout names: the
 * batch each delivery index arrived in, and the transaction at each delivery
 * position.
 */
interface DeliveryIndex {
  carriers: Map<string, string>;
  transactions: Map<string, BlockTransactionResult>;
}

function deliveryIndex(results: BlockTransactionResult[]): DeliveryIndex {
  const carriers = new Map<string, string>();
  const transactions = new Map<string, BlockTransactionResult>();
  for (const result of results) {
    const { inclusion } = result;
    const delivery = inclusion.l1TransactionIndex.toString();
    if (!carriers.has(delivery)) carriers.set(delivery, inclusion.l1TransactionHash);
    transactions.set(`${delivery}:${inclusion.batchItemIndex}`, result);
  }
  return { carriers, transactions };
}

/**
 * A designated payout comes from one transaction, which this page can name. A
 * poster payout has no source transaction: it aggregates the contributions of
 * every batch listed here, so it links the batches instead.
 */
function PayoutSource({ source, deliveries }: { source: PayoutSourceResult; deliveries: DeliveryIndex }) {
  if (source.kind === "designatedIssuance") {
    const result = deliveries.transactions.get(`${source.l1TransactionIndex}:${source.batchItemIndex}`);
    return result === undefined
      ? <>L1 delivery {formatCount(source.l1TransactionIndex)} · item {formatCount(source.batchItemIndex)}</>
      : <TransactionLink transactionId={result.transactionId} />;
  }
  const { l1TransactionIndices } = source;
  return <>
    Poster aggregate of {formatCount(l1TransactionIndices.length)} {l1TransactionIndices.length === 1 ? "batch" : "batches"}
    {l1TransactionIndices.map((index) => {
      const carrier = deliveries.carriers.get(index.toString());
      return <span key={index.toString()}>
        {" · "}
        {carrier === undefined ? `L1 delivery ${formatCount(index)}` : <BatchLink l1TransactionHash={carrier} />}
      </span>;
    })}
  </>;
}

function PayoutTotals({ blockPayouts }: { blockPayouts: BlockPayoutsResult }) {
  const payouts = blockPayouts.payouts.length;
  return <div className={detailStyles.summary} aria-label="Block payouts">
    <section><h2>Open fees</h2>
      <strong className={detailStyles.summaryValue}><PcashAmount value={blockPayouts.openFeesTotal} /></strong>
      <p className={detailStyles.summaryCaption}>{blockPayouts.openFeesTotal === 0n
        ? "No transaction in this block paid an open fee."
        : "Existing PCASH, moved from the payers."}</p>
    </section>
    <section><h2>Issuance</h2>
      <strong className={detailStyles.summaryValue}><PcashAmount value={blockPayouts.issuanceTotal} /></strong>
      <p className={detailStyles.summaryCaption}>{blockPayouts.issuanceTotal === 0n
        ? "This block created no new supply."
        : "Newly created supply."}</p>
    </section>
    <section><h2>Payouts</h2>
      <strong className={detailStyles.summaryValue}>{formatCount(payouts)}</strong>
      <p className={detailStyles.summaryCaption}>{payouts === 0
        ? "No native note was created."
        : "Each is one native note."}</p>
    </section>
  </div>;
}

/**
 * Where this block's fees and issuance went. The two totals stay apart: a fee
 * moves value that already existed, while issuance is new supply.
 */
function Payouts({ blockPayouts, results }: {
  blockPayouts: BlockPayoutsResult;
  results: BlockTransactionResult[];
}) {
  const { payouts } = blockPayouts;
  const deliveries = deliveryIndex(results);
  return <section className={detailStyles.details}>
    <div className={detailStyles.sectionHeading}><h2>System payouts</h2><p>Where this block’s open fees and issuance went</p></div>
    <PayoutTotals blockPayouts={blockPayouts} />
    {payouts.length === 0
      ? <Empty>No system payout was created in this block. No successful transaction here declared an open fee or earned issuance.</Empty>
      : <>
        <TableScroll><table><thead><tr>
          <th>Destination</th><th>Route</th><th>Source</th>
          <th>Component</th><th className={styles.num}>Amount</th>
          <th className={styles.num}>Output leaf</th>
        </tr></thead><tbody>{payouts.map((note) => <tr key={note.outputIndex.toString()}>
          <td><Hash value={note.ownerCommitment} short /></td>
          <td><Tag tone="info">{note.source.kind === "designatedIssuance" ? "Designated" : "Open"}</Tag></td>
          <td><PayoutSource source={note.source} deliveries={deliveries} /></td>
          <td>{note.component === "openFee" ? "Open fee" : "Issuance"}</td>
          <td className={styles.num}><PcashAmount value={note.amount} /></td>
          <td className={styles.num}>{formatCount(note.outputIndex)}</td>
        </tr>)}</tbody></table></TableScroll>
        <p className={styles.privacyNote}>
          Each row is one native system note at an opaque owner commitment rather than an Ethereum
          address. A designated route pays the commitment its own transaction named. An open route pays the poster
          commitment of the including batch. Each poster component combines its contributions across the batches
          listed, so it has no single source transaction.
        </p>
      </>}
  </section>;
}

export function BlockPage() {
  const { reader } = useReadyExplorer();
  const { number = "" } = useParams();
  const parsed = useMemo(() => {
    try {
      const value = BigInt(number);
      return value < 0n ? null : value;
    } catch {
      return null;
    }
  }, [number]);
  const { value: snapshot, error, reload } = useRead(
    () => parsed === null ? Promise.resolve(null) : reader.blockSnapshot(parsed),
    [reader, parsed],
    { pollMs: 6_000 },
  );

  if (parsed === null) return <Failure>“{number}” is not a block number.</Failure>;
  if (error !== undefined && snapshot === undefined) return <Failure onRetry={reload}>{error}</Failure>;
  if (snapshot === undefined || snapshot === null) return <Loading />;
  const { block, status, blockPayouts } = snapshot;
  if (block === null) return <Failure>Block {number} does not exist.</Failure>;

  const results = block.transactionResults;
  const failed = results.filter((result) => result.outcome !== "succeeded").length;
  const origins = deliveryOrigins(results.map((result) => result.inclusion));

  return <div className={detailStyles.page}>
    {error !== undefined && <p role="status" className={styles.muted}>Update delayed. Showing the last loaded block.</p>}
    <Breadcrumb><Link to="/explorer">Explorer</Link><Link to="/blocks">Blocks</Link></Breadcrumb>
    <header className={detailStyles.header}>
      <div className={detailStyles.headingLine}>
        <div className={detailStyles.title}>
          <h1>Block {block.number.toString()}</h1>
          <FinalityTag blockNumber={block.number} finalizedBlock={status.finalizedBlock} />
        </div>
        <div className={styles.blockActions}>
        {block.number > 0n
          ? <Link className="button" to={blockPath(block.number - 1n)}>← Prev</Link>
          : <span className="button" aria-disabled="true">← Prev</span>}
        {block.number < status.latestBlock
          ? <Link className="button" to={blockPath(block.number + 1n)}>Next →</Link>
          : <span className="button" aria-disabled="true">Next →</span>}
        </div>
      </div>
      <p><RelativeTime seconds={block.timestamp} suffix /> · {formatTime(block.timestamp)}</p>
    </header>

    <div className={detailStyles.summary} aria-label="Block summary">
      <section><h2>Identity</h2><dl>
        <Row label="Block hash"><Hash value={block.hash} short /></Row>
      </dl></section>
      <section><h2>Activity</h2><dl>
        <Row label="Transactions">{formatCount(results.length)}</Row>
        <Row label="Failed">{failed === 0 ? "None" : formatCount(failed)}</Row>
        <Row label="L1 batches">{formatCount(origins.length)}</Row>
      </dl></section>
      <section><h2>Origin</h2><dl>
        <Row label="L1 block">{block.l1Origin.blockNumber.toString()}</Row>
        <Row label="L1 block hash"><Hash value={block.l1Origin.blockHash} short /></Row>
      </dl></section>
    </div>

    <section className={detailStyles.details}>
      <div className={detailStyles.sectionHeading}><h2>Transactions</h2><p>Admitted in this block</p></div>
      {results.length === 0
        ? <Empty>This block admitted no transactions.</Empty>
        : <TableScroll><table><thead><tr><th className={styles.num}>Index</th><th>Transaction</th><th>Content hash</th><th>Batch</th><th>Outcome</th></tr></thead>
          <tbody>{results.map((result, index) => <tr key={`${result.inclusion.l1TransactionHash}:${result.inclusion.batchItemIndex}`}>
            <td className={styles.num}>{formatCount(index)}</td>
            <td><TransactionLink transactionId={result.transactionId} /></td>
            <td>{shortHex(result.contentHash)}</td>
            <td><BatchLink l1TransactionHash={result.inclusion.l1TransactionHash} /></td>
            <td><Tag tone={outcomeTone(result.outcome)}>{outcomeLabel(result.outcome)}</Tag></td>
          </tr>)}</tbody></table></TableScroll>}
    </section>

    {results.length > 0 && blockPayouts !== null && <Payouts blockPayouts={blockPayouts} results={results} />}

    <details className={detailStyles.more}>
      <summary>Show more</summary>
      <dl>
        <Row label="Block hash"><Hash value={block.hash} /></Row>
        <Row label={block.number === 0n ? "Configuration commitment" : "Parent hash"}><Hash value={block.parentHash} /></Row>
        <Row label="State root"><Hash value={block.stateRoot} /></Row>
        <Row label="Transaction results root"><Hash value={block.transactionResultsRoot} /></Row>
        <Row label="L1 origin root"><Hash value={block.l1OriginRoot} /></Row>
        <Row label="History root"><Hash value={block.historyRoot} /></Row>
        <Row label="Transaction-bearing batches">{origins.length === 0
          ? "None. Excluded carriers do not appear here."
          : origins.map((origin) => <div key={origin.l1TransactionHash}>
            L1 block {origin.l1BlockNumber.toString()} · batch tx index {formatCount(origin.l1TransactionIndex)} {" "}
            <BatchLink l1TransactionHash={origin.l1TransactionHash} />
          </div>)}</Row>
      </dl>
    </details>
  </div>;
}
