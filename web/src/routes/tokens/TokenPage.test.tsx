// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetDefinitionAssetId, formatAssetDefinition } from "@pcash/sdk/protocol";
import { WebsiteSettingsContext, WebsiteSettingsStore } from "../../lib/WebsiteSettings.tsx";
import { assetIdHex } from "./model.ts";
import { testDefinition } from "./tokenTestSupport.ts";

const state = vi.hoisted(() => ({ wallet: {} as Record<string, unknown>, openOverview: vi.fn() }));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet, errorMessage: (cause: unknown) => cause instanceof Error ? cause.message : String(cause) }));
vi.mock("../../lib/usePaymentIssuance.ts", () => ({ usePaymentIssuance: () => ({ issuance: undefined, inputs: undefined }) }));
vi.mock("../wallet/OwnerPanels.tsx", () => ({ useWalletPanel: () => ({ openOverview: state.openOverview }) }));
vi.mock("../../lib/EthereumProvider.tsx", () => ({ useEthereumNetwork: () => ({ l1ChainId: 1 }) }));
vi.mock("../../names/useEthereumName.ts", () => ({ useEthereumNameResolver: () => undefined, useEthereumName: () => undefined, useNameAddress: () => ({ state: "unresolved" }) }));
import TokenPage from "./TokenPage.tsx";

const definition = testDefinition("Harbor Credit", "HBR", 2, 100_000_000n);
const assetId = assetDefinitionAssetId(definition);
const shareText = formatAssetDefinition(definition);

let element: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.wallet = {
    phase: "ready", busy: false, snapshot: { assets: [], pendingContentHashes: [] }, funds: { spendablePrivate: 0n },
    status: { pcashChainId: 1n }, runAction: (action: () => Promise<unknown>) => action(), refresh: vi.fn(async () => undefined),
    wallet: { importAssetDefinition: vi.fn(async () => ({ assetId })), bulkJobs: vi.fn(async () => []) },
  };
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

async function render(path: string) {
  const settings = new WebsiteSettingsStore(() => localStorage);
  await act(async () => root.render(<WebsiteSettingsContext.Provider value={settings}><MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/token/:assetId" element={<TokenPage />} /></Routes>
  </MemoryRouter></WebsiteSettingsContext.Provider>));
}
const text = () => element.textContent ?? "";
const button = (label: string) => [...element.querySelectorAll("button")].find((node) => node.textContent === label);
const verifiedBox = () => element.querySelector('[aria-label="Verified definition"]');
const tabs = () => [...element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
const sendModes = () => [...element.querySelectorAll('[role="radiogroup"][aria-label="Send to"] label')].map((label) => label.textContent);
const sendMode = (label: string) => [...element.querySelectorAll<HTMLInputElement>('input[name="send-mode"]')].find((input) => input.parentElement?.textContent === label)!;

describe("token page", () => {
  it("verifies a shared link against the path's token ID and offers to add it", async () => {
    await render(`/token/${assetIdHex(assetId)}#d=${shareText}`);
    expect(element.querySelector("h1")?.textContent).toBe("Harbor Credit");
    expect(verifiedBox()?.textContent).toContain("Verified against the token ID");
    expect(verifiedBox()?.textContent).toContain("1,000,000 HBR");
    expect(verifiedBox()?.textContent).toContain(assetIdHex(assetId));
    expect(verifiedBox()?.textContent).not.toContain("outstanding");
    expect(text()).toContain("Current outstanding supplyPrivate — burns and holdings are not publicly enumerable.");
    expect(text()).toContain("You hold none of this token.");
    await act(async () => button("Add to your wallet")!.click());
    expect((state.wallet.wallet as { importAssetDefinition: ReturnType<typeof vi.fn> }).importAssetDefinition).toHaveBeenCalledWith(definition);
    expect(state.wallet.refresh).toHaveBeenCalledOnce();
  });

  it("shows a definition that derives another token ID as not matching, and nothing it claims", async () => {
    const other = testDefinition("Harbor Credit Official", "HBR");
    await render(`/token/${assetIdHex(assetId)}#d=${formatAssetDefinition(other)}`);
    expect(text()).toContain("The definition in this link does not match this token ID.");
    expect(text()).not.toContain("Harbor Credit Official");
    expect(verifiedBox()).toBeNull();
    expect(element.querySelector("h1")?.textContent).toBe("Unverified token");
  });

  it("uses the wallet's definition for the balance, actions and share link", async () => {
    state.wallet.snapshot = { assets: [{ assetId, definition, private: 12_345n, spendable: 12_300n, created: true }], pendingContentHashes: [] };
    await render(`/token/${assetIdHex(assetId)}`);
    expect(element.querySelector('[data-testid="token-balance"]')?.textContent).toBe("123.45 HBR");
    expect(text()).toContain("123 HBR available now");
    expect(text()).toContain("You created this token.");
    expect(tabs()).toEqual(["Send", "Drop"]);
    expect(sendModes()).toEqual(["One recipient", "Many recipients", "Claim links", "Burn"]);
    expect(element.querySelector('form[aria-label="Send token"]')).not.toBeNull();
    await act(async () => sendMode("Many recipients").click());
    expect(element.querySelector('form[aria-label="Send token"]')).toBeNull();
    expect(text()).toContain("Recipients, one per line");
    await act(async () => sendMode("Burn").click());
    expect(element.querySelector('form[aria-label="Burn token"]')).not.toBeNull();
    const link = element.querySelector<HTMLInputElement>('input[aria-label="Token link"]')!.value;
    expect(link).toBe(`${window.location.origin}/token/${assetIdHex(assetId)}#d=${shareText}`);
    expect(button("Add to your wallet")).toBeUndefined();
  });

  it("shows a held token without a definition by ID and accepts only its own definition", async () => {
    state.wallet.snapshot = { assets: [{ assetId, definition: null, private: 250n, spendable: 250n, created: false }], pendingContentHashes: [] };
    await render(`/token/${assetIdHex(assetId)}`);
    expect(element.querySelector("h1")?.textContent).toBe("Unverified token");
    expect(element.querySelector('[data-testid="token-balance"]')?.textContent).toBe("250 units");
    // Claims deliver the definition, so links and drops need one.
    expect(tabs()).toEqual([]);
    expect(sendModes()).toEqual(["One recipient", "Many recipients", "Burn"]);
    const textarea = element.querySelector<HTMLTextAreaElement>("textarea")!;
    const type = (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await type(formatAssetDefinition(testDefinition("Other", "OTH")));
    expect(text()).toContain("This definition belongs to a different token");
    expect(button("Add to your wallet")).toBeUndefined();
    await type(`https://pcash.example/token/${assetIdHex(assetId)}#d=${shareText}`);
    expect(verifiedBox()?.textContent).toContain("Harbor Credit");
    await act(async () => button("Add to your wallet")!.click());
    expect((state.wallet.wallet as { importAssetDefinition: ReturnType<typeof vi.fn> }).importAssetDefinition).toHaveBeenCalledWith(definition);
  });

  it("keeps the open send form when the wallet gains the token's definition", async () => {
    const held = (known: typeof definition | null) => ({ assets: [{ assetId, definition: known, private: 250n, spendable: 250n, created: false }], pendingContentHashes: [] });
    state.wallet.snapshot = held(null);
    await render(`/token/${assetIdHex(assetId)}`);
    await act(async () => sendMode("Many recipients").click());
    const list = () => element.querySelector<HTMLTextAreaElement>('textarea[placeholder^="0x1234"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(list(), "alice.eth, 1");
      list().dispatchEvent(new Event("input", { bubbles: true }));
    });
    state.wallet = { ...state.wallet, snapshot: held(definition) };
    await render(`/token/${assetIdHex(assetId)}`);
    expect(tabs()).toEqual(["Send", "Drop"]);
    expect(sendModes()).toEqual(["One recipient", "Many recipients", "Claim links", "Burn"]);
    expect(list().value).toBe("alice.eth, 1");
  });

  it("asks a visitor without a wallet to connect before acting, while still verifying the link", async () => {
    state.wallet = { ...state.wallet, phase: "disconnected", wallet: undefined, snapshot: undefined };
    await render(`/token/${assetIdHex(assetId)}#d=${shareText}`);
    expect(verifiedBox()?.textContent).toContain("Harbor Credit");
    expect(text()).toContain("Connect a wallet to hold and send this token.");
    await act(async () => button("Connect wallet")!.click());
    expect(state.openOverview).toHaveBeenCalled();
    expect(button("Add to your wallet")).toBeUndefined();
  });

  it("signs in on the page when the Ethereum wallet is connected but PCASH is locked", async () => {
    const signIn = vi.fn(async () => "ready");
    state.openOverview.mockClear();
    state.wallet = { ...state.wallet, phase: "sign-in-required", wallet: undefined, snapshot: undefined, signIn };
    await render(`/token/${assetIdHex(assetId)}#d=${shareText}`);
    expect(text()).toContain("Sign in to your wallet to hold and send this token.");
    await act(async () => button("Sign in")!.click());
    expect(signIn).toHaveBeenCalledOnce();
    expect(state.openOverview).not.toHaveBeenCalled();
  });
});
