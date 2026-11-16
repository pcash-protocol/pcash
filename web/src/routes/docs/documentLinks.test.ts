import { describe, expect, it } from "vitest";
import { resolveDocumentHref } from "./documentLinks.ts";

describe("document links", () => {
  it("leads to the page of a published document", () => {
    expect(resolveDocumentHref("docs/protocol-spec.md", "guides/running-a-node.md")).toBe("/docs/guides/running-a-node");
    expect(resolveDocumentHref("docs/protocol-spec.md", "whitepaper.md#private-only")).toBe("/docs/whitepaper#private-only");
    expect(resolveDocumentHref("docs/guides/building-on-pcash.md", "../whitepaper.md#authorization")).toBe("/docs/whitepaper#authorization");
    expect(resolveDocumentHref("docs/guides/building-on-pcash.md", "running-a-node.md")).toBe("/docs/guides/running-a-node");
    expect(resolveDocumentHref("docs/terms.md", "privacy.md")).toBe("/privacy");
    expect(resolveDocumentHref("docs/privacy.md", "terms.md")).toBe("/terms");
  });

  it("leads to the site's own copy of a file the website serves", () => {
    expect(resolveDocumentHref("docs/security.md", "../web/public/security/report.pdf")).toBe("/security/report.pdf");
  });

  it("leads to the source repository for any other repository file", () => {
    expect(resolveDocumentHref("docs/protocol-spec.md", "../circuits/README.md#reference-rules-reference_rules"))
      .toBe("https://github.com/pcash-protocol/pcash/blob/main/circuits/README.md#reference-rules-reference_rules");
    expect(resolveDocumentHref("docs/guides/running-a-node.md", "../../wallet/dashboards/pcash-wallet.json"))
      .toBe("https://github.com/pcash-protocol/pcash/blob/main/wallet/dashboards/pcash-wallet.json");
    expect(resolveDocumentHref("docs/guides/running-a-node.md", "../internal/operations.md"))
      .toBe("https://github.com/pcash-protocol/pcash/blob/main/docs/internal/operations.md");
    expect(resolveDocumentHref("docs/whitepaper.md", "guides/"))
      .toBe("https://github.com/pcash-protocol/pcash/tree/main/docs/guides/");
  });

  it("leaves section-only, site-absolute, and external links alone", () => {
    expect(resolveDocumentHref("docs/protocol-spec.md", "#state")).toBe("#state");
    expect(resolveDocumentHref("docs/protocol-spec.md", "/marketplace")).toBe("/marketplace");
    expect(resolveDocumentHref("docs/protocol-spec.md", "https://example.com/spec")).toBe("https://example.com/spec");
    expect(resolveDocumentHref("docs/terms.md", "mailto:legal@example.com")).toBe("mailto:legal@example.com");
  });
});
