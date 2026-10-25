import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser",
  testMatch: "**/*.spec.{ts,mjs}",
  retries: 0,
  projects: [
    { name: "connection", testMatch: "**/connection.spec.mjs" },
    { name: "wallet", testMatch: "**/wallet.spec.mjs" },
    { name: "marketplace", testMatch: "**/marketplace.spec.mjs" },
    { name: "protocol", testMatch: "**/protocol.spec.mjs" },
    { name: "metamask", testMatch: "**/metamask/*.spec.ts" },
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 60 * 60_000,
  expect: { timeout: 2 * 60_000 },
  outputDir: "test-results/playwright",
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
});
