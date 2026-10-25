import assert from "node:assert/strict";
import { buildWebsite, stageWebsite } from "../fixtures.mjs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getWallet, launch, MetaMaskWallet, type Dappwright } from "@tenkeylabs/dappwright";
import { test as base, expect, type BrowserContext } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";
import { decodeBatch, decodeTransaction, TX_KIND_PRIVATE_VALUE } from "@pcash/sdk/protocol";
import { ANVIL_ACCOUNTS } from "../../src/backends/anvil.ts";
import { controlsSystemPayout, fromHex, privateKeyPcashActionSigner, requestPcashProfile } from "../../src/deps.ts";
import { l1Rpc } from "../../src/backends/rpc.ts";
import { ScenarioFixture } from "../../src/fixture/scenarioFixture.ts";
import { leasePorts } from "../../src/framework/ports.ts";
import { startStaticHost } from "../static_host.mjs";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const LOCAL_CHAIN_ID = 31_337;
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

const test = base.extend<{ wallet: Dappwright }, { walletContext: BrowserContext }>({
  walletContext: [
    async ({}, use) => {
      const { wallet, browserContext } = await launch("", {
        wallet: "metamask",
        version: MetaMaskWallet.recommendedVersion,
      });
      let failure: unknown;
      try {
        // Keep public portfolio data out of the local wallet fixture while
        // allowing MetaMask's transaction services and the local stack.
        await browserContext.route(/^https?:\/\//, (route) => {
          const { hostname } = new URL(route.request().url());
          return ["127.0.0.1", "localhost", "authentication.api.cx.metamask.io",
            "gas.api.cx.metamask.io", "tx-sentinel-ethereum-mainnet.api.cx.metamask.io"].includes(hostname)
            ? route.continue()
            : route.abort();
        });
        await wallet.setup({ seed: ANVIL_MNEMONIC });
        await use(browserContext);
      } catch (cause) {
        failure = cause;
        throw cause;
      } finally {
        await browserContext.close().catch((closeError: unknown) => {
          if (failure === undefined) throw closeError;
        });
      }
    },
    { scope: "worker" },
  ],
  context: async ({ walletContext }, use) => {
    await use(walletContext);
  },
  wallet: async ({ walletContext }, use) => {
    await use(await getWallet("metamask", walletContext));
  },
});

interface L1Transaction {
  input: string;
  from: string;
  to: string;
}

test("registers with zero PCASH, mines without payment signatures, and displays its native note", async ({
  context,
  wallet,
}, testInfo) => {
  let fixture: ScenarioFixture | undefined;
  let site: Awaited<ReturnType<typeof startStaticHost>> | undefined;
  let siteLease: Awaited<ReturnType<typeof leasePorts>> | undefined;
  let failure: unknown;

  try {
    // The node advertises the browser prover assets the site will serve.
    siteLease = await leasePorts(1);
    const sitePort = siteLease.ports[0]!;
    const proverManifest = join(root, "assets/browser-prover-release.json");
    process.env.PCASH_PROVER_ASSETS_BASE_URL = `http://127.0.0.1:${sitePort}/`;
    process.env.PCASH_PROVER_ASSETS_MANIFEST = proverManifest;
    // MetaMask's network entry pins the default Anvil chain, whatever the shell configures.
    const { PCASH_E2E_ANVIL_CHAIN_ID: _anvilChainId, ...fixtureEnv } = process.env;
    fixture = await ScenarioFixture.create({
      name: "web-metamask-activation",
      env: fixtureEnv,
      nodeCount: 1,
      artifactsRoot: testInfo.outputPath("pcash-fixture"),
    });
    assert.equal(fixture.nodeCount, 1);
    assert.equal(fixture.nodeA, fixture.nodeB);
    assert.equal(fixture.backend.chainId, BigInt(LOCAL_CHAIN_ID));

    const account = privateKeyToAccount(ANVIL_ACCOUNTS.S);
    assert.equal((await fixture.nodeA.client.status()).issuedSoFar, 0n);
    assert.equal(await fixture.nodeA.client.getAccount(account.address), null);
    context.setDefaultTimeout(10 * 60_000);

    const status = await fixture.nodeA.client.status();
    const buildEnv = {
      ...process.env,
      PCASH_REQUIRE_PROVER_ASSETS: "1",
      PCASH_RPC_URL: fixture.nodeA.rpcUrl,
      PCASH_CHAIN_ID: fixture.network.pcashChainId.toString(),
      PCASH_BROWSER_L1_RPC_URLS: fixture.backend.rpcUrl,
      PCASH_L1_CHAIN_ID: fixture.network.l1ChainId.toString(),
      PCASH_PAYMENT_ROUTER_ADDRESS: `0x${"12".repeat(20)}`,
      PCASH_PAYMENT_ROUTER_FEE_RECIPIENT: `0x${"34".repeat(20)}`,
      PCASH_PAYMENT_ROUTER_FEE_BPS: "500",
    };
    const website = buildWebsite(testInfo, buildEnv);
    stageWebsite(website, fixture.binaries.toolRoot);
    await siteLease.release();
    site = await startStaticHost({ root: website, port: sitePort });
    // Wait for the asynchronous save before dismissing the network form.
    const extension = wallet.page;
    await extension.getByTestId("sort-by-networks").click();
    await extension.getByRole("tab", { name: "Custom", exact: true }).click();
    await extension.getByRole("button", { name: "Add custom network", exact: true }).click();
    await extension.getByTestId("network-form-network-name").fill("PCASH Anvil");
    await extension.getByTestId("test-add-rpc-drop-down").click();
    await extension.getByRole("button", { name: "Add RPC URL", exact: true }).click();
    await extension.getByTestId("rpc-url-input-test").fill(fixture.backend.rpcUrl);
    await extension.getByRole("button", { name: "Add URL", exact: true }).click();
    await extension.getByTestId("network-form-chain-id").fill(fixture.network.l1ChainId.toString());
    await extension.getByTestId("network-form-ticker-input").fill("ETH");
    await extension.getByRole("button", { name: "Save", exact: true }).click();
    await expect(extension.getByTestId("network-form-network-name")).not.toBeVisible();
    const closeNetwork = extension.getByTestId("modal-header-close-button");
    if (await closeNetwork.isVisible()) await closeNetwork.click();
    await wallet.switchNetwork("PCASH Anvil");

    const page = await context.newPage();
    await page.goto(`${site.url}/#wallet`);
    const connect = page.getByTestId("wallet-panel").getByRole("button", { name: "Connect wallet", exact: true });
    await expect(connect).toBeVisible();
    // The journey keeps name lookups off so it never reaches naming services.
    await page.getByTestId("wallet-panel").getByRole("checkbox", { name: "Show ENS names", exact: true }).uncheck();
    await connect.click();
    // RainbowKit's modal lists the discovered wallets; pick the first.
    const walletOption = page.locator('[data-testid^="rk-wallet-option-"]').first();
    await expect(walletOption).toBeVisible();
    // Connection immediately asks for the key signature in the same popup.
    // Listen before opening it and handle both approvals without waiting for
    // the connection popup to close between them.
    await Promise.all([wallet.signin(), walletOption.click()]);

    const setup = page.getByRole("button", { name: "Set up and mine", exact: true });
    await expect(setup).toBeVisible();
    await setup.click();
    await wallet.confirmTransaction();
    await expect.poll(async () => (await fixture!.nodeA.client.getAccount(account.address))?.address.toLowerCase(), {
      message: "the node to derive the account registration", timeout: 5 * 60_000, intervals: [500, 1_000, 2_000],
    }).toBe(account.address.toLowerCase());
    assert.ok((await fixture.nodeA.client.status()).issuedSoFar > 0n, "setup mining issues PCASH in the registration batch");
    // Account history is served by the derived index, which may lag canonical state.
    const registrationRecord = async () => (await fixture!.nodeA.client.getAccountHistory({ address: account.address, limit: 10 }))
      .items.find((item) => item.kind === "userAccountCreation");
    await expect.poll(registrationRecord, {
      message: "the index to record the account registration", timeout: 60_000, intervals: [500, 1_000, 2_000],
    }).toBeDefined();
    const registration = await registrationRecord();
    assert.ok(registration);
    const transaction = await l1Rpc<L1Transaction>(fixture.backend.rpcUrl, "eth_getTransactionByHash", [registration.inclusion.l1TransactionHash]);
    assert.equal(transaction.from.toLowerCase(), account.address.toLowerCase());
    assert.equal(transaction.to.toLowerCase(), status.inboxAddress.toLowerCase());
    await expect(page.getByTestId("wallet-sidebar-balance")).toContainText("PCASH", { timeout: 5 * 60_000 });
    const miningHistory = page.locator('[data-activity-kind="mined"]');
    await expect(miningHistory).toHaveCount(1, { timeout: 5 * 60_000 });
    await expect(miningHistory).toContainText("Mined");
    await expect(miningHistory).not.toContainText("Sent 0");
    const previousBalance = await page.getByTestId("wallet-sidebar-balance").textContent();
    await page.getByTestId("wallet-panel").getByRole("link", { name: "Get PCASH", exact: true }).click();
    await expect(page).toHaveURL(/\/get$/);
    await expect(page.getByTestId("wallet-panel")).not.toBeVisible();
    await expect(page.getByTestId("mining-estimate")).toContainText("PCASH");
    const current = await fixture.nodeA.client.status();
    const quote = await fixture.nodeA.client.getIssuanceQuote(current.latestBlockTimestamp);
    assert.ok(quote);
    assert.equal(quote.rewardPossible, true);
    const start = page.getByTestId("mining-start");
    const count = 3;
    await page.getByLabel("Transactions to mine", { exact: true }).fill(String(count));
    const nonceBefore: bigint = BigInt(await l1Rpc<string>(fixture.backend.rpcUrl, "eth_getTransactionCount", [account.address, "latest"]));
    await expect(start).toBeEnabled({ timeout: 2 * 60_000 });
    const issued = (await fixture.nodeA.client.status()).issuedSoFar;
    await start.click();
    await wallet.confirmTransaction();
    await expect.poll(async () => (await fixture!.nodeA.client.status()).issuedSoFar, {
      message: "one click to publish a mining transaction and issue native PCASH", timeout: 10 * 60_000, intervals: [500, 1_000, 2_000],
    }).toBeGreaterThan(issued);
    await expect(page.getByTestId("mining-result")).toContainText("Batch included", { timeout: 5 * 60_000 });
    const batchLink = await page.getByTestId("mining-result").getByRole("link", { name: "View PCASH batch", exact: true }).getAttribute("href");
    assert.ok(batchLink);
    const batchHash = batchLink.slice("/batch/".length);
    const published: L1Transaction = await l1Rpc<L1Transaction>(fixture.backend.rpcUrl, "eth_getTransactionByHash", [batchHash]);
    const entries: readonly Uint8Array[] = decodeBatch(fromHex(published.input)).items;
    assert.equal(entries.length, count, "one Ethereum batch contains every requested mine");
    assert.ok(entries.every(entry => decodeTransaction(entry).kind === TX_KIND_PRIVATE_VALUE));
    assert.equal(BigInt(await l1Rpc<string>(fixture.backend.rpcUrl, "eth_getTransactionCount", [account.address, "latest"])), nonceBefore + 1n, "one mining click spends one Ethereum nonce");
    await page.getByTestId("wallet-trigger").click();
    const balance = page.getByTestId("wallet-sidebar-balance");
    await expect(balance).toContainText("PCASH");
    await expect.poll(async () => balance.textContent(), {
      message: "the recovered wallet balance to increase after mining", timeout: 5 * 60_000,
    }).not.toBe(previousBalance);
    await page.getByTestId("wallet-panel").getByRole("button", { name: "Close wallet", exact: true }).click();
    // The browser published its own action, which named its own commitment for the issuance.
    const profile = await requestPcashProfile(privateKeyPcashActionSigner(fromHex(ANVIL_ACCOUNTS.S)), fixture.network);
    const payouts = await fixture.nodeA.client.getPayouts();
    assert.ok(payouts.records.some((record) => record.source.kind === "designatedIssuance"
      && record.component === "issuance" && record.amount > 0n && controlsSystemPayout(profile, record)));
  } catch (cause) {
    failure = cause;
    throw cause;
  } finally {
    await site?.close().catch(() => undefined);
    await siteLease?.release().catch(() => undefined);
    await fixture?.finish(failure);
  }
});
