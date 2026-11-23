import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useNetwork } from "../../components/NetworkContext.tsx";
import { Metadata } from "../Metadata.tsx";
import { MAC_WALLET_DOWNLOAD_URL, MAC_WALLET_SETUP_PATH } from "../docs/publicDocuments.ts";
import { routeById } from "../routeManifest.ts";
import styles from "./HomeRoute.module.css";

const get = routeById("get");
const whitepaper = routeById("whitepaper");
const security = routeById("security");
const spec = routeById("spec");
const buildingGuide = routeById("guide-building");
const merchantGuide = routeById("guide-merchant");
const privateDollarsGuide = routeById("guide-private-dollars");
const paper = (id: string) => `${whitepaper.path}#${id}`;

/** The two claims under the headline, each with its comparison. Each id is a link target. */
const claims: readonly { id: string; title: string; body: string; to: string; source: string }[] = [
  {
    id: "always-private",
    title: "Always private",
    body: "Cryptocurrencies like ZEC and ETH make privacy optional. Most people hold them in public because it’s easier, which adds nothing to anyone’s privacy. There’s no public PCASH, so it gets more private as more people hold it.",
    to: paper("private-only"), source: "White paper: Private only",
  },
  {
    id: "as-secure-as-ethereum",
    title: "As secure as Ethereum",
    body: "PCASH runs on Ethereum with no bridge or sequencer, so there’s no one to trust but Ethereum. Unlike shielded pools on Ethereum, PCASH evolves through social consensus, without admin keys. Unlike Bitcoin and Zcash, it has no security budget to fund, so its supply stays fixed: one billion PCASH.",
    to: paper("built-on-ethereum"), source: "White paper: Built on Ethereum",
  },
];

interface Point { title: string; body: string; to: string; label: string }
const points: readonly Point[] = [
  { title: "Private smart contracts", body: "A PCASH contract holds money under a rule anyone can write and no one can change: escrow, vesting, a treasury that needs two of three keys. The rule that approved a payment stays private.", to: buildingGuide.path, label: "What you can build" },
  { title: "Ethereum apps can move it", body: "An auction, a vote or a deposit contract on Ethereum can decide when PCASH is released, with no bridge. That’s how PCASH sells for ETH in one Ethereum transaction, with no custodian.", to: paper("rules-each-account-chooses"), label: "How Ethereum moves PCASH" },
  { title: "Issue your own asset", body: "Anyone can issue a private asset on PCASH, such as a dollar backed by USDC, and it moves with the same privacy. A deposit to the issuer’s vault on Ethereum mints dollars to a recipient Ethereum can’t see, and the issuer pays out USDC when they’re redeemed.", to: privateDollarsGuide.path, label: "How a private dollar works" },
];

/** A short answer shown in full, the rest expanding in place, then the source that goes further. Each id is a link target that opens it. */
interface Question { id: string; question: string; answer: string; more: string; to: string; source: string; download?: { href: string; label: string } }
const questions: readonly Question[] = [
  {
    id: "payments",
    question: "How does a payment work?",
    answer: "Pay any Ethereum address, or send a link anyone can claim. Your device makes the proof, and the recipient needs nothing to receive it.",
    more: "Your wallet publishes the payment to Ethereum, directly or through a relayer, and the recipient’s wallet finds it on their own device. They need an account only to spend, and creating one takes one Ethereum transaction. On a new device, their keys alone recover every payment.",
    to: paper("private-delivery"), source: "White paper: Private delivery",
  },
  {
    id: "technology",
    question: "What’s the technology?",
    answer: "One zero-knowledge proof per transaction, published to Ethereum. The proofs use CHONK, the proof system of Aztec’s Barretenberg.",
    more: "Every PCASH node computes the same ledger from Ethereum’s history and checks each proof without learning who paid, who was paid, how much, or which asset. Payments name no recipient: each wallet finds its own by trial decryption, trying new payments with its key.",
    to: paper("one-proof-per-transaction"), source: "White paper: One proof per transaction",
  },
  {
    id: "post-quantum",
    question: "Is it post-quantum?",
    answer: "Its encryption is. Receive keys are ML-KEM-768, so payments encrypted to them stay unreadable even to a quantum computer. As on nearly every chain, its proofs and signatures are not.",
    more: "Most privacy protocols encrypt payments with elliptic curves, which a quantum computer can break. This website derives its keys from a signature by your Ethereum wallet, so a quantum computer that broke that key could read your payments. PCASH Wallet for Mac keeps its keys separate.",
    to: paper("what-about-quantum-computers"), source: "White paper: What about quantum computers?",
  },
  {
    id: "most-private",
    question: "What’s the most private way to use PCASH?",
    answer: "PCASH Wallet for Mac. Its keys come from its own recovery phrase, not your Ethereum wallet, so its encryption stays post-quantum, and it reaches the network through Tor.",
    download: { href: MAC_WALLET_DOWNLOAD_URL, label: "Download PCASH Wallet for Mac" },
    more: "It runs in the terminal on Apple Silicon Macs, on the testnet, and makes every proof on your Mac. This website is the quick way in: it signs in with your Ethereum wallet and derives its keys from that signature.",
    to: MAC_WALLET_SETUP_PATH, source: "Setup instructions",
  },
  {
    id: "new-coin",
    question: "Why a new coin instead of ETH?",
    answer: "Private ETH has to sit in a shielded pool, an app on Ethereum that needs an admin key to change. And ETH can be held in public, so most of it is. PCASH has no admin keys and no public form.",
    more: "Every deposit into a pool and every withdrawal from it is public, and ETH held outside one adds nothing to anyone’s privacy. PCASH’s rules change only when people choose to run new software, as Ethereum’s do.",
    to: paper("private-only"), source: "White paper: Private only",
  },
  {
    id: "get-pcash",
    question: "How do I get PCASH?",
    answer: "Earn new PCASH by publishing transactions to Ethereum, or buy it for ETH from anyone selling. There was no premine, team allocation or sale.",
    more: "Each transaction published earns an equal share of its block’s new PCASH, whether it carries someone’s payment or is empty. Empty ones, mining, look like payments, so they’re cover for real ones. All of it is issued in about a year.",
    to: get.path, source: "Try PCASH",
  },
  {
    id: "buying-and-selling",
    question: "How do I buy or sell PCASH for ETH?",
    answer: "In the Marketplace, in one Ethereum transaction with no custodian. Getting ZEC for ETH means trusting an exchange, a solver network or a bridge.",
    more: "A seller locks PCASH in a PCASH escrow contract, and the buyer’s single Ethereum transaction pays the seller in ETH and claims the PCASH. Since anyone can prove PCASH’s state to Ethereum, other markets, bids included, can be built too. There is no withdrawal and no bridge.",
    to: paper("trading-pcash-for-eth"), source: "White paper: Trading PCASH for ETH",
  },
  {
    id: "receipts",
    question: "Can I prove I paid someone?",
    answer: "Yes. Share that payment’s receipt, and it reveals nothing else you’ve done.",
    more: "Every payment output has its own disclosure key. Anyone you give it to can check the payment’s recipient, asset, amount and memo against the chain.",
    to: `${merchantGuide.path}#receipts`, source: "Merchant payments: Receipts",
  },
];

export function HomeRoute() {
  const { network } = useNetwork();
  const { hash } = useLocation();
  // A link to a question opens the rest of its answer, if it has more. The prerendered page has no hash, so it opens after the
  // page renders, and web fonts can move the question after the browser's first jump to the anchor, so it scrolls again once they load.
  useEffect(() => {
    const target = hash.length > 1 ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    if (!target?.hasAttribute("data-question")) return;
    const rest = target.querySelector("details");
    if (rest) rest.open = true;
    void document.fonts?.ready.then(() => target.scrollIntoView());
  }, [hash]);
  const actions = <div className={styles.actions}>
    <Link className="button primary" to={get.path}>{network.l1ChainId === 1 ? "Get PCASH" : "Try the testnet"}</Link>
    <Link className="button" to={whitepaper.path}>How it works</Link>
    <Link className="button" to={buildingGuide.path}>Build on PCASH</Link>
  </div>;
  return <>
    <Metadata {...routeById("home").metadata} />
    <section className={styles.hero}>
      <div className={styles.art} aria-hidden="true">
        <img className={styles.lines} src="/brand/linework.webp" alt="" width={1536} height={1024} />
        <div className={styles.sealFrame}><img className={styles.seal} src="/brand/seal.webp" srcSet="/brand/seal-1400.webp 1400w, /brand/seal.webp 2400w" sizes="(max-width: 1000px) min(118vw, 860px), min(96vh, 62vw)" alt="" width={2400} height={2364} /></div>
      </div>
      <div className={styles.copy}>
        <h1>PCASH is a better Zcash.</h1>
        <p className={styles.tagline}>Always private.<br />As secure as Ethereum.</p>
        {actions}
        <p className={styles.documents}><Link to={whitepaper.path}>White paper</Link><span aria-hidden="true"> · </span><Link to={security.path}>Security</Link><span aria-hidden="true"> · </span><Link to={spec.path}>Protocol specification</Link></p>
      </div>
    </section>
    <section className={styles.claims} aria-label="Always private, as secure as Ethereum">
      <div className={styles.claimGrid}>
        {claims.map((item) => <div key={item.id} id={item.id} data-question="">
          <h2>{item.title}</h2>
          <p>{item.body}</p>
          <Link className={styles.more} to={item.to}>{item.source}</Link>
        </div>)}
      </div>
    </section>
    <section className={styles.points} aria-labelledby="beyond-heading">
      <div className={styles.inner}>
        <h2 id="beyond-heading" className={styles.sectionHeading}>Beyond private payments</h2>
        <ul className={styles.reasons}>
          {points.map((point) => <li key={point.title}>
            <h3>{point.title}</h3>
            <p>{point.body}</p>
            <Link className={styles.more} to={point.to}>{point.label}</Link>
          </li>)}
        </ul>
      </div>
    </section>
    <section className={styles.questions} aria-labelledby="questions-heading">
      <div className={styles.inner}>
        <h2 id="questions-heading" className={styles.sectionHeading}>Questions?</h2>
        <div className={styles.answers}>
          {questions.map((item) => <div key={item.id} id={item.id} data-question="">
            <h3>{item.question}</h3>
            <p>{item.answer}</p>
            {item.download && <a className={styles.download} href={item.download.href}>{item.download.label}</a>}
            <details>
              <summary>Read more</summary>
              <p>{item.more}</p>
              <Link className={styles.more} to={item.to}>{item.source}</Link>
            </details>
          </div>)}
        </div>
      </div>
    </section>
    <section className={styles.film} aria-label="The PCASH film">
      <video className={styles.video} src="/film/pcash.mp4" poster="/film/poster.webp" width={1920} height={1080} controls preload="none" playsInline />
      {actions}
    </section>
  </>;
}
