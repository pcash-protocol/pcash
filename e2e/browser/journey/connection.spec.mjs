import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { logger } from "../../src/framework/logger.ts";
import { e2eSettings } from "../../src/settings.ts";
import { test, buildWebsite, stageWebsite } from "../fixtures.mjs";
import { decodeBatch, decodeTransaction } from "@pcash/sdk/protocol";
import { fromHex } from "@pcash/sdk/utils";
import { toolRoot } from "@pcash/sdk/node/toolchain";
import {
  startControlledRpc,
  TEST_RELAY_BATCH,
  TEST_RELAY_L1_HASH,
  TEST_RELAY_CONTENT_HASH,
  TEST_RELAY_CONFLICT_CONTENT_HASH,
  TEST_RELAY_OVERSIZED_CONTENT_HASH,
  TEST_STATUS,
} from "./controlled_rpc.mjs";
import {
  DeterministicInjectedProvider,
  FIXED_ACCOUNT,
} from "./injected_provider.mjs";
import { createInjectedProviderSource, PAGE_PROVIDER_CONTROL } from "./page_provider.mjs";
import { startInjectedProviderBridge } from "./provider_bridge.mjs";

test("restores sign-ins and pending submissions across browser navigation", async ({ journey }, testInfo) => {
  const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const settings = e2eSettings();
  const onboardingScreenshots = settings.str("onboarding-screenshots");

  async function captureRelay(browser, name, width = 1440) {
    const directory = settings.str("relay-screenshots");
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.png`), await browser.screenshot({ width, height: width < 500 ? 844 : 1000 }));
  }

  async function refreshRelayLock(browser) {
    await browser.waitFor(`[...document.querySelectorAll("#ethereum-submission button")].some((button) => button.textContent.trim() === "Refresh" && !button.disabled)
      || document.body.innerText.includes("No Ethereum submission is blocking your wallet.")`, {
      description: "wallet recovery exposes Refresh or has already cleared the submission",
    });
    await browser.evaluate(`document.querySelector("#ethereum-submission button")?.click()`);
  }

  function requestMethods(provider, offset) {
    return provider.requestLog.slice(offset).map(({ method }) => method);
  }

  function assertDerivationRequest(provider, offset) {
    const requests = provider.requestLog.slice(offset, offset + 3);
    assert.deepEqual(requests.map(({ method }) => method), [
      "eth_chainId",
      "eth_accounts",
      "eth_signTypedData_v4",
    ]);
    const params = requests[2]?.params;
    assert.ok(Array.isArray(params));
    assert.equal(params[0].toLowerCase(), FIXED_ACCOUNT.toLowerCase());
    const typedData = JSON.parse(params[1]);
    assert.deepEqual(typedData.domain, {
      name: "PCASH",
      version: "1",
      chainId: BigInt(TEST_STATUS.l1ChainId).toString(),
      verifyingContract: TEST_STATUS.inboxAddress,
    });
    assert.deepEqual(typedData.message, {
      pcashChainId: BigInt(TEST_STATUS.pcashChainId).toString(),
      account: FIXED_ACCOUNT.toLowerCase(),
      context: "pcash-profile",
    });
  }

  async function disconnectWallet(browser) {
    if (!await browser.evaluate(`[...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Disconnect")`)) {
      await browser.evaluate(`document.querySelector('[data-testid="wallet-trigger"]').click()`);
    }
    await browser.clickButton("Disconnect");
  }

  async function waitForSubmittedAccount(browser) {
    await browser.openWallet();
    await browser.waitFor(`document.querySelector('[data-testid="wallet-trigger"][data-wallet-busy="false"]') !== null
      && document.querySelector('[data-testid="activation-status"]') !== null`, {
      description: "the submitted account keeps activation status visible in the sidebar",
      timeoutMs: 120_000,
    });
    assert.equal(await browser.evaluate(`document.querySelector('[data-testid="wallet-trigger"]').textContent.trim().toLowerCase()`), `${FIXED_ACCOUNT.slice(0, 6)}…${FIXED_ACCOUNT.slice(-4)}▾`.toLowerCase());
    assert.equal(await browser.evaluate(`document.querySelector('[aria-label="Receive address"] [title]').getAttribute("title").toLowerCase()`), FIXED_ACCOUNT.toLowerCase());
    assert.equal(await browser.evaluate(`document.querySelector('[aria-label="Receive address"] button').disabled`), false);
    await browser.evaluate(`(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value) => { window.copiedReceiveAddress = value; } } });
      document.querySelector('[aria-label="Receive address"] button').click();
    })()`);
    assert.equal(await browser.evaluate(`window.copiedReceiveAddress.toLowerCase()`), FIXED_ACCOUNT.toLowerCase());
    assert.equal(await browser.evaluate(`[...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Check status")`), true);
    assert.equal(await browser.evaluate(`document.querySelector('#send')`), null, "spending still waits for account confirmation");
  }

  async function waitForDisconnected(browser) {
    await browser.waitFor(`document.querySelector("#send") === null
      && document.querySelector('[data-testid="wallet-trigger"][data-wallet-busy="false"]') !== null
      && [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Connect wallet" && !button.disabled)`, {
      description: "the disconnected account view",
    });
  }

  async function waitForSetup(browser) {
    await browser.waitFor(`document.querySelector('[data-testid="wallet-panel"][open]') !== null
      && document.querySelector("#send") === null
      && [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Set up and mine" && !button.disabled)`, {
      description: "connection opens account setup in the sidebar",
    });
  }

  let rpc;
  let bridge;
  let site;
  let browser;
  let provider;
  let l1TransactionHash = `0x${"ab".repeat(32)}`;
  let failReceiptOnBroadcast = false;
  let releaseReceipts;

  try {
    rpc = await startControlledRpc({ emptyMempool: true });
    provider = new DeterministicInjectedProvider({
      chainId: BigInt(TEST_STATUS.l1ChainId),
      l1GenesisBlockNumber: TEST_STATUS.genesisL1Block,
      l1GenesisBlockHash: TEST_STATUS.genesisL1BlockHash,
      broadcastTransaction: async (transaction) => {
        if (failReceiptOnBroadcast) rpc.setReceiptFailure("Receipt lookup unavailable after broadcast");
        return rpc.recordTransaction(l1TransactionHash, transaction);
      },
    });
    bridge = await startInjectedProviderBridge(provider);
    const env = {
      ...process.env,
      PCASH_REQUIRE_PROVER_ASSETS: "1",
      PCASH_RPC_URL: rpc.url,
      PCASH_GENESIS_HASH: TEST_STATUS.genesisHash,
      PCASH_CHAIN_ID: TEST_STATUS.pcashChainId,
      PCASH_L1_CHAIN_ID: BigInt(TEST_STATUS.l1ChainId).toString(),
      PCASH_BROWSER_L1_RPC_URLS: rpc.url,
      PCASH_PAYMENT_ROUTER_ADDRESS: `0x${"12".repeat(20)}`,
      PCASH_PAYMENT_ROUTER_FEE_RECIPIENT: `0x${"34".repeat(20)}`,
      PCASH_PAYMENT_ROUTER_FEE_BPS: "500",
    };
    const website = buildWebsite(testInfo, env);
    await build({
      configFile: false,
      logLevel: "warn",
      worker: { format: "es" },
      build: {
        emptyOutDir: true,
        lib: {
          entry: join(root, "e2e", "browser", "journey", "wallet_database_probe.ts"),
          fileName: "index",
          formats: ["es"],
        },
        outDir: join(website, "wallet-database-probe"),
        target: "es2022",
      },
    });
    const databaseRuntimeAssets = readdirSync(website, { recursive: true })
      .filter((name) => /pglite|initdb/i.test(String(name)));
    assert.deepEqual(databaseRuntimeAssets, [], "production browser bundle contains the Node PGlite runtime");
    stageWebsite(website, toolRoot(), { versioned: false });
    site = await journey.host({ root: website });
    const release = JSON.parse(readFileSync(join(root, "assets/browser-prover-release.json"), "utf8"));
    rpc.setProverAssets({ assetSetId: release.assetSetId, baseUrl: `${site.url}/` });
    const routeContract = JSON.parse(readFileSync(join(website, "route-manifest.json"), "utf8"));
    const relayRoute = routeContract.routes.find(({ id }) => id === "get");
    if (relayRoute === undefined) throw new Error("production route contract has no Get PCASH route");

    browser = await journey.browser();
    await browser.addInitScript(`Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 1 });`);
    await browser.addInitScript(createInjectedProviderSource({ bridgeUrl: bridge.url }));
    await browser.navigate(site.url);
    await waitForDisconnected(browser);
    assert.equal(await browser.evaluate("globalThis.crossOriginIsolated"), true);
    assert.equal(await browser.evaluate(`new Promise((resolve, reject) => {
      const opening = indexedDB.open("pcash-wallet-strict-durability-probe", 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore("probe");
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        const transaction = database.transaction("probe", "readwrite", { durability: "strict" });
        const durability = transaction.durability;
        transaction.objectStore("probe").put("value", "key");
        transaction.oncomplete = () => { database.close(); resolve(durability); };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      };
    })`), "strict");

    const probeUrl = `${site.url}/wallet-database-probe/index.js`;
    const probeName = `pcash-wallet-engine-reopen-${Date.now()}`;
    const seeded = await browser.evaluate(`import(${JSON.stringify(probeUrl)})
      .then((probe) => probe.seedWalletCursor(${JSON.stringify(probeName)}, ${JSON.stringify(rpc.url)}))`);
    assert.deepEqual(seeded, { syncedThrough: "0" });
    rpc.clearRequests();
    rpc.advanceToBlock1();
    const resumed = await browser.evaluate(`import(${JSON.stringify(probeUrl)})
      .then((probe) => probe.reopenAndSyncWallet(${JSON.stringify(probeName)}, ${JSON.stringify(rpc.url)}))`);
    assert.deepEqual(resumed, { before: "0", after: "1" });
    const resumedScans = rpc.requests.filter(({ method }) => method === "pcash_getOutputs");
    assert.equal(resumedScans.length, 1);
    assert.equal(resumedScans[0].params[0].fromOutputIndex, "0x0");
    assert.deepEqual(resumedScans[0].params[0].target, rpc.blockBoundary(1));
    rpc.clearRequests();

    // Connecting asks for the key signature at once; declining it leaves the wallet connected and locked.
    const sameChainOffset = provider.requestLog.length;
    provider.rejectNext("eth_signTypedData_v4");
    await browser.connectWallet();
    await browser.waitFor(`document.querySelector('[data-testid="account-setup"] [role="alert"]')?.textContent?.includes("You rejected the request in your wallet.")
      && [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Sign in" && !button.disabled)`, {
      description: "a declined connection signature leaves Sign in retryable",
    });
    assert.equal(rpc.requests.some(({ method }) => method === "pcash_getAccountChanges"), false, "connecting does not read accounts before sign-in");
    const sameChainMethods = requestMethods(provider, sameChainOffset);
    assert.ok(sameChainMethods.includes("eth_requestAccounts"));
    assert.ok(sameChainMethods.includes("eth_chainId"));
    assert.ok(sameChainMethods.includes("eth_accounts"));
    assert.equal(sameChainMethods.filter((method) => method === "eth_signTypedData_v4").length, 1, "connecting asks for the key signature once");

    const derivationOffset = provider.requestLog.length;
    // Sign-in synchronizes the wallet, so a failed output read stops it before setup is offered.
    rpc.setOutputFailure("Journey output discovery unavailable");
    await browser.clickButton("Sign in");
    await browser.waitFor(`document.body.textContent.includes("Journey output discovery unavailable")
      && [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Reconnect" && !button.disabled)`, {
      description: "a failed output read stops sign-in with a reconnect action",
      timeoutMs: 120_000,
    });
    assertDerivationRequest(provider, derivationOffset);
    assert.equal(requestMethods(provider, derivationOffset).includes("eth_sendTransaction"), false, "setup does not reach Ethereum without synchronized outputs");
    assert.ok(rpc.requests.some(({ method }) => method === "pcash_getAccountChanges"), "sign-in replays account changes");
    rpc.setOutputFailure(undefined);
    await browser.clickButton("Reconnect");
    await waitForSetup(browser);
    if (onboardingScreenshots) {
      const directory = onboardingScreenshots;
      mkdirSync(directory, { recursive: true });
      for (const [name, width] of [["setup-desktop", 1440], ["setup-mobile", 390]]) {
        writeFileSync(join(directory, `${name}.png`), await browser.screenshot({ width, height: width < 500 ? 844 : 1000 }));
      }
      await browser.screenshot({ width: 1440, height: 1000 });
    }
    const setupOffset = provider.requestLog.length;
    provider.rejectNext("eth_sendTransaction");
    await browser.clickButton("Set up and mine");
    await browser.waitFor(`[...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Set up and mine" && !button.disabled)
      && document.body.textContent.includes("You rejected the request in your wallet.")`, {
      description: "one setup action reaches the Ethereum prompt and preserves a declined transaction",
      timeoutMs: 600_000,
    });
    const setupSignatures = provider.requestLog.slice(setupOffset)
      .filter(({ method }) => method === "eth_signTypedData_v4")
      .map(({ params }) => JSON.parse(params[1]).primaryType);
    assert.deepEqual(setupSignatures, [], "setup mining reuses the key signature without requesting payment authorization");
    assert.equal(requestMethods(provider, setupOffset).filter((method) => method === "eth_sendTransaction").length, 1);
    assert.equal(provider.sentTransactions.length, 0);
    assert.equal(new URL(await browser.evaluate("location.href")).pathname, "/");

    const preparedContentHash = await browser.evaluate(`[...document.querySelectorAll("dt")]
      .find((element) => element.textContent?.trim() === "PCASH transaction")?.nextElementSibling?.querySelector("code")?.textContent`);
    assert.match(preparedContentHash, /^0x[0-9a-fA-F]{64}$/);
    await disconnectWallet(browser);
    await waitForDisconnected(browser);
    assert.equal(await browser.evaluate("location.pathname.toLowerCase()"), "/", "disconnect keeps the current page in place");
    assert.equal(provider.sentTransactions.length, 0);
    await browser.connectWallet();
    await waitForSetup(browser);
    const preparedResumeOffset = provider.requestLog.length;
    provider.rejectNext("eth_sendTransaction");
    await browser.clickButton("Set up and mine");
    await browser.waitFor(`[...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Set up and mine" && !button.disabled)
      && document.body.textContent.includes("You rejected the request in your wallet.")`, {
      description: "reconnecting resumes the durable prepared activation",
      timeoutMs: 120_000,
    });
    assert.equal(await browser.evaluate(`document.body.textContent.includes(${JSON.stringify(preparedContentHash)})`), true, "disconnect preserves the exact prepared activation");
    assert.equal(provider.sentTransactions.length, 0);
    assert.equal(requestMethods(provider, preparedResumeOffset).filter((method) => method === "eth_signTypedData_v4").length, 0, "disconnect preserves the cached unlock signature");
    const submissionResumeOffset = provider.requestLog.length;
    // Exercise recovery from a known broadcast with an unknown L1 outcome.
    rpc.setReceiptFailure("Receipt RPC unavailable during activation recovery");
    releaseReceipts = rpc.holdReceipts();
    await browser.clickButton("Set up and mine");
    await browser.waitFor(`document.querySelector('[data-testid="activation-status"]')?.textContent.includes(${JSON.stringify(l1TransactionHash)})
      && document.querySelector('[data-testid="activation-status"] [role="status"]')?.textContent.includes("Waiting for Ethereum transaction inclusion")`, {
      description: "account setup exposes the L1 hash while waiting for inclusion", timeoutMs: 120_000,
    });
    assert.equal(await browser.evaluate(`document.querySelector('[data-testid="wallet-trigger"]').getAttribute("data-wallet-busy")`), "true", "the L1 hash is visible before receipt lookup completes");
    releaseReceipts();
    releaseReceipts = undefined;
    await waitForSubmittedAccount(browser);
    if (onboardingScreenshots) {
      const directory = onboardingScreenshots;
      for (const [name, width] of [["submitted-mobile", 390], ["submitted-desktop", 1440]]) {
        writeFileSync(join(directory, `${name}.png`), await browser.screenshot({ width, height: width < 500 ? 844 : 1000 }));
      }
    }
    assert.equal(provider.sentTransactions.length, 1);
    assert.equal(requestMethods(provider, submissionResumeOffset).includes("eth_signTypedData_v4"), false, "resuming the declined transaction reuses the completed key signature");
    assert.equal(requestMethods(provider, derivationOffset).filter((method) => method === "eth_sendTransaction").length, 3, "the declined Ethereum request is retried only by the explicit resume action");
    const sent = provider.sentTransactions[0];
    assert.equal(sent.from.toLowerCase(), FIXED_ACCOUNT.toLowerCase());
    assert.equal(sent.to.toLowerCase(), TEST_STATUS.inboxAddress.toLowerCase());
    assert.equal(sent.value, "0x0");
    assert.equal(decodeBatch(fromHex(sent.data)).items.length, 2);
    assert.equal(decodeTransaction(decodeBatch(fromHex(sent.data)).items[1]).kind, 0);
    const creation = decodeTransaction(decodeBatch(fromHex(sent.data)).items[0]);
    assert.equal(creation.kind, 1);
    assert.deepEqual(creation.authorization, { kind: "direct" });

    await browser.openWallet();
    assert.equal(await browser.evaluate(`document.querySelector('[data-testid="wallet-panel"] a[href="/get"]') !== null`), false, "mining waits for account confirmation");
    assert.equal(await browser.evaluate(`document.querySelector('[data-testid="mining-start"]')`), null);
    await waitForSubmittedAccount(browser);

    await disconnectWallet(browser);
    await waitForDisconnected(browser);
    assert.equal(provider.sentTransactions.length, 1);
    const submittedResumeOffset = provider.requestLog.length;
    await browser.connectWallet();
    await waitForSubmittedAccount(browser);
    assert.equal(requestMethods(provider, submittedResumeOffset).includes("eth_signTypedData_v4"), false, "reconnecting restores the saved sign-in");
    assert.equal(provider.sentTransactions.length, 1, "disconnect and reconnect must not rebroadcast activation");
    assert.equal(requestMethods(provider, submittedResumeOffset).includes("eth_sendTransaction"), false, "restoring a submitted activation only checks it");

    provider.setChainId(1n);
    const reloadOffset = provider.requestLog.length;
    await browser.reload();
    await waitForSubmittedAccount(browser);
    const wrongChainMethods = requestMethods(provider, reloadOffset);
    assert.ok(wrongChainMethods.includes("wallet_switchEthereumChain"));
    assert.equal(wrongChainMethods.includes("eth_signTypedData_v4"), false);
    assert.equal(provider.chainId, BigInt(TEST_STATUS.l1ChainId));
    assert.equal(provider.sentTransactions.length, 1, "reload must not rebroadcast activation");

    rpc.setReceiptFailure(undefined);
    const blockedSetupOffset = provider.requestLog.length;
    for (const prepare of [false, true]) {
      await browser.evaluate(`import(${JSON.stringify(probeUrl)}).then((probe) => probe.replaceAccountActivation("pcash-wallet-state", ${JSON.stringify(rpc.url)}, ${prepare}))`);
      await browser.reload();
      await waitForSubmittedAccount(browser);
      const checksBefore = rpc.requests.filter(({ method }) => method === "eth_getTransactionReceipt").length;
      await browser.evaluate(`(() => {
        window.activationBusyChanges = [];
        window.activationBusyObserver = new MutationObserver((changes) => {
          for (const change of changes) window.activationBusyChanges.push(change.target.getAttribute("data-wallet-busy"));
        });
        window.activationBusyObserver.observe(document.querySelector('[data-testid="wallet-trigger"]'), { attributes: true, attributeFilter: ["data-wallet-busy"] });
        document.querySelector('[data-testid="wallet-trigger"]').click();
      })()`);
      await browser.waitFor(`document.querySelector('[data-testid="wallet-panel"][open]') !== null`);
      assert.equal(await browser.evaluate(`document.querySelector('[data-testid="wallet-panel"] [aria-label="Receive address"] [title]').getAttribute("title").toLowerCase()`), FIXED_ACCOUNT.toLowerCase());
      assert.equal(await browser.evaluate(`document.querySelector('[data-testid="wallet-panel"]').innerText.includes("Continue setup")`), false);
      // Observe multiple timer ticks; a poll must neither stop after its first read nor lock the wallet.
      const pollDeadline = Date.now() + 30_000;
      while (rpc.requests.filter(({ method }) => method === "eth_getTransactionReceipt").length < checksBefore + 2) {
        if (Date.now() > pollDeadline) throw new Error("activation status did not keep checking in the background");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.deepEqual(await browser.evaluate(`window.activationBusyChanges`), [], "background checks do not toggle the wallet's busy state");
      await browser.evaluate(`window.activationBusyObserver.disconnect(); document.querySelector('button[aria-label="Close wallet"]').click()`);
      assert.equal(await browser.evaluate(`document.body.innerText.includes("relay journal")`), false);
      assert.equal(provider.sentTransactions.length, 1, "checking an older pending submission must not send another transaction");
    }
    assert.equal(requestMethods(provider, blockedSetupOffset).includes("eth_sendTransaction"), false);
    assert.equal(requestMethods(provider, blockedSetupOffset).includes("eth_signTypedData_v4"), false);

    // An active wallet flow may request one switch back after an external chain
    // change, but a declined switch must not reopen the prompt.
    await browser.evaluate(`history.pushState({}, "", location.pathname + location.search + "#wallet"); dispatchEvent(new PopStateEvent("popstate"))`);
    await browser.waitFor(`location.hash === "#wallet" && document.querySelector('[data-testid="wallet-panel"][open]') !== null`);
    const externalChainOffset = provider.requestLog.length;
    provider.setChainId(1n);
    provider.rejectNext("wallet_switchEthereumChain", { code: 4001, message: "Switch rejected by the journey" });
    await browser.evaluate(`window.ethereum[${JSON.stringify(PAGE_PROVIDER_CONTROL)}]
      .emit("chainChanged", "0x1")`);
    const chainSwitchDeadline = Date.now() + 30_000;
    for (;;) {
      if (requestMethods(provider, externalChainOffset).includes("wallet_switchEthereumChain")) break;
      if (Date.now() >= chainSwitchDeadline) throw new Error("an external chain change did not prompt a switch back");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(
      requestMethods(provider, externalChainOffset).filter((method) => method === "wallet_switchEthereumChain").length,
      1,
      "a refused switch after an external chain change must not be reissued",
    );
    provider.setChainId(BigInt(TEST_STATUS.l1ChainId));
    await browser.evaluate(`window.ethereum[${JSON.stringify(PAGE_PROVIDER_CONTROL)}]
      .emit("chainChanged", ${JSON.stringify(`0x${BigInt(TEST_STATUS.l1ChainId).toString(16)}`)})`);

    const savedReturnOffset = provider.requestLog.length;
    provider.setAccounts([`0x${"97".repeat(20)}`]);
    await browser.evaluate(`window.ethereum[${JSON.stringify(PAGE_PROVIDER_CONTROL)}].emit("accountsChanged", [${JSON.stringify(`0x${"97".repeat(20)}`)}])`);
    await browser.waitFor(`document.querySelector('[data-testid="wallet-trigger"][data-wallet-phase="sign-in-required"]') !== null`);
    provider.useFixedAccount();
    await browser.evaluate(`window.ethereum[${JSON.stringify(PAGE_PROVIDER_CONTROL)}].emit("accountsChanged", [${JSON.stringify(FIXED_ACCOUNT)}])`);
    await waitForSubmittedAccount(browser);
    assert.equal(requestMethods(provider, savedReturnOffset).includes("eth_signTypedData_v4"), false, "switching back restores the original wallet without signing");

    const accountChangeOffset = provider.requestLog.length;
    provider.setAccounts([`0x${"99".repeat(20)}`]);
    await browser.evaluate(`window.ethereum[${JSON.stringify(PAGE_PROVIDER_CONTROL)}]
      .emit("accountsChanged", [${JSON.stringify(`0x${"99".repeat(20)}`)}])`);
    await browser.waitFor(`document.querySelector("#send") === null
      && document.querySelector('[data-testid="wallet-trigger"][data-wallet-phase="sign-in-required"]')?.textContent.includes("0x9999")`, {
      description: "account change removes the prior owner's controls without signing",
    });
    assert.equal(await browser.evaluate("location.pathname.toLowerCase()"), "/", "an external account change does not hijack the viewed page");
    await browser.evaluate(`document.querySelector('[data-testid="wallet-trigger"]').click()`);
    await browser.waitFor(`document.querySelector('[data-testid="wallet-panel"][open] [data-testid="account-setup"]') !== null
      && [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Sign in" && !button.disabled)`, {
      description: "the wallet sidebar offers sign-in on the newly selected account",
    });
    assert.equal(requestMethods(provider, accountChangeOffset).includes("eth_signTypedData_v4"), false);

    const originalRequest = provider.request.bind(provider);
    const heldSignatures = [];
    provider.request = (request) => request.method === "eth_signTypedData_v4"
      ? new Promise((_resolve, reject) => heldSignatures.push({ request, reject }))
      : originalRequest(request);
    const waitForHeldSignatures = async (count) => {
      for (let attempt = 0; heldSignatures.length < count; attempt += 1) {
        if (attempt === 200) throw new Error(`expected ${count} sign-in signatures, received ${heldSignatures.length}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(heldSignatures.length, count);
    };
    try {
      await browser.clickButton("Sign in");
      await waitForHeldSignatures(1);
      const secondAccount = `0x${"98".repeat(20)}`;
      provider.setAccounts([secondAccount]);
      await browser.evaluate(`window.ethereum[${JSON.stringify(PAGE_PROVIDER_CONTROL)}]
        .emit("accountsChanged", [${JSON.stringify(secondAccount)}])`);
      await browser.waitFor(`document.querySelector('[data-testid="wallet-trigger"][data-wallet-phase="sign-in-required"]')?.textContent.includes("0x9898")`, {
        description: "account switching releases the previous sign-in attempt",
      });
      await browser.evaluate(`document.querySelector('[data-testid="wallet-trigger"]').click()`);
      await browser.waitFor(`document.querySelector('[data-testid="wallet-panel"][open] [data-testid="account-setup"]') !== null
        && [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Sign in")`, {
        description: "the second account can sign in while the first signature is unresolved",
      });
      await browser.clickButton("Sign in");
      await waitForHeldSignatures(2);
      assert.equal(heldSignatures[0].request.params[0].toLowerCase(), `0x${"99".repeat(20)}`);
      assert.equal(heldSignatures[1].request.params[0].toLowerCase(), secondAccount);
      heldSignatures[0].reject({ code: 4001, message: "Previous account signature rejected" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await browser.evaluate(`document.querySelector('[data-testid="account-setup"]')?.getAttribute("aria-busy")`), "true", "the previous attempt cannot end the current account's sign-in");
      assert.equal(await browser.evaluate(`document.body.textContent.includes("You rejected the request in your wallet.")`), false, "the previous account's rejection is not shown on the current account");
      assert.equal(await browser.evaluate(`[...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Sign in")`), false, "sign-in cannot be started twice while its signature is pending");
      heldSignatures[1].reject({ code: 4001, message: "Current account signature rejected" });
      await browser.waitFor(`document.querySelector('[role="alert"]')?.textContent?.includes("You rejected the request in your wallet.")
        && [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Sign in")`, {
        description: "the current account can retry a declined signature",
      });
      await browser.clickButton("Sign in");
      await waitForHeldSignatures(3);
      await disconnectWallet(browser);
      await waitForDisconnected(browser);
      heldSignatures[2].reject({ code: 4001, message: "Disconnected signature rejected" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await browser.evaluate(`document.body.textContent.includes("You rejected the request in your wallet.")`), false, "a dismissed signature cannot restore the disconnected wallet");
      await waitForDisconnected(browser);
    } finally {
      provider.request = originalRequest;
      for (const signature of heldSignatures) signature.reject({ code: 4001, message: "Journey signature cancelled" });
    }

    provider.setAccounts([]);
    await browser.evaluate(`window.ethereum[${JSON.stringify(PAGE_PROVIDER_CONTROL)}]
      .emit("accountsChanged", [])`);
    await waitForDisconnected(browser);

    // The step under test is a rejected network switch, so the wallet has to have
    // an account to return first. Without one the connect modal correctly waits on
    // the extension and the switch is never attempted.
    provider.useFixedAccount();
    provider.setChainId(1n);
    provider.rejectNext("wallet_switchEthereumChain", { code: 4001, message: "Switch rejected by the journey" });
    const rejectedSwitchOffset = provider.requestLog.length;
    await browser.connectWallet();
    // The connect modal owns the rejection now, so assert the protocol outcome
    // rather than an app-level alert: the switch is required before anything else,
    // and a refused switch must not lead to a signature.
    for (let attempt = 0; ; attempt += 1) {
      if (requestMethods(provider, rejectedSwitchOffset).includes("wallet_switchEthereumChain")) break;
      if (attempt === 200) throw new Error("the required network switch was never requested");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const rejectedSwitchMethods = requestMethods(provider, rejectedSwitchOffset);
    assert.ok(rejectedSwitchMethods.includes("wallet_switchEthereumChain"));
    assert.equal(rejectedSwitchMethods.includes("eth_signTypedData_v4"), false);
    // A refused switch must not be re-asked. Settling in a phase the automatic
    // effect ignores is what stops the prompt from reopening immediately.
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(
      requestMethods(provider, rejectedSwitchOffset).filter((method) => method === "wallet_switchEthereumChain").length,
      1,
      "a rejected network switch must not be reissued automatically",
    );

    provider.setChainId(BigInt(TEST_STATUS.l1ChainId));
    provider.useFixedAccount();
    const activationL1Hash = l1TransactionHash;
    l1TransactionHash = TEST_RELAY_L1_HASH;
    rpc.setReceiptFailure(undefined);
    rpc.useRelayCandidates();
    const relayBrowseRpcOffset = rpc.requests.length;
    await browser.navigate(`${site.url}${relayRoute.path}`);
    const relayConnectOffset = provider.requestLog.length;
    const relayConnected = `document.querySelector('[data-testid="mining-start"]') !== null`;
    const relaySignIn = '[...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Sign in" && !button.disabled)';
    await browser.waitFor(`${relayConnected} || [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Connect wallet" && !button.disabled)`);
    if (!await browser.evaluate(relayConnected)) await browser.connectWallet();
    await browser.waitFor(relayConnected, { description: "the saved sign-in opens Get PCASH", timeoutMs: 60_000 });
    assert.equal(requestMethods(provider, relayConnectOffset).includes("eth_signTypedData_v4"), false, "posting reuses the saved sign-in");
    assert.equal(await browser.evaluate(`document.querySelector('#mine-count').value`), "1", "the page starts with one mine");
    await browser.evaluate(`document.querySelector('[aria-label="Mine one fewer transaction"]').click()`);
    assert.equal(await browser.evaluate(`document.querySelector('#mine-count').value`), "0");
    const openRecovery = async () => browser.evaluate(`history.pushState({}, "", location.pathname + "#ethereum-submission"); dispatchEvent(new PopStateEvent("popstate"))`);
    const closeWallet = async () => browser.evaluate(`document.querySelector('[data-testid="wallet-panel"] [aria-label="Close wallet"]').click()`);
    await browser.waitFor(`document.body.innerText.includes("Resolve your existing Ethereum submission")`, {
      description: "the unresolved activation prevents another L1 publication",
    });
    await openRecovery();
    await browser.waitFor(`document.querySelector('[data-testid="wallet-panel"][data-view="ethereum-submission"]') !== null`);
    rpc.dropTransaction(activationL1Hash);
    // A mined replacement consumes the nonce, so recovery need not wait for
    // the propagation grace that protects a merely unseen transaction.
    rpc.setTransactionCount(4n);
    await refreshRelayLock(browser);
    await browser.waitFor(`document.body.innerText.includes("No Ethereum submission is blocking your wallet.") || document.body.innerText.includes("Cleared. You can submit again.")`, {
      description: "wallet recovery releases a replaced activation without broadcasting",
    });
    await closeWallet();
    await browser.waitFor(`document.querySelector('[data-testid="mining-start"]')?.disabled === false && document.body.innerText.includes("This batch posts 1 of ")`, {
      description: "automatic selection keeps the one compatible, fitting transaction",
    });
    assert.equal(provider.sentTransactions.length, 1);
    assert.equal(await browser.evaluate(`document.querySelector('input[type="checkbox"]') === null`), true, "Get PCASH has no manual selection table");
    const browsePreparations = rpc.requests.slice(relayBrowseRpcOffset).filter(({ method }) => method === "pcash_prepareRelay");
    assert.ok(browsePreparations.length > 0);
    assert.ok(browsePreparations.some(({ params }) => params[0].contentHashes.includes(TEST_RELAY_CONFLICT_CONTENT_HASH)), "selection checks competing candidates with the node");
    assert.ok(browsePreparations.some(({ params }) => params[0].contentHashes.length === 1 && params[0].contentHashes[0] === TEST_RELAY_CONTENT_HASH), "selection retries after dropping the conflicting candidate");
    assert.ok(browsePreparations.every(({ params }) => !params[0].contentHashes.includes(TEST_RELAY_OVERSIZED_CONTENT_HASH)), "the oversized candidate never fits the browser batch");
    assert.ok(browsePreparations.some(({ params }) => BigInt(params[0].maxBatchBytes) === 122_880n), "relay-only uses the entire browser capacity");
    await browser.waitFor(`document.body.innerText.includes("ETH") && document.body.innerText.includes("Estimated Ethereum cost")`);
    await captureRelay(browser, "get-relay-mobile", 390);
    await captureRelay(browser, "get-relay-desktop");
    rpc.delayNextGasEstimate(5_500);
    const slowPreparationStarted = Date.now();
    provider.rejectNext("eth_sendTransaction");
    await browser.clickButton("Relay transactions");
    await browser.waitFor(`document.body.innerText.includes("You rejected the request in your wallet.") && document.querySelector('[data-testid="mining-start"]')?.disabled === false`, {
      description: "a rejected wallet prompt leaves automatic relay retryable",
    });
    assert.equal(provider.sentTransactions.length, 1);
    assert.ok(Date.now() - slowPreparationStarted >= 5_500);
    await browser.clickButton("Relay transactions");
    await browser.waitFor(`document.querySelector('[data-testid="mining-result"]')?.textContent.includes("Waiting for L1 inclusion")`, {
      description: "the submitted batch has inline progress", timeoutMs: 30_000,
    });
    rpc.includeRelay();
    await browser.waitFor(`document.querySelector('[data-testid="mining-result"]')?.textContent.includes("Batch included")`, {
      description: "the included batch reports its actual earnings", timeoutMs: 30_000,
    });
    assert.equal(await browser.evaluate(`document.querySelector('[data-testid="mining-result"] [aria-label="0 PCASH"]') !== null`), true);
    await browser.evaluate(`document.querySelector('[data-testid="mining-result"] a[href="/batch/${TEST_RELAY_L1_HASH}"]').click()`);
    await browser.waitFor(`location.pathname === "/batch/${TEST_RELAY_L1_HASH}" && document.body.innerText.includes("Unfinalized")`, {
      description: "the result links to the included batch",
    });
    await captureRelay(browser, "batch-included-desktop");
    rpc.finalizeRelay();
    await browser.navigate(`${site.url}${relayRoute.path}`);
    const historyRows = `(() => {
      const key = Object.keys(sessionStorage).find((key) => key.startsWith("pcash:relay-history:") && key.endsWith(${JSON.stringify(`:${FIXED_ACCOUNT.toLowerCase()}`)}));
      return key ? JSON.parse(sessionStorage.getItem(key)) : [];
    })()`;
    await browser.waitFor(`(${historyRows}).some((row) => row.txHash === "${TEST_RELAY_L1_HASH}" && row.status === "finalized")`, {
      description: "the finalized batch remains in this wallet's session history", timeoutMs: 30_000,
    });
    assert.equal(provider.sentTransactions.length, 2);
    const relayTransaction = provider.sentTransactions[1];
    assert.equal(relayTransaction.from.toLowerCase(), FIXED_ACCOUNT.toLowerCase());
    assert.equal(relayTransaction.to.toLowerCase(), TEST_STATUS.inboxAddress.toLowerCase());
    assert.equal(relayTransaction.value, "0x0");
    assert.equal(relayTransaction.blobs, undefined);
    assert.equal(relayTransaction.blobVersionedHashes, undefined);
    assert.equal(relayTransaction.maxFeePerBlobGas, undefined);
    assert.equal(decodeBatch(fromHex(relayTransaction.data)).items.length, 1, "automatic relay publishes one compatible entry");
    await browser.reload();
    await browser.waitFor(relayConnected);
    assert.equal(await browser.evaluate(`(${historyRows}).some((row) => row.txHash === "${TEST_RELAY_L1_HASH}" && row.status === "finalized")`), true);
    assert.equal(provider.sentTransactions.length, 2, "reload must not rebroadcast the batch");

    const otherAccount = `0x${"99".repeat(20)}`;
    provider.setAccounts([otherAccount]);
    await browser.evaluate(`window.ethereum[${JSON.stringify(PAGE_PROVIDER_CONTROL)}].emit("accountsChanged", [${JSON.stringify(otherAccount)}])`);
    await browser.waitFor(relaySignIn, { description: "a different account needs its own fee-recovery sign-in", timeoutMs: 60_000 });
    provider.useFixedAccount();
    await browser.evaluate(`window.ethereum[${JSON.stringify(PAGE_PROVIDER_CONTROL)}].emit("accountsChanged", [${JSON.stringify(FIXED_ACCOUNT)}])`);
    await browser.waitFor(relayConnected, { description: "the original account restores its cached fee-recovery profile", timeoutMs: 60_000 });

    const unobservedRelayHash = `0x${"ee".repeat(32)}`;
    const journalEntry = {
      kind: "batch", createdAt: new Date().toISOString(), resolutionId: "journey-dropped-relay",
      phase: "broadcast_accepted", submissionKind: "eip1193_intent",
      transactionHash: unobservedRelayHash, signedTransaction: null, previousTransactionHashes: [], lastBroadcastBlock: null, carrier: "calldata",
      batch: TEST_RELAY_BATCH, selected: [TEST_RELAY_CONTENT_HASH], batchItemIndexes: ["0"], observationMode: "selected",
      collectibleOpenFee: "0", relayerAddress: FIXED_ACCOUNT,
      chainId: BigInt(TEST_STATUS.l1ChainId).toString(), inboxAddress: TEST_STATUS.inboxAddress,
      nonce: "1", gasLimit: "100000", maxFeePerGas: "1000000000", maxPriorityFeePerGas: "1000000",
      maxFeePerBlobGas: null, l1Rpc: rpc.url,
      genesisL1Block: BigInt(TEST_STATUS.genesisL1Block).toString(), genesisL1BlockHash: TEST_STATUS.genesisL1BlockHash,
      headCheckedBlock: BigInt(TEST_STATUS.genesisL1Block).toString(), headCheckedBlockHash: TEST_STATUS.genesisL1BlockHash,
    };
    await browser.evaluate(`import(${JSON.stringify(probeUrl)}).then(async (probe) => {
      await probe.seedRelayJournal(${JSON.stringify(rpc.url)}, ${JSON.stringify(journalEntry)});
      for (const key of Object.keys(sessionStorage)) if (key.startsWith("pcash:relay-history:")) sessionStorage.removeItem(key);
    })`);
    rpc.recordTransaction(unobservedRelayHash, { ...sent, nonce: "0x1" });
    await browser.reload();
    await browser.waitFor(`document.body.innerText.includes("Resolve your existing Ethereum submission")`, {
      description: "the durable submission lock survives without session history",
    });
    await openRecovery();
    rpc.dropTransaction(unobservedRelayHash);
    await refreshRelayLock(browser);
    await browser.waitFor(`document.body.innerText.includes("No Ethereum submission is blocking your wallet.") || document.body.innerText.includes("Cleared. You can submit again.")`, {
      description: "Refresh clears a dropped or replaced Ethereum transaction",
    });
    await closeWallet();
    await browser.reload();
    await browser.waitFor(`${relayConnected} && !document.body.innerText.includes("Resolve your existing Ethereum submission")`, {
      description: "the released submission stays released after reload",
    });
    assert.equal(provider.sentTransactions.length, 2, "submission recovery never broadcasts a transaction");

    // Reproduce an expired account setup queued behind a missing Ethereum nonce.
    const queuedHash = `0x${"c1".repeat(32)}`;
    const queuedActivation = await browser.evaluate(`import(${JSON.stringify(probeUrl)}).then((probe) =>
      probe.seedQueuedAccountActivation("pcash-wallet-state", ${JSON.stringify(rpc.url)}, ${JSON.stringify({ ...journalEntry, resolutionId: "queued-account-setup", transactionHash: queuedHash, nonce: "5" })}))`);
    rpc.recordTransaction(queuedHash, { ...sent, nonce: "0x5", data: queuedActivation.batch });
    rpc.setLatestBlockTimestamp(BigInt(queuedActivation.validUntilTimestamp) + 1n);
    await browser.evaluate(`history.pushState({}, "", location.pathname + location.search + "#wallet"); dispatchEvent(new PopStateEvent("popstate"))`);
    await browser.reload();
    await browser.waitFor(`document.querySelector('[data-testid="activation-status"]')?.innerText.includes("Ethereum is waiting for nonce 4")
      && [...document.querySelectorAll("button")].some((button) => button.textContent === "Retry setup" && !button.disabled)`, {
      description: "a reloaded expired setup shows its hash, nonce gap, and recovery action",
      timeoutMs: 60_000,
    });
    assert.equal(await browser.evaluate(`document.querySelector('[data-testid="activation-status"]').innerText.includes(${JSON.stringify(queuedHash)})`), true);
    assert.equal(await browser.evaluate(`document.querySelector('[data-testid="wallet-panel"] a[href="/get"]') !== null`), false, "mining waits for account confirmation");
    assert.equal(provider.sentTransactions.length, 2, "checking an expired transaction does not silently retry it");
    await browser.evaluate(`(() => {
      const retry = [...document.querySelectorAll("button")].find((button) => button.textContent === "Retry setup");
      retry.click(); retry.click();
    })()`);
    await browser.waitFor(`document.querySelector('[data-testid="wallet-trigger"][data-wallet-busy="false"]') !== null
      && document.querySelector('[data-testid="activation-status"]')?.innerText.includes("earlier Ethereum submission is unresolved")`, {
      description: "expiry does not release the pending Ethereum submission or broadcast a replacement",
      timeoutMs: 60_000,
    });
    assert.equal(provider.sentTransactions.length, 2, "retry cannot spend more gas while the expired setup carrier is unresolved");
    assert.equal(await browser.evaluate(`document.querySelector('[data-testid="activation-status"]').innerText.includes(${JSON.stringify(queuedHash)})`), true);
    await browser.reload();
    await browser.waitFor(`document.querySelector('[data-testid="activation-status"]')?.innerText.includes(${JSON.stringify(queuedHash)})`, {
      description: "reload retains the original setup and its unresolved relay journal",
      timeoutMs: 60_000,
    });
    assert.equal(provider.sentTransactions.length, 2, "reload does not send another setup transaction");

    const browserFailures = browser.events().filter((event) => {
      if (event.type === "pageerror") return true;
      if (event.type !== "error") return false;
      return /hydration|did not match|server rendered|Minified React error #4(?:18|19|20|21|22|23)/i.test(event.message);
    });
    assert.deepEqual(browserFailures, []);
    logger.info("wallet journey passed (IndexedDB reopen, saved PCASH sign-in, direct L1 activation, MetaMask calldata relay)");
  } catch (cause) {
    logger.error("wallet journey diagnostics", JSON.stringify({
      body: await browser?.evaluate("document.body?.innerText").catch(() => undefined),
      providerRequests: provider?.requestLog ?? [],
      rpcRequests: rpc?.requests ?? [],
      browserEvents: browser?.events().filter((event) => event.type === "pageerror"
        || event.type === "error").slice(-20) ?? [],
    }, null, 2));
    throw cause;
  } finally {
    releaseReceipts?.();

    await bridge?.close();
    await rpc?.close();
  }
});
