import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseDirectSendLink } from "@pcash/sdk/delivery";
import { directSendOutputKey, type DirectSendOpening } from "@pcash/sdk/protocol";
import { addressHex } from "@pcash/sdk/utils";
import { inspectDirectSend, type DirectSendFunding, type WalletReceivedDirectSend } from "@pcash/sdk/wallet";
import { EthereumAddress } from "../../components/EthereumAddress.tsx";
import { Notice } from "../../components/Notice.tsx";
import { PcashAmount } from "../../components/PcashAmount.tsx";
import { formatPcashAmount } from "../../components/pcashAmount.ts";
import { RouteHeader } from "../../components/RouteHeader.tsx";
import { querySession } from "../../lib/querySession.ts";
import { errorMessage, useWallet } from "../../lib/WalletProvider.tsx";
import { Metadata } from "../Metadata.tsx";
import { routeById } from "../routeManifest.ts";
import paper from "../PaperPage.module.css";
import { WalletPromptButton } from "../tokens/TokenCommon.tsx";
import { usePageFragment } from "../tokens/usePageFragment.ts";
import { AccountSetupPanel } from "../wallet/AccountSetupPanel.tsx";
import { shortValue } from "../wallet/model.ts";
import styles from "./ReceivePage.module.css";

const route = routeById("receive");

function openingOf(fragment: string | undefined): DirectSendOpening | undefined | null {
  if (fragment === undefined) return undefined;
  try { return parseDirectSendLink(fragment); } catch { return null; }
}

/**
 * A direct send's link: the payment's opening rides in the fragment, which no
 * server sees. Only the wallet of the address it pays can receive it, with no
 * claim step: once that address has set up PCASH, the full amount is its balance.
 */
export default function ReceivePage() {
  const fragment = usePageFragment();
  const opening = useMemo(() => openingOf(fragment), [fragment]);
  const { node, status } = useWallet();
  const otherNetwork = opening != null && status !== undefined && opening.chainId !== BigInt(status.pcashChainId);
  const funding = useQuery({
    queryKey: ["direct-send-funding", querySession(node), fragment],
    queryFn: () => inspectDirectSend(node, opening!),
    enabled: opening != null && !otherNetwork,
    // A rejected inclusion can still be followed by an accepted one.
    refetchInterval: (query) => query.state.data?.status === "pending" || query.state.data?.status === "rejected" ? 15_000 : false,
    retry: false,
  });
  const landed = funding.data?.status === "landed" ? funding.data : undefined;
  return <section className={`${paper.page} ${styles.stack}`}>
    <Metadata {...route.metadata} />
    <RouteHeader eyebrow="Payment link" title={opening == null ? "Receive PCASH" : `Receive ${formatPcashAmount(opening.amount)}`}
      description="Someone sent PCASH to your Ethereum address. Set up PCASH with that address's wallet to receive it." />
    {opening === undefined ? <Notice>Open the full link you were sent. The part after “#” holds the payment.</Notice>
      : opening === null ? <Notice tone="error">This isn't a valid PCASH payment link. Ask the sender to copy it again.</Notice>
      : otherNetwork ? <Notice tone="error">This link is for a different PCASH network.</Notice>
      : <div className={styles.columns}>
        <section className="panel" aria-labelledby="receive-payment">
          <h2 id="receive-payment">Payment</h2>
          <p className={styles.amount} data-testid="receive-amount"><PcashAmount value={opening.amount} /></p>
          {landed?.memo !== undefined && <blockquote className={styles.memo} data-testid="receive-memo">{landed.memo}</blockquote>}
          <p className={styles.hint}>To <EthereumAddress address={addressHex(opening.owner)} /></p>
          {/* Any payer can name any address, so a claimed sender stays a raw address. */}
          {landed?.sender !== undefined && <p className={styles.hint}>From <code title={landed.sender}>{shortValue(landed.sender, 8, 6)}</code> (unverified)</p>}
          {funding.data?.status === "pending" && <p className={styles.hint} role="status">This payment hasn't landed on PCASH yet. It can take a few minutes.</p>}
          {funding.data?.status === "rejected" && <Notice tone="error">This payment didn't go through. Ask the sender to send it again.</Notice>}
          {funding.data?.status === "invalid" && <Notice tone="error">This link doesn't match the payment it names. Ask the sender to copy it again.</Notice>}
          {funding.error !== null && <Notice tone="error">{errorMessage(funding.error)}</Notice>}
        </section>
        <section className="panel" aria-labelledby="receive-action">
          <h2 id="receive-action">Receive</h2>
          <ReceiveWithWallet opening={opening} link={fragment!} funding={funding.data?.status} />
        </section>
      </div>}
  </section>;
}

function ReceiveWithWallet({ opening, link, funding }: { opening: DirectSendOpening; link: string; funding: DirectSendFunding["status"] | undefined }) {
  const { wallet, phase, connectedAccount, connectionStep, accountRecord, snapshot } = useWallet();
  const owner = addressHex(opening.owner);
  const matches = connectedAccount?.toLowerCase() === owner;
  const head = snapshot?.syncedThrough?.pcashHash;
  const [received, setReceived] = useState<{ link: string; value?: WalletReceivedDirectSend; error?: string }>();
  useEffect(() => {
    // The wallet imports a link only once its payment has landed.
    if (wallet === undefined || !matches || funding !== "landed") return;
    let current = true;
    const key = directSendOutputKey(opening);
    // Importing keeps the opening and synchronizes; later reads follow the wallet's own syncs.
    const read = received?.link === link && received.value !== undefined
      ? wallet.receivedDirectSends().then((list) => list.find((candidate) => directSendOutputKey(candidate.opening) === key))
      : wallet.importDirectSend(link);
    void read.then(
      (value) => { if (current) setReceived({ link, ...(value === undefined ? {} : { value }) }); },
      (cause) => { if (current) setReceived({ link, error: errorMessage(cause) }); },
    );
    return () => { current = false; };
  }, [wallet, matches, link, head, funding]);

  if (phase === "disconnected" || connectedAccount === undefined) {
    return <div className={styles.status}><p>Connect the wallet for <EthereumAddress address={owner} /> to receive this payment.</p><WalletPromptButton /></div>;
  }
  if (!matches) {
    return <p className={styles.status} role="status">This payment is for <EthereumAddress address={owner} />. Switch to that account in your wallet.</p>;
  }
  if (wallet === undefined) {
    const working = phase === "initializing" || phase === "connecting" || phase === "signing-in" || phase === "opening";
    return <div className={styles.status}><p role="status">{working ? connectionStep ?? "Opening your wallet…" : "Sign in to your wallet to receive this payment."}</p>{!working && <WalletPromptButton />}</div>;
  }
  const keepLink = <Notice>Keep this link until your wallet saves the payment, when you set up or else the first time you spend it. Until then the link is its only copy.</Notice>;
  if (funding === "pending") return <>{keepLink}<p className={styles.status} role="status">Waiting for the payment to land on PCASH…</p></>;
  if (funding !== "landed") return null;
  const current = received?.link === link ? received : undefined;
  if (current?.error !== undefined) return <Notice tone="error">{current.error}</Notice>;
  const state = current?.value;
  if (state === undefined) return <p className={styles.status} role="status">Adding this payment to your wallet…</p>;
  const keep = !state.saved && keepLink;
  if (state.state === "waiting") return <>{keep}<p className={styles.status} role="status">Waiting for the payment to land on PCASH…</p></>;
  if (accountRecord !== "present") {
    return <div className={styles.status}>
      <p className={styles.receiving} data-testid="receive-state" data-state="receiving">Receiving <PcashAmount value={opening.amount} /></p>
      <p className={styles.hint}>Set up PCASH to receive it. There is no claim step: once setup lands, the full amount is in your balance.</p>
      {keep}
      <AccountSetupPanel />
    </div>;
  }
  return <div className={styles.status}>
    <Notice tone="success"><span data-testid="receive-state" data-state={state.state}>{state.state === "spent"
      ? "You received this payment and have since spent it."
      : <>Received. <PcashAmount value={opening.amount} /> is in your balance.</>}</span></Notice>
    {keep}
  </div>;
}
