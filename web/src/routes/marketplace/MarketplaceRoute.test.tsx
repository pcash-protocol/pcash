import { WebsiteSettingsContext, WebsiteSettingsStore } from "../../lib/WebsiteSettings.tsx";
// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useNavigate, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EstimateGasExecutionError, RpcRequestError, TransactionRejectedRpcError } from "viem";

const mocks = vi.hoisted(() => ({
  afterAction: vi.fn(), fasterGas: vi.fn(),
  closeStore: vi.fn(),
  buyMany: vi.fn(), quotePurchases: vi.fn(), checkPaymentBalance: vi.fn(), paymentGas: vi.fn(),
  fastEstimate: undefined as import("../../lib/useFastSendEstimate.ts").FastSendEstimate | undefined,
  publicCreated: false, publishSource: vi.fn(),
  publicationIdentity: vi.fn(),
  openOffers: vi.fn(), list: vi.fn(), onProgress: undefined as ((progress: import("@pcash/marketplace/app").MarketplaceProgress) => void) | undefined,
  refresh: vi.fn(), verify: vi.fn(), create: vi.fn(), buy: vi.fn(), resume: vi.fn(), reclaim: vi.fn(), restoreContract: vi.fn(), discard: vi.fn(),
  verifyRouter: vi.fn(),
  pollReceipt: vi.fn(), copy: vi.fn(), finalizePending: vi.fn(),
  openWallet: vi.fn(), connect: vi.fn(), signIn: vi.fn(), switchNetwork: vi.fn(), setupAccount: vi.fn(), checkActivation: vi.fn(),
  router: { configuration: { address: "0x1234" } as { address: string } | undefined, error: undefined as string | undefined },
  wallet: { phase: "disconnected", accountRecord: "absent", busy: false, profile: undefined as { address: bigint } | undefined, wallet: undefined as object | undefined,
    connectedAccount: undefined as string | undefined,
    node: { getMempoolTransaction: vi.fn(), getTransactionByNullifier: vi.fn(), areNullifiersSpent: vi.fn() }, readStatus: vi.fn(), walletClient: undefined as object | undefined, selfPublication: { mode: "l1", preflight: vi.fn(), submit: vi.fn() }, error: undefined as string | undefined,
    funds: undefined as { spendablePrivate: bigint } | undefined, snapshot: undefined as object | undefined, l1Balance: undefined as bigint | undefined },
}));
vi.mock("../../names/useEthereumName.ts", () => ({ useEthereumName: () => undefined }));
vi.mock("../../lib/WalletProvider.tsx", () => ({ errorMessage: (cause: unknown) => cause instanceof Error ? cause.message : String(cause), useWallet: () => ({
  ...mocks.wallet, runAction: async (action: () => Promise<unknown>) => { const result = await action(); await mocks.afterAction(); return result; }, connect: mocks.connect,
  signIn: mocks.signIn, switchNetwork: mocks.switchNetwork, setupAccount: mocks.setupAccount,
  checkAccountActivation: mocks.checkActivation, assertFasterGas: mocks.fasterGas,
}) }));
vi.mock("../wallet/OwnerPanels.tsx", () => ({ useWalletPanel: () => ({ openOverview: mocks.openWallet }) }));
vi.mock("@rainbow-me/rainbowkit", () => ({ useConnectModal: () => ({ openConnectModal: mocks.connect }) }));
vi.mock("../../lib/useConnectWallet.ts", () => ({ useConnectWallet: () => mocks.connect }));
vi.mock("@pcash/sdk/clients", async (original) => ({ ...await original<object>(), pollReceipt: mocks.pollReceipt }));
vi.mock("../../lib/finalizeMempoolTransaction.ts", () => ({ finalizeMempoolTransaction: (...args: unknown[]) => mocks.finalizePending(...args) }));
vi.mock("./configuration.ts", () => ({ resolveMarketplaceRouterConfiguration: () => mocks.router }));
vi.mock("./sourceOpenings.ts", () => ({
  marketplacePscanClient: () => ({}), isPublicCreatedOffer: () => mocks.publicCreated,
  publishMarketplaceSourceOpenings: (...args: unknown[]) => mocks.publishSource(...args),
}));
vi.mock("../../lib/MarketplaceStore.ts", () => ({
  BROWSER_MARKETPLACE_OPERATION_LOCK: {}, marketplaceStoreName: String, openMarketplaceStore: async () => ({ close: mocks.closeStore, list: mocks.list }),
}));
vi.mock("../../lib/useFastSendEstimate.ts", () => ({ useFastSendEstimate: () => mocks.fastEstimate }));
vi.mock("@pcash/marketplace/app", async original => ({
  ...await original<object>(),
  fetchOpenOffers: (...args: unknown[]) => mocks.openOffers(...args),
  MarketplaceController: class {
    constructor(options: { onProgress: (progress: import("@pcash/marketplace/app").MarketplaceProgress) => void }) { mocks.onProgress = options.onProgress; }
    buyMany = mocks.buyMany; quotePurchases = mocks.quotePurchases; checkPaymentBalance = mocks.checkPaymentBalance; paymentGas = mocks.paymentGas;
    refresh = mocks.refresh; verify = mocks.verify; createAndPublish = mocks.create; buy = mocks.buy;
    resumePublication = mocks.resume; reclaim = mocks.reclaim; restoreContract = mocks.restoreContract; discardUnfundedPublication = mocks.discard;
  },
  publicationIdentity: (pub: { terms: { id: string } }) => mocks.publicationIdentity(pub),
  escrowCommitments: (pub: { terms: { id: string } }) => ({ nullifier: `nullifier-${pub.terms.id}` }),
  publicationContractAddress: (pub: { l2Contract: { bodyHex: string } }) => pub.l2Contract.bodyHex,
  durableOfferPublications: (local: { pub: unknown }) => [local.pub],
  sharedOfferFromUrl: (url: string) => { const hash = new URL(url).hash; return hash ? JSON.parse(decodeURIComponent(hash.slice(1))) : null; },
  listingShareUrl: (pub: unknown, base: string) => `${base.split("#")[0]}#${encodeURIComponent(JSON.stringify(pub))}`,
  marketplaceActivity: (offers: { activity?: unknown; activityOwner?: bigint }[], owner?: bigint) => offers.flatMap((offer) => offer.activity && (owner === undefined || (offer.activityOwner ?? 1n) === owner) ? [{ updatedAt: 1_790_251_200_000, ...offer.activity as object }] : []),
  quotePaymentRouterFee: (gross: bigint, config: { feeRecipient: string; feeBps: number }) => {
    const websiteFeeWei = gross * BigInt(config.feeBps) / 10_000n;
    return { buyerGrossWei: gross, websiteFeeWei, sellerNetWei: gross - websiteFeeWei, ...config };
  },
  verifyPaymentRouterDeployment: (...args: unknown[]) => mocks.verifyRouter(...args),
  viemL1Signer: () => ({}),
}));
import { browserNetwork, type NetworkProfile } from "../../lib/networks.ts";
import { NetworkProvider } from "../../lib/NetworkProvider.tsx";
import MarketplaceRoute from "./MarketplaceRoute.tsx";
import { assetDefinitionAssetId, encodeAssetDefinition, formatAssetDefinition } from "@pcash/sdk/protocol";
import { toHex } from "@pcash/sdk/utils";
import { tokenPath } from "../tokens/model.ts";
import { testDefinition } from "../tokens/tokenTestSupport.ts";
import { MarketplaceProvider, useMarketplaceTodoCount } from "./MarketplaceProvider.tsx";
import { InsufficientPaymentBalanceError } from "@pcash/marketplace/app";

const publication = { reclaimAuthority: "1", terms: { id: "1", assetId: "0", amount: "1000000000000000000", ethPriceWei: "1000000000000000", deadlineT: "2000000000", seller: "1", router: "2" }, l2Contract: { bodyHex: `0x${"12".repeat(20)}` }, escrow: {} };
const verification = { safeToPay: true, checks: ["Offer is available"], escrow: "escrowed", feeQuote: { buyerGrossWei: 1000000000000000n, websiteFeeWei: 50000000000000n, sellerNetWei: 950000000000000n } };
// Fake timers would otherwise hold the query's batched updates.
notifyManager.setScheduler((callback) => callback());
let root: Root;
let queryClient: QueryClient;
let settings: WebsiteSettingsStore;
let container: HTMLDivElement;
let navigate: ReturnType<typeof useNavigate>;
let current: ReturnType<typeof useLocation>;
function TodoCount() { return <output data-testid="todo-count">{useMarketplaceTodoCount()}</output>; }
function App() { navigate = useNavigate(); current = useLocation(); return <MarketplaceProvider><TodoCount /><MarketplaceRoute /></MarketplaceProvider>; }
const todoCount = () => container.querySelector('[data-testid="todo-count"]')?.textContent;
const currentPath = () => `${current.pathname}${current.search}`;
async function render(path = "/marketplace", network?: NetworkProfile) {
  await act(async () => root.render(<QueryClientProvider client={queryClient}><WebsiteSettingsContext.Provider value={settings}><NetworkProvider {...(network ? { network } : {})}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></NetworkProvider></WebsiteSettingsContext.Provider></QueryClientProvider>));
}
async function rerender() { await act(async () => root.render(<QueryClientProvider client={queryClient}><WebsiteSettingsContext.Provider value={settings}><NetworkProvider><MemoryRouter><App /></MemoryRouter></NetworkProvider></WebsiteSettingsContext.Provider></QueryClientProvider>)); }
function button(text: string) { const found = [...container.querySelectorAll<HTMLButtonElement>("button, a")].find((node) => node.textContent === text); expect(found, text).toBeDefined(); return found!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function fill(label: string, value: string) {
  const input = [...container.querySelectorAll("label")].find((node) => node.textContent?.startsWith(label))?.querySelector("input");
  expect(input).toBeDefined();
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input!.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function search(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function select(index = 0) { await act(async () => container.querySelectorAll<HTMLInputElement>("[data-listing-select]")[index]!.click()); }
/** The owner's trades that wait on them, greyed out among the listings. */
const pendingRow = (index = 0) => container.querySelectorAll<HTMLElement>("[data-pending-trade]")[index] ?? null;
/** Opens a greyed-out trade: a saved listing in its popup, a purchase at its checkout. */
async function openPending(index = 0) { await act(async () => pendingRow(index)!.querySelector("button")!.click()); }
const listingPopup = () => container.querySelector('dialog[aria-label="Your listing"]');
/** The purchase panel beside the listings with nothing selected. */
const purchaseIdle = () => container.querySelector('[aria-label="Purchase"]')?.textContent?.includes("Select listings to see their total") ?? false;
const mineToggle = () => [...container.querySelectorAll("label")].find((node) => node.textContent?.includes("Only my listings"))?.querySelector("input");
const tokenTrigger = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.startsWith("Tokens:"))!;
const tokenMenu = () => container.querySelector('[aria-label="Filter by token"]');
const tokenOptions = () => [...tokenMenu()!.querySelectorAll("label strong")].map((node) => node.textContent);
async function toggleTokens() { await act(async () => tokenTrigger().click()); }
async function checkToken(label: string) {
  const option = [...tokenMenu()!.querySelectorAll("label")].find((node) => node.querySelector("strong")?.textContent === label);
  expect(option, label).toBeDefined();
  await act(async () => option!.querySelector("input")!.click());
}
/** Opens the listing form from the Create listing button beside the listings. */
async function openListing() { await click("Create listing"); }
function ready() { mocks.wallet.walletClient = {}; mocks.wallet.phase = "ready"; mocks.wallet.profile = { address: 1n }; }
const CONTRACT_TX = `0x${"ab".repeat(32)}`;
/** The store's record of this owner's saved listing. */
function storeListing(phase: "contract-submitted" | "funding-submitted" | "finalizing" | "funded", contentHash?: string, pub = publication) {
  const saved = { key: "saved", pub, publish: { submissionMode: "fast", phase: phase === "contract-submitted" ? "l2-contract-submitted" : phase, updatedAt: 1 },
    activity: { key: "saved:seller", offerKey: "saved", role: "seller", phase, status: phase === "funded" ? "ready" : "pending", publication: pub, ...(contentHash === undefined ? {} : { contentHash }) } };
  mocks.list.mockResolvedValue([saved]);
  mocks.refresh.mockResolvedValue({ catalogOffers: [publication], localOffers: [saved] });
  return [saved];
}
const offerPath = `/marketplace?offer=${publication.l2Contract.bodyHex}`;
/** Another of the owner's listings, saved before it was funded. */
const draft = { ...publication, terms: { ...publication.terms, id: "9" }, l2Contract: { bodyHex: `0x${"99".repeat(20)}` }, escrow: undefined };

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  queryClient = new QueryClient();
  settings = new WebsiteSettingsStore(() => localStorage);
  settings.setEnsEnabled(false);
  vi.clearAllMocks();
  mocks.publicationIdentity.mockReset().mockImplementation((pub: { terms: { id: string } }) => pub.terms.id);
  mocks.afterAction.mockReset().mockResolvedValue(undefined);
  mocks.fasterGas.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", Object.create(navigator, { clipboard: { value: { writeText: mocks.copy } } }));
  mocks.copy.mockResolvedValue(undefined);
  mocks.pollReceipt.mockReset().mockResolvedValue(null);
  mocks.wallet.node.getMempoolTransaction.mockResolvedValue({ status: "ready" });
  mocks.wallet.node.areNullifiersSpent.mockReset().mockImplementation(async (nullifiers: string[]) => nullifiers.map(() => false));
  mocks.wallet.node.getTransactionByNullifier.mockReset().mockResolvedValue(null);
  mocks.publicCreated = false;
  mocks.publishSource.mockResolvedValue({ status: "published" });
  Object.assign(mocks.wallet, { phase: "disconnected", accountRecord: "absent", busy: false, profile: undefined, wallet: undefined, walletClient: undefined, connectedAccount: undefined, error: undefined, funds: undefined, snapshot: undefined, l1Balance: undefined });
  mocks.finalizePending.mockReset().mockResolvedValue(undefined);
  mocks.router.error = undefined;
  mocks.router.configuration = { address: "0x1234" };
  mocks.verifyRouter.mockResolvedValue({ config: { feeRecipient: "0x5678", feeBps: 500 } });
  mocks.openOffers.mockImplementation(async (_node, offers) => offers);
  mocks.list.mockResolvedValue([]);
  mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [publication] });
  mocks.verify.mockResolvedValue(verification);
  mocks.create.mockImplementation(async () => {
    mocks.onProgress?.({ action: "publish", phase: "done", message: "Your listing is live.", elapsedMs: 0, publication: { step: "catalog" } });
    return { offer: { terms: { id: 1n } }, publication, catalogPublished: true };
  });
  mocks.buy.mockResolvedValue({ paymentHash: "0xpayment", claimContentHash: "0xclaim" });
  mocks.buyMany.mockReset().mockImplementation(async pubs => pubs.map((publication: unknown, index: number) => ({ publication, paymentHash: `0xpayment${index || ""}`, claimContentHash: `0xclaim${index || ""}` })));
  mocks.quotePurchases.mockReset().mockResolvedValue({ paymentWei: 1000000000000000n, websiteFeeWei: 50000000000000n, estimatedGasWei: 10n, maximumGasWei: 15n });
  mocks.checkPaymentBalance.mockReset().mockResolvedValue(undefined);
  mocks.paymentGas.mockReset().mockResolvedValue(2_100_000_000_000n);
  mocks.fastEstimate = { state: "ready", estimatedCostWei: 20n, maximumCostWei: 30n, collectibleOpenFee: 0n, expectedIssuance: 0n, companions: 1, ownIncluded: 0 };
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("marketplace click-through trades", () => {
  it("waits for the router fee terms before quoting or creating a listing", async () => {
    ready();
    let finish!: (value: unknown) => void;
    mocks.verifyRouter.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(); await openListing();
    await fill("PCASH amount", "12");
    await fill("Total price in ETH", "0.1");
    expect(mocks.verifyRouter).toHaveBeenCalledWith(mocks.wallet.node, expect.any(Array), "0x1234");
    expect(container.textContent).toContain("Reading the router fee from Ethereum…");
    const createButton = button("Publish listing") as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
    await act(async () => finish({ config: { feeRecipient: "0x9999", feeBps: 250 } }));
    expect(container.textContent).not.toContain("Reading the router fee from Ethereum…");
    expect(createButton.disabled).toBe(false);
    const feeTerm = [...container.querySelectorAll("dt")].find((node) => node.textContent === "Website fee included in price");
    expect(feeTerm?.nextElementSibling?.textContent).toContain("0.003 ETH");
    expect(feeTerm?.closest("details")).toBeNull();
  });

  it("retries a failed router fee lookup before enabling listing creation", async () => {
    ready();
    mocks.verifyRouter.mockRejectedValueOnce(new Error("L1 RPC unavailable"));
    await render(); await openListing();
    await fill("PCASH amount", "12");
    await fill("Total price in ETH", "0.1");
    expect(container.textContent).toContain("L1 RPC unavailable");
    expect((button("Publish listing") as HTMLButtonElement).disabled).toBe(true);
    await click("Retry router connection");
    expect(mocks.verifyRouter).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("L1 RPC unavailable");
    expect((button("Publish listing") as HTMLButtonElement).disabled).toBe(false);
    await click("Publish listing");
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("says Not enough PCASH while typing and keeps Publish disabled until the listing fits", async () => {
    ready();
    mocks.wallet.funds = { spendablePrivate: 10n * 10n ** 18n };
    await render(); await openListing();
    const submit = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await fill("Total price in ETH", "0.1");
    await fill("PCASH amount", "10");
    expect(container.textContent).not.toContain("Not enough PCASH");
    expect(submit().disabled).toBe(false);
    await fill("PCASH amount", "11");
    expect(container.textContent).toContain("Not enough PCASH");
    await act(async () => submit().click());
    expect(mocks.create).not.toHaveBeenCalled();
    expect(submit().disabled).toBe(true);
  });

  it("buys selected listings with one Ethereum transaction each and no PCASH fee, whatever the saved default", async () => {
    ready(); settings.setDefaultSubmissionMode("slow"); await render(); await select();
    expect(container.querySelector('[aria-label="Listings"] input[type="radio"]')).toBeNull();
    expect(container.textContent).not.toContain("Relayer Tip");
    expect(container.querySelector('[aria-label="Purchase"]')?.textContent).toContain("1 Ethereum transaction, each paying for one listing and carrying its claim");
    await click("Buy");
    expect(mocks.buyMany).toHaveBeenCalledWith([publication], expect.objectContaining({ assertActive: expect.any(Function) }));
  });

  it("keeps explorer notices in the relevant listing details", async () => {
    ready(); mocks.publicCreated = true;
    mocks.refresh.mockResolvedValue({ localOffers: [{ pub: publication }], catalogOffers: [publication] });
    mocks.publishSource.mockResolvedValue({ status: "pending-verification" });
    await render("/marketplace");
    expect(container.textContent).not.toContain("Explorer source verification");
    await act(async () => navigate(offerPath));
    const details = [...container.querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "Listing details");
    expect(details?.textContent).toContain("The explorer is still verifying this listing’s contract.");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button("Buy for 0.001 ETH").disabled).toBe(false);
    const fees = container.querySelector('[aria-label="Fees"]');
    expect(fees?.textContent).toBe("Website fee included0.00005 ETH");
    expect(fees?.closest("details")).toBeNull();
    mocks.publishSource.mockResolvedValue({ status: "published" });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.textContent).not.toContain("The explorer is still verifying");
  });

  it("excludes filled listings while retaining their detail route", async () => {
    const open = { ...publication, terms: { ...publication.terms, id: "2", ethPriceWei: "2000000000000000" }, l2Contract: { bodyHex: `0x${"34".repeat(20)}` } };
    mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [publication, open] });
    mocks.openOffers.mockResolvedValue([open]);
    await render("/marketplace");
    expect(container.querySelectorAll("[data-listing-select]")).toHaveLength(1);
    expect(container.querySelector("[data-listing-select]")?.closest("label")?.textContent).toContain("0.002");
    await act(async () => navigate(offerPath));
    expect(mocks.verify).toHaveBeenCalledWith(publication);
  });

  it("does not advertise unchecked offers when the spent-status read fails and retries on refresh", async () => {
    mocks.openOffers.mockRejectedValue(new Error("Node unavailable"));
    await render("/marketplace");
    expect(container.textContent).toContain("Could not check open listings");
    expect(container.querySelector("tbody")).toBeNull();
    mocks.openOffers.mockResolvedValue([]);
    await click("Refresh");
    expect(container.textContent).toContain("No open listings");
    expect(container.textContent).not.toContain("Could not check open listings");
  });

  it("sorts cards by value and total price without paying on selection", async () => {
    const cheaper = { ...publication, terms: { ...publication.terms, id: "2", amount: "4000000000000000000", ethPriceWei: "2000000000000000" }, l2Contract: { bodyHex: `0x${"34".repeat(20)}` } };
    const expired = { ...publication, terms: { ...publication.terms, id: "3", deadlineT: "1" } };
    mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [publication, expired, cheaper] });
    await render("/marketplace");
    expect(container.querySelectorAll("[data-listing-select]")).toHaveLength(2);
    expect(container.querySelector("[data-listing-select]")?.closest("label")?.textContent).toContain("4 PCASH");
    await act(async () => { const select = container.querySelector("select")!; select.value = "total"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector("[data-listing-select]")?.closest("label")?.textContent).toContain("1 PCASH");
    await select();
    expect(mocks.buyMany).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>("[data-listing-select]")?.checked).toBe(true);
  });

  it("keeps creation available while disconnected and preserves terms through setup and navigation", async () => {
    await render();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector('[aria-label="Available listings"]')).not.toBeNull();
    await openListing();
    expect(container.querySelector('[role="dialog"][aria-label="Create marketplace listing"] #list-pcash form')).not.toBeNull();
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    expect(container.querySelector<HTMLSelectElement>("form select")?.value).toBe("10080");
    expect([...container.querySelectorAll<HTMLInputElement>("#list-pcash form input")].slice(0, 2).map((input) => input.value)).toEqual(["", ""]);
    await fill("PCASH amount", "12"); await fill("Total price in ETH", "0.1");
    await click("Connect wallet"); expect(mocks.connect).toHaveBeenCalledOnce();
    mocks.wallet.phase = "sign-in-required"; await rerender();
    await click("Sign in"); expect(mocks.signIn).toHaveBeenCalledOnce(); expect(mocks.openWallet).not.toHaveBeenCalled();
    expect(mocks.setupAccount).not.toHaveBeenCalled();
    ready(); await rerender();
    expect(mocks.create).not.toHaveBeenCalled();
    await act(async () => navigate("/get")); await act(async () => navigate(-1));
    expect(container.querySelector("#list-pcash")).toBeNull();
    await openListing();
    expect(container.querySelector<HTMLInputElement>("#list-pcash form input")?.value).toBe("12");
    // Links to /marketplace#list-pcash open the popup.
    await act(async () => navigate("/get")); await act(async () => navigate("/marketplace#list-pcash"));
    const submit = container.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!;
    await act(async () => submit.click());
    expect(mocks.create).toHaveBeenCalledWith({ assetId: 0n, amount: 12n * 10n ** 18n, ethPriceWei: 10n ** 17n, purchaseMinutes: 10080n, creationOpenFeeAmount: 0n, fundingOpenFeeAmount: 0n }, expect.objectContaining({ submission: expect.objectContaining({ mode: "l1" }), assertActive: expect.any(Function) }));
    expect(container.textContent).toContain("Your PCASH is listed");
    expect(container.querySelector("#list-pcash form")).toBeNull();
    expect(button("View listing progress")).toBeDefined();
  });

  it("creates a Fast listing with one click and readable progress", async () => {
    ready();
    let finish!: (value: unknown) => void;
    mocks.create.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render(); await openListing();
    await fill("PCASH amount", "1"); await fill("Total price in ETH", "0.001");
    await click("Publish listing");
    await act(async () => mocks.onProgress?.({ action: "publish", phase: "proving", message: "Preparing escrow funding", elapsedMs: 0, publication: { step: "funding" } }));
    expect(mocks.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ submission: expect.objectContaining({ mode: "l1" }) }));
    expect(container.querySelector('[aria-current="step"]')).toBeNull();
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Available listings"]')).not.toBeNull();
    // The progress replaces the form and does not repeat what was entered.
    expect(container.querySelector("#list-pcash form")).toBeNull();
    expect(container.querySelector('#list-pcash > [aria-label="Listing creation progress"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Listing inputs"]')).toBeNull();
    await act(async () => finish({ offer: { terms: { id: 1n } }, publication, catalogPublished: true }));
    expect(container.textContent).toContain("Your PCASH is listed");
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it("says Confirm in your wallet under the action whose Ethereum transaction the wallet is asking about", async () => {
    ready();
    let finish!: (value: unknown) => void;
    mocks.create.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render(); await openListing();
    await fill("PCASH amount", "1"); await fill("Total price in ETH", "0.001");
    await click("Publish listing");
    await act(async () => mocks.onProgress?.({ action: "publish", phase: "submitting", message: "Posting", elapsedMs: 0, publication: { step: "funding" } }));
    const progress = container.querySelector('[aria-label="Listing creation progress"]')!;
    expect(progress.querySelector('[role="status"]')?.textContent).toBe("Confirm in your wallet");
    expect(container.textContent?.split("Confirm in your wallet")).toHaveLength(2);
    // Past the wallet prompt, and while the funded listing is published for buyers, nothing waits in the wallet.
    await act(async () => mocks.onProgress?.({ action: "publish", phase: "confirming", message: "Waiting", elapsedMs: 0, publication: { step: "funding" } }));
    expect(container.textContent).not.toContain("Confirm in your wallet");
    await act(async () => mocks.onProgress?.({ action: "publish", phase: "submitting", message: "Listing", elapsedMs: 0, publication: { step: "catalog" } }));
    expect(container.textContent).not.toContain("Confirm in your wallet");
    await act(async () => finish({ offer: { terms: { id: 1n } }, publication, catalogPublished: true }));
  });

  it("shows the claim proof's stage and fill from the marketplace prover's updates under Buy", async () => {
    ready(); let finish!: (value: unknown) => void;
    mocks.buyMany.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render(); await select(); await click("Buy");
    // The claim is proved by the marketplace's own prover, which reports through the controller's onProgress.
    await act(async () => mocks.onProgress?.({ action: "buy", phase: "proving", message: "execute escrow_claim", elapsedMs: 0, step: "execute", scope: "circuit", circuit: "escrow_claim", circuitIndex: 0, circuitCount: 4 }));
    expect(container.textContent).toContain("Running circuit 1 of 4…");
    const started = Number(container.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow"));
    await act(async () => mocks.onProgress?.({ action: "buy", phase: "proving", message: "prove chonk-finalize", elapsedMs: 0, step: "prove", scope: "stack", operation: "finalize", circuitCount: 4 }));
    // The stage names itself in the progress line; the raw prover message stays in Transaction details.
    expect(container.querySelector(".proof-progress")?.textContent).toBe("Buying PCASHFinishing the proof. This step takes longest.");
    expect(Number(container.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow"))).toBeGreaterThan(started);
    // A completion can arrive together with the next start, and the last one just
    // before the purchase ends; React renders neither, and both measurements are kept.
    await act(async () => {
      mocks.onProgress?.({ action: "buy", phase: "proving", message: "execute escrow_claim", elapsedMs: 0, step: "execute", scope: "circuit", circuit: "escrow_claim", circuitIndex: 0, circuitCount: 4, durationMs: 700 });
      mocks.onProgress?.({ action: "buy", phase: "proving", message: "execute kernel", elapsedMs: 0, step: "execute", scope: "circuit", circuit: "kernel", circuitIndex: 1, circuitCount: 4 });
    });
    await act(async () => {
      mocks.onProgress?.({ action: "buy", phase: "proving", message: "compress chonk-compress", elapsedMs: 0, step: "artifacts", scope: "stack", operation: "compress", circuitCount: 4, durationMs: 900 });
      finish([{ publication, paymentHash: "0xpayment", claimContentHash: "0xclaim" }]);
    });
    expect(JSON.parse(localStorage.getItem("pcash:proof-timings")!)).toEqual({ execute: 700, "compress:4": 900 });
    localStorage.removeItem("pcash:proof-timings");
  });

  it("says Confirm in your wallet under Buy while the claim waits in the wallet, and counts claims", async () => {
    ready(); let finish!: (value: unknown) => void;
    mocks.buyMany.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render(); await select(); await click("Buy");
    expect(container.textContent).not.toContain("Confirm in your wallet");
    await act(async () => mocks.onProgress?.({ action: "buy", phase: "submitting", message: "Approve the claim in your wallet…", elapsedMs: 0 }));
    expect(button("Buying…").nextElementSibling?.textContent).toBe("Confirm in your wallet");
    await act(async () => finish([{ publication, paymentHash: "0xpayment", claimContentHash: "0xclaim" }]));
    expect(container.textContent).not.toContain("Confirm in your wallet");
    const receipt = container.querySelector('[aria-label="Purchase"] [aria-label="Purchase receipt"]')!;
    expect(receipt.textContent).toContain("Purchase complete");
    expect(receipt.querySelector("h2")?.textContent).toBe("You bought 1 PCASH");
    // The claim rode in the payment, so nothing is left to post to Ethereum.
    expect(receipt.textContent).not.toContain("Post to Ethereum");
    expect(receipt.querySelector('a[href="/tx/0xclaim"]')?.textContent).toBe("PCASH transaction →");
    // The receipt is the purchase's view; nothing sends the buyer to the listing's checkout.
    expect(receipt.querySelector(`a[href="${offerPath}"]`)).toBeNull();
  });

  it("shows a directly completed listing without requiring Post to Ethereum", async () => {
    ready();
    mocks.create.mockImplementation(async () => {
      mocks.onProgress?.({ action: "publish", phase: "done", message: "Your listing is live.", elapsedMs: 0, publication: { step: "catalog" } });
      return { offer: { terms: { id: 1n } }, publication, catalogPublished: true };
    });
    await render(); await openListing();
    await fill("PCASH amount", "1"); await fill("Total price in ETH", "0.001");
    await click("Publish listing");
    expect(container.textContent).toContain("Your PCASH is listed");
    expect(container.textContent).not.toContain("Continue");
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("shows what a finished listing saved, not the step the page last read, once it stops running", async () => {
    ready();
    const saved = (activity: object) => [{ key: "saved", pub: publication, activity: { key: "saved:seller", offerKey: "saved", role: "seller", publication, ...activity } }];
    let finish!: (value: unknown) => void;
    mocks.create.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render(); await openListing();
    await fill("PCASH amount", "1"); await fill("Total price in ETH", "0.001");
    await click("Publish listing");
    // The catalog step reads the saved listing while it is funded but not yet in the catalog.
    mocks.list.mockResolvedValue(saved({ phase: "publication-failed", status: "action-required", error: "Funded offer has not been published to the catalog" }));
    await act(async () => mocks.onProgress?.({ action: "publish", phase: "submitting", message: "Your escrow is funded. Making your listing available to buyers…", elapsedMs: 0,
      publication: { step: "catalog", offerAddress: publication.l2Contract.bodyHex } }));
    // The popup shows the listing being created, so the orderbook and the count leave it out.
    expect(pendingRow()).toBeNull();
    expect(todoCount()).toBe("0");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // The catalog write lands after that read, and the refresh that follows the listing is slow.
    mocks.list.mockResolvedValue(saved({ phase: "funded", status: "ready" }));
    mocks.refresh.mockImplementation(() => new Promise(() => undefined));
    await act(async () => {
      mocks.onProgress?.({ action: "publish", phase: "done", message: "Your listing is live.", elapsedMs: 0, publication: { step: "catalog", offerAddress: publication.l2Contract.bodyHex } });
      finish({ offer: { terms: { id: 1n } }, publication, catalogPublished: true });
    });
    expect(container.textContent).toContain("Your PCASH is listed");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(pendingRow()).toBeNull();
    expect(todoCount()).toBe("0");
  });

  it.each(["activation-required", "activation-prepared"])("uses the same setup action in %s", async (phase) => {
    mocks.wallet.phase = phase;
    await render(); await openListing();
    await click("Open wallet");
    expect(mocks.openWallet).toHaveBeenCalledOnce(); expect(mocks.setupAccount).not.toHaveBeenCalled();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("signs in a locked wallet from the trade and keeps the draft when the signature is declined", async () => {
    mocks.wallet.phase = "sign-in-required";
    mocks.wallet.accountRecord = "present";
    mocks.signIn.mockRejectedValueOnce(new Error("User rejected the request"));
    await render(); await openListing();
    await fill("PCASH amount", "12");
    await click("Sign in");
    expect(mocks.signIn).toHaveBeenCalledOnce(); expect(mocks.openWallet).not.toHaveBeenCalled();
    expect(mocks.setupAccount).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Gas is paid in ETH");
    expect(container.querySelector<HTMLInputElement>("#list-pcash form input")?.value).toBe("12");
  });

  it("buys selected listings and displays transaction links", async () => {
    ready(); await render(); await select(); await click("Buy");
    expect(mocks.buyMany).toHaveBeenCalledWith([publication], expect.objectContaining({ assertActive: expect.any(Function) }));
    const receipt = container.querySelector('[aria-label="Purchase"] [aria-label="Purchase receipt"]');
    expect(receipt?.textContent).toContain("Purchase complete");
    expect(receipt?.querySelector('a[href="/tx/0xclaim"]')).not.toBeNull();
    // The receipt replaces the panel's quote and Buy.
    expect([...container.querySelectorAll('[aria-label="Purchase"] button')].map((node) => node.textContent)).toEqual(["Open wallet", "Done"]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(button("Create listing")).toBeDefined();
    await click("Open wallet"); expect(mocks.openWallet).toHaveBeenCalledOnce();
    await click("Done"); expect(purchaseIdle()).toBe(true);
  });

  it("refreshes the catalog when returning to the marketplace", async () => {
    mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [] });
    await render();
    expect(container.querySelectorAll("[data-listing-select]")).toHaveLength(0);
    await act(async () => navigate("/get"));
    mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [publication] });
    await act(async () => navigate("/marketplace"));
    expect(container.querySelectorAll("[data-listing-select]")).toHaveLength(1);
  });

  it("preserves seller drafts through panel navigation and wallet setup", async () => {
    await render(); await openListing();
    await fill("PCASH amount", "12"); await fill("Total price in ETH", "0.1");
    await select();
    expect(container.querySelector("#list-pcash form")).not.toBeNull();
    await act(async () => navigate("/get"));
    expect(container.querySelector("#list-pcash form")).toBeNull();
    await act(async () => navigate("/marketplace")); await openListing();
    expect(container.querySelector<HTMLInputElement>("#list-pcash form input")?.value).toBe("12");
    await act(async () => navigate(-1));
    expect(container.querySelector("#list-pcash form")).toBeNull();
    await act(async () => navigate(1)); await openListing();
    expect(container.querySelector<HTMLInputElement>("#list-pcash form input")?.value).toBe("12");
    expect(mocks.buy).not.toHaveBeenCalled();
  });

  it("shows purchase progress under Buy and keeps the bought listings after they leave the catalog", async () => {
    ready(); let finish!: (value: unknown) => void;
    mocks.buyMany.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render(); await select(); await click("Buy");
    const bar = () => container.querySelector('[aria-label="Purchase"]');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(button("Buying…").disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>("[data-listing-select]")?.disabled).toBe(true);
    const status = bar()?.querySelector('[aria-label="Purchase status"]');
    expect(status?.previousElementSibling).toBe(button("Buying…"));
    expect(status?.querySelector('[role="progressbar"]')).not.toBeNull();
    mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [] });
    await act(async () => finish([{ publication, paymentHash: "0xpayment", claimContentHash: "0xclaim" }]));
    expect(container.querySelectorAll("[data-listing-select]")).toHaveLength(0);
    expect(bar()?.querySelector("h2")?.textContent).toBe("You bought 1 PCASH");
    expect(bar()?.textContent).toContain("Purchase complete");
    await click("Done");
    expect(purchaseIdle()).toBe(true);
    expect(bar()?.querySelector('[aria-label="Purchase status"]')).toBeNull();
  });

  it("opens listing progress immediately and lets creation finish while the popup is closed", async () => {
    ready();
    let finish!: (value: unknown) => void;
    mocks.create.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render(); await openListing(); await fill("PCASH amount", "1"); await fill("Total price in ETH", "0.001");
    await click("Publish listing");
    const dialog = () => container.querySelector('[role="dialog"][aria-label="Create marketplace listing"]');
    expect(dialog()?.textContent).toContain("Creating your listing");
    expect(container.querySelector("#list-pcash form")).toBeNull();
    expect(dialog()?.querySelector('[aria-label="Listing inputs"]')).toBeNull();
    expect(document.activeElement).toBe(dialog());
    await act(async () => dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button("View listing progress"));
    await click("View listing progress");
    expect(dialog()?.textContent).toContain("Creating your listing");
    expect(mocks.create).toHaveBeenCalledOnce();
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('[aria-label="Close listing"]')!.click());
    await act(async () => finish({ offer: { terms: { id: 1n } }, publication, catalogPublished: true }));
    expect(dialog()).toBeNull();
    await click("View listing progress");
    expect(dialog()?.textContent).toContain("Your PCASH is listed");
    await click("Done");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button("Create listing"));
    await openListing();
    expect(container.querySelector("#list-pcash h2")?.textContent).toBe("List your PCASH");
    expect(container.querySelector<HTMLInputElement>("#list-pcash form input")?.value).toBe("");
    expect(container.querySelector<HTMLInputElement>("#list-pcash form input")?.disabled).toBe(false);
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it("re-enables the form with its values after a failure before anything was saved", async () => {
    ready(); mocks.create.mockRejectedValueOnce(new Error("User rejected the request"));
    await render(); await openListing(); await fill("PCASH amount", "12"); await fill("Total price in ETH", "0.1");
    await click("Publish listing");
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("User rejected the request");
    expect(dialog.textContent).toContain("Your listing was not created");
    expect(dialog.textContent).not.toContain("progress is saved");
    expect(dialog.textContent).not.toContain("Back to listing");
    const amount = container.querySelector<HTMLInputElement>('[role="dialog"] #list-pcash form input')!;
    expect([amount.value, amount.disabled]).toEqual(["12", false]);
    await click("Publish listing");
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Your PCASH is listed");
  });

  it("offers Continue, not a second listing, when a failure follows a saved listing transaction", async () => {
    ready();
    const contentHash = `0x${"ab".repeat(32)}`;
    const saved = { pub: publication, activity: { key: "seller:1", role: "seller", phase: "contract-submitted", status: "pending", publication, contentHash } };
    mocks.list.mockResolvedValue([saved]);
    mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [saved] });
    mocks.create.mockImplementationOnce(async () => {
      mocks.onProgress?.({ action: "publish", phase: "preparing", message: "Your listing creation transaction is ready.", elapsedMs: 0,
        publication: { step: "contract", contentHash, offerAddress: publication.l2Contract.bodyHex } });
      throw new Error("User rejected the request");
    });
    mocks.resume.mockResolvedValue({ offer: { terms: { id: 1n } }, publication, catalogPublished: true });
    await render(); await openListing(); await fill("PCASH amount", "12"); await fill("Total price in ETH", "0.1");
    await click("Publish listing");
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("User rejected the request");
    expect(dialog.textContent).toContain("Your progress is saved.");
    expect(dialog.querySelector("form")).toBeNull();
    await click("Continue");
    expect(mocks.resume).toHaveBeenCalledWith(publication, expect.objectContaining({ submission: expect.objectContaining({ mode: "l1" }) }));
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(dialog.textContent).toContain("Your PCASH is listed");
  });

  it("opens a shared offer absent from the catalog in checkout", async () => {
    mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [] });
    await render(`${offerPath}&publication=${encodeURIComponent(encodeURIComponent(JSON.stringify(publication)))}`);
    expect(mocks.verify).toHaveBeenCalledWith(publication);
    expect(container.querySelector('[aria-label="Trade PCASH"]')).not.toBeNull();
    expect(container.textContent).toContain("Review purchase");
  });

  it("loads a short listing URL directly from the catalog without a local offer or shared fragment", async () => {
    await render(offerPath);
    expect(mocks.verify).toHaveBeenCalledWith(publication);
    expect(container.textContent).toContain("0.001 ETH");
    expect(container.textContent).not.toContain("Loading listing");
    await click("Copy listing link");
    expect(mocks.copy).toHaveBeenCalledWith(new URL(offerPath, window.location.origin).href);
  });

  it("opens the newly created listing before the catalog or local refresh returns it", async () => {
    ready();
    mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [] });
    mocks.create.mockResolvedValue({ offer: { terms: { id: 1n } }, publication, catalogPublished: true });
    await render(); await openListing();
    await fill("PCASH amount", "1"); await fill("Total price in ETH", "0.001");
    await click("Publish listing");
    expect(button("View listing").parentElement).toBe(button("Copy link").parentElement);
    expect(button("View contract").parentElement).toBe(button("Copy link").parentElement);
    await click("Copy link");
    expect(mocks.copy).toHaveBeenCalledWith(new URL(offerPath, window.location.origin).href);
    expect(button("View listing").getAttribute("href")).toBe(offerPath);
    await click("View listing");
    expect(mocks.verify).toHaveBeenCalledWith(publication);
    expect(container.textContent).toContain("Review purchase");
    expect(container.textContent).not.toContain("Listing unavailable");
  });

  it("refreshes with the current wallet client after listing approvals replace it", async () => {
    ready();
    let finish!: (value: unknown) => void;
    mocks.create.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render(); await openListing();
    await fill("PCASH amount", "1"); await fill("Total price in ETH", "0.001");
    await click("Publish listing");
    mocks.wallet.walletClient = {};
    await rerender();
    await act(async () => finish({ offer: { terms: { id: 1n } }, publication, catalogPublished: true }));
    expect(container.textContent).toContain("Your PCASH is listed");
    expect(container.textContent).not.toContain("Loading listings…");
    expect(button("Refresh").disabled).toBe(false);
  });

  it("releases the listing action while its background catalog refresh is pending", async () => {
    ready();
    mocks.create.mockResolvedValue({ offer: { terms: { id: 1n } }, publication, catalogPublished: true });
    await render();
    let finishRefresh!: (value: unknown) => void;
    mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
    await openListing();
    await fill("PCASH amount", "1"); await fill("Total price in ETH", "0.001");
    await click("Publish listing");
    await click("Done");
    await openListing();
    await fill("PCASH amount", "1"); await fill("Total price in ETH", "0.001");
    expect(button("Publish listing").disabled).toBe(false);
    await act(async () => finishRefresh({ localOffers: [], catalogOffers: [publication] }));
  });

  it("opens the seller's own saved listing from its short URL and closes back to the marketplace", async () => {
    ready();
    mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [{ pub: publication, activity: {
      key: "seller:1", role: "seller", phase: "funded", status: "confirmed", publication,
    } }] });
    await render(offerPath);
    const panel = () => container.querySelector('[aria-label="Trade PCASH"]');
    expect(panel()?.textContent).toContain("Your listing");
    expect(panel()?.textContent).toContain("Listing live");
    expect(container.textContent).not.toContain("Review purchase");
    // A live listing waits on no one, so it is not greyed out.
    expect(pendingRow()).toBeNull();
    await click("Close");
    expect(panel()).toBeNull();
    expect(currentPath()).toBe("/marketplace");
  });

  it("shows the seller's own listing as sold once a claim spent its escrow, with no reclaim after T", async () => {
    ready();
    const expired = { ...publication, terms: { ...publication.terms, deadlineT: "1" } };
    mocks.wallet.node.areNullifiersSpent.mockImplementation(async (nullifiers: string[]) => nullifiers.map(() => true));
    mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [{ pub: expired, activity: {
      key: "seller:1", role: "seller", phase: "funded", status: "ready", publication: expired,
    } }] });
    await render(offerPath);
    const panel = () => container.querySelector('[aria-label="Trade PCASH"]');
    expect(panel()?.textContent).toContain("Listing sold");
    expect(panel()?.textContent).not.toContain("Reclaim");
  });

  it("rejects invalid form amounts before submitting", async () => {
    ready(); await render("/marketplace"); await openListing();
    await fill("PCASH amount", "-1"); await fill("Total price in ETH", "0.1");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("stops offering a listing for new purchases in its claim-only period", async () => {
    ready(); mocks.wallet.l1Balance = 0n;
    // Buying closes 24.5 hours before T, so a listing one hour from T is claim-only.
    const closing = { ...publication, terms: { ...publication.terms, deadlineT: String(Math.floor(Date.now() / 1_000) + 3_600) } };
    mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [closing] });
    await render("/marketplace");
    expect(container.textContent).toContain("No open listings");
    await act(async () => navigate(offerPath));
    expect(container.textContent).toContain("Buying closed at");
    expect(container.textContent).not.toContain("Buy before");
    expect(container.textContent).not.toContain("Not enough ETH for this purchase");
    expect(container.textContent).not.toContain("faucet");
    expect([...container.querySelectorAll("button")].some((node) => node.textContent?.startsWith("Buy for"))).toBe(false);
    // With no purchase saved in this browser, a restored wallet can still find a payment it made before the cutoff.
    await click("Check for my payment");
    expect(mocks.buy).toHaveBeenCalledWith(closing, expect.objectContaining({ assertActive: expect.any(Function) }));
  });

  it("allows retry after failed verification and prevents buying an unavailable offer", async () => {
    ready(); mocks.wallet.l1Balance = 0n; mocks.verify.mockRejectedValueOnce(new Error("Node unavailable"));
    await render(offerPath);
    expect(container.querySelector('[aria-label="Trade PCASH"] [role="alert"]')?.textContent).toContain("Node unavailable");
    mocks.verify.mockResolvedValue({ ...verification, safeToPay: false, escrow: "spent" });
    await click("Retry verification");
    expect(container.textContent).toContain("already been bought or reclaimed");
    expect(container.textContent).not.toContain("Not enough ETH for this purchase");
    expect(container.textContent).not.toContain("faucet");
    expect(button("Buy for 0.001 ETH").disabled).toBe(true);
    expect(mocks.buy).not.toHaveBeenCalled();
  });

  it("discards verification after navigation or wallet replacement", async () => {
    let resolve!: (value: unknown) => void;
    mocks.verify.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await render(offerPath); await click("Close");
    await act(async () => resolve(verification));
    expect(container.textContent).not.toContain("Review purchase");
    ready(); await act(async () => navigate(offerPath));
    expect(container.textContent).toContain("Review purchase");
    mocks.wallet.wallet = { on: () => async () => {} }; mocks.wallet.phase = "opening"; await rerender();
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Buy for 0.001 ETH")).toBe(false);
  });

  it.each([false, true])("refreshes recovery state and shows the saved purchase in the orderbook (%s)", async (saved) => {
    ready(); mocks.buy.mockRejectedValueOnce(new Error("Signature rejected"));
    await render(offerPath); const reads = mocks.refresh.mock.calls.length;
    if (saved) mocks.refresh.mockResolvedValue({ catalogOffers: [publication], localOffers: [{ pub: publication, activity: {
      key: "buyer:1", role: "buyer", phase: "selected", status: "action-required", publication,
    } }] });
    await click("Buy for 0.001 ETH");
    expect(container.textContent).toContain("Signature rejected");
    expect(container.textContent?.split("Signature rejected")).toHaveLength(2);
    expect(pendingRow()?.textContent?.includes("Needs payment") ?? false).toBe(saved);
    expect(mocks.refresh.mock.calls.length).toBeGreaterThan(reads);
    expect(mocks.buy).toHaveBeenCalledOnce();
  });

  it("keeps the form readable when marketplace configuration is missing", async () => {
    ready(); mocks.router.configuration = undefined; mocks.router.error = "Marketplace payments are read-only";
    await render("/marketplace"); await openListing();
    await fill("PCASH amount", "1"); await fill("Total price in ETH", "0.1");
    expect(container.textContent).toContain("read-only");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    ["activation-blocked", "An earlier Ethereum transaction is unresolved"],
    ["activation-ambiguous", "hasn’t returned a transaction hash"],
    ["activation-mining", "Waiting for Ethereum confirmation"],
    ["activation-pending", "Ethereum confirmed"],
  ])("explains %s separately from placing a sell order", async (phase, explanation) => {
    mocks.wallet.phase = phase;
    await render(); await openListing();
    expect(container.textContent).toContain(explanation);
    expect(container.textContent).toContain("It does not submit a trade");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("allows drafting a listing while the wallet is busy preparing", async () => {
    mocks.wallet.phase = "opening"; mocks.wallet.busy = true;
    await render(); await openListing();
    expect([...container.querySelectorAll("form input:not([type=radio]), form select")].every(input => !(input as HTMLInputElement).disabled)).toBe(true);
    await fill("PCASH amount", "12"); await fill("Total price in ETH", "0.1");
    expect(container.querySelector<HTMLInputElement>("#list-pcash form input")?.value).toBe("12");
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    ready(); mocks.wallet.busy = false; await rerender();
    expect(container.querySelector<HTMLInputElement>("#list-pcash form input")?.value).toBe("12");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });

  it("keeps offer storage open while a submitted publication continues off-route", async () => {
    ready(); let finish!: (value: unknown) => void;
    mocks.create.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await render(); await openListing(); await fill("PCASH amount", "1"); await fill("Total price in ETH", "0.1");
    await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await act(async () => root.render(null));
    expect(mocks.closeStore).not.toHaveBeenCalled();
    await act(async () => finish({ offer: { terms: { id: 1n } }, publication, catalogPublished: true }));
    expect(mocks.closeStore).toHaveBeenCalledOnce();
  });

  it("serializes repeated create clicks while funding is pending", async () => {
    ready(); let finish!: (value: unknown) => void;
    mocks.create.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await render("/marketplace"); await openListing(); await fill("PCASH amount", "1"); await fill("Total price in ETH", "0.1");
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => { submit.click(); submit.click(); });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(container.querySelector("#list-pcash form")).toBeNull();
    await act(async () => {
      mocks.onProgress?.({ action: "publish", phase: "confirming", message: "Waiting for your escrow funding to be confirmed.", elapsedMs: 0, publication: { step: "funding", contentHash: `0x${"ab".repeat(32)}` } });
    });
    expect(container.textContent).toContain("Waiting for Ethereum to confirm your listing…");
    await act(async () => finish({ offer: { terms: { id: 1n } }, publication, catalogPublished: true }));
    expect(container.textContent).toContain("Your PCASH is listed");
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it.each(["publication-failed", "paid", "payment-ambiguous"])("resumes durable %s activity through the existing controller", async (phase) => {
    ready(); mocks.wallet.walletClient = {};
    const role = phase === "publication-failed" ? "seller" : "buyer";
    mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [{ pub: publication, activity: {
      key: "trade", role, phase, status: "action-required", publication, openFeeBaseUnits: "7",
    } }] });
    mocks.resume.mockResolvedValue({ offer: { terms: { id: 1n } }, publication, catalogPublished: true });
    await render();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.buy).not.toHaveBeenCalled();
    // Opening the greyed-out trade starts nothing: a listing opens in its popup, a purchase at its checkout.
    await openPending();
    expect(role === "seller" ? listingPopup() : container.querySelector('[aria-label="Trade PCASH"]')).not.toBeNull();
    expect(currentPath()).toBe(role === "seller" ? "/marketplace" : offerPath);
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.buy).not.toHaveBeenCalled();
    await click("Continue");
    if (role === "seller") {
      expect(mocks.resume).toHaveBeenCalledWith(publication, expect.objectContaining({ submission: expect.objectContaining({ mode: "l1" }), assertActive: expect.any(Function) })); expect(mocks.create).not.toHaveBeenCalled();
    } else expect(mocks.buy).toHaveBeenCalledWith(publication, expect.objectContaining({ assertActive: expect.any(Function) }));
  });

  it.each(["wrong-network", "activation-blocked", "activation-ambiguous", "error"])("offers inline recovery for %s", async (phase) => {
    mocks.wallet.phase = phase; await render("/marketplace"); await openListing();
    const [label, action] = phase === "wrong-network" ? ["Switch network", mocks.switchNetwork] as const
      : phase === "error" ? ["Reconnect wallet", mocks.connect] as const : ["Check status", mocks.checkActivation] as const;
    await click(label); expect(action).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("discloses proceeds before submitting a listing", async () => {
    ready();
    await render("/marketplace"); await openListing();
    await fill("PCASH amount", "12"); await fill("Total price in ETH", "0.1");
    const proceeds = [...container.querySelectorAll("#list-pcash dt")].find(dt => dt.textContent === "You receive");
    expect(proceeds?.nextElementSibling?.textContent).toBe("0.095 ETH");
    await click("Publish listing");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ ethPriceWei: 10n ** 17n }), expect.objectContaining({ submission: expect.objectContaining({ mode: "l1" }) }));
  });

  it("puts a one-week purchase window under the price and explains approvals on Publish listing", async () => {
    ready();
    await render("/marketplace"); await openListing();
    const price = [...container.querySelectorAll("#list-pcash label")].find((label) => label.textContent?.startsWith("Total price in ETH"))!;
    expect(price.nextElementSibling?.textContent).toContain("Open for purchases for");
    expect(price.nextElementSibling?.querySelector("select")?.value).toBe("10080");
    expect(container.textContent).not.toContain("Listing settings");
    expect(container.textContent).not.toContain("Open fee per action");
    const tip = document.getElementById(button("Publish listing").getAttribute("aria-describedby")!);
    expect(tip?.getAttribute("role")).toBe("tooltip");
    expect(tip?.textContent).toContain("Approve two free signatures");
    expect(tip?.hidden).toBe(true);
  });

  it("keeps catalog failures private and lets Continue retry the saved publication", async () => {
    ready();
    mocks.create.mockResolvedValue({ offer: { terms: { id: 1n } }, publication, catalogPublished: false, catalogError: "Catalog offline" });
    mocks.resume.mockResolvedValue({ offer: { terms: { id: 1n } }, publication, catalogPublished: true });
    await render(); await openListing();
    await fill("PCASH amount", "1"); await fill("Total price in ETH", "0.1");
    await click("Publish listing");
    expect(container.textContent).toContain("Your listing needs attention");
    expect(container.textContent).not.toContain("Your PCASH is listed");
    await click("Continue");
    expect(container.textContent).toContain("Your PCASH is listed");
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.resume).toHaveBeenCalledOnce();
  });

  it.each([
    ["retries only the catalog publication of a canonically funded Faster listing, which needs no ETH", { phase: "funded", fundingAcceptedBlock: "5" }, false],
    ["checks for Ethereum gas before continuing a Faster listing whose funding is not canonical", { phase: "l2-contract-submitted" }, true],
  ])("%s", async (_, publish, needsGas) => {
    ready();
    const saved = { key: "saved", pub: publication, publish: { submissionMode: "fast", catalogError: "Catalog offline", updatedAt: 1, ...publish }, activity: {
      key: "saved:seller", offerKey: "saved", role: "seller", phase: "publication-failed", status: "action-required", publication, error: "Catalog offline" } };
    mocks.list.mockResolvedValue([saved]);
    mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [saved] });
    mocks.fasterGas.mockRejectedValue(Object.assign(new Error("Not enough ETH for gas."), { name: "FasterGasError" }));
    mocks.resume.mockResolvedValue({ offer: { terms: { id: 1n } }, publication, catalogPublished: true });
    await render();
    await openPending(); await click("Continue");
    expect(mocks.fasterGas).toHaveBeenCalledTimes(needsGas ? 1 : 0);
    if (needsGas) {
      expect(mocks.resume).not.toHaveBeenCalled();
      expect(listingPopup()?.textContent).toContain("Not enough ETH for gas.");
    } else expect(mocks.resume).toHaveBeenCalledWith(publication, expect.objectContaining({ submission: expect.objectContaining({ mode: "l1" }) }));
  });

  it("serializes purchase clicks and continues after checkout closes", async () => {
    ready(); mocks.wallet.profile = { address: 2n }; let finish!: (value: unknown) => void;
    mocks.buy.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await render(offerPath);
    const buy = button("Buy for 0.001 ETH");
    await act(async () => { buy.click(); buy.click(); });
    expect(mocks.buy).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-label="Marketplace progress"]')).toBeNull();
    await click("Close");
    await act(async () => navigate("/get"));
    expect(container.querySelector('[aria-label="Marketplace progress"] a')?.getAttribute("href")).toBe("/marketplace");
    await act(async () => navigate("/marketplace"));
    await act(async () => finish({ paymentHash: "0xpayment", claimContentHash: "0xclaim" }));
    await act(async () => navigate(offerPath));
    expect(container.textContent).toContain("Receiving PCASH");
    expect(container.textContent).not.toContain("Purchase complete");
    expect(mocks.buy).toHaveBeenCalledOnce();
  });

  it("keeps the reviewed listing on screen with the purchase status under Buy", async () => {
    ready(); let finish!: (value: unknown) => void;
    mocks.buy.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await render(offerPath);
    await click("Buy for 0.001 ETH");
    const buy = button("Buying…");
    expect(buy.disabled).toBe(true);
    expect([...container.querySelectorAll("dt")].map((dt) => dt.textContent)).toContain("You receive");
    expect(container.querySelector('[aria-label="Purchase inputs"]')).toBeNull();
    expect(buy.nextElementSibling?.getAttribute("role")).toBe("status");
    await act(async () => finish({ paymentHash: "0xpayment", claimContentHash: "0xclaim" }));
    expect(buy.disabled).toBe(true);
    expect(buy.nextElementSibling?.textContent).toContain("Receiving PCASH");
    expect(container.textContent).toContain("Review purchase");
  });

  it("keeps the checkout in place as the saved purchase advances, then shows its receipt there", async () => {
    vi.useFakeTimers(); ready(); mocks.wallet.profile = { address: 2n };
    let finish!: (value: unknown) => void;
    mocks.buy.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await render(offerPath);
    await click("Buy for 0.001 ETH");
    const buy = button("Buying…");
    const title = container.querySelector("#trade-title")!;
    // The buyer's record is saved while the purchase runs and read by the store poll.
    const purchase = { key: "buyer:2", role: "buyer", publication, paymentHash: "0xpayment" };
    mocks.list.mockResolvedValue([{ pub: publication, activityOwner: 2n, activity: { ...purchase, phase: "payment-pending", status: "pending" } }]);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(buy.isConnected).toBe(true);
    expect(buy.nextElementSibling?.textContent).toContain("Waiting for ETH payment");
    mocks.refresh.mockResolvedValue({ catalogOffers: [publication], localOffers: [{ pub: publication, activityOwner: 2n,
      activity: { ...purchase, phase: "claimed", status: "complete", contentHash: "0xclaim" } }] });
    expect(title.textContent).toBe("Review purchase");
    await act(async () => finish({ paymentHash: "0xpayment", claimContentHash: "0xclaim" }));
    // The receipt takes the checkout's place in the same panel.
    expect(container.querySelector("#trade-title")?.textContent).toBe("You bought 1 PCASH");
    expect(container.querySelector('[aria-label="Trade PCASH"]')?.textContent).toContain("Purchase complete");
    expect(container.querySelectorAll('[aria-label="Trade PCASH"]')).toHaveLength(1);
  });

  it("shows a purchase error under Buy and leaves the checkout ready to try again", async () => {
    ready(); mocks.wallet.profile = { address: 2n };
    mocks.buy.mockRejectedValueOnce(new Error("User rejected the request"));
    await render(offerPath);
    await click("Buy for 0.001 ETH");
    const buy = button("Buy for 0.001 ETH");
    expect(buy.disabled).toBe(false);
    expect(buy.nextElementSibling?.getAttribute("role")).toBe("alert");
    expect(buy.nextElementSibling?.textContent).toBe("User rejected the request");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  it("shows a wallet's raw RPC refusal in plain words instead of the request dump", async () => {
    ready(); mocks.wallet.profile = { address: 2n };
    mocks.buy.mockRejectedValueOnce(new TransactionRejectedRpcError(new RpcRequestError({ body: { method: "eth_sendTransaction", params: [{ data: `0x${"ab".repeat(400)}` }] },
      url: "https://rpc.example", error: { code: -32003, message: "insufficient funds for gas * price + value" } })));
    await render(offerPath);
    await click("Buy for 0.001 ETH");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Your Ethereum wallet doesn't have enough ETH for this transaction and its gas.");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  it("polls accepted claims without overlapping reads and completes only on confirmation", async () => {
    vi.useFakeTimers();
    try {
      ready();
      const activity = { key: "buyer:1", role: "buyer", phase: "claim-accepted", status: "pending", publication };
      mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [{ pub: publication, activity }] });
      await render(offerPath);
      expect(container.textContent).toContain("Receiving PCASH");
      expect(container.textContent).not.toContain("Purchase complete");
      const reads = mocks.refresh.mock.calls.length;
      let finish!: (value: unknown) => void;
      mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      await act(async () => vi.advanceTimersByTime(5_000));
      await act(async () => { window.dispatchEvent(new Event("focus")); vi.advanceTimersByTime(10_000); });
      expect(mocks.refresh).toHaveBeenCalledTimes(reads + 1);
      await act(async () => finish({ catalogOffers: [], localOffers: [{ pub: publication, activity: { ...activity, phase: "claimed", status: "complete" } }] }));
      expect(container.textContent).toContain("Purchase complete");
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(mocks.refresh).toHaveBeenCalledTimes(reads + 1);
      expect(mocks.buy).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("keeps buyer intent explicit after setup and closes to the marketplace with Escape", async () => {
    await render();
    await act(async () => navigate(offerPath));
    expect(container.querySelector('[aria-label="Wallet setup"]')).not.toBeNull();
    ready(); await rerender();
    expect(button("Buy for 0.001 ETH").disabled).toBe(false);
    expect(mocks.buy).not.toHaveBeenCalled();
    await act(async () => container.querySelector('[aria-label="Trade PCASH"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(currentPath()).toBe("/marketplace");
    expect(container.querySelector('[aria-label="Trade PCASH"]')).toBeNull();
  });

  it("does not show a previous wallet's late purchase result as the new wallet's purchase", async () => {
    ready(); let finish!: (value: unknown) => void;
    mocks.buy.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await render(offerPath); await click("Buy for 0.001 ETH");
    mocks.wallet.profile = { address: 2n }; mocks.wallet.wallet = { on: () => async () => {} }; await rerender();
    await act(async () => finish({ paymentHash: "0xpayment", claimContentHash: "0xclaim" }));
    expect(container.textContent).not.toContain("Receiving PCASH");
    expect(container.textContent).not.toContain("Payment confirmed");
    expect(container.textContent).not.toContain("Purchase complete");
  });

});


it("publishes every listing from the Ethereum wallet with no relayer fees, whatever the saved default", async () => {
  ready(); mocks.wallet.walletClient = {};
  settings.setDefaultSubmissionMode("slow");
  await render(); await openListing();
  expect(container.querySelector('#list-pcash input[type="radio"]')).toBeNull();
  expect(container.textContent).not.toContain("fee (PCASH)");
  await fill("PCASH amount", "1"); await fill("Total price in ETH", "0.001");
  await click("Publish listing");
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ creationOpenFeeAmount: 0n, fundingOpenFeeAmount: 0n }),
    expect.objectContaining({ submission: expect.objectContaining({ mode: "l1" }) }));
  expect(mocks.fasterGas).toHaveBeenCalledOnce();
});

it("populates listings automatically after Fast confirmation and catalog publication", async () => {
  ready();
  mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [] });
  let confirm!: () => void;
  mocks.create.mockImplementation(async () => {
    await new Promise<void>(resolve => { confirm = resolve; });
    mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [publication] });
    return { offer: { terms: { id: 1n } }, publication, catalogPublished: true };
  });
  await render(); await openListing();
  await fill("PCASH amount", "1"); await fill("Total price in ETH", "0.001");
  await click("Publish listing");
  expect(container.querySelectorAll("[data-listing-select]")).toHaveLength(0);
  await act(async () => confirm());
  expect(container.textContent).toContain("Your PCASH is listed");
  expect(container.querySelectorAll("[data-listing-select]")).toHaveLength(1);
  expect(mocks.resume).not.toHaveBeenCalled();
});

it("refreshes live listings before the wallet finishes its post-trade refresh", async () => {
  ready();
  let finishWalletRefresh!: () => void;
  mocks.afterAction.mockImplementationOnce(() => new Promise<void>(resolve => { finishWalletRefresh = resolve; }));
  mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [] });
  mocks.create.mockImplementation(async () => {
    mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [publication] });
    return { offer: { terms: { id: 1n } }, publication, catalogPublished: true };
  });
  await render(); await openListing();
  await fill("PCASH amount", "1"); await fill("Total price in ETH", "0.001");
  await click("Publish listing");
  expect(container.textContent).toContain("Your PCASH is listed");
  expect(container.querySelectorAll("[data-listing-select]")).toHaveLength(1);
  expect(button("Refresh").disabled).toBe(false);
  mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [] });
  await click("Refresh");
  expect(container.querySelectorAll("[data-listing-select]")).toHaveLength(0);
  await act(async () => finishWalletRefresh());
});

it("queues a fresh listing read when Refresh is clicked during an older read", async () => {
  await render();
  let finishRead!: (value: unknown) => void;
  mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  await click("Refresh");
  const reads = mocks.refresh.mock.calls.length;
  expect(button("Refresh").disabled).toBe(false);
  await click("Refresh");
  expect(mocks.refresh).toHaveBeenCalledTimes(reads);
  mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [] });
  await act(async () => finishRead({ localOffers: [], catalogOffers: [publication] }));
  expect(mocks.refresh).toHaveBeenCalledTimes(reads + 1);
  expect(container.querySelectorAll("[data-listing-select]")).toHaveLength(0);
});

it("keeps listings visible during the refresh following a Fast publication", async () => {
  ready();
  await render();
  let finishRead!: (value: unknown) => void;
  mocks.refresh.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  mocks.create.mockResolvedValue({ offer: { terms: { id: 1n } }, publication, catalogPublished: true });
  await openListing();
  await fill("PCASH amount", "1"); await fill("Total price in ETH", "0.001");
  await click("Publish listing");
  expect(container.textContent).toContain("Your PCASH is listed");
  expect(container.querySelectorAll("[data-listing-select]")).toHaveLength(1);
  expect(button("Refresh").disabled).toBe(false);
  await act(async () => finishRead({ localOffers: [], catalogOffers: [publication] }));
});

it("finishes a slow availability check across repeated activity refreshes", async () => {
  vi.useFakeTimers(); ready();
  const pending = { pub: draft, activity: {
    key: "seller:1", role: "seller", phase: "funding-submitted", status: "pending", publication: draft,
  } };
  mocks.refresh.mockImplementation(async () => ({ localOffers: [structuredClone(pending)], catalogOffers: [structuredClone(publication)] }));
  await render();
  const checks = mocks.openOffers.mock.calls.length;
  mocks.openOffers.mockImplementation((_node, offers) => new Promise(resolve => setTimeout(() => resolve(offers), 12_000)));
  await click("Refresh");
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(mocks.openOffers).toHaveBeenCalledTimes(checks + 1);
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(container.querySelectorAll("[data-listing-select]")).toHaveLength(1);
  expect(container.textContent).not.toContain("Checking listings…");
});

it("keeps the listings and their quote in place while background checks find nothing new", async () => {
  vi.useFakeTimers(); ready();
  const pending = { pub: draft, activity: {
    key: "seller:1", role: "seller", phase: "funding-submitted", status: "pending", publication: draft,
  } };
  // Every read returns equal but freshly parsed objects, as the node and store do.
  mocks.refresh.mockImplementation(async () => ({ localOffers: [structuredClone(pending)], catalogOffers: [structuredClone(publication)] }));
  mocks.openOffers.mockImplementation(async (_node, offers) => structuredClone(offers));
  await render();
  await select();
  const table = container.querySelector('[aria-label="Available listings"]');
  const quotes = mocks.quotePurchases.mock.calls.length;
  const seen: string[] = [];
  const observer = new MutationObserver(() => seen.push(container.textContent ?? ""));
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  // Several 5s activity polls and a 15s expiry tick.
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  observer.disconnect();
  expect(mocks.openOffers.mock.calls.length).toBeGreaterThan(1);
  expect(container.querySelector('[aria-label="Available listings"]')).toBe(table);
  expect(seen.some((text) => text.includes("Updating listings") || text.includes("Estimating"))).toBe(false);
  expect(mocks.quotePurchases).toHaveBeenCalledTimes(quotes);
  expect([...container.querySelectorAll("dt")].some((dt) => dt.textContent === "Website fee")).toBe(true);
});

it("shows loading instead of an empty market before the first listings arrive", async () => {
  ready();
  let finish!: (value: unknown) => void;
  const first = new Promise((resolve) => { finish = resolve; });
  mocks.refresh.mockImplementation(() => first);
  const seen: string[] = [];
  const observer = new MutationObserver(() => seen.push(container.textContent ?? ""));
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  await render();
  expect(container.textContent).toContain("Loading listings…");
  await act(async () => finish({ localOffers: [], catalogOffers: [publication] }));
  observer.disconnect();
  expect(container.querySelectorAll("[data-listing-select]")).toHaveLength(1);
  expect(seen.some((text) => text.includes("No open listings"))).toBe(false);
});

it("reads marketplace trades only on marketplace pages", async () => {
  ready();
  await render();
  await act(async () => navigate("/explorer"));
  const calls = mocks.refresh.mock.calls.length;
  await act(async () => navigate("/blocks"));
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(mocks.refresh).toHaveBeenCalledTimes(calls);
  await act(async () => navigate("/marketplace"));
  expect(mocks.refresh.mock.calls.length).toBeGreaterThan(calls);
});

it("does not poll trades that only their owner can move forward", async () => {
  vi.useFakeTimers(); ready();
  mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [{ pub: publication, activity: {
    key: "failed", role: "seller", phase: "reclaim-failed", status: "failed", publication, contentHash: "0xreclaim", error: "Rejected",
  } }] });
  await render();
  const calls = mocks.refresh.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(mocks.refresh).toHaveBeenCalledTimes(calls);
});

it("retains listings when availability refresh fails and replaces them on a successful retry", async () => {
  await render();
  mocks.openOffers.mockRejectedValueOnce(new Error("Node unavailable"));
  await click("Refresh");
  expect(container.querySelectorAll("[data-listing-select]")).toHaveLength(1);
  expect(container.textContent).toContain("Could not check open listings");
  mocks.openOffers.mockResolvedValue([]);
  await click("Refresh");
  expect(container.querySelectorAll("[data-listing-select]")).toHaveLength(0);
  expect(container.textContent).not.toContain("Could not check open listings");
});


it("waits for Continue before resuming a listing saved in an earlier session", async () => {
  vi.useFakeTimers(); ready();
  storeListing("contract-submitted", CONTRACT_TX);
  mocks.resume.mockResolvedValue({ offer: { terms: { id: 1n } }, publication, catalogPublished: true });
  await render(offerPath);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(mocks.resume).not.toHaveBeenCalled();
  expect(pendingRow()?.textContent).toContain("Needs submission");
  await click("Continue");
  expect(mocks.resume).toHaveBeenCalledOnce();
  expect(mocks.resume).toHaveBeenCalledWith(publication, expect.objectContaining({ submission: expect.objectContaining({ mode: "l1" }) }));
});

it("discards a listing whose funding never started once the seller confirms", async () => {
  vi.useFakeTimers(); ready();
  storeListing("contract-submitted", CONTRACT_TX);
  mocks.pollReceipt.mockResolvedValue({ outcome: "succeeded" });
  mocks.discard.mockImplementation(async () => {
    mocks.list.mockResolvedValue([]);
    mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [] });
  });
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  await render(offerPath);
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  await click("Discard");
  expect(mocks.discard).not.toHaveBeenCalled();
  await click("Discard");
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(mocks.discard).toHaveBeenCalledWith(publication);
  expect(container.querySelector('[aria-label="Listings"]')?.textContent).toContain("Listing discarded.");
  expect(pendingRow()).toBeNull();
  expect(currentPath()).toBe("/marketplace");
  expect(mocks.resume).not.toHaveBeenCalled();
});

it("restores a listing after reload without approving until Continue", async () => {
  vi.useFakeTimers(); ready();
  const saved = { key: "offer", pub: publication, publish: { submissionMode: "fast" }, activity: {
    key: "seller", offerKey: "offer", role: "seller", phase: "contract-submitted", status: "pending", publication,
  } };
  mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [saved] });
  mocks.resume.mockResolvedValue({ offer: { terms: { id: 1n } }, publication, catalogPublished: true });
  await render(offerPath);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(mocks.resume).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Trade PCASH"] input[type="radio"]')).toBeNull();
  await click("Continue");
  expect(mocks.resume).toHaveBeenCalledWith(publication, expect.objectContaining({ submission: expect.objectContaining({ mode: "l1" }) }));
});

it("buys a reviewed listing in one Ethereum transaction with no relayer fee", async () => {
  ready(); settings.setDefaultSubmissionMode("slow"); await render(offerPath);
  expect(container.querySelector('[aria-label="Trade PCASH"] input[type="radio"]')).toBeNull();
  expect(container.textContent).toContain("No relayer fee");
  expect(container.textContent).toContain("One Ethereum transaction pays in ETH and claims your PCASH");
  expect(container.textContent).toContain("The payment is public on Ethereum: your address, the price and the amount.");
  await click("Buy for 0.001 ETH");
  expect(mocks.buy).toHaveBeenCalledWith(publication, expect.objectContaining({ assertActive: expect.any(Function) }));
});

it("reclaims from the Ethereum wallet with no relayer fee, only after the explicit action", async () => {
  ready(); settings.setDefaultSubmissionMode("slow");
  const expired = { ...publication, terms: { ...publication.terms, deadlineT: "1" } };
  mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [{ key: "offer", pub: expired, activity: {
    key: "seller", offerKey: "offer", role: "seller", phase: "funded", status: "confirmed", publication: expired, openFeeBaseUnits: "7",
  } }] });
  mocks.reclaim.mockResolvedValue("0xreclaim");
  await render(offerPath);
  expect(mocks.reclaim).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Trade PCASH"] input[type="radio"]')).toBeNull();
  expect(container.textContent).not.toContain("Relayer fee");
  await click("Reclaim PCASH");
  expect(mocks.reclaim).toHaveBeenCalledWith(expired, 0n, expect.objectContaining({ submission: expect.objectContaining({ mode: "l1" }) }));
});

it("reclaims from the listing's popup with the wallet prompt, error and outcome in that place", async () => {
  ready();
  const expired = { ...publication, terms: { ...publication.terms, deadlineT: "1" } };
  mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [{ key: "offer", pub: expired, activity: {
    key: "seller", offerKey: "offer", role: "seller", phase: "funded", status: "confirmed", publication: expired,
  } }] });
  mocks.reclaim.mockRejectedValueOnce(new Error("insufficient notes to cover 5000000000000000000: most spendable in one transfer is 1"));
  await render();
  expect(pendingRow()?.textContent).toContain("Ready to reclaim");
  await openPending();
  await click("Reclaim PCASH");
  expect(listingPopup()?.querySelector('[role="alert"]')?.textContent).toBe("Not enough funds in one transaction.");
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  let finish!: (value: unknown) => void;
  mocks.reclaim.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await click("Reclaim PCASH");
  await act(async () => mocks.onProgress?.({ action: "reclaim", phase: "submitting", message: "Approve Ethereum gas to publish this PCASH transaction yourself.", elapsedMs: 0 }));
  expect(listingPopup()?.querySelector('[role="status"]')?.textContent).toBe("Confirm in your wallet");
  expect(pendingRow()?.textContent).toContain("Needs wallet approval");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [{ key: "offer", pub: expired, activity: {
    key: "seller", offerKey: "offer", role: "seller", phase: "reclaim-accepted", status: "pending", publication: expired,
  } }] });
  await act(async () => finish("0xreclaim"));
  expect(pendingRow()).toBeNull();
  expect(listingPopup()?.textContent).toContain("Reclaim submitted. Your PCASH returns once it is confirmed.");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close listing"]')!.click());
  expect(listingPopup()).toBeNull();
  expect(container.querySelector('[aria-label="Listings"]')?.textContent).toContain("Reclaim submitted. Your PCASH returns once it is confirmed.");
});

it("greys out the owner's trades that wait on them among the listings, and counts them for the nav", async () => {
  ready();
  const live = { ...publication, terms: { ...publication.terms, id: "2" }, l2Contract: { bodyHex: `0x${"34".repeat(20)}` } };
  const failed = { key: "failed", role: "seller", phase: "publication-failed", status: "action-required", error: "Funded offer has not been published to the catalog", publication };
  const completed = { key: "live", role: "seller", phase: "funded", status: "ready", publication: live };
  mocks.refresh.mockResolvedValue({ catalogOffers: [live], localOffers: [
    { pub: live, activity: completed }, { pub: publication, activity: failed },
    { pub: live, activity: { ...completed, key: "other-account" }, activityOwner: 2n },
  ] });
  await render();
  expect(todoCount()).toBe("1");
  const rows = [...container.querySelectorAll('[aria-label="Available listings"] [role="row"]')].slice(1);
  expect(rows).toHaveLength(2);
  // The unfinished listing comes first, greyed out with its state and no checkbox to buy it.
  expect(rows[0]).toBe(pendingRow());
  expect(rows[0]!.textContent).toContain("Needs publishing");
  expect(rows[0]!.querySelector("[data-listing-select]")).toBeNull();
  expect(rows[1]!.querySelector("[data-listing-select]")).not.toBeNull();
  expect(container.textContent).toContain("2 listings");
  await openPending();
  expect(listingPopup()?.querySelector('[role="alert"]')?.textContent).toBe("Your listing is funded but not listed for buyers yet. Continue to list it.");
  expect(mocks.resume).not.toHaveBeenCalled();
  mocks.resume.mockResolvedValue({ offer: { terms: { id: 1n } }, publication, catalogPublished: true });
  await click("Continue");
  expect(mocks.resume).toHaveBeenCalledOnce();
});

it("marks the owner's listings and narrows the orderbook to them", async () => {
  const other = { ...publication, reclaimAuthority: "2", terms: { ...publication.terms, id: "2" }, l2Contract: { bodyHex: `0x${"34".repeat(20)}` } };
  mocks.refresh.mockResolvedValue({ catalogOffers: [publication, other], localOffers: [{ pub: draft, activity: {
    key: "draft", role: "seller", phase: "draft", status: "action-required", publication: draft,
  } }] });
  await render();
  const own = (id: string) => container.querySelector(`[data-listing-select="${id}"]`)?.closest('[role="row"]')?.querySelector('[title="Your listing"]') ?? null;
  // Signed out, no listing is the viewer's and there is nothing to narrow to.
  expect(own("1")).toBeNull();
  expect(mineToggle()).toBeUndefined();
  expect(pendingRow()).toBeNull();
  ready(); await rerender();
  expect(own("1")).not.toBeNull();
  expect(own("2")).toBeNull();
  expect(pendingRow()?.querySelector('[title="Your listing"]')).not.toBeNull();
  await select();
  await act(async () => mineToggle()!.click());
  expect(container.querySelector('[data-listing-select="2"]')).toBeNull();
  expect(container.querySelector<HTMLInputElement>('[data-listing-select="1"]')?.checked).toBe(true);
  expect(pendingRow()?.textContent).toContain("Needs proving");
  await act(async () => mineToggle()!.click());
  expect(container.querySelector('[data-listing-select="2"]')).not.toBeNull();
});

it("counts an expired listing only once the node shows no buyer took it", async () => {
  ready();
  const expired = { ...publication, terms: { ...publication.terms, id: "2", deadlineT: "1" }, l2Contract: { bodyHex: `0x${"34".repeat(20)}` } };
  const local = [
    { pub: publication, activity: { key: "interrupted", role: "seller", phase: "contract-submitted", status: "pending", publication } },
    { pub: expired, activity: { key: "expired", role: "seller", phase: "funded", status: "ready", publication: expired } },
  ];
  mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: local });
  await render();
  const reclaimable = () => container.querySelector('[data-pending-trade="2"]');
  expect(todoCount()).toBe("2");
  expect(reclaimable()?.textContent).toContain("Ready to reclaim");
  // A buyer spent the expired listing's escrow: it sold, and nothing is left to reclaim. Unsold escrows are read again at the next wallet head.
  mocks.wallet.node.areNullifiersSpent.mockImplementation(async (nullifiers: string[]) => nullifiers.map((nullifier) => nullifier === "nullifier-2"));
  Object.assign(mocks.wallet, { snapshot: { syncedThrough: { pcashHash: "0x02" } } }); await rerender();
  expect(todoCount()).toBe("1");
  expect(reclaimable()).toBeNull();
  // Before the claim's block is finalized, a reorg can remove it: the listing is the seller's to reclaim again.
  mocks.wallet.node.areNullifiersSpent.mockImplementation(async (nullifiers: string[]) => nullifiers.map(() => false));
  Object.assign(mocks.wallet, { snapshot: { syncedThrough: { pcashHash: "0x03" } } }); await rerender();
  expect(todoCount()).toBe("2");
  expect(reclaimable()?.textContent).toContain("Ready to reclaim");
});

it("shows the owner's saved trades when open listings cannot be checked", async () => {
  ready();
  mocks.openOffers.mockRejectedValue(new Error("Node unavailable"));
  mocks.refresh.mockResolvedValue({ catalogOffers: [publication], localOffers: [{ pub: draft, activity: {
    key: "draft", role: "seller", phase: "draft", status: "action-required", publication: draft,
  } }] });
  await render();
  expect(container.textContent).toContain("Could not check open listings");
  expect(container.querySelector("[data-listing-select]")).toBeNull();
  expect(pendingRow()?.textContent).toContain("Needs proving");
  await openPending();
  expect(listingPopup()?.textContent).toContain("Your progress is saved.");
});

it("shows the owner's trades and their count only to the signed-in owner", async () => {
  const activity = { key: "saved", role: "seller", phase: "publication-failed", status: "failed", publication };
  mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [{ pub: publication, activity }] });
  await render();
  expect(pendingRow()).toBeNull();
  expect(todoCount()).toBe("0");
  ready(); await rerender();
  expect(pendingRow()?.textContent).toContain("Needs publishing");
  expect(todoCount()).toBe("1");
});

it("shows Refresh as busy only for a refresh the user asked for, until its own read finishes", async () => {
  const reads: ((value: unknown) => void)[] = [];
  mocks.refresh.mockImplementation(() => new Promise(resolve => { reads.push(resolve); }));
  // The page's own first read is still running.
  await render();
  expect(reads).toHaveLength(1);
  expect(button("Refresh").getAttribute("aria-busy")).toBe("false");
  await click("Refresh");
  expect(button("Refresh").getAttribute("aria-busy")).toBe("true");
  // The read that started before Refresh does not finish it.
  await act(async () => reads[0]!({ localOffers: [], catalogOffers: [] }));
  expect(reads).toHaveLength(2);
  expect(button("Refresh").getAttribute("aria-busy")).toBe("true");
  await act(async () => reads[1]!({ localOffers: [], catalogOffers: [publication] }));
  expect(button("Refresh").getAttribute("aria-busy")).toBe("false");
});

it.each(["funding-submitted", "publication-failed", "reclaim-prepared", "reclaim-failed"])("offers Post to Ethereum for a queued seller transaction in %s", async phase => {
  ready();
  mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [{ pub: publication, activity: {
    key: "seller:1", role: "seller", phase, status: "action-required", publication, contentHash: "0xpending",
  } }] });
  await render(offerPath);
  expect(container.textContent).toContain("Not posted yet");
  expect(button("Post to Ethereum")).toBeDefined();
  expect(mocks.resume).not.toHaveBeenCalled();
  expect(mocks.reclaim).not.toHaveBeenCalled();
});

it("greys out a paid purchase whose claim has not landed, and Continue at its checkout finishes it", async () => {
  ready(); mocks.wallet.profile = { address: 2n };
  mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [{ pub: publication, activityOwner: 2n, activity: {
    key: "buyer:2", role: "buyer", phase: "paid", status: "action-required", publication, paymentHash: "0xpayment",
  } }] });
  await render();
  expect(pendingRow()?.textContent).toContain("Needs claim");
  expect(pendingRow()?.querySelector('[title="Your purchase"]')).not.toBeNull();
  await openPending();
  expect(currentPath()).toBe(offerPath);
  // A claim travels only in the buyer's own router call, never through the PCASH mempool.
  expect(container.textContent).not.toContain("Post to Ethereum");
  expect(mocks.buy).not.toHaveBeenCalled();
  await click("Continue");
  expect(mocks.buy).toHaveBeenCalledWith(publication, expect.objectContaining({ assertActive: expect.any(Function) }));
});

it("tells the buyer to Continue before T when a paid purchase's claim has not landed and nothing is running", async () => {
  ready(); mocks.wallet.profile = { address: 2n };
  mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [{ pub: publication, activityOwner: 2n, activity: {
    key: "buyer:2", role: "buyer", phase: "paid", status: "action-required", publication, paymentHash: "0xpayment",
  } }] });
  await render(offerPath);
  const status = container.querySelector('[aria-label="Trade PCASH"] [role="status"]')!;
  expect(status.textContent).toContain("Payment confirmed · Finish your claim");
  expect(status.textContent).toContain("Your PCASH claim has not landed yet. Continue checks it and sends it again if it failed. Finish before");
  expect(status.textContent).not.toContain("Keep this tab open to finish");
  expect(button("Continue")).toBeDefined();
});

it("shows a finished purchase with its Ethereum payment and PCASH claim links", async () => {
  ready();
  mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [{ pub: publication, activity: {
    key: "buyer:1", role: "buyer", phase: "claimed", status: "complete", publication, contentHash: "0xclaim", paymentHash: "0xpayment",
  } }] });
  await render(offerPath, { ...browserNetwork(), l1ChainId: 11155111 });
  const details = container.querySelector('[aria-label="Trade PCASH"]')!;
  expect(details.querySelector("h2")?.textContent).toBe("You bought 1 PCASH");
  expect(details.textContent).toContain("Purchase complete");
  expect(details.querySelector('a[href="https://sepolia.etherscan.io/tx/0xpayment"]')).not.toBeNull();
  expect(details.querySelector('a[href="/tx/0xclaim"]')).not.toBeNull();
  expect(details.querySelector(`a[href="/${publication.l2Contract.bodyHex}"]`)).not.toBeNull();
  // A finished purchase waits on no one.
  expect(pendingRow()).toBeNull();
  expect(mocks.buy).not.toHaveBeenCalled();
});

it("keeps portable listing links on the marketplace with their publication intact", async () => {
  mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [] });
  const portable = `${offerPath}&publication=${encodeURIComponent(encodeURIComponent(JSON.stringify(publication)))}`;
  await render(portable);
  await click("Copy listing link");
  const copied = new URL(mocks.copy.mock.calls[0]![0]);
  expect(copied.hash).toBe("");
  expect(copied.pathname).toBe("/marketplace");
  expect(copied.searchParams.get("offer")).toBe(publication.l2Contract.bodyHex);
  expect(JSON.parse(decodeURIComponent(copied.searchParams.get("publication")!))).toEqual(publication);
});


it("keeps the storefront free of redundant navigation controls, including its empty state", async () => {
  mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [] });
  await render();
  const labels = [...container.querySelectorAll("a, button")].map(node => node.textContent);
  expect(labels).not.toContain("Listings");
  expect(labels).not.toContain("Your trades");
  expect(labels).not.toContain("List PCASH");
  expect(container.querySelector('[aria-label="Marketplace navigation"]')).toBeNull();
  expect(container.querySelector("form")).toBeNull();
  expect(button("Create listing")).toBeDefined();
});

it("opens a saved listing in a popup from its greyed-out row and closes it without starting work", async () => {
  ready();
  mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [{ pub: publication, activity: {
    key: "saved", role: "seller", phase: "draft", status: "action-required", publication,
  } }] });
  await render();
  expect(pendingRow()?.textContent).toContain("Needs proving");
  // Clicking anywhere on the row opens it.
  await act(async () => pendingRow()!.querySelector<HTMLElement>('[role="cell"]:last-child')!.click());
  expect(listingPopup()?.textContent).toContain("Your progress is saved.");
  expect([...listingPopup()!.querySelectorAll("button")].map((node) => node.textContent)).toEqual(expect.arrayContaining(["Continue", "Discard"]));
  expect(mocks.resume).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close listing"]')!.click());
  expect(listingPopup()).toBeNull();
  expect(pendingRow()?.textContent).toContain("Needs proving");
  expect(mocks.resume).not.toHaveBeenCalled();
});

it("does not label missing or unavailable transactions as waiting in the mempool", async () => {
  vi.useFakeTimers(); ready();
  mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [{ pub: publication, activity: {
    key: "saved", role: "seller", phase: "funding-submitted", status: "pending", publication, contentHash: "0xpending",
  } }] });
  mocks.wallet.node.getMempoolTransaction.mockResolvedValue(null);
  await render();
  const row = pendingRow()!;
  expect(row.textContent).toContain("Needs submission");
  mocks.wallet.node.getMempoolTransaction.mockRejectedValue(new Error("Offline"));
  // A transaction the node no longer offers is rechecked every 15 seconds.
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(row.textContent).toContain("Needs submission");
  await act(async () => vi.advanceTimersByTimeAsync(12_000));
  expect(row.textContent).toContain("Pending");
  expect(row.textContent).not.toContain("Not posted yet");
});


it("shows what a finished purchase paid, with the gas its payment spent", async () => {
  ready(); await render(); await select(); await click("Buy");
  const totals = container.querySelector('[aria-label="Purchase receipt"] [aria-label="Purchase totals"]');
  expect([...totals!.querySelectorAll("dt")].map((node) => node.textContent)).toEqual(["You paid", "Website fee, included", "Gas"]);
  expect(totals?.textContent).toContain("0.001 ETH");
  expect(totals?.textContent).toContain("0.0000021 ETH");
  expect(mocks.paymentGas).toHaveBeenCalledWith(["0xpayment"]);
});

it("gives a recovered purchase's website fee from the router's terms, not the unpaid quote", async () => {
  ready();
  // The payment was recovered, so the quote has nothing left to pay and no fee.
  mocks.quotePurchases.mockResolvedValue({ paymentWei: 0n, websiteFeeWei: 0n, estimatedGasWei: 10n, maximumGasWei: 15n });
  await render(); await select(); await click("Buy");
  const totals = container.querySelector('[aria-label="Purchase receipt"] [aria-label="Purchase totals"]')!;
  const row = (label: string) => [...totals.querySelectorAll("dt")].find((node) => node.textContent === label)?.nextElementSibling?.textContent;
  expect(row("You paid")).toBe("0.001 ETH");
  // 500 basis points of the 0.001 ETH price.
  expect(row("Website fee, included")).toBe("0.00005 ETH");
});

it("shows its purchase, not its sold listing, on the checkout of a listing a wallet bought from itself", async () => {
  ready();
  mocks.refresh.mockResolvedValue({ catalogOffers: [], localOffers: [
    { pub: publication, activity: { key: "saved:seller", role: "seller", phase: "funded", status: "ready", publication } },
    { pub: publication, activity: { key: "buyer:1", role: "buyer", phase: "claimed", status: "complete", publication, contentHash: "0xclaim", paymentHash: "0xpayment" } },
  ] });
  await render(offerPath);
  const panel = container.querySelector('[aria-label="Trade PCASH"]')!;
  expect(panel.querySelector("h2")?.textContent).toBe("You bought 1 PCASH");
  expect(panel.textContent).not.toContain("Your listing");
});

it("links each purchase to its Ethereum and PCASH explorer", async () => {
  ready(); settings.setDefaultSubmissionMode("slow");
  const second = { ...publication, terms: { ...publication.terms, id: "2" } };
  mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [publication, second] });
  await render("/marketplace", { ...browserNetwork(), l1ChainId: 11155111 });
  await select(0); await select(1);
  expect(container.querySelectorAll('[class*="selectedRow"]')).toHaveLength(2);
  expect(container.querySelector('[aria-label="Purchase"]')?.textContent).toContain("2 listings");
  await click("Buy");
  expect(mocks.buyMany).toHaveBeenCalledWith([publication, second], expect.objectContaining({ assertActive: expect.any(Function) }));
  const payment = container.querySelector('a[href="https://sepolia.etherscan.io/tx/0xpayment"]');
  expect(payment?.textContent).toBe("Ethereum payment");
  expect(payment?.querySelector("svg")).not.toBeNull();
  expect(container.querySelector('a[href="/tx/0xclaim1"]')).not.toBeNull();
  expect(settings.getSnapshot().defaultSubmissionMode).toBe("slow");
});

it("does not send unavailable listings or substitute zero gas for a failed estimate", async () => {
  ready(); mocks.quotePurchases.mockRejectedValue(new Error("This listing has already been bought."));
  await render(); await select(); expect(button("Buy").disabled).toBe(true);
  expect(container.textContent).toContain("already been bought"); expect(mocks.buyMany).not.toHaveBeenCalled();
});

it("describes an opaque quote RPC refusal as a gas-estimation failure", async () => {
  ready();
  mocks.quotePurchases.mockRejectedValue(new EstimateGasExecutionError(new TransactionRejectedRpcError(new RpcRequestError({
    body: { method: "eth_estimateGas" }, url: "https://rpc.example", error: { code: -32003, message: "tx fee exceeds the configured cap" },
  })), {}));
  await render(); await select();
  expect(container.querySelector('[aria-label="Purchase"]')?.textContent).toContain("Ethereum gas could not be estimated right now. Try again in a moment.");
  expect(container.textContent).not.toContain("wallet refused");
  expect(button("Buy").disabled).toBe(true);
});

it("enables Buy once the listings are verified, before their gas is estimated", async () => {
  ready();
  let checked!: () => void;
  mocks.quotePurchases.mockImplementation((_publications, { onChecked }) => {
    checked = () => onChecked({ paymentWei: 1000000000000000n, websiteFeeWei: 50000000000000n });
    return new Promise(() => {});
  });
  await render(); await select();
  const bar = container.querySelector('[aria-label="Purchase"]')!;
  expect(bar.textContent).toContain("Checking listings…");
  expect(button("Buy").disabled).toBe(true);
  await act(async () => checked());
  expect(bar.textContent).toContain("0.001 ETH plus gas (estimating…)");
  expect(bar.textContent).toContain("Includes website fee 0.00005 ETH · No relayer fee");
  expect(bar.querySelector('[aria-label="Purchase totals"]')?.textContent).toContain("Website fee");
  expect(button("Buy").disabled).toBe(false);
  await click("Buy");
  expect(mocks.buyMany).toHaveBeenCalledOnce();
});

it("uses a successful fresh quote instead of a stale-low cached balance and requotes when the cache changes", async () => {
  ready(); mocks.wallet.l1Balance = 0n;
  await render(); await select();
  const purchase = container.querySelector('[aria-label="Purchase"]')!;
  expect(purchase.textContent).not.toContain("Not enough ETH for this purchase");
  expect(button("Buy").disabled).toBe(false);
  const quotes = mocks.quotePurchases.mock.calls.length;
  mocks.wallet.l1Balance = 1n;
  await rerender();
  expect(mocks.quotePurchases).toHaveBeenCalledTimes(quotes + 1);
});

it("skips gas estimation and links faucets when the wallet cannot cover the payment", async () => {
  ready();
  const paymentWei = 1000000000000000n;
  mocks.wallet.l1Balance = paymentWei + 1n;
  mocks.quotePurchases.mockRejectedValue(new InsufficientPaymentBalanceError(paymentWei - 1n, paymentWei));
  await render("/marketplace", { ...browserNetwork(), name: "Sepolia", l1ChainId: 11155111 });
  await select();
  const purchase = container.querySelector('[aria-label="Purchase"]')!;
  expect(purchase.textContent).toContain("Not enough ETH for this purchase.");
  expect(purchase.textContent).toContain("payment costs 0.001 ETH before gas");
  expect(purchase.textContent).toContain("Not estimated: payment exceeds balance");
  expect(purchase.textContent).not.toContain("wallet refused");
  expect(button("Buy").disabled).toBe(true);
  expect(mocks.buyMany).not.toHaveBeenCalled();
  expect(purchase.querySelectorAll('a[href="https://sepolia-faucet.pk910.de/"]')).toHaveLength(1);
  expect(purchase.textContent).not.toContain("Google Cloud faucet");
});

it("uses a fresh direct balance check, links one faucet on a shortfall, and retries after a cached balance change", async () => {
  ready(); mocks.wallet.profile = { address: 2n };
  const paymentWei = 1000000000000000n;
  mocks.wallet.l1Balance = paymentWei + 1n;
  mocks.checkPaymentBalance.mockRejectedValueOnce(new InsufficientPaymentBalanceError(0n, paymentWei)).mockResolvedValueOnce(undefined);
  await render(offerPath, { ...browserNetwork(), name: "Sepolia", l1ChainId: 11155111 });
  const buy = button("Buy for 0.001 ETH");
  expect(buy.disabled).toBe(true);
  expect(container.textContent).toContain("Not enough ETH for this purchase.");
  expect(container.textContent).toContain("Your Ethereum wallet has 0 ETH");
  expect(container.querySelectorAll('a[href="https://sepolia-faucet.pk910.de/"]')).toHaveLength(1);
  expect(container.textContent).not.toContain("Google Cloud faucet");
  expect(mocks.buy).not.toHaveBeenCalled();
  mocks.wallet.l1Balance = paymentWei + 2n;
  await rerender();
  expect(mocks.checkPaymentBalance).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain("Not enough ETH for this purchase.");
  expect(button("Buy for 0.001 ETH").disabled).toBe(false);
});

it("enables a direct purchase after a fresh check succeeds despite a stale-low cached balance", async () => {
  ready(); mocks.wallet.profile = { address: 2n }; mocks.wallet.l1Balance = 0n;
  await render(offerPath);
  expect(mocks.checkPaymentBalance).toHaveBeenCalledWith(1000000000000000n);
  expect(container.textContent).not.toContain("Not enough ETH for this purchase.");
  expect(button("Buy for 0.001 ETH").disabled).toBe(false);
});


it("starts only one purchase while wallet requests are pending", async () => {
  ready(); let finish!: (value: unknown) => void;
  mocks.buyMany.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render(); await select(); const buy = button("Buy");
  await act(async () => { buy.click(); buy.click(); });
  expect(mocks.buyMany).toHaveBeenCalledOnce(); expect(container.textContent).not.toContain("Purchase complete");
  await act(async () => finish([{ publication, paymentHash: "0xpayment", claimContentHash: "0xclaim" }]));
  expect(container.textContent).toContain("Purchase complete");
});

it("keeps a rejected purchase's selection and shows recovery guidance under Buy", async () => {
  ready(); mocks.buyMany.mockRejectedValueOnce(new Error("User rejected the request"));
  await render(); await select(); await click("Buy");
  const status = () => container.querySelector('[aria-label="Purchase"] [aria-label="Purchase status"]');
  expect(status()?.textContent).toContain("User rejected the request");
  expect(status()?.textContent).toContain("Your progress is saved");
  expect(container.textContent).not.toContain("Purchase complete");
  expect(container.textContent).not.toContain("Your trade couldn’t finish");
  const checkbox = container.querySelector<HTMLInputElement>("[data-listing-select]")!;
  expect([checkbox.checked, checkbox.disabled]).toEqual([true, false]);
  expect(button("Buy").disabled).toBe(false);
  await click("Buy");
  expect(mocks.buyMany).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[aria-label="Purchase"] [aria-label="Purchase receipt"]')?.textContent).toContain("Purchase complete");
  expect(container.querySelector('[aria-label="Purchase"]')?.textContent).not.toContain("User rejected the request");
});

it("reports success only once each payment's carried claim has landed", async () => {
  ready(); let finish!: (value: unknown) => void;
  mocks.buyMany.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render(); await select(); await click("Buy");
  expect(container.querySelector('[aria-label="Purchase status"]')?.textContent).not.toContain("Purchase complete");
  await act(async () => finish([{ publication, paymentHash: "0xpayment", claimContentHash: "0xclaim" }]));
  const receipt = container.querySelector('[aria-label="Purchase receipt"]')?.textContent;
  expect(receipt).toContain("Purchase complete");
  expect(receipt).not.toContain("Not posted to Ethereum yet.");
});

it("retains selection through wallet setup without paying automatically", async () => {
  await render(); await select(); expect(container.querySelector('[aria-label="Listings"] [aria-label="Wallet setup"]')).not.toBeNull();
  ready(); await rerender(); expect(container.querySelector<HTMLInputElement>('[data-listing-select]')?.checked).toBe(true);
  expect(button("Buy").disabled).toBe(false); expect(mocks.buyMany).not.toHaveBeenCalled();
});

it("summarizes the selection in a purchase panel beside the listings that stays when nothing is selected", async () => {
  ready();
  const second = { ...publication, terms: { ...publication.terms, id: "2", amount: "2000000000000000000" }, l2Contract: { bodyHex: `0x${"34".repeat(20)}` } };
  mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [publication, second] });
  await render();
  expect(purchaseIdle()).toBe(true);
  expect(container.querySelector('[aria-label="Purchase"]')?.closest('[aria-label="Listings"]')).not.toBeNull();
  await select(0); await select(1);
  const bar = container.querySelector('[aria-label="Purchase"]')!;
  expect(purchaseIdle()).toBe(false);
  expect(bar.querySelector("strong")?.textContent).toBe("2 listings · 3 PCASH");
  expect(bar.textContent).toContain("incl. gas");
  expect(bar.textContent).toContain("Your Ethereum address, the price and the amount are public.");
  expect(bar.querySelector("details")?.open).toBe(false);
  expect(bar.querySelector('[aria-label="Purchase totals"]')?.textContent).toContain("Website fee");
  expect(bar.textContent).not.toContain("Open fee");
  await select(0); await select(1);
  expect(container.querySelector('[aria-label="Purchase"]')).toBe(bar);
  expect(purchaseIdle()).toBe(true);
  expect(bar.querySelector('[aria-label="Purchase totals"]')).toBeNull();
});

it("refreshes an accepted claim through finality", async () => {
  vi.useFakeTimers(); ready();
  const activity = { key: "buyer:1", role: "buyer", phase: "claim-accepted", status: "pending", publication, contentHash: "0xclaim" };
  mocks.refresh.mockResolvedValue({ localOffers: [{ pub: publication, activity }], catalogOffers: [] });
  await render(offerPath);
  expect(container.textContent).toContain("Payment confirmed · Receiving PCASH");
  mocks.refresh.mockResolvedValue({ localOffers: [{ pub: publication, activity: { ...activity, phase: "claimed", status: "complete" } }], catalogOffers: [] });
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(container.textContent).toContain("Purchase complete");
  expect(mocks.buyMany).not.toHaveBeenCalled();
  expect(mocks.buy).not.toHaveBeenCalled();
});

describe("token listings", () => {
  const definition = testDefinition("Harbor Credit", "HBR", 2);
  const assetId = assetDefinitionAssetId(definition);
  const tokenPublication = { ...publication, assetDefinition: toHex(encodeAssetDefinition(definition)),
    terms: { ...publication.terms, id: "7", assetId: assetId.toString(), amount: "250", ethPriceWei: "1000000000000000" },
    l2Contract: { bodyHex: `0x${"56".repeat(20)}` } };
  // Another token's definition under this listing's token ID: readable, but it does not derive the ID.
  const forged = { ...tokenPublication, assetDefinition: toHex(encodeAssetDefinition(testDefinition("Harbor Credit Official", "HBR", 2))),
    terms: { ...tokenPublication.terms, id: "8" }, l2Contract: { bodyHex: `0x${"78".repeat(20)}` } };
  const choose = async (label: string, value: string) => {
    const select = [...container.querySelectorAll("label")].find((node) => node.textContent?.startsWith(label))!.querySelector("select")!;
    await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
  };

  it("lists every token by default and narrows them to the tokens checked in the dropdown", async () => {
    mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [publication, tokenPublication] });
    await render("/marketplace");
    const table = () => container.querySelector('[aria-label="Available listings"]')!;
    const rows = () => container.querySelectorAll("[data-listing-select]");
    expect(rows()).toHaveLength(2);
    expect(table().textContent).toContain("1 PCASH");
    expect(table().textContent).toContain("2.5 HBR");
    // 0.001 ETH for 2.5 tokens: 0.0004 ETH per token.
    expect(table().textContent).toContain("0.0004 ETH / HBR");
    expect(tokenTrigger().textContent).toContain("All tokens");
    await toggleTokens();
    expect(tokenOptions()).toEqual(["All tokens", "PCASH", "HBR"]);
    // The search finds a token by its symbol or name.
    await search("harbor");
    expect(tokenOptions()).toEqual(["HBR"]);
    await search("nothing listed");
    expect(tokenOptions()).toEqual([]);
    expect(tokenMenu()?.textContent).toContain("No listed token matches “nothing listed”.");
    await search("hb");
    await checkToken("HBR");
    expect(rows()).toHaveLength(1);
    expect(table().textContent).toContain("2.5 HBR");
    expect(tokenTrigger().textContent).toContain("HBR");
    expect(container.querySelector<HTMLAnchorElement>('a[href^="/token/"]')?.getAttribute("href")).toBe(`${tokenPath(assetId)}#d=${formatAssetDefinition(definition)}`);
    // Checking a second token adds its listings.
    await search("");
    await checkToken("PCASH");
    expect(rows()).toHaveLength(2);
    expect(tokenTrigger().textContent).toContain("PCASH, HBR");
    await click("Show all");
    expect(rows()).toHaveLength(2);
    expect(tokenTrigger().textContent).toContain("All tokens");
    await act(async () => tokenMenu()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(tokenMenu()).toBeNull();
    expect(document.activeElement).toBe(tokenTrigger());
    ready(); await rerender();
    // Best value groups by asset: PCASH first, then the token.
    await select(1);
    // One purchase buys one asset.
    expect(container.querySelector<HTMLInputElement>("[data-listing-select]")?.disabled).toBe(true);
    await toggleTokens();
    await checkToken("PCASH");
    expect(container.textContent).toContain("One asset per purchase: you have HBR selected");
    // Selection survives filtering, so Buy takes what the bar shows.
    expect(container.querySelector('[aria-label="Purchase"] strong')?.textContent).toBe("1 listing · 2.5 HBR");
    // A click outside closes the dropdown.
    await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(tokenMenu()).toBeNull();
    await click("Buy");
    expect(mocks.buyMany).toHaveBeenCalledWith([tokenPublication], expect.objectContaining({ assertActive: expect.any(Function) }));
  });

  it("hides a token listing whose definition does not derive its token ID and never shows its claimed name", async () => {
    mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [publication, forged] });
    await render("/marketplace");
    expect(container.textContent).toContain("1 listing is hidden because its token definition does not match the token ID.");
    expect(container.textContent).not.toContain("Harbor Credit Official");
    await toggleTokens();
    expect(tokenOptions()).toEqual(["All tokens", "PCASH"]);
    await search("official");
    expect(tokenOptions()).toEqual([]);
  });

  it("shows an opened unverifiable token listing as unverified", async () => {
    mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [forged] });
    await render(`/marketplace?offer=${forged.l2Contract.bodyHex}`);
    expect(container.querySelector('[aria-label="Listing details"]')?.textContent).toContain("Unverified token");
    expect(container.textContent).not.toContain("Harbor Credit Official");
    expect(container.textContent).not.toContain("✓ Verified");
  });

  it("reviews a token listing in its own units", async () => {
    mocks.refresh.mockResolvedValue({ localOffers: [], catalogOffers: [tokenPublication] });
    ready();
    await render(`/marketplace?offer=${tokenPublication.l2Contract.bodyHex}`);
    expect(container.textContent).toContain("Buy HBR");
    const rows = Object.fromEntries([...container.querySelectorAll("dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent]));
    expect(rows["You receive"]).toBe("2.5 HBR");
    expect(container.textContent).toContain("No relayer fee.");
    expect(container.querySelector('[aria-label="Listing details"]')?.textContent).toContain("HBR Harbor Credit✓ Verified");
  });

  it("lists a token the wallet holds with its definition and amount in base units", async () => {
    ready();
    Object.assign(mocks.wallet, { snapshot: { assets: [{ assetId, definition, private: 1_000n, spendable: 1_000n, created: true }] } });
    try {
      await render(); await openListing();
      await choose("What to sell", assetId.toString());
      expect(container.textContent).toContain("List your HBR");
      await fill("HBR amount", "10.01");
      expect(container.textContent).toContain("You have 10 HBR available to list.");
      await fill("HBR amount", "1.5");
      await fill("Total price in ETH", "0.1");
      await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ assetId, assetDefinition: encodeAssetDefinition(definition), amount: 150n }), expect.anything());
    } finally {
      delete (mocks.wallet as { snapshot?: unknown }).snapshot;
    }
  });
});


it("retries restoration on later syncs at the same tip without looping on its own sync", async () => {
  ready();
  let completed!: (event: { syncedThrough: { pcashHash: string } }) => void;
  mocks.wallet.wallet = { on: (_name: string, callback: typeof completed) => { completed = callback; return async () => {}; } };
  await render();
  const before = mocks.refresh.mock.calls.length;
  const event = { syncedThrough: { pcashHash: "0xtip" } };
  mocks.refresh.mockImplementation(async () => {
    await Promise.resolve();
    completed(event);
    return { localOffers: [], catalogOffers: [], recoveryErrors: ["Payment discovery: RPC unavailable"] };
  });
  await act(async () => completed(event));
  expect(mocks.refresh).toHaveBeenCalledTimes(before + 1);
  expect(container.textContent).toContain("Payment discovery: RPC unavailable");
  await act(async () => completed(event));
  expect(mocks.refresh).toHaveBeenCalledTimes(before + 2);
});

it("offers contract recovery for restored funding without requiring a catalog or funding again", async () => {
  ready(); settings.setDefaultSubmissionMode("slow");
  mocks.wallet.funds = { spendablePrivate: 10n * 10n ** 18n };
  const expired = { ...publication, terms: { ...publication.terms, amount: (1n * 10n ** 18n).toString(), deadlineT: "1" } };
  mocks.refresh.mockResolvedValue({ catalogOffers: [], catalogError: "Catalog offline", localOffers: [{ key: "offer", pub: expired, activity: {
    key: "seller", offerKey: "offer", role: "seller", phase: "contract-missing", status: "action-required", publication: expired,
  } }] });
  mocks.restoreContract.mockResolvedValue("0xcreation");
  await render(offerPath);
  expect(container.querySelector('[aria-label="Trade PCASH"] input[type="radio"]')).toBeNull();
  expect(container.textContent).not.toContain("Relayer fee");
  await click("Recover escrow contract");
  expect(mocks.restoreContract).toHaveBeenCalledWith(expired, 0n, expect.objectContaining({ submission: expect.objectContaining({ mode: "l1" }) }));
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.resume).not.toHaveBeenCalled();
  expect(mocks.reclaim).not.toHaveBeenCalled();
});
