import { useEffect, useState } from "react";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { fetchCatalogOffers, fetchOpenOffers, type OfferPublication } from "@pcash/marketplace/app";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { isNativeListing } from "../marketplace/listingAsset.ts";
import { compareValue, unitPriceWei } from "../marketplace/listingPrice.ts";

export const BEST_LISTING_REFRESH_MS = 300_000;

export interface BestListing {
  weiPerThousand: bigint;
  approximate: boolean;
}

/** The cheapest open PCASH listing per unit among `open` publications. */
export function bestPcashListing(open: readonly OfferPublication[]): BestListing | undefined {
  const best = open.filter(isNativeListing).reduce<OfferPublication | undefined>((current, offer) => current === undefined || compareValue(offer, current) < 0 ? offer : current, undefined);
  if (best === undefined) return undefined;
  const price = unitPriceWei(best);
  return { weiPerThousand: price.wei * 1_000n, approximate: price.approximate };
}

/** Open listings exactly as the marketplace resolves them. */
export async function readBestListing(node: PcashNodeClient): Promise<BestListing | undefined> {
  return bestPcashListing(await fetchOpenOffers(node, await fetchCatalogOffers(node)));
}

/** The best open listing on this network, or undefined while unknown or when there is none. */
export function useBestListing(): BestListing | undefined {
  const { node, status } = useWallet();
  const identity = status === undefined ? undefined : `${status.pcashChainId}:${status.genesisHash}`;
  const [value, setValue] = useState<{ identity: string; node: typeof node; listing: BestListing | undefined }>();
  useEffect(() => {
    if (identity === undefined) return;
    let cancelled = false;
    const read = async () => {
      try {
        const listing = await readBestListing(node);
        if (!cancelled) setValue({ identity, node, listing });
      } catch {
        // An unreadable catalog keeps the last reading; with none, no marketplace row shows.
      }
    };
    void read();
    const timer = setInterval(() => void read(), BEST_LISTING_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [node, identity]);
  return value !== undefined && value.identity === identity && value.node === node ? value.listing : undefined;
}
