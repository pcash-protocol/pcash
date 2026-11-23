import { Link, Route, Routes } from "react-router-dom";
import { resolveDocumentHref } from "./documentLinks.ts";
import { DocumentPage } from "./DocumentPage.tsx";
import { Metadata } from "../Metadata.tsx";
import { DOCS_PATH, publicDocuments } from "./publicDocuments.ts";
import { documentSource } from "./sources.ts";
import { routeById } from "../routeManifest.ts";
import styles from "./DocsRoute.module.css";

const docsRoute = routeById("docs");

const documents = publicDocuments.map(({ id, file, contentsDepth }) => ({
  route: routeById(id),
  source: documentSource(file),
  contentsDepth,
  resolveHref: (href: string) => resolveDocumentHref(file, href),
}));

export default function DocsRoute() {
  return <Routes>
    {documents.map(({ route, source, contentsDepth, resolveHref }) => <Route key={route.id} path={route.path.slice(DOCS_PATH.length + 1)} element={<DocumentPage route={route} source={source} contentsDepth={contentsDepth} resolveHref={resolveHref} />} />)}
    <Route path="*" element={<section className={styles.notFound}><Metadata title="Documentation page not found" description="The requested PCASH documentation page does not exist." /><h1>Documentation page not found.</h1><Link to={docsRoute.path}>See all docs</Link></section>} />
  </Routes>;
}
