// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebsiteSettingsContext, WebsiteSettingsStore } from "../../lib/WebsiteSettings.tsx";

const ZERO = new Uint8Array(32);
const state = vi.hoisted(() => ({ wallet: {} as Record<string, any> }));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet, errorMessage: (cause: unknown) => cause instanceof Error ? cause.message : String(cause) }));
vi.mock("../../lib/usePaymentIssuance.ts", () => ({ usePaymentIssuance: () => ({ issuance: undefined, inputs: undefined }) }));
vi.mock("../wallet/OwnerPanels.tsx", () => ({ useWalletPanel: () => ({ openOverview: vi.fn() }) }));
import CreateTokenPage, { tokenTerms } from "./CreateTokenPage.tsx";

describe("token terms", () => {
  const fields = { name: " Harbor Credit ", symbol: "HBR", decimals: "2", supply: "1,000,000" };
  it("commits to trimmed NFC text and supply in base units", () => {
    expect(tokenTerms(fields, ZERO)).toEqual({ metadata: { name: "Harbor Credit", symbol: "HBR", decimals: 2, contentDigest: ZERO }, initialSupply: 100_000_000n });
    expect(tokenTerms({ ...fields, name: "Café" }, ZERO).metadata.name).toBe("Café");
  });
  it("names the first rule a field breaks", () => {
    expect(() => tokenTerms({ ...fields, name: "x".repeat(65) }, ZERO)).toThrow("Name must be 1 to 64 bytes of text.");
    expect(() => tokenTerms({ ...fields, symbol: "HÄRBOR" }, ZERO)).toThrow("Symbol must be 1 to 12 plain ASCII characters.");
    expect(() => tokenTerms({ ...fields, decimals: "19" }, ZERO)).toThrow("Decimals must be a whole number from 0 to 18.");
    expect(() => tokenTerms({ ...fields, supply: "1.001" }, ZERO)).toThrow("Total supply can have at most 2 decimal places");
    expect(() => tokenTerms({ ...fields, decimals: "18", supply: "1000000000000000000000" }, ZERO)).toThrow(/Total supply can be at most 340,282,366,920,938,463,463\.374607431768211455 HBR/);
  });
});

let element: HTMLDivElement;
let root: Root;
let landed: { pathname: string; state: unknown } | undefined;
function Landing() {
  const location = useLocation();
  landed = { pathname: location.pathname, state: location.state };
  return <p>token page</p>;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  landed = undefined;
  state.wallet = {
    phase: "ready", busy: false, funds: { spendablePrivate: 2n * 10n ** 18n }, snapshot: { pendingContentHashes: [] },
    runAction: (action: () => Promise<unknown>) => action(),
    wallet: { assets: vi.fn(async () => []), createAsset: vi.fn() },
  };
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

const render = () => act(async () => root.render(<WebsiteSettingsContext.Provider value={new WebsiteSettingsStore(() => localStorage)}>
  <MemoryRouter initialEntries={["/tokens/new"]}><Routes>
    <Route path="/tokens/new" element={<CreateTokenPage />} />
    <Route path="/token/:assetId" element={<Landing />} />
  </Routes></MemoryRouter></WebsiteSettingsContext.Provider>));
const text = () => element.textContent ?? "";
const button = (label: string) => [...element.querySelectorAll("button")].find((node) => node.textContent === label)!;
const field = (label: string) => [...element.querySelectorAll("label")].find((node) => node.textContent?.startsWith(label))!.querySelector("input, select, textarea") as HTMLInputElement;
async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const radio = (label: string) => [...element.querySelectorAll<HTMLInputElement>("input[type=radio]")].find((node) => node.parentElement?.textContent === label)!;

describe("creating a token", () => {
  it("says exactly what was hashed for the content digest", async () => {
    await render();
    await type(field("Text or link to hash"), "https://example.org/terms");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(text()).toContain("SHA-256 of the text “https://example.org/terms” exactly as entered, as UTF-8 (25 bytes). This is the text of the link, not the page it points to.");
    await act(async () => radio("Digest").click());
    await type(field("SHA-256 digest"), "0x12");
    expect(text()).toContain("A content digest is 0x followed by 64 hex digits.");
  });

  it("states the fixed supply, creates in one step with the chosen route, and lands on the token page", async () => {
    state.wallet.wallet.createAsset.mockImplementation(async (intent: { onPrepared(contentHash: string): void }) => {
      intent.onPrepared("0xcreate");
      return { contentHash: "0xcreate", accepted: false, assetId: 0xabcn };
    });
    await render();
    await type(field("Name"), "Harbor Credit");
    await type(field("Symbol"), "HBR");
    await act(async () => {
      const select = field("Decimals") as unknown as HTMLSelectElement;
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await type(field("Total supply"), "1,000,000");
    await act(async () => radio("None").click());
    expect(text()).toContain("The supply is fixed forever.");
    expect(text()).toContain("There is no later minting: no one, including you, can ever create more.");
    expect(text()).toContain("No content. The digest is 32 zero bytes.");
    await act(async () => button("Create token").click());
    expect(state.wallet.wallet.createAsset).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { name: "Harbor Credit", symbol: "HBR", decimals: 2, contentDigest: ZERO }, initialSupply: 100_000_000n, openFeeAmount: 10n ** 18n,
    }));
    expect(landed).toEqual({ pathname: `/token/0x${"0".repeat(61)}abc`, state: { creation: { contentHash: "0xcreate", mode: "slow" } } });
  });

  it("starts a creator with no PCASH at a zero relayer fee, which a token creation allows", async () => {
    state.wallet.funds = { spendablePrivate: 0n };
    state.wallet.wallet.createAsset.mockReturnValue(new Promise(() => undefined));
    await render();
    expect(field("Relayer fee").value).toBe("0");
    await type(field("Name"), "Harbor Credit");
    await type(field("Symbol"), "HBR");
    await type(field("Total supply"), "5");
    await act(async () => radio("None").click());
    await act(async () => button("Create token").click());
    expect(state.wallet.wallet.createAsset).toHaveBeenCalledWith(expect.objectContaining({ openFeeAmount: 0n }));
  });

  it("follows an unconfirmed creation to the token the wallet journaled", async () => {
    state.wallet.wallet.assets.mockResolvedValueOnce([]).mockResolvedValueOnce([{ assetId: 0xdefn, created: true }]);
    state.wallet.wallet.createAsset.mockImplementation(async (intent: { onPrepared(contentHash: string): void }) => {
      intent.onPrepared("0xcreate");
      throw new Error("connection reset");
    });
    await render();
    await type(field("Name"), "Harbor Credit");
    await type(field("Symbol"), "HBR");
    await type(field("Total supply"), "5");
    await act(async () => radio("None").click());
    await act(async () => button("Create token").click());
    expect(landed).toEqual({ pathname: `/token/0x${"0".repeat(61)}def`, state: { creation: { contentHash: "0xcreate", mode: "slow", unknown: true } } });
  });

  it("creates once when Create is clicked again while existing tokens are read", async () => {
    let release!: () => void;
    state.wallet.wallet.assets.mockImplementation(() => new Promise((resolve) => { release = () => resolve([]); }));
    state.wallet.wallet.createAsset.mockReturnValue(new Promise(() => undefined));
    await render();
    await type(field("Name"), "Harbor Credit");
    await type(field("Symbol"), "HBR");
    await type(field("Total supply"), "5");
    await act(async () => radio("None").click());
    const create = button("Create token");
    await act(async () => { create.click(); create.click(); });
    expect(create.disabled).toBe(true);
    await act(async () => create.click());
    await act(async () => release());
    expect(state.wallet.wallet.assets).toHaveBeenCalledTimes(1);
    expect(state.wallet.wallet.createAsset).toHaveBeenCalledTimes(1);
  });

  it("keeps the form in place and locked while the token is created, with progress under the button", async () => {
    state.wallet.wallet.createAsset.mockReturnValue(new Promise(() => undefined));
    await render();
    await type(field("Name"), "Harbor Credit");
    await type(field("Symbol"), "HBR");
    await type(field("Total supply"), "5");
    await act(async () => radio("None").click());
    await act(async () => button("Create token").click());
    const form = element.querySelector("form")!;
    expect(form.querySelector("fieldset")!.disabled).toBe(true);
    expect(field("Name").value).toBe("Harbor Credit");
    expect(field("Total supply").value).toBe("5");
    expect(button("Creating…").disabled).toBe(true);
    expect(element.querySelector("#create-heading")!.textContent).toBe("Token details");
    const progress = form.querySelector(".proof-progress")!;
    expect(button("Creating…").compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows a creation that failed before submission and lets the creator try again", async () => {
    state.wallet.wallet.createAsset.mockRejectedValue(new Error("User rejected the request."));
    await render();
    await type(field("Name"), "Harbor Credit");
    await type(field("Symbol"), "HBR");
    await type(field("Total supply"), "5");
    await act(async () => radio("None").click());
    await act(async () => button("Create token").click());
    expect(text()).toContain("User rejected the request.");
    expect(element.querySelector("fieldset")!.disabled).toBe(false);
    expect(field("Name").value).toBe("Harbor Credit");
    expect(field("Total supply").value).toBe("5");
    expect(radio("None").checked).toBe(true);
    expect(button("Try again").disabled).toBe(false);
    expect(landed).toBeUndefined();
  });
});
