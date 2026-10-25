import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Metadata } from "../Metadata.tsx";
import { routeById, type RouteDefinition } from "../routeManifest.ts";
import { Diagram } from "./diagrams/Diagram.tsx";
import { diagrams } from "./diagrams/index.ts";
import { CopyForLlm, markdownPath } from "./DocumentTools.tsx";
import { renderDocument, type DocumentBlock } from "./longDocument.ts";
import styles from "./DocumentPage.module.css";

const learnRoute = routeById("learn");
const developersRoute = routeById("developers");

function Block({ block }: { block: DocumentBlock }) {
  if (block.kind === "html") return <div className={styles.body} dangerouslySetInnerHTML={{ __html: block.html }} />;
  const Figure = diagrams[block.slug]!;
  return <div className={styles.figure}><Diagram summary={block.caption}><Figure /></Diagram></div>;
}

const HIDE_CODE_KEY = "pcash.docs.hideCode";

function storedHideCode(): boolean {
  try { return localStorage.getItem(HIDE_CODE_KEY) === "true"; } catch { return false; }
}

/** Whether the reader hides quoted code, remembered on this device. The stored choice applies after hydration, so the prerendered page matches. */
function useHideCode(): [boolean, () => void] {
  const [hidden, setHidden] = useState(false);
  useEffect(() => setHidden(storedHideCode()), []);
  const toggle = () => setHidden((current) => {
    try { localStorage.setItem(HIDE_CODE_KEY, String(!current)); } catch { /* the choice lasts for this page */ }
    return !current;
  });
  return [hidden, toggle];
}

/** A published repository document on its own page. Guides and reference pages sit under Developers; the rest sit under Learn. */
export function DocumentPage({ route, source, contentsDepth, resolveHref }: {
  route: RouteDefinition;
  source: string;
  /** Deepest heading level listed in the contents. */
  contentsDepth: number;
  resolveHref: (href: string) => string;
}) {
  const rendered = useMemo(() => renderDocument(source, resolveHref), [source, resolveHref]);
  const [hideCode, toggleHideCode] = useHideCode();
  const contents = rendered.headings.filter((heading) => heading.depth >= 2 && heading.depth <= contentsDepth);
  const parent = route.path.split("/").length > 3 ? developersRoute : learnRoute;
  const links = contents.map((heading) => <a key={heading.id} href={`#${heading.id}`} className={heading.depth > 2 ? styles.nested : undefined}>{heading.text}</a>);
  return <div className={styles.page}>
    <Metadata {...route.metadata} />
    <div className={styles.layout}>
      <aside className={styles.contents}><span>Contents</span><nav aria-label="Contents">{links}</nav></aside>
      <div className={styles.main}>
        <header className={styles.header}>
          <nav className={styles.breadcrumbs} aria-label="Breadcrumb"><Link to={parent.path}>{parent.primaryLabel}</Link><span aria-hidden="true">/</span><span aria-current="page">{route.metadata.title}</span></nav>
          <h1>{rendered.title}</h1>
          <p className={styles.meta}>{rendered.minutes} min read</p>
          <div className={styles.tools}>
            <CopyForLlm source={source} className={styles.tool} />
            <a className={styles.tool} href={markdownPath(route.path)}>View as Markdown</a>
            {rendered.hasEvidence && <button type="button" className={styles.tool} aria-pressed={hideCode} onClick={toggleHideCode}>Hide code</button>}
          </div>
        </header>
        <details className={styles.mobileContents}><summary>Contents</summary><nav aria-label="Contents">{links}</nav></details>
        <article className={rendered.hasEvidence && hideCode ? styles.hideEvidence : undefined}>{rendered.blocks.map((block, index) => <Block key={index} block={block} />)}</article>
      </div>
    </div>
  </div>;
}
