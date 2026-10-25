// @vitest-environment jsdom
import { WebsiteSettingsProvider, WEBSITE_SETTINGS_KEY } from "../lib/WebsiteSettings.tsx";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletPanel } from "./WalletPanel.tsx";
import { OwnerPanelsProvider, useWalletPanel } from "../routes/wallet/OwnerPanels.tsx";

const state = vi.hoisted(() => ({ wallet: {} as Record<string, unknown> }));
vi.mock("../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet, errorMessage: String }));
const connect = vi.hoisted(() => ({ connectModalOpen: false, openConnectModal: undefined as (() => void) | undefined, wagmiStatus: "disconnected", disconnect: undefined as unknown as () => Promise<void> }));
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ openConnectModal: connect.openConnectModal, connectModalOpen: connect.connectModalOpen }) }));
vi.mock("wagmi/actions", () => ({ getAccount: () => ({ status: connect.wagmiStatus }), disconnect: () => connect.disconnect() }));
vi.mock("../lib/EthereumProvider.tsx", () => ({ useEthereumNetwork: () => ({ ethereumConfig: {} }) }));
vi.mock("../lib/useNativeActivity.ts", () => ({ useNativeActivity: () => ({ checking: false, failed: false, activity: { state: "ready", entries: [], received: 0n, spent: 0n } }) }));
vi.mock("../lib/usePaymentIssuance.ts", () => ({ usePaymentIssuance: () => ({ issuance: undefined, inputs: undefined }) }));
// The toast watcher has its own tests; the panel tests do not drive wallet events.
vi.mock("./WalletPanelToasts.tsx", async (original) => ({ ...await original<typeof import("./WalletPanelToasts.tsx")>(), WalletToastWatcher: () => null }));
vi.mock("./NetworkContext.tsx", () => ({ useNetwork: () => ({ network: { l1ChainId: 1, pcashChainId: 1 } }) }));
const address = `0x${"12".repeat(20)}`;
let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  localStorage.setItem(WEBSITE_SETTINGS_KEY, JSON.stringify({ ensEnabled: false, defaultSubmissionMode: "slow" }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  state.wallet = { connectedAccount: address, phase: "sign-in-required", accountRecord: "absent", busy: false,
    cancelPrivateSend: vi.fn(), paymentStage: { state: "idle" }, paymentActivity: [], awaitingConfirmation: new Map(), syncState: { state: "idle" }, funds: { total: 500_000_000_000_000_000n },
    setupAccount: vi.fn(async () => undefined), signIn: vi.fn(async () => undefined) };
  connect.connectModalOpen = false;
  connect.openConnectModal = vi.fn();
  connect.wagmiStatus = "disconnected";
  connect.disconnect = vi.fn(async () => undefined);
  HTMLDialogElement.prototype.show = function () { this.open = true; };
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });
function Opener() { const panel = useWalletPanel(); return <button type="button" onClick={panel.showPanel}>Open</button>; }
const queryClient = new QueryClient();
const render = () => act(async () => root.render(<QueryClientProvider client={queryClient}><WebsiteSettingsProvider><MemoryRouter initialEntries={["/explorer#wallet"]}><OwnerPanelsProvider><Opener /><WalletPanel /></OwnerPanelsProvider></MemoryRouter></WebsiteSettingsProvider></QueryClientProvider>));
const button = (label: string) => [...element.querySelectorAll("button")].find((node) => node.textContent === label)!;
it("offers Sign in while connected but locked", async () => {
  state.wallet.accountRecord = "unknown";
  await render();
  expect(button("Set up and mine")).toBeUndefined();
  await act(async () => button("Sign in").click());
  expect(state.wallet.signIn).toHaveBeenCalledOnce();
  expect(state.wallet.setupAccount).not.toHaveBeenCalled();
});
it("opens setup in the drawer and keeps it open while setup progresses", async () => {
  state.wallet.phase = "activation-required";
  await render();
  expect(element.querySelector("dialog")?.open).toBe(true);
  await act(async () => button("Set up and mine").click());
  expect(state.wallet.setupAccount).toHaveBeenCalledOnce();
  state.wallet.phase = "activating"; state.wallet.busy = true;
  await render();
  expect(element.querySelector("dialog")?.open).toBe(true);
  expect(element.textContent).toContain("Setting up…");
  expect(element.querySelector(`a[href="/${address}"]`)).not.toBeNull();
});
it("keeps balance, receiving and activity in the drawer and links to Get PCASH", async () => {
  state.wallet.phase = "ready"; state.wallet.profile = { address: BigInt(address), nkRoot: 22n }; state.wallet.accountRecord = "present";
  await render();
  expect(element.textContent).toContain("<1 PCASH");
  expect(element.querySelector('a[href="/get"]')).not.toBeNull();
  expect(button("Send")).toBeDefined();
  expect(element.querySelector("#wallet-activity")).not.toBeNull();
  await act(async () => button("Receive").click());
  expect(element.querySelector("#receive code")?.textContent).toBe(`${location.origin}/${address}`);
  expect(element.querySelector('#receive [aria-label="Copy profile link"]')).not.toBeNull();
  expect(element.querySelector("#receive svg[role=img]")).not.toBeNull();
  expect(element.querySelector("textarea")).toBeNull();
  expect(element.querySelector("dialog")?.open).toBe(true);
});
it("lists token balances by symbol, or by ID when unverified, linking to each token page", async () => {
  const { testDefinition } = await import("../routes/tokens/tokenTestSupport.ts");
  const { assetDefinitionAssetId } = await import("@pcash/sdk/protocol");
  const definition = testDefinition("Harbor Credit", "HBR", 2);
  const verifiedId = assetDefinitionAssetId(definition);
  const unknownId = 0x1234n;
  state.wallet.phase = "ready"; state.wallet.profile = { address: BigInt(address), nkRoot: 22n }; state.wallet.accountRecord = "present";
  state.wallet.snapshot = { assets: [
    { assetId: verifiedId, definition, private: 123_456n, spendable: 123_456n, created: true },
    { assetId: unknownId, definition: null, private: 5n, spendable: 5n, created: false },
  ] };
  await render();
  const rows = [...element.querySelectorAll("a[data-token-row]")];
  expect(rows.map((row) => row.getAttribute("href"))).toEqual([`/token/0x${verifiedId.toString(16).padStart(64, "0")}`, `/token/0x${"0".repeat(60)}1234`]);
  expect(rows[0]!.textContent).toContain("Harbor Credit");
  expect(rows[0]!.textContent).toContain("1,234.56 HBR");
  expect(rows[1]!.textContent).toContain("Unverified token");
  expect(rows[1]!.textContent).toContain("5 units");
  expect(element.querySelector('a[href="/tokens"]')?.textContent).toBe("All tokens →");
});

it("offers one network switch action inside the drawer", async () => {
  state.wallet.phase = "wrong-network";
  state.wallet.switchNetwork = vi.fn(async () => undefined);
  await render();
  expect([...element.querySelectorAll("button")].filter((node) => node.textContent === "Switch network")).toHaveLength(1);
  await act(async () => button("Switch network").click());
  expect(state.wallet.switchNetwork).toHaveBeenCalledOnce();
});
it("shows a failed mining entry while account setup still needs attention", async () => {
  state.wallet.phase = "activation-required";
  state.wallet.profile = { address: BigInt(address), nkRoot: 22n };
  state.wallet.paymentActivity = [{ contentHash: "0xmining", deliveryTarget: address, recipientAddress: address,
    amount: 0n, openFeeAmount: 0n, privateRelayFeeAmount: 0n, privateRelayRecipient: null, validUntilTimestamp: 2000000000n, state: "submission-unknown", status: "failed" }];
  await render();
  expect(element.textContent).toContain("Set up and mine");
  expect(element.querySelector("#wallet-activity")).not.toBeNull();
  expect(element.querySelector('[data-payment-id="0xmining"]')?.textContent).toContain("Failed");
});

it("closes on a backdrop click or Escape but not on clicks inside", async () => {
  await render();
  const dialog = element.querySelector("dialog")!;
  const heading = element.querySelector<HTMLElement>("[data-wallet-heading]")!;
  await act(async () => heading.click());
  expect(dialog.open).toBe(true);
  // A press inside the panel released over the backdrop, such as a drag-select.
  await act(async () => { heading.dispatchEvent(new Event("pointerdown", { bubbles: true })); dialog.click(); });
  expect(dialog.open).toBe(true);
  await act(async () => { dialog.dispatchEvent(new Event("pointerdown", { bubbles: true })); dialog.click(); });
  expect(dialog.open).toBe(false);
  await act(async () => button("Open").click());
  expect(dialog.open).toBe(true);
  const escape = new Event("cancel", { bubbles: true, cancelable: true });
  await act(async () => dialog.dispatchEvent(escape));
  expect(escape.defaultPrevented).toBe(true);
  expect(dialog.open).toBe(false);
});
it("closes when the user follows the explorer link or an activity row", async () => {
  state.wallet.phase = "ready"; state.wallet.profile = { address: BigInt(address), nkRoot: 22n }; state.wallet.accountRecord = "present";
  state.wallet.paymentActivity = [{ kind: "payment", contentHash: "0xpayment", deliveryTarget: address, recipientAddress: address,
    amount: 1n, openFeeAmount: 0n, privateRelayFeeAmount: 0n, privateRelayRecipient: null, validUntilTimestamp: 2000000000n, status: "finalized" }];
  await render();
  const dialog = element.querySelector("dialog")!;
  await act(async () => element.querySelector<HTMLAnchorElement>(`a[href="/${address}"]`)!.click());
  expect(dialog.open).toBe(false);
  await act(async () => button("Open").click());
  expect(dialog.open).toBe(true);
  await act(async () => element.querySelector<HTMLAnchorElement>('[data-payment-id="0xpayment"] a')!.click());
  expect(dialog.open).toBe(false);
});
it("ignores the backdrop and Escape while the connect modal is open", async () => {
  connect.connectModalOpen = true;
  await render();
  const dialog = element.querySelector("dialog")!;
  await act(async () => { dialog.dispatchEvent(new Event("pointerdown", { bubbles: true })); dialog.click(); });
  await act(async () => dialog.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true })));
  expect(dialog.open).toBe(true);
});
it("asks no first-use questions and exposes settings through the gear", async () => {
  localStorage.removeItem(WEBSITE_SETTINGS_KEY);
  await render();
  expect(element.querySelector('[aria-label="Choose your privacy defaults"]')).toBeNull();
  expect(button("Sign in")).toBeDefined();
  await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Wallet settings"]')!.click());
  expect(element.querySelector('section[aria-label="Wallet settings"]')).not.toBeNull();
  await act(async () => button("← Back").click());
  expect(element.querySelector('section[aria-label="Wallet settings"]')).toBeNull();
  expect(element.querySelector("dialog")!.open).toBe(true);
});
it("offers Show ENS names, checked by default, under Connect wallet, aligned with the identity block", async () => {
  localStorage.removeItem(WEBSITE_SETTINGS_KEY);
  state.wallet.phase = "disconnected"; state.wallet.connectedAccount = undefined;
  await render();
  const heading = element.querySelector("[data-wallet-heading]")!;
  expect(heading.textContent).toBe("Your wallet");
  // No placeholder avatar pushes the text away from the left edge the button starts at.
  expect(heading.parentElement!.previousElementSibling).toBeNull();
  const connectButton = button("Connect wallet");
  const ens = element.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(ens.closest("label")!.textContent).toBe("Show ENS names");
  expect(ens.checked).toBe(true);
  expect(connectButton.compareDocumentPosition(ens) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async () => ens.click());
  expect(ens.checked).toBe(false);
  expect(JSON.parse(localStorage.getItem(WEBSITE_SETTINGS_KEY)!)).toEqual({ ensEnabled: false, defaultSubmissionMode: "slow" });
});

describe("a payment that fails after its review is discarded", () => {
  const STALE = "Wallet state changed after review. Send the payment again.";
  let fail: (cause: Error) => void;
  const type = (field: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const field = (label: string) => [...element.querySelectorAll("#send label")].find((node) => node.textContent?.startsWith(label))!.querySelector("input")!;
  const view = () => element.querySelector("dialog")!.getAttribute("data-view");
  beforeEach(async () => {
    Object.assign(state.wallet, { phase: "ready", accountRecord: "present", profile: { address: BigInt(address), nkRoot: 22n }, funds: { total: 20n * 10n ** 18n, spendablePrivate: 20n * 10n ** 18n },
      resetPrivateSend: vi.fn(), refreshSubmissionLock: vi.fn(async () => ({ waiting: [], released: [] })),
      preflightPrivateSend: vi.fn(async () => ({ openFeeAmount: 10n ** 18n, privateRelayFeeAmount: 0n, privateRelayRecipient: null, beneficiary: { kind: "publisher" }, publication: "open", inputCount: 1, inputTotal: 20n * 10n ** 18n, retry: false })),
      sendPrivate: vi.fn(() => new Promise((_resolve, reject) => { fail = reject; })) });
    await render();
    await act(async () => button("Send").click());
    await type(field("Recipient"), `0x${"34".repeat(20)}`);
    await type(field("Amount"), "10");
    await type(field("Relayer fee"), "1");
    await act(async () => button("Send").click());
    expect(state.wallet.sendPrivate).toHaveBeenCalledOnce();
    state.wallet.paymentStage = { state: "proving", attemptId: 1 };
    await render();
  });
  const failStale = async () => {
    await act(async () => { state.wallet.paymentStage = { state: "failed", attemptId: 1 }; fail(new Error(STALE)); });
    await render();
  };

  it("reopens a closed panel on Send with the error", async () => {
    await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Close wallet"]')!.click());
    await failStale();
    expect(element.querySelector("dialog")!.open).toBe(false);
    await act(async () => button("Open").click());
    expect(view()).toBe("send");
    expect(element.querySelector("#send")!.textContent).toContain(STALE);
  });

  it("shows the error on the overview, and View opens Send with it", async () => {
    await act(async () => button("← Wallet").click());
    expect(view()).toBe("overview");
    await failStale();
    const row = [...element.querySelectorAll("[role=status]")].find((node) => node.textContent?.includes(STALE));
    expect(row?.textContent).toContain("Payment");
    await act(async () => [...row!.querySelectorAll("button")].find((node) => node.textContent === "View")!.click());
    expect(view()).toBe("send");
    expect(element.querySelector("#send")!.textContent).toContain(STALE);
  });
});

describe("connecting after the extension switched accounts", () => {
  beforeEach(() => {
    state.wallet.phase = "disconnected";
    state.wallet.beginOnboarding = vi.fn();
    state.wallet.connect = vi.fn(async () => undefined);
    connect.openConnectModal = undefined;
  });
  it("reuses a connection wagmi still holds instead of greying out Connect", async () => {
    connect.wagmiStatus = "connected";
    await render();
    expect(button("Connect wallet").disabled).toBe(false);
    await act(async () => button("Connect wallet").click());
    expect(state.wallet.connect).toHaveBeenCalledOnce();
  });
  it("drops an unfinished connection attempt and opens the picker", async () => {
    connect.wagmiStatus = "reconnecting";
    const picker = vi.fn();
    connect.disconnect = vi.fn(async () => { connect.openConnectModal = picker; });
    await render();
    await act(async () => button("Connect wallet").click());
    expect(connect.disconnect).toHaveBeenCalledOnce();
    await render();
    expect(picker).toHaveBeenCalledOnce();
  });
});
