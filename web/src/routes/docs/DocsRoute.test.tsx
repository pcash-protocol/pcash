import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { renderPublicPage } from "../prerender.tsx";
import { prerenderRoutes, renderModeForPathname, routeById, routeForPathname, routeManifest } from "../routeManifest.ts";
import { DocumentPage } from "./DocumentPage.tsx";
import { whitepaperSections } from "./LearnPage.tsx";
import { renderDocument } from "./longDocument.ts";
import { documentPath, publicDocuments } from "./publicDocuments.ts";
import { whitepaperSource } from "./sources.ts";

describe("documentation routes", () => {
  it("prerenders the public home and developer routes without a loading shell", () => {
    expect(new Set(routeManifest.map(({ path }) => path)).size).toBe(routeManifest.length);
    expect(new Set(routeManifest.map(({ id }) => id)).size).toBe(routeManifest.length);
    const home = renderPublicPage("/");
    expect(home.html).toMatch(/<h1>[^<]+<\/h1>/);
    expect(home.html).not.toContain("Loading…");
    const developers = renderPublicPage("/developers");
    expect(developers.html).toContain("Build private applications on public foundations");
    expect(developers.html).toContain("Protocol specification");
    expect(developers.html).not.toContain("Loading…");
  });

  it("prerenders what Get PCASH and Tokens show before the wallet or node answers", () => {
    const get = renderPublicPage("/get").html;
    expect(get).toContain("<h1>Get PCASH</h1>");
    expect(get).toContain("How each block’s issuance is set");
    const tokens = renderPublicPage("/tokens").html;
    expect(tokens).toContain("Check a token");
    expect(tokens).toContain("Token drops listed on this node.");
  });

  it("prerenders Learn and every published document as complete pages", () => {
    for (const path of ["/docs", ...publicDocuments.map(({ file }) => documentPath(file))]) {
      const page = renderPublicPage(path);
      expect(page.html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
      expect(page.html).not.toContain("Loading");
    }
  });

  it("prerenders a diagram between the paragraphs of a document", () => {
    const source = '# Title\n\nBefore.\n\n<figure data-diagram="payment-journey"><figcaption><p>One payment, start to finish.</p></figcaption></figure>\n\nAfter.\n';
    const html = renderToString(<MemoryRouter><DocumentPage route={routeById("whitepaper")} source={source} contentsDepth={3} resolveHref={(href) => href} /></MemoryRouter>);
    const order = ["<p>Before.</p>", 'aria-label="Payment journey"', "<figcaption>One payment, start to finish.</figcaption>", "<p>After.</p>"].map((part) => html.indexOf(part));
    expect(order.every((index) => index !== -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("points every Learn reference at a white paper section that exists", () => {
    const ids = new Set(renderDocument(whitepaperSource, (href) => href).headings.map((heading) => heading.id));
    for (const [id] of Object.values(whitepaperSections)) expect(ids, id).toContain(id);
  });

  it("assigns every URL either a prerendered document or the neutral client shell", () => {
    expect(prerenderRoutes.map(({ path }) => path)).toContain("/");
    expect(prerenderRoutes.map(({ path }) => path)).toContain("/developers");
    expect(renderModeForPathname("/explorer")).toBe("client");
    expect(renderModeForPathname("/blocks")).toBe("client");
    expect(renderModeForPathname(`/0x${"ab".repeat(20)}`)).toBe("client");
    expect(routeForPathname(`/tx/0x${"ab".repeat(32)}`)?.id).toBe("explorer");
    expect(routeForPathname("/block/12")?.id).toBe("explorer");
    expect(renderModeForPathname("/docs/guides/running-a-node")).toBe("prerender");
    expect(routeForPathname("/docs/reference/absent")).toBeUndefined();
    expect(routeForPathname("/docs/internal/operations")).toBeUndefined();
    expect(renderModeForPathname("/developers/")).toBe("prerender");
    expect(routeForPathname("/tokens/new")?.id).toBe("token-new");
    expect(routeForPathname(`/token/0x${"0a".repeat(32)}`)?.id).toBe("token");
    expect(renderModeForPathname("/tokens")).toBe("prerender");
    expect(renderModeForPathname("/get")).toBe("prerender");
    expect(routeForPathname("/tokensish")).toBeUndefined();
    expect(routeForPathname("/explorerish")).toBeUndefined();
    expect(renderModeForPathname("/does-not-exist")).toBe("client");
  });
});
