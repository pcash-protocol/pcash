// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProveStatus } from "@pcash/sdk/browser-prover/requests";
import type { WalletPaymentActivity, WalletPaymentStage } from "../../lib/WalletProvider.tsx";

const PCASH = 10n ** 18n;
const RECIPIENT = `0x${"12".repeat(20)}`;
const state = vi.hoisted(() => ({
  wallet: {
    phase: "ready", busy: false, paymentStage: { state: "idle" } as WalletPaymentStage, status: { pcashChainId: 1n, genesisHash: "0xgenesis" }, connectedAccount: "0xme",
    synchronize: vi.fn(), preflightPrivateSend: vi.fn(), resolvePendingPaymentFate: vi.fn(), sendPrivate: vi.fn(),
    cancelPrivateSend: vi.fn(), resetPrivateSend: vi.fn(), refreshSubmissionLock: vi.fn(),
    wallet: { hasReceiveKey: vi.fn() },
    selfPublication: undefined as unknown,
    progress: undefined as ProveStatus | undefined,
    actionProgress: undefined as { phase: string; message: string } | undefined,
    walletPromptOpen: false,
  },
  ethereumReceipt: vi.fn(), pcashReceipt: vi.fn(),
  quote: undefined as unknown,
  paymentIssuance: undefined as bigint | undefined,
  refreshIssuance: vi.fn(),
  l1ChainId: 1,
  fastEstimate: undefined as unknown,
  namedAddress: { state: "unresolved" } as { state: string; address?: string },
  resolveName: vi.fn(),
}));
vi.mock("wagmi/actions", () => ({ getPublicClient: () => ({ getTransactionReceipt: state.ethereumReceipt }) }));
vi.mock("@pcash/sdk/clients", async (original) => ({ ...await original<typeof import("@pcash/sdk/clients")>(), pollReceipt: state.pcashReceipt }));
vi.mock("../../lib/WalletProvider.tsx", () => ({
  errorMessage: (error: unknown) => String(error),
  useWallet: () => state.wallet,
}));
vi.mock("../../names/useEthereumName.ts", () => ({ useEthereumNameResolver: () => ({ resolveName: state.resolveName }), useEthereumName: () => undefined, useNameAddress: () => state.namedAddress }));
vi.mock("../../lib/EthereumProvider.tsx", () => ({ useEthereumNetwork: () => ({ l1ChainId: state.l1ChainId }) }));
vi.mock("../../lib/useFastSendEstimate.ts", () => ({ useFastSendEstimate: (enabled: boolean) => enabled ? state.fastEstimate : undefined }));
vi.mock("../../lib/usePaymentIssuance.ts", () => ({ usePaymentIssuance: () => ({
  issuance: state.paymentIssuance, refresh: state.refreshIssuance,
  inputs: state.quote === undefined ? undefined : {
    quote: { status: "fulfilled", value: state.quote }, economics: { status: "fulfilled", value: { records: [] } },
  },
}) }));
import { WebsiteSettingsContext, WebsiteSettingsStore } from "../../lib/WebsiteSettings.tsx";
import { OwnerPanelsProvider, useWalletPanel, SendCard } from "./OwnerPanels.tsx";

const preflight = (openFeeAmount: bigint) => ({
  openFeeAmount, privateRelayFeeAmount: 0n, privateRelayRecipient: null, beneficiary: { kind: "publisher" }, publication: "open", inputCount: 1, inputTotal: 20n * PCASH, retry: false,
});

let element: HTMLDivElement;
let root: Root;
let settings: WebsiteSettingsStore;
let controller: ReturnType<typeof useWalletPanel>;
let navigate: NavigateFunction;
function Probe() { controller = useWalletPanel(); navigate = useNavigate(); return null; }
beforeEach(async () => {
  settings = new WebsiteSettingsStore(() => localStorage);
  settings.setEnsEnabled(false);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(state.wallet)) if (typeof mock === "function") (mock as ReturnType<typeof vi.fn>).mockReset();
  state.wallet.paymentStage = { state: "idle" };
  state.wallet.refreshSubmissionLock.mockResolvedValue({ waiting: [], released: [] });
  state.wallet.wallet.hasReceiveKey.mockReset().mockResolvedValue(true);
  state.wallet.busy = false;
  state.wallet.progress = undefined;
  state.wallet.actionProgress = undefined;
  state.wallet.walletPromptOpen = false;
  state.ethereumReceipt.mockReset().mockResolvedValue(null);
  state.pcashReceipt.mockReset().mockResolvedValue(null);
  state.namedAddress = { state: "unresolved" };
  state.resolveName.mockReset();
  state.wallet.sendPrivate.mockReturnValue(new Promise(() => undefined));
  state.quote = { rewardPossible: true, maxSingleActionReward: 5n * PCASH };
  state.l1ChainId = 1;
  state.fastEstimate = undefined;
  state.paymentIssuance = PCASH / 5n;
  state.refreshIssuance.mockReset().mockImplementation(async () => state.paymentIssuance);
  state.wallet.selfPublication = { mode: "l1" };
  state.wallet.connectedAccount = "0xme";
  delete (state.wallet as Record<string, unknown>).funds;
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
  await render();
});
const render = () => act(async () => { root.render(<WebsiteSettingsContext.Provider value={settings}><MemoryRouter><OwnerPanelsProvider><Probe /><SendCard /></OwnerPanelsProvider></MemoryRouter></WebsiteSettingsContext.Provider>); });
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

const text = () => element.textContent ?? "";
const speedOption = (label: "Faster" | "More private") => [...element.querySelectorAll<HTMLInputElement>("input[type=radio]")].find((node) => node.parentElement?.textContent === label)!;
const help = () => element.querySelector<HTMLButtonElement>('button[aria-label="About Faster and More private"]')!;
const FASTER = "Your Ethereum wallet posts it to Ethereum and pays the gas. Observers can see that your wallet posted a PCASH transaction, but not what it does.";
const MORE_PRIVATE = "It goes to the public PCASH mempool and any relayer posts it for the relayer fee, so it is harder to trace to you.";
const input = (label: string) => [...element.querySelectorAll("label")].find((node) => node.textContent?.startsWith(label === "Fee" ? "Relayer fee (PCASH)" : label))!.querySelector("input")!;
const button = (label: string) => [...element.querySelectorAll("button")].find((node) => node.textContent?.startsWith(label));
const memoField = () => element.querySelector("textarea")!;
const senderBox = () => element.querySelector<HTMLInputElement>("input[type=checkbox]")!;
async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const split = () => element.querySelector('[data-testid="payment-split"]')?.textContent;
const splitPart = (part: "recipient" | "relayer-fee") => element.querySelector(`[data-split="${part}"]`)?.textContent;
/** What the review says the recipient's note carries. */
const forRecipient = () => Object.fromEntries([...element.querySelectorAll('[aria-label="For the recipient"] dt')].map((term) => [term.textContent, term.nextElementSibling?.textContent]));
async function review(fee = "") {
  await type(input("Recipient"), RECIPIENT);
  await type(input("Amount"), "10");
  if (fee !== "") await type(input("Fee"), fee);
  await act(async () => { button("Send")!.click(); });
}

describe("sending with open fees and separate issuance", () => {
  it("prefills the default open fee and says the fee is extra", async () => {
    expect(input("Fee").value).toBe("1");
    expect(text()).toContain("Relayers already earn about <1 PCASH per transaction");
    await type(input("Recipient"), RECIPIENT);
    await type(input("Amount"), "10");
    expect(split()).toBe("Recipient gets 10 PCASH · relayer gets 1 PCASH extra");
  });

  it("orders the fields Recipient, Amount, message, Speed, Relayer fee, and drops the fee for Faster", async () => {
    const fields = () => [...element.querySelectorAll("fieldset input, fieldset textarea")].map((node) => node.closest("label")!.textContent);
    expect(fields()).toEqual(["Recipient", "Amount", "Message (optional)", "Include my address", "Faster", "More private", "Relayer fee (PCASH)"]);
    const speed = element.querySelector("[role=radiogroup]")!;
    expect(document.getElementById(speed.getAttribute("aria-labelledby")!)!.textContent).toBe("Speed");
    await act(async () => { speedOption("Faster").click(); });
    expect(fields()).toEqual(["Recipient", "Amount", "Message (optional)", "Include my address", "Faster", "More private"]);
  });

  it("shows the reviewed amount and fees in the summary while the payment is prepared", async () => {
    const reviewed = { ...preflight(PCASH), privateRelayFeeAmount: 2n * PCASH };
    state.wallet.preflightPrivateSend.mockResolvedValue(reviewed);
    await review();
    expect(state.wallet.preflightPrivateSend).toHaveBeenCalledWith({ to: RECIPIENT, amount: 10n * PCASH, openFeeAmount: PCASH, includeSender: true, newAction: true });
    expect(splitPart("recipient")).toBe("10 PCASH");
    expect(splitPart("relayer-fee")).toBe("3 PCASH");
    expect(forRecipient()).toEqual({ "Your address": "Included" });
    expect(button("Proving")?.disabled).toBe(true);
    expect(state.wallet.sendPrivate).toHaveBeenCalledWith({ to: RECIPIENT, amount: 10n * PCASH, openFeeAmount: PCASH, includeSender: true, newAction: true }, reviewed);
  });

  it("takes whole PCASH only and says so before Send", async () => {
    await type(input("Recipient"), RECIPIENT);
    await type(input("Amount"), "0.5");
    expect(button("Send")!.disabled).toBe(true);
    expect(text()).toContain("Amount must be a whole number");
    await type(input("Amount"), "1");
    await type(input("Fee"), "1.5");
    expect(button("Send")!.disabled).toBe(true);
    expect(text()).toContain("Relayer fee must be a whole number");
    await type(input("Fee"), "2");
    expect(button("Send")!.disabled).toBe(false);
    expect(state.wallet.preflightPrivateSend).not.toHaveBeenCalled();
  });

  it("sends an explicit zero fee as given", async () => {
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(0n));
    await review("0");
    expect(state.wallet.preflightPrivateSend).toHaveBeenCalledWith({ to: RECIPIENT, amount: 10n * PCASH, openFeeAmount: 0n, includeSender: true, newAction: true });
    expect(state.wallet.sendPrivate).toHaveBeenCalledWith({ to: RECIPIENT, amount: 10n * PCASH, openFeeAmount: 0n, includeSender: true, newAction: true }, preflight(0n));
  });

  it("omits the issuance estimate and still prepares the payment while the display read is pending or failed", async () => {
    state.quote = undefined;
    state.paymentIssuance = undefined;
    await render();
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(2n * PCASH));
    await review("2");
    expect(split()).toBe("Recipient gets 10 PCASH · relayer gets 2 PCASH extra");
    expect(state.wallet.sendPrivate).toHaveBeenCalled();
  });

  it("reviews a zero payment with an explicit zero fee", async () => {
    state.wallet.preflightPrivateSend.mockResolvedValue({ ...preflight(0n), inputCount: 0, inputTotal: 0n });
    await type(input("Recipient"), RECIPIENT);
    await type(input("Amount"), "0");
    await type(input("Fee"), "0");
    await act(async () => { button("Send")!.click(); });
    expect(state.wallet.preflightPrivateSend).toHaveBeenCalledWith({ to: RECIPIENT, amount: 0n, openFeeAmount: 0n, newAction: true });
    expect([splitPart("recipient"), splitPart("relayer-fee")]).toEqual(["0 PCASH", "0 PCASH"]);
    expect(state.wallet.sendPrivate).toHaveBeenCalledWith({ to: RECIPIENT, amount: 0n, openFeeAmount: 0n, newAction: true }, { ...preflight(0n), inputCount: 0, inputTotal: 0n });
  });
});


describe("choosing fast or slow", () => {

  it("defaults to slow and relays through the node mempool", async () => {
    expect(speedOption("More private").checked).toBe(true);
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(PCASH));
    await review();
    expect(state.wallet.preflightPrivateSend).toHaveBeenCalledWith({ to: RECIPIENT, amount: 10n * PCASH, openFeeAmount: PCASH, includeSender: true, newAction: true });
  });

  it("publishes a fast payment from the Ethereum wallet with zero PCASH fee", async () => {
    await act(async () => { speedOption("Faster").click(); });
    const reviewed = { ...preflight(0n), beneficiary: { kind: "self" }, publication: "self" };
    state.wallet.preflightPrivateSend.mockResolvedValue(reviewed);
    await review();
    const intent = { to: RECIPIENT, amount: 10n * PCASH, publication: "self", includeSender: true, newAction: true };
    expect(state.wallet.preflightPrivateSend).toHaveBeenCalledWith(intent);
    expect(state.wallet.sendPrivate).toHaveBeenCalledWith(intent, reviewed);
    expect(split()).toBe("Recipient gets 10 PCASH · you pay the Ethereum gas");
    expect(forRecipient()).toEqual({ "Your address": "Included" });
  });

  it("shows a More private payment loaded for review as More private while the draft is Faster", async () => {
    await act(async () => { speedOption("Faster").click(); });
    state.wallet.preflightPrivateSend.mockResolvedValue({ ...preflight(PCASH), retry: true });
    await act(async () => controller.reviewPendingPayment({
      kind: "payment", contentHash: `0x${"ab".repeat(32)}`, deliveryTarget: RECIPIENT, recipientAddress: RECIPIENT, amount: 10n * PCASH, openFeeAmount: PCASH,
      privateRelayFeeAmount: 0n, privateRelayRecipient: null, validUntilTimestamp: 2_000_000_000n, status: "unknown", includeSender: true,
    }));
    expect(split()).toBe("Recipient gets 10 PCASH · relayer gets 1 PCASH extra");
    expect(speedOption("More private").checked).toBe(true);
  });

  it("offers fast only once the Ethereum wallet can publish", async () => {
    state.wallet.selfPublication = undefined;
    await render();
    expect(speedOption("Faster").disabled).toBe(true);
    expect(document.getElementById(speedOption("Faster").getAttribute("aria-describedby")!)!.textContent).toBe(`${FASTER} Available once your Ethereum wallet is ready to post.`);
  });

  it("explains both speeds in a tip that a tap opens and a second tap, Escape, a tap outside, or leaving focus closes", async () => {
    const tip = document.getElementById(help().getAttribute("aria-describedby")!)!;
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(tip.hidden).toBe(true);
    await act(async () => help().click());
    expect(tip.hidden).toBe(false);
    expect(help().getAttribute("aria-expanded")).toBe("true");
    expect(tip.textContent).toBe(`Faster — ${FASTER}More private — ${MORE_PRIVATE}`);
    expect(document.getElementById(speedOption("Faster").getAttribute("aria-describedby")!)!.textContent).toBe(FASTER);
    expect(document.getElementById(speedOption("More private").getAttribute("aria-describedby")!)!.textContent).toBe(MORE_PRIVATE);
    await act(async () => help().click());
    expect(tip.hidden).toBe(true);
    await act(async () => help().click());
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(tip.hidden).toBe(true);
    await act(async () => help().click());
    await act(async () => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(tip.hidden).toBe(true);
    await act(async () => { help().focus(); help().click(); });
    expect(tip.hidden).toBe(false);
    await act(async () => { speedOption("Faster").focus(); });
    expect(tip.hidden).toBe(true);
  });

  it("shows the speed tip while a mouse hovers the ?, not after a tap's emulated hover", async () => {
    const tip = document.getElementById(help().getAttribute("aria-describedby")!)!;
    await act(async () => { help().dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "touch" })); });
    expect(tip.hidden).toBe(true);
    await act(async () => { help().dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })); });
    expect(tip.hidden).toBe(false);
    await act(async () => { help().dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: document.body })); });
    expect(tip.hidden).toBe(true);
    await act(async () => { help().dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })); });
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(tip.hidden).toBe(true);
  });
});

describe("named payment recipients", () => {
  it.each(["alice.eth", "alice.gwei", "alice.wei"])("refreshes %s before preparing a payment", async (name) => {
    const freshAddress = `0x${"34".repeat(20)}`;
    state.namedAddress = { state: "resolved", address: RECIPIENT };
    state.resolveName.mockResolvedValue({ name, address: freshAddress, system: "gns" });
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(PCASH));
    await type(input("Recipient"), name);
    await type(input("Amount"), "10");
    await act(async () => { button("Send")!.click(); });
    expect(state.resolveName).toHaveBeenCalledWith(name);
    expect(state.wallet.preflightPrivateSend).toHaveBeenCalledWith({ to: freshAddress, amount: 10n * PCASH, openFeeAmount: PCASH, includeSender: true, newAction: true });
    expect(state.wallet.sendPrivate).toHaveBeenCalledWith({ to: freshAddress, amount: 10n * PCASH, openFeeAmount: PCASH, includeSender: true, newAction: true }, preflight(PCASH));
    expect(text()).toContain(freshAddress);
  });

  it("blocks a failed fresh lookup and allows review to retry", async () => {
    state.namedAddress = { state: "resolved", address: RECIPIENT };
    state.resolveName.mockRejectedValueOnce(new Error("Resolution unavailable. Retry."));
    await type(input("Recipient"), "alice.wei"); await type(input("Amount"), "10");
    await act(async () => { button("Send")!.click(); });
    expect(state.wallet.preflightPrivateSend).not.toHaveBeenCalled();
    expect(text()).toContain("Resolution unavailable");
    state.resolveName.mockResolvedValue({ name: "alice.wei", address: RECIPIENT, system: "wns" });
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(PCASH / 100n));
    await act(async () => { button("Send")!.click(); });
    expect(state.wallet.sendPrivate).toHaveBeenCalled();
  });

  it("blocks a name that stopped resolving", async () => {
    state.namedAddress = { state: "resolved", address: RECIPIENT };
    state.resolveName.mockResolvedValue(null);
    await type(input("Recipient"), "alice.gwei"); await type(input("Amount"), "10");
    await act(async () => { button("Send")!.click(); });
    expect(state.wallet.preflightPrivateSend).not.toHaveBeenCalled();
    expect(text()).toContain("does not resolve");
  });

  it("ignores a lookup for a draft the user has changed", async () => {
    let resolve!: (value: unknown) => void;
    state.namedAddress = { state: "resolved", address: RECIPIENT };
    state.resolveName.mockReturnValue(new Promise((done) => { resolve = done; }));
    await type(input("Recipient"), "alice.wei"); await type(input("Amount"), "10");
    await act(async () => { button("Send")!.click(); });
    await type(input("Recipient"), "bob.wei");
    await act(async () => resolve({ name: "alice.wei", address: RECIPIENT, system: "wns" }));
    expect(state.wallet.preflightPrivateSend).not.toHaveBeenCalled();
  });
});

describe("sending without a second confirmation", () => {
  const CONTENT_HASH = `0x${"ab".repeat(32)}`;
  const L1_HASH = `0x${"cd".repeat(32)}`;
  const outcome = (publication: "open" | "self") => ({
    contentHash: CONTENT_HASH, publication, ...(publication === "self" ? { l1Hash: L1_HASH } : {}),
    accepted: false, queued: true, settled: false, retried: false, recovered: false,
  });
  const hashLink = () => [...element.querySelectorAll("dd a")][0] as HTMLAnchorElement | undefined;
  const rows = () => Object.fromEntries([...element.querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent]));

  it("starts the payment from Send and offers no confirm step while proving", async () => {
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(PCASH / 100n));
    await review();
    expect(state.wallet.sendPrivate).toHaveBeenCalledTimes(1);
    expect(button("Send payment")).toBeUndefined();
    expect(button("Cancel")).toBeDefined();
  });

  it("links a slow payment's PCASH transaction to the explorer", async () => {
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(PCASH / 100n));
    state.wallet.sendPrivate.mockResolvedValue(outcome("open"));
    await review();
    expect(text()).toContain("Payment sent");
    expect(rows()).toMatchObject({ "Sent to": "PCASH mempool (L2)" });
    expect(hashLink()?.getAttribute("href")).toBe(`/tx/${CONTENT_HASH}`);
  });

  it.each([
    [1, `https://etherscan.io/tx/${L1_HASH}`],
    [11155111, `https://sepolia.etherscan.io/tx/${L1_HASH}`],
  ])("links a fast payment's Ethereum transaction to Etherscan for L1 chain %i", async (chainId, href) => {
    state.l1ChainId = chainId;
    await act(async () => { speedOption("Faster").click(); });
    state.wallet.preflightPrivateSend.mockResolvedValue({ ...preflight(0n), beneficiary: { kind: "self" }, publication: "self" });
    state.wallet.sendPrivate.mockResolvedValue(outcome("self"));
    await review();
    expect(rows()).toMatchObject({ "Sent to": "Ethereum (L1)" });
    expect(hashLink()?.getAttribute("href")).toBe(href);
  });

  it("shows the Ethereum hash without a link on a chain Etherscan does not cover", async () => {
    state.l1ChainId = 31337;
    await act(async () => { speedOption("Faster").click(); });
    state.wallet.preflightPrivateSend.mockResolvedValue({ ...preflight(0n), beneficiary: { kind: "self" }, publication: "self" });
    state.wallet.sendPrivate.mockResolvedValue(outcome("self"));
    await review();
    expect(hashLink()).toBeUndefined();
    expect(element.querySelector("dd code")?.textContent).toBe(L1_HASH);
  });

  it("shows the L1 hash as soon as broadcast succeeds, before the send promise resolves", async () => {
    state.wallet.preflightPrivateSend.mockResolvedValue({ ...preflight(0n), publication: "self" });
    await review();
    state.wallet.busy = true;
    state.wallet.paymentStage = { state: "l1-submitted", attemptId: 1, contentHash: CONTENT_HASH, l1Hash: L1_HASH };
    await render();
    expect(text()).toContain("Posted to Ethereum, waiting for inclusion");
    expect(hashLink()?.getAttribute("href")).toBe(`https://etherscan.io/tx/${L1_HASH}`);
    expect(text()).not.toContain("couldn't confirm");
    expect(button("Send another")?.disabled).toBe(true);
  });

  it("keeps tracking a known hash after the send action's receipt wait fails", async () => {
    state.wallet.preflightPrivateSend.mockResolvedValue({ ...preflight(0n), publication: "self" });
    state.wallet.sendPrivate.mockImplementation(async () => {
      state.wallet.paymentStage = { state: "l1-submitted", attemptId: 1, contentHash: CONTENT_HASH, l1Hash: L1_HASH };
      throw new Error("Receipt wait timed out");
    });
    await review();
    expect(text()).toContain(L1_HASH);
    expect(text()).toContain("Posted to Ethereum, waiting for inclusion");
    expect(text()).not.toContain("Receipt wait timed out");
    expect(text()).not.toContain("couldn't confirm");
    expect(button("Check status")).toBeUndefined();
  });

  it("retains recovery for an ambiguous submission with no L1 hash", async () => {
    state.wallet.preflightPrivateSend.mockResolvedValue({ ...preflight(0n), publication: "self" });
    state.wallet.sendPrivate.mockImplementation(async () => {
      state.wallet.paymentStage = { state: "submission-unknown", attemptId: 1, contentHash: CONTENT_HASH };
      throw new Error("No transaction hash returned");
    });
    await review();
    expect(text()).toContain("couldn't confirm whether the network received this payment");
    expect(button("Check status")).toBeDefined();
  });

  it("returns to an empty form to send another", async () => {
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(PCASH / 100n));
    state.wallet.sendPrivate.mockResolvedValue(outcome("open"));
    await review();
    await act(async () => { button("Send another")!.click(); });
    expect(input("Amount").value).toBe("");
    expect(input("Fee").value).toBe("1");
    expect(button("Send")?.textContent).toBe("Send");
  });
});

describe("amount and readiness hints", () => {
  it("fills the spendable balance minus the fee with Max, floored to whole PCASH", async () => {
    (state.wallet as Record<string, unknown>).funds = { spendablePrivate: 3n * PCASH + 123_456n * 10n ** 10n, total: 3n * PCASH };
    await render();
    expect(text()).toContain("Available 3 PCASH");
    await type(input("Fee"), "1");
    await act(async () => button("Max")!.click());
    expect(input("Amount").value).toBe("2");
    // Less than 1 PCASH after the fee: Max has nothing to fill, and the amount it was following becomes a zero payment.
    await type(input("Recipient"), RECIPIENT);
    await type(input("Fee"), "3");
    expect(button("Max")!.disabled).toBe(true);
    expect(input("Amount").value).toBe("0");
    expect(button("Send")!.disabled).toBe(false);
    await act(async () => { speedOption("Faster").click(); });
    expect(button("Max")!.disabled).toBe(false);
    (state.wallet as Record<string, unknown>).funds = { spendablePrivate: PCASH - 1n, total: PCASH - 1n };
    await render();
    expect(button("Max")!.disabled).toBe(true);
  });

  it("recalculates Max when the fee or speed changes and stops once the amount is typed", async () => {
    (state.wallet as Record<string, unknown>).funds = { spendablePrivate: 3n * PCASH, total: 3n * PCASH };
    await render();
    await act(async () => button("Max")!.click());
    expect(input("Amount").value).toBe("2");
    await type(input("Fee"), "2");
    expect(input("Amount").value).toBe("1");
    await act(async () => { speedOption("Faster").click(); });
    expect(input("Amount").value).toBe("3");
    await type(input("Amount"), "2");
    await act(async () => { speedOption("More private").click(); });
    expect(input("Amount").value).toBe("2");
  });

  it("says why Send is unavailable", async () => {
    expect(button("Send")!.disabled).toBe(true);
    expect(text()).toContain("Enter a recipient to continue.");
    await type(input("Recipient"), RECIPIENT);
    expect(text()).toContain("Enter an amount to continue.");
    await type(input("Amount"), "1");
    expect(button("Send")!.disabled).toBe(false);
  });
});

describe("hiding the wallet during a payment", () => {
  const CONTENT_HASH = `0x${"ab".repeat(32)}`;
  beforeEach(async () => {
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(PCASH / 100n));
    await act(async () => controller.openSend());
    state.wallet.cancelPrivateSend.mockClear();
  });

  it("keeps proving when the panel closes and reopens on the payment", async () => {
    await review();
    await act(async () => controller.closePanel());
    expect(state.wallet.cancelPrivateSend).not.toHaveBeenCalled();
    expect(controller.review).toBeDefined();
    await act(async () => controller.showPanel());
    expect(controller.panelView).toBe("send");
  });

  it("keeps proving across the overview and page navigation", async () => {
    await review();
    await act(async () => controller.openOverview());
    await act(async () => navigate("/blocks"));
    expect(state.wallet.cancelPrivateSend).not.toHaveBeenCalled();
    expect(controller.review).toBeDefined();
    await act(async () => controller.openSend());
    expect(controller.panelView).toBe("send");
    expect(controller.review).toBeDefined();
  });

  it("marks a payment that finishes while hidden until the panel is shown", async () => {
    let finish!: (value: unknown) => void;
    state.wallet.sendPrivate.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await review();
    await act(async () => controller.closePanel());
    await act(async () => finish({ contentHash: CONTENT_HASH, publication: "open", accepted: false, queued: true, settled: false, retried: false, recovered: false }));
    expect(controller.unseenOutcome).toBe(true);
    await act(async () => controller.showPanel());
    expect(controller.unseenOutcome).toBe(false);
    expect(controller.panelView).toBe("send");
    expect(text()).toContain("Payment sent");
  });

  it("reopens on a payment that failed while hidden from the overview, with its error", async () => {
    let fail!: (cause: Error) => void;
    state.wallet.sendPrivate.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    await review();
    await act(async () => controller.openOverview());
    await act(async () => controller.closePanel());
    await act(async () => fail(new Error("proof failed")));
    state.wallet.paymentStage = { state: "failed", attemptId: 1 };
    await render();
    expect(controller.unseenOutcome).toBe(true);
    await act(async () => controller.showPanel());
    expect(controller.panelView).toBe("send");
    expect(text()).toContain("proof failed");
  });

  it("still cancels when the account changes", async () => {
    await review();
    state.wallet.connectedAccount = "0xother";
    await render();
    expect(state.wallet.cancelPrivateSend).toHaveBeenCalled();
  });
});

describe("the Faster send estimate", () => {
  const estimate = (overrides = {}) => ({
    state: "ready", estimatedCostWei: 1_234_500_000_000n, maximumCostWei: 2_000_000_000_000n,
    collectibleOpenFee: 3n * PCASH, expectedIssuance: 2n * PCASH, companions: 2, ownIncluded: 1, ...overrides,
  });
  const faster = async () => {
    await type(input("Amount"), "10");
    await act(async () => { speedOption("Faster").click(); });
  };

  it("puts the Ethereum gas in the summary and says what posting earns", async () => {
    state.fastEstimate = estimate();
    await faster();
    expect(split()).toBe("Recipient gets 10 PCASH · Ethereum gas about 0.0000013 ETH, up to 0.000002 ETH");
    expect(text()).toContain("Posting it earns you about 5 PCASH.");
  });

  it("says nothing about earnings when posting earns nothing", async () => {
    state.fastEstimate = estimate({ collectibleOpenFee: 0n, expectedIssuance: 0n });
    await faster();
    expect(text()).not.toContain("Posting it earns you");
  });

  it.each([
    [{ state: "loading" }, "Ethereum gas: estimating…"],
    [{ state: "error", message: "not enough ETH" }, "Ethereum gas could not be estimated"],
  ])("says when the cost is not known yet (%o)", async (fastEstimate, cost) => {
    state.fastEstimate = fastEstimate;
    await faster();
    expect(split()).toBe(`Recipient gets 10 PCASH · ${cost}`);
  });

  it("does not estimate while More private is selected", async () => {
    state.fastEstimate = estimate();
    await type(input("Amount"), "10");
    expect(split()).toBe("Recipient gets 10 PCASH · relayer gets 1 PCASH extra");
    expect(text()).not.toContain("Ethereum gas");
  });
});



describe("the relayer fee", () => {
  it("submits the fee on screen without re-reading issuance", async () => {
    await type(input("Fee"), "4");
    state.paymentIssuance = PCASH;
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(4n * PCASH));
    await review();
    expect(state.refreshIssuance).not.toHaveBeenCalled();
    expect(state.wallet.preflightPrivateSend).toHaveBeenCalledWith({ to: RECIPIENT, amount: 10n * PCASH, openFeeAmount: 4n * PCASH, includeSender: true, newAction: true });
    expect(state.wallet.sendPrivate).toHaveBeenCalledWith(expect.objectContaining({ openFeeAmount: 4n * PCASH }), preflight(4n * PCASH));
  });

  it("follows the estimate until the user edits it", async () => {
    state.paymentIssuance = 40n * PCASH;
    await render();
    expect(input("Fee").value).toBe("2");
    await type(input("Fee"), "3");
    state.paymentIssuance = 100n * PCASH;
    await render();
    expect(input("Fee").value).toBe("3");
  });

  it("rounds the prefilled fee to whole PCASH", async () => {
    state.paymentIssuance = 123_456_789_000_000_000_000n;
    await render();
    expect(input("Fee").value).toBe("6");
  });

  it.each([undefined, 0n])("prefills 1 PCASH when issuance is %s", async (issuance) => {
    state.paymentIssuance = issuance;
    await render();
    expect(input("Fee").value).toBe("1");
    // An unknown issuance makes no claim about what relayers earn.
    if (issuance === undefined) expect(text()).not.toContain("Relayers");
    else expect(text()).toContain("Relayers earn no issuance right now, so this fee is all they get");
  });

  it("leaves the fee blank until the first issuance read settles", async () => {
    state.quote = undefined;
    state.paymentIssuance = undefined;
    await render();
    expect(input("Fee").value).toBe("");
  });

  it("asks for a fee when the field is cleared", async () => {
    await type(input("Recipient"), RECIPIENT);
    await type(input("Amount"), "10");
    await type(input("Fee"), "");
    expect(button("Send")!.disabled).toBe(true);
    expect(text()).toContain("Enter a relayer fee to continue.");
  });
});

describe("resolving the recipient while typing", () => {
  it("shows the address a name resolves to", async () => {
    const resolved = `0x${"34".repeat(20)}`;
    state.namedAddress = { state: "resolved", address: resolved };
    await type(input("Recipient"), "alice.eth");
    expect(text()).toContain(`Pays ${resolved}`);
  });

  it("disables Send for an address with no receive key and never starts preparation", async () => {
    state.wallet.wallet.hasReceiveKey.mockResolvedValue(false);
    await type(input("Recipient"), RECIPIENT);
    await type(input("Amount"), "10");
    expect(state.wallet.wallet.hasReceiveKey).toHaveBeenCalledWith(RECIPIENT.toLowerCase());
    expect(text()).toContain("This address hasn't set up PCASH, so it can't receive a private payment yet.");
    expect(button("Send")!.disabled).toBe(true);
    expect(state.wallet.preflightPrivateSend).not.toHaveBeenCalled();
  });

  it("checks the receive key of the address a name resolves to", async () => {
    const resolved = `0x${"34".repeat(20)}`;
    state.namedAddress = { state: "resolved", address: resolved };
    state.wallet.wallet.hasReceiveKey.mockResolvedValue(false);
    await type(input("Recipient"), "alice.eth");
    expect(state.wallet.wallet.hasReceiveKey).toHaveBeenCalledWith(resolved);
    expect(text()).toContain("hasn't set up PCASH");
  });

  it("refuses a name whose fresh address has no receive key", async () => {
    const fresh = `0x${"56".repeat(20)}`;
    state.namedAddress = { state: "resolved", address: RECIPIENT };
    state.resolveName.mockResolvedValue({ name: "alice.eth", address: fresh, system: "ens" });
    state.wallet.wallet.hasReceiveKey.mockImplementation(async (address: string) => address.toLowerCase() !== fresh);
    await type(input("Recipient"), "alice.eth");
    await type(input("Amount"), "10");
    await act(async () => { button("Send")!.click(); });
    expect(state.wallet.preflightPrivateSend).not.toHaveBeenCalled();
    expect(text()).toContain("hasn't set up PCASH");
  });
});

describe("keeping the form in place", () => {
  const CONTENT_HASH = `0x${"ab".repeat(32)}`;

  it("keeps the sent values in the locked form with the result beneath it", async () => {
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(PCASH / 100n));
    state.wallet.sendPrivate.mockResolvedValue({ contentHash: CONTENT_HASH, publication: "open", accepted: false, queued: true, settled: false, retried: false, recovered: false });
    await review();
    expect(input("Recipient").value).toBe(RECIPIENT);
    expect(input("Amount").value).toBe("10");
    const form = element.querySelector("form")!;
    expect(form.querySelector("fieldset")!.disabled).toBe(true);
    expect(form.nextElementSibling!.textContent).toContain("The payment is in the PCASH mempool");
    expect(button("Send another")).toBeDefined();
  });

  it("re-enables the form with its values and shows the error under the button", async () => {
    state.wallet.preflightPrivateSend.mockRejectedValue(new Error("Insufficient funds"));
    await review();
    expect(element.querySelector("fieldset")!.disabled).toBe(false);
    expect(input("Recipient").value).toBe(RECIPIENT);
    expect(input("Amount").value).toBe("10");
    const alert = element.querySelector("form")!.lastElementChild!;
    expect(alert.textContent).toContain("Insufficient funds");
    expect(button("Send")!.disabled).toBe(false);
  });

  it("stops Max from following the balance once the payment is submitted", async () => {
    (state.wallet as Record<string, unknown>).funds = { spendablePrivate: 3n * PCASH, total: 3n * PCASH };
    await render();
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(PCASH));
    await type(input("Recipient"), RECIPIENT);
    await act(async () => button("Max")!.click());
    await act(async () => { button("Send")!.click(); });
    expect(input("Amount").value).toBe("2");
    (state.wallet as Record<string, unknown>).funds = { spendablePrivate: 0n, total: 0n };
    await render();
    expect(input("Amount").value).toBe("2");
  });

  it("unlocks a failed preparation with its values and offers Try again", async () => {
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(PCASH / 100n));
    state.wallet.sendPrivate.mockRejectedValue(new Error("You rejected the request in your wallet."));
    await review();
    state.wallet.paymentStage = { state: "failed", attemptId: 1 };
    await render();
    expect(element.querySelector("fieldset")!.disabled).toBe(false);
    expect(input("Recipient").value).toBe(RECIPIENT);
    expect(input("Amount").value).toBe("10");
    expect(text()).toContain("You rejected the request in your wallet.");
    expect(button("Edit")).toBeUndefined();
    expect(state.wallet.preflightPrivateSend).toHaveBeenCalledOnce();
    await act(async () => { button("Try again")!.click(); });
    expect(state.wallet.preflightPrivateSend).toHaveBeenCalledTimes(2);
  });

  it("locks the filled form while the payment is prepared and shows progress beneath it", async () => {
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(PCASH / 100n));
    await review();
    expect(input("Recipient").value).toBe(RECIPIENT);
    expect(input("Amount").value).toBe("10");
    expect(element.querySelector("fieldset")!.disabled).toBe(true);
    expect(button("Cancel")).toBeDefined();
    await act(async () => { button("Cancel")!.click(); });
    expect(element.querySelector("fieldset")!.disabled).toBe(false);
    expect(input("Amount").value).toBe("10");
  });
});

describe("leaving the Send view", () => {
  beforeEach(async () => { await act(async () => controller.openSend()); });

  it("discards a failed preparation and its error", async () => {
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(PCASH / 100n));
    await review();
    state.wallet.paymentStage = { state: "failed", attemptId: 1 };
    state.wallet.sendPrivate.mockRejectedValue(new Error("proof failed"));
    await render();
    await act(async () => controller.openOverview());
    expect(controller.review).toBeUndefined();
    expect(controller.paymentError).toBeUndefined();
  });

  it("clears a send error", async () => {
    state.wallet.preflightPrivateSend.mockRejectedValue(new Error("Insufficient funds"));
    await review();
    expect(controller.paymentError).toContain("Insufficient funds");
    await act(async () => controller.closePanel());
    expect(controller.paymentError).toBeUndefined();
  });
});

describe("after a fast payment", () => {
  const CONTENT_HASH = `0x${"ab".repeat(32)}`;
  const L1_HASH = `0x${"cd".repeat(32)}`;
  beforeEach(async () => {
    await act(async () => { speedOption("Faster").click(); });
    state.wallet.preflightPrivateSend.mockResolvedValue({ ...preflight(0n), beneficiary: { kind: "self" }, publication: "self" });
    state.wallet.sendPrivate.mockResolvedValue({ contentHash: CONTENT_HASH, publication: "self", l1Hash: L1_HASH, accepted: false, queued: true, settled: false, retried: false, recovered: false });
    await review();
  });

  it("refreshes the submission lock once the receipt is seen and stops waiting when PCASH decides", async () => {
    expect(controller.resultL1Hash).toBe(L1_HASH);
    expect(controller.confirmation.finished).toBe(false);
    expect(state.wallet.refreshSubmissionLock).not.toHaveBeenCalled();
    state.ethereumReceipt.mockResolvedValue({ status: "success" });
    state.pcashReceipt.mockResolvedValue({ transactionId: CONTENT_HASH, accepted: true, outcome: "succeeded" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3_100)); });
    expect(controller.confirmation.finished).toBe(true);
    expect(state.wallet.refreshSubmissionLock).toHaveBeenCalled();
  });

  it("unlocks the form with its values and offers Try again when PCASH rejects the payment", async () => {
    expect(element.querySelector("fieldset")!.disabled).toBe(true);
    state.ethereumReceipt.mockResolvedValue({ status: "success" });
    state.pcashReceipt.mockResolvedValue({ transactionId: CONTENT_HASH, accepted: false, outcome: "nullifierAlreadySpent" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3_100)); });
    expect(text()).toContain("PCASH did not accept this payment. This transaction tried to spend a note that had already been spent.");
    expect(element.querySelector("fieldset")!.disabled).toBe(false);
    expect(input("Recipient").value).toBe(RECIPIENT);
    expect(input("Amount").value).toBe("10");
    expect(button("Send another")).toBeUndefined();
    state.wallet.sendPrivate.mockReturnValue(new Promise(() => undefined));
    await act(async () => { button("Try again")!.click(); });
    expect(controller.resultL1Hash).toBeUndefined();
    expect(state.wallet.preflightPrivateSend).toHaveBeenCalledTimes(2);
    expect(input("Amount").value).toBe("10");
  });

  it("keeps the amount until the result is left, then forgets the result on Done", async () => {
    expect(input("Amount").value).toBe("10");
    await act(async () => controller.finishPayment());
    expect(controller.resultL1Hash).toBeUndefined();
    expect(controller.sent).toBeUndefined();
    expect(input("Amount").value).toBe("");
  });
});

describe("confirming in the Ethereum wallet", () => {
  const confirmPrompt = () => [...element.querySelectorAll('[role="status"]')].some((node) => node.textContent === "Confirm in your wallet");

  it("asks for confirmation while a Faster send's wallet prompt is open", async () => {
    await act(async () => { speedOption("Faster").click(); });
    state.wallet.preflightPrivateSend.mockResolvedValue({ ...preflight(0n), beneficiary: { kind: "self" }, publication: "self" });
    await review();
    state.wallet.paymentStage = { state: "submitting", attemptId: 1 };
    await render();
    expect(confirmPrompt()).toBe(false);
    state.wallet.walletPromptOpen = true;
    await render();
    expect(confirmPrompt()).toBe(true);
    state.wallet.walletPromptOpen = false;
    await render();
    expect(confirmPrompt()).toBe(false);
  });

  it("does not ask during a More private send, whatever else waits on a prompt", async () => {
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(PCASH));
    await review();
    state.wallet.paymentStage = { state: "submitting", attemptId: 1 };
    state.wallet.walletPromptOpen = true;
    await render();
    expect(button("Sending")).toBeDefined();
    expect(confirmPrompt()).toBe(false);
  });
});

it("uses the saved default for new sends without replacing a draft's selection", async () => {
  await act(async () => settings.setDefaultSubmissionMode("fast"));
  await act(async () => controller.openSend());
  expect(speedOption("Faster").checked).toBe(true);
  await act(async () => settings.setDefaultSubmissionMode("slow"));
  expect(speedOption("Faster").checked).toBe(true);
  await act(async () => controller.sendAnother());
  expect(speedOption("More private").checked).toBe(true);
  await act(async () => speedOption("Faster").click());
  expect(settings.getSnapshot().defaultSubmissionMode).toBe("slow");
});


it("shows combined proof and transaction details during a private transfer without expanding a toggle", async () => {
  state.wallet.preflightPrivateSend.mockResolvedValue(preflight(PCASH / 100n));
  await review();
  state.wallet.busy = true;
  state.wallet.paymentStage = { state: "proving", attemptId: 1 };
  state.wallet.progress = { phase: "proving", step: "prove", message: "Generating the private payment proof", elapsedMs: 1_000, durationMs: 1_250 };
  state.wallet.actionProgress = { phase: "proving", message: "Preparing your private payment" };
  await render();
  const details = element.querySelector('[aria-label="Transaction details"]')!;
  expect(details.textContent).toContain("Generating the private payment proof");
  expect(details.textContent).toContain("Preparing your private payment");
  expect(details.textContent).toContain("1.3 seconds");
  expect(details.closest("details")).toBeNull();
  expect(element.querySelectorAll('[aria-label="Transaction details"]')).toHaveLength(1);
  expect([...element.querySelectorAll("summary")].some(item => item.textContent === "Proof details")).toBe(false);
});

describe("a message and the payer's address", () => {
  const CONTENT_HASH = `0x${"ab".repeat(32)}`;
  const rows = () => Object.fromEntries([...element.querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent]));
  const counter = () => element.querySelector("#send-memo-hint")!.lastElementChild!.textContent;

  it("includes the address by default and sends the message with it", async () => {
    expect(senderBox().checked).toBe(true);
    expect(counter()).toBe("0 / 2407 bytes");
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(PCASH));
    await type(input("Recipient"), RECIPIENT);
    await type(input("Amount"), "10");
    await type(memoField(), " Lunch 🍜 ");
    expect(counter()).toBe("10 / 2407 bytes");
    await act(async () => { button("Send")!.click(); });
    const intent = { to: RECIPIENT, amount: 10n * PCASH, openFeeAmount: PCASH, memo: "Lunch 🍜", includeSender: true, newAction: true };
    expect(state.wallet.preflightPrivateSend).toHaveBeenCalledWith(intent);
    expect(state.wallet.sendPrivate).toHaveBeenCalledWith(intent, preflight(PCASH));
    expect(rows()).toMatchObject({ Message: "Lunch 🍜", "Your address": "Included" });
  });

  it("leaves the address out when unchecked, which leaves more room for the message", async () => {
    await act(async () => { senderBox().click(); });
    expect(counter()).toBe("0 / 2429 bytes");
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(PCASH));
    await review();
    expect(state.wallet.preflightPrivateSend).toHaveBeenCalledWith({ to: RECIPIENT, amount: 10n * PCASH, openFeeAmount: PCASH, newAction: true });
    expect(rows()).toMatchObject({ "Your address": "Not included" });
    expect(rows()).not.toHaveProperty("Message");
  });

  it("blocks a message over the byte limit", async () => {
    await type(input("Recipient"), RECIPIENT);
    await type(input("Amount"), "10");
    // Two bytes each: 2,420 bytes fits beside no address but not beside one.
    await type(memoField(), "é".repeat(1210));
    expect(counter()).toBe("2420 / 2407 bytes");
    expect(text()).toContain("Shorten the message to 2407 bytes or fewer.");
    expect(button("Send")!.disabled).toBe(true);
    await act(async () => { senderBox().click(); });
    expect(counter()).toBe("2420 / 2429 bytes");
    expect(text()).not.toContain("Shorten the message");
    expect(button("Send")!.disabled).toBe(false);
  });

  it("refuses a message on a zero payment and sends one without the address", async () => {
    state.wallet.preflightPrivateSend.mockResolvedValue({ ...preflight(0n), inputCount: 0, inputTotal: 0n });
    await type(input("Recipient"), RECIPIENT);
    await type(input("Amount"), "0");
    await type(input("Fee"), "0");
    await type(memoField(), "hi");
    expect(button("Send")!.disabled).toBe(true);
    expect(text()).toContain("A zero payment can't carry a message.");
    await type(memoField(), "");
    expect(senderBox().checked).toBe(true);
    await act(async () => { button("Send")!.click(); });
    expect(state.wallet.preflightPrivateSend).toHaveBeenCalledWith({ to: RECIPIENT, amount: 0n, openFeeAmount: 0n, newAction: true });
    // A zero payment has no recipient note, so the review names neither.
    expect([splitPart("recipient"), splitPart("relayer-fee")]).toEqual(["0 PCASH", "0 PCASH"]);
    expect(rows()).toEqual({});
  });

  it("clears the message and restores the address choice to send another", async () => {
    state.wallet.preflightPrivateSend.mockResolvedValue(preflight(PCASH));
    state.wallet.sendPrivate.mockResolvedValue({ contentHash: CONTENT_HASH, publication: "open", accepted: false, queued: true, settled: false, retried: false, recovered: false });
    await type(memoField(), "Rent");
    await act(async () => { senderBox().click(); });
    await review();
    expect(memoField().value).toBe("Rent");
    await act(async () => { button("Send another")!.click(); });
    expect(memoField().value).toBe("");
    expect(senderBox().checked).toBe(true);
  });

  it.each([
    [{ memo: "Rent", includeSender: true }, { memo: "Rent", includeSender: true }, "Included"],
    [{ includeSender: false }, {}, "Not included"],
  ] as const)("retries a saved payment with what it carried (%o)", async (saved, carried, shown) => {
    const payment: WalletPaymentActivity = {
      kind: "payment", contentHash: CONTENT_HASH, deliveryTarget: RECIPIENT, recipientAddress: RECIPIENT, amount: 10n * PCASH, openFeeAmount: PCASH,
      privateRelayFeeAmount: 0n, privateRelayRecipient: null, validUntilTimestamp: 2_000_000_000n, status: "failed", ...saved,
    };
    const reviewed = { ...preflight(PCASH), retry: true };
    state.wallet.preflightPrivateSend.mockResolvedValue(reviewed);
    await act(async () => controller.reviewPendingPayment(payment));
    const intent = { to: RECIPIENT, amount: 10n * PCASH, openFeeAmount: PCASH, ...carried, retryContentHash: CONTENT_HASH };
    expect(state.wallet.preflightPrivateSend).toHaveBeenCalledWith(intent);
    expect(memoField().value).toBe(saved.includeSender ? "Rent" : "");
    expect(senderBox().checked).toBe(saved.includeSender);
    expect(rows()).toMatchObject({ "Your address": shown });
    await act(async () => { button("Send payment")!.click(); });
    expect(state.wallet.sendPrivate).toHaveBeenCalledWith(intent, reviewed);
  });
});
