import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

async function renderApp(pathname: string): Promise<string> {
  const { appRoutes } = await import("../../App.tsx");
  return renderToStaticMarkup(<RouterProvider router={createMemoryRouter(appRoutes(), { initialEntries: [pathname] })} />);
}

describe("fixture states route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("exists only in fixture mode", async () => {
    vi.stubEnv("VITE_PCASH_MODE", "fixtures");
    expect(await renderApp("/__states")).not.toContain("Not found");
    vi.unstubAllEnvs();
    vi.resetModules();
    expect(await renderApp("/__states")).toContain("Not found");
  });

  it("links every state to a fully resolved path", async () => {
    const { default: StatesRoute } = await import("./StatesRoute.tsx");
    const html = renderToStaticMarkup(<MemoryRouter><StatesRoute /></MemoryRouter>);
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(([, href]) => href);
    expect(hrefs.length).toBeGreaterThan(30);
    for (const href of hrefs) {
      expect(href).toMatch(/^\//);
      expect(href).not.toMatch(/undefined|null|NaN/);
    }
    expect(html).toContain("Every route, every state");
  });
});
