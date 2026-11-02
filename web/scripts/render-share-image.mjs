// Renders scripts/share-image/share-image.html to public/og.jpg, the link-preview
// image every page names in og:image. Uses the installed Chrome; set
// PCASH_WEB_BROWSER_CHROME to use another executable.
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { Config } from "@pcash/sdk/bcfg";
import { Logger } from "@pcash/sdk/blgr";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const page = join(webRoot, "scripts/share-image/share-image.html");
const output = join(webRoot, "public/og.jpg");
// CSS masks load in CORS mode, so the page is served from an origin rather
// than file://. Requests to it are answered from disk.
const origin = "https://share-image.invalid";
const types = { ".html": "text/html", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg" };

const logger = new Logger("info");
await logger.open();
const config = new Config("pcash");
config.load({ argv: true, env: true });
const executablePath = config.str("web-browser-chrome");
const browser = await chromium.launch(executablePath === null ? { channel: "chrome" } : { executablePath });
try {
  const tab = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await tab.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = path === "/" ? page : join(webRoot, "public", normalize(path));
    await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] ?? "application/octet-stream" });
  });
  await tab.goto(`${origin}/`);
  await tab.evaluate(() => document.fonts.ready);
  await tab.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0));
  if (!await tab.evaluate(() => document.fonts.check('800 88px "Source Serif 4"'))) throw new Error("Source Serif 4 did not load");
  await tab.screenshot({ path: output, type: "jpeg", quality: 88 });
  logger.info(`wrote ${output}`);
} finally {
  await browser.close();
}
