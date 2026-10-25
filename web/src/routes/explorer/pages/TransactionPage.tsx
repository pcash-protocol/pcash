import { RelativeTime } from "../../../components/RelativeTime.tsx";
import { CopyButton } from "../../../components/CopyButton.tsx";
import { EthereumAddress } from "../../../components/EthereumAddress.tsx";
import { ExternalLinkIcon } from "../../../components/icons.tsx";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { addressPath } from "../paths.ts";
import { decodeArena, transactionArena, type DecodedRecord } from "../arena.ts";
import type {
  IssuanceRoute,
  ExplorerCursor,
  MempoolItemResult,
  ReceiptResult,
  TransactionPageResult,
  TransactionResult,
  TransactionSummaryResult,
} from "@pcash/sdk/clients";
import { toHex } from "@pcash/sdk/utils";
import { PcashAmount } from "../../../components/PcashAmount.tsx";
import { usePersonalTransactionDetails, type PersonalTransactionPayment } from "../../../components/PersonalTransactionDetails.tsx";
import { useReadyExplorer, type ExplorerReader } from "../ExplorerProvider.tsx";
import {
  describeFailure,
  etherscanTransactionUrl,
  failureOperands,
  formatBytes,
  formatCount,
  formatFundingMode,
  formatKind,
  outcomeLabel,
  formatTime,
  outcomeTone,
  relativeTime,
  type FailureOperand,
} from "../format.ts";
import {
  AddressLink,
  BatchLink,
  BlockLink,
  Breadcrumb,
  Failure,
  AddressDisplay,
  Hash,
  Loading,
  Pager,
  TableScroll,
  Tag,
  TransactionLink,
  useRead,
  useCursorStack,
} from "../ui.tsx";
import styles from "../ExplorerRoute.module.css";

import detailStyles from "./DetailPage.module.css";
import txStyles from "./TransactionPage.module.css";

const POLL_MS = 6_000;

/**
 * The route takes either identifier. A transaction id names one inclusion of
 * some bytes; a content hash names the exact bytes, which exist from the
 * moment they are signed and before anything is on chain.
 */
export type Resolution =
  | { state: "posted"; canonical: TransactionResult }
  | { state: "inclusions"; page: TransactionPageResult }
  | { state: "pending"; item: MempoolItemResult }
  | { state: "unknown" };

type PersonalPaymentState = "succeeded" | "failed" | "pending" | "submitted";

function matchingPayment(payments: PersonalTransactionPayment[], ...contentHashes: string[]): PersonalTransactionPayment | undefined {
  const normalized = new Set(contentHashes.map((contentHash) => contentHash.toLowerCase()));
  return payments.find((payment) => normalized.has(payment.contentHash.toLowerCase()));
}

function OperandValue({ operand }: { operand: FailureOperand }) {
  const { link } = operand;
  if (/^0x[0-9a-fA-F]{40}$/.test(operand.value)) return <AddressDisplay address={operand.value} short />;
  if (link === undefined) return operand.value.startsWith("0x")
    ? <Hash value={operand.value} short /> : <span>{operand.value}</span>;
  if (link.kind === "transaction") return <TransactionLink transactionId={link.value} />;
  return <BlockLink number={BigInt(link.value)} />;
}

function formatIssuanceRoute(route: IssuanceRoute): string {
  return route === "open" ? "Open" : route === "designated" ? "Designated" : "None";
}

/**
 * Where the settled fee and issuance went. Both routes resolve to one opaque
 * owner commitment: the one the action designated, or the poster commitment of
 * the batch whose inclusion succeeded. Neither is an Ethereum address.
 */
function BlockPayoutsDestination({ receipt }: { receipt: TransactionSummaryResult | undefined }) {
  if (receipt === undefined || receipt.issuanceOwnerCommitment === null) return <>—</>;
  return <Hash value={receipt.issuanceOwnerCommitment} short />;
}

/** Why this destination is the one that got paid, in one line. */
function BlockPayoutsNote({ route }: { route: IssuanceRoute }) {
  if (route === "open") {
    return <p className={txStyles.privacy}>
      The open route pays the poster commitment carried in the batch header. That commitment is not the
      Ethereum address that sent the batch, and it names no public balance.
    </p>;
  }
  if (route === "designated") {
    return <p className={txStyles.privacy}>
      The action named this issuance commitment in its proof, so reposting the same bytes cannot redirect issuance.
    </p>;
  }
  return null;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className={detailStyles.row}><dt>{label}</dt><dd>{children}</dd></div>;
}

export function PersonalPayment({ payment, state }: { payment: PersonalTransactionPayment; state: PersonalPaymentState }) {
  const completed = state === "succeeded";
  if (payment.kind === "mine") return <section className={txStyles.personalPayment} aria-label="Your mining action">
    <div className={txStyles.personalPaymentHeading}>
      <div><p>Your mining action</p><h2>{completed ? <>Mined{payment.minedAmount === undefined ? "" : <> <PcashAmount value={payment.minedAmount} /></>}</> : state === "failed" ? "Mining failed" : "Mining…"}</h2></div>
      {!completed && <Tag tone={state === "failed" ? "bad" : "warn"}>{state === "failed" ? "Failed" : "Pending"}</Tag>}
    </div>
    <p className={txStyles.personalPaymentNote}>These details come from this signed-in browser wallet. They are not public transaction data.</p>
    <dl><Row label="Issuance received">{completed ? payment.minedAmount === undefined ? "Checking received issuance…" : <PcashAmount value={payment.minedAmount} /> : state === "failed" ? "None" : "Pending"}</Row><Row label="Relayer fee"><PcashAmount value={0n} /></Row></dl>
  </section>;
  const description = completed
    ? "These details come from this signed-in browser wallet. They are not public transaction data."
    : state === "failed"
      ? "This inclusion failed, so it did not transfer the amount or pay the fee. The requested details come from this signed-in browser wallet."
      : state === "pending"
        ? "This signed-in browser wallet created the payment, but it has not been included in a PCASH block yet."
        : "These signed payment details come from this browser wallet. The inclusions below show what happened each time the bytes were submitted.";
  return <section className={txStyles.personalPayment} aria-label="Your private payment">
    <div className={txStyles.personalPaymentHeading}>
      <div><p>Your payment</p><h2>{completed ? <>Sent <PcashAmount value={payment.amount} /></> : <>Payment of <PcashAmount value={payment.amount} /></>}</h2></div>
      {!completed && <Tag tone={state === "failed" ? "bad" : "warn"}>{state === "failed" ? "Not sent" : state === "pending" ? "Pending" : "Signed"}</Tag>}
    </div>
    <p className={txStyles.personalPaymentNote}>{description}</p>
    <dl>
      <Row label="Recipient"><AddressDisplay address={payment.recipientAddress} /></Row>
      {!completed && <Row label="Requested amount"><PcashAmount value={payment.amount} /></Row>}
      <Row label={completed ? "Fee paid" : "Requested fee"}><PcashAmount value={payment.openFeeAmount} rounding="up" /></Row>
      <Row label={completed ? "Total paid" : "Requested total"}><PcashAmount value={payment.amount + payment.openFeeAmount} rounding="up" /></Row>
    </dl>
  </section>;
}

function FailureBlock({ outcome, detail }: {
  outcome: Exclude<TransactionSummaryResult["outcome"], "succeeded">;
  detail: ReceiptResult["failureDetail"];
}) {
  return <section className={txStyles.failure} aria-label="Transaction failure">
    <h2>{describeFailure(outcome)}</h2>
    {detail !== null && <dl>
      {failureOperands(detail).map((operand) => <Row key={operand.label} label={operand.label}>
        <OperandValue operand={operand} />
      </Row>)}
    </dl>}
  </section>;
}

type DetailTab = "Overview" | "Public inputs" | "Arena" | "Raw bytes";

/** The node is another process: bytes it serves that do not decode simply have no arena to show. */
function readArena(rawTransaction: string): Uint8Array | null {
  try {
    return transactionArena(rawTransaction);
  } catch {
    return null;
  }
}

function DecodedRecordRows({ record }: { record: DecodedRecord }) {
  if (record.kind === "boardPost") return <dl aria-label="Message board post">
    <Row label="Schema">Message board post</Row>
    <Row label="Application ID"><code>{record.schema}</code></Row>
    <Row label="Text"><span className={txStyles.recordText}>{record.text}</span></Row>
    <Row label="Post"><Link to={`/messages/${record.postId}`}><Hash value={record.postId} short /></Link></Row>
    <Row label="Reply to">{record.parent === null ? "None" : <Link to={`/messages/${record.parent}`}><Hash value={record.parent} short /></Link>}</Row>
    <Row label="Board"><Hash value={record.board} short /></Row>
  </dl>;
  return <dl aria-label="Application record">
    <Row label="Schema">Unknown application record</Row>
    <Row label="Application ID"><code>{record.schema}</code></Row>
    {record.text !== null && <Row label="As text"><span className={txStyles.recordText}>{record.text}</span></Row>}
    <Row label="Data"><pre className={txStyles.rawBytes}>{record.data}</pre></Row>
  </dl>;
}

function ArenaPanel({ arena }: { arena: Uint8Array }) {
  const { status } = useReadyExplorer();
  const [decoding, setDecoding] = useState(false);
  const hex = useMemo(() => toHex(arena), [arena]);
  const decoded = useMemo(() => decoding
    ? decodeArena({ chainId: BigInt(status.pcashChainId), genesisHash: status.genesisHash }, arena)
    : undefined, [decoding, arena, status.pcashChainId, status.genesisHash]);
  return <div className={txStyles.arena}>
    <div className={txStyles.arenaHeading}>
      <p>{formatBytes(BigInt(arena.length))}: a salt, then cells that carry encrypted deliveries, filler, and any public records.</p>
      <div className={txStyles.arenaActions}>
        <CopyButton value={hex} label="Copy arena" />
        <button type="button" aria-pressed={decoding} onClick={() => setDecoding(!decoding)}>{decoding ? "Hide decoded" : "Decode"}</button>
      </div>
    </div>
    {decoded !== undefined && <section className={txStyles.decoded} aria-label="Decoded arena">
      <dl>
        <Row label="Salt"><Hash value={decoded.salt} short mono /></Row>
        <Row label="Cells">{formatCount(decoded.cells)}</Row>
        <Row label="Public records">{decoded.publicRecords === null ? "None" : formatCount(decoded.publicRecords.length)}</Row>
      </dl>
      {decoded.publicRecords?.map((record) => <DecodedRecordRows key={record.schema} record={record} />)}
      <p className={txStyles.privacy}>
        {decoded.publicRecords === null ? "This arena publishes nothing. " : "Public records are plaintext and authenticate no author. "}
        The other cells are encrypted to a recipient or the sender, or are random filler, and only their keys can read them.
      </p>
    </section>}
    <pre className={txStyles.rawBytes}>{hex}</pre>
  </div>;
}

function PostedTransaction({ canonical, personalPayment }: { canonical: TransactionResult; personalPayment: PersonalTransactionPayment | undefined }) {
  const { status } = useReadyExplorer();
  const [tab, setTab] = useState<DetailTab>("Overview");
  const { summary } = canonical;
  const { inclusion } = summary;
  const receipt = summary;
  const detail = summary.failureDetail;
  const etherscan = etherscanTransactionUrl(Number(status.l1ChainId), inclusion.l1TransactionHash);
  const nullifiers = summary.nullifiers ?? [];
  const succeeded = summary.outcome === "succeeded";
  // A succeeded contract creation reports the account it created.
  const createdContract = summary.kind === "contractAccount" ? summary.account : null;
  const arena = useMemo(() => readArena(canonical.rawTransaction), [canonical.rawTransaction]);
  const tabs: DetailTab[] = arena === null ? ["Overview", "Public inputs", "Raw bytes"] : ["Overview", "Public inputs", "Arena", "Raw bytes"];

  return <div className={detailStyles.page}>
    <Breadcrumb><Link to="/explorer">Explorer</Link><Link to="/transactions">Transactions</Link></Breadcrumb>
    <header className={detailStyles.header}>
      <div className={detailStyles.title}><h1>Transaction</h1><Tag tone={succeeded ? "good" : "bad"}>{succeeded ? "Succeeded" : "Failed"}</Tag></div>
      <p>{formatKind(summary.kind)}{summary.fundingMode !== null && <> · {formatFundingMode(summary.fundingMode)}</>}{createdContract !== null && <> · <Link to={addressPath(createdContract.address)}><EthereumAddress address={createdContract.address} short /></Link></>} · <RelativeTime seconds={summary.timestamp} suffix /></p>
    </header>

    {summary.outcome !== "succeeded" && <FailureBlock outcome={summary.outcome} detail={detail} />}

    {personalPayment !== undefined && <PersonalPayment payment={personalPayment} state={succeeded ? "succeeded" : "failed"} />}

    <div className={detailStyles.summary} aria-label="Transaction summary">
      <section><h2>Identity</h2><dl>
        <Row label="Transaction ID"><Hash value={summary.transactionId} short /></Row>
        <Row label="Content hash"><Link to={`/tx/${summary.contentHash}`}><Hash value={summary.contentHash} short /></Link></Row>
        <Row label="PCASH chain">{status.pcashChainId.toString()}</Row>
      </dl></section>
      <section><h2>Inclusion</h2><dl>
        <Row label="PCASH block"><BlockLink number={summary.block.blockNumber} /></Row>
        <Row label="L1 batch"><BatchLink l1TransactionHash={inclusion.l1TransactionHash} /></Row>
        <Row label="Batch item">{inclusion.batchItemIndex.toString()}</Row>
        {receipt !== undefined && <Row label="Batch sent by"><AddressLink address={receipt.l1Sender} /></Row>}
      </dl></section>
      <section><h2>System payouts</h2><dl>
        <Row label="Issuance route">{formatIssuanceRoute(summary.issuanceRoute)}</Row>
        <Row label="Issuance to"><BlockPayoutsDestination receipt={succeeded ? receipt : undefined} /></Row>
        <Row label="Declared open fee">{summary.declaredOpenFeeAmount === null ? "None" : <PcashAmount value={summary.declaredOpenFeeAmount} rounding="up" />}</Row>
        <Row label="Open fee paid">{receipt === undefined ? "—" : <PcashAmount value={receipt.settledOpenFeeAmount} rounding="up" />}</Row>
        <Row label="Issuance paid">{receipt === undefined ? "—" : <PcashAmount value={receipt.settledIssuanceAmount} />}</Row>
      </dl>{succeeded && <BlockPayoutsNote route={summary.issuanceRoute} />}</section>
    </div>

    <section className={detailStyles.details}>
      <div role="tablist" aria-label="Transaction details" className={detailStyles.tabs}>
        {tabs.map((name, index) => <button key={name} type="button" role="tab" id={`transaction-tab-${index}`}
          aria-controls="transaction-panel" aria-selected={tab === name} tabIndex={tab === name ? 0 : -1}
          onClick={() => setTab(name)} onKeyDown={(event) => {
            const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
              : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
              : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
            if (next !== undefined) {
              event.preventDefault(); setTab(tabs[next]!);
              document.getElementById(`transaction-tab-${next}`)?.focus();
            }
          }}>{name}</button>)}
      </div>
      <div role="tabpanel" id="transaction-panel" aria-labelledby={`transaction-tab-${tabs.indexOf(tab)}`} tabIndex={0} className={detailStyles.tabPanel}>
        {tab === "Overview" && <>
          <dl>
            <Row label="Nullifiers spent">{formatCount(succeeded ? nullifiers.length : 0)}</Row>
            <Row label="Outputs created">{formatCount(summary.outputsAdded)}</Row>
            {summary.outputLeafStart !== null && <Row label="First output leaf">{summary.outputLeafStart.toString()}</Row>}
            {summary.account !== null && createdContract === null && <Row label="Account"><Link to={addressPath(summary.account.address)}><EthereumAddress address={summary.account.address} /></Link> · revision {summary.account.accountRevision.toString()}</Row>}
            <Row label="Timestamp">{formatTime(summary.timestamp)}</Row>
            <Row label="Block index">{summary.pcashTransactionIndex.toString()}</Row>
            <Row label="Byte size">{formatBytes(summary.byteSize)}</Row>
            <Row label="Outcome identifier"><code>{summary.outcome}</code></Row>
            {etherscan !== undefined && <Row label="Ethereum"><a href={etherscan} target="_blank" rel="noreferrer">View on Etherscan<ExternalLinkIcon /></a></Row>}
          </dl>
          {summary.kind === "privateValue" && personalPayment === undefined && <p className={txStyles.privacy}>Participants and amounts stay private.</p>}
        </>}
        {tab === "Public inputs" && <dl>
          <Row label="Issuance route">{formatIssuanceRoute(summary.issuanceRoute)}</Row>
          {summary.declaredIssuanceOwnerCommitment !== null && <Row label="Declared issuance destination"><Hash value={summary.declaredIssuanceOwnerCommitment} short mono /></Row>}
          {nullifiers.map((nullifier, index) => <Row key={`${index}:${nullifier}`} label={`Nullifier ${index + 1}`}><Hash value={nullifier} short mono /></Row>)}
        </dl>}
        {tab === "Arena" && arena !== null && <ArenaPanel arena={arena} />}
        {tab === "Raw bytes" && <pre className={txStyles.rawBytes}>{canonical.rawTransaction}</pre>}
      </div>
    </section>

  </div>;
}

function Inclusions({ hash, page, pagination, personalPayment }: { hash: string; page: TransactionPageResult; pagination: ReturnType<typeof useCursorStack<ExplorerCursor>>; personalPayment: PersonalTransactionPayment | undefined }) {
  return <div className={styles.stack}>
    <Breadcrumb>
      <Link to="/transactions">Transactions</Link>
      <span>Submission</span>
    </Breadcrumb>

    <div className={styles.panelHeading}>
      <div>
        <h2>Submission</h2>
        <Hash value={hash} />
      </div>
    </div>
    <p>Each row is one inclusion of these exact bytes, newest first. A later failed replay does not change an earlier successful inclusion.</p>

    {personalPayment !== undefined && <PersonalPayment payment={personalPayment} state="submitted" />}

    <TableScroll>
      <table>
        <thead>
          <tr><th>Transaction</th><th className={styles.num}>Block</th><th className={styles.num}>Age</th><th>L1 batch</th><th>Outcome</th></tr>
        </thead>
        <tbody>
          {page.items.map((summary) => <tr key={summary.transactionId}>
            <td><TransactionLink transactionId={summary.transactionId} /></td>
            <td className={styles.num}><BlockLink number={summary.block.blockNumber} /></td>
            <td className={styles.num}><RelativeTime seconds={summary.timestamp} /></td>
            <td><BatchLink l1TransactionHash={summary.inclusion.l1TransactionHash} /></td>
            <td><Tag tone={outcomeTone(summary.outcome)}>{outcomeLabel(summary.outcome)}</Tag></td>
          </tr>)}
        </tbody>
      </table>
    </TableScroll>
    <Pager hasPrevious={pagination.hasPrevious} hasNext={page.nextCursor !== null} onPrevious={pagination.previous} onNext={() => page.nextCursor !== null && pagination.next(page.nextCursor)}>
      Page {pagination.page}
    </Pager>
  </div>;
}

function Pending({ item, personalPayment }: { item: MempoolItemResult; personalPayment: PersonalTransactionPayment | undefined }) {
  const receivedAt = item.receivedAtUnixMs / 1000n;
  return <div className={detailStyles.page}>
    <Breadcrumb><Link to="/explorer">Explorer</Link><Link to="/transactions">Transactions</Link></Breadcrumb>
    <header className={detailStyles.header}>
      <div className={detailStyles.title}><h1>Transaction</h1><Tag tone="warn">Pending</Tag></div>
      <p>Waiting to be posted to Ethereum.</p>
    </header>

    {personalPayment !== undefined && <PersonalPayment payment={personalPayment} state="pending" />}

    <div className={detailStyles.summary} aria-label="Transaction summary">
      <section>
        <h2>Content hash</h2>
        <Hash value={item.contentHash} short />
      </section>
      <section>
        <h2>Declared open fee</h2>
        <PcashAmount value={item.openFeeAmount} rounding="up" className={styles.figures} />
      </section>
      <section>
        <h2>Received</h2>
        <time className={styles.figures} dateTime={new Date(Number(item.receivedAtUnixMs)).toISOString()} title={formatTime(receivedAt)}>
          {relativeTime(receivedAt)} ago
        </time>
      </section>
    </div>

    <dl>
      <Row label="Issuance route">{formatIssuanceRoute(item.issuanceRoute)}</Row>
      <Row label="Byte size">{formatBytes(item.byteSize)}</Row>
    </dl>

    <div><Link className="button" to="/get">Get PCASH →</Link></div>
  </div>;
}

export function TransactionPage() {
  const { transactionId } = useParams<{ transactionId: string }>();
  return transactionId === undefined ? <Failure>No transaction id in the URL.</Failure> : <TransactionContent key={transactionId} id={transactionId} />;
}

/**
 * What `/tx/:id` names: a transaction ID, or a content hash. Bytes included once
 * are that one transaction; the list of inclusions is for bytes included more than once.
 */
export async function resolveTransaction(
  reader: Pick<ExplorerReader, "transaction" | "submission" | "mempoolTransaction">,
  id: string,
  cursor: ExplorerCursor | undefined,
): Promise<Resolution> {
  const posted = await reader.transaction(id);
  if (posted !== null) return { state: "posted", canonical: posted };
  const submission = await reader.submission(id, cursor);
  const [only] = submission.items;
  if (only !== undefined && submission.items.length === 1 && submission.nextCursor === null && cursor === undefined) {
    const included = await reader.transaction(only.transactionId);
    if (included !== null) return { state: "posted", canonical: included };
  }
  if (submission.items.length > 0) return { state: "inclusions", page: submission };
  const pending = await reader.mempoolTransaction(id);
  if (pending !== null) return { state: "pending", item: pending };
  return { state: "unknown" };
}

function TransactionContent({ id }: { id: string }) {
  const { reader, status } = useReadyExplorer();
  const personalDetails = usePersonalTransactionDetails();
  const pagination = useCursorStack<ExplorerCursor>();
  const personalPayments = personalDetails.network !== undefined
    && personalDetails.network.chainId === BigInt(status.pcashChainId)
    && personalDetails.network.genesisHash.toLowerCase() === status.genesisHash.toLowerCase()
    ? personalDetails.payments
    : [];

  const { value, error, reload } = useRead<Resolution>(() => resolveTransaction(reader, id, pagination.cursor),
    [reader, id, pagination.cursor], pagination.cursor === undefined ? { pollMs: POLL_MS } : {});

  if (error !== undefined && value === undefined) return <Failure onRetry={reload}>{error}</Failure>;
  if (value === undefined) return <Loading />;

  let content: ReactNode;
  switch (value.state) {
    case "posted":
      content = <PostedTransaction canonical={value.canonical}
        personalPayment={value.canonical.summary.kind === "privateValue"
          ? matchingPayment(personalPayments, value.canonical.summary.contentHash)
          : undefined} />;
      break;
    case "inclusions":
      content = <Inclusions hash={id} page={value.page} pagination={pagination} personalPayment={matchingPayment(personalPayments, id)} />;
      break;
    case "pending":
      content = <Pending item={value.item} personalPayment={value.item.kind === "privateValue" ? matchingPayment(personalPayments, id, value.item.contentHash) : undefined} />;
      break;
    case "unknown":
      content = <Failure>
        This node has not seen a transaction or a submission with this hash. Another node may have:
        this node only knows what it has derived and what its own mempool holds.
      </Failure>;
  }
  return <>
    {error !== undefined && <p role="status" className={styles.muted}>Update delayed. Showing the last loaded transaction.</p>}
    {content}
  </>;
}
