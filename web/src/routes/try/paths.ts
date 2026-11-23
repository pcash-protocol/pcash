/** Try PCASH's tabs in order. Token, drop and thread pages belong to their tab. */
export const TRY_TABS = [
  { id: "pay", label: "Pay", path: "/get", nested: [] },
  { id: "earn", label: "Earn", path: "/get/earn", nested: [] },
  { id: "tokens", label: "Tokens", path: "/tokens", nested: ["/tokens/", "/token/", "/drop/"] },
  { id: "board", label: "Anonymous board", path: "/board", nested: ["/board/"] },
] as const;

export type TryTab = (typeof TRY_TABS)[number];

export function tryTabFor(pathname: string): TryTab | undefined {
  const path = pathname === "/" ? pathname : pathname.replace(/\/+$/, "");
  return TRY_TABS.find((tab) => path === tab.path || tab.nested.some((prefix) => path.startsWith(prefix)));
}

/** Whether a page sits under Try PCASH, where account setup is shown at the top of the page. */
export function isTryPath(pathname: string): boolean {
  return tryTabFor(pathname) !== undefined;
}
