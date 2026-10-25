// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WalletPaymentActivity } from "../../lib/WalletProvider.tsx";

const PCASH = 10n ** 18n;
const state = vi.hoisted(() => ({
  wallet: {
    phase: "ready", busy: false, paymentStage: { state: "idle" }, status: { pcashChainId: 1n, l1ChainId: 1n, genesisHash: "0xgenesis" }, connectedAccount: "0xme",
    profile: { address: 1n }, snapshot: { address: "0xme", syncedThrough: { pcashHash: "head", pcashNumber: 9n }, pendingContentHashes: [] as string[] }, paymentActivity: [] as WalletPaymentActivity[],
    awaitingConfirmation: new Map<string, string>(), activation: undefined as { miningTransactionHex?: string } | undefined,
    node: { getAccountHistory: vi.fn(async () => ({ items: [] })) },
    wallet: { mine: vi.fn(), preflightMine: vi.fn(), hasReceiveKey: async () => true }, selfPublication: { mode: "l1" }, runAction: (action: () => Promise<unknown>) => action(),
    synchronize: vi.fn().mockResolvedValue(undefined), preflightPrivateSend: vi.fn(), resolvePendingPaymentFate: () => undefined, sendPrivate: vi.fn(),
    cancelPrivateSend: () => undefined, resetPrivateSend: () => undefined,
    submissionLock: undefined as { kind: "batch"; selected: string[]; transactionHash: string | null } | { kind: "call"; transactionHash: string | null } | undefined,
    refreshSubmissionLock: vi.fn(),
    walletPromptOpen: false,
  },
  l1Chain: { blockExplorers: { default: { name: "Etherscan", url: "https://etherscan.io" } } },
  offers: [] as unknown[],
  activity: undefined as unknown,
  observed: {} as Record<string, string>,
  post: { pendingCount: 0, ethereumTransactions: 0, busy: false, post: vi.fn(async () => undefined) } as { pendingCount: number; ethereumTransactions: number; busy: boolean; progress?: { current: number; total: number }; error?: string; post: () => Promise<void> },
}));
vi.mock("../../lib/WalletProvider.tsx", () => ({ errorMessage: String, useWallet: () => state.wallet }));
vi.mock("../../lib/usePaymentIssuance.ts", () => ({ usePaymentIssuance: () => ({ issuance: undefined, inputs: undefined }) }));
vi.mock("../../lib/EthereumProvider.tsx", () => ({ useEthereumNetwork: () => ({ ethereumConfig: {}, l1ChainId: 1, l1Chain: state.l1Chain }) }));
vi.mock("../../lib/MarketplaceStore.ts", () => ({ marketplaceStoreName: () => "offers", openMarketplaceStore: async () => ({ list: async () => state.offers, close: () => undefined }) }));
vi.mock("@pcash/marketplace/app", async (original) => ({
  ...await original<typeof import("@pcash/marketplace/app")>(),
  publicationIdentity: (publication: { terms: { id: string } }) => publication.terms.id,
  publicationContractAddress: () => `0x${"cc".repeat(20)}`,
}));
vi.mock("../../names/useEthereumName.ts", () => ({ useEthereumNameResolver: () => undefined, useEthereumName: () => undefined, useNameAddress: () => ({ state: "unresolved" }) }));
vi.mock("../../lib/useNativeActivity.ts", () => ({ useNativeActivity: () => ({ activity: state.activity, failed: false, checking: false }) }));
vi.mock("../../components/NetworkContext.tsx", () => ({ useNetwork: () => ({ network: { l1ChainId: 1, pcashChainId: 1, genesisHash: "0xgenesis" } }) }));
vi.mock("../../lib/usePendingTransactionState.ts", () => ({ usePendingTransactionState: (contentHash: string | undefined) => ({ data: contentHash === undefined || state.observed[contentHash] === undefined ? undefined : { state: state.observed[contentHash] } }) }));
vi.mock("../../lib/postPending.ts", () => ({ usePostPending: () => state.post }));
import { transactionIdentity } from "@pcash/sdk/browser";
import { fromHex } from "@pcash/sdk/utils";
import { recordTokenActivity, tokenActivityKey } from "../../lib/tokenActivity.ts";
import { WebsiteSettingsContext, WebsiteSettingsStore } from "../../lib/WebsiteSettings.tsx";
import { OwnerPanelsProvider, useWalletPanel } from "./OwnerPanels.tsx";
import { Activity, postingLabel, postPendingLabel } from "./Activity.tsx";

beforeAll(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterAll(() => { vi.unstubAllGlobals(); });
const tree = (children: React.ReactNode) => <QueryClientProvider client={new QueryClient()}><MemoryRouter><OwnerPanelsProvider>{children}</OwnerPanelsProvider></MemoryRouter></QueryClientProvider>;
const html = () => renderToStaticMarkup(tree(<Activity compact />));
const plain = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const payment = (overrides: Partial<WalletPaymentActivity>): WalletPaymentActivity => ({
  kind: "payment", contentHash: `0x${"ab".repeat(32)}`, deliveryTarget: `0x${"12".repeat(20)}`, recipientAddress: `0x${"12".repeat(20)}`, includeSender: false, amount: 100n * PCASH,
  openFeeAmount: 0n, privateRelayFeeAmount: 0n, privateRelayRecipient: null, validUntilTimestamp: 2_000_000_000n, status: "finalized", ...overrides,
});
function withState(patch: { activity?: unknown; payments?: WalletPaymentActivity[]; observed?: Record<string, string> }, run: () => void) {
  const previous = { activity: state.activity, payments: state.wallet.paymentActivity, observed: state.observed };
  if ("activity" in patch) state.activity = patch.activity;
  if (patch.payments !== undefined) state.wallet.paymentActivity = patch.payments;
  if (patch.observed !== undefined) state.observed = patch.observed;
  try { run(); } finally { state.activity = previous.activity; state.wallet.paymentActivity = previous.payments; state.observed = previous.observed; }
}

/** Mounts the compact feed; `rerender` renders it again after a state change and lets its reads settle. */
async function withMounted(run: (element: HTMLDivElement, rerender: () => Promise<void>) => Promise<void>) {
  const client = new QueryClient();
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const rerender = async () => {
    await act(async () => { root.render(<QueryClientProvider client={client}><MemoryRouter><OwnerPanelsProvider><Activity compact /></OwnerPanelsProvider></MemoryRouter></QueryClientProvider>); });
    for (let tick = 0; tick < 3; tick++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  try {
    await rerender();
    await run(element, rerender);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
}

describe("activity feed", () => {
  it("gives every row an icon, a title and a relative time with the exact time on hover, and no badge once complete", () => {
    withState({ activity: { state: "ready", pcashHash: "head", pcashNumber: 9n, entries: [
      { transactionId: null, direction: "received", amount: 7n * PCASH, blockNumber: 9n, blockHash: "0xposted", timestamp: 100n, commitments: [], payout: { openFeeAmount: 2n * PCASH, issuanceAmount: 5n * PCASH } },
      { transactionId: `0x${"cd".repeat(32)}`, direction: "received", amount: 2n * PCASH, blockNumber: 8n, blockHash: "0xpaid", timestamp: 90n, commitments: [], payout: null },
    ] } }, () => {
      const markup = html();
      expect(markup.match(/data-activity-kind="(\w+)"/g)).toEqual(['data-activity-kind="mined"', 'data-activity-kind="received"']);
      expect(plain(markup)).toContain("Mined 7 PCASH");
      expect(plain(markup)).toContain("Received 2 PCASH");
      expect(markup).toMatch(/<time dateTime="1970-01-01T00:01:40.000Z" title="[^"]+">\S+ ago<\/time>/);
      expect(markup).not.toMatch(/Block 9|Accepted|Finalized|Checking/);
      expect(markup).toContain('d="m14 13-8.381 8.38a1 1 0 0 1-3.001-3L11 9.999"');
      expect(markup).toContain('d="M17 17H7V7"');
    });
  });

  it("dates a fresh browser's recovered history by block and shows account setup as the oldest row", async () => {
    // Setup mining lands in the setup's block; a payment arrives four blocks later. No local records exist.
    const setupTime = 1_750_000_012n;
    const setup = { kind: "userAccountCreation", outcome: "succeeded", transactionId: `0x${"0a".repeat(32)}`, timestamp: setupTime };
    const previous = { node: state.wallet.node, activity: state.activity };
    state.wallet.node = { ...previous.node, getAccountHistory: vi.fn(async () => ({ items: [setup] })) } as typeof previous.node;
    state.activity = { state: "ready", pcashHash: "head", pcashNumber: 9n, entries: [
      { transactionId: `0x${"cd".repeat(32)}`, direction: "received", amount: 2n * PCASH, blockNumber: 5n, blockHash: "0x05", timestamp: setupTime + 48n, commitments: [], payout: null },
      { transactionId: `0x${"0b".repeat(32)}`, direction: "received", amount: 5n * PCASH, blockNumber: 1n, blockHash: "0x01", timestamp: setupTime, commitments: [], payout: { openFeeAmount: 0n, issuanceAmount: 5n * PCASH } },
    ] };
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    try {
      await act(async () => { root.render(tree(<Activity />)); });
      // The account history read resolves, then the query cache notifies on a later task.
      for (let tick = 0; tick < 5; tick++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const rows = [...element.querySelectorAll("[data-activity-kind]")];
      expect(rows.map((row) => row.getAttribute("data-activity-kind"))).toEqual(["received", "mined", "setup"]);
      expect(rows.map((row) => row.querySelector("time")?.getAttribute("dateTime"))).toEqual([
        new Date(Number(setupTime + 48n) * 1_000).toISOString(),
        new Date(Number(setupTime) * 1_000).toISOString(),
        new Date(Number(setupTime) * 1_000).toISOString(),
      ]);
      expect(rows.every((row) => / ago$/.test(row.querySelector("time")?.textContent ?? ""))).toBe(true);
    } finally {
      await act(async () => root.unmount());
      element.remove();
      state.wallet.node = previous.node;
      state.activity = previous.activity;
    }
  });

  it("names the recipient of a sent payment", () => {
    withState({ activity: { state: "ready", pcashHash: "head", pcashNumber: 9n, entries: [] }, payments: [payment({ privateRelayFeeAmount: 8n * PCASH / 10n, privateRelayRecipient: `0x${"34".repeat(20)}` })] }, () => {
      const text = plain(html());
      expect(text).toContain("Sent 100 PCASH to 0x121212…121212");
      expect(text).not.toContain("Pending");
    });
  });

  it("shows a memo and a claimed sender on a line under the row's title", () => {
    withState({ activity: { state: "ready", pcashHash: "head", pcashNumber: 9n, entries: [
      { transactionId: `0x${"cd".repeat(32)}`, direction: "received", amount: 2n * PCASH, blockNumber: 8n, blockHash: "0xpaid", timestamp: 90n, commitments: [], payout: null,
        messages: [{ memo: new TextEncoder().encode("Thanks"), sender: BigInt(`0x${"56".repeat(20)}`) }] },
    ] }, payments: [payment({ memo: "Lunch", includeSender: true })] }, () => {
      const markup = html();
      expect(markup).toMatch(/<\/span><small[^>]*><span>“Lunch”<\/span><\/small>/);
      expect(plain(markup)).toContain("“Thanks” from 0x565656…565656 (unverified)");
    });
  });

  it("says where a pending transaction is on its way to Ethereum", () => {
    const posted = `0x${"01".repeat(32)}`;
    const waiting = `0x${"02".repeat(32)}`;
    withState({ activity: undefined, payments: [payment({ contentHash: posted, status: "pending" }), payment({ contentHash: waiting, status: "pending" })], observed: { [posted]: "ethereum", [waiting]: "mempool" } }, () => {
      state.wallet.snapshot.pendingContentHashes = [posted, waiting];
      const markup = html();
      state.wallet.snapshot.pendingContentHashes = [];
      const row = (contentHash: string) => plain(markup.split(`data-payment-id="${contentHash}"`)[1]!.split("data-activity-kind")[0]!);
      expect(row(posted)).toContain("Posted, waiting for inclusion");
      expect(row(posted)).toContain("Pending");
      expect(row(waiting)).toContain("Not posted yet");
      expect(markup.match(/data-activity-state="pending"/g)).toHaveLength(2);
    });
  });

  it.each([
    ["pending", "Mining", "Pending"],
    ["unknown", "Mining", "Pending"],
    ["failed", "Mining", "Failed"],
    ["conflicted", "Mining", "Failed"],
    ["expired", "Mining", "Expired"],
  ] as const)("labels %s mining without a zero payment", (status, title, badge) => {
    withState({ activity: undefined, payments: [payment({ kind: "mine", amount: 0n, status })], observed: { [payment({}).contentHash]: "mempool" } }, () => {
      const text = plain(html());
      expect(text).toContain(title);
      expect(text).toContain(badge);
      expect(text).not.toContain("Sent ");
    });
  });

  it("hides only the action waiting on its wallet prompt, and setup mining until its transaction goes out", () => {
    const inFlight = `0x${"03".repeat(32)}`;
    const dropped = `0x${"04".repeat(32)}`;
    const posted = `0x${"05".repeat(32)}`;
    const setup = transactionIdentity(fromHex("0x0abc")).contentHash.toLowerCase();
    const unclear = `0x${"06".repeat(32)}`;
    state.wallet.awaitingConfirmation = new Map([[inFlight, "1"]]);
    state.wallet.activation = { miningTransactionHex: "0x0abc" };
    try {
      withState({ activity: undefined, payments: [
        payment({ kind: "mine", contentHash: inFlight, status: "unknown" }), payment({ kind: "mine", contentHash: dropped, status: "unknown" }),
        payment({ kind: "mine", contentHash: posted, status: "pending", l1TxHash: `0x${"0e".repeat(32)}` }), payment({ kind: "mine", contentHash: setup, status: "unknown" }),
        payment({ contentHash: unclear, status: "unknown" }),
      ], observed: { [dropped]: "absent", [posted]: "ethereum", [unclear]: "ambiguous" } }, () => {
        const markup = html();
        expect(markup).not.toContain(inFlight);
        expect(markup).not.toContain(setup);
        const row = (contentHash: string) => plain(markup.split(`data-payment-id="${contentHash}"`)[1]!.split("data-payment-id")[0]!);
        // A dropped transaction is not posted, and posting cannot help: its recovery is the action.
        expect(row(dropped)).toContain("Pending");
        expect(row(dropped)).toContain("Retry mining");
        expect(row(dropped)).not.toContain("Not posted yet");
        expect(row(unclear)).toContain("Check status");
        expect(row(posted)).toContain("Posted, waiting for inclusion");
      });
      // The prompt returned a hash: the action is shown while it is still running.
      withState({ activity: undefined, payments: [payment({ kind: "mine", contentHash: inFlight, status: "pending", l1TxHash: `0x${"0e".repeat(32)}` }),
        payment({ kind: "mine", contentHash: setup, status: "pending", l1TxHash: `0x${"0f".repeat(32)}` })] }, () => {
        const markup = html();
        expect(markup).toContain(inFlight);
        expect(markup).toContain(setup);
      });
    } finally {
      state.wallet.awaitingConfirmation = new Map();
      state.wallet.activation = undefined;
    }
  });

  it("hides a token action only while it waits on its wallet prompt", async () => {
    const contentHash = `0x${"07".repeat(32)}`;
    recordTokenActivity(tokenActivityKey(state.wallet.status, state.wallet.snapshot.address),
      { kind: "token-burned", contentHash, amount: 5n, unit: { symbol: "HBR", decimals: 0 }, at: 1_000, awaitingSubmission: true });
    state.wallet.awaitingConfirmation = new Map([[contentHash, "2"]]);
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    try {
      await act(async () => { root.render(tree(<Activity />)); });
      expect(element.textContent).not.toContain("Burned 5 HBR");
      // After an unclear failure the action is no longer running, and the row shows.
      state.wallet.awaitingConfirmation = new Map();
      await act(async () => { root.render(tree(<Activity />)); });
      expect(element.textContent).toContain("Burned 5 HBR");
    } finally {
      await act(async () => root.unmount());
      element.remove();
      state.wallet.awaitingConfirmation = new Map();
      localStorage.clear();
    }
  });

  it("shows no Received and Spent totals", () => {
    withState({ activity: { state: "ready", pcashHash: "head", pcashNumber: 9n, entries: [] } }, () => {
      const markup = html();
      expect(markup).not.toContain("Account totals");
      expect(plain(markup)).not.toMatch(/Received|Spent/);
    });
  });

  it("keeps payment rows waiting on their wallet prompt hidden whatever the contentHash's case", () => {
    const contentHash = `0x${"AB".repeat(32)}`;
    state.wallet.awaitingConfirmation = new Map([[contentHash.toLowerCase(), "1"]]);
    try {
      withState({ activity: undefined, payments: [payment({ contentHash, status: "unknown" })] }, () => {
        expect(html()).not.toContain("data-payment-id");
      });
    } finally {
      state.wallet.awaitingConfirmation = new Map();
    }
  });

  it("hides a marketplace step of unknown submission while its prompt is open and the node cannot place it", async () => {
    const contentHash = `0x${"Ec".repeat(32)}`;
    const publication = { reclaimAuthority: `0x${"0".repeat(39)}1`, terms: { id: "4", assetId: "0", amount: (100n * PCASH).toString(), ethPriceWei: (10n ** 16n).toString(), deadlineT: "2000000000", seller: "1", router: "2" }, escrow: {} };
    state.offers = [{ key: "reclaiming", pub: publication, source: "created", savedAt: 500, reclaim: { phase: "prepared", publication, contentHash, updatedAt: 5_000 } }];
    state.wallet.awaitingConfirmation = new Map([[contentHash.toLowerCase(), "3"]]);
    try {
      await withMounted(async (element, rerender) => {
        const reclaimed = () => element.querySelector('[data-activity-kind="reclaimed"]');
        state.observed = { [contentHash]: "ambiguous" };
        await rerender();
        expect(reclaimed()).toBeNull();
        state.wallet.awaitingConfirmation = new Map();
        await rerender();
        expect(reclaimed()?.textContent).toContain("Pending");
      });
    } finally {
      state.offers = [];
      state.observed = {};
      state.wallet.awaitingConfirmation = new Map();
    }
  });

  it("gives a row its blocking Ethereum submission's link and Check status in place of its own recovery", async () => {
    const contentHash = `0x${"0c".repeat(32)}`;
    const hash = `0x${"0d".repeat(32)}`;
    const lock = { kind: "batch" as const, selected: [contentHash], transactionHash: hash };
    state.wallet.paymentActivity = [payment({ kind: "mine", contentHash, amount: 0n, status: "unknown" })];
    state.wallet.submissionLock = lock;
    state.wallet.refreshSubmissionLock.mockReset().mockResolvedValue({ waiting: [lock], released: [] });
    state.wallet.wallet.preflightMine.mockClear();
    try {
      await withMounted(async (element) => {
        const row = element.querySelector(`[data-payment-id="${contentHash}"]`)!;
        expect(row.querySelector("a[target=_blank]")?.getAttribute("href")).toBe(`https://etherscan.io/tx/${hash}`);
        expect([...row.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Check status"]);
        await act(async () => row.querySelector("button")!.click());
        expect(state.wallet.refreshSubmissionLock).toHaveBeenCalledOnce();
        expect(state.wallet.wallet.preflightMine).not.toHaveBeenCalled();
        expect([...element.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toContain("Still pending on Ethereum.");
      });
    } finally {
      state.wallet.paymentActivity = [];
      state.wallet.submissionLock = undefined;
    }
  });

  it("gives a submission no row carries a Pending row of its own once its prompt has closed", async () => {
    const hash = `0x${"0e".repeat(32)}`;
    const lock = { kind: "call" as const, transactionHash: hash };
    state.wallet.submissionLock = lock;
    state.wallet.refreshSubmissionLock.mockReset().mockResolvedValue({ waiting: [], released: [lock] });
    try {
      state.wallet.walletPromptOpen = true;
      await withMounted(async (element) => {
        expect(element.querySelector('[data-activity-kind="submission"]')).toBeNull();
      });
      state.wallet.walletPromptOpen = false;
      await withMounted(async (element) => {
        const row = element.querySelector('[data-activity-kind="submission"]')!;
        expect(row.textContent).toContain("Ethereum submission");
        expect(row.textContent).toContain("Pending");
        expect(row.querySelector("a[target=_blank]")?.getAttribute("href")).toBe(`https://etherscan.io/tx/${hash}`);
        await act(async () => row.querySelector("button")!.click());
        expect(state.wallet.refreshSubmissionLock).toHaveBeenCalledOnce();
        expect([...element.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toContain("Cleared. You can submit again.");
      });
    } finally {
      state.wallet.submissionLock = undefined;
      state.wallet.walletPromptOpen = false;
    }
  });

  it("reads a receipt again on each new head until an accepted inclusion is final", async () => {
    const contentHash = `0x${"08".repeat(32)}`;
    const key = tokenActivityKey(state.wallet.status, state.wallet.snapshot.address);
    recordTokenActivity(key, { kind: "token-created", contentHash, amount: 5n, unit: { symbol: "HBR", decimals: 0 }, at: 1_000 });
    const accepted = { inclusion: { l1BlockNumber: 100n }, contentHash, transactionId: `0x${"09".repeat(32)}`, outcome: "succeeded" };
    // Each read of this transaction's receipts takes the next answer; other rows' reads find none.
    const answers: (Error | object[])[] = [];
    const getReceipt = vi.fn(async ({ contentHash: requestedHash }: { contentHash: string }) => {
      if (requestedHash !== contentHash) return [];
      const answer = answers.shift();
      if (answer === undefined || answer instanceof Error) throw answer ?? new Error("unexpected read");
      return answer;
    });
    const wallet = state.wallet as typeof state.wallet & { followedStatus?: { status: { finalizedL1BlockNumber: bigint } } };
    const previous = { node: state.wallet.node, synced: state.wallet.snapshot.syncedThrough };
    state.wallet.node = { ...previous.node, getReceipt } as typeof previous.node;
    const client = new QueryClient();
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    const shown = async (head: string, finalized: bigint) => {
      state.wallet.snapshot.syncedThrough = { pcashHash: head, pcashNumber: 9n };
      wallet.followedStatus = { status: { finalizedL1BlockNumber: finalized } };
      await act(async () => { root.render(<QueryClientProvider client={client}><MemoryRouter><OwnerPanelsProvider><Activity /></OwnerPanelsProvider></MemoryRouter></QueryClientProvider>); });
      // The read resolves, then the query cache notifies on a later task.
      for (let tick = 0; tick < 5; tick++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      return element.querySelector('[data-activity-kind="token-created"]')!.getAttribute("data-activity-state");
    };
    try {
      // A read that failed is retried on the next head.
      answers.push(new Error("node unavailable"));
      expect(await shown("h1", 90n)).toBe("pending");
      answers.push([accepted]);
      expect(await shown("h2", 90n)).toBe("complete");
      // The block that included it is reorged away: the row is no longer complete.
      answers.push([]);
      expect(await shown("h3", 90n)).toBe("pending");
      answers.push([accepted]);
      expect(await shown("h4", 100n)).toBe("complete");
      // Accepted in a finalized block: later heads do not read it again.
      expect(await shown("h5", 101n)).toBe("complete");
      expect(getReceipt.mock.calls.filter(([query]) => query.contentHash === contentHash)).toHaveLength(4);
    } finally {
      await act(async () => root.unmount());
      element.remove();
      state.wallet.node = previous.node;
      state.wallet.snapshot.syncedThrough = previous.synced;
      delete wallet.followedStatus;
      localStorage.clear();
    }
  });

  it("counts the Ethereum transactions while posting", () => {
    expect(postingLabel(undefined)).toBe("Posting…");
    expect(postingLabel({ current: 1, total: 1 })).toBe("Posting…");
    expect(postingLabel({ current: 1, total: 2 })).toBe("Posting 1 of 2…");
    state.post = { ...state.post, pendingCount: 5, ethereumTransactions: 2, busy: true, progress: { current: 2, total: 2 } };
    try {
      expect(plain(html())).toContain("Posting 2 of 2…");
    } finally {
      state.post = { pendingCount: 0, ethereumTransactions: 0, busy: false, post: vi.fn(async () => undefined) };
    }
  });

  it("keeps posting in view while posted entries leave the count, then shows why it stopped", () => {
    try {
      state.post = { ...state.post, pendingCount: 0, ethereumTransactions: 0, busy: true };
      expect(plain(html())).toContain("Posting…");
      state.post = { ...state.post, busy: false, error: "User rejected the request." };
      const text = plain(html());
      expect(text).toContain("User rejected the request.");
      expect(text).not.toContain("Post 0 pending");
    } finally {
      state.post = { pendingCount: 0, ethereumTransactions: 0, busy: false, post: vi.fn(async () => undefined) };
    }
  });

  it.each([
    [0, 0, undefined],
    [1, 1, "Post 1 pending"],
    [5, 2, "Post 5 pending (2 Ethereum transactions)"],
  ])("offers to post %i pending transactions", async (pendingCount, ethereumTransactions, label) => {
    expect(postPendingLabel({ pendingCount: 5, ethereumTransactions: 2 })).toBe("Post 5 pending (2 Ethereum transactions)");
    state.post = { ...state.post, pendingCount, ethereumTransactions, post: vi.fn(async () => undefined) };
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    try {
      await act(async () => { root.render(tree(<Activity />)); });
      const button = [...element.querySelectorAll("button")].find((node) => node.textContent?.startsWith("Post "));
      expect(button?.textContent).toBe(label);
      if (button !== undefined) {
        await act(async () => button.click());
        expect(state.post.post).toHaveBeenCalledOnce();
      }
    } finally {
      await act(async () => root.unmount());
      element.remove();
      state.post = { ...state.post, pendingCount: 0, ethereumTransactions: 0 };
    }
  });
});

function PanelView() {
  const { panelView, message } = useWalletPanel();
  return <><output data-panel-view>{panelView}</output><output data-panel-message>{message}</output></>;
}

describe("expired transactions", () => {
  const expired = payment({ contentHash: `0x${"0e".repeat(32)}`, status: "expired", openFeeAmount: 3n * PCASH, memo: "Lunch", includeSender: true });
  const preflight = { retry: false, publication: "relay", openFeeAmount: 3n * PCASH, privateRelayFeeAmount: 0n };
  const button = (element: HTMLElement, label: string) => [...element.querySelectorAll("button")].find((node) => node.textContent === label);

  it("says what Expired means on every expired row and offers to resend only a payment", async () => {
    const token = `0x${"0d".repeat(32)}`;
    recordTokenActivity(tokenActivityKey(state.wallet.status, state.wallet.snapshot.address), { kind: "token-burned", contentHash: token, amount: 5n, unit: { symbol: "HBR", decimals: 0 }, at: 1_000 });
    state.wallet.paymentActivity = [expired, payment({ kind: "mine", contentHash: `0x${"0f".repeat(32)}`, amount: 0n, status: "expired" })];
    state.activity = undefined;
    // Neither the wallet nor the node holds the token action any longer.
    state.observed = { [token]: "absent" };
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    try {
      await act(async () => { root.render(tree(<Activity />)); });
      const rows = [...element.querySelectorAll<HTMLElement>('[data-activity-state="expired"]')];
      expect(rows.map((row) => row.dataset.activityKind).sort()).toEqual(["mined", "sent", "token-burned"]);
      for (const row of rows) {
        const chip = row.querySelector<HTMLElement>("[aria-describedby]")!;
        expect(chip.textContent).toBe("Expired");
        // Reachable by keyboard, which shows the tip on focus.
        expect(chip.tabIndex).toBe(0);
        expect(document.getElementById(chip.getAttribute("aria-describedby")!)?.textContent).toBe("Transaction never confirmed");
        expect(row.querySelector("button")?.textContent).toBe(row.dataset.activityKind === "sent" ? "Resend" : undefined);
      }
    } finally {
      await act(async () => root.unmount());
      element.remove();
      state.wallet.paymentActivity = [];
      state.observed = {};
      localStorage.clear();
    }
  });

  it.each([
    ["slow", { openFeeAmount: 3n * PCASH }],
    ["fast", { publication: "self" }],
  ] as const)("resends an expired payment in one click as a new payment at the default speed (%s)", async (mode, transport) => {
    const settings = new WebsiteSettingsStore(() => localStorage);
    settings.setDefaultSubmissionMode(mode);
    state.wallet.preflightPrivateSend.mockReset().mockResolvedValue(preflight);
    state.wallet.sendPrivate.mockReset().mockResolvedValue({ contentHash: `0x${"aa".repeat(32)}`, publication: "relay" });
    state.wallet.paymentActivity = [expired];
    state.activity = undefined;
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    try {
      await act(async () => { root.render(<WebsiteSettingsContext.Provider value={settings}>{tree(<><Activity /><PanelView /></>)}</WebsiteSettingsContext.Provider>); });
      await act(async () => { button(element, "Resend")!.click(); });
      // What the expired payment carried, as a new action: no selection of its dead bytes.
      const intent = { to: expired.deliveryTarget, amount: expired.amount, memo: "Lunch", includeSender: true, newAction: true, ...transport };
      expect(state.wallet.preflightPrivateSend.mock.calls).toStrictEqual([[intent]]);
      expect(state.wallet.sendPrivate.mock.calls).toStrictEqual([[intent, preflight]]);
      expect(element.querySelector("[data-panel-view]")?.textContent).toBe("send");
    } finally {
      await act(async () => root.unmount());
      element.remove();
      state.wallet.paymentActivity = [];
      localStorage.clear();
    }
  });

  it("keeps Resend off until the wallet is ready, and says why", async () => {
    state.wallet.phase = "activation-pending";
    state.wallet.preflightPrivateSend.mockReset();
    state.wallet.paymentActivity = [expired];
    state.activity = undefined;
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    try {
      await act(async () => { root.render(tree(<Activity />)); });
      expect(button(element, "Resend")!.disabled).toBe(true);
      await act(async () => { button(element, "Resend")!.click(); });
      expect(state.wallet.preflightPrivateSend).not.toHaveBeenCalled();
      expect(element.textContent).toContain("Resume wallet setup to retry, resend or check these transactions.");
    } finally {
      await act(async () => root.unmount());
      element.remove();
      state.wallet.phase = "ready";
      state.wallet.paymentActivity = [];
    }
  });

  it("leaves a payment already in the Send view alone", async () => {
    const unknown = payment({ contentHash: `0x${"0c".repeat(32)}`, status: "unknown" });
    state.wallet.preflightPrivateSend.mockReset().mockResolvedValue({ ...preflight, retry: true });
    state.wallet.sendPrivate.mockReset();
    state.wallet.paymentActivity = [unknown, expired];
    state.activity = undefined;
    state.observed = { [unknown.contentHash]: "ambiguous" };
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    try {
      await act(async () => { root.render(tree(<><Activity /><PanelView /></>)); });
      await act(async () => { button(element, "Check status")!.click(); });
      await act(async () => { button(element, "Resend")!.click(); });
      expect(state.wallet.preflightPrivateSend).toHaveBeenCalledTimes(1);
      expect(state.wallet.sendPrivate).not.toHaveBeenCalled();
      expect(element.querySelector("[data-panel-message]")?.textContent).toBe("Finish or cancel this payment before resending another.");
    } finally {
      await act(async () => root.unmount());
      element.remove();
      state.wallet.paymentActivity = [];
      state.observed = {};
    }
  });
});

describe("setup mining recovery controls", () => {
  it.each(["activation-prepared", "activation-mining", "activation-pending", "ready"])(
    "only retries mining when ready (phase: %s)", async (phase) => {
      state.wallet.phase = phase;
      state.wallet.busy = false;
      state.wallet.preflightPrivateSend.mockReset();
      state.wallet.synchronize.mockClear();
      state.wallet.wallet.preflightMine.mockReset().mockResolvedValue({ retry: true, openFeeAmount: 0n });
      state.wallet.wallet.mine.mockReset().mockResolvedValue({ contentHash: "submitted" });
      state.wallet.paymentActivity = (["failed", "unknown"] as const).map((status, index) => payment({
        kind: "mine", contentHash: `0x${String(index + 1).repeat(64)}`, amount: 0n, validUntilTimestamp: 100n, status,
      }));
      state.activity = undefined;
      state.observed = { [state.wallet.paymentActivity[1]!.contentHash]: "ambiguous" };
      const element = document.createElement("div");
      document.body.append(element);
      const root = createRoot(element);
      try {
        await act(async () => { root.render(tree(<><Activity /><PanelView /></>)); });
        const controls = [...element.querySelectorAll("button")];
        expect(controls.map((button) => button.textContent).sort()).toEqual(["Retry", "Retry mining"]);
        expect(element.querySelectorAll("[data-payment-id]")).toHaveLength(2);
        for (const button of controls) {
          expect(button.disabled).toBe(phase !== "ready");
          await act(async () => { button.click(); });
        }
        if (phase === "ready") {
          expect(state.wallet.wallet.preflightMine).toHaveBeenCalledTimes(2);
          expect(state.wallet.wallet.mine).toHaveBeenCalledTimes(2);
          expect(state.wallet.preflightPrivateSend).not.toHaveBeenCalled();
          for (const mined of state.wallet.paymentActivity) expect(state.wallet.wallet.preflightMine).toHaveBeenCalledWith({
            submission: state.wallet.selfPublication, retryContentHash: mined.contentHash,
          });
          expect(element.querySelector("[data-panel-view]")?.textContent).not.toBe("send");
          expect(element.textContent).not.toContain("Resume wallet setup");
        } else {
          expect(state.wallet.wallet.preflightMine).not.toHaveBeenCalled();
          expect(element.querySelector("[data-panel-view]")?.textContent).not.toBe("send");
          expect(element.textContent).toContain("Resume wallet setup to retry, resend or check these transactions.");
        }
      } finally {
        await act(async () => root.unmount());
        element.remove();
        state.wallet.phase = "ready";
        state.wallet.paymentActivity = [];
        state.observed = {};
      }
    },
  );

  it("shows a failed mining retry in the list it was started from", async () => {
    state.wallet.wallet.preflightMine.mockReset().mockResolvedValue({ retry: true, openFeeAmount: 0n });
    state.wallet.wallet.mine.mockReset().mockRejectedValue(new Error("Your Ethereum wallet doesn't have enough ETH for this transaction and its gas."));
    state.wallet.paymentActivity = [payment({ kind: "mine", contentHash: `0x${"1".repeat(64)}`, amount: 0n, validUntilTimestamp: 100n, status: "failed" })];
    state.activity = undefined;
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    try {
      await act(async () => { root.render(tree(<Activity />)); });
      await act(async () => { [...element.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click(); });
      expect(element.querySelector('[role="alert"]')?.textContent).toBe("Error: Your Ethereum wallet doesn't have enough ETH for this transaction and its gas.");
    } finally {
      await act(async () => root.unmount());
      element.remove();
      state.wallet.paymentActivity = [];
    }
  });
});
