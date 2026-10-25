import { useRef } from "react";
import { useLocation } from "react-router-dom";
import { WALLET_PANEL_HASHES } from "../../lib/walletSurface.ts";

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
  return saved.current.fragment;
}
