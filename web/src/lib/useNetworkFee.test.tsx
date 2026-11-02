// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { quoteNetworkFee } from "@pcash/sdk/protocol";

const state = vi.hoisted(() => ({ wallet: { node: { status: vi.fn() }, status: undefined as { feeExcess: bigint } | undefined } }));
vi.mock("./WalletProvider.tsx", () => ({ useWallet: () => state.wallet }));
import { NETWORK_FEE_REFRESH_MS, S_ACTION_UNITS, S_ACTION_WITH_ACCOUNT_UNITS, useNetworkFee } from "./useNetworkFee.ts";

// Far enough above the target that the projected base fee is positive.
const BUSY = 1_400_000n;
let root: Root;
let element: HTMLDivElement;
let observed: bigint | undefined;
function Probe({ enabled = true }: { enabled?: boolean }) { observed = useNetworkFee(S_ACTION_UNITS, enabled); return null; }
const render = (enabled = true) => act(async () => root.render(<Probe enabled={enabled} />));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.wallet.node.status.mockReset();
  state.wallet.status = { feeExcess: 0n };
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("counts a new account's units beside a profile S action's nullifiers", () => {
  expect([S_ACTION_UNITS, S_ACTION_WITH_ACCOUNT_UNITS]).toEqual([4n, 6n]);
});

it("quotes from the node's latest fee excess and sees the fee return to zero", async () => {
  state.wallet.node.status.mockResolvedValueOnce({ feeExcess: BUSY }).mockResolvedValue({ feeExcess: 0n });
  await render();
  expect(observed).toBe(quoteNetworkFee(BUSY, S_ACTION_UNITS));
  expect(observed).toBeGreaterThan(0n);
  await act(async () => vi.advanceTimersByTimeAsync(NETWORK_FEE_REFRESH_MS));
  expect(observed).toBe(0n);
  expect(state.wallet.node.status).toHaveBeenCalledTimes(2);
});

it("starts from the wallet's status and keeps it when the node read fails", async () => {
  state.wallet.status = { feeExcess: BUSY };
  state.wallet.node.status.mockRejectedValue(new Error("node unavailable"));
  await render();
  expect(observed).toBe(quoteNetworkFee(BUSY, S_ACTION_UNITS));
});

it("reads nothing while disabled or before any status is known", async () => {
  await render(false);
  expect(observed).toBeUndefined();
  state.wallet.status = undefined;
  await render();
  expect(observed).toBeUndefined();
  expect(state.wallet.node.status).not.toHaveBeenCalled();
});
