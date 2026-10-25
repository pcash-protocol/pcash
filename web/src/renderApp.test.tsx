// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { renderPublicPage } from "./routes/prerender.tsx";
import { prerenderRoutes } from "./routes/routeManifest.ts";

// Never answered, so no page started here reads the network, including after its test.
vi.stubGlobal("fetch", () => new Promise(() => undefined));
vi.stubGlobal("scrollTo", () => undefined);

afterEach(() => {
  vi.restoreAllMocks();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

// A mismatch logs an error; a page that was not ready to hydrate is rendered again, replacing the prerendered nodes.
it.each(prerenderRoutes.map(({ path }) => path))("hydrates the prerendered %s page in place", async (path) => {
  document.body.innerHTML = `<div id="root" data-prerender-path="${path}">${renderPublicPage(path).html}</div>`;
  window.history.replaceState(null, "", path);
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const heading = document.querySelector("h1")!;
  vi.resetModules();
  await import("./renderApp.tsx");
  // Each page's metadata effect runs once it has committed.
  await vi.waitFor(() => expect(document.head.querySelector("title[data-pcash-route-metadata]")).not.toBeNull(), { timeout: 10_000 });
  expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([]);
  expect(heading.isConnected).toBe(true);
}, 30_000);
