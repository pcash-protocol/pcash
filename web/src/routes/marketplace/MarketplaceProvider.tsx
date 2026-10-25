import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import type { StoredOffer } from "@pcash/marketplace/app";
import { useNetwork } from "../../components/NetworkContext.tsx";
import { marketplaceStoreName, openMarketplaceStore } from "../../lib/MarketplaceStore.ts";
import { networkInstanceKey } from "../../lib/networks.ts";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { useMarketplaceTodos } from "./todos.ts";
import { MarketplaceContext, useMarketplaceController } from "./useMarketplace.ts";
import styles from "./MarketplaceRoute.module.css";

/** How many of the signed-in owner's marketplace trades wait on them, for the navigation. */
const TodoCountContext = createContext(0);

export function useMarketplaceTodoCount(): number {
  return useContext(TodoCountContext);
}

function MarketplaceSession({ children }: { children: ReactNode }) {
  const market = useMarketplaceController();
  const elsewhere = !market.location.pathname.startsWith("/marketplace");
  const pending = market.tradePending || (market.pendingPublication && market.progress?.phase !== "done");
  return <MarketplaceContext.Provider value={market}>
    <TodoCountContext.Provider value={market.todos.length}>
      {children}
      {elsewhere && pending && <aside className={styles.floatingActivity} aria-label="Marketplace progress">
        <span role="status">{market.actionErrorFor(() => true) !== undefined ? "Your trade needs attention" : "Your trade is in progress"}</span>
        <Link to="/marketplace">View trade →</Link>
      </aside>}
    </TodoCountContext.Provider>
  </MarketplaceContext.Provider>;
}

/** Before the first marketplace visit, the count comes from the trades this browser saved, read once per owner. */
function SavedTodoCount({ children }: { children: ReactNode }) {
  const { profile } = useWallet();
  const { network } = useNetwork();
  const scope = networkInstanceKey(network);
  const [offers, setOffers] = useState<StoredOffer[]>([]);
  useEffect(() => {
    if (profile === undefined) return;
    let cancelled = false;
    void openMarketplaceStore(marketplaceStoreName(scope)).then(async (store) => {
      try {
        const listed = await store.list();
        if (!cancelled) setOffers(listed);
      } finally { store.close(); }
    })
      // The marketplace page reports an unavailable store.
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [scope, profile?.address]);
  const count = useMarketplaceTodos(profile?.address, offers).length;
  return <TodoCountContext.Provider value={count}>{children}</TodoCountContext.Provider>;
}

/** Mount on the first marketplace visit, then keep authorized work alive across routes. */
export function MarketplaceProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { network } = useNetwork();
  const visiting = location.pathname.startsWith("/marketplace");
  const [visited, setVisited] = useState(visiting);
  useEffect(() => { if (visiting) setVisited(true); }, [visiting]);
  if (!visited && !visiting) return <SavedTodoCount>{children}</SavedTodoCount>;
  return <MarketplaceSession key={networkInstanceKey(network)}>
    {children}
  </MarketplaceSession>;
}
