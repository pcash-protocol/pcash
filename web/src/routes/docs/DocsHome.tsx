import { Link } from "react-router-dom";
import { documentGroups, publicDocuments } from "./publicDocuments.ts";
import { Metadata } from "../Metadata.tsx";
import { routeById } from "../routeManifest.ts";
import styles from "./DocsHome.module.css";

const docsRoute = routeById("docs");

interface Card { eyebrow: string; title: string; description: string; to: string }

const groups = documentGroups.map(({ id, question, summary }) => ({
  id,
  title: question,
  summary,
  cards: publicDocuments.filter((document) => document.group === id)
    .map(({ id: route, eyebrow, title, description }): Card => ({ eyebrow, title, description, to: routeById(route).path })),
}));

/** Working applications on PCASH, each one an example of what the protocol does. */
const apps = {
  id: "apps",
  title: "Apps built on PCASH",
  summary: "Working applications on the public protocol, and examples of what it does.",
  cards: [
    { id: "marketplace", title: "Marketplace", description: "Sell PCASH for ETH through escrow contracts; each sale settles in one Ethereum transaction with no custodian." },
    { id: "tokens", title: "Tokens", description: "Create a private token with a fixed supply, send it, and check any token’s definition against its ID." },
    { id: "board", title: "Anonymous board", description: "A public board: anyone can read every post, and no one can tell which account wrote one." },
  ].map(({ id, ...app }): Card => ({ ...app, eyebrow: "App", to: routeById(id).path })),
};

function Section({ id, title, summary, cards }: { id: string; title: string; summary: string; cards: Card[] }) {
  return <section className={styles.section} aria-labelledby={`${id}-heading`}>
    <div className={styles.sectionHeading}>
      <h2 id={`${id}-heading`}>{title}</h2>
      <p>{summary}</p>
    </div>
    <nav className={styles.resourceGrid} aria-labelledby={`${id}-heading`}>
      {cards.map((card) => <Link key={card.to} to={card.to}>
        <span className={styles.resourceBody}>
          <small>{card.eyebrow}</small>
          <strong>{card.title}</strong>
          <span>{card.description}</span>
        </span>
        <span className={styles.arrow} aria-hidden="true">↗</span>
      </Link>)}
    </nav>
  </section>;
}

/** Every published document, grouped by the question it answers, then the apps. */
export default function DocsHome() {
  return <div className={styles.page}>
    <Metadata {...docsRoute.metadata} />
    <header className={styles.hero}>
      <h1>Docs</h1>
      <p>How PCASH works, the exact rules, and how to build on it and run it.</p>
    </header>
    {groups.map((group) => <Section key={group.id} {...group} />)}
    <Section {...apps} />
  </div>;
}
