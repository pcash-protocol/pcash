import { documentGroups, publicDocuments, SOURCE_REPOSITORY_URL } from "./publicDocuments.ts";

/**
 * Published documents a reader gives an AI in one paste. A model given the
 * rules without their reasons supplies its own, so the protocol bundle carries
 * the white paper and the design rationale beside the specification.
 */
export interface DocumentBundle {
  id: string;
  /** The text's first line. */
  title: string;
  /** What the text holds, in reading order. */
  intro: string;
  /** Repository paths, in order. */
  files: readonly string[];
  /** The bundle's name and description on the Learn and Developers pages. */
  name: string;
  description: string;
  /** A question worth asking with it. */
  question: string;
}

export const evaluateBundle: DocumentBundle = {
  id: "evaluate",
  title: "PCASH: the protocol, its reasons and its security",
  intro: "Three PCASH documents follow, in this order: the white paper, which explains what PCASH is and why; "
    + "Security, which covers how PCASH protects its money and the people who use it; "
    + "and the protocol specification, which states the exact rules and is normative.",
  files: ["docs/whitepaper.md", "docs/security.md", "docs/protocol-spec.md"],
  name: "The protocol, its reasons and its security",
  description: "The white paper, the Security page and the specification in one paste, so a model has the rules, the reasons for them and how PCASH is protected.",
  question: "How does this protocol work, and is it a good design?",
};

export const buildBundle: DocumentBundle = {
  id: "build",
  title: "PCASH: building applications",
  intro: "Two PCASH documents follow, in this order: the building guide, which shows what applications can do and how; "
    + "and the protocol specification, which states the exact rules and is normative.",
  files: ["docs/guides/building-on-pcash.md", "docs/protocol-spec.md"],
  name: "Building applications",
  description: "The building guide and the specification in one paste.",
  question: "How would I build a vesting contract that releases PCASH every month?",
};

export const documentBundles: readonly DocumentBundle[] = [evaluateBundle, buildBundle];

/** Every published document, in list order. */
const fullBundle = {
  title: "PCASH documentation",
  intro: "Every published PCASH document follows. The protocol specification is normative; the others explain it, "
    + "give the reasons for its choices, and show how to build on it and run it.",
  files: publicDocuments.map(({ file }) => file),
};

/** Where a bundle's text is served. */
export function bundlePath(bundle: DocumentBundle): string {
  return `/llms/${bundle.id}.txt`;
}

export const LLMS_INDEX_PATH = "/llms.txt";
export const LLMS_FULL_PATH = "/llms-full.txt";

/**
 * A heading, what follows, then each document's Markdown in a block naming
 * its title and the path its raw Markdown is served at. `read` returns a
 * document's Markdown by repository path.
 */
export function bundleText(bundle: Pick<DocumentBundle, "title" | "intro" | "files">, read: (file: string) => string): string {
  const documents = bundle.files.map((file) => {
    const { title } = publicDocuments.find((document) => document.file === file)!;
    const source = read(file).replace(/^\n+|\n+$/g, "");
    return `<document title="${title}" path="/${file}">\n${source}\n</document>\n`;
  });
  return [`# ${bundle.title}\n\n${bundle.intro}\n`, ...documents].join("\n");
}

/** Every published document as one text. */
export function fullText(read: (file: string) => string): string {
  return bundleText(fullBundle, read);
}

/** An index for AI readers, in the llms.txt format: the bundles, then every document by question. */
export function llmsIndex(): string {
  const link = (title: string, path: string, description: string) => `- [${title}](${path}): ${description}`;
  return [
    "# PCASH",
    "",
    "> Private money Ethereum can program, with no public form, no operator, and capped native issuance.",
    "",
    "Each document below is plain Markdown. The bundles hold several documents in one file, for reading in one pass.",
    "",
    "## Bundles",
    "",
    ...documentBundles.map((bundle) => link(bundle.name, bundlePath(bundle), bundle.description)),
    link("Everything", LLMS_FULL_PATH, "Every published document in one file."),
    ...documentGroups.flatMap(({ id, question }) => [
      "",
      `## ${question}`,
      "",
      ...publicDocuments.filter(({ group }) => group === id).map(({ title, file, description }) => link(title, `/${file}`, description)),
    ]),
    "",
    "## Source",
    "",
    link("Repository", SOURCE_REPOSITORY_URL, "Source code for the node, circuits, SDK, applications and website."),
    "",
  ].join("\n");
}

/** Every AI text the site serves, by path. */
export function aiTexts(read: (file: string) => string): ReadonlyMap<string, () => string> {
  return new Map<string, () => string>([
    [LLMS_INDEX_PATH, llmsIndex],
    [LLMS_FULL_PATH, () => fullText(read)],
    ...documentBundles.map((bundle) => [bundlePath(bundle), () => bundleText(bundle, read)] as const),
  ]);
}
