import { Suspense } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { PageSkeleton } from "../components/PageSkeleton.tsx";
import { AccountWidget } from "../components/AccountWidget.tsx";
import { useNetwork } from "../components/NetworkContext.tsx";
import { SOURCE_REPOSITORY_URL } from "./docs/publicDocuments.ts";
import { isExplorerPath } from "./explorer/paths.ts";
import { useMarketplaceTodoCount } from "./marketplace/MarketplaceProvider.tsx";
import { useLeaveGuard, useWalletActivity } from "./wallet/activity.ts";
import { footerNavigation, primaryNavigation, routeById, routeForPathname, type RouteDefinition } from "./routeManifest.ts";

const homeRoute = routeById("home");

// Explorer pages live at the site root, so the Explorer item cannot be
// matched by path prefix like the others.
function isActive(route: RouteDefinition, pathname: string): boolean {
  if (route.id === "home") return pathname === "/";
  if (route.id === "explorer") return isExplorerPath(pathname);
  return pathname === route.path || pathname.startsWith(`${route.path}/`);
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
    {network.l1ChainId !== 1 && <p className="testnet-banner" role="note"><strong>Testnet.</strong> This site runs on {network.name}, and its PCASH has no value. Mainnet is coming soon.</p>}
    <header className="site-header">
      <NavLink to={homeRoute.path} className="brand" aria-label="PCASH home"><img className="brand-seal" src="/brand/seal-small.webp" alt="" width={239} height={240} /><img className="brand-word" src="/brand/wordmark.webp" alt="PCASH" width={900} height={188} /></NavLink>
      <nav aria-label="Primary navigation">{primaryNavigation.map((route) => {
        const active = isActive(route, pathname);
        return <Link key={route.id} to={route.path} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>{route.primaryLabel}
          {route.alpha && <span className="nav-alpha"><span className="sr-only">, </span>Alpha</span>}
          {route.id === "marketplace" && marketplaceTodos > 0 && <span className="nav-badge"><span className="sr-only">, </span>{marketplaceTodos}<span className="sr-only"> waiting on you</span></span>}</Link>;
      })}</nav>
      <div className="header-wallet"><AccountWidget /></div>
    </header>
    <main id="main-content">{routeForPathname(pathname)?.alpha && <p className="notice" role="note"><strong>Alpha.</strong> This page is in alpha. It is subject to change at any time and may break.</p>}<Suspense fallback={<PageSkeleton />}><Outlet /></Suspense></main>
    <footer><span>Private money Ethereum can program.</span><nav aria-label="Footer navigation">{footerNavigation.map((route) => <Link key={route.id} to={route.path}>{route.footerLabel}</Link>)}<a href={SOURCE_REPOSITORY_URL} target="_blank" rel="noreferrer">GitHub</a></nav></footer>
  </div>;
}
