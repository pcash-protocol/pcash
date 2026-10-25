import { Link } from "react-router-dom";
import { START_WALLET } from "../../lib/useConnectWallet.ts";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { Metadata } from "../Metadata.tsx";
import { routeById } from "../routeManifest.ts";
import styles from "./HomeRoute.module.css";

const get = routeById("get");
const learn = routeById("learn");
const developers = routeById("developers");
const whitepaper = routeById("whitepaper");
const security = routeById("security");
const spec = routeById("spec");

const points = [
  { numeral: 1, width: 127, title: "Private payments", body: "Sender, recipient, amount and balance stay private, for PCASH and for any asset issued on it." },
  { numeral: 2, width: 173, title: "Rules Ethereum can drive", body: "Anyone can write the private rules a PCASH account spends by, and rules can act on Ethereum. Ethereum contracts can move PCASH, so it trades for ETH with no custodian." },
  { numeral: 3, width: 170, title: "Proof without disclosure", body: "A payment can prove where its funds came from, so a business can check it without learning who paid." },
] as const;

export function HomeRoute() {
  const { phase } = useWallet();
  // Get PCASH starts connect or sign-in on arrival for a visitor who has not signed in, once a saved connection resolves.
  const startWallet = phase === "initializing" || phase === "connecting" || phase === "disconnected" || phase === "sign-in-required";
  const actions = <div className={styles.actions}>
    <Link className="button primary" to={get.path} state={startWallet ? START_WALLET : undefined}>Mine PCASH</Link>
    <Link className="button" to={learn.path}>How it works</Link>
    <Link className="button" to={developers.path}>Build on PCASH</Link>
  </div>;
  return <>
    <Metadata {...routeById("home").metadata} />
    <section className={styles.hero}>
      <div className={styles.art} aria-hidden="true">
        <img className={styles.lines} src="/brand/linework.webp" alt="" width={1536} height={1024} />
        <div className={styles.sealFrame}><img className={styles.seal} src="/brand/seal.webp" srcSet="/brand/seal-1400.webp 1400w, /brand/seal.webp 2400w" sizes="(max-width: 1000px) min(118vw, 860px), min(96vh, 62vw)" alt="" width={2400} height={2364} /></div>
      </div>
      <div className={styles.copy}>
        <h1>Private money Ethereum can program.</h1>
        <p>Hold and send it without publishing your balance or who you pay. Ethereum contracts can move it, so ETH buys PCASH in one transaction with no custodian.</p>
        {actions}
        <p className={styles.documents}><Link to={whitepaper.path}>White paper</Link><span aria-hidden="true"> · </span><Link to={security.path}>Security</Link><span aria-hidden="true"> · </span><Link to={spec.path}>Protocol specification</Link></p>
      </div>
    </section>
    <section className={styles.points} aria-label="What PCASH is">
      <div className={styles.grid}>
        {points.map((point) => <article key={point.numeral}>
          <img className={styles.numeral} src={`/brand/numeral-${point.numeral}.webp`} alt={String(point.numeral)} width={point.width} height={200} loading="lazy" />
          <h2>{point.title}</h2>
          <p>{point.body}</p>
        </article>)}
      </div>
      {actions}
    </section>
  </>;
}
