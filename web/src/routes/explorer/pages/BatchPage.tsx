import { EthereumAddress } from "../../../components/EthereumAddress.tsx";
import { ExternalLinkIcon } from "../../../components/icons.tsx";
import { friendlyError } from "../../../components/friendlyError.ts";
import { Fragment, useRef, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { addressPath } from "../paths.ts";
import type { BlockResult, L1DeliveryBatchResult } from "@pcash/sdk/clients";
import { findRelayAttempt, relayDeploymentKey } from "../../../shared/relayHistory.ts";
import { useReadyExplorer, type ExplorerReader } from "../ExplorerProvider.tsx";
import { etherscanTransactionUrl, formatBytes, formatCount, outcomeLabel, shortHex } from "../format.ts";
import {
  BlockLink, Breadcrumb, Fact, Facts, Failure, Hash, Loading, TableScroll, Tag,
  TransactionLink, useRead,
} from "../ui.tsx";
import explorer from "../ExplorerRoute.module.css";
import styles from "./BatchPage.module.css";
import detailStyles from "./DetailPage.module.css";

interface BatchOutcome {
  blockNumber: bigint;
  succeeded: number;
  failed: number;
}

interface BatchView {
  /** Every carrier of the Ethereum transaction, in carrier order; empty when the node has none. */
  batches: L1DeliveryBatchResult[];
  outcome: BatchOutcome | null;
  results?: { result: BlockResult["transactionResults"][number]; index: number }[];
  detailError?: string;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className={detailStyles.row}><dt>{label}</dt><dd>{children}</dd></div>;
}

export function batchReason(reason: string): string {
  return reason.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/\bid\b/g, "ID").replace(/^./, (letter) => letter.toUpperCase());
}

function carrierTitle(batch: L1DeliveryBatchResult): string {
  switch (batch.carrierType) {
    case "calldata": return "Inbox calldata";
    case "blob": return "Inbox blobs";
    case "event": return `Carrier event, log ${batch.logIndex}`;
  }
}

export async function loadBatchView(reader: ExplorerReader, id: string, genesisL1Block: bigint, previous?: BatchView): Promise<BatchView> {
  const batches = await reader.l1DeliveryBatches(id);
  const [first] = batches;
  if (first === undefined) return { batches, outcome: null };
  const blockNumber = first.l1BlockNumber - genesisL1Block;
  let block: BlockResult | null;
  try { block = await reader.block(blockNumber); }
  catch (cause) {
    const retained = previous?.batches[0]?.l1BlockHash === first.l1BlockHash ? previous : undefined;
    return { batches, outcome: retained?.outcome ?? null,
      ...(retained?.results === undefined ? {} : { results: retained.results }),
      detailError: friendlyError(cause) };
  }
  if (block === null) return { batches, outcome: null };
  const carrier = first.l1TransactionHash.toLowerCase();
  const results = block.transactionResults.map((result, index) => ({ result, index }))
    .filter(({ result }) => result.inclusion.l1TransactionHash.toLowerCase() === carrier);
  return {
    batches,
    results,
    outcome: {
      blockNumber,
      succeeded: results.filter(({ result }) => result.outcome === "succeeded").length,
      failed: results.filter(({ result }) => result.outcome !== "succeeded").length,
    },
  };
}

type ResultsByItem = Map<string, NonNullable<BatchView["results"]>[number]>;

function CarrierSection({ batch, byItem, titled }: { batch: L1DeliveryBatchResult; byItem: ResultsByItem; titled: boolean }) {
  const admitted = batch.items.filter((item) => item.exclusionReason === null).length;
  return <section className={styles.carrier} aria-label={carrierTitle(batch)}>
    {titled && <div className={detailStyles.sectionHeading}><h2>{carrierTitle(batch)}</h2></div>}
    {batch.exclusionReason !== null && <div className={styles.excluded}><Tag tone="bad">{batchReason(batch.exclusionReason)}</Tag><span>No items were admitted.</span></div>}
    <div className={detailStyles.summary} aria-label="Carrier summary">
      <section><h2>Carrier</h2><dl>
        <Row label="Type">{batch.carrierType === "blob" ? "Blob" : batch.carrierType === "event" ? "Event" : "Calldata"}</Row>
        {batch.emitter !== null && <Row label="Emitter"><Link to={addressPath(batch.emitter)}><EthereumAddress address={batch.emitter} short /></Link></Row>}
        {batch.logIndex !== null && <Row label="Log index">{batch.logIndex.toString()}</Row>}
        {batch.carrierType === "event" && <Row label="Context">{batch.context === null ? "Not decoded"
          : batch.context === "0x" ? "Empty" : <code title={batch.context}>{shortHex(batch.context)}</code>}</Row>}
        {/* A carrier event's hash and length cover its whole log data; item offsets are into its decoded batch. */}
        <Row label={batch.carrierType === "event" ? "Log data length" : "Length"}>{formatBytes(batch.carrierLength)}</Row>
        {batch.carrierType === "blob" && <Row label="Blobs">{formatCount(batch.blobVersionedHashes.length)}</Row>}
      </dl></section>
      <section><h2>Items</h2><dl>
        <Row label="Total">{formatCount(batch.items.length)}</Row>
        <Row label="Admitted">{formatCount(admitted)}</Row>
        <Row label="Not admitted">{formatCount(batch.items.length - admitted)}</Row>
      </dl></section>
    </div>
    <section className={styles.items}><div className={detailStyles.sectionHeading}><h2>Items</h2></div><TableScroll><table>
      <thead><tr><th className={explorer.num}>Item</th><th className={explorer.num}>Batch offset (B)</th><th className={explorer.num}>Length (B)</th><th>Content hash</th><th>Admitted</th><th>Transaction</th><th className={explorer.num}>Block index</th><th>Result</th></tr></thead>
      <tbody>{batch.items.map((item) => {
        const entry = byItem.get(item.batchItemIndex.toString());
        return <tr key={item.batchItemIndex.toString()}>
          <td className={explorer.num}>{item.batchItemIndex.toString()}</td><td className={explorer.num}>{formatCount(item.byteOffset)}</td><td className={explorer.num}>{formatCount(item.byteLength)}</td>
          <td><code title={item.contentHash}>{shortHex(item.contentHash)}</code></td>
          <td><Tag tone={item.exclusionReason === null ? "good" : "warn"}>{item.exclusionReason === null ? "Yes" : "No"}</Tag></td>
          <td>{entry === undefined ? "—" : <TransactionLink transactionId={entry.result.transactionId} />}</td>
          <td className={explorer.num}>{entry === undefined ? "—" : entry.index}</td>
          <td>{item.exclusionReason !== null ? <span title={item.exclusionReason}><Tag tone="warn">{batchReason(item.exclusionReason)}</Tag></span>
            : entry === undefined ? "Checking…" : <Tag tone={entry.result.outcome === "succeeded" ? "good" : "bad"}>{outcomeLabel(entry.result.outcome)}</Tag>}</td>
        </tr>;
      })}</tbody>
    </table></TableScroll></section>
  </section>;
}

export function BatchPage() {
  const { hash } = useParams<{ hash: string }>();
  const { reader, status } = useReadyExplorer();
  const id = hash ?? "";
  const previous = useRef<{ id: string; value: BatchView } | undefined>(undefined);
  const { value, error, reload } = useRead(() => loadBatchView(reader, id, status.genesisL1Block,
    previous.current?.id === id ? previous.current.value : undefined),
    [reader, id, status.genesisL1Block],
    { pollMs: 5_000, refreshDeps: [status.latestBlockHash, status.finalizedBlockHash] });
  if (value !== undefined) previous.current = { id, value };
  const network = relayDeploymentKey(status);
  const local = findRelayAttempt(network, id);
  const etherscan = etherscanTransactionUrl(Number(status.l1ChainId), id);
  const batches = value?.batches ?? [];
  const [batch] = batches;
  const finalized = batch !== undefined && batch.l1BlockNumber <= status.finalizedL1BlockNumber;
  const heading = <>
    <Breadcrumb><Link to="/explorer">Explorer</Link><span>Batch</span></Breadcrumb>
    <div className={styles.heading}><h2>Batch <code title={id}>{shortHex(id)}</code></h2>
      {batch !== undefined ? <Tag tone="good">{finalized ? "Finalized" : "Unfinalized"}</Tag>
        : local !== undefined && <Tag tone={local.status === "failed" ? "bad" : "warn"}>{local.status === "failed" ? "Failed" : "Pending"}</Tag>}
    </div>
  </>;
  if (hash === undefined) return <Failure>No batch hash in the URL.</Failure>;
  if (value === undefined && local === undefined) return error === undefined ? <Loading /> : <Failure onRetry={reload}>{error}</Failure>;
  if (batch === undefined) return <div className={styles.page}>{heading}
    <section className={styles.pending}>
      <h3>{local === undefined ? "Batch not found" : local.status === "failed" ? "Submission failed" : "Waiting for the batch"}</h3>
      <p>{local === undefined ? "This node has no batch with this transaction hash."
        : local.status === "failed" ? local.error ?? "The Ethereum transaction did not complete."
        : "Your submission is being tracked. Batch details will appear here automatically."}</p>
      {error !== undefined && <p role="status">Update delayed. <button type="button" onClick={reload}>Retry</button></p>}
      {etherscan !== undefined && <a href={etherscan} target="_blank" rel="noreferrer">View on Etherscan<ExternalLinkIcon /></a>}
    </section>
  </div>;
  const { outcome, results = [] } = value!;
  const byItem: ResultsByItem = new Map(results.map((entry) => [entry.result.inclusion.batchItemIndex.toString(), entry]));
  const titled = batches.length > 1;
  const carrierLabel = (carrier: L1DeliveryBatchResult, label: string) => titled ? `${carrierTitle(carrier)}: ${label}` : label;
  return <div className={styles.page}>
    {heading}
    <p className={styles.subtitle}>Ethereum block {batch.l1BlockNumber.toString()} · Sent by <Link to={addressPath(batch.l1Sender)}><EthereumAddress address={batch.l1Sender} short /></Link>
      {titled && <> · {batches.length} carriers</>}
      {etherscan !== undefined && <> · <a href={etherscan} target="_blank" rel="noreferrer">Etherscan<ExternalLinkIcon /></a></>}
    </p>
    {(error !== undefined || value!.detailError !== undefined) && <p role="status">Update delayed. <button type="button" onClick={reload}>Retry</button></p>}
    <div className={detailStyles.summary} aria-label="Batch summary">
      <section><h2>Outcome</h2>{outcome === null ? <p>Checking transaction results…</p> : <dl>
        <Row label="PCASH block"><BlockLink number={outcome.blockNumber} /></Row>
        <Row label="Succeeded">{formatCount(outcome.succeeded)}</Row>
        <Row label="Failed">{formatCount(outcome.failed)}</Row>
      </dl>}</section>
    </div>
    {batches.map((carrier) => <CarrierSection key={`${carrier.carrierType}:${carrier.logIndex ?? ""}`} batch={carrier} byItem={byItem} titled={titled} />)}
    <details className={detailStyles.more}><summary>Raw batch details</summary><Facts>
      <Fact label="Ethereum transaction"><Hash value={batch.l1TransactionHash} /></Fact>
      <Fact label="Ethereum block hash"><Hash value={batch.l1BlockHash} /></Fact>
      <Fact label="Transaction index">{batch.l1TransactionIndex.toString()}</Fact>
      {batches.map((carrier) => <Fragment key={`${carrier.carrierType}:${carrier.logIndex ?? ""}`}>
        <Fact label={carrierLabel(carrier, "Carrier hash")}><Hash value={carrier.carrierHash} /></Fact>
        {carrier.context !== null && carrier.context !== "0x" && <Fact label={carrierLabel(carrier, "Context")}><code className={styles.context}>{carrier.context}</code></Fact>}
        {carrier.posterOwnerCommitment !== null && <Fact label={carrierLabel(carrier, "Poster commitment")}><Hash value={carrier.posterOwnerCommitment} /></Fact>}
        {carrier.exclusionReason !== null && <Fact label={carrierLabel(carrier, "Exclusion code")}><code>{carrier.exclusionReason}</code></Fact>}
      </Fragment>)}
    </Facts><p>Item positions count the items of every carrier of the Ethereum transaction, in carrier order, and include excluded items. Block positions count admitted transactions. A carrier event's carrier hash and length cover its whole log data. The poster commitment in the header is what open-route blockPayouts pays; it is an opaque commitment, not the Ethereum address that sent the batch.</p></details>
  </div>;
}
