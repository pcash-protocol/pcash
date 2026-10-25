// @vitest-environment jsdom
import { GetActivityProvider, useGetActivity } from "../lib/GetActivity.tsx";
import { WebsiteSettingsProvider, WEBSITE_SETTINGS_KEY } from "../lib/WebsiteSettings.tsx";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({
  phase: "ready", busy: false, accountRecord: "absent", syncState: { state: "idle" }, connectedAccount: `0x${"12".repeat(20)}` as string | undefined,
  status: { l1ChainId: 1n, pcashChainId: 1n, genesisHash: "genesis", latestBlockHash: "head", latestBlockTimestamp: 100n },
  profile: { address: 1n, nkRoot: 22n }, snapshot: undefined,
  funds: { total: 12n * 10n ** 18n, spendablePrivate: 12n * 10n ** 18n }, paymentActivity: [], awaitingConfirmation: new Map(), paymentStage: { state: "idle" },
  node: { getIssuanceQuote: vi.fn(), getSubmission: vi.fn() },
  wallet: { address: `0x${"12".repeat(20)}`, preflightMine: vi.fn(), mine: vi.fn(), hasReceiveKey: async () => true },
  selfPublication: { mode: "l1", submit: vi.fn() }, runAction: (action: () => Promise<unknown>) => action(),
  submissionLock: undefined as { transactionHash: string | null } | undefined,
  setupAccount: vi.fn(), checkAccountActivation: vi.fn(), clearError: vi.fn(), cancelPrivateSend: vi.fn(), resetPrivateSend: vi.fn(), cancelOnboarding: vi.fn(), disconnect: vi.fn(),
}));
vi.mock("../lib/WalletProvider.tsx", () => ({ useWallet: () => wallet, errorMessage: String }));
vi.mock("../lib/EthereumProvider.tsx", () => ({ useEthereumNetwork: () => ({ ethereumConfig: {} }) }));
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ connectModalOpen: false }) }));
vi.mock("../lib/useNativeActivity.ts", () => ({ useNativeActivity: () => ({ activity: undefined, failed: false, checking: false }) }));
vi.mock("../lib/usePaymentIssuance.ts", () => ({ usePaymentIssuance: () => ({ issuance: undefined, inputs: undefined }) }));
// The toast watcher has its own tests; the panel tests do not drive wallet events.
vi.mock("./WalletPanelToasts.tsx", async (original) => ({ ...await original<typeof import("./WalletPanelToasts.tsx")>(), WalletToastWatcher: () => null }));
vi.mock("../routes/wallet/Activity.tsx", () => ({ Activity: () => null }));
import { WalletPanel } from "./WalletPanel.tsx";
import { OwnerPanelsProvider, useWalletPanel } from "../routes/wallet/OwnerPanels.tsx";
import { HomeRoute } from "../routes/home/HomeRoute.tsx";

const PAYEE = `0x${"34".repeat(20)}`;
let root: Root;
let element: HTMLDivElement;
let setGetActivity: ReturnType<typeof useGetActivity>["setActivity"];
let navigate: NavigateFunction;
function Navigation() {
  setGetActivity = useGetActivity().setActivity;
  navigate = useNavigate();
  const panel = useWalletPanel();
  const location = useLocation();
  return <><button data-testid="account" onClick={panel.openOverview}>Account</button><button onClick={panel.showPanel}>Reopen</button><button onClick={() => panel.openSendTo(PAYEE)}>Pay</button><output data-testid="location">{location.pathname}{location.search}{location.hash}</output></>;
}
const queryClient = new QueryClient();
function tree(path: string) {
  return <QueryClientProvider client={queryClient}><WebsiteSettingsProvider><MemoryRouter initialEntries={[path]}><GetActivityProvider><OwnerPanelsProvider><Navigation /><WalletPanel /><HomeRoute /></OwnerPanelsProvider></GetActivityProvider></MemoryRouter></WebsiteSettingsProvider></QueryClientProvider>;
}
beforeEach(() => {
  localStorage.setItem(WEBSITE_SETTINGS_KEY, JSON.stringify({ ensEnabled: false, defaultSubmissionMode: "slow" }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
  wallet.submissionLock = undefined;
  wallet.phase = "ready";
  wallet.accountRecord = "present";
  wallet.disconnect.mockReset().mockResolvedValue(undefined);
  wallet.setupAccount.mockReset().mockResolvedValue(undefined);
  wallet.checkAccountActivation.mockReset().mockResolvedValue(undefined);
  wallet.connectedAccount = `0x${"12".repeat(20)}`;
  wallet.status = { l1ChainId: 1n, pcashChainId: 1n, genesisHash: "genesis", latestBlockHash: "head", latestBlockTimestamp: 100n };
  wallet.funds = { total: 12n * 10n ** 18n, spendablePrivate: 12n * 10n ** 18n };
  wallet.node.getIssuanceQuote.mockReset().mockResolvedValue({ rewardPossible: true, exhausted: false, maxSingleActionReward: 100n * 10n ** 18n });
  wallet.node.getSubmission.mockReset().mockReturnValue(new Promise(() => undefined));
  wallet.wallet.preflightMine.mockReset().mockResolvedValue({});
  wallet.wallet.mine.mockReset().mockResolvedValue({ contentHash: "content" });
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });
const panel = () => element.querySelector<HTMLDialogElement>('[data-testid="wallet-panel"]')!;
const location = () => element.querySelector('[data-testid="location"]')!.textContent;
async function click(label: string) {
  const button = [...element.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label)!;
  expect(button, label).toBeDefined();
  await act(async () => button.click());
}

describe("Get PCASH navigation", () => {
  it("keeps the requested recipient through setup and opens Send only when ready", async () => {
    const recipient = `0x${"34".repeat(20)}`;
    const path = `/alice.eth?to=${recipient}#send`;
    wallet.phase = "activation-required";
    wallet.accountRecord = "absent";
    await act(async () => root.render(tree(path)));
    expect(panel().querySelector("#send")).toBeNull();
    await click("Set up and mine");
    expect(location()).toBe(path);
    wallet.phase = "ready";
    wallet.accountRecord = "present";
    await act(async () => root.render(tree(path)));
    expect(panel().getAttribute("data-view")).toBe("send");
    expect(panel().querySelector<HTMLInputElement>("#send input")!.value).toBe(recipient);
    expect(wallet.wallet.preflightMine).not.toHaveBeenCalled();
    expect(wallet.wallet.mine).not.toHaveBeenCalled();
  });
  it("keeps the sidebar open when the connected account finishes restoring", async () => {
    wallet.phase = "connecting";
    wallet.connectedAccount = undefined;
    await act(async () => root.render(tree("/")));
    await click("Account");
    wallet.connectedAccount = `0x${"12".repeat(20)}`;
    wallet.phase = "sign-in-required";
    await act(async () => root.render(tree("/")));
    expect(panel().open).toBe(true);
    expect(panel().querySelector('[data-testid="account-setup"]')).not.toBeNull();
    expect(location()).toBe("/");
  });
  it("offers Disconnect as the only session action in the footer", async () => {
    await act(async () => root.render(tree("/#wallet")));
    const buttons = [...panel().querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toContain("Disconnect");
    expect(buttons).not.toContain("Sign out");
    await click("Disconnect");
    expect(wallet.disconnect).toHaveBeenCalledOnce();
    expect(panel().open).toBe(true);
  });
  it("links from the home page without opening the wallet or starting a proof", async () => {
    await act(async () => root.render(tree("/?unit=pcash")));
    const link = [...element.querySelectorAll<HTMLAnchorElement>("a")].find(candidate => candidate.textContent === "Mine PCASH")!;
    await act(async () => link.click());
    expect(location()).toBe("/get");
    expect(panel().open).toBe(false);
    expect(wallet.wallet.mine).not.toHaveBeenCalled();
    expect(wallet.node.getIssuanceQuote).not.toHaveBeenCalled();
  });

  it("closes the wallet when following its Get PCASH link", async () => {
    await act(async () => root.render(tree("/explorer#wallet")));
    await act(async () => panel().querySelector<HTMLAnchorElement>('a[href="/get"]')!.click());
    expect(location()).toBe("/get");
    expect(panel().open).toBe(false);
    expect(wallet.wallet.mine).not.toHaveBeenCalled();
  });

  it("opens recovery from a page link and clears its hash when closed", async () => {
    await act(async () => root.render(tree("/marketplace#ethereum-submission")));
    expect(panel().getAttribute("data-view")).toBe("ethereum-submission");
    expect(panel().textContent).toContain("No Ethereum submission is blocking your wallet.");
    await act(async () => panel().querySelector<HTMLButtonElement>('[aria-label="Close wallet"]')!.click());
    expect(location()).toBe("/marketplace");
    expect(panel().open).toBe(false);
  });

  it("does not treat the removed mine hash as a wallet view", async () => {
    await act(async () => root.render(tree("/#mine")));
    expect(panel().open).toBe(false);
    expect(wallet.wallet.mine).not.toHaveBeenCalled();
  });
});


describe("profile Send", () => {
  const closeWallet = () => act(async () => panel().querySelector<HTMLButtonElement>('[aria-label="Close wallet"]')!.click());
  const recipientInput = () => panel().querySelector<HTMLInputElement>("#send input")!;

  it("sets the recipient every time it opens, replacing an edited draft", async () => {
    await act(async () => root.render(tree("/")));
    await click("Pay");
    expect(panel().getAttribute("data-view")).toBe("send");
    expect(recipientInput().value).toBe(PAYEE);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(recipientInput(), "0x1234");
      recipientInput().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await closeWallet();
    await click("Pay");
    expect(panel().open).toBe(true);
    expect(recipientInput().value).toBe(PAYEE);
  });

  it("says a payment is waiting through setup and opens Send when ready", async () => {
    wallet.phase = "activation-required";
    wallet.accountRecord = "absent";
    await act(async () => root.render(tree("/")));
    await click("Pay");
    expect(panel().getAttribute("data-view")).toBe("overview");
    expect(panel().querySelector('[data-testid="waiting-payment"]')!.textContent).toBe("Payment to 0x3434…3434Set up PCASH to continue.");
    wallet.phase = "ready";
    wallet.accountRecord = "present";
    await act(async () => root.render(tree("/")));
    expect(panel().open).toBe(true);
    expect(panel().getAttribute("data-view")).toBe("send");
    expect(recipientInput().value).toBe(PAYEE);
  });

  it.each([
    ["disconnected", "Connect your wallet to continue."],
    ["sign-in-required", "Sign in to continue."],
    ["activation-required", "Set up PCASH to continue."],
  ])("drops a waiting payment when the panel is closed (%s)", async (phase, detail) => {
    wallet.phase = phase;
    if (phase === "disconnected") wallet.connectedAccount = undefined;
    await act(async () => root.render(tree("/")));
    await click("Pay");
    expect(panel().querySelector('[data-testid="waiting-payment"]')!.textContent).toContain(detail);
    await closeWallet();
    wallet.phase = "ready";
    await act(async () => root.render(tree("/")));
    expect(panel().open).toBe(false);
  });

  it("drops a waiting payment when the visitor leaves the page it was started on", async () => {
    wallet.phase = "sign-in-required";
    await act(async () => root.render(tree("/alice.eth")));
    await click("Pay");
    expect(panel().querySelector('[data-testid="waiting-payment"]')).not.toBeNull();
    await act(async () => navigate("/bob.eth"));
    expect(panel().querySelector('[data-testid="waiting-payment"]')).toBeNull();
    wallet.phase = "ready";
    await act(async () => root.render(tree("/alice.eth")));
    expect(panel().getAttribute("data-view")).not.toBe("send");
  });
});

it("keeps a send draft and its selection when visiting settings", async () => {
  await act(async () => root.render(tree("/#send")));
  const recipient = panel().querySelector<HTMLInputElement>("#send input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(recipient, "0x1234");
    recipient.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const gear = () => panel().querySelector<HTMLButtonElement>('[aria-label="Wallet settings"]')!;
  await act(async () => gear().click());
  const savedMode = panel().querySelector<HTMLInputElement>('section[aria-label="Wallet settings"] input[value="fast"]')!;
  await act(async () => savedMode.click());
  await click("← Back");
  expect(panel().querySelector<HTMLInputElement>("#send input")!.value).toBe("0x1234");
  expect(panel().querySelector<HTMLInputElement>('#send input[value="slow"]')!.checked).toBe(true);
  expect(panel().open).toBe(true);
});

it("keeps a pending submission out of the overview", async () => {
  wallet.submissionLock = { transactionHash: null };
  await act(async () => root.render(tree("/#wallet")));
  expect(panel().getAttribute("data-view")).toBe("overview");
  expect(panel().querySelector('[aria-label="Ethereum submission"]')).toBeNull();
  expect(panel().textContent).not.toContain("Confirm");
});

it("opens overview after the previously viewed submission clears", async () => {
  wallet.submissionLock = { transactionHash: null };
  await act(async () => root.render(tree("/marketplace#ethereum-submission")));
  await act(async () => panel().querySelector<HTMLButtonElement>('[aria-label="Close wallet"]')!.click());
  wallet.submissionLock = undefined;
  await act(async () => root.render(tree("/marketplace")));
  await click("Reopen");
  expect(panel().getAttribute("data-view")).toBe("overview");
});

it("asks before disconnecting during unsubmitted Get PCASH work", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await act(async () => root.render(tree("/get#wallet")));
  await act(async () => setGetActivity({ working: true, unsafeToLeave: true }));
  await click("Disconnect");
  expect(confirm).toHaveBeenCalledOnce();
  expect(wallet.disconnect).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await click("Disconnect");
  expect(wallet.disconnect).toHaveBeenCalledOnce();
  confirm.mockRestore();
});
