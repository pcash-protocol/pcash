// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDirectSendLink } from "@pcash/sdk/delivery";
import type { DirectSendOpening } from "@pcash/sdk/protocol";

const PCASH = 10n ** 18n;
const OWNER = `0x${"12".repeat(20)}`;
const state = vi.hoisted(() => ({ wallet: {} as Record<string, any>, inspect: vi.fn() }));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet, errorMessage: (cause: unknown) => cause instanceof Error ? cause.message : String(cause) }));
vi.mock("@pcash/sdk/wallet", async (original) => ({ ...await original<typeof import("@pcash/sdk/wallet")>(), inspectDirectSend: state.inspect }));
vi.mock("../tokens/TokenCommon.tsx", () => ({ WalletPromptButton: () => <button type="button">Connect wallet</button> }));
vi.mock("../wallet/AccountSetupPanel.tsx", () => ({ AccountSetupPanel: () => <section data-testid="account-setup">Set up and mine</section> }));
import ReceivePage from "./ReceivePage.tsx";

const opening: DirectSendOpening = {
  chainId: 1n, contentHash: `0x${"ab".repeat(32)}`, slot: 0, owner: BigInt(OWNER), amount: 4n * PCASH, noteSecret: 0x5eedn,
};
const link = formatDirectSendLink(opening, "/receive");

let element: HTMLDivElement;
let root: Root;
let renders = 0;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.inspect.mockReset().mockResolvedValue({ status: "landed", leafIndex: 5n });
  state.wallet = { phase: "disconnected", node: {}, status: { pcashChainId: 1n }, accountRecord: "unknown" };
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

async function render(path = link) {
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><MemoryRouter key={`${path}:${renders++}`} initialEntries={[path]}><ReceivePage /></MemoryRouter></QueryClientProvider>));
  for (let tick = 0; tick < 3; tick++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const text = () => element.textContent ?? "";
const receiveState = () => element.querySelector("[data-testid=receive-state]")?.getAttribute("data-state");

describe("receiving a direct send", () => {
  it("shows the amount and asks for the wallet of the address it pays", async () => {
    await render();
    expect(element.querySelector("[data-testid=receive-amount]")?.textContent).toBe("4 PCASH");
    expect(text()).toContain(`Connect the wallet for ${OWNER}`);
    expect(state.inspect).toHaveBeenCalledWith(state.wallet.node, opening);
  });

  it("shows the sender's message before any wallet connects, with the sender's claimed address", async () => {
    const sender = `0x${"5e".repeat(20)}`;
    state.inspect.mockResolvedValue({ status: "landed", leafIndex: 5n, memo: "Dinner, thanks!", sender });
    await render();
    expect(element.querySelector("[data-testid=receive-memo]")?.textContent).toBe("Dinner, thanks!");
    expect(text()).toContain("From 0x5e5e5e…5e5e5e (unverified)");
    expect(text()).toContain(`Connect the wallet for ${OWNER}`);
  });

  it("asks another account to switch, and never imports into it", async () => {
    const importDirectSend = vi.fn();
    state.wallet = { ...state.wallet, phase: "ready", connectedAccount: `0x${"34".repeat(20)}`, wallet: { importDirectSend } };
    await render();
    expect(text()).toContain(`This payment is for ${OWNER}. Switch to that account in your wallet.`);
    expect(importDirectSend).not.toHaveBeenCalled();
  });

  it("shows Receiving and setup until the account exists, with the link as the payment's only copy", async () => {
    const importDirectSend = vi.fn(async () => ({ opening, state: "received", saved: false }));
    state.wallet = { ...state.wallet, phase: "activation-required", accountRecord: "absent", connectedAccount: OWNER, wallet: { importDirectSend } };
    await render();
    expect(importDirectSend).toHaveBeenCalledWith(link.slice(link.indexOf("#")));
    expect(receiveState()).toBe("receiving");
    expect(text()).toContain("Receiving 4 PCASH");
    expect(text()).toContain("There is no claim step");
    expect(element.querySelector("[data-testid=account-setup]")).not.toBeNull();
    expect(text()).toContain("Keep this link until your wallet saves the payment");
  });

  it("shows the balance once set up, and drops the notice once a final record saves it", async () => {
    const received = { opening, state: "received", saved: true };
    state.wallet = { ...state.wallet, phase: "ready", accountRecord: "present", connectedAccount: OWNER, wallet: { importDirectSend: async () => received } };
    await render();
    expect(receiveState()).toBe("received");
    expect(text()).toContain("Received. 4 PCASH is in your balance.");
    expect(text()).not.toContain("Keep this link");
  });

  it("waits for a payment that has not landed before importing it", async () => {
    state.inspect.mockResolvedValue({ status: "pending" });
    const importDirectSend = vi.fn();
    state.wallet = { ...state.wallet, phase: "ready", accountRecord: "present", connectedAccount: OWNER, wallet: { importDirectSend } };
    await render();
    expect(text()).toContain("This payment hasn't landed on PCASH yet.");
    expect(text()).toContain("Waiting for the payment to land on PCASH");
    expect(text()).toContain("Keep this link");
    expect(importDirectSend).not.toHaveBeenCalled();
  });

  it("refuses a malformed link, one for another network, and one whose output holds another note", async () => {
    await render("/receive#not-a-payment");
    expect(text()).toContain("This isn't a valid PCASH payment link.");
    await render(formatDirectSendLink({ ...opening, chainId: 2n }, "/receive"));
    expect(text()).toContain("This link is for a different PCASH network.");
    state.inspect.mockResolvedValue({ status: "invalid" });
    await render();
    expect(text()).toContain("This link doesn't match the payment it names.");
    state.inspect.mockResolvedValue({ status: "rejected" });
    await render();
    expect(text()).toContain("This payment didn't go through. Ask the sender to send it again.");
  });
});
