// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  wallet: { phase: "disconnected", signIn: vi.fn(), connect: vi.fn(), beginOnboarding: vi.fn() },
  modal: { openConnectModal: undefined as (() => void) | undefined },
  openConnectModal: vi.fn(),
  account: { status: "disconnected" },
  disconnect: vi.fn(),
  // Components reading the mocks re-render when a test changes them, as context consumers would.
  version: 0,
  listeners: new Set<() => void>(),
}));
async function watched() {
  const { useSyncExternalStore } = await import("react");
  return () => useSyncExternalStore((listener) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); }, () => mocks.version);
}
vi.mock("../../lib/WalletProvider.tsx", async () => { const watch = await watched(); return { useWallet: () => { watch(); return mocks.wallet; } }; });
vi.mock("../../lib/EthereumProvider.tsx", () => ({ useEthereumNetwork: () => ({ ethereumConfig: {} }) }));
vi.mock("@rainbow-me/rainbowkit", async () => { const watch = await watched(); return { useConnectModal: () => { watch(); return { ...mocks.modal }; } }; });
vi.mock("wagmi/actions", () => ({ getAccount: () => mocks.account, disconnect: mocks.disconnect }));
import { useStartWalletOnArrival } from "../../lib/useConnectWallet.ts";
import { HomeRoute } from "./HomeRoute.tsx";

const NativeRequest = Request;
let root: Root;
let element: HTMLDivElement;
let rendered: string;
let onboardedOn: string | undefined;
/** The page the wallet's onboarding would return to: the location React has rendered. */
function Probe() {
  rendered = useLocation().pathname;
  return null;
}
/** Get PCASH's part: it starts the wallet once it has rendered. */
function GetPage() {
  useStartWalletOnArrival();
  return <Probe />;
}

let router: ReturnType<typeof createMemoryRouter>;
const renderRouter = () => act(async () => root.render(<RouterProvider router={router} />));
/** Applies a change to the mocked wallet or RainbowKit state and lets the page react to it. */
const change = (apply: () => void) => act(async () => {
  apply();
  mocks.version += 1;
  for (const listener of mocks.listeners) listener();
});
async function clickMine(init: MouseEventInit = {}) {
  router = createMemoryRouter([{ element: <><Probe /><HomeRoute /></>, path: "/" }, { element: <GetPage />, path: "/get" }]);
  await renderRouter();
  const link = [...element.querySelectorAll<HTMLAnchorElement>("a")].find((candidate) => candidate.textContent === "Mine PCASH")!;
  await act(async () => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })));
}

beforeEach(() => {
  // React Router creates Requests; Node fetch and jsdom use different AbortSignal classes.
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, init === undefined ? undefined : { ...init, signal: null }); }
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.wallet.phase = "disconnected";
  mocks.wallet.signIn.mockReset().mockResolvedValue(undefined);
  mocks.wallet.connect.mockReset().mockResolvedValue(undefined);
  onboardedOn = undefined;
  mocks.wallet.beginOnboarding.mockReset().mockImplementation(() => { onboardedOn = rendered; });
  mocks.openConnectModal.mockReset();
  mocks.modal.openConnectModal = mocks.openConnectModal;
  mocks.account.status = "disconnected";
  mocks.disconnect.mockReset().mockResolvedValue(undefined);
  mocks.listeners.clear();
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.unstubAllGlobals();
});

describe("Mine PCASH", () => {
  it("opens Get PCASH, which opens the wallet picker once and consumes the request", async () => {
    await clickMine();
    expect(router.state.location.pathname).toBe("/get");
    expect(mocks.openConnectModal).toHaveBeenCalledOnce();
    expect(onboardedOn).toBe("/get");
    expect(router.state.location.state).toBeNull();
    await change(() => undefined);
    expect(mocks.openConnectModal).toHaveBeenCalledOnce();
    expect(mocks.wallet.signIn).not.toHaveBeenCalled();
  });

  it("opens the picker after dropping an unfinished connection, although Home has unmounted", async () => {
    // RainbowKit withholds its picker while wagmi is still attempting a connection.
    mocks.modal.openConnectModal = undefined;
    mocks.account.status = "connecting";
    await clickMine();
    expect(router.state.location.pathname).toBe("/get");
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(mocks.openConnectModal).not.toHaveBeenCalled();
    await change(() => { mocks.modal.openConnectModal = mocks.openConnectModal; });
    expect(mocks.openConnectModal).toHaveBeenCalledOnce();
  });

  it("waits for the saved connection to resolve before choosing the step", async () => {
    mocks.wallet.phase = "initializing";
    await clickMine();
    expect(mocks.openConnectModal).not.toHaveBeenCalled();
    expect(mocks.wallet.signIn).not.toHaveBeenCalled();
    await change(() => { mocks.wallet.phase = "sign-in-required"; });
    expect(mocks.wallet.signIn).toHaveBeenCalledOnce();
    expect(mocks.openConnectModal).not.toHaveBeenCalled();
  });

  it("keeps the request while a saved connection is restored, then starts sign-in once", async () => {
    mocks.wallet.phase = "initializing";
    await clickMine();
    await change(() => { mocks.wallet.phase = "connecting"; });
    expect(router.state.location.state).not.toBeNull();
    expect(mocks.wallet.signIn).not.toHaveBeenCalled();
    await change(() => { mocks.wallet.phase = "sign-in-required"; });
    expect(mocks.wallet.signIn).toHaveBeenCalledOnce();
    expect(router.state.location.state).toBeNull();
    await change(() => undefined);
    expect(mocks.wallet.signIn).toHaveBeenCalledOnce();
    expect(mocks.openConnectModal).not.toHaveBeenCalled();
  });

  it("starts nothing when a restored connection is already signing in", async () => {
    mocks.wallet.phase = "connecting";
    await clickMine();
    await change(() => { mocks.wallet.phase = "opening"; });
    expect(router.state.location.state).toBeNull();
    expect(mocks.wallet.signIn).not.toHaveBeenCalled();
    expect(mocks.openConnectModal).not.toHaveBeenCalled();
  });

  it("starts sign-in for a connected wallet that is not signed in", async () => {
    mocks.wallet.phase = "sign-in-required";
    await clickMine();
    expect(router.state.location.pathname).toBe("/get");
    expect(mocks.wallet.signIn).toHaveBeenCalledOnce();
    expect(mocks.openConnectModal).not.toHaveBeenCalled();
  });

  it("only opens Get PCASH for a signed-in wallet", async () => {
    mocks.wallet.phase = "ready";
    await clickMine();
    expect(router.state.location.pathname).toBe("/get");
    expect(mocks.openConnectModal).not.toHaveBeenCalled();
    expect(mocks.wallet.signIn).not.toHaveBeenCalled();
  });

  it("starts nothing for a click that opens a new tab", async () => {
    // jsdom cannot open the tab the browser would.
    element.addEventListener("click", (event) => event.preventDefault());
    await clickMine({ metaKey: true });
    expect(router.state.location.pathname).toBe("/");
    expect(mocks.openConnectModal).not.toHaveBeenCalled();
  });
});
