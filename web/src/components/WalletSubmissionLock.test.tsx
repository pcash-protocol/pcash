// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfirmInWallet, useConfirmInWallet, WalletSubmissionLock } from "./WalletSubmissionLock.tsx";

const hash = `0x${"12".repeat(32)}`;
const state = vi.hoisted(() => ({
  lock: undefined as { transactionHash: string | null } | undefined,
  promptOpen: false,
  refresh: vi.fn(),
}));
vi.mock("../lib/WalletProvider.tsx", async () => ({
  useWallet: () => ({ submissionLock: state.lock, walletPromptOpen: state.promptOpen, refreshSubmissionLock: state.refresh }),
  errorMessage: (await import("./friendlyError.ts")).friendlyError,
}));
vi.mock("../lib/EthereumProvider.tsx", () => ({ useEthereumNetwork: () => ({ l1Chain: { blockExplorers: { default: { name: "Etherscan", url: "https://etherscan.io" } } } }) }));
let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.lock = { transactionHash: hash };
  state.promptOpen = false;
  state.refresh.mockReset().mockResolvedValue({ waiting: [], awaitingDerivation: [] });
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });
const render = (node = <WalletSubmissionLock />) => act(async () => root.render(node));
const clickRefresh = () => act(async () => element.querySelector<HTMLButtonElement>("button")!.click());

it("says nothing is blocking when there is no lock", async () => {
  state.lock = undefined;
  await render();
  expect(element.textContent).toContain("No Ethereum submission is blocking your wallet.");
  expect(element.querySelector("button")).toBeNull();
});

it("links a pending submission on the block explorer without polling on its own", async () => {
  await render();
  const link = element.querySelector<HTMLAnchorElement>(`a[href="https://etherscan.io/tx/${hash}"]`)!;
  expect(link.textContent).toBe("View on Etherscan");
  expect(element.textContent).not.toContain("0x1212");
  expect(state.refresh).not.toHaveBeenCalled();
});

it("reports a submission that is still pending", async () => {
  state.refresh.mockResolvedValue({ waiting: [{ transactionHash: hash }], awaitingDerivation: [] });
  await render();
  await clickRefresh();
  expect(element.querySelector('[role="status"]')!.textContent).toBe("Still pending on Ethereum.");
});

it("reports a cleared lock after the provider drops it", async () => {
  await render();
  await clickRefresh();
  state.lock = undefined;
  await render();
  expect(element.querySelector('[role="status"]')!.textContent).toBe("Cleared. You can submit again.");
  expect(element.textContent).not.toContain("No Ethereum submission is blocking");
});

it("shows a failed refresh in plain words", async () => {
  state.refresh.mockRejectedValue(new TypeError("Failed to fetch"));
  await render();
  await clickRefresh();
  expect(element.querySelector('[role="status"]')!.textContent).toBe("Could not reach the network. Check your connection and try again.");
  expect(element.querySelector("button")!.disabled).toBe(false);
});

function Probe({ running }: { running: boolean }) {
  return useConfirmInWallet(running) ? <ConfirmInWallet /> : null;
}
// A lock left without a hash from an earlier session has no open prompt.
it.each([
  [true, true, true],
  [false, true, false],
  [true, false, false],
])("asks to confirm in the wallet only for running work whose prompt is open (running %s, prompt open %s)", async (running, promptOpen, shown) => {
  state.lock = { transactionHash: null };
  state.promptOpen = promptOpen;
  await render(<Probe running={running} />);
  expect(element.textContent).toBe(shown ? "Confirm in your wallet" : "");
});

it("reports a mined transaction as waiting for PCASH, not Ethereum", async () => {
  state.refresh.mockResolvedValue({ waiting: [{ transactionHash: hash }], awaitingDerivation: ["setup"] });
  await render();
  await clickRefresh();
  expect(element.querySelector('[role="status"]')!.textContent).toBe("Ethereum confirmed your transaction. Waiting for PCASH to process it.");
  expect(element.textContent).not.toContain("pending on Ethereum");
  expect(element.textContent).not.toContain("Pending on Ethereum");
});

it("keeps mixed confirmations distinct", async () => {
  state.refresh.mockResolvedValue({ waiting: [{ transactionHash: hash }, { transactionHash: "another" }], awaitingDerivation: ["setup"] });
  await render();
  await clickRefresh();
  expect(element.querySelector('[role="status"]')!.textContent).toContain("Other Ethereum submissions are still unresolved.");
});

it("does not claim an unhashed submission is pending on Ethereum", async () => {
  state.lock = { transactionHash: null };
  state.refresh.mockResolvedValue({ waiting: [{ transactionHash: null }], awaitingDerivation: [] });
  await render();
  await clickRefresh();
  expect(element.querySelector('[role="status"]')!.textContent).toBe("Your Ethereum wallet has not returned a transaction for this submission.");
});
