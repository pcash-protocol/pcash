// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  quote: vi.fn(),
  wallet: {
    node: {},
    status: { latestBlockHash: "0x01" },
    profile: { address: 1n, nkRoot: 2n },
    connectedAccount: "0xbuyer",
    snapshot: { pendingContentHashes: [] as string[] },
    selfPublication: { quoteBatch: (...args: unknown[]) => mocks.quote(...args) },
  },
}));
vi.mock("./WalletProvider.tsx", () => ({ useWallet: () => mocks.wallet, errorMessage: (cause: unknown) => String(cause) }));
vi.mock("./fastBatch.ts", () => ({ planFastBatch: (...args: unknown[]) => mocks.plan(...args) }));
import { useFastSendEstimate } from "./useFastSendEstimate.ts";
import type { DisplayIssuanceInputs } from "./usePaymentIssuance.ts";

let root: Root;
let container: HTMLDivElement;
function Estimate({ count, shared }: { count: number; shared: DisplayIssuanceInputs | null | undefined }) {
  const estimate = useFastSendEstimate(true, count, shared);
  return <p>{estimate?.state === "ready" ? `${estimate.estimatedCostWei} wei` : estimate?.state ?? "none"}</p>;
}
const render = (count = 1, shared?: DisplayIssuanceInputs | null) => act(async () => root.render(<Estimate count={count} shared={shared} />));
function deferredQuote() {
  let resolve!: (cost: bigint) => void;
  mocks.quote.mockImplementationOnce(() => new Promise(done => { resolve = cost => done({ estimatedCostWei: cost, maximumCostWei: cost }); }));
  return (cost: bigint) => act(async () => resolve(cost));
}

beforeEach(() => {
  mocks.plan.mockReset().mockResolvedValue({ own: [], companions: { transactions: [], collectibleOpenFee: 0n, collectibleOpenFees: [] }, expectedIssuance: 0n });
  mocks.quote.mockReset().mockResolvedValue({ estimatedCostWei: 5n, maximumCostWei: 9n });
  mocks.wallet.status = { latestBlockHash: "0x01" };
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("keeps the last estimate while a new head re-plans the same batch", async () => {
  await render();
  expect(container.textContent).toBe("5 wei");
  const finish = deferredQuote();
  mocks.wallet.status = { latestBlockHash: "0x02" };
  await render();
  expect(mocks.plan).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe("5 wei");
  await finish(7n);
  expect(container.textContent).toBe("7 wei");
});

it("estimates afresh when the batch itself changes", async () => {
  await render();
  expect(container.textContent).toBe("5 wei");
  const finish = deferredQuote();
  await render(2);
  expect(container.textContent).toBe("loading");
  await finish(11n);
  expect(container.textContent).toBe("11 wei");
});

it("does not display a previous network estimate while shared issuance inputs load", async () => {
  await render();
  expect(container.textContent).toBe("5 wei");
  mocks.wallet.node = {};
  mocks.wallet.status = { latestBlockHash: "0x02" };
  await render(1, null);
  expect(container.textContent).toBe("loading");
  const inputs = { quote: { status: "fulfilled" as const, value: null }, economics: { status: "rejected" as const, reason: new Error("unavailable") } };
  await render(1, inputs);
  expect(mocks.plan).toHaveBeenLastCalledWith(expect.objectContaining({ issuanceInputs: inputs }));
  expect(container.textContent).toBe("5 wei");
});

it("keeps a same-network head estimate while its next shared pair loads", async () => {
  const inputs = { quote: { status: "fulfilled" as const, value: null }, economics: { status: "rejected" as const, reason: new Error("unavailable") } };
  await render(1, inputs);
  expect(container.textContent).toBe("5 wei");
  mocks.wallet.status = { latestBlockHash: "0x02" };
  await render(1, null);
  expect(container.textContent).toBe("5 wei");
  const finish = deferredQuote();
  await render(1, inputs);
  expect(container.textContent).toBe("5 wei");
  await finish(7n);
  expect(container.textContent).toBe("7 wei");
});
