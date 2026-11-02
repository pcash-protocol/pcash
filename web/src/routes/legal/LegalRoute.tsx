import { useMatch } from "react-router-dom";
import privacy from "../../../../docs/privacy.md?raw";
import terms from "../../../../docs/terms.md?raw";
import { resolveDocumentHref } from "../docs/documentLinks.ts";
import { renderDocument } from "../docs/longDocument.ts";
import { Metadata } from "../Metadata.tsx";
import { routeById, type RouteDefinition } from "../routeManifest.ts";
import styles from "./LegalRoute.module.css";

const termsRoute = routeById("terms");
const privacyRoute = routeById("privacy");

function legalPage(route: RouteDefinition, file: string, source: string) {
  // Neither document has diagrams, so every block is HTML.
  const { title, blocks } = renderDocument(source, (href) => resolveDocumentHref(file, href));
  return { route, title, body: blocks.map((block) => block.kind === "html" ? block.html : "").join("") };
}

const termsPage = legalPage(termsRoute, "docs/terms.md", terms);
const privacyPage = legalPage(privacyRoute, "docs/privacy.md", privacy);

/** The Terms of Service and the Privacy Policy, each on its own page. */
export default function LegalRoute() {
  // The router matches paths case-insensitively, so use its match rather than the raw pathname.
  const { route, title, body } = useMatch(termsRoute.path) ? termsPage : privacyPage;
  return <article className={styles.page}>
    <Metadata {...route.metadata} />
    <h1>{title}</h1>
    <div dangerouslySetInnerHTML={{ __html: body }} />
  </article>;
}
