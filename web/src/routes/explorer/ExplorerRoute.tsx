import { PageSkeleton } from "../../components/PageSkeleton.tsx";
import { NavLink, Route, Routes, useLocation, useSearchParams, matchPath } from "react-router-dom";
import { ExplorerSearchForm } from "./ExplorerSearchForm.tsx";
import { ExplorerProvider, useExplorer } from "./ExplorerProvider.tsx";
import { explorerPaths } from "./paths.ts";
import { formatCount } from "./format.ts";
import { nodeSyncState } from "./model.ts";
import type { StatusResult } from "@pcash/sdk/clients";
import { DashboardPage } from "./pages/DashboardPage.tsx";
import { BlocksPage } from "./pages/BlocksPage.tsx";
import { BlockPage } from "./pages/BlockPage.tsx";
import { TransactionsPage } from "./pages/TransactionsPage.tsx";
import { TransactionPage } from "./pages/TransactionPage.tsx";
import { BatchPage } from "./pages/BatchPage.tsx";
import { ContractsPage } from "./pages/ContractsPage.tsx";
import { SearchPage } from "./pages/SearchPage.tsx";
import { Metadata, type MetadataProps } from "../Metadata.tsx";
import { RouteHeader } from "../../components/RouteHeader.tsx";
import paper from "../PaperPage.module.css";
import styles from "./ExplorerRoute.module.css";

export interface ExplorerRouteProps {
  metadata: MetadataProps;
}

/**
 * Chain-object pages share a nav group but not a URL prefix: every one of them
 * is a leaf at the site root.
 */
function ExplorerNavigation() {
  const link = ({ isActive }: { isActive: boolean }) => isActive ? styles.active : undefined;
  return <div className={styles.tabs}>
    <NavLink end className={link} to="/explorer">Overview</NavLink>
    <NavLink className={link} to="/blocks">Blocks</NavLink>
    <NavLink className={link} to="/transactions">Transactions</NavLink>
    <NavLink className={link} to="/contracts">Contracts</NavLink>
  </div>;
}

/** Sync state is shown only when it means the explorer's data is stale. */
export function ExplorerSyncBanner({ status }: { status: StatusResult }) {
  const sync = nodeSyncState(status.latestL1BlockNumber, status.observedL1BlockNumber);
  if (sync.kind !== "behind") return null;
  return <p role="status" className={styles.syncBanner}>
    Explorer data is {formatCount(sync.blocksBehind)} Ethereum blocks behind. Recent activity may be missing.
  </p>;
}

function ExplorerConnectionPanel() {
  const { connection, retry } = useExplorer();
  if (connection.phase === "ready") return null;
  if (connection.phase === "connecting") return <PageSkeleton />;
  const heading = connection.phase === "misconfigured"
    ? "Explorer is not configured"
    : connection.phase === "mismatch"
        ? "Network identity mismatch"
        : "Explorer unavailable";
  const message = connection.message;
  return <section className={`panel ${styles.statusPanel}`}>
    <p className="eyebrow">Connection</p>
    <h2>{heading}</h2>
    <p>{message}</p>
    {connection.phase !== "misconfigured"
      && <button type="button" onClick={retry}>Retry</button>}
  </section>;
}

function ExplorerContent({ metadata }: Pick<ExplorerRouteProps, "metadata">) {
  const { connection } = useExplorer();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const query = matchPath("/search", pathname) === null ? "" : params.get("q") ?? "";
  const detail = matchPath("/tx/:transactionId", pathname) !== null
    || matchPath("/batch/:hash", pathname) !== null
    || matchPath("/block/:number", pathname) !== null;
  const node = connection.phase === "misconfigured" ? undefined : connection.config;
  return <div className={`${paper.page} ${styles.stack}`}>
    <Metadata {...metadata} />
    {!detail && <RouteHeader eyebrow="Onchain activity" title="Explorer" description="Follow blocks, transactions, and the public record of private money."
      aside={connection.phase === "ready" && <span className={styles.chainStatus}>{node?.rpcDisplayUrl === "Fixture data" ? "Recorded chain" : `Block ${connection.status.latestBlock}`}</span>} />}
    {connection.phase === "ready"
      ? <>
        <ExplorerSyncBanner status={connection.status} />
        <ExplorerSearchForm key={query} initial={query} />
        {!detail && <ExplorerNavigation />}
        <Routes>
          <Route path={explorerPaths.dashboard} element={<DashboardPage />} />
          <Route path={explorerPaths.blocks} element={<BlocksPage />} />
          <Route path={explorerPaths.block} element={<BlockPage />} />
          <Route path={explorerPaths.transactions} element={<TransactionsPage />} />
          <Route path={explorerPaths.transaction} element={<TransactionPage />} />
          <Route path={explorerPaths.batch} element={<BatchPage />} />
          <Route path={explorerPaths.contracts} element={<ContractsPage />} />
          <Route path={explorerPaths.search} element={<SearchPage />} />
        </Routes>
      </>
      : <ExplorerConnectionPanel />}
  </div>;
}

export default function ExplorerRoute({ metadata }: ExplorerRouteProps) {
  return <ExplorerProvider><ExplorerContent metadata={metadata} /></ExplorerProvider>;
}
