import { RelativeTime } from "../../../components/RelativeTime.tsx";
import { useState } from "react";
import type { ExplorerCursor } from "@pcash/sdk/clients";
import { useReadyExplorer } from "../ExplorerProvider.tsx";
import {
  AddressLink,
  BatchLink,
  BlockLink,
  Empty,
  Failure,
  Loading,
  PageHeading,
  Pager,
  TableScroll,
  Tag,
  useCursorStack,
  useRead,
} from "../ui.tsx";
import styles from "../ExplorerRoute.module.css";

export function ContractsPage() {
  const { reader } = useReadyExplorer();
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const pages = useCursorStack<ExplorerCursor>();
  const { cursor } = pages;
  const { value: source } = useRead(() => reader.sourceInfo(), [reader]);
  const { value: page, error, reload } = useRead(
    () => reader.contracts({ limit: 25, verifiedOnly, ...(cursor ? { cursor } : {}) }),
    [reader, verifiedOnly, cursor],
  );

  const authority = source === undefined
    ? "the node's source verification service"
    : (source.info.serviceName ?? source.info.verificationAuthority);

  const toggle = <label className={styles.toggle}>
    <input
      type="checkbox"
      checked={verifiedOnly}
      onChange={(event) => {
        setVerifiedOnly(event.target.checked);
        pages.reset();
      }}
    />
    <span>Verified only</span>
  </label>;

  return <div className={styles.stack}>
    <PageHeading
      eyebrow="Code"
      title="Contracts"
      description={`Contract accounts on this chain. Source correspondence is published by ${authority}, which reproduces the deployed program from its source. It is not an audit.`}
      action={toggle}
    />
    {error !== undefined && <Failure onRetry={reload}>{error}</Failure>}
    <section className="panel">
      {page === undefined
        ? <Loading />
        : page.items.length === 0
          ? <Empty>{verifiedOnly ? "No contract on this node has verified source." : "This node has indexed no contracts."}</Empty>
          : <TableScroll><table>
            <thead><tr>
              <th>Contract</th>
              <th>Created</th>
              <th>Age</th>
              <th className={styles.num}>Functions</th>
              <th>L1 batch</th>
              <th>Verified</th>
            </tr></thead>
            <tbody>{page.items.map((contract) => <tr key={contract.address}>
              <td><AddressLink address={contract.address} /></td>
              <td><BlockLink number={contract.block.blockNumber} /></td>
              <td><RelativeTime seconds={contract.timestamp} /></td>
              <td className={styles.num}>{contract.functions.length}</td>
              <td><BatchLink l1TransactionHash={contract.origin.l1TransactionHash} /></td>
              <td>{contract.sourceVerification === null
                ? null
                : contract.sourceVerification === "verified"
                  ? <Tag tone="good">Verified</Tag>
                  : "Not verified"}</td>
            </tr>)}</tbody>
          </table></TableScroll>}
    </section>
    {page !== undefined && <Pager
      hasPrevious={pages.hasPrevious}
      hasNext={page.nextCursor !== null}
      onPrevious={pages.previous}
      onNext={() => page.nextCursor !== null && pages.next(page.nextCursor)}
    >Page {pages.page}</Pager>}
    <p className={styles.muted}>
      A contract's function set is fixed at creation. The function set commitment is bound into the
      address, so deploying a changed set produces a different address rather than changing this one.
    </p>
  </div>;
}
