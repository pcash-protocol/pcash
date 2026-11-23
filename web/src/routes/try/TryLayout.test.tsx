// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const PCASH = 10n ** 18n;
const READY_WALLET = {
  connectedAccount: "0xowner", status: { genesisHash: "0xgenesis" }, profile: {} as object | undefined, wallet: {}, selfPublication: {},
  submissionLock: undefined as unknown, busy: false, phase: "ready", progress: undefined, accountRecord: "present",
};
const DISCONNECTED = { phase: "disconnected", connectedAccount: undefined, profile: undefined, wallet: undefined, selfPublication: undefined };
const state = vi.hoisted(() => ({
  wallet: {} as Record<string, unknown>,
  connect: vi.fn(),
  networkFee: 0n as bigint | undefined,
  first: undefined as unknown,
  panel: { chooseByLink: vi.fn() },
}));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet }));
// The network fee the SDK quotes for setup.
vi.mock("../../lib/useNetworkFee.ts", () => ({ S_ACTION_UNITS: 4n, S_ACTION_WITH_ACCOUNT_UNITS: 5n, useNetworkFee: () => state.networkFee }));
vi.mock("../../lib/useConnectWallet.ts", () => ({ useConnectWallet: () => state.connect }));
vi.mock("../../lib/EthereumProvider.tsx", () => ({ useEthereumNetwork: () => ({ l1Chain: { blockExplorers: { default: { name: "Etherscan", url: "https://etherscan.io" } } } }) }));
vi.mock("../wallet/AccountSetupPanel.tsx", () => ({ AccountSetupPanel: () => <section data-testid="account-setup"><button type="button">Sign in</button></section> }));
vi.mock("../get/useFirstPcash.ts", () => ({ useFirstPcash: (enabled: boolean) => enabled ? state.first : undefined }));
vi.mock("../wallet/OwnerPanels.tsx", () => ({ useWalletPanel: () => state.panel }));
import { TryLayout } from "./TryLayout.tsx";

let element: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;
const render = (path = "/get") => {
  router = createMemoryRouter([{ element: <TryLayout />, children: [{ path: "*", element: <p data-testid="tab-page">Tab page</p> }] }], { initialEntries: [path] });
  return act(async () => root.render(<RouterProvider router={router} />));
};
const panel = () => element.querySelector("section")!;
const first = () => element.querySelector('[data-testid="first-pcash"]');
const firstButton = (label: string) => [...first()!.querySelectorAll("button")].find((node) => node.textContent?.startsWith(label))!;
const currentTabs = () => [...element.querySelectorAll('nav a[aria-current="page"]')].map((node) => node.textContent);

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.networkFee = 0n;
  state.wallet = { ...READY_WALLET };
  state.first = undefined;
  state.connect.mockReset();
  state.panel.chooseByLink.mockReset();
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

it("gives a disconnected visitor Connect wallet, Show ENS names, the terms and the connect error", async () => {
  state.wallet = { ...state.wallet, ...DISCONNECTED, error: "Could not reach the network. Check your connection and try again." };
  await render();
  expect(panel().querySelector("h2")!.textContent).toBe("Get your first PCASH");
  expect(panel().textContent).toContain("Connect an Ethereum wallet to get your first PCASH.");
  expect(panel().querySelector('[role="alert"]')!.textContent).toBe("Could not reach the network. Check your connection and try again.");
  expect(panel().textContent).toContain("By connecting a wallet, you agree to the Terms of Service.");
  expect(panel().querySelector('a[href="/terms"]')).not.toBeNull();
  const connect = [...panel().querySelectorAll("button")].find((node) => node.textContent === "Connect wallet")!;
  const ens = panel().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(ens.closest("label")!.textContent).toBe("Show ENS names");
  expect(connect.compareDocumentPosition(ens) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async () => connect.click());
  expect(state.connect).toHaveBeenCalledOnce();
});

it("puts the wallet's sign-in step beside the steps when connected but locked", async () => {
  state.wallet = { ...state.wallet, phase: "sign-in-required", profile: undefined };
  await render();
  expect(panel().querySelector('[data-testid="account-setup"]')).not.toBeNull();
  expect(element.querySelectorAll('[data-testid="account-setup"]')).toHaveLength(1);
  expect(element.querySelector('[data-testid="account-ready"]')).toBeNull();
});

it("shows no next step while the saved connection is still resolving", async () => {
  state.wallet = { ...state.wallet, phase: "initializing", connectedAccount: undefined, profile: undefined, wallet: undefined, selfPublication: undefined };
  await render();
  expect(panel().querySelector('[data-testid="account-setup"]')).toBeNull();
  expect(panel().querySelector("button")).toBeNull();
});

it("tells a visitor that setup needs PCASH while the network fee is above zero", async () => {
  state.networkFee = 100n * PCASH;
  state.wallet = { ...state.wallet, ...DISCONNECTED };
  await render();
  expect(panel().querySelector('[data-testid="network-fee-funding"]')!.textContent).toContain("Setup needs PCASH right now.");
  expect([...panel().querySelectorAll("button")].some((node) => node.textContent === "Connect wallet")).toBe(true);
});

it("gives a signed-in wallet without an account the setup step and the three steps", async () => {
  state.wallet = { ...state.wallet, phase: "activation-required", accountRecord: "absent" };
  await render();
  expect(element.querySelector("h1")!.textContent).toBe("Try PCASH");
  expect(panel().querySelector('[data-testid="account-setup"]')).not.toBeNull();
  expect([...panel().querySelectorAll("ol strong")].map((node) => node.textContent)).toEqual(["Get PCASH", "Send it", "Earn more"]);
  expect(element.querySelector('[data-testid="account-ready"]')).toBeNull();
});

it("shows what setup paid and the payment to try next", async () => {
  state.first = { amount: 838n * PCASH, l1TransactionHash: "0xsetup" };
  await render();
  expect(first()!.querySelector("h2")!.textContent).toBe("Your PCASH is ready.");
  expect(first()!.textContent).toContain("838 PCASH");
  expect(first()!.querySelector('a[href="https://etherscan.io/tx/0xsetup"]')).not.toBeNull();
  expect(panel().querySelector("ol li")!.textContent).toContain("Done.");
  // Right after setup there is nothing on the account page this screen lacks.
  expect(first()!.querySelector('a[href="/account"]')).toBeNull();
  expect(element.querySelector('[data-testid="account-ready"]')).toBeNull();
  await act(async () => firstButton("Done").click());
  expect(first()).toBeNull();
  expect(element.querySelector('[data-testid="account-ready"]')).not.toBeNull();
});

it("keeps the send buttons off until the wallet is ready", async () => {
  state.first = { amount: 838n * PCASH };
  state.wallet = { ...state.wallet, phase: "syncing" };
  await render();
  expect(firstButton("Send PCASH").disabled).toBe(true);
  expect(firstButton("Send it by link").disabled).toBe(true);
  expect(firstButton("Done").disabled).toBe(false);
});

it("waits for the setup receipt before naming the amount", async () => {
  state.first = {};
  await render();
  expect(first()!.querySelector(".spinner")).not.toBeNull();
  expect(first()!.textContent).not.toContain("PCASH ·");
  expect(first()!.querySelector('a[href^="https://etherscan.io"]')).toBeNull();
});

it("opens the Pay tab with a direct payment from Send PCASH", async () => {
  state.first = { amount: 838n * PCASH };
  await render("/get/earn");
  await act(async () => firstButton("Send PCASH").click());
  expect(state.panel.chooseByLink).toHaveBeenCalledExactlyOnceWith(false);
  expect(router.state.location.pathname).toBe("/get");
  expect(first()).toBeNull();
});

it("opens the Pay tab with a claim link from Send it by link", async () => {
  state.first = { amount: 838n * PCASH };
  await render("/tokens");
  await act(async () => firstButton("Send it by link").click());
  expect(state.panel.chooseByLink).toHaveBeenCalledExactlyOnceWith(true);
  expect(router.state.location.pathname).toBe("/get");
});

it("replaces setup with a line that links to the account once the account is ready", async () => {
  await render();
  const line = element.querySelector('[data-testid="account-ready"]')!;
  expect(line.textContent).toContain("Your account is ready.");
  const link = line.querySelector("a")!;
  expect(link.textContent).toBe("View your account →");
  expect(link.getAttribute("href")).toBe("/account");
  expect(element.querySelector("section")).toBeNull();
  expect(element.querySelector('[data-testid="tab-page"]')).not.toBeNull();
});

it("links each tab and marks the one the path belongs to", async () => {
  await render();
  expect([...element.querySelectorAll("nav a")].map((node) => [node.textContent, node.getAttribute("href")]))
    .toEqual([["Pay", "/get"], ["Earn", "/get/earn"], ["Tokens", "/tokens"], ["Anonymous board", "/board"]]);
  const expected: [string, string][] = [["/get", "Pay"], ["/get/", "Pay"], ["/get/earn", "Earn"], ["/tokens", "Tokens"], ["/tokens/new", "Tokens"],
    ["/token/0xabc", "Tokens"], ["/drop/abc", "Tokens"], ["/board", "Anonymous board"], ["/board/0xabc", "Anonymous board"]];
  for (const [path, label] of expected) {
    await act(async () => router.navigate(path));
    expect(currentTabs(), path).toEqual([label]);
  }
});
