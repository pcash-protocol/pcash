import assert from "node:assert/strict";
import { join } from "node:path";
import { leasePorts } from "../../src/framework/ports.ts";
import { logger } from "../../src/framework/logger.ts";
import { e2eSettings } from "../../src/settings.ts";
import { fileURLToPath } from "node:url";
import { setupPaymentRouter, LOCAL_PAYMENT_ROUTER_CONFIG, LOCAL_PAYMENT_ROUTER_KEY } from "@pcash/marketplace/tooling/paymentRouterSetup";
import { ScenarioFixture } from "../../src/fixture/scenarioFixture.ts";
import { setupUserWallets } from "../../src/scenarios/setup.ts";
import { l1Rpc, validPrivateKey } from "../../src/backends/rpc.ts";
import { ANVIL_ACCOUNTS } from "../../src/backends/anvil.ts";
import { setupAnvilMulticall3 } from "../../../scripts/dev/multicall3.mjs";
import { test, buildWebsite, stageWebsite } from "../fixtures.mjs";
import { readJourneyIssuanceQuote } from "./marketplace_issuance.mjs";
import { marketplaceTrade, wholePcash } from "./marketplace_trade.mjs";

test("publishes listings and buys their inventory through the marketplace", async ({ journey }, testInfo) => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const settings = e2eSettings();
  const actors = [];
  let fixture;
  let site;
  let siteLease;
  let failure;

  async function actorBrowser(actor) {
    const entry = await journey.actor({ actor, network: fixture.network, l1RpcUrl: fixture.backend.rpcUrl });
    actors.push(entry);
    const { browser } = entry;
    await browser.navigate(`${site.url}/marketplace`);
    await browser.waitFor(`[...document.querySelectorAll("button")].some(b => b.textContent === "Create listing")`);
    await browser.connectWallet();
    await browser.waitFor(`document.querySelector('[data-testid="wallet-trigger"][data-wallet-phase="ready"]') !== null`, {
      description: "registered marketplace wallet is ready", timeoutMs: 120_000,
    });
    await browser.evaluate(`document.querySelector('button[aria-label="Close wallet"]').click()`);
    assert.equal(await browser.evaluate("location.pathname"), "/marketplace", "wallet setup stays in the trade flow");
    return entry;
  }

  try {
    siteLease = await leasePorts(1);
    const sitePort = siteLease.ports[0];
    process.env.PCASH_PROVER_ASSETS_BASE_URL = `http://127.0.0.1:${sitePort}/`;
    const proverManifest = join(root, "assets/browser-prover-release.json");
    process.env.PCASH_PROVER_ASSETS_MANIFEST = proverManifest;
    fixture = await ScenarioFixture.create({ name: "marketplace-browser-funded", env: process.env, keepArtifacts: true, artifactsRoot: testInfo.outputPath("node"),
      nodeCount: 1,
      // Browser wallets pay their own Ethereum gas, so both actors are funded Anvil accounts.
      actorKeys: {
        S: settings.str("actor-1-key")?.trim() ? validPrivateKey(settings.str("actor-1-key"), "PCASH_E2E_ACTOR_1_KEY") : ANVIL_ACCOUNTS.S,
        R: settings.str("actor-2-key")?.trim() ? validPrivateKey(settings.str("actor-2-key"), "PCASH_E2E_ACTOR_2_KEY") : ANVIL_ACCOUNTS.R,
      },
    });
    await setupAnvilMulticall3((method, params) => l1Rpc(fixture.backend.rpcUrl, method, params));
    const router = await setupPaymentRouter({ rpcUrl: fixture.backend.rpcUrl, l1ChainId: fixture.network.l1ChainId,
      cacheRoot: join(fixture.artifacts.root, "marketplace"), routerConfig: LOCAL_PAYMENT_ROUTER_CONFIG, privateKey: LOCAL_PAYMENT_ROUTER_KEY });
    await fixture.waitForNodesAtL1Head();
    const balances = await setupUserWallets(fixture, { actors: ["S", "R"], accounts: ["R"], funded: ["S"] });
    // Relayers post what waits in the mempool, as they would on a public network.
    fixture.harness.startAutoRelay();
    const initialIssuance = await readJourneyIssuanceQuote(fixture.nodeA.client);
    assert.notEqual(initialIssuance, null, "initial issuance quote is available");
    assert.ok(initialIssuance.issuedSoFar > 0n);
    const website = buildWebsite(testInfo, {
      ...process.env, PCASH_REQUIRE_PROVER_ASSETS: "1", PCASH_RPC_URL: fixture.nodeA.rpcUrl,
      PCASH_PSCAN_URL: fixture.nodeA.pscanUrl, PCASH_CHAIN_ID: fixture.network.pcashChainId.toString(),
      PCASH_L1_CHAIN_ID: fixture.network.l1ChainId.toString(), PCASH_BROWSER_L1_RPC_URLS: fixture.backend.rpcUrl,
      PCASH_PAYMENT_ROUTER_ADDRESS: router.address, PCASH_PAYMENT_ROUTER_FEE_RECIPIENT: router.routerConfig.feeRecipient,
      PCASH_PAYMENT_ROUTER_FEE_BPS: String(router.routerConfig.feeBps),
    });
    stageWebsite(website, fixture.binaries.toolRoot);
    await siteLease.release();
    site = await journey.host({ root: website, port: sitePort });
    const seller = await actorBrowser(fixture.actors.S);
    const buyer = await actorBrowser(fixture.actors.R);
    const amount = wholePcash(balances.S / 2n);
    await marketplaceTrade({ seller, buyer, amount, fixture });
    const finalIssuance = await readJourneyIssuanceQuote(fixture.nodeA.client);
    assert.notEqual(finalIssuance, null, "final issuance quote is available");
    assert.ok(finalIssuance.issuedSoFar >= initialIssuance.issuedSoFar);
    logger.info("funded marketplace browser journey passed");
  } catch (cause) {
    failure = cause;
    for (const [index, actor] of actors.entries()) {
      logger.error(`Marketplace browser ${index}:`, await actor.browser?.evaluate("document.body?.innerText").catch(() => undefined));
    }
    throw cause;
  } finally {
    let cleanupFailure;
    try { await siteLease?.release(); } catch (cause) { cleanupFailure = cause; }
    await fixture?.finish(failure ?? cleanupFailure);
    if (!failure && cleanupFailure) throw cleanupFailure;
  }
});
