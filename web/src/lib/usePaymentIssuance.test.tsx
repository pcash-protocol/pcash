// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  quote: vi.fn(), economics: vi.fn(),
  wallet: { node: {}, status: { pcashChainId: 1, genesisHash: "a", latestBlock: 1n, latestBlockHash: "head-1", latestBlockTimestamp: 12n } },
}));
vi.mock("./WalletProvider.tsx", () => ({ useWallet: () => state.wallet }));
vi.mock("@pcash/sdk/relay", () => ({ nextBlockIssuanceQuote: (...args: unknown[]) => state.quote(...args), recentBlockEconomics: (...args: unknown[]) => state.economics(...args) }));
vi.mock("@pcash/sdk/wallet/actions", () => ({ paymentIssuanceFromInputs: (quote: { maxSingleActionReward: bigint } | null) => quote?.maxSingleActionReward ?? 0n }));
import { ISSUANCE_DISPLAY_REFRESH_MS, usePaymentIssuance } from "./usePaymentIssuance.ts";

// Fake timers would otherwise hold the query's batched updates.
notifyManager.setScheduler((callback) => callback());
let root: Root;
let element: HTMLDivElement;
let client: QueryClient;
let observed: ReturnType<typeof usePaymentIssuance>;
function Probe() { observed = usePaymentIssuance(true); return <p>{observed.issuance?.toString() ?? "unavailable"}</p>; }
const render = () => act(async () => root.render(<QueryClientProvider client={client}><Probe /><Probe /></QueryClientProvider>));
const nextHead = () => { state.wallet.status = { ...state.wallet.status, latestBlock: state.wallet.status.latestBlock + 1n, latestBlockHash: `head-${state.wallet.status.latestBlock + 1n}` }; };
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.quote.mockReset(); state.economics.mockReset().mockResolvedValue({ records: [] });
  state.wallet.status = { pcashChainId: 1, genesisHash: "a", latestBlock: 1n, latestBlockHash: "head-1", latestBlockTimestamp: 12n };
  client = new QueryClient();
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("reads once for every view, keeps the value across new heads, and refreshes on the display cadence", async () => {
  state.quote.mockResolvedValueOnce({ maxSingleActionReward: 7n }).mockResolvedValue({ maxSingleActionReward: 9n });
  await render();
  expect(element.textContent).toBe("77");
  nextHead();
  await render();
  expect(element.textContent).toBe("77");
  expect(state.quote).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(ISSUANCE_DISPLAY_REFRESH_MS));
  expect(state.quote).toHaveBeenCalledTimes(2);
  expect(state.quote.mock.calls[1]![1]).toMatchObject({ latestBlockHash: "head-2" });
  expect(state.economics.mock.calls[1]![1]).toBe(2n);
  expect(element.textContent).toBe("99");
});

it("keeps unavailable distinct from zero and keeps each input's last value when a refresh fails", async () => {
  state.quote.mockRejectedValueOnce(new Error("quote unavailable")).mockResolvedValueOnce({ maxSingleActionReward: 0n })
    .mockRejectedValue(new Error("quote unavailable"));
  state.economics.mockRejectedValueOnce(new Error("index unavailable")).mockResolvedValue({ records: [] });
  await render();
  expect(observed.issuance).toBeUndefined();
  expect(observed.inputs?.quote.status).toBe("rejected");
  expect(observed.inputs?.economics.status).toBe("rejected");
  await act(async () => vi.advanceTimersByTimeAsync(ISSUANCE_DISPLAY_REFRESH_MS));
  expect(observed.issuance).toBe(0n);
  await act(async () => vi.advanceTimersByTimeAsync(ISSUANCE_DISPLAY_REFRESH_MS));
  expect(state.quote).toHaveBeenCalledTimes(3);
  expect(observed.issuance).toBe(0n);
});
