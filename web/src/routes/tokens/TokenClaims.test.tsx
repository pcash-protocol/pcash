// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assetDefinitionAssetId } from "@pcash/sdk/protocol";
import { DurablePreBroadcastError } from "@pcash/sdk/wallet";
import { readTokenActivity, tokenActivityKey } from "../../lib/tokenActivity.ts";
import { WebsiteSettingsContext, WebsiteSettingsStore } from "../../lib/WebsiteSettings.tsx";
import { testDefinition } from "./tokenTestSupport.ts";

const PCASH = 10n ** 18n;
const state = vi.hoisted(() => {
  const state = { wallet: {} as Record<string, any>, app: {} as Record<string, any>, modes: [] as string[], openOverview: () => undefined, tokens: {} as Record<string, unknown> };
  // Stable like the real hook's callbacks, so effects that depend on them run once.
  state.tokens = {
    app: async (mode = "slow") => { state.modes.push(mode); return state.app; },
    inspectLink: async (url: string) => state.app.inspectLink(url),
    availableDrops: async () => state.app.availableDrops(),
    dropEligibility: async (drop: unknown) => state.wallet.wallet === undefined && state.wallet.connectedAccount === undefined ? undefined : state.app.dropEligibility(drop),
    progress: undefined, onProgress: () => undefined, clearProgress: () => undefined,
  };
  return state;
});
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet, errorMessage: (cause: unknown) => cause instanceof Error ? cause.message : String(cause) }));
vi.mock("../../lib/usePaymentIssuance.ts", () => ({ usePaymentIssuance: () => ({ issuance: undefined, inputs: undefined }) }));
vi.mock("../wallet/OwnerPanels.tsx", () => ({ useWalletPanel: () => ({ openOverview: state.openOverview }) }));
vi.mock("./useTokensApp.ts", () => ({ useTokensApp: () => ({ ...state.tokens, available: state.wallet.wallet !== undefined }) }));
import { linkAmounts, TokenClaimLinks } from "./TokenClaimLinks.tsx";
import { dropTerms, localDateTime, TokenDrops } from "./TokenDrops.tsx";
import ClaimPage from "./ClaimPage.tsx";
import DropPage from "./DropPage.tsx";
import { TokenFailureNotice, tokenFailure } from "./EthereumSubmission.tsx";
import { TokensActionProgress } from "./TokenTransactionStatus.tsx";

const definition = testDefinition("Harbor Credit", "HBR", 2);
const assetId = assetDefinitionAssetId(definition);
const UNIT = { decimals: 2, symbol: "HBR" };
const CONTRACT = `0x${"ab".repeat(20)}`;
const NOW = 1_900_000_020n;

let element: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.modes = [];
  state.wallet = {
    phase: "ready", busy: false, wallet: {}, connectedAccount: `0x${"12".repeat(20)}`, funds: { spendablePrivate: 0n },
    status: { pcashChainId: 1n, latestBlockTimestamp: NOW }, selfPublication: { mode: "l1" },
    runAction: (action: () => Promise<unknown>) => action(),
    assertFasterGas: async () => undefined,
    readStatus: vi.fn(async () => ({ latestBlock: 42n, latestBlockTimestamp: NOW })),
  };
  state.app = {};
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

async function render(node: ReactNode, path = "/") {
  const settings = new WebsiteSettingsStore(() => localStorage);
  await act(async () => root.render(<WebsiteSettingsContext.Provider value={settings}><MemoryRouter key={path} initialEntries={[path]}>{node}</MemoryRouter></WebsiteSettingsContext.Provider>));
}
const text = () => element.textContent ?? "";
const button = (label: string) => [...element.querySelectorAll("button")].find((node) => node.textContent === label);
const field = (label: string) => [...element.querySelectorAll("label")].find((node) => node.textContent?.startsWith(label))!.querySelector("input, textarea") as HTMLInputElement;
const radio = (label: string) => [...element.querySelectorAll<HTMLInputElement>("input[type=radio]")].find((node) => node.parentElement?.textContent === label)!;
async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe("claim link amounts", () => {
  it("builds equal or listed amounts in base units", () => {
    expect(linkAmounts({ shape: "same", count: "3", amount: "1.5", list: "" }, 2)).toEqual([150n, 150n, 150n]);
    expect(linkAmounts({ shape: "list", count: "", amount: "", list: "10, 2.25\n1" }, 2)).toEqual([1_000n, 225n, 100n]);
    expect(() => linkAmounts({ shape: "same", count: "0", amount: "1", list: "" }, 2)).toThrow(/1 to 100/);
    expect(() => linkAmounts({ shape: "list", count: "", amount: "", list: "1.234" }, 2)).toThrow("Amount 1 can have at most 2 decimal places");
  });
});

describe("creating claim links", () => {
  const set = (claims: ("claimed" | "unclaimed")[]) => ({
    key: "links:1", assetId, definition, contractAddress: CONTRACT, phase: "ready", createdAt: 0,
    links: claims.map((_, index) => ({ index, amount: 500n })),
    claims: claims.map((claim, index) => ({ index, amount: 500n, state: claim })),
  });

  it("creates the set by Fast, then shows each link with the bearer warning", async () => {
    state.app = {
      linkSets: vi.fn(async () => []), linkSetStatus: vi.fn(),
      createLinkSet: vi.fn(async () => set(["unclaimed", "unclaimed"])),
      linkSetUrls: vi.fn(async () => ["https://site/claim#one", "https://site/claim#two"]),
    };
    await render(<TokenClaimLinks assetId={assetId} unit={UNIT} spendable={10_000n} />);
    expect(field("Number of links").value).toBe("1");
    await type(field("Number of links"), "2");
    await type(field("Amount per link"), "5");
    await act(async () => radio("Faster").click());
    expect(text()).toContain("Total held by the links: 10 HBR");
    await act(async () => button("Create claim links")!.click());
    await settle();
    expect(state.modes).toContain("fast");
    expect(state.app.createLinkSet).toHaveBeenCalledWith(expect.objectContaining({ assetId, amounts: [500n, 500n] }));
    expect(state.app.createLinkSet.mock.calls[0][0].openFeeAmount).toBeUndefined();
    expect(state.app.linkSetUrls).toHaveBeenCalledWith("links:1", `${window.location.origin}/claim`);
    expect([...element.querySelectorAll<HTMLInputElement>('input[aria-label^="Claim link"]')].map((input) => input.value)).toEqual(["https://site/claim#one", "https://site/claim#two"]);
    expect(text()).toContain("anyone who opens it can claim them. Send each link privately, only to the person it is for.");
  });

  it("creates another set once the first is ready, and lists both", async () => {
    const sets: ReturnType<typeof set>[] = [];
    state.app = {
      linkSets: vi.fn(async () => sets), linkSetStatus: vi.fn(async (key: string) => sets.find((entry) => entry.key === key)),
      createLinkSet: vi.fn(async () => {
        const created = { ...set(["unclaimed"]), key: `links:${sets.length + 1}` };
        sets.unshift(created);
        return created;
      }),
      linkSetUrls: vi.fn(async (key: string) => [`https://site/claim#${key}`]),
    };
    await render(<TokenClaimLinks assetId={assetId} unit={UNIT} spendable={10_000n} />);
    await type(field("Amount per link"), "5");
    await act(async () => radio("Faster").click());
    await act(async () => button("Create claim links")!.click());
    await settle();
    await act(async () => button("Create claim links")!.click());
    await settle();
    expect(state.app.createLinkSet).toHaveBeenCalledTimes(2);
    expect([...element.querySelectorAll("[data-link-set]")].map((node) => node.getAttribute("data-link-set"))).toEqual(["links:2", "links:1"]);
    expect(element.querySelector<HTMLInputElement>('input[aria-label="Claim link 1"]')!.value).toBe("https://site/claim#links:2");
  });

  it("keeps the default relayer fee for a creator with no PCASH, and refuses a relayed creation", async () => {
    state.app = { linkSets: vi.fn(async () => []), createLinkSet: vi.fn() };
    await render(<TokenClaimLinks assetId={assetId} unit={UNIT} spendable={10_000n} />);
    await type(field("Amount per link"), "5");
    await act(async () => radio("More private").click());
    expect(field("Relayer fee").value).toBe("1");
    await act(async () => button("Create claim links")!.click());
    expect(text()).toContain("This relayer fee is paid in PCASH: 1 PCASH. Your wallet has 0 PCASH available. Choose Faster to pay Ethereum gas instead.");
    expect(text()).not.toContain("set the relayer fee to 0");
    expect(state.app.createLinkSet).not.toHaveBeenCalled();
  });

  it("lists claimed and unclaimed links and claims the rest for the creator in batches", async () => {
    state.wallet.funds = { spendablePrivate: PCASH };
    state.app = {
      linkSets: vi.fn(async () => [set(["claimed", "unclaimed", "unclaimed", "unclaimed", "unclaimed", "unclaimed"])]),
      linkSetStatus: vi.fn(async () => set(["claimed", "unclaimed", "unclaimed", "unclaimed", "unclaimed", "unclaimed"])),
      claimUnclaimedLinks: vi.fn().mockResolvedValueOnce({ remaining: 1 }).mockResolvedValueOnce({ remaining: 0 }),
    };
    await render(<TokenClaimLinks assetId={assetId} unit={UNIT} spendable={10_000n} />);
    await settle();
    expect(text()).toContain("1 of 6 claimed");
    await act(async () => radio("More private").click());
    await type(field("Relayer fee"), "1");
    await act(async () => button("Claim unclaimed yourself (5)")!.click());
    await settle();
    expect(state.app.claimUnclaimedLinks).toHaveBeenCalledTimes(2);
    expect(state.app.claimUnclaimedLinks.mock.calls[0]).toEqual(["links:1", expect.objectContaining({ openFeeAmount: PCASH })]);
  });

  it("says in plain words when the Ethereum wallet never confirmed a send, and continues once the check releases it", async () => {
    const unsent = { resolutionId: "c8cb83c6-0f46-4f9e-9cc4-31529dd89306", transactionHash: null };
    let lock: typeof unsent | null = null;
    state.wallet.selfPublication = { mode: "l1", l1Recovery: async () => ({ show: async () => ({ latched: lock !== null, entries: lock === null ? [] : [lock] }) }) };
    state.wallet.refreshSubmissionLock = vi.fn(async () => { const entry = lock; lock = null; return { waiting: [], released: entry === null ? [] : [entry] }; });
    const creating = { ...set(["unclaimed", "unclaimed"]), phase: "creating-contract", claims: null };
    const blocked = Object.assign(new Error(`relay journal ${unsent.resolutionId} is ambiguous`), { name: "RelayJournalConflictError" });
    state.app = {
      linkSets: vi.fn(async () => []), linkSetStatus: vi.fn(async () => creating),
      createLinkSet: vi.fn(async () => {
        lock = unsent;
        state.app.linkSets = vi.fn(async () => [creating]);
        throw new Error("Wallet did not confirm whether the transaction was sent: [-32603] Internal JSON-RPC error.");
      }),
      resumeLinkSet: vi.fn().mockRejectedValueOnce(blocked).mockResolvedValue(set(["unclaimed", "unclaimed"])),
      linkSetUrls: vi.fn(async () => ["https://site/claim#one", "https://site/claim#two"]),
    };
    await render(<TokenClaimLinks assetId={assetId} unit={UNIT} spendable={10_000n} />);
    await type(field("Amount per link"), "5");
    await act(async () => radio("Faster").click());
    await act(async () => button("Create claim links")!.click());
    await settle();
    expect(text()).toContain("Your Ethereum wallet did not confirm whether it sent your last transaction.");
    expect(text()).not.toContain("-32603");
    expect(element.querySelector('a[href$="#ethereum-submission"]')).not.toBeNull();
    expect(button("Continue creating")).toBeDefined();

    await act(async () => button("Continue creating")!.click());
    await settle();
    expect(text()).not.toContain("relay journal");
    expect(text()).toContain("did not confirm whether it sent your last transaction");

    await act(async () => button("Check Ethereum submission")!.click());
    await settle();
    expect(state.wallet.refreshSubmissionLock).toHaveBeenCalledTimes(1);
    expect(element.querySelector('[data-testid="ethereum-submission-lock"]')).toBeNull();
    await act(async () => button("Continue creating")!.click());
    await settle();
    expect(state.app.resumeLinkSet).toHaveBeenCalledTimes(2);
    expect(element.querySelectorAll('input[aria-label^="Claim link"]')).toHaveLength(2);
  });

  it("keeps a sent transaction that is still landing as the lock, since it blocks the next Fast send too", async () => {
    const sent = { resolutionId: "5b1f9d4e-7c2a-4d8e-9f10-2a3b4c5d6e7f", transactionHash: `0x${"ab".repeat(32)}` };
    state.wallet.selfPublication = { mode: "l1", l1Recovery: async () => ({ show: async () => ({ latched: false, entries: [sent] }) }) };
    state.wallet.refreshSubmissionLock = vi.fn(async () => ({ waiting: [sent], released: [] }));
    const blocked = Object.assign(new Error(`content hash 0x01 is already in flight: relay journal ${sent.resolutionId} is in flight`), { name: "RelayJournalConflictError" });
    await render(<TokenFailureNotice failure={tokenFailure(blocked, true)} />);
    await settle();
    expect(text()).toContain("Your last Ethereum transaction was sent and is still landing.");
    expect(text()).not.toContain("settled now");
    await act(async () => button("Check Ethereum submission")!.click());
    await settle();
    expect(text()).toContain("Still unresolved on Ethereum.");
    expect(element.querySelector('[data-testid="ethereum-submission-lock"]')).not.toBeNull();
  });
});

describe("creating a drop", () => {
  it("reads terms in token units with a block cutoff and a local end time", () => {
    const end = localDateTime(NOW + 3600n);
    expect(dropTerms({ amount: "2.5", count: "4", cutoff: "42", end }, 2, NOW)).toEqual({ claimAmount: 250n, count: 4, cutoffBlockNumber: 42n, claimEndTimestamp: NOW + 3600n });
    expect(() => dropTerms({ amount: "1", count: "4", cutoff: "42", end: localDateTime(NOW - 60n) }, 2, NOW)).toThrow(/after the latest block/);
    expect(() => dropTerms({ amount: "1", count: "0", cutoff: "42", end }, 2, NOW)).toThrow(/Number of claims/);
  });

  it("defaults the cutoff to the latest block, creates the drop, and offers reclaim only after it closes", async () => {
    const drop = (end: bigint) => ({ key: "drop:1", assetId, definition, contractAddress: CONTRACT, claimAmount: 100n, count: 3,
      cutoffBlockNumber: 42n, claimEndTimestamp: end, phase: "ready", createdAt: 0, claimed: 1, remaining: 2 });
    state.app = { drops: vi.fn(async () => [drop(NOW + 60n)]), dropStatus: vi.fn(async () => drop(NOW + 60n)), createDrop: vi.fn(async () => drop(NOW + 60n)) };
    await render(<TokenDrops assetId={assetId} unit={UNIT} spendable={10_000n} />);
    await settle();
    expect(field("Accounts registered by block").value).toBe("42");
    expect(text()).toContain("Only accounts that existed at block 42 can claim");
    expect(text()).toContain("You can reclaim the 2 unclaimed after claims end.");
    await type(field("Amount per claim"), "1");
    await type(field("Number of claims"), "3");
    await act(async () => radio("Faster").click());
    await act(async () => button("Create drop")!.click());
    await settle();
    expect(state.app.createDrop).toHaveBeenCalledWith(expect.objectContaining({ assetId, claimAmount: 100n, count: 3, cutoffBlockNumber: 42n }));
    const recovered = { ...drop(NOW - 1n), phase: "publishing" };
    state.app.drops = vi.fn(async () => [recovered]);
    state.app.dropStatus = vi.fn(async () => recovered);
    state.app.reclaimDrop = vi.fn(async () => ({ remaining: 0 }));
    state.wallet.funds = { spendablePrivate: PCASH };
    await render(<TokenDrops key="closed" assetId={assetId} unit={UNIT} spendable={10_000n} />);
    await settle();
    await act(async () => button("Reclaim unclaimed (2)")!.click());
    await settle();
    expect(state.app.reclaimDrop).toHaveBeenCalledWith("drop:1", expect.objectContaining({ openFeeAmount: PCASH }));
  });
});

describe("claiming a link", () => {
  const inspection = (status: string) => ({ link: {}, assetId, definition, amount: 1_250n, status });

  it("shows the verified token and amount from the fragment and claims by Slow at the zero fee a wallet with no PCASH starts at", async () => {
    state.app = {
      inspectLink: vi.fn().mockResolvedValueOnce(inspection("claimable")).mockResolvedValue(inspection("claimed")),
      claimLink: vi.fn(async () => ({ contentHash: "0x1", accepted: true, queued: false, role: "transfer", assetId, definition, amount: 1_250n, recipient: "0x12" })),
    };
    await render(<Routes><Route path="/claim" element={<ClaimPage />} /></Routes>, "/claim#secret-part");
    await settle();
    expect(state.app.inspectLink).toHaveBeenCalledWith("#secret-part");
    expect(element.querySelector("h1")?.textContent).toBe("Claim 12.5 HBR");
    expect(element.querySelector('[aria-label="Verified definition"]')?.textContent).toContain("Harbor Credit");
    expect(element.querySelector("[data-claim-status]")?.textContent).toBe("Ready to claim");
    await act(async () => radio("More private").click());
    expect(field("Relayer fee").value).toBe("0");
    expect(text()).not.toContain("is paid in PCASH");
    await act(async () => button("Claim")!.click());
    await settle();
    expect(state.app.claimLink).toHaveBeenCalledWith("#secret-part", expect.objectContaining({ openFeeAmount: 0n }));
    expect(text()).toContain("You claimed 12.5 HBR. It is in your wallet.");
    expect(element.querySelector("[data-claim-status]")?.textContent).toBe("Already claimed");
  });

  it("keeps the claim when connecting a wallet borrows and then clears the URL fragment", async () => {
    let navigate: NavigateFunction | undefined;
    function Navigator() { navigate = useNavigate(); return null; }
    state.app = { inspectLink: vi.fn(async () => inspection("claimable")), claimLink: vi.fn(async () => ({ assetId, amount: 1n })) };
    await render(<><Navigator /><Routes><Route path="/claim" element={<ClaimPage />} /></Routes></>, "/claim#secret-part");
    await settle();
    await act(async () => navigate!("/claim#wallet"));
    await act(async () => navigate!("/claim", { replace: true }));
    await settle();
    expect(element.querySelector("[data-claim-status]")?.textContent).toBe("Ready to claim");
    state.wallet.funds = { spendablePrivate: PCASH };
    await act(async () => button("Claim")!.click());
    await settle();
    expect(state.app.claimLink).toHaveBeenCalledWith("#secret-part", expect.anything());
  });

  it("does not show the previous link while another link is being inspected", async () => {
    let navigate: NavigateFunction | undefined;
    function Navigator() { navigate = useNavigate(); return null; }
    let finishSecond: ((value: ReturnType<typeof inspection>) => void) | undefined;
    state.app = { inspectLink: vi.fn((url: string) => url === "#first"
      ? Promise.resolve(inspection("claimable"))
      : new Promise((resolve) => { finishSecond = resolve; })) };
    await render(<><Navigator /><Routes><Route path="/claim" element={<ClaimPage />} /></Routes></>, "/claim#first");
    await settle();
    expect(text()).toContain("Claim 12.5 HBR");
    await act(async () => navigate!("/claim#second"));
    expect(text()).not.toContain("12.5 HBR");
    expect(button("Claim")).toBeUndefined();
    await act(async () => finishSecond!(inspection("claimed")));
    expect(element.querySelector("[data-claim-status]")?.textContent).toBe("Already claimed");
    await act(async () => navigate!("/claim"));
    expect(text()).toContain("Open the full claim link you were sent.");
  });

  it("claims by Fast without an open fee", async () => {
    state.app = { inspectLink: vi.fn(async () => inspection("claimable")), claimLink: vi.fn(async () => ({ assetId, amount: 1n })) };
    await render(<Routes><Route path="/claim" element={<ClaimPage />} /></Routes>, "/claim#secret-part");
    await settle();
    await act(async () => radio("Faster").click());
    await act(async () => button("Claim")!.click());
    await settle();
    expect(state.modes).toContain("fast");
    expect(state.app.claimLink.mock.calls[0][1].openFeeAmount).toBeUndefined();
  });

  it("asks a visitor to connect, and explains a link with no fragment", async () => {
    state.app = { inspectLink: vi.fn(async () => inspection("claimable")) };
    state.wallet = { ...state.wallet, wallet: undefined, connectedAccount: undefined, phase: "disconnected" };
    await render(<Routes><Route path="/claim" element={<ClaimPage />} /></Routes>, "/claim#secret-part");
    await settle();
    expect(text()).toContain("Connect a wallet to claim these tokens.");
    expect(text()).toContain("Claim 12.5 HBR");
    expect(text()).toContain("including the person who made it. Once you claim, the tokens are yours.");
    await render(<Routes><Route path="/claim" element={<ClaimPage key="bare" />} /></Routes>, "/claim");
    expect(text()).toContain("Open the full claim link you were sent.");
  });

  it("signs in on the page when the Ethereum wallet is connected but PCASH is locked, and survives a declined signature", async () => {
    state.app = { inspectLink: vi.fn(async () => inspection("claimable")) };
    const signIn = vi.fn().mockRejectedValueOnce(new Error("User rejected the request.")).mockResolvedValue("ready");
    state.openOverview = vi.fn();
    state.wallet = { ...state.wallet, wallet: undefined, phase: "sign-in-required", signIn };
    await render(<Routes><Route path="/claim" element={<ClaimPage />} /></Routes>, "/claim#secret-part");
    await settle();
    expect(text()).toContain("Sign in to your wallet to claim these tokens.");
    expect(button("Open wallet")).toBeUndefined();
    await act(async () => button("Sign in")!.click());
    await settle();
    await act(async () => button("Sign in")!.click());
    expect(signIn).toHaveBeenCalledTimes(2);
    expect(state.openOverview).not.toHaveBeenCalled();
  });

  it("records a claim for Activity once its bytes are journaled, keeping one whose submission is unclear", async () => {
    const TX = `0x${"c1".repeat(32)}`;
    const REFUSED = `0x${"c2".repeat(32)}`;
    const network = { pcashChainId: 1n, l1ChainId: 11155111n, genesisHash: "0xGENESIS" };
    state.wallet = { ...state.wallet, status: { ...state.wallet.status, ...network }, snapshot: { address: `0x${"12".repeat(20)}`, pendingContentHashes: [] } };
    const entries = () => readTokenActivity(tokenActivityKey(network, `0x${"12".repeat(20)}`));
    const prepared = (after: () => Promise<unknown>, contentHash = TX) => vi.fn(async (_link: string, options: { onPrepared?(contentHash: string, transactionHex: string): Promise<void> | void }) => {
      await options.onPrepared?.(contentHash, "0x00");
      return after();
    });
    try {
      state.app = { inspectLink: vi.fn(async () => inspection("claimable")), claimLink: prepared(async () => { throw new Error("mempool connection reset"); }) };
      await render(<Routes><Route path="/claim" element={<ClaimPage />} /></Routes>, "/claim#secret-part");
      await settle();
      await act(async () => button("Claim")!.click());
      await settle();
      expect(entries()).toEqual([expect.objectContaining({ kind: "token-claimed", contentHash: TX, amount: 1_250n, unit: UNIT, awaitingSubmission: true })]);
      expect(text()).toContain("We couldn’t confirm whether your claim reached the network. It shows as Pending in your activity");
      // A refusal before broadcast leaves no row.
      state.app.claimLink = prepared(async () => { throw new DurablePreBroadcastError(new Error("User rejected the request.")); }, REFUSED);
      await act(async () => button("Claim")!.click());
      await settle();
      expect(entries().map((entry) => entry.contentHash)).toEqual([TX]);
      expect(text()).toContain("User rejected the request.");
      state.app.claimLink = prepared(async () => ({ contentHash: TX, accepted: true, queued: false, role: "transfer", assetId, definition, amount: 1_250n, recipient: "0x12" }));
      await act(async () => button("Claim")!.click());
      await settle();
      expect(entries()).toEqual([expect.objectContaining({ kind: "token-claimed", contentHash: TX })]);
      expect(entries()[0]!.awaitingSubmission).toBeUndefined();
      expect(text()).toContain("You claimed 12.5 HBR.");
    } finally {
      localStorage.clear();
    }
  });

  it("shows a claim proof's stage and fill from the template prover's own update", async () => {
    const proof = { phase: "proving", message: "prove chonk-finalize", elapsedMs: 0, step: "prove", scope: "stack", operation: "finalize", circuitCount: 4 } as const;
    await render(<TokensActionProgress progress={{ phase: "proving", message: proof.message, proof }} />);
    expect(element.querySelector(".proof-progress")?.textContent).toContain("Finishing the proof. This step takes longest.");
    expect(Number(element.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
  });

  it("labels a claim waiting for inclusion as Pending", async () => {
    await render(<TokensActionProgress progress={{ phase: "confirming", message: "Waiting for a relayer to include the transaction…" }} />);
    expect(element.querySelector(".proof-progress")?.textContent).toBe("PendingWaiting for a relayer to include the transaction…");
  });
});

describe("claiming a drop", () => {
  const available = { id: CONTRACT, assetId, definition, count: 2, funding: [], drop: { configuration: { claimAmount: 300n, cutoffBlockNumber: 42n, claimEndTimestamp: NOW + 60n } } };

  it("shows a verified drop before connecting a wallet", async () => {
    state.wallet = { ...state.wallet, wallet: undefined, connectedAccount: undefined, phase: "disconnected" };
    state.app = { availableDrops: vi.fn(async () => [available]) };
    await render(<Routes><Route path="/drop/:contractAddress" element={<DropPage />} /></Routes>, `/drop/${CONTRACT}`);
    await settle();
    expect(text()).toContain("3 HBR");
    expect(text()).toContain("Connect a wallet to claim from this drop.");
    expect(button("Claim")).toBeUndefined();
  });

  it("states eligibility in plain words and claims when eligible", async () => {
    state.app = {
      availableDrops: vi.fn(async () => [available]),
      dropEligibility: vi.fn().mockResolvedValueOnce({ status: "eligible", message: "This account can claim HBR from this drop." })
        .mockResolvedValue({ status: "claimed", message: "This account has already claimed this drop." }),
      claimDrop: vi.fn(async () => ({ assetId, amount: 300n })),
    };
    await render(<Routes><Route path="/drop/:contractAddress" element={<DropPage />} /></Routes>, `/drop/${CONTRACT}`);
    await settle();
    expect(text()).toContain("Accounts that existed at block 42");
    expect(element.querySelector("[data-eligibility]")?.textContent).toBe("You can claim");
    expect(field("Relayer fee").value).toBe("0");
    await act(async () => button("Claim")!.click());
    await settle();
    expect(state.app.claimDrop).toHaveBeenCalledWith(available, expect.objectContaining({ openFeeAmount: 0n, onPrepared: expect.any(Function) }));
    expect(element.querySelector("[data-eligibility]")?.textContent).toBe("Already claimed");
  });

  it("explains an account registered after the cutoff and offers no claim", async () => {
    state.app = { availableDrops: vi.fn(async () => [available]), dropEligibility: vi.fn(async () => ({ status: "ineligible", message: "Only accounts created by block 42 can claim, and this one was created later." })) };
    await render(<Routes><Route path="/drop/:contractAddress" element={<DropPage />} /></Routes>, `/drop/${CONTRACT}`);
    await settle();
    expect(element.querySelector("[data-eligibility]")?.textContent).toBe("Registered after the cutoff");
    expect(text()).toContain("this one was created later.");
    expect(button("Claim")).toBeUndefined();
  });

  it("says when the node lists no drop at the address", async () => {
    state.app = { availableDrops: vi.fn(async () => []) };
    await render(<Routes><Route path="/drop/:contractAddress" element={<DropPage />} /></Routes>, `/drop/${CONTRACT}`);
    await settle();
    expect(text()).toContain("This node does not list a drop at this address.");
  });
});
