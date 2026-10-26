import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSetupPanel } from "./AccountSetupPanel.tsx";

const state = vi.hoisted(() => ({ wallet: {} as Record<string, unknown>, reward: undefined as bigint | undefined, l1ChainId: 11155111 }));
vi.mock("../../lib/EthereumProvider.tsx", () => ({ useEthereumNetwork: () => ({ l1Chain: { id: state.l1ChainId, name: "Sepolia", blockExplorers: { default: { url: "https://etherscan.io" } } } }) }));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => state.wallet, fasterStandIns: async (batch: string) => [`stand-in:${batch}`] }));
// Like the real hook, a disabled read returns nothing.
vi.mock("../../lib/usePaymentIssuance.ts", () => ({ usePaymentIssuance: (enabled: boolean) => ({ issuance: enabled ? state.reward : undefined }) }));
let client: QueryClient;
const render = () => renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter><AccountSetupPanel /></MemoryRouter></QueryClientProvider>);
// Server rendering registers the cost query without running it; run it as a mounted panel would.
const loadCost = () => Promise.all(client.getQueryCache().findAll({ queryKey: ["setup-cost"] }).map((query) => query.fetch()));
const ether = 10n ** 18n;
const status = { pcashChainId: 1n };
const quoteBatch = vi.fn();

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  quoteBatch.mockReset().mockResolvedValue({ estimatedCostWei: ether / 1000n, maximumCostWei: ether / 500n });
  state.reward = 2n * ether;
  state.l1ChainId = 11155111;
  state.wallet = { phase: "activation-required", accountRecord: "absent", busy: false, syncState: { state: "idle" },
    selfPublication: { quoteBatch }, readStatus: async () => status, walletPromptOpen: false };
});

describe("account setup presentation", () => {
  it("offers recovery when an earlier submission has no Ethereum hash", () => {
    state.wallet.phase = "activation-blocked";
    state.wallet.profile = {};
    state.wallet.activationBlocker = { transactionHash: null };
    const otherHash = `0x${"ab".repeat(32)}`;
    state.wallet.activation = { l1TxHash: otherHash, validUntilTimestamp: "2000000000" };
    const html = render();
    expect(html).toContain("An earlier Ethereum submission is blocking account setup.");
    expect(html).toContain("Check status</button>");
    expect(html).toContain('href="/#ethereum-submission"');
    expect(html).not.toContain("Set up and mine</button>");
    expect(html).not.toContain(otherHash);
    expect(html).not.toContain("One Ethereum transaction publishes");
  });
  it("explains what the one setup transaction does before it starts", () => {
    const html = render();
    expect(html).toContain("Set up and mine");
    expect(html).toContain("One Ethereum transaction publishes your encryption key so people can pay you, lets you spend PCASH, and mines your first PCASH. Gas is paid in ETH.");
    expect(html).toContain("What am I approving?");
    expect(html).toContain("Your Ethereum wallet authorizes spending");
    expect(html).not.toContain("signature");
    expect(html.indexOf("Keep access to this Ethereum wallet")).toBeLessThan(html.indexOf("<button"));
    expect(html).not.toContain("Finish setup");
    expect(html).not.toContain("Approve account settings");
    expect(html).not.toContain("Discover your PCASH");
    expect(html).not.toContain("<ol");
    expect(html.match(/class="button primary"/g)).toHaveLength(1);
  });
  it("offers Sign in, not setup, while the wallet is connected but locked", () => {
    state.wallet.phase = "sign-in-required";
    state.wallet.accountRecord = "unknown";
    const html = render();
    expect(html).toContain("<h2>Sign in</h2>");
    expect(html).toContain("Sign in</button>");
    expect(html).not.toContain("Unlock");
    expect(html).toContain("About this signature");
    expect(html).not.toContain("Set up and mine");
    expect(html).not.toContain("Ethereum transaction");
    expect(html).not.toContain("disabled");
  });
  it("hides the explanation once the signature is requested", () => {
    state.wallet.phase = "signing-in";
    state.wallet.accountRecord = "unknown";
    state.wallet.busy = true;
    const html = render();
    expect(html).toContain("Approve the free signature in your wallet…");
    expect(html).toContain("Signing in…");
    expect(html).not.toContain("About this signature");
  });
  it("resumes a prepared transaction without another authorization action", () => {
    state.wallet.phase = "activation-prepared";
    state.wallet.profile = {};
    const html = render();
    expect(html).toContain("Set up and mine");
    expect(html).not.toContain("Authorize account creation</button>");
    expect(html).not.toContain("<ol");
  });
  it("checks an ambiguous submission instead of offering another send", () => {
    state.wallet.phase = "activation-ambiguous";
    const html = render();
    expect(html).toContain("Check status</button>");
    expect(html).not.toContain("Set up and mine</button>");
    expect(html).toContain("Your wallet did not return a transaction hash.");
  });
  it("keeps the active Ethereum prompt in the same card", () => {
    state.wallet.phase = "activating";
    state.wallet.setupStep = "ethereum";
    state.wallet.busy = true;
    let html = render();
    expect(html).toContain("Sending the Ethereum transaction…");
    expect(html).toContain("Setting up…");
    expect(html).not.toContain("Set up and mine</button>");
    expect(html).toContain('class="button primary" disabled=""');
    expect(html).not.toContain("What am I approving?");
    expect(html).not.toContain("Confirm in your wallet");
    state.wallet.walletPromptOpen = true;
    html = render();
    expect(html.indexOf("Confirm in your wallet")).toBeGreaterThan(html.indexOf("Setting up…</button>"));
    state.wallet.setupStep = "waiting";
    expect(render()).not.toContain("Confirm in your wallet");
  });
  it.each(["activation-required", "activation-prepared"])("previews the reward and Ethereum cost before %s setup", async (phase) => {
    state.wallet.phase = phase;
    state.reward = undefined;
    let html = render();
    expect(html).toContain("Estimated PCASH received</dt><dd>—</dd>");
    expect(html).toContain("Estimated Ethereum cost</dt><dd>—</dd>");
    state.reward = 2n * ether;
    await loadCost();
    expect(quoteBatch).toHaveBeenCalledWith({ status, transactions: ["stand-in:setup"] });
    html = render();
    const preview = html.indexOf('aria-label="Set up and mine estimate"');
    expect(preview).toBeGreaterThan(-1);
    expect(preview).toBeLessThan(html.indexOf("Set up and mine</button>"));
    expect(html).toMatch(/Estimated PCASH received<\/dt><dd>≈ <span[^>]*aria-label="2 PCASH"/);
    expect(html).toMatch(/Estimated Ethereum cost<\/dt><dd>≈ <span[^>]*aria-label="0.001 ETH"/);
  });
  it.each([
    ["while setup is working", { phase: "activation-prepared", busy: true }],
    ["for sign-in", { phase: "sign-in-required", accountRecord: "unknown" }],
  ])("hides the estimate %s", (_name, wallet) => {
    Object.assign(state.wallet, wallet, { l1Balance: 0n });
    const html = render();
    expect(html).not.toContain("Set up and mine estimate");
    expect(html).not.toContain("faucet");
  });
  it("points a Sepolia wallet short of setup's maximum gas at faucets until it has enough", async () => {
    state.wallet.l1Balance = 0n;
    let html = render();
    expect(html).toContain("Get Sepolia ETH to set up.");
    expect(html.indexOf("Get Sepolia ETH")).toBeLessThan(html.indexOf("Set up and mine</button>"));
    expect(html).toContain('<a href="https://sepolia-faucet.pk910.de/" target="_blank" rel="noreferrer">PoW faucet');
    expect(html).not.toContain("Google Cloud faucet");
    expect(html).not.toContain("cloud.google.com/application/web3/faucet");
    // Before the quote, only an empty balance is short; after it, the maximum cost decides, not the estimate.
    state.wallet.l1Balance = ether / 1000n;
    expect(render()).not.toContain("faucet");
    await loadCost();
    expect(render()).toContain("Get Sepolia ETH to set up.");
    state.wallet.l1Balance = ether / 500n;
    expect(render()).not.toContain("faucet");
  });
  it("names no faucet on a chain without one", () => {
    state.l1ChainId = 1;
    state.wallet.l1Balance = 0n;
    expect(render()).not.toContain("faucet");
  });
  it.each([["activation-mining", true], ["activation-mining", false], ["activation-pending", false]])("keeps activation status visible after submission in %s (busy: %s)", (phase, busy) => {
    state.wallet.phase = phase;
    state.wallet.busy = busy;
    state.wallet.profile = {};
    const hash = `0x${"ab".repeat(32)}`;
    state.wallet.activation = { l1TxHash: hash, validUntilTimestamp: "2000000000" };
    const html = render();
    expect(html).toContain(hash);
    expect(html).toContain(`href="https://etherscan.io/tx/${hash}"`);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(phase === "activation-pending" ? "Waiting for PCASH to process it." : "Waiting for Ethereum transaction inclusion…");
    expect(html).toContain('data-testid="activation-status"');
    expect(html).not.toContain("Set up and mine</button>");
  });
  it("switches the indicator to PCASH processing once Ethereum inclusion is known", () => {
    const hash = `0x${"ab".repeat(32)}`;
    state.wallet.phase = "activation-mining";
    state.wallet.activation = { l1TxHash: hash, validUntilTimestamp: "2000000000" };
    state.wallet.activationTransaction = { hash, state: "included" };
    expect(render()).toContain("Waiting for PCASH to process it.");
    expect(render()).not.toContain("Waiting for Ethereum transaction inclusion");
  });

  it.each([undefined, { l1TxHash: null, validUntilTimestamp: "2000000000" }])("recognizes an earlier submitted transaction with activation record %s", (activation) => {
    state.wallet.phase = "activation-blocked";
    state.wallet.profile = {};
    state.wallet.activation = activation;
    state.wallet.activationBlocker = { transactionHash: `0x${"cd".repeat(32)}` };
    expect(render()).toContain(`0x${"cd".repeat(32)}`);
    expect(render()).toContain("Check status</button>");
  });
  it("keeps synchronization visible before spending becomes available", () => {
    state.wallet.phase = "syncing";
    state.wallet.profile = {};
    expect(render()).toContain("Checking for private payments…");
    expect(render()).toContain('class="button primary" disabled=""');
  });
  it.each([["error", "Reconnect"], ["wrong-network", "Switch network"]])("keeps connection recovery available for an unlocked account in %s", (phase, label) => {
    state.wallet.phase = phase;
    state.wallet.profile = {};
    state.wallet.accountRecord = "present";
    expect(render()).toContain(`${label}</button>`);
  });
  it("shows the prover's step detail while proving setup mining", () => {
    state.wallet.phase = "activating";
    state.wallet.profile = {};
    state.wallet.progress = { phase: "proving", message: "compress chonk…", elapsedMs: 0 };
    expect(render()).toContain("compress chonk…");
  });
});

it("offers setup funded by the poster reward when the wallet has no ETH", () => {
  state.wallet.l1Balance = 0n;
  const html = render();
  expect(html).toContain("Set up without ETH");
  expect(html).toContain("A relayer receives the mining reward");
});

it("shows relayer progress for open setup without asking for an Ethereum transaction", () => {
  state.wallet.phase = "activation-pending";
  state.wallet.activation = { publication: "open", state: "mempool-submitted", contentHash: `0x${"ab".repeat(32)}`, validUntilTimestamp: "200", l1TxHash: null };
  state.wallet.status = { latestBlockTimestamp: 100n };
  const html = render();
  expect(html).toContain("Waiting for a relayer");
  expect(html).not.toContain("Review Ethereum transaction");
  expect(html).not.toContain("did not return a transaction hash");
});

it("offers an expired open setup retry without ETH", () => {
  state.wallet.phase = "activation-pending";
  state.wallet.activation = { publication: "open", state: "mempool-submitted", contentHash: `0x${"ab".repeat(32)}`, validUntilTimestamp: "200", l1TxHash: null };
  state.wallet.status = { latestBlockTimestamp: 201n };
  const html = render();
  expect(html).toContain("Retry setup without ETH");
  expect(html).not.toContain("Review Ethereum transaction");
});
