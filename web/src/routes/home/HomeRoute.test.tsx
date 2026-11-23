// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ l1ChainId: 11155111 }));
vi.mock("../../components/NetworkContext.tsx", () => ({ useNetwork: () => ({ network }) }));
import { HomeRoute } from "./HomeRoute.tsx";

const NativeRequest = Request;
let root: Root;
let element: HTMLDivElement;
let router: ReturnType<typeof createMemoryRouter>;

async function renderHome() {
  router = createMemoryRouter([{ element: <HomeRoute />, path: "/" }, { element: <p>Get PCASH page</p>, path: "/get" }]);
  await act(async () => root.render(<RouterProvider router={router} />));
  return element.querySelector<HTMLAnchorElement>('a[href="/get"]')!;
}

beforeEach(() => {
  // React Router creates Requests; Node fetch and jsdom use different AbortSignal classes.
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, init === undefined ? undefined : { ...init, signal: null }); }
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  network.l1ChainId = 11155111;
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.unstubAllGlobals();
});

it("labels the button for testnet unless the L1 is Ethereum mainnet", async () => {
  expect((await renderHome()).textContent).toBe("Try the testnet");
  await act(async () => root.unmount());
  root = createRoot(element);
  network.l1ChainId = 1;
  expect((await renderHome()).textContent).toBe("Get PCASH");
});

it("opens Get PCASH without asking it to start a wallet connection", async () => {
  const link = await renderHome();
  await act(async () => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
  expect(router.state.location.pathname).toBe("/get");
  expect(router.state.location.state).toBeNull();
});
