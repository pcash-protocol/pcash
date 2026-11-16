import { useEffect, useRef, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import styles from "./MarketplaceRoute.module.css";

/** The listing a link opened. A route-backed panel leaves wallet dialogs free to own modal focus. */
export function TradePanel({ children }: { children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const search = new URLSearchParams(location.search);
  search.delete("offer");
  search.delete("publication");
  const close = () => navigate({ pathname: location.pathname, search: search.toString() }, { replace: true, preventScrollReset: true });
  useEffect(() => {
    panel.current?.focus();
  }, [location.pathname, location.search]);
  return (
    <div
      className={styles.tradePanel}
      ref={panel}
      tabIndex={-1}
      role="region"
      aria-label="Trade PCASH"
      onKeyDown={(event) => {
        // Wallet portals bubble through React; only handle keys from this panel's DOM.
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          panel.current?.contains(event.target as Node)
        ) {
          event.preventDefault();
          close();
        }
      }}
    >
      <button
        className={styles.closePanel}
        aria-label="Close trade"
        onClick={close}
      >
        Close
      </button>
      {children}
    </div>
  );
}
