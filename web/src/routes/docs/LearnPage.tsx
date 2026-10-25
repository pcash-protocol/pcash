import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Metadata } from "../Metadata.tsx";
import { routeById } from "../routeManifest.ts";
import { bundlePath, evaluateBundle } from "./bundles.ts";
import { CopyBundleForLlm, CopyForLlm } from "./DocumentTools.tsx";
import { specSource, whitepaperSource } from "./sources.ts";
import styles from "./LearnPage.module.css";

const learnRoute = routeById("learn");
const whitepaperRoute = routeById("whitepaper");
const specRoute = routeById("spec");
const securityRoute = routeById("security");
const developersRoute = routeById("developers");
const marketplaceRoute = routeById("marketplace");
const buildingGuide = routeById("guide-building").path;

/** A white paper section, by its heading anchor. Every Learn claim points to the section it rests on. */
export const whitepaperSections = {
  privacy: ["what-is-public", "What is public"],
  privateOnly: ["private-only", "Private only"],
  issuance: ["what-you-pay-with", "What you pay with"],
  derivation: ["built-on-ethereum", "Built on Ethereum"],
  conditions: ["trading-pcash-for-eth", "Trading PCASH for ETH"],
  authorization: ["rules-each-account-chooses", "Rules each account chooses"],
  noRuleChanges: ["no-one-can-censor-or-change-it", "No one can censor or change it"],
  trust: ["what-you-trust", "What you trust"],
  security: ["what-if-a-key-is-lost-or-stolen", "What if a key is lost or stolen?"],
  proofs: ["proofs-that-travel-with-money", "Proofs that travel with money"],
} as const satisfies Record<string, readonly [string, string]>;

type PaperSection = keyof typeof whitepaperSections;

function PaperLink({ section }: { section: PaperSection }) {
  const [id, label] = whitepaperSections[section];
  return <Link className={styles.source} to={`${whitepaperRoute.path}#${id}`}>White paper: {label}</Link>;
}

interface Question {
  question: string;
  answer: string;
  section: PaperSection;
}

const questions = {
  visible: {
    question: "What can other people see?",
    answer: "That an account registered, that a transaction happened, its fee and timing, and which of the two transaction sizes it used. If you publish a transaction from your own Ethereum address, that address is linked to it. They cannot see the sender, recipient, amount or balance.",
    section: "privacy",
  },
  wrapped: {
    question: "Is PCASH ETH, or wrapped ETH?",
    answer: "No. PCASH is its own asset. It exists only inside PCASH, and no bridge redeems it for ETH. You do pay Ethereum gas, in ETH, to publish transactions.",
    section: "privateOnly",
  },
  getting: {
    question: "How do I get PCASH?",
    answer: "Mine it on the Get PCASH page, earn issuance and fees by relaying transactions, or buy it from a holder for ETH in the Marketplace. Mining and receiving PCASH need no account. Spending does, and creating one takes one Ethereum transaction.",
    section: "issuance",
  },
  contract: {
    question: "Why isn't PCASH a smart contract?",
    answer: "A privacy contract has to choose. An immutable one cannot fix a bug without moving everyone to a new contract, which breaks their privacy. An upgradeable one is only as safe as whoever controls upgrades. PCASH is defined by rules for reading Ethereum history instead, so each version is immutable, and a new version applies only if people choose to run it.",
    section: "noRuleChanges",
  },
  trust: {
    question: "What am I trusting?",
    answer: "Ethereum's consensus and history, the soundness of the zero-knowledge proof system, and the correctness of PCASH's circuits and software. When you buy PCASH with ETH, you also rely on an honest node to check the listing, which can be your own. Not a sequencer, an administrator, a bridge, or other users keeping their money in a pool. The latest security review and its report are on the Security page.",
    section: "trust",
  },
  keyLoss: {
    question: "What happens if I lose my Ethereum key?",
    answer: "Your Ethereum key is needed once, to create your account. After that, your account's own rules decide who can spend, and they can use other keys. What never changes is the secret your account needs to spend its notes, fixed when the account is created. No one can restore it, and losing it loses the PCASH. The wallet on this site derives that secret from your Ethereum key, so there is nothing extra to back up, and losing the key loses your PCASH.",
    section: "security",
  },
  withdraw: {
    question: "Can I turn PCASH back into ETH?",
    answer: "Only by selling it to someone for ETH, through a PCASH escrow contract. There is no withdrawal and no bridge.",
    section: "conditions",
  },
} satisfies Record<string, Question>;

function Idea({ numeral, width, title, children, section, asked = [] }: {
  numeral: number;
  width: number;
  title: string;
  children: ReactNode;
  section: PaperSection;
  /** Questions a reader of this idea is likely to ask, answered in place. */
  asked?: readonly Question[];
}) {
  return <section className={styles.idea}>
    <img className={styles.numeral} src={`/brand/numeral-${numeral}.webp`} alt={String(numeral)} width={width} height={200} />
    <div>
      <h2>{title}</h2>
      {children}
      {asked.length > 0 && <div className={styles.questions}>{asked.map((question) => <details key={question.question}>
        <summary>{question.question}</summary>
        <p>{question.answer}</p>
        {question.section !== section && <PaperLink section={question.section} />}
      </details>)}</div>}
      <PaperLink section={section} />
    </div>
  </section>;
}

export function LearnPage() {
  return <div className={styles.page}>
    <Metadata {...learnRoute.metadata} />
    <header className={styles.hero}>
      <p className={styles.kicker}>Learn</p>
      <h1>PCASH in six ideas</h1>
      <p className={styles.lead}>Private money Ethereum can program, in short. The white paper makes the full case, and the protocol specification has the exact rules.</p>
      <nav className={styles.documentLinks} aria-label="Documents">
        <Link className={styles.tool} to={whitepaperRoute.path}>White paper</Link>
        <Link className={styles.tool} to={specRoute.path}>Protocol specification</Link>
      </nav>
    </header>

    <Idea numeral={1} width={127} title="Private payments, in PCASH or your own asset" section="privateOnly" asked={[questions.visible, questions.wrapped]}>
      <p>When you pay, the sender, the recipient, the amount and the asset stay private, and so does every balance. Each payment carries a zero-knowledge proof: the network checks that it is valid without learning any of those details.</p>
      <p>There is no public PCASH, nothing to deposit and nothing to withdraw, and a PCASH account holding nothing looks the same as one holding a lot. Anyone can create another asset, such as a private dollar or a token, and it moves with the same privacy.</p>
    </Idea>

    <Idea numeral={2} width={173} title="You choose the rules for your money" section="authorization" asked={[questions.keyLoss]}>
      <p>Every PCASH account sets its own spending rules: a signature, a passkey, two of three keys, a recovery key held by a friend, or any rule anyone writes, with no one's permission. The rule that approved a payment stays private.</p>
      <p>PCASH contracts are accounts whose rules can never change, which makes escrow, vesting and shared treasuries trustworthy.</p>
    </Idea>

    <Idea numeral={3} width={170} title="Ethereum apps can move private money" section="conditions" asked={[questions.withdraw]}>
      <p>Rules can act on what happens on Ethereum, and Ethereum contracts can move PCASH. The <Link to={marketplaceRoute.path}>Marketplace</Link> on this site works this way: a seller locks PCASH in a PCASH escrow contract, and the buyer's single Ethereum transaction pays the seller in ETH and claims the PCASH. If no one buys before the deadline, the seller takes the PCASH back. No operator holds either side's funds.</p>
    </Idea>

    <Idea numeral={4} width={176} title="Payments can carry the proofs recipients need" section="proofs">
      <p>A recipient can ask a payment to prove what it needs, such as that its funds came only from approved sources. The sender proves it without revealing who paid, and the proof travels on with the money, so the next recipient can check it too. A stablecoin issuer can require the same proof before it redeems. <Link to={buildingGuide}>What you can build</Link>.</p>
    </Idea>

    <Idea numeral={5} width={167} title="Ethereum orders the transactions" section="derivation" asked={[questions.contract, questions.trust]}>
      <p>PCASH transactions are published to Ethereum, and every PCASH node derives the same state from Ethereum's history. There is no validator set, sequencer, operator or upgrade key, and anyone can post transactions. The rules change only if people choose to run new software, the way Ethereum itself changes.</p>
    </Idea>

    <Idea numeral={6} width={171} title="Earn PCASH by supplying activity" section="issuance" asked={[questions.getting]}>
      <p>New PCASH is issued for successful transactions, including mining: publishing a transaction with no payment to make. You pay Ethereum gas, not PCASH, and each mine adds cover for other people's payments. Total issuance is capped at one billion PCASH, with no premine, allocation or sale.</p>
      <p>Each block's issuance is limited and shared equally among the transactions that earn it. The amount per transaction declines as supply is issued and adjusts to how quickly issuance is running.</p>
      <p><Link className={styles.action} to="/get">Mine PCASH</Link></p>
    </Idea>

    <section className={styles.deeper} aria-labelledby="deeper-heading">
      <div>
        <h2 id="deeper-heading">Read further</h2>
        <div className={styles.documents}>
          <article>
            <h3><Link to={whitepaperRoute.path}>White paper</Link></h3>
            <p>Why PCASH exists and how it works, in one document.</p>
            <div className={styles.tools}><Link className={styles.tool} to={whitepaperRoute.path}>Read</Link><CopyForLlm source={whitepaperSource} className={styles.tool} /></div>
          </article>
          <article>
            <h3><Link to={securityRoute.path}>Security</Link></h3>
            <p>How PCASH protects its money and the people who use it, and the latest security review.</p>
            <div className={styles.tools}><Link className={styles.tool} to={securityRoute.path}>Read</Link></div>
          </article>
          <article>
            <h3><Link to={specRoute.path}>Protocol specification</Link></h3>
            <p>The exact rules every implementation follows.</p>
            <div className={styles.tools}><Link className={styles.tool} to={specRoute.path}>Read</Link><CopyForLlm source={specSource} className={styles.tool} /></div>
          </article>
          <article>
            <h3>Ask an AI</h3>
            <p>{evaluateBundle.description} Try asking: “{evaluateBundle.question}”</p>
            <div className={styles.tools}><CopyBundleForLlm bundle={evaluateBundle} className={styles.tool} /><a className={styles.tool} href={bundlePath(evaluateBundle)}>Plain text</a></div>
          </article>
        </div>
        <p className={styles.onward}>Building on PCASH or running a node? Start at <Link to={developersRoute.path}>Developers</Link>.</p>
      </div>
    </section>
  </div>;
}
