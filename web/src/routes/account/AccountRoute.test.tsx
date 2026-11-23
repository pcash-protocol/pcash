// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { assetDefinitionAssetId } from "@pcash/sdk/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testDefinition } from "../tokens/tokenTestSupport.ts";

const address = `0x${"12".repeat(20)}`;
const state = vi.hoisted(() => ({ wallet: {} as Record<string, unknown>, todos: 0, unsafeToLeave: false }));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet }));
vi.mock("../../lib/GetActivity.tsx", () => ({ useGetActivity: () => ({ unsafeToLeave: state.unsafeToLeave }), confirmDiscardGetWork: () => true }));
vi.mock("../../names/useEthereumName.ts", () => ({ useEthereumIdentity: () => ({}) }));
vi.mock("../marketplace/MarketplaceProvider.tsx", () => ({ useMarketplaceTodoCount: () => state.todos }));
vi.mock("../wallet/Activity.tsx", () => ({ Activity: () => <div data-testid="activity" /> }));
vi.mock("../wallet/MiningBalance.tsx", () => ({ MiningBalance: () => <output data-testid="balance">1,229 PCASH</output> }));
vi.mock("../wallet/OwnerPanels.tsx", () => ({ AccountStatusNotices: () => null, ReceiveCard: ({ address: owner }: { address: string }) => <article id="receive">{owner}</article> }));
vi.mock("../../components/WalletPanel.tsx", () => ({ PaymentInProgress: () => null, WaitingPayment: () => null }));
vi.mock("../../components/WalletSettings.tsx", () => ({ WalletSettings: () => <h2>Settings</h2> }));
vi.mock("../try/TryLayout.tsx", async (original) => ({ ...await original<typeof import("../try/TryLayout.tsx")>(), NextStep: () => <button type="button">Connect wallet</button> }));
import AccountRoute from "./AccountRoute.tsx";

let element: HTMLDivElement;
let root: Root;
let path = "";
function Where() { path = useLocation().pathname; return null; }
const render = () => act(async () => root.render(<MemoryRouter initialEntries={["/account"]}><Where /><Routes><Route path="*" element={<AccountRoute />} /></Routes></MemoryRouter>));
const link = (text: string) => [...element.querySelectorAll("a")].find((node) => node.textContent === text);
const ready = () => Object.assign(state.wallet, { phase: "ready", wallet: {}, profile: {}, selfPublication: {}, accountRecord: "present" });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.wallet = { connectedAccount: address, phase: "disconnected", accountRecord: "absent", disconnect: vi.fn(async () => undefined) };
  state.todos = 0;
  state.unsafeToLeave = false;
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

it("shows the setup step, and none of the account's sections, before the account exists", async () => {
  await render();
  expect(element.querySelector("h1")?.textContent).toBe("Your account");
  expect(element.textContent).toContain("Connect wallet");
  expect(link("Try PCASH")?.getAttribute("href")).toBe("/get");
  expect(element.querySelector("#tokens")).toBeNull();
  expect(element.querySelector('[data-testid="balance"]')).toBeNull();
});

it("gathers the balance, tokens, activity, trades, receive link and settings", async () => {
  ready();
  state.todos = 2;
  await render();
  expect(element.querySelector('[data-testid="balance"]')).not.toBeNull();
  expect(link("Send")?.getAttribute("href")).toBe("/get");
  expect(link("Earn more")?.getAttribute("href")).toBe("/get/earn");
  expect([...element.querySelectorAll('nav[aria-label="On this page"] a')].map((node) => node.getAttribute("href"))).toEqual(["#tokens", "#activity", "#trades", "#receive", "#settings"]);
  expect(element.querySelector("#tokens")?.textContent).toContain("Tokens you create or receive appear here.");
  expect(element.querySelector('[data-testid="activity"]')).not.toBeNull();
  expect(element.querySelector("#trades")?.textContent).toContain("2 trades are waiting on you");
  expect(element.querySelector("#receive")?.textContent).toBe(address);
  expect(element.querySelector("#settings h2")?.textContent).toBe("Settings");
  expect(link("View your account in the explorer →")?.getAttribute("href")).toBe(`/${address}`);
});

it("lists token balances by symbol, or by ID when unverified, linking to each token page", async () => {
  ready();
  const definition = testDefinition("Harbor Credit", "HBR", 2);
  const verifiedId = assetDefinitionAssetId(definition);
  state.wallet.snapshot = { assets: [
    { assetId: verifiedId, definition, private: 123_456n, spendable: 123_456n, created: true },
    { assetId: 0x1234n, definition: null, private: 5n, spendable: 5n, created: false },
  ] };
  await render();
  const rows = [...element.querySelectorAll("#tokens a[data-token-row]")];
  expect(rows.map((row) => row.getAttribute("href"))).toEqual([`/token/0x${verifiedId.toString(16).padStart(64, "0")}`, `/token/0x${"0".repeat(60)}1234`]);
  expect(rows[0]!.textContent).toContain("1,234.56 HBR");
  expect(rows[1]!.textContent).toContain("Unverified token");
});

it("disconnects from the page", async () => {
  ready();
  await render();
  const disconnect = [...element.querySelectorAll("button")].find((node) => node.textContent === "Disconnect")!;
  await act(async () => disconnect.click());
  expect(state.wallet.disconnect).toHaveBeenCalledOnce();
  expect(path).toBe("/account");
});
