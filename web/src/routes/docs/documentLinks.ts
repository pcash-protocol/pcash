import { routeById } from "../routeManifest.ts";
import { documentPath, publicDocuments, SOURCE_REPOSITORY_URL } from "./publicDocuments.ts";

const PUBLIC_ASSETS = "web/public/";

/** Where each published repository file lives on the site. */
export const sitePathByFile: ReadonlyMap<string, string> = new Map([
  ...publicDocuments.map(({ file }) => [file, documentPath(file)] as const),
  ["docs/terms.md", routeById("terms").path],
  ["docs/privacy.md", routeById("privacy").path],
]);

/**
 * Resolves a link written in a repository document for the website. A link to a
 * published document leads to its page; a link to any other repository file
 * leads to that file in the source repository.
 */
export function resolveDocumentHref(currentFile: string, href: string): string {
  if (href.startsWith("#") || href.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  const resolved = new URL(href, new URL(currentFile, "https://repository.invalid/"));
  const file = decodeURIComponent(resolved.pathname.slice(1));
  const sitePath = sitePathByFile.get(file);
  if (sitePath !== undefined) return `${sitePath}${resolved.hash}`;
  // The website serves web/public at its root.
  if (file.startsWith(PUBLIC_ASSETS)) return `/${file.slice(PUBLIC_ASSETS.length)}`;
  return `${SOURCE_REPOSITORY_URL}/${file.endsWith("/") ? "tree" : "blob"}/main/${file}${resolved.hash}`;
}
