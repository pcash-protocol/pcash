import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { marked } from "marked";
import { describe, expect, it } from "vitest";
import { sitePathByFile } from "./documentLinks.ts";
import { renderDocument } from "./longDocument.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..");
const INTERNAL = "docs/internal/";

function markdownFiles(directory: string): string[] {
  return readdirSync(join(REPOSITORY_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

function read(file: string): string {
  return readFileSync(join(REPOSITORY_ROOT, file), "utf8");
}

const headingIdsByFile = new Map<string, Set<string>>();

function headingIds(file: string): Set<string> {
  let ids = headingIdsByFile.get(file);
  if (ids === undefined) {
    ids = new Set(renderDocument(read(file), (href) => href).headings.map(({ id }) => id));
    headingIdsByFile.set(file, ids);
  }
  return ids;
}

function links(file: string): string[] {
  const hrefs: string[] = [];
  marked.walkTokens(marked.lexer(read(file)), (token) => {
    if (token.type === "link") hrefs.push(token.href);
  });
  return hrefs;
}

describe("published documents", () => {
  it("are exactly the documents under docs/ outside docs/internal/", () => {
    const onDisk = markdownFiles("docs").filter((file) => !file.startsWith(INTERNAL));
    expect([...sitePathByFile.keys()].sort()).toEqual(onDisk.sort());
  });

  it("link only to sections, pages, and repository files that exist, and never to an internal document", () => {
    const broken: string[] = [];
    for (const file of sitePathByFile.keys()) {
      for (const href of links(file)) {
        if (href.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
        const resolved = new URL(href, new URL(file, "https://repository.invalid/"));
        const target = decodeURIComponent(resolved.pathname.slice(1));
        const fragment = resolved.hash.slice(1);
        const published = sitePathByFile.has(target);
        const ok = target.startsWith(INTERNAL)
          ? false
          : published
            ? fragment === "" || headingIds(target).has(fragment)
            : existsSync(join(REPOSITORY_ROOT, target));
        if (!ok) broken.push(`${file}: ${href}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
