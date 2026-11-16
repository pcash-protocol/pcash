import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { WALLET_PANEL_HASHES } from "../../lib/walletSurface.ts";

/** Each mounted page's own fragment, by path and query, for the wallet picker while the wallet panel holds the address bar's. */
const pageFragments = new Map<string, string>();

/** The fragment the page at `page` (path and query) holds, if it reads one. */
export function heldPageFragment(page: string): string | undefined {
  return pageFragments.get(page);
}

/**
 * The fragment this page was opened with, such as a claim link or a shared
 * definition. Connecting a wallet borrows the fragment for the sidebar and
 * closing it clears the fragment, so the page keeps its own.
 */
export function usePageFragment(): string | undefined {
  const { pathname, search, hash } = useLocation();
  const page = pathname + search;
  const own = hash.length > 1 && !WALLET_PANEL_HASHES.includes(hash) ? hash : undefined;
  const saved = useRef({ page, fragment: own, borrowed: false });
  if (saved.current.page !== page) saved.current = { page, fragment: own, borrowed: false };
  else if (own !== undefined) saved.current = { page, fragment: own, borrowed: false };
  else if (WALLET_PANEL_HASHES.includes(hash)) saved.current.borrowed = true;
  else if (!saved.current.borrowed) saved.current.fragment = undefined;
  const fragment = saved.current.fragment;
  useEffect(() => {
    if (fragment === undefined) return;
    pageFragments.set(page, fragment);
    return () => { if (pageFragments.get(page) === fragment) pageFragments.delete(page); };
  }, [page, fragment]);
  return fragment;
}
