// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebsiteSettingsContext, WebsiteSettingsStore } from "../../lib/WebsiteSettings.tsx";

const PCASH = 10n ** 18n;
const RECIPIENT = `0x${"12".repeat(20)}`;
const ASSET_ID = 0xabcn;
const state = vi.hoisted(() => ({ wallet: {} as Record<string, any>, receipt: vi.fn(), issuance: undefined as bigint | undefined, namedAddress: { state: "unresolved" } as { state: string; address?: string }, resolveName: vi.fn() }));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet, errorMessage: (cause: unknown) => cause instanceof Error ? cause.message : String(cause) }));
vi.mock("../../lib/usePaymentIssuance.ts", () => ({ usePaymentIssuance: () => ({ issuance: state.issuance, inputs: undefined }) }));
vi.mock("../../lib/EthereumProvider.tsx", () => ({ useEthereumNetwork: () => ({ l1ChainId: 1 }) }));
vi.mock("../../names/useEthereumName.ts", () => ({ useEthereumNameResolver: () => ({ resolveName: state.resolveName }), useEthereumName: () => undefined, useNameAddress: () => state.namedAddress }));
vi.mock("@pcash/sdk/clients", async (original) => ({ ...await original<typeof import("@pcash/sdk/clients")>(), pollReceipt: state.receipt }));
import { TokenBurn, TokenSend } from "./TokenActions.tsx";
import { readTokenActivity, tokenActivityKey } from "../../lib/tokenActivity.ts";

const UNIT = { decimals: 2, symbol: "HBR" };
let element: HTMLDivElement;
let root: Root;
let settings: WebsiteSettingsStore;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  settings = new WebsiteSettingsStore(() => localStorage);
  state.receipt.mockReset().mockResolvedValue(null);
  state.issuance = undefined;
  state.namedAddress = { state: "unresolved" };
  state.resolveName.mockReset();
  state.wallet = {
    phase: "ready", busy: false, status: { pcashChainId: 1n, l1ChainId: 1n, genesisHash: "0xgenesis" }, funds: { spendablePrivate: 0n },
    snapshot: { address: RECIPIENT, assets: [], pendingContentHashes: [] }, node: {},
    selfPublication: { mode: "l1", preflight: vi.fn(), submit: vi.fn() },
    runAction: (action: () => Promise<unknown>) => action(),
    assertFasterGas: async () => undefined,
    synchronize: vi.fn(async () => undefined),
    wallet: {
      sendAsset: vi.fn(), burnAsset: vi.fn(), hasReceiveKey: vi.fn(async () => true),
      snapshot: vi.fn(async () => ({ pendingContentHashes: ["0xpending", "0xsent"] })),
    },
  };
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

const render = (node: React.ReactNode) => act(async () => root.render(<WebsiteSettingsContext.Provider value={settings}><MemoryRouter>{node}</MemoryRouter></WebsiteSettingsContext.Provider>));
const text = () => element.textContent ?? "";
const button = (label: string) => [...element.querySelectorAll("button")].find((node) => node.textContent === label);
const input = (label: string) => [...element.querySelectorAll("label")].find((node) => node.textContent?.startsWith(label))!.querySelector("input")!;
const mode = (label: "Faster" | "More private") => [...element.querySelectorAll<HTMLInputElement>("input[type=radio]")].find((node) => node.parentElement?.textContent === label)!;
async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function fillSend(amount = "12.5") {
  await type(input("Recipient"), RECIPIENT);
  await type(input("Amount"), amount);
}

describe("sending a token", () => {
  it("names the address a recipient name resolves to, and the freshly resolved one once submitted", async () => {
    state.wallet.funds = { spendablePrivate: 2n * PCASH };
    const fresh = `0x${"34".repeat(20)}`;
    state.namedAddress = { state: "resolved", address: RECIPIENT };
    state.resolveName.mockResolvedValue({ name: "alice.eth", address: fresh, system: "ens" });
    state.wallet.wallet.sendAsset.mockReturnValue(new Promise(() => undefined));
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    await type(input("Recipient"), "alice.eth");
    await type(input("Amount"), "1");
    expect(text()).toContain(`Pays ${RECIPIENT}`);
    await act(async () => button("Send")!.click());
    expect(state.wallet.wallet.sendAsset).toHaveBeenCalledWith(expect.objectContaining({ outputs: [{ to: fresh, amount: 100n }] }));
    expect(text()).toContain(`Pays ${fresh}`);
    expect(input("Recipient").value).toBe("alice.eth");
  });

  it("refuses a recipient with no published receive key under the field, before anything is proved", async () => {
    state.wallet.funds = { spendablePrivate: 2n * PCASH };
    state.wallet.wallet.hasReceiveKey.mockResolvedValue(false);
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    await fillSend();
    const message = "This address hasn't set up PCASH, so it can't receive a private payment yet.";
    expect(element.querySelector("fieldset")!.textContent).toContain(message);
    expect(state.wallet.wallet.hasReceiveKey).toHaveBeenCalledWith(RECIPIENT.toLowerCase());
    expect(button("Send")!.disabled).toBe(true);
  });

  it("checks the receive key of the address a name freshly resolves to", async () => {
    state.wallet.funds = { spendablePrivate: 2n * PCASH };
    const fresh = `0x${"34".repeat(20)}`;
    state.namedAddress = { state: "resolved", address: RECIPIENT };
    state.resolveName.mockResolvedValue({ name: "alice.eth", address: fresh, system: "ens" });
    state.wallet.wallet.hasReceiveKey.mockImplementation(async (address: string) => address.toLowerCase() !== fresh);
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    await type(input("Recipient"), "alice.eth");
    await type(input("Amount"), "1");
    await act(async () => button("Send")!.click());
    expect(element.querySelector('[role="alert"]')?.textContent).toBe("This address hasn't set up PCASH, so it can't receive a private payment yet.");
    expect(state.wallet.wallet.sendAsset).not.toHaveBeenCalled();
    expect(element.querySelector("fieldset")!.disabled).toBe(false);
  });

  it("gives the plain reason when PCASH rejects the transfer", async () => {
    state.wallet.funds = { spendablePrivate: 2n * PCASH };
    state.wallet.wallet.sendAsset.mockResolvedValue({ contentHash: "0xsent", accepted: false });
    state.receipt.mockResolvedValue({ outcome: "nullifierAlreadySpent" });
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    await fillSend();
    await act(async () => button("Send")!.click());
    expect(text()).toContain("PCASH did not accept this transfer. This transaction tried to spend a note that had already been spent.");
    expect(text()).not.toContain("nullifierAlreadySpent");
  });

  it("prefills a zero relayer fee for a wallet that cannot pay the default, and sends with it", async () => {
    state.wallet.wallet.sendAsset.mockResolvedValue({ contentHash: "0xsent", accepted: false });
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    expect(input("Relayer fee").value).toBe("0");
    expect(text()).not.toContain("is paid in PCASH");
    await fillSend();
    await act(async () => button("Send")!.click());
    expect(state.wallet.wallet.sendAsset).toHaveBeenCalledWith(expect.objectContaining({
      assetId: ASSET_ID, outputs: [{ to: RECIPIENT, amount: 1_250n }], openFeeAmount: 0n,
    }));
    expect(state.wallet.wallet.sendAsset.mock.calls[0][0].submission).toBeUndefined();
    expect(text()).toContain("In the PCASH mempool, waiting for a relayer");
    expect(readTokenActivity(tokenActivityKey(state.wallet.status, RECIPIENT))).toEqual([
      expect.objectContaining({ kind: "token-sent", contentHash: "0xsent", amount: 1_250n, unit: UNIT, to: RECIPIENT }),
    ]);
  });

  it("follows the issuance estimate until the relayer fee is edited", async () => {
    state.wallet.funds = { spendablePrivate: 10n * PCASH };
    state.issuance = 60n * PCASH;
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    expect(input("Relayer fee").value).toBe("3");
    await type(input("Relayer fee"), "4");
    state.issuance = 100n * PCASH;
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    expect(input("Relayer fee").value).toBe("4");
  });

  it("starts one transfer when Send is clicked again while the recipient is checked", async () => {
    state.wallet.funds = { spendablePrivate: 2n * PCASH };
    let release!: () => void;
    const checked = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    state.wallet.wallet.hasReceiveKey.mockImplementation(() => checked);
    state.wallet.wallet.sendAsset.mockReturnValue(new Promise(() => undefined));
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    await fillSend();
    const send = button("Send")!;
    await act(async () => { send.click(); send.click(); });
    expect(send.disabled).toBe(true);
    expect(element.querySelector("fieldset")!.disabled).toBe(true);
    await act(async () => send.click());
    await act(async () => release());
    expect(state.wallet.wallet.sendAsset).toHaveBeenCalledTimes(1);
  });

  it("keeps the form in place, locked with its values, and shows the result under the button", async () => {
    state.wallet.funds = { spendablePrivate: 2n * PCASH };
    let finish!: (result: { contentHash: string; accepted: boolean }) => void;
    state.wallet.wallet.sendAsset.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    await fillSend();
    await act(async () => button("Send")!.click());
    const form = element.querySelector("form")!;
    expect(form.querySelector("fieldset")!.disabled).toBe(true);
    expect(input("Recipient").value).toBe(RECIPIENT);
    expect(input("Amount").value).toBe("12.5");
    expect(button("Send")!.disabled).toBe(true);
    expect(element.querySelector("dl")).toBeNull();
    // A Slow send asks for no signature, so no prompt to approve one.
    expect(text()).not.toContain("Approve");
    await act(async () => finish({ contentHash: "0xsent", accepted: false }));
    const status = element.querySelector('[data-testid="token-transaction-status"]')!;
    expect(form.contains(status)).toBe(true);
    expect(button("Send")!.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(form.querySelector("fieldset")!.disabled).toBe(true);
    await act(async () => button("Send another")!.click());
    expect(form.querySelector("fieldset")!.disabled).toBe(false);
    expect(input("Recipient").value).toBe(RECIPIENT);
    expect(input("Amount").value).toBe("");
    expect(element.querySelector('[data-testid="token-transaction-status"]')).toBeNull();
  });

  it("re-enables the fields with their values after a failure and tries again with them", async () => {
    state.wallet.funds = { spendablePrivate: 2n * PCASH };
    state.wallet.wallet.sendAsset.mockRejectedValueOnce(new Error("User rejected the request.")).mockResolvedValueOnce({ contentHash: "0xsent", accepted: false });
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    await fillSend();
    await act(async () => button("Send")!.click());
    expect(text()).toContain("User rejected the request.");
    expect(element.querySelector("fieldset")!.disabled).toBe(false);
    expect(input("Recipient").value).toBe(RECIPIENT);
    expect(input("Amount").value).toBe("12.5");
    expect(button("Edit")).toBeUndefined();
    await type(input("Amount"), "2");
    await act(async () => button("Try again")!.click());
    expect(state.wallet.wallet.sendAsset.mock.calls[1][0]).toMatchObject({ outputs: [{ to: RECIPIENT, amount: 200n }] });
    expect(text()).not.toContain("User rejected the request.");
  });

  it("says in plain words when the chosen fee needs PCASH the wallet lacks", async () => {
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    await fillSend();
    await type(input("Relayer fee"), "1");
    const message = "This relayer fee is paid in PCASH: 1 PCASH. Your wallet has 0 PCASH available. Choose Faster to pay Ethereum gas instead, or set the relayer fee to 0.";
    expect(text()).toContain(message);
    state.wallet.funds = { spendablePrivate: 2n * PCASH };
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    expect(text()).not.toContain("is paid in PCASH");
    state.wallet.funds = { spendablePrivate: 0n };
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    await act(async () => button("Send")!.click());
    expect(element.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(state.wallet.wallet.sendAsset).not.toHaveBeenCalled();
  });

  it("publishes Fast through the connected Ethereum wallet with no PCASH fee", async () => {
    state.wallet.wallet.sendAsset.mockResolvedValue({ contentHash: "0xsent", accepted: true });
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    await act(async () => mode("Faster").click());
    await fillSend("1");
    await act(async () => button("Send")!.click());
    const intent = state.wallet.wallet.sendAsset.mock.calls[0][0];
    expect(intent.submission.mode).toBe("l1");
    expect(intent.openFeeAmount).toBeUndefined();
    expect(mode("Faster").checked).toBe(true);
    expect(element.querySelector("fieldset")!.disabled).toBe(true);
  });

  it("refuses more than the spendable balance", async () => {
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={1_000n} />);
    await fillSend("10.01");
    await act(async () => button("Send")!.click());
    expect(text()).toContain("You have 10 HBR available to send.");
    expect(state.wallet.wallet.sendAsset).not.toHaveBeenCalled();
  });

  it("checks an ambiguous submission and resubmits the exact journaled transfer", async () => {
    state.wallet.wallet.sendAsset.mockImplementationOnce(async (intent: { onPrepared(contentHash: string): void }) => {
      intent.onPrepared("0xpending");
      throw new Error("mempool connection reset");
    }).mockResolvedValueOnce({ contentHash: "0xpending", accepted: false });
    state.wallet.funds = { spendablePrivate: 2n * PCASH };
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    await fillSend();
    await act(async () => button("Send")!.click());
    expect(text()).toContain("We couldn’t confirm whether the network received this transfer.");
    await act(async () => button("Check status")!.click());
    expect(state.wallet.synchronize).toHaveBeenCalled();
    expect(text()).toContain("The transfer is still pending. You can submit the same transaction again.");
    await act(async () => button("Submit again")!.click());
    const retry = state.wallet.wallet.sendAsset.mock.calls[1][0];
    expect(retry).toMatchObject({ assetId: ASSET_ID, outputs: [{ to: RECIPIENT, amount: 1_250n }], retryContentHash: "0xpending" });
    expect("openFeeAmount" in retry).toBe(false);
  });

  it("explains a Fast send blocked by an unresolved Ethereum submission and offers the check", async () => {
    const lock = { resolutionId: "c8cb83c6", transactionHash: null };
    state.wallet.selfPublication.l1Recovery = async () => ({ show: async () => ({ latched: true, entries: [lock] }) });
    state.wallet.refreshSubmissionLock = vi.fn(async () => ({ waiting: [lock], released: [] }));
    state.wallet.wallet.sendAsset.mockRejectedValue(Object.assign(new Error("relay journal c8cb83c6 is ambiguous"), { name: "RelayJournalConflictError" }));
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    await act(async () => mode("Faster").click());
    await fillSend("1");
    await act(async () => button("Send")!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(text()).not.toContain("relay journal");
    expect(text()).toContain("Your Ethereum wallet did not confirm whether it sent your last transaction.");
    await act(async () => button("Check Ethereum submission")!.click());
    expect(state.wallet.refreshSubmissionLock).toHaveBeenCalled();
    expect(text()).toContain("Still unresolved on Ethereum.");
  });

  it("reports a transfer that expired unincluded as having changed nothing", async () => {
    state.wallet.wallet.sendAsset.mockResolvedValue({ contentHash: "0xgone", accepted: false });
    state.wallet.funds = { spendablePrivate: 2n * PCASH };
    await render(<TokenSend assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    await fillSend();
    await act(async () => button("Send")!.click());
    expect(text()).toContain("This transfer expired before it was included. Nothing changed.");
    expect(button("Try again")).toBeDefined();
  });
});

describe("burning a token", () => {
  it("requires an explicit irreversible confirmation and pays the default open fee", async () => {
    state.wallet.wallet.burnAsset.mockResolvedValue({ contentHash: "0xburn", accepted: false });
    state.wallet.funds = { spendablePrivate: 2n * PCASH };
    await render(<TokenBurn assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    await type(input("Amount to burn"), "3");
    const burn = button("Burn permanently")!;
    expect(burn.disabled).toBe(true);
    await act(async () => element.querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
    expect(burn.disabled).toBe(false);
    await act(async () => burn.click());
    expect(state.wallet.wallet.burnAsset).toHaveBeenCalledWith(expect.objectContaining({ assetId: ASSET_ID, amount: 300n, openFeeAmount: PCASH }));
  });

  it("locks the form while the burn is out, and Done clears it", async () => {
    state.wallet.funds = { spendablePrivate: 2n * PCASH };
    state.wallet.wallet.burnAsset.mockResolvedValue({ contentHash: "0xburn", accepted: false });
    await render(<TokenBurn assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    await type(input("Amount to burn"), "3");
    const check = element.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    await act(async () => check.click());
    await act(async () => button("Burn permanently")!.click());
    expect(element.querySelector("fieldset")!.disabled).toBe(true);
    expect(input("Amount to burn").value).toBe("3");
    expect(check.checked).toBe(true);
    expect(button("Burn permanently")!.disabled).toBe(true);
    await act(async () => button("Done")!.click());
    expect(element.querySelector("fieldset")!.disabled).toBe(false);
    expect(input("Amount to burn").value).toBe("");
    expect(check.checked).toBe(false);
  });

  it("re-enables the fields with their values after a failure", async () => {
    state.wallet.funds = { spendablePrivate: 2n * PCASH };
    state.wallet.wallet.burnAsset.mockRejectedValue(new Error("User rejected the request."));
    await render(<TokenBurn assetId={ASSET_ID} unit={UNIT} spendable={10_000n} />);
    await type(input("Amount to burn"), "3");
    await act(async () => element.querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
    await act(async () => button("Burn permanently")!.click());
    expect(text()).toContain("User rejected the request.");
    expect(element.querySelector("fieldset")!.disabled).toBe(false);
    expect(input("Amount to burn").value).toBe("3");
    expect(element.querySelector<HTMLInputElement>("input[type=checkbox]")!.checked).toBe(true);
    expect(button("Try again")!.disabled).toBe(false);
  });
});
