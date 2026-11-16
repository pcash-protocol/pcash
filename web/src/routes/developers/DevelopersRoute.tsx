import { Link } from "react-router-dom";
import { buildBundle, bundlePath, LLMS_INDEX_PATH } from "../docs/bundles.ts";
import { CopyBundleForLlm } from "../docs/DocumentTools.tsx";
import { documentGroups, publicDocuments, SOURCE_REPOSITORY_URL } from "../docs/publicDocuments.ts";
import { Metadata } from "../Metadata.tsx";
import { routeById } from "../routeManifest.ts";
import styles from "./DevelopersRoute.module.css";

const developersRoute = routeById("developers");
const buildingGuide = routeById("guide-building");
const learnRoute = routeById("learn");

// What PCASH is and why sits on Learn; this page holds the rest.
const groups = documentGroups.filter((group) => group.id !== "learn").map((group) => ({
  ...group,
  documents: publicDocuments.filter((document) => document.group === group.id)
    .map(({ id, eyebrow, title, description }) => ({ eyebrow, title, description, to: routeById(id).path })),
}));

export default function DevelopersRoute() {
  return <div className={styles.page}>
    <Metadata {...developersRoute.metadata} />
    <header className={styles.hero}>
      <p className={styles.kicker}>Developers</p>
      <h1>Build private applications on public foundations.</h1>
      <p>Start with the builder guide, then use the specification and the reference pages when you need the exact protocol boundary.</p>
      <div className={styles.actions}>
        <Link className={styles.primaryLink} to={buildingGuide.path}>Start building <span aria-hidden="true">→</span></Link>
        <a className={styles.secondaryLink} href={SOURCE_REPOSITORY_URL} target="_blank" rel="noreferrer">Source on GitHub <span aria-hidden="true">↗</span></a>
      </div>
      <p className={styles.newcomer}>New to PCASH? <Link to={learnRoute.path}>Learn</Link> what it is and why it is built this way.</p>
    </header>

    <section className={styles.section} aria-labelledby="ai-heading">
      <div className={styles.sectionHeading}>
        <p className={styles.kicker}>Ask an AI</p>
        <h2 id="ai-heading">Give a model what it needs to build.</h2>
        <p>Agents can start from <a href={LLMS_INDEX_PATH}>llms.txt</a>. To ask whether the protocol is a good design, use the bundle on <Link to={learnRoute.path}>Learn</Link>.</p>
      </div>
      <article className={styles.bundle}>
        <strong>{buildBundle.name}</strong>
        <p>{buildBundle.description}</p>
        <p className={styles.question}>Try asking: “{buildBundle.question}”</p>
        <div className={styles.tools}>
          <CopyBundleForLlm bundle={buildBundle} className={styles.tool} />
          <a className={styles.tool} href={bundlePath(buildBundle)}>Plain text</a>
        </div>
      </article>
    </section>

    {groups.map((group) => <section key={group.id} className={styles.section} aria-labelledby={`${group.id}-heading`}>
      <div className={styles.sectionHeading}>
        <h2 id={`${group.id}-heading`}>{group.question}</h2>
        <p>{group.summary}</p>
      </div>
      <nav className={styles.resourceGrid} aria-labelledby={`${group.id}-heading`}>
        {group.documents.map((document) => <Link key={document.to} to={document.to}>
          <span className={styles.resourceBody}>
            <small>{document.eyebrow}</small>
            <strong>{document.title}</strong>
            <span>{document.description}</span>
          </span>
          <span className={styles.arrow} aria-hidden="true">↗</span>
        </Link>)}
      </nav>
    </section>)}
  </div>;
}
