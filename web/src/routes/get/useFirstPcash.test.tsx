// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EarnReading } from "../wallet/earnOutcome.ts";

const state = vi.hoisted(() => ({
  wallet: {} as Record<string, unknown>,
  reading: undefined as unknown,
  resolve: vi.fn(),
}));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet }));
vi.mock("../wallet/earnOutcome.ts", () => ({ resolveEarnLanding: state.resolve }));
import { useFirstPcash, type FirstPcash } from "./useFirstPcash.ts";

const SETUP = `0x${"ab".repeat(32)}`;
const landed = (yours: boolean | null, issuanceAmount = 800n): EarnReading => ({ kind: "landed", landing: {
  contentHash: SETUP, transactionId: "0x01", blockNumber: 1n, blockHash: "0x02", timestamp: 0n, l1TransactionHash: "0xl1", outcome: "succeeded", block: null,
  payout: { route: "designated", destination: "0x03", openFeeAmount: issuanceAmount === 0n ? 0n : 2n, issuanceAmount, yours },
} } as EarnReading);

let element: HTMLDivElement;
let root: Root;
let client: QueryClient;
let seen: FirstPcash | undefined;
function Probe({ accountReady }: { accountReady: boolean }) { seen = useFirstPcash(accountReady); return null; }
/** Lets the query resolve and the probe re-render until the check holds. */
const settle = (check: () => void) => vi.waitFor(async () => { await act(async () => undefined); check(); });
const render = (accountReady: boolean) => act(async () => root.render(<QueryClientProvider client={client}><Probe accountReady={accountReady} /></QueryClientProvider>));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.wallet = { node: {}, profile: { address: 1n, nkRoot: 2n } };
  state.resolve.mockReset().mockImplementation(async () => state.reading);
  seen = undefined;
  element = document.createElement("div"); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it("is undefined when this page saw no setup", async () => {
  await render(true);
  expect(seen).toBeUndefined();
  expect(state.resolve).not.toHaveBeenCalled();
});

it("keeps the setup's hash after the wallet clears it and reports what its mine paid this wallet", async () => {
  state.wallet = { ...state.wallet, activationContentHash: SETUP };
  await render(false);
  expect(seen).toBeUndefined();
  state.reading = landed(true);
  state.wallet = { node: state.wallet.node, profile: state.wallet.profile };
  await render(true);
  await settle(() => expect(seen).toEqual({ amount: 802n, l1TransactionHash: "0xl1" }));
  expect(state.resolve).toHaveBeenCalledWith(state.wallet.node, SETUP, state.wallet.profile, expect.objectContaining({ indexAttempts: 1 }));
});

it("waits while the payout's owner is unknown", async () => {
  state.wallet = { ...state.wallet, activationContentHash: SETUP };
  state.reading = landed(null);
  await render(true);
  await settle(() => expect(state.resolve).toHaveBeenCalledOnce());
  expect(seen).toEqual({});
});

it.each([
  ["paid nothing", landed(null, 0n)],
  ["paid someone else", landed(false)],
  ["failed", { kind: "landed", landing: { ...(landed(true) as { landing: object }).landing, outcome: "rejected", payout: null } }],
])("shows nothing once the setup %s", async (_name, reading) => {
  state.wallet = { ...state.wallet, activationContentHash: SETUP };
  state.reading = reading;
  await render(true);
  await settle(() => expect(state.resolve).toHaveBeenCalledOnce());
  await settle(() => expect(seen).toBeUndefined());
});

it("shows nothing when the receipt read fails", async () => {
  state.wallet = { ...state.wallet, activationContentHash: SETUP };
  state.resolve.mockRejectedValue(new Error("node unavailable"));
  await render(true);
  await settle(() => expect(state.resolve).toHaveBeenCalledOnce());
  await settle(() => expect(seen).toBeUndefined());
});

it("stops reading once the page no longer wants the result", async () => {
  state.wallet = { ...state.wallet, activationContentHash: SETUP };
  state.reading = landed(true);
  await render(false);
  expect(seen).toBeUndefined();
  expect(state.resolve).not.toHaveBeenCalled();
});
