import { useMemo } from "react";
import { friendlyError } from "../../../components/friendlyError.ts";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { PcashNodeRpcError } from "@pcash/sdk/clients";
import { useReadyExplorer, type ExplorerReader } from "../ExplorerProvider.tsx";
import { formatKind, outcomeLabel, parseSearchTarget, shortHex } from "../format.ts";
import { addressPath, batchPath, blockPath, transactionPath } from "../paths.ts";
import { Empty, Failure, Loading, PageHeading, useRead } from "../ui.tsx";
import styles from "../ExplorerRoute.module.css";

/** JSON-RPC invalid params, the node's answer for bytes that are not a nonzero BN254 field element. */
const INVALID_PARAMS = -32602;

interface HashMatch {
  label: string;
  detail: string;
  path: string;
}

/**
 * A 32-byte hash is not one namespace. The same bytes can be a transaction id,
 * a content hash with several inclusions, a block hash, and an L1 transaction
 * hash, so each is checked, including the node-local mempool for bytes awaiting inclusion.
 */
export async function resolveHashMatches(reader: ExplorerReader, hash: string): Promise<HashMatch[]> {
  const [transaction, submission, block, batches, pending] = await Promise.all([
    reader.transaction(hash),
    reader.submission(hash),
    // A block hash is a field element and most L1 hashes are not, so the node
    // refusing the bytes as a block hash means no block has them.
    reader.blockByHash(hash).catch((cause: unknown) => {
      if (cause instanceof PcashNodeRpcError && cause.code === INVALID_PARAMS) return null;
      throw cause;
    }),
    reader.l1DeliveryBatches(hash),
    reader.mempoolTransaction(hash),
  ]);
  const found: HashMatch[] = [];
  const summary = transaction?.summary;
  if (summary !== undefined) {
    found.push({
      label: "Transaction",
      detail: `${formatKind(summary.kind)} · ${outcomeLabel(summary.outcome)}`,
      path: transactionPath(hash),
    });
  }
  if (submission !== null && submission.items.length > 0) {
    const count = submission.items.length;
    found.push({
      label: "Content hash",
      detail: `${submission.nextCursor === null ? "" : "At least "}${count} inclusion${count === 1 ? "" : "s"} of these bytes`,
      path: transactionPath(hash),
    });
  }
  if (pending !== null) {
    found.push({ label: "Pending submission", detail: "Known to this node; not posted", path: transactionPath(hash) });
  }
  if (block !== null) {
    found.push({ label: "Block", detail: block.number.toString(), path: blockPath(block.number) });
  }
  const [batch] = batches;
  if (batch !== undefined) {
    found.push({
      label: "L1 batch",
      detail: `Ethereum block ${batch.l1BlockNumber}${batches.length > 1 ? ` · ${batches.length} carriers` : ""}`,
      path: batchPath(batch.l1TransactionHash),
    });
  }
  // A transaction id and a content hash both land on /tx, so two matches that
  // resolve to the same page are one answer, not an ambiguity.
  return found.filter((match, index) => found.findIndex((other) => other.path === match.path) === index);
}

function HashSearch({ hash, query }: { hash: string; query: string }) {
  const { reader } = useReadyExplorer();
  const { value: matches, error, reload } = useRead(() => resolveHashMatches(reader, hash), [reader, hash]);

  if (error !== undefined) return <Failure onRetry={reload}>{error}</Failure>;
  if (matches === undefined) return <Loading>Resolving this hash…</Loading>;
  if (matches.length === 0) return <Empty>No results for {query}</Empty>;
  const only = matches[0];
  if (matches.length === 1 && only !== undefined) return <Navigate replace to={only.path} />;
  return <div className={styles.stack}>
    <PageHeading
      eyebrow="Search"
      title="Search results"
      description={`These bytes name ${matches.length} different things on this chain.`}
    />
    <section className="panel"><div className={styles.dataRows}>
      {matches.map((match) => <Link className={styles.dataRow} key={match.label} to={match.path}>
        <span className={styles.itemIcon}>{match.label.slice(0, 1)}</span>
        <span className={styles.itemMain}><strong>{match.label}</strong><small>{match.detail}</small></span>
        <span className={styles.itemMeta}><code>{shortHex(hash)}</code></span>
        <span>View</span>
      </Link>)}
    </div></section>
  </div>;
}

export function SearchPage() {
  const [params] = useSearchParams();
  const query = (params.get("q") ?? "").trim();
  const parsed = useMemo(() => {
    if (query === "") return undefined;
    try {
      return { target: parseSearchTarget(query) };
    } catch (cause) {
      return { error: friendlyError(cause) };
    }
  }, [query]);

  if (parsed === undefined) {
    return <div className={styles.stack}>
      <PageHeading
        eyebrow="Search"
        title="Search"
        description="Enter a block number, an address or ENS, .gwei or .wei name, a transaction id, a content hash, a block hash, or an L1 transaction hash."
      />
    </div>;
  }
  if ("error" in parsed) {
    return <div className={styles.stack}>
      <PageHeading eyebrow="Search" title="Search" />
      <Empty>{parsed.error}</Empty>
    </div>;
  }

  const { target } = parsed;
  if (target.kind === "block") return <Navigate replace to={blockPath(target.number)} />;
  if (target.kind === "address") return <Navigate replace to={addressPath(target.address)} />;
  if (target.kind === "name") return <Navigate replace to={addressPath(target.name)} />;
  return <HashSearch hash={target.hash} query={query} />;
}
