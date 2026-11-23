import { DOCS_PATH, documentPath, publicDocuments } from "./docs/publicDocuments.ts";
import { explorerPaths } from "./explorer/paths.ts";

export type RouteRenderMode = "prerender" | "client";

export interface RouteMetadata {
  title: string;
  description: string;
  type?: "website" | "article";
}

export interface RouteDefinition {
  id: string;
  path: string;
  renderMode: RouteRenderMode;
  metadata: RouteMetadata;
  primaryLabel?: string;
  /** Marked Alpha in the header, with a notice above the page. */
  alpha?: true;
}

export const routeManifest: readonly RouteDefinition[] = [
  {
    id: "home",
    path: "/",
    renderMode: "prerender",
    metadata: { title: "A better Zcash", description: "PCASH is a better Zcash: always private, and as secure as Ethereum." },
    primaryLabel: "Home",
  },
  ...publicDocuments.map(({ id, file, title, description }): RouteDefinition => ({
    id,
    path: documentPath(file),
    renderMode: "prerender",
    metadata: { title, description, type: "article" },
  })),
  {
    id: "docs",
    path: DOCS_PATH,
    renderMode: "prerender",
    metadata: { title: "Docs", description: "The PCASH white paper, security model and protocol specification, and guides to building on PCASH and running a node." },
    primaryLabel: "Docs",
  },
  {
    id: "explorer",
    path: "/explorer",
    renderMode: "client",
    metadata: { title: "Explorer", description: "Inspect PCASH blocks, transactions, immutable contracts, verified source correspondence, and disclosed configuration." },
    primaryLabel: "Explorer",
  },
  {
    id: "marketplace",
    path: "/marketplace",
    renderMode: "client",
    metadata: { title: "Marketplace", description: "Buy and list PCASH for ETH." },
    primaryLabel: "Marketplace",
  },
  {
    id: "tokens",
    path: "/tokens",
    renderMode: "prerender",
    metadata: { title: "Tokens", description: "Create a private token with a fixed supply, send it, and check any token’s definition against its ID." },
  },
  {
    id: "token-new",
    path: "/tokens/new",
    renderMode: "client",
    metadata: { title: "Create a token", description: "Create a private token on PCASH with a fixed supply." },
  },
  {
    id: "token",
    path: "/token/:assetId",
    renderMode: "client",
    metadata: { title: "Token", description: "A private token on PCASH and its definition, verified against the token ID." },
  },
  {
    id: "claim",
    path: "/claim",
    renderMode: "client",
    metadata: { title: "Claim a link", description: "Claim the PCASH or tokens a claim link holds into your own wallet." },
  },
  {
    id: "receive",
    path: "/receive",
    renderMode: "client",
    metadata: { title: "Receive PCASH", description: "Receive PCASH someone sent to your Ethereum address before you set up PCASH." },
  },
  {
    id: "drop",
    path: "/drop/:contractAddress",
    renderMode: "client",
    metadata: { title: "Token drop", description: "Claim tokens from a drop for existing PCASH accounts." },
  },
  {
    id: "get",
    path: "/get",
    renderMode: "prerender",
    metadata: { title: "Try PCASH", description: "Get your first PCASH with one Ethereum transaction, send it, earn more by posting pending transactions, or make your own token." },
    primaryLabel: "Try PCASH",
  },
  {
    id: "get-earn",
    path: "/get/earn",
    renderMode: "client",
    metadata: { title: "Earn PCASH", description: "Earn new PCASH and fees by posting pending payments to Ethereum." },
  },
  {
    id: "account",
    path: "/account",
    renderMode: "client",
    metadata: { title: "Your account", description: "Your PCASH balances, activity, tokens, trades and wallet settings." },
  },
  {
    id: "board",
    path: "/board",
    renderMode: "client",
    metadata: { title: "Anonymous board", description: "A public board on PCASH: anyone can read every post, and no one can tell which account wrote one." },
  },
  {
    id: "board-thread",
    path: "/board/:postId",
    renderMode: "client",
    metadata: { title: "Thread", description: "A thread on the PCASH anonymous board, with every reply." },
  },
  {
    id: "terms",
    path: "/terms",
    renderMode: "prerender",
    metadata: { title: "Terms of Service", description: "The Terms of Service for this website and its related services." },
    primaryLabel: "Terms",
  },
  {
    id: "privacy",
    path: "/privacy",
    renderMode: "prerender",
    metadata: { title: "Privacy Policy", description: "How information is handled when you use this website and its related services." },
    primaryLabel: "Privacy",
  },
];

export function routeById(id: string): RouteDefinition {
  return routeManifest.find((candidate) => candidate.id === id)!;
}

/** The header's two groups, in order: what a visitor does here, then what they look up. */
export const primaryNavigation = (["get", "marketplace"] as const).map((id) => routeById(id));
export const referenceNavigation = (["explorer", "docs"] as const).map((id) => routeById(id));
/** The footer repeats the header, then the legal pages. */
export const legalNavigation = (["terms", "privacy"] as const).map((id) => routeById(id));
export const prerenderRoutes = routeManifest.filter((route) => route.renderMode === "prerender");

// Explorer object pages sit at the site root with a dynamic tail (/tx/:id,
// /block/:n, …), so each static head is a client prefix. Root identity paths
// are client-rendered by the shell fallback that covers every unknown path.
const explorerPrefixes = Object.values(explorerPaths)
  .filter((path) => path.includes("/:"))
  .map((path) => ({ prefix: `/${path.slice(0, path.indexOf("/:"))}`, routeId: "explorer" as const }));

export const clientRoutePrefixes = [
  ...explorerPrefixes,
  { prefix: "/marketplace", routeId: "marketplace" as const },
  { prefix: "/token", routeId: "token" as const },
  { prefix: "/drop", routeId: "drop" as const },
  { prefix: "/board", routeId: "board-thread" as const },
];

export function normalizePathname(pathname: string): string {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}

export function routeForPathname(pathname: string): RouteDefinition | undefined {
  const normalized = normalizePathname(pathname);
  const exact = routeManifest.find((route) => route.path === normalized);
  if (exact !== undefined) return exact;
  const prefix = clientRoutePrefixes.find(({ prefix: candidate }) => normalized.startsWith(`${candidate}/`));
  return prefix === undefined ? undefined : routeById(prefix.routeId);
}

export function renderModeForPathname(pathname: string): RouteRenderMode {
  return routeForPathname(pathname)?.renderMode ?? "client";
}
