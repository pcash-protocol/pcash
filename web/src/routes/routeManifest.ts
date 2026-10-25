import { documentPath, publicDocuments } from "./docs/publicDocuments.ts";
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
  footerLabel?: string;
  /** Marked Alpha in the header, with a notice above the page. */
  alpha?: true;
}

export const routeManifest: readonly RouteDefinition[] = [
  {
    id: "home",
    path: "/",
    renderMode: "prerender",
    metadata: { title: "PCASH", description: "Private money Ethereum can program. Anyone can write the rules a PCASH account spends by, rules can act on Ethereum, and it runs on Ethereum with no sequencer, operator, or upgrade key." },
    primaryLabel: "Home",
  },
  {
    id: "learn",
    path: "/docs",
    renderMode: "prerender",
    metadata: { title: "Learn PCASH", description: "PCASH in six ideas: private payments in any asset, rules you choose, Ethereum apps that move private money, proofs that travel with it, Ethereum ordering, and earning PCASH." },
    primaryLabel: "Learn",
    footerLabel: "Learn",
  },
  ...publicDocuments.map(({ id, file, title, description, footerLabel }): RouteDefinition => ({
    id,
    path: documentPath(file),
    renderMode: "prerender",
    metadata: { title, description, type: "article" },
    ...footerLabel === undefined ? {} : { footerLabel },
  })),
  {
    id: "developers",
    path: "/developers",
    renderMode: "prerender",
    metadata: { title: "Developers", description: "Build private applications with the PCASH protocol specification, guides, reference documentation, and reproducible source." },
    primaryLabel: "Developers",
    footerLabel: "Developers",
  },
  {
    id: "explorer",
    path: "/explorer",
    renderMode: "client",
    metadata: { title: "Explorer", description: "Inspect PCASH blocks, transactions, immutable contracts, verified source correspondence, and disclosed configuration." },
    primaryLabel: "Explorer",
    footerLabel: "Explorer",
  },
  {
    id: "marketplace",
    path: "/marketplace",
    renderMode: "client",
    metadata: { title: "Marketplace", description: "Buy and list PCASH for ETH." },
    primaryLabel: "Marketplace",
    footerLabel: "Marketplace",
  },
  {
    id: "tokens",
    path: "/tokens",
    renderMode: "prerender",
    metadata: { title: "Tokens", description: "Create a private token with a fixed supply, send it, and check any token's definition against its ID." },
    primaryLabel: "Tokens",
    footerLabel: "Tokens",
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
    metadata: { title: "Claim tokens", description: "Claim the tokens a PCASH claim link holds into your own wallet." },
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
    metadata: { title: "Get PCASH", description: "Mine PCASH, relay transactions, and follow native issuance." },
    primaryLabel: "Get PCASH",
    footerLabel: "Get PCASH",
  },
  {
    id: "messages",
    path: "/messages",
    renderMode: "client",
    metadata: { title: "Messages", description: "An anonymous public message board on PCASH: anyone can read every post, and no one can tell which account wrote one." },
    primaryLabel: "Messages",
    footerLabel: "Messages",
  },
  {
    id: "message-thread",
    path: "/messages/:postId",
    renderMode: "client",
    metadata: { title: "Thread", description: "A thread on the PCASH message board, with every reply." },
  },
  {
    id: "terms",
    path: "/terms",
    renderMode: "prerender",
    metadata: { title: "Terms of Service", description: "The Terms of Service for this website and its related services." },
    footerLabel: "Terms",
  },
  {
    id: "privacy",
    path: "/privacy",
    renderMode: "prerender",
    metadata: { title: "Privacy Policy", description: "How information is handled when you use this website and its related services." },
    footerLabel: "Privacy",
  },
];

export function routeById(id: string): RouteDefinition {
  return routeManifest.find((candidate) => candidate.id === id)!;
}

/** Products first, then reference material. Order here is the header order. */
const primaryNavigationOrder = ["marketplace", "tokens", "explorer", "get", "messages", "learn", "developers"] as const;

export const primaryNavigation = primaryNavigationOrder.map((id) => routeById(id));
export const footerNavigation = routeManifest.filter((route) => route.footerLabel !== undefined);
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
  { prefix: "/messages", routeId: "message-thread" as const },
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
