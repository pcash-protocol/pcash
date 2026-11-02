/** URL fragments the wallet sidebar uses for its own panels. */
export const WALLET_PANEL_HASHES: readonly string[] = ["#wallet", "#send", "#ethereum-submission"];

const WALLET_SURFACES = ["/marketplace", "/get", "/tokens", "/token", "/claim", "/drop"] as const;

/** Public browsing prompts no network switch until the visitor opens a wallet flow. */
export function onWalletSurface(pathname: string, hash = ""): boolean {
  return WALLET_PANEL_HASHES.includes(hash)
    || WALLET_SURFACES.some((surface) => pathname === surface || pathname.startsWith(`${surface}/`));
}

/** Resume setup in the sidebar without leaving the page or losing a payment intent. */
export function onboardingDestination(location: { pathname: string; search: string; hash: string }): string {
  const hash = location.hash === "#send" || location.hash === "#ethereum-submission" ? location.hash : "#wallet";
  return `${location.pathname}${location.search}${hash}`;
}
