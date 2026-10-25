import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { formatUnits } from "viem";
import { logger } from "../../src/framework/logger.ts";
import { e2eSettings } from "../../src/settings.ts";

const proofWait = { timeoutMs: 20 * 60_000, intervalMs: 250 };
async function tradeWait(browser, expression, description, timeoutMs = 120_000) {
  const result = await browser.waitFor(`(() => {
    const error = document.querySelector('[role="alert"]');
    if (error) return { error: error.textContent };
    const value = (${expression});
    return value ? { value } : false;
  })()`, { timeoutMs, intervalMs: 250, description });
  assert.equal(result.error, undefined, `${description}: ${result.error}`);
  logger.info(`marketplace browser: ${description}`);
  return result.value;
}

async function route(browser, path) {
  await browser.evaluate(`history.pushState({}, "", ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent("popstate"))`);
}

/** Opens the Create listing popup and waits for its form's default expiry. */
async function openListingForm(browser) {
  await browser.waitFor(`[...document.querySelectorAll("button")].some(b => b.textContent === "Create listing")`);
  await browser.clickButton("Create listing");
  await browser.waitFor('document.querySelector("#list-pcash select")?.value === "10080"');
}

async function captureMarketplace(browser, name) {
  const directory = e2eSettings().str("marketplace-screenshots");
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  for (const width of [1440, 390]) {
    await browser.screenshot({ width, height: 1000 });
    await browser.evaluate("scrollTo(0, 0); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert.ok(await browser.evaluate("document.documentElement.scrollWidth <= innerWidth"), `${name} overflows at ${width}px`);
    writeFileSync(join(directory, `${name}-${width}.png`), await browser.screenshot({ width, height: 1000 }));
  }
}

const PCASH = 10n ** 18n;
/** The largest whole PCASH amount at or below `value`; the site takes PCASH only in whole units. */
export const wholePcash = (value) => value / PCASH * PCASH;

/** Real funded browser trade, using the wallet journey's isolated Anvil actors. */
export async function marketplaceTrade({ seller, buyer, amount, fixture }) {
  // A listing prepares creation and funding together; the existing protocol still
  // authorizes each PCASH action separately before one Ethereum approval.
  await route(seller.browser, "/marketplace");
  await openListingForm(seller.browser);
  assert.equal(await seller.browser.evaluate(`[...document.querySelectorAll('main a, main button')].some(element => ['Listings', 'Your trades', 'List PCASH'].includes(element.textContent.trim()))`), false);
  await seller.browser.fillLabeledInput("PCASH amount", formatUnits(amount, 18));
  await seller.browser.fillLabeledInput("Total price in ETH", "0.001");
  assert.equal(await seller.browser.evaluate(`document.querySelector('#list-pcash input[type="radio"]')`), null, "listing has no Fast/Slow choice");
  await seller.browser.waitFor('document.querySelector(\'button[type="submit"]\')?.disabled === false');
  await captureMarketplace(seller.browser, "listing-form");
  const authorizationsBefore = seller.provider.requestLog.filter(({ method }) => method === "eth_signTypedData_v4").length;
  const registrationsBefore = seller.provider.requestLog.filter(({ method }) => method === "eth_sendTransaction").length;
  await seller.browser.evaluate('document.querySelector(\'button[type="submit"]\').click()');
  await seller.browser.waitFor(`document.querySelector('[aria-label="Listing creation progress"]') !== null`, { description: "structured offer creation progress" });
  await captureMarketplace(seller.browser, "publication-progress");
  assert.equal(await seller.browser.evaluate(`document.querySelector('[aria-current="step"]') !== null`), false);
  await route(seller.browser, "/");
  await seller.browser.waitFor(`document.querySelector('[aria-label="Marketplace progress"]') !== null`);
  await route(seller.browser, "/marketplace");
  await seller.browser.waitFor(`[...document.querySelectorAll("button")].some(b => b.textContent === "View listing progress")`);
  await seller.browser.clickButton("View listing progress");
  const listing = await tradeWait(seller.browser, `[...document.querySelectorAll("a")].find(a => a.textContent === "View listing")?.getAttribute("href")`, "offer funded and published", proofWait.timeoutMs);
  assert.match(listing, /\/marketplace\?offer=0x[0-9a-f]{40}$/, "published offers use a short listing link");
  const finalizationTransactions = seller.provider.requestLog.filter(({ method }) => method === "eth_sendTransaction").length - registrationsBefore;
  assert.equal(finalizationTransactions, 1, "a listing publishes creation and funding in one Ethereum transaction");
  assert.equal(seller.provider.requestLog.filter(({ method }) => method === "eth_signTypedData_v4").length - authorizationsBefore, 2,
    "the current protocol requires one PCASH authorization per action");
  await captureMarketplace(seller.browser, "listing-complete");

  const listingCount = 2;
  await seller.browser.clickButton("Done");
  await openListingForm(seller.browser);
  await seller.browser.fillLabeledInput("PCASH amount", formatUnits(wholePcash(amount / 2n), 18));
  await seller.browser.fillLabeledInput("Total price in ETH", "0.0006");
  await seller.browser.waitFor('document.querySelector(\'button[type="submit"]\')?.disabled === false');
  await seller.browser.clickButton("Publish listing");
  await tradeWait(seller.browser, `[...document.querySelectorAll("a")].some(a => a.textContent === "View listing")`, "second listing published", proofWait.timeoutMs);
  await seller.browser.clickButton("Done");

  await route(buyer.browser, "/marketplace");
  await buyer.browser.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent === "Refresh" && !b.disabled)');
  await buyer.browser.clickButton("Refresh");
  await tradeWait(buyer.browser, 'document.querySelector("[data-listing-select]") !== null', "offer discovered in catalog", 60_000);
  assert.equal(await buyer.browser.evaluate(`document.querySelector('[aria-label="Listings"] input[type="radio"]')`), null, "buying has no Fast/Slow choice");
  await buyer.browser.waitFor(`document.querySelectorAll('[data-listing-select]').length === ${listingCount}`);
  await buyer.browser.evaluate(`[...document.querySelectorAll('[data-listing-select]')].forEach(input => input.click())`);
  await tradeWait(buyer.browser, `[...document.querySelectorAll('button')].some(button => button.textContent === 'Buy' && !button.disabled)`, "purchase gas estimated", 60_000);
  await captureMarketplace(buyer.browser, "funded-listings");
  // One Ethereum transaction per listing pays for it and carries its claim.
  const purchaseTransactions = listingCount;
  const before = buyer.provider.requestLog.filter(({ method }) => method === "eth_sendTransaction").length;
  await buyer.browser.clickButton("Buy");
  await tradeWait(buyer.browser, `document.querySelector('[aria-label="Purchase"] [aria-label="Purchase status"]') !== null && location.pathname === "/marketplace"`, "selected purchases show progress under Buy");
  await captureMarketplace(buyer.browser, "checkout");
  await tradeWait(buyer.browser, `document.querySelector('[aria-label="Purchase receipt"] a[href^="/tx/"]') !== null`, "purchase success receipt", proofWait.timeoutMs);
  const purchases = buyer.provider.requestLog.filter(({ method }) => method === "eth_sendTransaction").slice(before);
  const claimPaths = await buyer.browser.evaluate(`[...document.querySelectorAll('[aria-label="Purchase receipt"] a[href^="/tx/"]')].map(a => a.getAttribute('href'))`);
  assert.equal(claimPaths.length, listingCount, "every purchase links its claim");
  const carriers = new Set();
  for (const [index, path] of claimPaths.entries()) {
    const claim = await fixture.waitForAcceptedAcrossNodes(path.slice(4), `marketplace-carried-claim-${index + 1}`);
    const [receipt] = await fixture.nodeA.client.getReceipt(claim.nodeA.transactionId);
    const [carrier, ...others] = await fixture.nodeA.client.getL1DeliveryBatches(receipt.inclusion.l1TransactionHash);
    assert.equal(others.length, 0, "the purchase transaction carries one batch");
    assert.equal(carrier?.carrierType, "event", "the claim travels in the router's event");
    assert.ok(purchases.some(({ params: [tx] }) => tx.to.toLowerCase() === carrier.emitter.toLowerCase()), "the buyer's purchase called the router that carried the claim");
    carriers.add(receipt.inclusion.l1TransactionHash.toLowerCase());
  }
  assert.equal(carriers.size, listingCount, "each purchase carries its own claim");
  assert.equal(await buyer.browser.evaluate('location.pathname'), '/marketplace');
  await captureMarketplace(buyer.browser, "purchase-success");
  await buyer.browser.clickButton("Open wallet");
  const completedPurchases = `document.querySelectorAll('[data-activity-kind="bought"][data-activity-state="complete"]').length === ${listingCount}`;
  await tradeWait(buyer.browser, completedPurchases, "PCASH received in wallet activity", proofWait.timeoutMs);
  assert.equal(buyer.provider.requestLog.filter(({ method }) => method === "eth_sendTransaction").length, before + purchaseTransactions,
    "The buyer sends one transaction per listing, which pays and claims");
  await buyer.browser.reload();
  await buyer.browser.openWallet();
  await buyer.browser.waitFor(completedPurchases, proofWait);
  assert.equal(buyer.provider.requestLog.filter(({ method }) => method === "eth_sendTransaction").length, before + purchaseTransactions,
    "reloading a completed purchase must not pay twice");
  await buyer.browser.clickButton("Close wallet");

  await route(buyer.browser, "/marketplace");
  await tradeWait(buyer.browser, 'document.body.innerText.includes("No open listings") && document.querySelectorAll("[data-listing-select]").length === 0', "filled offer removed from buyer listings");
  await route(seller.browser, "/marketplace");
  await seller.browser.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent === "Refresh" && !b.disabled)');
  await seller.browser.clickButton("Refresh");
  await tradeWait(seller.browser, 'document.body.innerText.includes("No open listings") && document.querySelectorAll("[data-listing-select]").length === 0', "filled offer removed from seller listings");
  fixture.artifacts.record("funded-browser-marketplace-trade", { amount, listing, ethPayments: listingCount });
}
