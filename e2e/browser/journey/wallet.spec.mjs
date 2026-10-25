import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeBatch, decodeTransaction, transactionPublication } from "@pcash/sdk/protocol";
import { fromHex } from "@pcash/sdk/utils";
import { formatUnits, parseUnits, keccak256 } from "viem";
import { l1Rpc, validPrivateKey } from "../../src/backends/rpc.ts";
import { ANVIL_ACCOUNTS } from "../../src/backends/anvil.ts";
import { ScenarioFixture } from "../../src/fixture/scenarioFixture.ts";
import { setupUserWallets } from "../../src/scenarios/setup.ts";
import { assertSystemPayoutRecovered } from "../../src/scenarios/payouts.ts";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import { eventually } from "../../src/framework/eventually.ts";
import { leasePorts } from "../../src/framework/ports.ts";
import { logger } from "../../src/framework/logger.ts";
import { circuitBundle, e2eSettings } from "../../src/settings.ts";
import { test, buildWebsite, stageWebsite } from "../fixtures.mjs";
import { MULTICALL3_ADDRESS, setupAnvilMulticall3 } from "../../../scripts/dev/multicall3.mjs";

test("receives L notes and spends through relayed and Fast browser submissions", async ({ journey }, testInfo) => {
  const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const settings = e2eSettings();
  const bundle = circuitBundle();
  const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

  async function captureOwner(browser, name, width = 1440) {
    const directory = settings.str("owner-screenshots");
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.png`), await browser.screenshot({ width, height: width < 500 ? 844 : 1000 }));
  }

  function formatPcashInput(value) {
    return formatUnits(value, 18);
  }

  /** The exact amount as the site labels it: thousands separators, no trailing zeros. */
  function displayPcash(value) {
    const [whole, fraction] = formatPcashInput(value).split(".");
    return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction === undefined ? "" : `.${fraction}`} PCASH`;
  }

  function addressHex(value) {
    return `0x${BigInt(value).toString(16).padStart(40, "0")}`;
  }

  function typedData(request) {
    const params = request?.params;
    if (!Array.isArray(params) || typeof params[0] !== "string" || typeof params[1] !== "string") {
      throw new Error("eth_signTypedData_v4 request has malformed parameters");
    }
    return { account: params[0], value: JSON.parse(params[1]) };
  }

  function assertTransferAuthorization(provider, offset, actor, recipient, amount, network) {
    const log = provider.requestLog;
    const requests = log.slice(offset);
    const authorizations = requests.filter(({ method }) => method === "eth_signTypedData_v4");
    assert.equal(authorizations.length, 1, "one PCASH authorization covers the payment");
    const signed = typedData(authorizations[0]);
    assert.equal(signed.account.toLowerCase(), actor.address.toLowerCase());
    assert.deepEqual(signed.value.domain, {
      name: "PCASH",
      version: "1",
      chainId: network.l1ChainId.toString(),
      verifyingContract: addressHex(network.inboxAddress),
    });
    assert.equal(signed.value.primaryType, "PcashPayment");
    assert.equal(signed.value.message.pcashChainId, network.pcashChainId.toString());
    assert.equal(signed.value.message.recipient, recipient.address.toLowerCase());
    assert.equal(signed.value.message.amount, amount.toString());
    assert.ok(BigInt(signed.value.message.openFeeAmount) > 0n, "the relayed payment carries its relayer fee");
    assert.equal(signed.value.message.issuanceOwnerCommitment, "0", "the default payment uses the open issuance route");
    assert.deepEqual(Object.keys(signed.value.message), [
      "pcashChainId",
      "recipient",
      "amount",
      "openFeeAmount",
      "issuanceRecipient",
      "issuanceOwnerCommitment",
      "relayFeeAmount",
      "relayFeeOwnerCommitment",
      "transactionContext",
      "notBefore",
      "validUntil",
    ]);
  }

  async function waitForDisconnected(browser) {
    await browser.waitFor(`document.querySelector('[data-testid="wallet-trigger"][data-wallet-phase="disconnected"]') !== null
      && [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Connect wallet")`, {
      description: "the disconnected account view",
      timeoutMs: 60_000,
    });
  }

  async function connectAndDerive(browser) {
    await browser.connectWallet();
    await browser.waitFor(`document.querySelector('[data-testid="wallet-trigger"][data-wallet-phase="ready"]') !== null`, {
      description: "registered wallet is ready to send and receive", timeoutMs: 120_000,
    });
    await browser.page.getByRole('button', { name: 'Close wallet', exact: true }).click();
  }

  async function copyProfileLink(browser, address) {
    const copy = '#receive [aria-label="Copy profile link"]';
    await browser.clickButton("Receive");
    await browser.waitFor(`document.querySelector(${JSON.stringify(copy)}) !== null`, { description: "the receive panel" });
    await browser.evaluate(`document.querySelector(${JSON.stringify(copy)}).click()`);
    await browser.waitFor(`document.querySelector(${JSON.stringify(copy)}).getAttribute("data-copy-state") === "copied"`, { description: "profile link copied from the receive panel" });
    const link = await browser.evaluate('sessionStorage.getItem("journey-clipboard")');
    const origin = await browser.evaluate("location.origin");
    assert.equal(link.toLowerCase(), `${origin}/${address}`.toLowerCase(), "clipboard contains the account's profile link");
    assert.equal(await browser.evaluate('document.querySelector("#receive code")?.textContent'), link, "the receive panel shows the copied profile link");
    await browser.clickButton("← Wallet");
  }

  async function trackNavigationCopy(browser) {
    const source = `(() => {
      window.navigationCopyFailures = [];
      const inspect = () => {
        const text = document.body?.innerText ?? "";
        const matches = text.match(/Checking node identity|Connecting to (?:the )?(?:PCASH|node|network)/gi) ?? [];
        for (const match of matches) if (!window.navigationCopyFailures.includes(match)) window.navigationCopyFailures.push(match);
      };
      new MutationObserver(inspect).observe(document, { childList: true, subtree: true, characterData: true });
      inspect();
    })()`;
    await browser.addInitScript(source);
    await browser.evaluate(source);
  }

  async function closeWallet(browser) {
    await browser.evaluate(`document.querySelector('button[aria-label="Close wallet"]').click()`);
    await browser.waitFor('document.querySelector("dialog[open]") === null', { description: "the close button dismisses the wallet" });
  }

  async function checkGlobalWallet(browser, address) {
    const ownerPath = `/${address.toLowerCase()}`;
    await browser.evaluate(`(() => {
      history.pushState({ ...history.state, idx: (history.state?.idx ?? 0) + 1, key: "global-wallet" }, "", "/");
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    })()`);
    await browser.waitFor(`location.pathname === "/" && document.querySelector('[data-testid="wallet-trigger"][data-wallet-phase="ready"]') !== null`);
    const open = async () => {
      await browser.evaluate(`document.querySelector('[data-testid="wallet-trigger"][data-wallet-phase="ready"]').click()`);
      await browser.waitFor(`document.querySelector('dialog[open][data-testid="wallet-panel"][data-view="overview"]') !== null`);
    };
    await open();
    await copyProfileLink(browser, address);
    // Escape and the backdrop dismiss the wallet panel.
    await browser.pressEscape();
    assert.equal(await browser.evaluate('document.querySelector("dialog[open][data-testid=wallet-panel]") !== null'), false, "Escape closes the global wallet");
    await open();
    const outside = await browser.evaluate(`(() => {
      const bounds = document.querySelector('dialog[open]').getBoundingClientRect();
      return { x: Math.max(1, bounds.left / 2), y: 20 };
    })()`);
    await browser.clickAt(outside.x, outside.y);
    assert.equal(await browser.evaluate('document.querySelector("dialog[open][data-testid=wallet-panel]") !== null'), false, "the backdrop closes the global wallet");
    await open();
    await browser.evaluate(`window.walletPanelUnderTest = document.querySelector('dialog[open]'); [...window.walletPanelUnderTest.querySelectorAll('button')].find((button) => button.textContent.trim() === "Send").click()`);
    await browser.waitFor('document.querySelector("dialog[open] #send form") !== null');
    assert.equal(await browser.evaluate(`document.querySelector('dialog[open]') === window.walletPanelUnderTest && location.pathname === "/"`), true, "Send stays in the same global panel on the current page");
    await browser.clickButton("Cancel");
    await browser.waitFor(`document.querySelector('dialog[open][data-view="overview"]') !== null`);
    await trackNavigationCopy(browser);
    assert.equal(await browser.evaluate(`[...document.querySelectorAll('dialog[open] a')].some((link) => link.textContent.includes("View full account"))`), false);
    await closeWallet(browser);
    await browser.evaluate(`history.pushState({}, "", ${JSON.stringify(ownerPath)}); dispatchEvent(new PopStateEvent("popstate"))`);
    await browser.waitFor(`document.querySelector('main [data-testid="wallet-balance"]')?.textContent.includes("PCASH")`, { description: "the owner's address page recovers its balance from the cached keys" });
    assert.equal(await browser.evaluate(`document.querySelector('main [data-testid="wallet-sidebar-balance"], main [data-testid="account-setup"]')`), null);
    await browser.openWallet();
    await waitForReady(browser);
    assert.deepEqual(await browser.evaluate("window.navigationCopyFailures"), [], "warm account navigation does not flash node connection prose");
  }

  async function checkSendDrawer(browser) {
    await browser.evaluate(`document.querySelector('[data-testid="wallet-trigger"][data-wallet-phase="ready"]').click()`);
    await browser.waitFor(`document.querySelector('dialog[open][data-view="overview"]') !== null`);
    await captureOwner(browser, "wallet-overview-mobile", 390);
    await captureOwner(browser, "wallet-overview-desktop");
    await closeWallet(browser);
    await browser.openWallet();
    await browser.clickButton("Send");
    await browser.waitFor('document.querySelector("dialog[open] #send form") !== null', { description: "Send opens the payment drawer" });
    await captureOwner(browser, "wallet-send-desktop");
    await browser.evaluate(`document.querySelector('button[aria-label="Close wallet"]').click()`);
    await browser.waitFor('document.querySelector("dialog[open]") === null && location.hash !== "#send"', { description: "Close dismisses the payment drawer and clears its URL intent" });
    await browser.openWallet();
    await browser.clickButton("Send");
    await browser.waitFor('document.querySelector("dialog[open] #send form") !== null');
    await browser.clickButton("Cancel");
    await browser.waitFor(`document.querySelector('dialog[open][data-view="overview"]') !== null && location.hash !== "#send"`, { description: "Cancel returns from the unsent payment form to the wallet" });
    await closeWallet(browser);
  }

  async function waitForReady(browser) {
    await browser.openWallet();
    await browser.waitFor(`document.querySelector('[data-testid="wallet-trigger"][data-wallet-phase="ready"]') !== null
      && [...document.querySelectorAll('[data-testid="wallet-panel"] button')].some(button => button.textContent === "Send" && !button.disabled)
      && [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Receive" && !button.disabled)
      && document.querySelector('[role="alert"]') === null`, {
      description: "the ready Wallet dashboard",
      timeoutMs: 2 * 60_000,
    });
  }

  async function readyView(browser) {
    return browser.evaluate(`(() => {
      const normalized = (value) => value?.replace(/\\s+/g, " ").trim() ?? "";
      const balanceCard = document.querySelector('[data-testid="wallet-sidebar-balance"]');
      if (!balanceCard) throw new Error("Account balance is missing");
      const facts = (container) => Object.fromEntries([...container.querySelectorAll("dt")].map((term) => [
        normalized(term.textContent),
        normalized(term.nextElementSibling?.textContent),
      ]));
      const activity = document.querySelector("#wallet-activity");
      return {
        balance: normalized(balanceCard.querySelector("[aria-label]")?.getAttribute("aria-label") ?? balanceCard.textContent),
        balanceDescription: normalized(balanceCard.nextElementSibling?.textContent),
        status: facts(document),
        historyCurrent: activity?.getAttribute("data-history-current") === "true",
        historyHead: activity?.getAttribute("data-history-head"),
        walletHead: activity?.getAttribute("data-wallet-head"),
        historyChecking: activity?.getAttribute("data-history-checking") === "true",
        incomingRows: activity?.querySelectorAll('[data-activity-kind="received"]').length ?? 0,
        noPendingTransactions: activity?.getAttribute("data-history-state") === "ready" && activity.querySelector('[data-activity-state="pending"]') === null,
        outgoingPaymentLinks: [...(activity?.querySelectorAll('[data-activity-kind="sent"] a[href^="/tx/"]') ?? [])].map((link) => link.getAttribute("href")),
        hasConfirmedTransaction: activity?.querySelector('[data-activity-state="complete"]') != null,
        hasFinalizedTransaction: activity?.querySelector('[data-payment-status="finalized"]') != null,
        acceptedPaymentLinks: [...(activity?.querySelectorAll('[data-payment-id][data-activity-kind="sent"][data-activity-state="complete"]') ?? [])].map((row) => row.querySelector('a[href^="/tx/"]')?.getAttribute("href")),
        paymentLinks: [...(activity?.querySelectorAll('a[href^="/tx/"]') ?? [])].map((link) => link.getAttribute("href")),
      };
    })()`);
  }

  async function waitForReadyView(browser, predicate, description, timeoutMs = 2 * 60_000) {
    await browser.openWallet();
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await readyView(browser);
        if (predicate(last)) return last;
      } catch (cause) {
        last = { error: cause instanceof Error ? cause.message : String(cause) };
      }
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ${description}; last=${JSON.stringify({
      balance: last?.balance,
      noPendingTransactions: last?.noPendingTransactions,
      hasConfirmedTransaction: last?.hasConfirmedTransaction,
      historyCurrent: last?.historyCurrent,
      error: last?.error,
    })}`);
  }

  function assertBalance(view, expected, options = {}) {
    assert.equal(view.balance, displayPcash(expected));
    if (options.allowConfirmed === true) {
      assert.equal(view.hasConfirmedTransaction, true);
    } else {
      assert.equal(view.noPendingTransactions, true);
    }
  }

  /** The reviewed payment's summary line: what the recipient and the relayer get, as exact amounts. */
  async function reviewView(browser) {
    await browser.waitFor(`document.querySelector('dialog[open] #send [data-testid="payment-split"] [data-split="relayer-fee"]') !== null
      && [...document.querySelectorAll("#send button")].some((button) => /Proving|Sending/.test(button.textContent ?? ""))
      && document.querySelector('[role="alert"]') === null`, {
      description: "the private payment being proved",
      timeoutMs: 60_000,
    });
    return browser.evaluate(`(() => {
      const split = document.querySelector('dialog[open] #send [data-testid="payment-split"]');
      if (!split) throw new Error("Payment summary is missing");
      const exact = (name) => split.querySelector('[data-split="' + name + '"] [aria-label]')?.getAttribute("aria-label");
      const recipientInput = [...document.querySelectorAll("dialog[open] #send label")]
        .find((label) => label.textContent.trim() === "Recipient")?.querySelector("input");
      return { relayerFee: exact("relayer-fee"), recipient: exact("recipient"),
        recipientAddress: recipientInput?.value.toLowerCase(),
        locked: document.querySelector("dialog[open] #send fieldset")?.disabled };
    })()`);
  }

  async function setRecipientHistory(browser, ownerAddress, recipientAddress) {
    const recipientPath = `/${recipientAddress}`;
    const ownerPath = `/${ownerAddress}`;
    const sendPath = `${ownerPath}?${new URLSearchParams({ to: recipientAddress })}#send`;
    // Navigation leaves the wallet open, so close it before seeding the history.
    if (await browser.evaluate('document.querySelector("dialog[open]") !== null')) await closeWallet(browser);
    // Seed adjacent SPA history entries, then exercise actual Back/Forward below.
    await browser.evaluate(`(() => {
      history.replaceState(history.state, "", ${JSON.stringify(recipientPath)});
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    })()`);
    await browser.waitFor(`location.pathname.toLowerCase() === ${JSON.stringify(recipientPath.toLowerCase())} && document.querySelector("dialog[open] #send") === null`, {
      description: "the recipient address preceding the owner's send URL",
    });
    await browser.evaluate(`(() => {
      history.pushState({ ...history.state, idx: (history.state?.idx ?? 0) + 1, key: "recipient-payment" }, "", ${JSON.stringify(sendPath)});
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    })()`);
    await browser.waitFor(`document.querySelector("dialog[open] #send input")?.value === ${JSON.stringify(recipientAddress)}`, {
      description: "the URL recipient populated in the owner's send form",
    });
    return { ownerPath, recipientPath };
  }

  async function backAndForwardSend(browser, { ownerPath, recipientPath }, hashOnly = false) {
    await browser.evaluate("history.back()");
    // Back and Forward preserve the wallet panel and its payment form.
    await browser.waitFor(hashOnly
      ? `location.pathname.toLowerCase() === ${JSON.stringify(ownerPath.toLowerCase())} && location.hash === ""`
      : `location.pathname.toLowerCase() === ${JSON.stringify(recipientPath.toLowerCase())}`, {
      description: hashOnly ? "Hash-only Back leaves the send URL without leaving the owner page" : "Back leaves the owner send URL",
    });
    await browser.evaluate("history.forward()");
    await browser.waitFor(`location.pathname.toLowerCase() === ${JSON.stringify(ownerPath.toLowerCase())} && document.querySelector("dialog[open] #send form") !== null`, {
      description: "Forward restores the owner send form",
    });
  }

  const RELAYER_FEE_INPUT = `[...document.querySelectorAll("#send label")].find(label => label.textContent.startsWith("Relayer fee (PCASH)"))?.querySelector("input")`;

  /** The relayer fee the form shows once the per-action issuance quote prefills it. */
  async function prefilledRelayerFee(browser) {
    await browser.waitFor(`(${RELAYER_FEE_INPUT})?.value !== "" && (${RELAYER_FEE_INPUT})?.value !== undefined`, {
      description: "the per-action issuance quote prefills the relayer fee",
    });
    return parseUnits(await browser.evaluate(`(${RELAYER_FEE_INPUT}).value`), 18);
  }

  async function reviewAmount(browser, amount) {
    await browser.fillLabeledInput("Amount", formatPcashInput(amount));
    const prefilled = await prefilledRelayerFee(browser);
    await browser.waitFor(`[...document.querySelectorAll("#send button")].some((button) => button.textContent?.trim() === "Send" && !button.disabled)`, {
      description: "the send lifecycle settles so another payment can be sent", timeoutMs: 60_000,
    });
    await browser.clickButton("Send");
    const review = await reviewView(browser);
    const fee = parseUnits(review.relayerFee.replace(" PCASH", "").replaceAll(",", ""), 18);
    assert.equal(fee, prefilled, "the prefilled relayer fee on screen is the fee submitted");
  }

  async function cancelAcrossHistory(browser, paths, amount, hashOnly, before) {
    if (hashOnly) {
      await closeWallet(browser);
      await browser.evaluate(`history.pushState({ ...history.state, idx: (history.state?.idx ?? 0) + 1, key: "send-fragment" }, "", location.pathname + location.search + "#send"); dispatchEvent(new PopStateEvent("popstate", { state: history.state }))`);
      await browser.waitFor('document.querySelector("dialog[open] #send form") !== null');
    }
    await reviewAmount(browser, amount);
    await waitForSendProgress(browser);
    assert.equal(await browser.evaluate(`[...document.querySelectorAll("#send button")].some((button) => button.textContent?.includes("Proving") && button.disabled)`), true, "the payment shows its proof in progress");
    await browser.waitFor(`[...document.querySelectorAll("#send button")].some((button) => button.textContent?.trim() === "Cancel")`, {
      description: "an active cancellable proof", timeoutMs: 60_000,
    });
    await browser.clickButton("Cancel");
    await browser.waitFor(`document.querySelector("dialog[open] #send form fieldset:not([disabled])") !== null`, { description: "explicit cancellation unlocks the payment form", timeoutMs: 60_000 });
    await backAndForwardSend(browser, paths, hashOnly);
    await browser.waitFor(`[...document.querySelectorAll("#send button")].some((button) => button.textContent?.trim() === "Send" && !button.disabled)`, {
      description: "proving cancellation releases the busy state", timeoutMs: 60_000,
    });
    const after = await waitForReadyView(browser,
      (view) => view.historyCurrent && view.noPendingTransactions,
      "the recovered activity after explicit proof cancellation and navigation");
    assert.deepEqual(after.outgoingPaymentLinks, before.outgoingPaymentLinks, "a canceled proof must not create submitted activity");
    await setRecipientHistory(browser, paths.ownerPath.slice("/".length), paths.recipientPath.slice("/".length));
  }

  async function trackPaymentWork(browser) {
    await browser.evaluate(`(() => {
      window.paymentWorkProbe?.restore();
      const originalFetch = window.fetch;
      const originalPost = Worker.prototype.postMessage;
      const counts = { proofs: 0, submissions: 0 };
      const submitted = [];
      window.fetch = function(...args) {
        try {
          const request = JSON.parse(args[1]?.body);
          if (["pcash_submitRawTransaction", "eth_sendTransaction"].includes(request.method)) counts.submissions += 1;
          if (request.method === "pcash_submitRawTransaction") submitted.push(request.params[0]);
        } catch {}
        return originalFetch.apply(this, args);
      };
      Worker.prototype.postMessage = function(message, ...args) {
        if (message?.kind === "chonk") counts.proofs += 1;
        return originalPost.call(this, message, ...args);
      };
      window.paymentWorkProbe = { counts, submitted, restore: () => { window.fetch = originalFetch; Worker.prototype.postMessage = originalPost; } };
    })()`);
  }

  async function waitForPayment(browser, expression, options) {
    const result = await browser.waitFor(`(() => {
      const error = document.querySelector("dialog[open] #send [role=alert]")?.textContent?.trim();
      if (error) return { error };
      return (${expression}) ? { ready: true } : false;
    })()`, options);
    if (result.error) throw new Error(`Payment failed: ${result.error}`);
  }

  /** A proved payment submits by itself; the card then names where it went and links its transaction. */
  async function waitForSentPayment(browser, provider, providerRequests, transactionsBefore) {
    await waitForPayment(browser, `document.querySelector("dialog[open] #send h2")?.textContent === "Payment sent"`, {
      description: "the proved payment submits without a second confirmation",
      timeoutMs: 20 * 60_000,
      intervalMs: 250,
    });
    assert.deepEqual(await browser.evaluate("({ ...window.paymentWorkProbe.counts })"), { proofs: 1, submissions: 1 }, "Send proves once and broadcasts that proof exactly once");
    const sent = await browser.evaluate(`(() => {
      const rows = Object.fromEntries([...document.querySelectorAll("dialog[open] #send dt")].map((term) => [term.textContent.trim(), term.nextElementSibling]));
      return { sentTo: rows["Sent to"]?.textContent.trim(), href: rows["PCASH transaction"]?.querySelector("a")?.getAttribute("href") };
    })()`);
    assert.equal(sent.sentTo, "PCASH mempool (L2)");
    assert.match(sent.href ?? "", /^\/tx\/0x[0-9a-f]{64}$/, "a relayed payment links its PCASH transaction in the explorer");
    await browser.clickButton("Done");
    await waitForPayment(browser, `document.querySelector('dialog[open][data-view="overview"] [data-payment-highlighted="true"][data-payment-id]') !== null
      && document.querySelector("dialog[open] #send") === null`, {
      description: "Done returns to the wallet with the new payment highlighted",
      timeoutMs: 60_000,
      intervalMs: 250,
    });
    const submissionRequests = provider.requestLog.slice(providerRequests);
    // A relayed payment goes to the node mempool; the relayer publishes it and collects its fee and issuance.
    assert.equal(submissionRequests.filter(({ method }) => method === "eth_sendTransaction").length, 0, "a relayed payment is not published from the sender's Ethereum account");
    assert.equal(provider.sentTransactions.length, transactionsBefore, "the payment is admitted to the mempool, not broadcast by the sender");
  }

  async function waitForSendProgress(browser) {
    await browser.waitFor(`document.querySelector("dialog[open] #send [role=status]")?.textContent?.trim().length > 0`, {
      description: "visible in-card payment progress after signing",
      timeoutMs: 60_000,
    });
  }

  function browserFailures(browser) {
    return browser.events().filter((event) => {
      if (event.type === "pageerror") return true;
      if (event.type !== "error") return false;
      return /hydration|did not match|server rendered|Minified React error #4(?:18|19|20|21|22|23)/i.test(event.message);
    });
  }

  function providerEvidence(provider) {
    return provider.requestLog.map((request) => {
      if (request.method !== "eth_signTypedData_v4") return { method: request.method };
      let primaryType = "invalid";
      try { primaryType = typedData(request).value.primaryType; } catch {}
      return { method: request.method, primaryType };
    });
  }

  async function startActorBrowser({ actor, network, siteUrl, accountPath, l1RpcUrl }) {
    const session = await journey.actor({ actor, network, l1RpcUrl });
    const { browser } = session;
    await browser.addInitScript(`Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { sessionStorage.setItem("journey-clipboard", text); } } });`);
    await browser.navigate(`${siteUrl}${accountPath}`);
    await waitForDisconnected(browser);
    assert.equal(await browser.evaluate("globalThis.crossOriginIsolated"), true);
    await connectAndDerive(browser);
    return session;
  }

  let fixture;
  let siteLease;
  let site;
  let recipient;
  let sender;
  let failure;

  try {
    if (!bundle?.trim()) {
      throw new Error("PCASH_CIRCUIT_BUNDLE is required for the funded browser journey");
    }
    siteLease = await leasePorts(1);
    const sitePort = siteLease.ports[0];
    process.env.PCASH_PROVER_ASSETS_BASE_URL = `http://127.0.0.1:${sitePort}/`;
    const proverManifest = join(root, "assets/browser-prover-release.json");
    process.env.PCASH_PROVER_ASSETS_MANIFEST = proverManifest;
    fixture = await ScenarioFixture.create({
      name: "wallet-browser-funded-send",
      env: process.env,
      keepArtifacts: true,
      artifactsRoot: testInfo.outputPath("node"),
      nodeCount: 1,
      // Browser wallets pay their own Ethereum gas, so both actors are funded Anvil accounts.
      actorKeys: {
        S: settings.str("actor-1-key")?.trim() ? validPrivateKey(settings.str("actor-1-key"), "PCASH_E2E_ACTOR_1_KEY") : ANVIL_ACCOUNTS.S,
        R: settings.str("actor-2-key")?.trim() ? validPrivateKey(settings.str("actor-2-key"), "PCASH_E2E_ACTOR_2_KEY") : ANVIL_ACCOUNTS.R,
      },
    });
    await setupAnvilMulticall3((method, params) => l1Rpc(fixture.backend.rpcUrl, method, params));
    const balanceCheck = await l1Rpc(fixture.backend.rpcUrl, "eth_call", [{
      to: MULTICALL3_ADDRESS, data: `0x4d2301cc${"00".repeat(32)}`,
    }, "latest"]);
    assert.match(balanceCheck, /^0x[0-9a-fA-F]{64}$/, "Multicall3 native balance read must return one ABI word");
    const nativeBalance = await l1Rpc(fixture.backend.rpcUrl, "eth_getBalance", [`0x${"00".repeat(20)}`, "latest"]);
    assert.equal(BigInt(balanceCheck), BigInt(nativeBalance), "Multicall3 balance must match native eth_getBalance");
    const balances = await setupUserWallets(fixture, {
      actors: ["S", "R"],
      accounts: ["R"],
      funded: ["S"],
    });
    const S = fixture.actors.S;
    const R = fixture.actors.R;
    const earned = balances.S;
    if (!S || !R || earned === undefined) throw new Error("funded browser fixture did not create S and R");
    // Browser payments wait in the mempool for a relayer, as they would on a public network.
    fixture.harness.startAutoRelay();
    // Move the entire native inventory into L before opening either browser.
    // Browser payment proving must stay S, even though every native input now
    // originates in the native-proved L transaction or the system payout note S
    // collects for publishing it itself.
    const largeFunding = await (await S.client()).send({
      to: S.address, amount: earned, openFeeAmount: 0n, shape: 1, submission: fixture.harness.l1(S.wallet),
    });
    const largeAccepted = await fixture.waitForAcceptedAcrossNodes(largeFunding.contentHash, "browser-native-L-funding");
    const largeTransaction = await eventually("indexed native L funding", () => fixture.nodeA.client.getTransaction(largeAccepted.nodeA.transactionId), transaction => transaction !== null);
    const largeEntry = decodeTransaction(fromHex(largeTransaction.rawTransaction));
    assert.equal(largeEntry.kind, 0);
    assert.equal(largeEntry.shape, 1);
    const funded = await S.balance({ rescan: true });
    fixture.artifacts.record("funded-browser-native-L-inventory", {
      contentHash: largeFunding.contentHash, transactionId: largeAccepted.nodeA.transactionId, balance: funded,
    });
    const initialBalance = funded;
    // The remainder leaves room for both payments' default fees. The site takes PCASH only in whole units.
    const wholePcash = (value) => value / 10n ** 18n * 10n ** 18n;
    const amount = wholePcash(funded * 3n / 4n);
    const selfAmount = wholePcash(funded / 8n);
    if (amount < 1n || selfAmount < 1n) throw new Error("earned browser balance is too small to test note payments");

    const env = {
      ...process.env,
      PCASH_REQUIRE_PROVER_ASSETS: "1",
      PCASH_RPC_URL: fixture.nodeA.rpcUrl,
      PCASH_CHAIN_ID: fixture.network.pcashChainId.toString(),
      PCASH_L1_CHAIN_ID: fixture.network.l1ChainId.toString(),
      PCASH_BROWSER_L1_RPC_URLS: fixture.backend.rpcUrl,
      PCASH_PAYMENT_ROUTER_ADDRESS: `0x${"12".repeat(20)}`,
      PCASH_PAYMENT_ROUTER_FEE_RECIPIENT: `0x${"34".repeat(20)}`,
      PCASH_PAYMENT_ROUTER_FEE_BPS: "500",
    };
    const website = buildWebsite(testInfo, env);
    stageWebsite(website, fixture.binaries.toolRoot);
    await siteLease.release();
    site = await journey.host({ root: website, port: sitePort });

    // Both accounts were registered by the fixture; the browser owns payment behavior.
    recipient = await startActorBrowser({
      actor: R,
      network: fixture.network,
      siteUrl: site.url,
      accountPath: "/#wallet",
      l1RpcUrl: fixture.backend.rpcUrl,
    });

    sender = await startActorBrowser({
      actor: S,
      network: fixture.network,
      siteUrl: site.url,
      accountPath: "/#wallet",
      l1RpcUrl: fixture.backend.rpcUrl,
    });
    const senderInitial = await waitForReadyView(sender.browser,
      (view) => view.balance === displayPcash(initialBalance) && view.noPendingTransactions && view.historyCurrent,
      "the initial sender balance and recovered history");
    assertBalance(senderInitial, initialBalance);
    await captureOwner(sender.browser, "owner-initial");
    fixture.artifacts.record("funded-browser-sender-ready", {
      address: S.address,
      balance: initialBalance,
      currentBlock: senderInitial.status["Current block"],
    });

    await checkGlobalWallet(sender.browser, S.address);
    await checkSendDrawer(sender.browser);
    const historyPaths = await setRecipientHistory(sender.browser, S.address, R.address);
    await cancelAcrossHistory(sender.browser, historyPaths, amount, true, senderInitial);
    await cancelAcrossHistory(sender.browser, historyPaths, amount, false, senderInitial);
    logger.info("funded browser: explicit cancellation leaves no submission across Back/Forward");

    await trackPaymentWork(sender.browser);
    await sender.browser.fillLabeledInput("Recipient", R.address);
    await sender.browser.fillLabeledInput("Amount", formatPcashInput(amount));
    const enteredFee = 2n * await prefilledRelayerFee(sender.browser);
    await sender.browser.fillLabeledInput("Relayer fee (PCASH)", formatPcashInput(enteredFee));
    let approvedFee;
    const originalPaymentRequest = sender.provider.request.bind(sender.provider);
    let rejectPaymentSignature;
    sender.provider.request = (request) => request.method === "eth_signTypedData_v4"
      ? new Promise((_resolve, reject) => { rejectPaymentSignature = reject; })
      : originalPaymentRequest(request);
    try {
      await sender.browser.clickButton("Send");
      await sender.browser.waitFor(`[...document.querySelectorAll("dialog[open] #send [role=status]")].some((status) => status.textContent.includes("Approve the free signature in your wallet to continue."))`, {
        description: "a pending payment signature explains what the wallet is waiting for",
        timeoutMs: 60_000,
      });
      const approved = await reviewView(sender.browser);
      approvedFee = parseUnits(approved.relayerFee.replace(" PCASH", "").replaceAll(",", ""), 18);
      assert.equal(approvedFee, enteredFee, "the entered relayer fee is the fee submitted");
      const signatureDeadline = Date.now() + 10_000;
      while (rejectPaymentSignature === undefined && Date.now() < signatureDeadline) await sleep(10);
      assert.equal(typeof rejectPaymentSignature, "function");
      assert.equal(await sender.browser.evaluate(`[...document.querySelectorAll("#send button")].some((button) => button.textContent?.includes("Proving") && button.disabled)`), true, "payment cannot be sent before signature and proof complete");
      assert.deepEqual(await sender.browser.evaluate("({ ...window.paymentWorkProbe.counts })"), { proofs: 0, submissions: 0 }, "a pending signature cannot prove or broadcast a payment");
      await captureOwner(sender.browser, "payment-awaiting-signature-desktop");
      rejectPaymentSignature({ code: 4001, message: "Payment signature declined by journey" });
      await sender.browser.waitFor(`[...document.querySelectorAll("#send button")].some((button) => button.textContent?.trim() === "Try again" && !button.disabled)
        && document.querySelector("dialog[open] #send fieldset")?.disabled === false
        && document.querySelector("#send [role=alert]")?.textContent.includes("You rejected the request in your wallet.")`, {
        description: "a declined payment signature unlocks the form with its values and offers Try again",
      });
    } finally {
      sender.provider.request = originalPaymentRequest;
      rejectPaymentSignature?.({ code: 4001, message: "Journey signature cleanup" });
    }
    const transferRequestOffset = sender.provider.requestLog.length;
    const transferTransactions = sender.provider.sentTransactions.length;
    await sender.browser.clickButton("Try again");
    const review = await reviewView(sender.browser);
    await captureOwner(sender.browser, "send-review-desktop");
    // The locked form keeps the entered recipient; the summary keeps the reviewed amounts.
    assert.equal(review.locked, true);
    assert.equal(review.recipientAddress, R.address.toLowerCase());
    assert.equal(parseUnits(review.relayerFee.replace(" PCASH", "").replaceAll(",", ""), 18), approvedFee, "retry retains the reviewed fee");
    assert.equal(review.recipient, displayPcash(amount));
    await waitForSentPayment(sender.browser, sender.provider, transferRequestOffset, transferTransactions);
    await captureOwner(sender.browser, "wallet-payment-highlight-mobile", 390);
    await captureOwner(sender.browser, "wallet-payment-highlight-desktop");
    await sender.browser.evaluate("history.back()");
    await sender.browser.waitFor(`location.pathname.toLowerCase() === ${JSON.stringify(historyPaths.recipientPath.toLowerCase())} && document.querySelector("dialog[open]") !== null`, { description: "Back leaves the submitted payment without closing the wallet" });
    await sender.browser.evaluate("history.forward()");
    await sender.browser.waitFor(`location.pathname.toLowerCase() === ${JSON.stringify(historyPaths.ownerPath.toLowerCase())}`, { description: "Forward restores the account after submission" });
    await sender.browser.openWallet();
    await sender.browser.waitFor(`[...document.querySelectorAll("#wallet-activity a")].some((link) => link.getAttribute("href")?.startsWith("/tx/"))`, {
      description: "the accepted browser-proved private payment",
      timeoutMs: 20 * 60_000,
      intervalMs: 250,
    });
    assertTransferAuthorization(sender.provider, transferRequestOffset, S, R, amount, fixture.network);
    const [paymentHex] = await sender.browser.evaluate("window.paymentWorkProbe.submitted");
    const browserPayment = decodeTransaction(fromHex(paymentHex));
    assert.equal(browserPayment.kind, 0);
    assert.equal(browserPayment.shape, 0, "the browser spends L-created native inventory using S");
    const paymentContentHash = keccak256(paymentHex);
    await fixture.waitForAcceptedAcrossNodes(paymentContentHash, "browser-relayed-payment");
    await assertSystemPayoutRecovered({
      node: fixture.nodeA.client,
      chainId: fixture.network.pcashChainId,
      contentHash: paymentContentHash,
      label: "browser relayed payment",
      sourceKind: "posterPayout",
      recipient: derivePcashProfileFromPrivateKey(fromHex(fixture.harness.privateKey), fixture.network),
    });
    fixture.artifacts.record("funded-browser-payment-accepted", {
      sender: S.address,
      recipient: R.address,
      amount,
      providerRequests: providerEvidence(sender.provider).slice(transferRequestOffset),
    });

    const receivedRecipient = await waitForReadyView(recipient.browser,
      (view) => view.noPendingTransactions && view.historyCurrent
        && view.incomingRows === 1,
      "the received payment in the recipient's history");
    assert.equal(receivedRecipient.incomingRows, 1, "the private payment appears as one incoming activity row");
    assert.ok(receivedRecipient.balance !== "", "the recipient's balance is visible");
    assert.deepEqual(browserFailures(recipient.browser), []);
    fixture.artifacts.record("funded-browser-recipient-received", {
      address: R.address,
      balance: amount,
      currentBlock: receivedRecipient.status["Current block"],
    });
    // Keep the recipient context available for failure diagnostics until fixture teardown.
    recipient = undefined;

    const finalizedPayment = await waitForReadyView(sender.browser,
      (view) => view.hasFinalizedTransaction && view.paymentLinks.length > 0,
      "the outgoing payment retained after finality", 120_000);
    const receiptPath = finalizedPayment.paymentLinks[0];
    const reconnectOffset = sender.provider.requestLog.length;
    await sender.browser.reload();
    // The saved sign-in restores this session on its own. Asserting that no second
    // signature is requested is the property that matters here: a wallet derived
    // from one signature must never ask for it again.
    const senderBalanceAfterPayment = await S.balance({ rescan: true });
    const senderAfterPayment = await waitForReadyView(
      sender.browser,
      (view) => view.balance === displayPcash(senderBalanceAfterPayment)
        && (view.hasConfirmedTransaction),
      "the sender balance after its private-note payment",
    );
    assertBalance(senderAfterPayment, senderBalanceAfterPayment, { allowConfirmed: true });
    assert.deepEqual(await sender.browser.evaluate("window.navigationCopyFailures"), [], "cold account reload does not flash node connection prose");
    assert.equal(senderAfterPayment.hasFinalizedTransaction, true);
    assert.ok(senderAfterPayment.paymentLinks.includes(receiptPath), "finalized receipt link must survive reload");
    assert.equal(
      sender.provider.requestLog.slice(reconnectOffset).some(({ method }) => method === "eth_signTypedData_v4"),
      false,
      "reloading must restore the saved sign-in without a new signature",
    );
    assert.deepEqual(browserFailures(sender.browser), []);
    fixture.artifacts.record("funded-browser-sender-reconciled", {
      address: S.address,
      balance: senderBalanceAfterPayment,
      currentBlock: senderAfterPayment.status["Current block"],
      providerRequests: providerEvidence(sender.provider).slice(reconnectOffset),
    });

    const beforeSelfHistory = await readyView(sender.browser);
    await sender.browser.openWallet();
    await sender.browser.waitFor(`[...document.querySelectorAll('dialog[open] button')].some(button => button.textContent.trim() === "Send" && !button.disabled)`, {
      description: "the wallet overview is ready to send",
    });
    await sender.browser.evaluate(`[...document.querySelectorAll('dialog[open] button')].find((button) => button.textContent.trim() === "Send").click()`);
    await sender.browser.waitFor('document.querySelector("dialog[open] #send form") !== null');
    await trackPaymentWork(sender.browser);
    const selfRequestOffset = sender.provider.requestLog.length;
    const selfTransactions = sender.provider.sentTransactions.length;
    await sender.browser.fillLabeledInput("Recipient", S.address);
    await sender.browser.fillLabeledInput("Amount", formatPcashInput(selfAmount));
    await prefilledRelayerFee(sender.browser);
    await sender.browser.clickButton("Send");
    const selfReview = await reviewView(sender.browser);
    assert.equal(selfReview.locked, true);
    assert.equal(selfReview.recipientAddress, S.address.toLowerCase());
    assert.notEqual(selfReview.relayerFee, "0 PCASH", "the prefilled relayer fee is positive");
    await waitForSentPayment(sender.browser, sender.provider, selfRequestOffset, selfTransactions);
    await sender.browser.waitFor(`document.querySelector('dialog[open][data-view="overview"] [data-payment-highlighted="true"]') !== null`, {
      description: "the accepted browser-proved self-payment",
      timeoutMs: 20 * 60_000,
      intervalMs: 250,
    });
    assertTransferAuthorization(sender.provider, selfRequestOffset, S, S, selfAmount, fixture.network);
    const [selfPaymentHex] = await sender.browser.evaluate("window.paymentWorkProbe.submitted");
    await fixture.waitForAcceptedAcrossNodes(keccak256(selfPaymentHex), "browser-self-payment");
    const selfFee = transactionPublication(fromHex(selfPaymentHex)).openFeeAmount;
    const senderBalanceAfterSelf = senderBalanceAfterPayment - selfFee;
    await eventually("self-payment outputs recovered by the wallet scan",
      () => S.balance({ rescan: true }),
      balance => balance === senderBalanceAfterSelf, { timeoutMs: 120_000 });
    const senderFinal = await waitForReadyView(
      sender.browser,
      (view) => view.balance === displayPcash(senderBalanceAfterSelf)
        && view.hasConfirmedTransaction
        && view.historyCurrent && !view.historyChecking && view.historyHead !== beforeSelfHistory.historyHead
        && view.acceptedPaymentLinks.some((link) => !senderAfterPayment.paymentLinks.includes(link)),
      "the sender note-funded self-payment",
    );
    assertBalance(senderFinal, senderBalanceAfterSelf, { allowConfirmed: true });
    if (settings.str("owner-screenshots")) {
      await sender.browser.openWallet();
      await captureOwner(sender.browser, "owner-desktop");
      await captureOwner(sender.browser, "owner-mobile", 390);
    }
    fixture.artifacts.record("funded-browser-self-send", {
      address: S.address,
      amount: selfAmount,
      balance: senderBalanceAfterSelf,
      currentBlock: senderFinal.status["Current block"],
      providerRequests: providerEvidence(sender.provider).slice(selfRequestOffset),
    });

    await sender.browser.openWallet();
    await sender.browser.waitFor(`[...document.querySelectorAll('dialog[open] button')].some(button => button.textContent.trim() === "Send" && !button.disabled)`, {
      description: "the wallet overview is ready to send",
    });
    await sender.browser.evaluate(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent.trim() === "Send").click()`);
    await sender.browser.waitFor('document.querySelector("dialog[open] #send form") !== null');
    await sender.browser.fillLabeledInput("Recipient", R.address);
    await sender.browser.fillLabeledInput("Amount", "1");
    await sender.browser.evaluate('document.querySelector("#send input[value=fast]").click()');
    const fastRequestOffset = sender.provider.requestLog.length;
    const fastTransactionOffset = sender.provider.sentTransactions.length;
    await sender.browser.clickButton("Send");
    await waitForPayment(sender.browser, `document.querySelector("dialog[open] #send h2")?.textContent === "Payment submitted"`, {
      description: "Fast publishes from the connected Ethereum wallet", timeoutMs: 20 * 60_000, intervalMs: 250,
    });
    assert.equal(sender.provider.sentTransactions.length, fastTransactionOffset + 1);
    const fastAuthorization = sender.provider.requestLog.slice(fastRequestOffset).find(request => request.method === "eth_signTypedData_v4");
    const fastMessage = typedData(fastAuthorization).value.message;
    assert.equal(BigInt(fastMessage.openFeeAmount), 0n, "a Fast payment carries no PCASH open fee");
    assert.notEqual(BigInt(fastMessage.issuanceOwnerCommitment), 0n, "Fast retains its designated destination");
    const fastBatch = decodeBatch(fromHex(sender.provider.sentTransactions.at(-1).data));
    const fastIndex = fastBatch.items.findIndex(bytes => transactionPublication(bytes)?.issuanceOwnerCommitment === BigInt(fastMessage.issuanceOwnerCommitment));
    assert.ok(fastIndex >= 0, "the signed payment is present in the finalized batch");
    const fastHash = keccak256(fastBatch.items[fastIndex]);
    await fixture.waitForAcceptedAcrossNodes(fastHash, "browser-fast-payment");
    const returned = await assertSystemPayoutRecovered({ node: fixture.nodeA.client, chainId: fixture.network.pcashChainId,
      contentHash: fastHash, label: "browser Fast issuance", sourceKind: "designatedIssuance",
      recipient: derivePcashProfileFromPrivateKey(fromHex(S.privateKey), fixture.network) });
    assert.equal(returned.receipt.settledOpenFeeAmount, 0n);
    fixture.artifacts.record("funded-browser-fast-send", { contentHash: fastHash, batchItemIndex: fastIndex, openFeeAmount: fastMessage.openFeeAmount });

    for (const actor of [sender, recipient]) {
      if (!actor) continue;
      const largeArtifacts = await actor.browser.evaluate('performance.getEntriesByType("resource").filter(entry => /(?:large|shared_asset_claim).*\\.(?:json|vk)/.test(entry.name)).map(entry => entry.name)');
      assert.deepEqual(largeArtifacts, [], "browser S spending and L receiving must not fetch L-only artifacts");
    }
    logger.info(`funded wallet browser journey passed (${funded} private payment, ${selfAmount} note-funded self-payment, entered relayer fee retry, Fast zero-fee issuance)`);
  } catch (cause) {
    failure = cause;
    logger.error("funded wallet browser journey diagnostics", JSON.stringify({
      senderBody: await sender?.browser.evaluate("document.body?.innerText").catch(() => undefined),
      recipientBody: await recipient?.browser.evaluate("document.body?.innerText").catch(() => undefined),
      senderProvider: sender ? providerEvidence(sender.provider) : [],
      recipientProvider: recipient ? providerEvidence(recipient.provider) : [],
      senderBrowser: sender ? browserFailures(sender.browser).slice(-20) : [],
      recipientBrowser: recipient ? browserFailures(recipient.browser).slice(-20) : [],
    }, null, 2));
    throw cause;
  } finally {
    let cleanupFailure;
    try { await siteLease?.release(); } catch (cause) { cleanupFailure = cause; }
    if (cleanupFailure && fixture) {
      fixture.artifacts.record("browser-cleanup-failed", { message: cleanupFailure.message });
    }
    let finishFailure;
    try {
      await fixture?.finish(failure ?? cleanupFailure);
      const resultPath = settings.str("funded-browser-result")?.trim();
      if (fixture && resultPath) copyFileSync(join(fixture.artifacts.root, "evidence.json"), resultPath);
    } catch (cause) {
      finishFailure = cause;
    }
    if (failure === undefined) {
      const finalErrors = [cleanupFailure, finishFailure].filter((cause) => cause !== undefined);
      if (finalErrors.length === 1) throw finalErrors[0];
      if (finalErrors.length > 1) throw new AggregateError(finalErrors, "funded Wallet journey teardown failed");
    } else if (cleanupFailure || finishFailure) {
      logger.error("funded wallet browser journey teardown also failed", cleanupFailure ?? finishFailure);
    }
  }
});
