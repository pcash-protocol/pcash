// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ plan: vi.fn(), quote: vi.fn(), wallet: { node: {}, status: { pcashChainId: 1, genesisHash: "a", latestBlockHash: "one" }, profile: {}, selfPublication: {}, connectedAccount: "address", snapshot: undefined } }));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet, errorMessage: (error: Error) => error.message }));
vi.mock("../../lib/fastBatch.ts", () => ({ planFastBatch: (...args: unknown[]) => state.plan(...args) }));
vi.mock("@pcash/sdk/wallet/actions", () => ({ PADDED_PRIVATE_VALUE_BYTE_SIZE: 10n }));
import { useGetEstimate } from "./useGetEstimate.ts";
import type { DisplayIssuanceInputs } from "../../lib/usePaymentIssuance.ts";
let root: Root, element: HTMLDivElement, observed: ReturnType<typeof useGetEstimate>;
let count: number, inputs: DisplayIssuanceInputs;
function Probe() { observed = useGetEstimate(count, true, inputs); return null; }
const render = () => act(async () => root.render(<Probe />));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.plan.mockReset().mockResolvedValue({ own: [], companions: { transactions: [], collectibleOpenFee: 0n }, expectedIssuance: 5n });
  state.quote.mockReset().mockResolvedValue({ estimatedCostWei: 10n });
  state.wallet.selfPublication = { quoteBatch: state.quote };
  state.wallet.status = { pcashChainId: 1, genesisHash: "a", latestBlockHash: "one" };
  count = 1; inputs = { quote: { status: "fulfilled", value: {} }, economics: { status: "fulfilled", value: {} } } as DisplayIssuanceInputs;
  element = document.createElement("div"); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
it("does not replan each head and retains numbers on background failure", async () => {
  await render(); expect(observed.state).toBe("ready");
  state.wallet.status = { ...state.wallet.status, latestBlockHash: "two" }; await render();
  expect(state.plan).toHaveBeenCalledTimes(1); expect(state.quote).toHaveBeenCalledTimes(1);
  state.plan.mockRejectedValue(new Error("unavailable")); inputs = { ...inputs }; await render();
  expect(observed.state).toBe("ready");
  if (observed.state === "ready") { expect(observed.plan.expectedIssuance).toBe(5n); expect(observed.refreshError).toBe("unavailable"); }
});
it("does not display another count or network's quote", async () => {
  await render();
  state.plan.mockReturnValue(new Promise(() => {})); count = 2; await render(); expect(observed.state).toBe("loading");
  count = 1; state.wallet.status = { ...state.wallet.status, genesisHash: "other" }; await render(); expect(observed.state).toBe("loading");
});

it("quotes the required mine when optional mempool lookup is unavailable", async () => {
  const actual = await vi.importActual<typeof import("../../lib/fastBatch.ts")>("../../lib/fastBatch.ts");
  state.plan.mockImplementation(actual.planFastBatch);
  state.wallet.node = { getMempool: vi.fn(async () => { throw new Error("mempool unavailable"); }) };
  inputs = { quote: { status: "fulfilled", value: { internalOffer: 10n, blockAllowance: 100n, supplyCap: 1000n, issuedSoFar: 0n, exhausted: false } },
    economics: { status: "fulfilled", value: { records: [{ qualifyingActions: 0n, blocks: 1n }] } } } as DisplayIssuanceInputs;
  await render();
  expect(observed.state).toBe("ready");
  if (observed.state === "ready") { expect(observed.plan.actions).toEqual({ qualifying: 1n, collectible: 1n }); expect(observed.plan.companions.transactions).toEqual([]); }
  expect(state.quote).toHaveBeenCalledWith(expect.objectContaining({ transactions: [new Uint8Array(10).fill(255)] }));
});

it("does not quote relay-only acquisition when mempool lookup fails", async () => {
  const actual = await vi.importActual<typeof import("../../lib/fastBatch.ts")>("../../lib/fastBatch.ts");
  state.plan.mockImplementation(actual.planFastBatch);
  state.wallet.node = { getMempool: vi.fn(async () => { throw new Error("mempool unavailable"); }) };
  count = 0;
  await render();
  expect(observed).toEqual({ state: "error", message: "mempool unavailable" });
  expect(state.quote).not.toHaveBeenCalled();
});

it("keeps Ethereum quote failures fatal for required mines", async () => {
  state.quote.mockRejectedValue(new Error("Ethereum balance unavailable"));
  await render();
  expect(observed).toEqual({ state: "error", message: "Ethereum balance unavailable" });
});
