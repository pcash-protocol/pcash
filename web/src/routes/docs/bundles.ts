import { documentGroups, publicDocuments, SOURCE_REPOSITORY_URL } from "./publicDocuments.ts";

/** Documents joined into one text: a heading, what follows, then each document. */
interface DocumentBundle {
  /** The text's first line. */
  title: string;
  /** What the text holds, in reading order. */
  intro: string;
  /** Repository paths, in order. */
  files: readonly string[];
}

/** Every published document, in list order. */
const fullBundle: DocumentBundle = {
  title: "PCASH documentation",
  intro: "Every published PCASH document follows. The protocol specification is normative; the others explain it, "
    + "give the reasons for its choices, and show how to build on it and run it.",
  files: publicDocuments.map(({ file }) => file),
};

export const LLMS_INDEX_PATH = "/llms.txt";
export const LLMS_FULL_PATH = "/llms-full.txt";

/**
 * A heading, what follows, then each document's Markdown in a block naming
 * its title and the path its raw Markdown is served at. `read` returns a
 * document's Markdown by repository path.
 */
export function bundleText(bundle: DocumentBundle, read: (file: string) => string): string {
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

/** An index for AI readers, in the llms.txt format: the full text, then every document by question. */
export function llmsIndex(): string {
  const link = (title: string, path: string, description: string) => `- [${title}](${path}): ${description}`;
  return [
    "# PCASH",
    "",
    "> Programmable private money secured by Ethereum, with no public form, no operator, and capped native issuance.",
    "",
    "Each document below is plain Markdown.",
    "",
    "## Everything",
    "",
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
  ]);
}
