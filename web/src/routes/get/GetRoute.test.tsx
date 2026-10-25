// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const PCASH = 10n ** 18n;
const READY_WALLET = {
  connectedAccount: "0xowner", status: { genesisHash: "0xgenesis" }, profile: {} as object | undefined, wallet: {}, selfPublication: {},
  submissionLock: undefined as unknown, busy: false, phase: "ready", progress: undefined,
};
const state = vi.hoisted(() => ({
  estimate: { state: "loading" } as unknown,
  batch: {} as Record<string, unknown>,
  wallet: {} as Record<string, unknown>,
  listing: undefined as unknown,
  history: undefined as unknown,
  connect: vi.fn(),
}));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet }));
vi.mock("../../lib/GetActivity.tsx", () => ({ useGetActivity: () => ({ unsafeToLeave: false }) }));
vi.mock("./useGetNavigationGuard.ts", () => ({ useGetNavigationGuard: () => undefined }));
vi.mock("../../lib/useConnectWallet.ts", () => ({ useConnectWallet: () => state.connect, useStartWalletOnArrival: () => undefined }));
vi.mock("../../lib/EthereumProvider.tsx", () => ({ useEthereumNetwork: () => ({ l1Chain: { blockExplorers: { default: { name: "Etherscan", url: "https://etherscan.io" } } } }) }));
vi.mock("../wallet/AccountSetupPanel.tsx", () => ({ AccountSetupPanel: () => <section data-testid="account-setup"><button type="button">Sign in</button></section> }));
vi.mock("./IssuanceOverview.tsx", () => ({ IssuanceOverview: () => null }));
vi.mock("./RewardNow.tsx", () => ({ RewardNow: () => null }));
vi.mock("./useBestListing.ts", () => ({ useBestListing: () => state.listing }));
// Offer 1,000 and block maximum 3,000: up to three mines per block each get the full offer.
vi.mock("./useGetIssuance.ts", () => ({ useGetIssuance: () => ({
  inputs: { quote: { status: "fulfilled", value: { rewardPossible: true, exhausted: false, supplyCap: 21_000_000n * PCASH, issuedSoFar: 0n,
    internalOffer: 1_000n * PCASH, blockAllowance: 3_000n * PCASH, maxSingleActionReward: 1_000n * PCASH } } },
  history: state.history,
}) }));
vi.mock("./useGetEstimate.ts", () => ({ useGetEstimate: () => state.estimate }));
vi.mock("./useGetBatch.ts", () => ({ useGetBatch: () => state.batch }));
import GetRoute from "./GetRoute.tsx";

let element: HTMLDivElement;
let root: Root;
const render = () => act(async () => root.render(<MemoryRouter><GetRoute /></MemoryRouter>));
const term = (label: string) => [...element.querySelectorAll("dt")].find((node) => node.childNodes[0]?.textContent === label);
const row = (label: string) => term(label)?.nextElementSibling?.textContent;
const panel = () => element.querySelector('[aria-labelledby="get-action-title"]')!;
const startButton = () => element.querySelector<HTMLButtonElement>('[data-testid="mining-start"]')!;
const afterButton = () => startButton().nextElementSibling;
const plan = (overrides: Record<string, unknown> = {}) => ({ own: [], companions: { transactions: [], collectibleOpenFee: 0n }, rewardEach: PCASH, expectedIssuance: PCASH,
  actions: { qualifying: 1n, collectible: 1n }, actionsWithoutCompanions: { qualifying: 1n, collectible: 1n }, pendingCount: 0, ...overrides });
const ready = (planOverrides: Record<string, unknown> = {}) => ({ state: "ready", plan: plan(planOverrides),
  quote: { estimatedCostWei: 10n ** 16n + 1n, maximumCostWei: 10n ** 16n, balanceWei: 10n ** 18n } });
/** A day whose non-empty blocks each carried `perBlock` qualifying transactions. */
const recentBlocks = (perBlock: number) => ({ supply: [{ firstTimestamp: 0n }], day: { qualifyingActions: BigInt(perBlock * 10), issuanceTotal: 0n },
  week: { qualifyingActions: 0n, issuanceTotal: 0n }, recentBlocks: new Map([[perBlock, 10]]), asOf: 86_400n });

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.estimate = { state: "loading" };
  state.listing = undefined;
  state.history = undefined;
  state.batch = { attempts: [], start: vi.fn(), cancel: vi.fn() };
  state.wallet = { ...READY_WALLET };
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

it("shows estimates without approximation marks, rounding the Ethereum cost up", async () => {
  state.estimate = ready();
  await render();
  expect(row("Estimated Ethereum cost")).toBe("0.011 ETH");
  expect(row("Estimated PCASH received")).toBe("1,000 PCASH");
  expect(term("Estimated PCASH received")!.textContent).toContain("if your transaction is alone in its block");
  expect(row("Mining cost per 1,000 PCASH")).toBe("0.01 ETH");
  expect(panel().textContent).not.toContain("≈");
  expect(panel().textContent).not.toContain("Full supply");
  expect(panel().textContent).not.toContain("arketplace");
});

it("estimates no more per mine than recent crowded blocks paid each", async () => {
  state.estimate = ready();
  state.history = recentBlocks(5);
  await render();
  // Five per block share the 3,000 maximum: 600 each, below the 1,000 offer.
  expect(row("Estimated PCASH received")).toBe("600 PCASH");
  expect(term("Estimated PCASH received")!.textContent).toContain("at recent crowding, about 5 per block");
  expect(row("Mining cost per 1,000 PCASH")).toBe("0.017 ETH");
  state.history = recentBlocks(2);
  await render();
  expect(row("Estimated PCASH received")).toBe("1,000 PCASH");
  expect(term("Estimated PCASH received")!.textContent).toContain("if your transaction is alone in its block");
});

it("shows the marketplace only when its best listing beats mining", async () => {
  state.estimate = ready();
  state.listing = { weiPerThousand: 10n ** 16n + 1n, approximate: false };
  await render();
  expect(panel().textContent).not.toContain("arketplace");
  state.listing = { weiPerThousand: 5n * 10n ** 15n, approximate: false };
  await render();
  const link = [...panel().querySelectorAll("a")].find((node) => node.textContent?.startsWith("Better rate on the marketplace"))!;
  expect(link.getAttribute("href")).toBe("/marketplace");
  expect(link.textContent).toBe("Better rate on the marketplace →0.005 ETH before gas");
});

it("labels the button by whether the batch mines and relays other people's transactions", async () => {
  await render();
  expect(startButton().textContent).toBe("Mine");
  state.estimate = ready({ own: [Uint8Array.of(1)] });
  await render();
  expect(startButton().textContent).toBe("Mine");
  state.estimate = ready({ companions: { transactions: [Uint8Array.of(2)], collectibleOpenFee: 5n * PCASH } });
  await render();
  expect(startButton().textContent).toBe("Mine and relay");
  await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Mine one fewer transaction"]')!.click());
  expect(startButton().textContent).toBe("Relay transactions");
});

it("summarizes what relaying adds and says when the batch carries the wallet's own pending transactions", async () => {
  state.estimate = ready({ own: [Uint8Array.of(1)], companions: { transactions: [Uint8Array.of(2), Uint8Array.of(3)], collectibleOpenFee: 40n * PCASH + PCASH / 2n },
    actions: { qualifying: 4n, collectible: 4n }, actionsWithoutCompanions: { qualifying: 2n, collectible: 2n }, pendingCount: 12 });
  await render();
  const text = panel().textContent!;
  expect(text).toContain("12 pending transactions. This batch posts 3 of 12.");
  expect(text).toContain("Includes your own pending transactions. Their fees stay with you.");
  expect(text).toContain("Fees from other people’s transactions, on top of issuance: 41 PCASH");
  // Four actions share the 3,000 maximum (750 each) against two alone at 1,000 each, plus 40.5 in fees.
  expect(text).toContain("You get 1,041 PCASH more than mining alone");
  expect(text).toContain("Why the protocol pays");
});

it("leaves out the own-pending note and the gain when there is nothing to relay", async () => {
  state.estimate = ready({ pendingCount: 1 });
  await render();
  expect(panel().textContent).toContain("1 pending transaction. This batch posts 0 of 1.");
  expect(panel().textContent).not.toContain("Includes your own pending");
  expect(panel().textContent).not.toContain("more than mining alone");
});

it("says the pending count is unavailable rather than zero when the mempool could not be read", async () => {
  state.estimate = ready({ pendingCount: undefined });
  await render();
  expect(panel().textContent).toContain("Pending transactions are unavailable right now.");
  expect(panel().textContent).not.toContain("No pending transactions");
  expect(panel().textContent).not.toContain("This batch posts");
});

it("shows batch progress directly under the button inside the action panel", async () => {
  state.batch = { ...state.batch, progress: { phase: "preparing", message: "Selecting pending transactions…" } };
  await render();
  const status = afterButton()!;
  expect(panel().contains(status)).toBe(true);
  expect(status.textContent).toContain("Selecting pending transactions…");
  expect(status.querySelector("button")?.textContent).toBe("Cancel");
});

it("says Confirm in your wallet under the button while the wallet prompt is open", async () => {
  state.batch = { ...state.batch, progress: { phase: "submitting", message: "Confirm the Ethereum transaction…" }, finalCost: 10n ** 15n };
  await render();
  const line = afterButton()!.querySelector('[role="status"]')!;
  expect(line.textContent).toBe("Confirm in your wallet");
  expect(line.querySelector(".spinner")).not.toBeNull();
  expect(afterButton()!.textContent).not.toContain("Confirm the Ethereum transaction");
  expect(afterButton()!.querySelector("button")).toBeNull();
});

it("shows this visit's batch directly under the button with singular counts and an external link", async () => {
  state.batch = { ...state.batch, current: { id: "1", at: 0, status: "included", txHash: "0xabc", contentHashes: ["0xOWN", "0x2"], ownContentHashes: ["0xown"], controlledCommitments: [],
    collectedFee: 0n, collectedIssuance: 2n * PCASH, acceptedCount: 1, skippedCount: 1, minedElsewhereCount: 1 } };
  await render();
  const result = afterButton()!;
  expect(result.getAttribute("data-testid")).toBe("mining-result");
  expect(panel().contains(result)).toBe(true);
  expect(result.textContent).toContain("Batch included");
  expect(result.textContent).toContain("Collected fees 0 PCASH");
  expect(result.textContent).toContain("Includes your own pending transactions. Their fees stay with you.");
  expect(result.textContent).toContain("1 transaction succeeded; 1 was skipped or failed.");
  expect(result.textContent).toContain("1 of your mines was included by another poster");
  const link = result.querySelector<HTMLAnchorElement>('a[href="https://etherscan.io/tx/0xabc"]')!;
  expect(link.textContent).toBe("View Ethereum transaction");
  expect(link.querySelector("svg")).not.toBeNull();
});

it("waits for L1 inclusion with a spinner after the batch is posted", async () => {
  state.wallet = { ...state.wallet, submissionLock: { resolutionId: "r1", transactionHash: "0xabc" } };
  state.batch = { ...state.batch, progress: { phase: "confirming", message: "Waiting for Ethereum and PCASH inclusion…" },
    current: { id: "1", at: 0, status: "pending", txHash: "0xabc", resolutionId: "r1", contentHashes: [] } };
  await render();
  expect(startButton().textContent).toBe("Waiting for inclusion…");
  const result = afterButton()!;
  expect(result.getAttribute("data-testid")).toBe("mining-result");
  expect(result.querySelector('[role="status"]')!.textContent).toBe("Waiting for L1 inclusion");
  expect(result.querySelector(".spinner")).not.toBeNull();
  expect(panel().textContent).not.toContain("Estimates are not settled");
  state.batch = { ...state.batch, progress: undefined };
  await render();
  expect(panel().textContent).not.toContain("Resolve your existing Ethereum submission");
});

it("hides a batch that has neither a hash nor a failure", async () => {
  state.batch = { ...state.batch, current: { id: "1", at: 0, status: "wallet", contentHashes: [] } };
  await render();
  expect(element.querySelector('[data-testid="mining-result"]')).toBeNull();
});

it("links to the Ethereum submission only for an error that concerns one", async () => {
  state.batch = { ...state.batch, error: "No worthwhile pending transactions to relay right now.", submissionError: false };
  await render();
  expect(panel().querySelector('[role="alert"]')!.textContent).toBe("No worthwhile pending transactions to relay right now.");
  expect(panel().querySelector('a[href="/#ethereum-submission"]')).toBeNull();
  state.batch = { ...state.batch, error: "Rejected in wallet", submissionError: true };
  await render();
  expect(panel().querySelector('[role="alert"] a')!.textContent).toBe("Review Ethereum submission");
});

it("replaces the form with Connect wallet, Show ENS names, the terms and the connect error when disconnected", async () => {
  state.wallet = { ...state.wallet, phase: "disconnected", connectedAccount: undefined, profile: undefined, wallet: undefined, selfPublication: undefined,
    error: "Could not reach the network. Check your connection and try again." };
  await render();
  expect(panel().querySelector('[role="alert"]')!.textContent).toBe("Could not reach the network. Check your connection and try again.");
  expect(panel().textContent).toContain("By connecting a wallet, you agree to the Terms of Service.");
  expect(panel().querySelector('a[href="/terms"]')).not.toBeNull();
  expect(panel().querySelector("dl")).toBeNull();
  expect(panel().querySelector('[data-testid="mining-start"]')).toBeNull();
  expect(panel().textContent).not.toContain("—");
  const connect = [...panel().querySelectorAll("button")].find((node) => node.textContent === "Connect wallet")!;
  const ens = panel().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(ens.closest("label")!.textContent).toBe("Show ENS names");
  expect(connect.compareDocumentPosition(ens) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async () => connect.click());
  expect(state.connect).toHaveBeenCalledOnce();
});

it("puts the wallet's sign-in step in place of the form when connected but locked", async () => {
  state.wallet = { ...state.wallet, phase: "sign-in-required", profile: undefined };
  await render();
  expect(panel().querySelector('[data-testid="account-setup"]')).not.toBeNull();
  expect(panel().querySelector("dl")).toBeNull();
  expect(element.querySelectorAll('[data-testid="account-setup"]')).toHaveLength(1);
});

it("shows no next step while the saved connection is still resolving", async () => {
  state.wallet = { ...state.wallet, phase: "initializing", connectedAccount: undefined, profile: undefined, wallet: undefined, selfPublication: undefined };
  await render();
  expect(panel().querySelector('[data-testid="account-setup"]')).toBeNull();
  expect(panel().querySelector("button")).toBeNull();
  expect(panel().querySelector("h2")!.textContent).toBe("Mine and relay");
});
