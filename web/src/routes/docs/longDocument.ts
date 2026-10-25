import { Marked, type Token, type Tokens } from "marked";
import { SOURCE_REPOSITORY_URL } from "./publicDocuments.ts";

export interface DocumentHeading {
  id: string;
  text: string;
  depth: number;
}

/** Rendered Markdown, or a diagram the document places between its paragraphs. */
export type DocumentBlock =
  | { kind: "html"; html: string }
  | { kind: "diagram"; slug: string; caption: string };

export interface RenderedDocument {
  title: string;
  blocks: DocumentBlock[];
  headings: DocumentHeading[];
  minutes: number;
  /** Whether the document quotes code as evidence, which its page can hide. */
  hasEvidence: boolean;
}

/**
 * A diagram placement: this exact HTML on one line, as a block of its own. The caption's
 * `<p>` keeps it a paragraph of its own where the figure tags are stripped, as on GitHub.
 */
const diagramFigure = /^<figure data-diagram="([a-z0-9-]+)"><figcaption><p>([^<]+)<\/p><\/figcaption><\/figure>$/;

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** The anchor a heading gets on the white paper and specification pages. */
export function headingId(text: string): string {
  return text.toLowerCase().replaceAll("`", "").replace(/[^a-z0-9\s-]/g, "").trim().replace(/[\s-]+/g, "-");
}

/**
 * Renders a repository Markdown document for its own page. The first top-level
 * heading becomes the page title and is left out of the body. Headings get stable
 * anchors, and a document with several top-level headings (the white paper uses
 * them for its parts) moves the rest down one level. A diagram figure block
 * becomes a diagram block, splitting the Markdown around it. A code block whose
 * info string names a repository path after the language ("rust node/src/x.rs")
 * is evidence: a figure captioned with a link to that file in the repository. The text around
 * evidence reads without it, so the page can hide it.
 */
export function renderDocument(source: string, resolveHref: (href: string) => string): RenderedDocument {
  const ids = new WeakMap<Token, string>();
  const headings: DocumentHeading[] = [];
  const used = new Map<string, number>();
  let hasEvidence = false;
  const marked = new Marked({
    renderer: {
      heading(token) {
        return `<h${token.depth} id="${ids.get(token)}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
      },
      code({ text, lang }) {
        const [language, file] = (lang ?? "").trim().split(/\s+/);
        if (file === undefined) return false;
        hasEvidence = true;
        const source = `<a href="${SOURCE_REPOSITORY_URL}/blob/main/${escapeHtml(file)}">${escapeHtml(file)}</a>`;
        return `<figure class="evidence" data-evidence><figcaption>${source}</figcaption><pre><code class="language-${escapeHtml(language!)}">${escapeHtml(text)}</code></pre></figure>\n`;
      },
    },
  });
  const tokens = marked.lexer(source);
  const topLevel = tokens.filter((token): token is Tokens.Heading => token.type === "heading" && token.depth === 1);
  const titleToken = topLevel[0];
  const shift = topLevel.length > 1;
  marked.walkTokens(tokens, (token) => {
    if (token.type === "link") token.href = resolveHref(token.href);
    if (token.type !== "heading" || token === titleToken) return;
    if (shift) token.depth = Math.min(token.depth + 1, 6);
    const text = token.text.replaceAll("`", "");
    const base = headingId(text);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;
    ids.set(token, id);
    headings.push({ id, text, depth: token.depth });
  });
  if (titleToken !== undefined) tokens.splice(tokens.indexOf(titleToken), 1);
  const blocks: DocumentBlock[] = [];
  let run: Token[] = [];
  const flush = () => {
    const html = marked.parser(run);
    if (html !== "") blocks.push({ kind: "html", html });
    run = [];
  };
  for (const token of tokens) {
    const figure = token.type === "html" && token.block ? diagramFigure.exec(token.text.trim()) : null;
    if (figure === null) {
      run.push(token);
      continue;
    }
    flush();
    blocks.push({ kind: "diagram", slug: figure[1]!, caption: figure[2]! });
  }
  flush();
  const words = source.split(/\s+/).filter(Boolean).length;
  return {
    title: titleToken?.text.replaceAll("`", "") ?? "",
    blocks,
    headings,
    minutes: Math.max(1, Math.round(words / 230)),
    hasEvidence,
  };
}
