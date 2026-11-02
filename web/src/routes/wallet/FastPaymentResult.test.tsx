// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { TransactionReceiptNotFoundError } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ ethereum: vi.fn(), pcash: vi.fn(), config: {}, node: {}, busy: false }));
vi.mock("wagmi/actions", () => ({ getPublicClient: () => ({ getTransactionReceipt: state.ethereum }) }));
vi.mock("@pcash/sdk/clients", () => ({ pollReceipt: state.pcash }));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => ({ node: state.node, busy: state.busy }) }));
vi.mock("../../lib/EthereumProvider.tsx", () => ({ useEthereumNetwork: () => ({ ethereumConfig: state.config, l1ChainId: 1 }) }));
import { FastPaymentResult, usePaymentConfirmation } from "./FastPaymentResult.tsx";

const HASH = `0x${"ab".repeat(32)}` as const;
const CONTENT_HASH = `0x${"ab".repeat(32)}`;
const TX_ID = `0x${"cd".repeat(32)}`;
let root: Root;
let element: HTMLDivElement;
const sendAnother = vi.fn();
function Tracked({ hash }: { hash: string }) {
  return <FastPaymentResult hash={hash} confirmation={usePaymentConfirmation(hash, CONTENT_HASH)} onDone={undefined} onSendAnother={sendAnother} />;
}
const render = (hash = HASH) => act(async () => root.render(<MemoryRouter><Tracked hash={hash} /></MemoryRouter>));
const text = () => element.textContent ?? "";
const advance = () => act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  state.busy = false;
  state.ethereum.mockReset().mockRejectedValue(new TransactionReceiptNotFoundError({ hash: HASH }));
  state.pcash.mockReset().mockResolvedValue(null);
  sendAnother.mockReset();
  element = document.createElement("div"); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("fast payment inclusion progress", () => {
  it("automatically advances from broadcast to L1 inclusion to PCASH acceptance", async () => {
    await render();
    expect(text()).toContain("Posted to Ethereum, waiting for inclusion");
    expect(text()).toContain(HASH);
    expect(element.querySelector("[aria-hidden=true]")).not.toBeNull();
    expect([...element.querySelectorAll("button")].find((node) => node.textContent === "Send another")?.disabled).toBe(true);
    state.ethereum.mockResolvedValue({ status: "success" });
    await advance();
    expect(text()).toContain("Included on Ethereum");
    expect(text()).toContain("Waiting for PCASH to process");
    expect(text()).not.toContain("Payment confirmed");
    state.pcash.mockResolvedValue({ transactionId: TX_ID, accepted: true, outcome: "succeeded" });
    await advance();
    expect(text()).toContain("Payment confirmed in PCASH");
    expect(element.querySelector(`a[href="/tx/${TX_ID}"]`)).not.toBeNull();
    expect(element.querySelector("button")?.disabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the hash and retries status lookup failures without treating them as rejection", async () => {
    state.ethereum.mockRejectedValue(new Error("RPC unavailable"));
    await render();
    expect(text()).toContain(HASH);
    expect(text()).toContain("We’ll keep checking");
    expect(text()).not.toContain("reverted");
    state.ethereum.mockResolvedValue({ status: "success" });
    await advance();
    expect(text()).toContain("Included on Ethereum");
    expect(text()).not.toContain("temporarily unavailable");
  });

  it("keeps checking canonical PCASH after an Ethereum status-zero receipt", async () => {
    state.ethereum.mockResolvedValue({ status: "reverted" });
    await render();
    expect(text()).toContain("Included on Ethereum");
    expect(text()).toContain("Waiting for PCASH to process");
    expect(text()).not.toContain("did not deliver");
    expect(text()).not.toContain("Payment confirmed");
    expect(text()).not.toContain("waiting for inclusion");
    expect(element.querySelector('a[href$="#ethereum-submission"]')).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    state.pcash.mockResolvedValue({ transactionId: TX_ID, outcome: "succeeded" });
    await advance();
    expect(text()).toContain("Payment confirmed in PCASH");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not confuse Ethereum inclusion with PCASH acceptance", async () => {
    state.ethereum.mockResolvedValue({ status: "success" });
    state.pcash.mockResolvedValue({ transactionId: TX_ID, accepted: false, outcome: "nullifierAlreadySpent" });
    await render();
    expect(text()).toContain("Included on Ethereum");
    expect(text()).toContain("PCASH did not accept this payment. This transaction tried to spend a note that had already been spent.");
    expect(text()).not.toContain("nullifierAlreadySpent");
    expect(text()).not.toContain("Payment confirmed");
    // The form above offers Try again with the values kept; Send another would clear them.
    expect([...element.querySelectorAll("button")].some((node) => node.textContent === "Send another")).toBe(false);
  });

  it("ignores a late receipt for a different payment", async () => {
    let finish!: (receipt: unknown) => void;
    state.ethereum.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render();
    const nextHash = `0x${"ef".repeat(32)}` as typeof HASH;
    await render(nextHash);
    await act(async () => finish({ status: "success" }));
    expect(text()).toContain(nextHash);
    expect(text()).toContain("Posted to Ethereum, waiting for inclusion");
    expect(text()).not.toContain("Included on Ethereum");
  });
});
