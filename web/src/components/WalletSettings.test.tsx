// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EthereumName } from "@pcash/sdk/names";

const wallet = vi.hoisted(() => ({
  phase: "ready", busy: false, paymentStage: { state: "idle" }, status: { pcashChainId: 1n, genesisHash: "head" }, connectedAccount: "0xme",
  profile: { address: 1n }, snapshot: undefined,
  paymentActivity: [{ contentHash: `0x${"ab".repeat(32)}`, recipientAddress: `0x${"12".repeat(20)}`, amount: 1n, openFeeAmount: 0n, privateRelayFeeAmount: 0n, privateRelayRecipient: null, status: "confirmed", createdAtUnixMs: 1n }],
  awaitingConfirmation: new Map(),
  preflightPrivateSend: vi.fn(), sendPrivate: vi.fn(), cancelPrivateSend: vi.fn(), resetPrivateSend: vi.fn(),
}));
vi.mock("../lib/WalletProvider.tsx", () => ({ useWallet: () => wallet, errorMessage: String }));
vi.mock("../lib/useNativeActivity.ts", () => ({ useNativeActivity: () => ({ activity: undefined, failed: false, checking: false }) }));
vi.mock("../lib/usePaymentIssuance.ts", () => ({ usePaymentIssuance: () => ({ issuance: 20n, inputs: { quote: { status: "rejected" }, economics: { status: "rejected" } } }) }));
vi.mock("../lib/EthereumProvider.tsx", () => ({ useEthereumNetwork: () => ({ ethereumConfig: {}, l1ChainId: 1 }) }));
const siteStorage = vi.hoisted(() => ({ requestSiteDataClear: vi.fn() }));
vi.mock("../lib/siteStorage.ts", () => siteStorage);
vi.mock("./NetworkContext.tsx", () => ({ useNetwork: () => ({ network: { l1ChainId: 1, pcashChainId: 1 } }) }));
import { WalletSettings } from "./WalletSettings.tsx";
import { WebsiteSettingsContext, WebsiteSettingsStore, WebsiteSettingsProvider, useWebsiteSettings, WEBSITE_SETTINGS_KEY } from "../lib/WebsiteSettings.tsx";
import { EthereumAddress } from "./EthereumAddress.tsx";
import { OwnerPanelsProvider, SendCard } from "../routes/wallet/OwnerPanels.tsx";
import { Activity } from "../routes/wallet/Activity.tsx";
import { PersonalPayment } from "../routes/explorer/pages/TransactionPage.tsx";
import { NameResolutionContext, useEthereumIdentity, useNameAddress } from "../names/useEthereumName.ts";
import { NameResolutionSession } from "../names/NameResolutionSession.ts";
import { NameResolutionProvider } from "../names/NameResolutionProvider.tsx";
import { NAME_CACHE_KEY, NAME_TTL } from "../names/nameCache.ts";

const address = `0x${"12".repeat(20)}` as const;
const identity: EthereumName = { address, name: "alice.eth", system: "ens" };
const rpc = { reverseAddress: vi.fn(), resolveName: vi.fn(), getAvatar: vi.fn() };
let session: NameResolutionSession;
let settings: WebsiteSettingsStore;
let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  rpc.reverseAddress.mockReset().mockResolvedValue({ identity, complete: true });
  rpc.resolveName.mockReset().mockResolvedValue(identity);
  rpc.getAvatar.mockReset().mockResolvedValue("https://example.com/avatar.png");
  wallet.preflightPrivateSend.mockReset().mockResolvedValue({ openFeeAmount: 1n, privateRelayFeeAmount: 0n, privateRelayRecipient: null, beneficiary: { kind: "publisher" }, publication: "open", retry: false });
  wallet.sendPrivate.mockReset().mockReturnValue(new Promise(() => undefined));
  settings = new WebsiteSettingsStore(() => localStorage);
  settings.setEnsEnabled(false);
  session = new NameResolutionSession(() => rpc, () => localStorage);
  session.queryClient.mount();
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount()); element.remove();
  session.stop(); session.queryClient.clear(); session.queryClient.unmount();
  vi.unstubAllGlobals();
});
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); }
function SettingsBridge() {
  const { ensEnabled } = useWebsiteSettings();
  useEffect(() => session.setEnabled(ensEnabled), [ensEnabled]);
  return <WalletSettings onBack={() => undefined} />;
}
async function render(children: ReactNode, path = "/") {
  await act(async () => root.render(<WebsiteSettingsContext.Provider value={settings}><NameResolutionContext.Provider value={session}><MemoryRouter initialEntries={[path]}><OwnerPanelsProvider><SettingsBridge />{children}</OwnerPanelsProvider></MemoryRouter></NameResolutionContext.Provider></WebsiteSettingsContext.Provider>));
  await flush();
}
async function toggle() { await act(async () => element.querySelector<HTMLButtonElement>('[role="switch"]')!.click()); await flush(); }
function noLookups() {
  expect(rpc.reverseAddress).not.toHaveBeenCalled(); expect(rpc.resolveName).not.toHaveBeenCalled(); expect(rpc.getAvatar).not.toHaveBeenCalled();
  expect(localStorage.getItem(NAME_CACHE_KEY)).toBeNull();
  expect(JSON.stringify(session.queryClient.getQueryCache().getAll().map((query) => query.queryKey))).not.toContain(address);
}

describe("Show ENS names setting", () => {
  it.each(["history", "receipt"])("keeps %s local until the user turns ENS names on", async (view) => {
    const child = view === "history" ? <QueryClientProvider client={new QueryClient()}><Activity /></QueryClientProvider>
      : <PersonalPayment payment={{ kind: "payment", contentHash: "tx", recipientAddress: address, amount: 1n, openFeeAmount: 0n }} state="succeeded" />;
    await render(child);
    expect(element.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(element.querySelector(`[title="${address}"]`)).not.toBeNull();
    noLookups();
    await toggle();
    expect(rpc.reverseAddress).toHaveBeenCalledWith(address);
    expect(element.textContent).toContain("alice.eth");
    expect(localStorage.getItem(NAME_CACHE_KEY)).toContain(address);
    await toggle();
    expect(element.textContent).not.toContain("alice.eth");
    expect(localStorage.getItem(NAME_CACHE_KEY)).toBeNull();
    expect(session.cache.read(`1:reverse:${address}`)).toBeUndefined();
  });

  it("blocks typed names, fresh payment lookups, and avatars while ENS names are off", async () => {
    function NameAndAvatar() {
      const resolved = useNameAddress("alice.eth");
      const account = useEthereumIdentity(address);
      return <div data-name-state={resolved.state}>{account.avatar}</div>;
    }
    await render(<><NameAndAvatar /><SendCard /></>, "/?to=alice.eth");
    const amount = [...element.querySelectorAll("label")].find((label) => label.textContent?.startsWith("Amount"))!.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(amount, "1");
      amount.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const review = () => [...element.querySelectorAll("button")].find((button) => button.textContent === "Send")!;
    await act(async () => review().click());
    noLookups();
    expect(element.textContent).toContain("ENS names are off");
    expect(wallet.preflightPrivateSend).not.toHaveBeenCalled();
    await toggle(); await flush();
    expect(rpc.getAvatar).toHaveBeenCalledWith(identity);
    await act(async () => review().click());
    expect(rpc.resolveName).toHaveBeenCalledTimes(2);
    expect(wallet.preflightPrivateSend).toHaveBeenCalledWith({ to: address, amount: 10n ** 18n, openFeeAmount: 10n ** 18n, includeSender: true, newAction: true });
  });

  it("prevents an old result from restoring a cleared cache or appearing after re-enabling lookups", async () => {
    let finish!: (value: unknown) => void;
    rpc.reverseAddress.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await render(<EthereumAddress address={address} />);
    await toggle();
    await toggle();
    await act(async () => finish({ identity, complete: true })); await flush();
    expect(element.textContent).not.toContain("alice.eth");
    expect(localStorage.getItem(NAME_CACHE_KEY)).toBeNull();
    await toggle();
    expect(rpc.reverseAddress).toHaveBeenCalledTimes(2);
    expect(element.textContent).toContain("alice.eth");
  });

  it("clears confirmed misses when ENS names are turned off", async () => {
    rpc.reverseAddress.mockResolvedValue({ identity: null, complete: true });
    await render(<EthereumAddress address={address} />); await toggle();
    expect(localStorage.getItem(NAME_CACHE_KEY)).toContain(address);
    await toggle();
    expect(localStorage.getItem(NAME_CACHE_KEY)).toBeNull();
    await toggle();
    expect(rpc.reverseAddress).toHaveBeenCalledTimes(2);
  });

  it.each([null, [], "wrong", { "1:forward:alice.eth": { identity: [] } }])("recovers forward resolution from malformed browser storage: %j", async (value) => {
    localStorage.setItem(NAME_CACHE_KEY, JSON.stringify(value));
    function NameInput() { const value = useNameAddress("alice.eth"); return <span>{value.state === "resolved" ? value.address : value.state}</span>; }
    await render(<NameInput />); await toggle();
    expect(element.textContent).toContain(address);
    expect(rpc.resolveName).toHaveBeenCalledWith("alice.eth");
  });

  it("applies a change from another tab before accepting pending results", async () => {
    settings.setEnsEnabled(true);
    await act(async () => root.render(<WebsiteSettingsProvider><NameResolutionProvider createResolver={() => rpc}><WalletSettings onBack={() => undefined} /><EthereumAddress address={address} /></NameResolutionProvider></WebsiteSettingsProvider>)); await flush();
    expect(element.textContent).toContain("alice.eth");
    await act(async () => {
      settings.setEnsEnabled(false);
      window.dispatchEvent(new StorageEvent("storage", { key: WEBSITE_SETTINGS_KEY }));
    }); await flush();
    expect(element.textContent).not.toContain("alice.eth");
    expect(localStorage.getItem(NAME_CACHE_KEY)).toBeNull();
  });

  it("does not treat freshness expiry as storage deletion", () => {
    session.setEnabled(true);
    const entry = session.cache.write(`1:reverse:${address}`, { identity, complete: true });
    vi.spyOn(Date, "now").mockReturnValue(entry.expiresAt + NAME_TTL);
    expect(session.cache.read(`1:reverse:${address}`)).toBeUndefined();
    expect(localStorage.getItem(NAME_CACHE_KEY)).toContain(address);
    session.setEnabled(false);
    expect(localStorage.getItem(NAME_CACHE_KEY)).toBeNull();
    vi.restoreAllMocks();
  });
});

it("sets ENS names and the default speed independently, with the RPC fields under Advanced", async () => {
  await render(null);
  const ens = () => element.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Show ENS names"]')!;
  expect(element.querySelector('[aria-label="Privacy mode"]')).toBeNull();
  await act(async () => ens().click());
  expect(settings.getSnapshot()).toEqual({ ensEnabled: true, defaultSubmissionMode: "slow" });
  const speed = element.querySelector('[role="radiogroup"]')!;
  expect(element.querySelector(`#${CSS.escape(speed.getAttribute("aria-labelledby")!)}`)?.textContent).toBe("Default speed");
  await act(async () => element.querySelector<HTMLInputElement>('input[value="fast"]')!.click());
  expect(settings.getSnapshot()).toEqual({ ensEnabled: true, defaultSubmissionMode: "fast" });
  const advanced = element.querySelector('section[aria-label="Wallet settings"] > details')!;
  expect(advanced.querySelector("summary")?.textContent).toBe("Advanced");
  expect(advanced.querySelector('form[aria-label="RPC endpoints"]')).not.toBeNull();
  expect(advanced.nextElementSibling).toBeNull();
});

it("confirms before reloading to clear everything this website stores", async () => {
  siteStorage.requestSiteDataClear.mockReset();
  await render(null);
  const button = (label: string) => [...element.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label);
  await act(async () => button("Clear site data")!.click());
  expect(siteStorage.requestSiteDataClear).not.toHaveBeenCalled();
  await act(async () => button("Cancel")!.click());
  expect(button("Clear and reload")).toBeUndefined();
  await act(async () => button("Clear site data")!.click());
  await act(async () => button("Clear and reload")!.click());
  expect(siteStorage.requestSiteDataClear).toHaveBeenCalledOnce();
});
