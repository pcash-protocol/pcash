import { describe, expect, it } from "vitest";
import { renderDocument } from "./longDocument.ts";

const figure = '<figure data-diagram="payment-journey"><figcaption><p>Prepare a payment, prove it, publish it, verify it, and recover the new notes.</p></figcaption></figure>';

describe("long document rendering", () => {
  it("turns a figure block into a diagram block", () => {
    const rendered = renderDocument(`# Title\n\n${figure}\n`, (href) => href);
    expect(rendered.blocks).toEqual([
      { kind: "diagram", slug: "payment-journey", caption: "Prepare a payment, prove it, publish it, verify it, and recover the new notes." },
    ]);
  });

  it("splits the Markdown around a figure in the middle of a document", () => {
    const source = `# Title\n\nBefore the [payment](a.md).\n\n${figure}\n\n## After\n\nAfter the payment.\n`;
    const rendered = renderDocument(source, (href) => `/resolved/${href}`);
    expect(rendered.title).toBe("Title");
    expect(rendered.headings).toEqual([{ id: "after", text: "After", depth: 2 }]);
    expect(rendered.blocks).toEqual([
      { kind: "html", html: '<p>Before the <a href="/resolved/a.md">payment</a>.</p>\n' },
      { kind: "diagram", slug: "payment-journey", caption: "Prepare a payment, prove it, publish it, verify it, and recover the new notes." },
      { kind: "html", html: '<h2 id="after">After</h2>\n<p>After the payment.</p>\n' },
    ]);
  });

  it("captions a code block that names a repository file as evidence, and leaves other code blocks alone", () => {
    const source = "# Title\n\n```rust node/src/a.rs\nfn f() -> u8 { 1 < 2 }\n```\n\n```ts\nconst x = 1;\n```\n";
    const rendered = renderDocument(source, (href) => href);
    expect(rendered.hasEvidence).toBe(true);
    expect(rendered.blocks).toEqual([{ kind: "html", html:
      '<figure class="evidence" data-evidence><figcaption><a href="https://github.com/pcash-protocol/pcash/blob/main/node/src/a.rs">node/src/a.rs</a></figcaption>'
      + '<pre><code class="language-rust">fn f() -&gt; u8 { 1 &lt; 2 }</code></pre></figure>\n'
      + '<pre><code class="language-ts">const x = 1;\n</code></pre>\n' }]);
    expect(renderDocument("# Title\n\n```ts\nconst x = 1;\n```\n", (href) => href).hasEvidence).toBe(false);
  });
});
