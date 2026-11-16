import { Notice } from "../../components/Notice.tsx";
import { NotFound } from "../NotFound.tsx";
import { Metadata } from "../Metadata.tsx";
import { routeById } from "../routeManifest.ts";
import { useMarketplace } from "./useMarketplace.ts";
import { CheckoutPanel } from "./CheckoutPanel.tsx";
import { MarketplaceListings } from "./MarketplaceListings.tsx";
import { TradePanel } from "./TradePanel.tsx";
import styles from "./MarketplaceRoute.module.css";

const marketplaceRoute = routeById("marketplace");

export default function MarketplaceRoute() {
  const market = useMarketplace();
  const { location } = market;
  if (!["/marketplace", "/marketplace/"].includes(location.pathname)) return <NotFound />;
  return (
    <section
      className={styles.marketplace}
      aria-label="Marketplace"
    >
      <Metadata {...marketplaceRoute.metadata} />
      <header className={styles.hero}>
        <div className={styles.heroArt} aria-hidden="true">
          <img className={styles.heroLines} src="/brand/linework.webp" alt="" width={1536} height={1024} />
          <div className={styles.heroSeal}><img src="/brand/seal-1400.webp" alt="" width={1400} height={1379} /></div>
        </div>
        <div className={styles.heroCopy}><p className="eyebrow">PCASH for ETH</p>
          <h1>Private money.<br />An open market.</h1>
          <p>Find your PCASH. Set your price. Trade directly.</p>
        </div>
      </header>

      {market.configurationError && (
        <Notice>
          {market.configurationError}
          {market.configuration && (
            <>
              {" "}
              <button onClick={market.retryVerification}>Retry router connection</button>
            </>
          )}
        </Notice>
      )}
      {market.error && <Notice tone="error">{market.error}</Notice>}

      {market.offerAddress !== undefined && <TradePanel><CheckoutPanel market={market} /></TradePanel>}
      <MarketplaceListings market={market} />
    </section>
  );
}
