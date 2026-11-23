// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const READY_WALLET = {
  connectedAccount: "0xowner", status: { genesisHash: "0xgenesis" }, profile: {} as object | undefined, wallet: {}, selfPublication: {},
  busy: false, phase: "ready", accountRecord: "present",
};
const state = vi.hoisted(() => ({ wallet: {} as Record<string, unknown> }));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet }));
vi.mock("../wallet/OwnerPanels.tsx", () => ({
  useWalletPanel: () => ({ chooseByLink: () => undefined }),
  SendCard: () => <div data-testid="send-card" />,
  ReceiveCard: ({ address }: { address: string }) => <div data-testid="receive-card">{address}</div>,
}));
import GetRoute from "./GetRoute.tsx";

let element: HTMLDivElement;
let root: Root;
const render = () => act(async () => root.render(<MemoryRouter><GetRoute /></MemoryRouter>));
const sendCard = () => element.querySelector('[data-testid="send-card"]');
const receiveCard = () => element.querySelector('[data-testid="receive-card"]');

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.wallet = { ...READY_WALLET };
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

it("previews sending and points a visitor without an account to setup", async () => {
  state.wallet = { ...state.wallet, phase: "disconnected", connectedAccount: undefined, profile: undefined, wallet: undefined, selfPublication: undefined };
  await render();
  const preview = element.querySelector("section")!;
  expect(preview.querySelector("h2")!.textContent).toBe("Send PCASH");
  expect(preview.textContent).toMatch(/Set up your account above to send\.$/);
  expect(sendCard()).toBeNull();
  expect(receiveCard()).toBeNull();
  const download = element.querySelector('a[href="https://github.com/pcash-protocol/pcash/releases/latest/download/pcash-wallet-darwin-arm64.tar.gz"]');
  expect(download?.textContent).toBe("Download PCASH Wallet for Mac");
  expect(element.querySelector('a[href="/docs/guides/running-a-node#run-the-apple-silicon-testnet-wallet-over-tor"]')?.textContent)
    .toBe("Setup instructions");
});

it("keeps the preview while the account is known to be absent", async () => {
  state.wallet = { ...state.wallet, phase: "activation-required", accountRecord: "absent" };
  await render();
  expect(element.textContent).toContain("Set up your account above to send.");
  expect(sendCard()).toBeNull();
  expect(receiveCard()).toBeNull();
});

it("shows the send form beside the receive card once the account is ready", async () => {
  await render();
  expect(sendCard()).not.toBeNull();
  expect(receiveCard()!.textContent).toBe("0xowner");
  expect(element.textContent).not.toContain("Set up your account above to send.");
});

it("holds the send form until the wallet is ready, keeping the receive card", async () => {
  state.wallet = { ...state.wallet, phase: "syncing" };
  await render();
  expect(sendCard()).toBeNull();
  expect(element.querySelector('[role="status"]')!.textContent).toBe("Send opens when your wallet is ready.");
  expect(receiveCard()!.textContent).toBe("0xowner");
});
