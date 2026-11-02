// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WalletNativeActivity, WalletNativeActivityEntry } from "@pcash/sdk/wallet";
import type { WalletPaymentActivity } from "../lib/WalletProvider.tsx";

const PCASH = 10n ** 18n;
const RECIPIENT = `0x${"34".repeat(20)}`;
const state = vi.hoisted(() => ({
  wallet: {} as {
    wallet: ReturnType<typeof fakeWallet>; snapshot: { pendingContentHashes: string[] }; funds: { pcashNumber: bigint; synchronized: boolean } | undefined;
    phase: string; paymentActivity: Partial<WalletPaymentActivity>[];
  },
  activity: undefined as WalletNativeActivity | undefined,
}));
vi.mock("../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet }));
vi.mock("../lib/useNativeActivity.ts", () => ({ useNativeActivity: () => ({ activity: state.activity }) }));
import { useWalletToasts, WalletToasts, WalletToastWatcher } from "./WalletPanelToasts.tsx";

/** A wallet that delivers the action events a test emits. */
function fakeWallet() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    on(name: string, listener: (event: unknown) => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
      return () => { listeners.get(name)!.delete(listener); };
    },
    emit(name: string, event: unknown) { listeners.get(name)?.forEach((listener) => listener(event)); },
  };
}

function Toasts() {
  const { toasts, show, dismiss } = useWalletToasts();
  return <><WalletToastWatcher onToasts={show} /><WalletToasts toasts={toasts} onDismiss={dismiss} /></>;
}

let element: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.wallet = { wallet: fakeWallet(), snapshot: { pendingContentHashes: [] }, funds: { pcashNumber: 10n, synchronized: true }, phase: "ready", paymentActivity: [] };
  state.activity = undefined;
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
  await render();
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const render = () => act(async () => root.render(<Toasts />));
const shown = () => [...element.querySelectorAll("[role=status] > div > span")].map((node) => node.textContent);
/** This session's wallet starts an action and journals its transaction. */
const start = (name: string, contentHash: string) => act(async () => {
  state.wallet.wallet.emit("action:started", { action: { id: `action-${contentHash}`, name } });
  state.wallet.wallet.emit("action:before-journal", { action: { id: `action-${contentHash}`, name }, contentHash, transactionHex: "0x00" });
});
const entry = (blockNumber: bigint, overrides: Partial<WalletNativeActivityEntry> = {}): WalletNativeActivityEntry => ({
  transactionId: `0x${blockNumber.toString(16).padStart(64, "0")}`, direction: "received", amount: 2n * PCASH, blockNumber, blockHash: `0x${blockNumber}`,
  timestamp: 100n, commitments: [`0xc${blockNumber}`], payout: null, ...overrides,
});
/** A new history read through `pcashNumber`. */
async function read(pcashNumber: bigint, entries: WalletNativeActivityEntry[]) {
  state.activity = { state: "ready", pcashHash: `0x${pcashNumber}`, pcashNumber, entries };
  await render();
}
const tx = (byte: string) => `0x${byte.repeat(32)}`;

it("confirms a payment this session sent, once", async () => {
  await start("send", tx("AB"));
  const sent = { kind: "payment" as const, contentHash: tx("ab"), amount: 10n * PCASH, recipientAddress: RECIPIENT };
  state.wallet.paymentActivity = [{ ...sent, status: "pending" }];
  await render();
  expect(shown()).toEqual([]);
  state.wallet.paymentActivity = [{ ...sent, status: "confirmed" }];
  await render();
  state.wallet.paymentActivity = [{ ...sent, status: "finalized" }];
  await render();
  expect(shown()).toEqual(["Sent 10 PCASH to 0x343434…343434"]);
});

it("stays quiet about a retried payment and one pending when the session opened", async () => {
  state.wallet.snapshot = { pendingContentHashes: [tx("aa")] };
  await render();
  await start("send", tx("aa"));
  state.wallet.paymentActivity = [tx("aa"), tx("bb")].map((contentHash) => ({ kind: "payment", contentHash, amount: PCASH, recipientAddress: RECIPIENT, status: "confirmed" }));
  await render();
  expect(shown()).toEqual([]);
});

it("announces account setup once it finishes", async () => {
  for (const phase of ["activation-required", "activating", "ready", "ready"]) {
    state.wallet.phase = phase;
    await render();
  }
  expect(shown()).toEqual(["Your PCASH account is set up"]);
});

it("announces what history receives after the funds baseline, once per set of notes", async () => {
  await read(12n, [
    entry(12n, { transactionId: null, amount: 5n * PCASH, payout: { openFeeAmount: 0n, issuanceAmount: 5n * PCASH } }),
    entry(11n, { commitments: ["0xb", "0xa"] }),
    entry(10n),
  ]);
  expect(shown()).toEqual(["Mined 5 PCASH", "Received 2 PCASH"]);
  // A reorg re-includes the payment under another transaction in another block.
  await read(14n, [entry(14n, { commitments: ["0xa", "0xb"] }), entry(12n, { transactionId: null, amount: 5n * PCASH, payout: { openFeeAmount: 0n, issuanceAmount: 5n * PCASH } })]);
  expect(shown()).toEqual(["Mined 5 PCASH", "Received 2 PCASH"]);
});

it("keeps history at or below the first funds' block quiet, including what recovery finds later", async () => {
  await read(10n, [entry(10n), entry(4n)]);
  state.wallet.funds = { pcashNumber: 13n, synchronized: true };
  await read(13n, [entry(9n), entry(3n, { direction: "spent", contentHash: tx("cc") })]);
  expect(shown()).toEqual([]);
});

it("sets the baseline only once the initial sync reaches the node's head", async () => {
  state.wallet = { ...state.wallet, wallet: fakeWallet(), funds: { pcashNumber: 5n, synchronized: false } };
  await read(5n, [entry(5n), entry(4n)]);
  // Payments received while offline arrive as the initial sync catches up.
  state.wallet.funds = { pcashNumber: 12n, synchronized: true };
  await read(12n, [entry(12n), entry(8n), entry(5n)]);
  expect(shown()).toEqual([]);
  await read(13n, [entry(13n), entry(12n)]);
  expect(shown()).toEqual(["Received 2 PCASH"]);
});

it("names a landed spend by the action this session started, leaving payments to their receipts", async () => {
  await start("asset-creation", tx("01"));
  await start("marketplace:buy", tx("02"));
  await start("send", tx("03"));
  const spent = (blockNumber: bigint, contentHash: string) => entry(blockNumber, { direction: "spent", contentHash, commitments: [] });
  await read(15n, [spent(15n, tx("01")), spent(14n, tx("02")), spent(13n, tx("03")), spent(12n, tx("04"))]);
  expect(shown()).toEqual(["Token created", "Marketplace transaction confirmed"]);
});

it("starts over for another wallet", async () => {
  await start("asset-burn", tx("05"));
  state.wallet = { ...state.wallet, wallet: fakeWallet(), funds: { pcashNumber: 20n, synchronized: true } };
  await read(20n, [entry(15n), entry(14n, { direction: "spent", contentHash: tx("05"), commitments: [] })]);
  expect(shown()).toEqual([]);
});

it("dismisses a toast after 6 seconds or on Dismiss", async () => {
  vi.useFakeTimers();
  await read(12n, [entry(12n, { amount: 3n * PCASH }), entry(11n)]);
  expect(shown()).toEqual(["Received 3 PCASH", "Received 2 PCASH"]);
  await act(async () => element.querySelectorAll<HTMLButtonElement>('button[aria-label="Dismiss"]')[1]!.click());
  expect(shown()).toEqual(["Received 3 PCASH"]);
  await act(async () => { vi.advanceTimersByTime(5_999); });
  expect(shown()).toEqual(["Received 3 PCASH"]);
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(shown()).toEqual([]);
});
