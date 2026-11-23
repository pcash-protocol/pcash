import { isTryPath } from "../routes/try/paths.ts";

/** URL fragments the wallet sidebar uses for its own panels. */
export const WALLET_PANEL_HASHES: readonly string[] = ["#wallet", "#send", "#ethereum-submission"];

const WALLET_SURFACES = ["/marketplace", "/get", "/tokens", "/token", "/claim", "/drop", "/account"] as const;

/** Public browsing prompts no network switch until the visitor opens a wallet flow. */
export function onWalletSurface(pathname: string, hash = ""): boolean {
  return WALLET_PANEL_HASHES.includes(hash)
    || WALLET_SURFACES.some((surface) => pathname === surface || pathname.startsWith(`${surface}/`));
}

/** Resume setup in the sidebar without leaving the page or losing a payment intent. Try PCASH and the account page set the account up on the page itself. */
export function onboardingDestination(location: { pathname: string; search: string; hash: string }): string {
  const inPage = isTryPath(location.pathname) || location.pathname === "/account";
  const hash = location.hash === "#send" || location.hash === "#ethereum-submission" || inPage ? location.hash : "#wallet";
  return `${location.pathname}${location.search}${hash}`;
}
