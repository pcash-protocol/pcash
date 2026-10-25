import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

test('isolates browser storage and preserves failure evidence while closing the static host', { timeout: 60_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pcash-browser-fixture-'));
  const site = join(directory, 'site');
  mkdirSync(site);
  writeFileSync(join(site, '_headers'), '/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n  Cross-Origin-Resource-Policy: same-origin\n');
  writeFileSync(join(site, '_redirects'), '/* /index.html 200\n');
  writeFileSync(join(site, 'index.html'), '<label>Name<input id="name"></label><button onclick="localStorage.name=document.querySelector(\'#name\').value">Save</button>');
  const state = join(directory, 'host.json');
  const spec = `import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'fixtures.mjs')).href)};
test('intentional failure after isolated browser interactions', async ({ journey }) => {
  const host = await journey.host({ root: ${JSON.stringify(site)} });
  writeFileSync(${JSON.stringify(state)}, JSON.stringify(host.url));
  const first = await journey.browser();
  await first.navigate(host.url);
  assert.equal(await first.evaluate('crossOriginIsolated'), true);
  await first.fillLabeledInput('Name', 'Alice');
  await first.clickButton('Save');
  await first.reload();
  assert.equal(await first.evaluate('localStorage.name'), 'Alice');
  const second = await journey.browser();
  await second.navigate(host.url);
  assert.equal(await second.evaluate('localStorage.name ?? null'), null);
  throw new Error('intentional fixture failure');
});`;
  writeFileSync(join(directory, 'fixture.spec.mjs'), spec);
  const config = join(directory, 'playwright.config.mjs');
  writeFileSync(config, `export default { testDir: ${JSON.stringify(directory)}, testMatch: '*.spec.mjs', workers: 1, retries: 0, timeout: 30000,
    outputDir: ${JSON.stringify(join(directory, 'results'))}, use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' } };`);
  try {
    const result = await new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, [resolve(import.meta.dirname, '../../node_modules/playwright/cli.js'), 'test', '--config', config, '--reporter', 'json'], {
        cwd: resolve(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => stdout += chunk);
      child.stderr.on('data', chunk => stderr += chunk);
      child.on('error', reject);
      child.on('close', code => resolveRun({ code, stdout, stderr }));
    });
    assert.equal(result.code, 1, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    const outcome = report.suites[0].specs[0].tests[0].results[0];
    assert.match(outcome.error.message, /intentional fixture failure/);
    const attachments = outcome.attachments.map(attachment => attachment.contentType);
    for (const type of ['application/zip', 'image/png', 'application/json', 'video/webm']) assert.ok(attachments.includes(type), `missing ${type}`);
    await assert.rejects(fetch(JSON.parse(readFileSync(state, 'utf8'))), /fetch failed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
