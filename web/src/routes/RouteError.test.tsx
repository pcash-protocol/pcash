// @vitest-environment jsdom
import { act, lazy, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RouteError } from "./RouteError.tsx";

const MISSING_CHUNK = "Failed to fetch dynamically imported module: https://example.test/assets/MarketplaceRoute-old.js";
const StalePage = lazy(() => Promise.reject(new TypeError(MISSING_CHUNK)));

let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount()); element.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("replaces a page whose chunk failed to load inside the site chrome and offers a reload", async () => {
  const reload = vi.fn();
  vi.stubGlobal("location", { ...window.location, reload });
  const router = createMemoryRouter([{
    element: <><header>Site header</header><Suspense fallback="Loading"><Outlet /></Suspense></>,
    children: [{ errorElement: <RouteError />, children: [{ path: "/marketplace", element: <StalePage /> }] }],
  }], { initialEntries: ["/marketplace"] });
  await act(async () => root.render(<RouterProvider router={router} />));
  await vi.waitFor(() => expect(element.querySelector('[role="alert"]')).not.toBeNull());

  expect(element.textContent).toContain("Site header");
  expect(element.querySelector("h1")?.textContent).toBe("This page could not load");
  expect(element.textContent).toContain(MISSING_CHUNK);
  expect(element.textContent).not.toContain("Unexpected Application Error");
  await act(async () => element.querySelector<HTMLButtonElement>("button")!.click());
  expect(reload).toHaveBeenCalledOnce();
});
