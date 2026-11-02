import { describe, expect, it } from "vitest";
import { aiTexts, bundlePath, bundleText, documentBundles, fullText, LLMS_FULL_PATH, LLMS_INDEX_PATH, llmsIndex } from "./bundles.ts";
import { publicDocuments } from "./publicDocuments.ts";

const published = new Set(publicDocuments.map(({ file }) => file));

describe("document bundles", () => {
  it("hold only published documents, each once", () => {
    for (const bundle of documentBundles) {
      expect(bundle.files.filter((file) => !published.has(file)), bundle.id).toEqual([]);
      expect(new Set(bundle.files).size, bundle.id).toBe(bundle.files.length);
    }
  });

  it("frame each document with its title and raw Markdown path, in order", () => {
    const text = bundleText(
      { title: "Two documents", intro: "The white paper, then the specification.", files: ["docs/whitepaper.md", "docs/protocol-spec.md"] },
      (file) => `\n# ${file}\n\nBody.\n\n`,
    );
    expect(text).toBe([
      "# Two documents",
      "",
      "The white paper, then the specification.",
      "",
      '<document title="White paper" path="/docs/whitepaper.md">',
      "# docs/whitepaper.md",
      "",
      "Body.",
      "</document>",
      "",
      '<document title="Protocol specification" path="/docs/protocol-spec.md">',
      "# docs/protocol-spec.md",
      "",
      "Body.",
      "</document>",
      "",
    ].join("\n"));
  });

  it("put every published document in the full text", () => {
    const text = fullText((file) => file);
    for (const { file, title } of publicDocuments) expect(text).toContain(`<document title="${title}" path="/${file}">\n${file}\n</document>`);
  });
});

describe("llms.txt", () => {
  it("links every bundle, the full text, and every published document's Markdown", () => {
    const index = llmsIndex();
    expect(index.startsWith("# PCASH\n\n> ")).toBe(true);
    for (const bundle of documentBundles) expect(index).toContain(`](${bundlePath(bundle)}): `);
    expect(index).toContain(`](${LLMS_FULL_PATH}): `);
    for (const { file } of publicDocuments) expect(index).toContain(`](/${file}): `);
  });

  it("is served with the full text and each bundle", () => {
    expect([...aiTexts((file) => file).keys()]).toEqual([LLMS_INDEX_PATH, LLMS_FULL_PATH, ...documentBundles.map(bundlePath)]);
  });
});
