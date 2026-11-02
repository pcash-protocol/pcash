import { useEffect, useState } from "react";
import { formatDirectSendLink } from "@pcash/sdk/delivery";
import type { DirectSendOpening } from "@pcash/sdk/protocol";
import type { Wallet, WalletDirectSend } from "@pcash/sdk/wallet";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { routeById } from "../routeManifest.ts";

/** The receive page link that delivers a direct send's opening in its fragment. */
export function directSendUrl(opening: DirectSendOpening): string {
  return formatDirectSendLink(opening, `${globalThis.location?.origin ?? ""}${routeById("receive").path}`);
}

/** The link of the direct send a payment made, rebuilt from the wallet's journal or its recovered sender regions. */
export async function directSendLinkOf(wallet: Pick<Wallet, "directSends">, contentHash: string): Promise<string> {
  const send = (await wallet.directSends()).find((candidate) => candidate.opening.contentHash === contentHash.toLowerCase());
  if (send === undefined) throw new Error("This payment's link is not available yet.");
  return directSendUrl(send.opening);
}

/** Direct sends this wallet paid, by funding content hash, read again on every sync. */
export function useDirectSends(): ReadonlyMap<string, WalletDirectSend> {
  const { wallet, snapshot } = useWallet();
  const head = snapshot?.syncedThrough?.pcashHash;
  const pending = (snapshot?.pendingContentHashes ?? []).join(",");
  const [sends, setSends] = useState<ReadonlyMap<string, WalletDirectSend>>(new Map());
  useEffect(() => {
    if (wallet === undefined) { setSends(new Map()); return; }
    let current = true;
    void wallet.directSends().then(
      (list) => { if (current) setSends(new Map(list.map((send) => [send.opening.contentHash, send]))); },
      // Activity still shows the payment; its link waits for the next read.
      () => undefined,
    );
    return () => { current = false; };
  }, [wallet, head, pending]);
  return sends;
}
