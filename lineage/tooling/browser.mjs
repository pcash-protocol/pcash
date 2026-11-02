import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const output = process.argv[2] ?? "lineage-browser-results";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true });
try {
  const page = await browser.newPage();
  page.on("pageerror", error => console.error(error.message));
  await page.goto(process.env.PROOF_LAB_URL ?? "http://127.0.0.1:4488/");
  await page.locator("#threads").selectOption("1");
  await page.locator("#memory-limit").selectOption("1024");
  await page.locator("#runs").selectOption("3");
  await page.locator("#device-name").fill("Desktop Chrome; 1 thread, 1024 MiB Wasm ceiling");
  for (const [id, label] of [["lineageControl", "Lineage control (SDK no-op)"], ["lineageEvent", "Private lineage event"]]) {
    const button = page.locator("button.scenario").filter({ has: page.locator("strong", { hasText: label }) });
    await button.click({ timeout: 60_000 });
    await page.waitForFunction(expected => {
      try { const report = JSON.parse(document.querySelector("#result").textContent); return !!report.finishedAt && report.scenarios.some(item => item.id === expected); } catch { return false; }
    }, id, { timeout: 600_000 });
    const report = JSON.parse(await page.locator("#result").textContent());
    await writeFile(join(output, `${id}-desktop.json`), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
    if (report.scenarios.some(item => item.error || item.runs.some(run => !run.ok))) throw new Error(`${id} failed`);
  }
} finally { await browser.close(); }
