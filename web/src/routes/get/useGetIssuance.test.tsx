// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ quote: vi.fn(), economics: vi.fn(), history: vi.fn(), wallet: { node: {}, status: { pcashChainId: 1, genesisHash: "a", latestBlock: 1n, latestBlockHash: "one", latestBlockTimestamp: 12n } } }));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet }));
vi.mock("@pcash/sdk/relay", () => ({ nextBlockIssuanceQuote: (...args: unknown[]) => state.quote(...args), recentBlockEconomics: (...args: unknown[]) => state.economics(...args) }));
vi.mock("./issuanceOverviewModel.ts", () => ({ readIssuanceWindows: (...args: unknown[]) => state.history(...args) }));
import { useGetIssuance, GET_DISPLAY_REFRESH_MS } from "./useGetIssuance.ts";
let root: Root, element: HTMLDivElement, observed: ReturnType<typeof useGetIssuance>;
function Probe() { observed = useGetIssuance(); return null; }
const render = () => act(async () => root.render(<Probe />));
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.quote.mockReset().mockResolvedValue({ maxSingleActionReward: 5n });
  state.economics.mockReset().mockResolvedValue({ records: [] });
  state.history.mockReset().mockResolvedValue({ supply: [], day: { qualifyingActions: 0n, issuanceTotal: 0n }, week: { qualifyingActions: 0n, issuanceTotal: 0n }, asOf: 12n });
  state.wallet.status = { pcashChainId: 1, genesisHash: "a", latestBlock: 1n, latestBlockHash: "one", latestBlockTimestamp: 12n };
  element = document.createElement("div"); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("shares one display read and keeps it through new heads and failed refresh", async () => {
  await render();
  const inputs = observed.inputs;
  state.wallet.status = { ...state.wallet.status, latestBlock: 2n, latestBlockHash: "two" };
  await render();
  expect(observed.inputs).toBe(inputs);
  expect(state.quote).toHaveBeenCalledTimes(1); expect(state.economics).toHaveBeenCalledTimes(1); expect(state.history).toHaveBeenCalledTimes(1);
  state.quote.mockRejectedValue(new Error("unavailable")); state.history.mockRejectedValue(new Error("unavailable"));
  await act(async () => vi.advanceTimersByTimeAsync(GET_DISPLAY_REFRESH_MS));
  expect(observed.inputs?.quote).toBe(inputs?.quote);
  expect(observed.history?.day.issuanceTotal).toBe(0n);
  expect(observed.error).toBeDefined();
  expect(state.history).toHaveBeenCalledTimes(1);
});
it("distinguishes unavailable history from measured zero and clears data on network change", async () => {
  state.history.mockRejectedValue(new Error("unavailable")); state.economics.mockRejectedValue(new Error("unavailable"));
  await render();
  expect(observed.history).toBeUndefined(); expect(observed.inputs?.economics.status).toBe("rejected");
  state.wallet.status = { ...state.wallet.status, genesisHash: "b" };
  state.quote.mockReturnValue(new Promise(() => {}));
  await render();
  expect(observed.inputs).toBeUndefined();
});
