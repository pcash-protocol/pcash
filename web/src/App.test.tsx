import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { appRoutes } from "./App.tsx";
import { RouteError } from "./routes/RouteError.tsx";
import { footerNavigation, primaryNavigation, routeById } from "./routes/routeManifest.ts";

function render(pathname: string) {
  return renderToStaticMarkup(<RouterProvider router={createMemoryRouter(appRoutes(), { initialEntries: [pathname] })} />);
}

describe("application shell", () => {
  it("puts the products, then the reference material, in the header", () => {
    expect(primaryNavigation.map((route) => route.primaryLabel))
      .toEqual(["Marketplace", "Tokens", "Explorer", "Get PCASH", "Messages", "Learn", "Developers"]);
  });

  it("links Tokens from the footer beside the other products", () => {
    expect(footerNavigation.map((route) => route.id)).toContain("tokens");
  });

  it("renders the shared chrome on a public route", () => {
    const html = render(routeById("developers").path);
    expect(html).toContain('aria-label="Primary navigation"');
    expect(html).toContain('href="/marketplace"');
    expect(html).not.toContain("Not found");
  });

  it("renders a failed page's error inside the shared chrome", () => {
    const pages = appRoutes()[0]?.children?.[0];
    expect(pages?.path).toBeUndefined();
    expect((pages?.errorElement as ReactElement).type).toBe(RouteError);
    expect(pages?.children?.map((route) => route.path)).toContain(`${routeById("marketplace").path}/*`);
    expect(pages?.children?.map((route) => route.path)).toContain(routeById("tokens").path);
  });

  it.each([["marketplace"], ["get"], ["explorer"], ["tokens"], ["token-new"], ["claim"], ["messages"]])("resolves the %s route rather than the catch-all", (id) => {
    const html = render(routeById(id).path);
    expect(html).not.toContain("Not found");
  });

  it("routes a drop contract address to its drop page", () => {
    expect(render(`/drop/0x${"ab".repeat(20)}`)).not.toContain("Not found");
  });

  it("routes a token ID to its token page", () => {
    expect(render(`/token/0x${"0a".repeat(32)}`)).not.toContain("Not found");
  });

  it.each([
    "/blocks",
    "/block/12",
    `/tx/0x${"ab".repeat(32)}`,
    `/batch/0x${"cd".repeat(32)}`,
    "/contracts",
    "/search",
  ])("routes %s to the explorer at the site root", (path) => {
    expect(render(path)).not.toContain("Not found");
  });

  it.each([`/0x${"ef".repeat(20)}`, "/alice.eth", "/sub.alice.eth"])(
    "routes %s to the address page",
    (path) => {
      expect(render(path)).not.toContain("Not found");
    },
  );

  it.each([
    "/nope",
    "/pending",
    "/issuance",
    "/mine",
    "/account",
    "/bob",
    "/explorer/blocks",
    `/explorer/transaction/0x${"ab".repeat(32)}`,
    "/blocks/extra",
    `/address/0x${"ef".repeat(20)}`,
    "/address/alice.eth",
    "/alice.eth/extra",
    "/mempool",
    "/economics",
    `/implementation/0x${"ab".repeat(32)}`,
    "/tokens/extra",
    "/token",
    "/token/0x1234",
    `/token/0x${"00".repeat(32)}`,
    `/token/0x${"ff".repeat(32)}`,
    `/token/0x${"0a".repeat(32)}/extra`,
    "/drop",
    "/drop/0x1234",
    `/drop/0x${"ab".repeat(20)}/extra`,
  ])("renders the not-found page for %s without loading a chunk", (path) => {
    const html = render(path);
    expect(html).toContain("Not found");
    expect(html).not.toContain("Loading…");
  });
});
