import { RelativeTime } from "../../../components/RelativeTime.tsx";
import { useState } from "react";
import { useReadyExplorer } from "../ExplorerProvider.tsx";
import { formatCount } from "../format.ts";
import {
  BlockLink,
  Empty,
  Failure,
  Loading,
  PageHeading,
  Pager,
  TableScroll,
  useRead,
} from "../ui.tsx";
import styles from "../ExplorerRoute.module.css";

const PAGE_SIZE = 25n;

/**
 * Block numbers are dense, so the window is arithmetic rather than a cursor.
 * `end` is undefined while the page tracks the head, which keeps Newer live as
 * new blocks arrive instead of pinning the table to the height at mount.
 */
export function BlocksPage() {
  const { reader, status } = useReadyExplorer();
  const [end, setEnd] = useState<bigint>();
  const to = end ?? status.latestBlock;
  const from = to >= PAGE_SIZE ? to - (PAGE_SIZE - 1n) : 0n;
  const { value: snapshot, error, reload } = useRead(async () => ({
    blocks: await reader.blocks(from, to), from, to,
  }), [reader, end], { pollMs: 6_000, refreshDeps: [from, to] });
  const blocks = snapshot?.blocks;
  const displayedFrom = snapshot?.from ?? from;
  const displayedTo = snapshot?.to ?? to;

  const newer = () => {
    const shifted = displayedTo + PAGE_SIZE;
    setEnd(shifted >= status.latestBlock ? undefined : shifted);
  };

  return <div className={styles.stack}>
    <PageHeading
      eyebrow="Canonical chain"
      title="Blocks"
      description="Every derived block, newest first, with the L1 block its transactions were delivered in."
      action={<span className={styles.muted}>
        Block {displayedFrom.toString()} to {displayedTo.toString()} of {status.latestBlock.toString()}
      </span>}
    />
    {error !== undefined && <Failure onRetry={reload}>{error}</Failure>}
    <section className="panel">
      {blocks === undefined
        ? <Loading />
        : blocks.length === 0
          ? <Empty>No blocks in this range.</Empty>
          : <TableScroll><table>
            <thead><tr>
              <th>Block</th>
              <th>Age</th>
              <th className={styles.num}>Transactions</th>
              <th className={styles.num}>Failed</th>
              <th>L1 block</th>
            </tr></thead>
            <tbody>{[...blocks].reverse().map((block) => {
              const failed = block.transactionResults.filter((result) => result.outcome !== "succeeded").length;
              return <tr key={block.hash}>
                <td><strong><BlockLink number={block.number} /></strong></td>
                <td><RelativeTime seconds={block.timestamp} /></td>
                <td className={styles.num}>{formatCount(block.transactionResults.length)}</td>
                <td className={styles.num}>{failed === 0 ? "—" : formatCount(failed)}</td>
                <td>L1 {block.l1Origin.blockNumber.toString()}</td>
              </tr>;
            })}</tbody>
          </table></TableScroll>}
    </section>
    <Pager
      hasPrevious={snapshot !== undefined && end !== undefined}
      hasNext={snapshot !== undefined && displayedFrom > 0n}
      onPrevious={newer}
      onNext={() => setEnd(displayedFrom - 1n)}
    />
  </div>;
}
