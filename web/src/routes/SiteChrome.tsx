import { Fragment, Suspense, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { PageSkeleton } from "../components/PageSkeleton.tsx";
import { AccountWidget } from "../components/AccountWidget.tsx";
import { GitHubIcon } from "../components/icons.tsx";
import { useNetwork } from "../components/NetworkContext.tsx";
import { SOURCE_REPOSITORY_URL } from "./docs/publicDocuments.ts";
import { isExplorerPath } from "./explorer/paths.ts";
import { isTryPath } from "./try/paths.ts";
import { useMarketplaceTodoCount } from "./marketplace/MarketplaceProvider.tsx";
import { useLeaveGuard, useWalletActivity } from "./wallet/activity.ts";
import { legalNavigation, primaryNavigation, referenceNavigation, routeById, routeForPathname, type RouteDefinition } from "./routeManifest.ts";

const homeRoute = routeById("home");

// Explorer pages live at the site root, and Try PCASH covers its tabs' pages
// (tokens, drops, messages), so neither can be matched by path prefix like the others.
function isActive(route: RouteDefinition, pathname: string): boolean {
  if (route.id === "home") return pathname === "/";
  if (route.id === "explorer") return isExplorerPath(pathname);
  if (route.id === "get") return isTryPath(pathname);
  return pathname === route.path || pathname.startsWith(`${route.path}/`);
}

function NavItem({ route, pathname, children }: { route: RouteDefinition; pathname: string; children?: ReactNode }) {
  const active = isActive(route, pathname);
  return <Link to={route.path} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>{route.primaryLabel}
    {route.alpha && <span className="nav-alpha"><span className="sr-only">, </span>Alpha</span>}
    {children}</Link>;
}

/** The header and footer every page shares, including the live account widget. */
export function SiteChrome() {
  const { pathname } = useLocation();
  const activity = useWalletActivity();
  useLeaveGuard(activity.unsafeToLeave);
  const marketplaceTodos = useMarketplaceTodoCount();
  const { network } = useNetwork();
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    {network.l1ChainId !== 1 && <p className="testnet-banner" role="note"><strong>Testnet</strong> · Mainnet coming soon</p>}
    <header className="site-header">
      <NavLink to={homeRoute.path} className="brand" aria-label="PCASH home"><img className="brand-seal" src="/brand/seal-small.webp" alt="" width={239} height={240} /><img className="brand-word" src="/brand/wordmark.webp" alt="PCASH" width={900} height={188} /></NavLink>
      <div className="header-links">
        <nav aria-label="Primary navigation">{[...primaryNavigation, ...referenceNavigation].map((route, index) => <Fragment key={route.id}>
          {index > 0 && <span className="nav-separator" aria-hidden="true">·</span>}
          <NavItem route={route} pathname={pathname}>
            {route.id === "marketplace" && marketplaceTodos > 0 && <span className="nav-badge"><span className="sr-only">, </span>{marketplaceTodos}<span className="sr-only"> waiting on you</span></span>}
          </NavItem>
        </Fragment>)}</nav>
        <a className="header-github" href={SOURCE_REPOSITORY_URL} target="_blank" rel="noopener noreferrer" aria-label="PCASH on GitHub"><GitHubIcon size={18} /></a>
      </div>
      <div className="header-wallet"><AccountWidget /></div>
    </header>
    <main id="main-content">{routeForPathname(pathname)?.alpha && <p className="notice" role="note"><strong>Alpha.</strong> This page is in alpha. It is subject to change at any time and may break.</p>}<Suspense fallback={<PageSkeleton />}><Outlet /></Suspense></main>
    <footer><span>PCASH is a better Zcash. Always private, as secure as Ethereum.</span><nav aria-label="Footer navigation">
      <span className="footer-group">{primaryNavigation.map((route) => <Link key={route.id} to={route.path}>{route.primaryLabel}</Link>)}</span>
      <span className="footer-group">{referenceNavigation.map((route) => <Link key={route.id} to={route.path}>{route.primaryLabel}</Link>)}<a className="footer-github" href={SOURCE_REPOSITORY_URL} target="_blank" rel="noreferrer"><GitHubIcon size={14} />GitHub</a></span>
      <span className="footer-group">{legalNavigation.map((route) => <Link key={route.id} to={route.path}>{route.primaryLabel}</Link>)}</span>
    </nav></footer>
  </div>;
}
