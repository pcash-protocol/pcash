import { test as base, expect } from '@playwright/test';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { startStaticHost } from './static_host.mjs';
import { circuitBundle, e2eSettings } from '../src/settings.ts';

import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DeterministicInjectedProvider } from './journey/injected_provider.mjs';
import { startInjectedProviderBridge } from './journey/provider_bridge.mjs';
import { createInjectedProviderSource } from './journey/page_provider.mjs';
import { resolveBrowserProverAssets, stageBrowserProverAssets } from '../../scripts/circuits/browser_assets.mjs';

const root = resolve(import.meta.dirname, '../..');

// Each test serves its own immutable copy. Production builds are serialized by
// the one-worker configuration; no live server reads the next test's web/dist.
export function buildWebsite(testInfo, env) {
  execFileSync('npm', ['run', 'build', '--workspace', '@pcash/web'], { cwd: root, env, stdio: 'inherit' });
  const destination = testInfo.outputPath('website');
  mkdirSync(destination, { recursive: true });
  cpSync(join(root, 'web/dist'), destination, { recursive: true });
  return destination;
}

export function stageWebsite(website, toolRoot, { versioned = true } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, 'assets/browser-prover-release.json'), 'utf8'));
  stageBrowserProverAssets(resolveBrowserProverAssets({ bundle: circuitBundle(), toolRoot, required: true }),
    versioned ? join(website, manifest.assetSetId) : website);
}

export const test = base.extend({
  journey: async ({ browser }, use, testInfo) => {
    const sessions = [];
    const servers = [];
    try {
      await use({
        async actor({ actor, network, l1RpcUrl }) {
          const client = createWalletClient({ account: privateKeyToAccount(actor.privateKey), transport: http(l1RpcUrl) });
          const provider = new DeterministicInjectedProvider({ privateKey: actor.privateKey, chainId: network.l1ChainId,
            broadcastTransaction: tx => client.sendTransaction({ chain: null, to: tx.to, data: tx.data, value: BigInt(tx.value ?? '0x0'),
              ...(tx.nonce === undefined ? {} : { nonce: Number(BigInt(tx.nonce)) }),
              ...(tx.gas === undefined ? {} : { gas: BigInt(tx.gas) }),
              ...(tx.maxFeePerGas === undefined ? {} : { maxFeePerGas: BigInt(tx.maxFeePerGas) }),
              ...(tx.maxPriorityFeePerGas === undefined ? {} : { maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) }),
            }),
          });
          const bridge = await startInjectedProviderBridge(provider);
          servers.push(bridge);
          const browser = await this.browser();
          await browser.addInitScript(createInjectedProviderSource({ bridgeUrl: bridge.url }));
          return { actor, provider, browser };
        },
        async host(options) {
          const server = await startStaticHost(options);
          servers.push(server);
          return server;
        },
        async browser() {
          const context = await browser.newContext({ recordVideo: { dir: testInfo.outputPath('videos') } });
          const session = { context, events: [], page: undefined };
          sessions.push(session);
          const page = await context.newPage();
          session.page = page;
          page.setDefaultTimeout(60_000);
          page.on('pageerror', error => session.events.push({ type: 'pageerror', message: error.message }));
          page.on('console', message => session.events.push({ type: message.type(), message: message.text() }));
          const cores = e2eSettings().str('web-browser-hardware-concurrency');
          if (cores !== null) {
            const hardwareConcurrency = Number(cores);
            if (!Number.isSafeInteger(hardwareConcurrency) || hardwareConcurrency < 1) throw new Error('invalid browser hardware concurrency');
            const cdp = await context.newCDPSession(page);
            await cdp.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency });
            await cdp.detach();
          }
          return {
            page,
            context,
            events: () => session.events,
            evaluate: expression => page.evaluate(expression),
            addInitScript: source => context.addInitScript(source),
            navigate: url => page.goto(url),
            reload: () => page.reload(),
            pressEscape: () => page.keyboard.press('Escape'),
            clickAt: (x, y) => page.mouse.click(x, y),
            async screenshot({ width = 1440, height = 1000 } = {}) {
              await page.setViewportSize({ width, height });
              return page.screenshot({ fullPage: true });
            },
            async waitFor(expression, { description = expression, timeoutMs = 15_000, intervalMs = 50 } = {}) {
              return test.step(description, async () => {
                const value = await page.waitForFunction(expression, undefined, { timeout: timeoutMs, polling: intervalMs });
                try { return await value.jsonValue(); } finally { await value.dispose(); }
              });
            },
            async openWallet() {
              const panel = page.locator('[data-testid="wallet-panel"][data-view="overview"][open]');
              await expect(async () => {
                if (await panel.isVisible()) return;
                const close = page.getByRole('button', { name: 'Close wallet', exact: true });
                if (await close.isVisible()) await close.click({ timeout: 1_000 });
                await page.getByTestId('wallet-trigger').click({ timeout: 1_000 });
                await expect(panel).toBeVisible({ timeout: 1_000 });
              }).toPass({ timeout: 15_000 });
            },
            async connectWallet() {
              await this.openWallet();
              const panel = page.getByTestId('wallet-panel');
              await panel.getByRole('checkbox', { name: 'Show ENS names', exact: true }).uncheck();
              await panel.getByRole('button', { name: 'Connect wallet', exact: true }).click();
              await page.locator('[data-testid^="rk-wallet-option-"]').first().click();
            },
            async openMining() {
              await this.openWallet();
              await page.getByTestId('wallet-panel').getByRole('link', { name: 'Get PCASH', exact: true }).click();
              await expect(page.getByTestId('mining-start')).toBeVisible();
            },
            clickButton: label => page.getByRole('button', { name: label, exact: true }).click(),
            fillLabeledInput: (label, value) => page.getByLabel(label, { exact: true }).fill(String(value)),
          };
        },
      });
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus;
      const cleanup = await Promise.allSettled(sessions.map(async ({ context, page, events }, index) => {
        try {
          if (failed) await testInfo.attach(`browser-${index}-events`, {
            body: JSON.stringify(events, null, 2), contentType: 'application/json',
          });
          // Playwright records traces and failure screenshots for every context.
        } finally {
          await context.close();
          if (failed && page?.video()) await testInfo.attach(`video-${index}`, { path: await page.video().path(), contentType: 'video/webm' });
          else await page?.video()?.delete();
        }
      }));
      const closed = await Promise.allSettled(servers.map(server => server.close()));
      const errors = [...cleanup, ...closed].filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'browser fixture cleanup failed');
    }
  },
});
