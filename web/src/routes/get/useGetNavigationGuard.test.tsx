// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useGetNavigationGuard } from "./useGetNavigationGuard.ts";
const NativeRequest = Request;
let active: boolean;
let element: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;
function Page() { useGetNavigationGuard(active); return <p>Get PCASH</p>; }
beforeEach(async () => {
  active = true;
  // React Router creates Requests; Node fetch and jsdom use different AbortSignal classes.
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, init === undefined ? undefined : { ...init, signal: null }); }
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "confirm").mockReturnValue(false);
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
  router = createMemoryRouter([{ path: "/get", element: <Page /> }, { path: "/explorer", element: <p>Explorer</p> }], { initialEntries: ["/get"] });
  await act(async () => root.render(<RouterProvider router={router} />));
});
afterEach(async () => { await act(async () => root.unmount()); router.dispose(); element.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("keeps proving when leaving is declined", async () => {
  await act(async () => router.navigate("/explorer"));
  expect(window.confirm).toHaveBeenCalledOnce();
  expect(router.state.location.pathname).toBe("/get");
});
it("leaves after the user confirms discarded work", async () => {
  vi.mocked(window.confirm).mockReturnValue(true);
  await act(async () => router.navigate("/explorer"));
  expect(router.state.location.pathname).toBe("/explorer");
});
it("opens recovery without warning or leaving the page", async () => {
  await act(async () => router.navigate("/get#ethereum-submission"));
  expect(window.confirm).not.toHaveBeenCalled();
  expect(router.state.location.hash).toBe("#ethereum-submission");
});
it("does not warn for an idle page", async () => {
  active = false;
  await act(async () => router.navigate("/get?refresh=1"));
  await act(async () => router.navigate("/explorer"));
  expect(window.confirm).not.toHaveBeenCalled();
  expect(router.state.location.pathname).toBe("/explorer");
});
