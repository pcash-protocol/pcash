import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";
import privacy from "../../../../docs/privacy.md?raw";
import terms from "../../../../docs/terms.md?raw";
import { appRoutes } from "../../App.tsx";
import { renderPublicPage } from "../prerender.tsx";
import LegalRoute from "./LegalRoute.tsx";

/** The legal document itself, without the shared header and footer, which link to both pages. */
function article(html: string): string {
  return html.match(/<article[^>]*>[\s\S]*<\/article>/)?.[0] ?? "";
}

describe("legal pages", () => {
  it("prerenders the complete terms and privacy policy, linked to each other", () => {
    const termsPage = article(renderPublicPage("/terms").html);
    expect(termsPage).toContain("<h1>PCASH Terms of Service</h1>");
    expect(termsPage).toContain('id="21-contact"');
    expect(termsPage).toContain('href="/privacy"');
    const privacyPage = article(renderPublicPage("/privacy").html);
    expect(privacyPage).toContain("<h1>PCASH Privacy Policy</h1>");
    expect(privacyPage).toContain('id="contact-us"');
    expect(privacyPage).toContain('href="/terms"');
    for (const page of [termsPage, privacyPage]) expect(page).not.toMatch(/href="[^"]*\.md"/);
  });

  it("renders the matched document for a path in another case", () => {
    const render = (pathname: string) => article(renderToString(<RouterProvider router={createMemoryRouter(appRoutes({ legalPage: <LegalRoute /> }), { initialEntries: [pathname] })} />));
    expect(render("/Terms")).toContain("<h1>PCASH Terms of Service</h1>");
    expect(render("/PRIVACY")).toContain("<h1>PCASH Privacy Policy</h1>");
  });

  it("has no unfilled placeholders", () => {
    for (const source of [terms, privacy]) expect(source.match(/\[[A-Z][A-Z /&-]*\]/g) ?? []).toEqual([]);
  });
});
