import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { checks, main, runChecks, SUITES } from './ci-all.mjs';

const task = (name, needs = []) => ({ name, needs, command: ['unused'] });
const statuses = results => Object.fromEntries(results.map(({ name, status }) => [name, status]));

test('reports a failure before starting the next independent check and retains its log', async () => {
  const events = [];
  const results = await runChecks([task('lint'), task('tests')], async ({ name }) => {
    events.push(`execute ${name}`);
    return { code: name === 'lint' ? 2 : 0, log: `/logs/${name}.log` };
  }, message => events.push(message));
  assert.deepEqual(statuses(results), { lint: 'FAIL', tests: 'PASS' });
  assert.equal(results[0].code, 2);
  assert.equal(results[0].log, '/logs/lint.log');
  const failure = events.findIndex(message => message.startsWith('FAIL lint'));
  assert.ok(failure > 0);
  assert.ok(failure < events.indexOf('execute tests'));
  assert.match(events[failure], /\/logs\/lint\.log/);
});

test('failed prerequisites block their descendants while independent branches continue', async () => {
  const executed = [];
  const results = await runChecks([
    task('build'), task('unit', ['build']), task('browser', ['unit']), task('independent'),
  ], async ({ name }) => {
    executed.push(name);
    return { code: name === 'build' ? 1 : 0 };
  }, () => {});
  assert.deepEqual(executed, ['build', 'independent']);
  assert.deepEqual(statuses(results), { build: 'FAIL', unit: 'BLOCKED', browser: 'BLOCKED', independent: 'PASS' });
  assert.deepEqual(results[1].blocked, ['build']);
  assert.deepEqual(results[2].blocked, ['unit']);
});

test('an execution exception is reported as a failure without aborting the run', async () => {
  const messages = [];
  const results = await runChecks([task('missing-tool'), task('next')], async ({ name }) => {
    if (name === 'missing-tool') throw new Error('spawn ENOENT');
    return { code: 0 };
  }, message => messages.push(message));
  assert.deepEqual(statuses(results), { 'missing-tool': 'FAIL', next: 'PASS' });
  assert.match(results[0].error, /spawn ENOENT/);
  assert.ok(messages.some(message => /FAIL missing-tool.*spawn ENOENT/.test(message)));
});

test('interruption prevents any further checks from starting', async () => {
  let interrupted = false;
  const results = await runChecks([task('current'), task('later')], async () => {
    interrupted = true;
    return { code: 1 };
  }, () => {}, () => interrupted);
  assert.deepEqual(statuses(results), { current: 'FAIL' });
});

test('catalog prerequisites are unique earlier tasks, making every branch reachable', () => {
  const seen = new Set();
  for (const { name, command, needs } of checks()) {
    assert.ok(!seen.has(name), `duplicate task ${name}`);
    assert.ok(command.length > 0, `${name} has no command`);
    for (const dependency of needs) assert.ok(seen.has(dependency), `${name} depends on missing or later task ${dependency}`);
    seen.add(name);
  }
});

test('suite selections keep fast checks prover-free and include every acceptance/browser branch once', () => {
  const names = suite => checks(suite).map(task => task.name);
  const fast = checks('fast');
  for (const excluded of ['tools', 'circuit-bundle', 'profile-compile', 'rust-real-proof', 'e2e-scenarios', 'browser-wallet', 'metamask']) {
    assert.ok(!names('fast').includes(excluded), excluded);
  }
  for (const p of ['sdk', 'marketplace', 'tokens', 'lineage']) {
    assert.ok(fast.find(task => task.name === `test-${p}`).command.includes('test:fast'));
  }
  assert.ok(names('acceptance').includes('e2e-scenarios'));
  assert.ok(!names('core').includes('e2e-scenarios'));
  assert.ok(!names('browser').includes('metamask'));
  assert.deepEqual(names('browser').filter(name => name.startsWith('browser-')),
    ['browser-chromium', 'browser-fixtures', 'browser-connection', 'browser-wallet', 'browser-marketplace', 'browser-protocol']);
  const union = new Set(SUITES.filter(suite => suite !== 'all').flatMap(names));
  assert.deepEqual(new Set(names('all')), union);
  for (const suite of SUITES) {
    const seen = new Set();
    for (const task of checks(suite)) {
      assert.ok(!seen.has(task.name), `${suite}: duplicate ${task.name}`);
      for (const dependency of task.needs) assert.ok(seen.has(dependency), `${suite}: missing ${dependency}`);
      seen.add(task.name);
    }
  }
  assert.throws(() => checks('typo'), /unknown suite/);
});

test('CLI rejects unrecognized arguments', async () => {
  await assert.rejects(main(['core', '--typo']), /usage:/);
  await assert.rejects(main(['core', '--list', 'extra']), /usage:/);
});

test('local scenarios run with a parent network preset', () => {
  const scenarios = checks().find(({ name }) => name === 'e2e-scenarios');
  assert.deepEqual(scenarios?.env, { PCASH_NETWORK: 'testnet' });
});

test('wallet tests follow the tools attempt even when installation fails', async () => {
  for (const code of [0, 1]) {
    let toolsAttempted = false;
    let walletRan = false;
    const results = await runChecks(checks(), async ({ name }) => {
      if (name === 'tools') {
        toolsAttempted = true;
        return { code };
      }
      if (name === 'test-wallet') {
        assert.equal(toolsAttempted, true, 'wallet must check CRS availability after tools installation');
        walletRan = true;
      }
      return { code: 0 };
    }, () => {});
    assert.equal(walletRan, true);
    assert.equal(statuses(results)['test-wallet'], 'PASS');
    assert.equal(statuses(results).tools, code === 0 ? 'PASS' : 'FAIL');
  }
});

test('lint and typecheck failures do not hide package tests or integration checks', async () => {
  const results = await runChecks(checks(), async ({ name }) => ({
    code: name === 'rust-clippy' || name.startsWith('typecheck-') ? 1 : 0,
  }), () => {});
  const byName = statuses(results);
  for (const name of ['rust-tests', 'test-sdk', 'test-wallet', 'test-relayer', 'test-marketplace', 'test-tokens', 'test-lineage', 'web-unit', 'e2e-scenarios', 'metamask']) {
    assert.equal(byName[name], 'PASS', `${name} should still run after unrelated lint/typecheck failures`);
  }
});

test('a circuit build failure leaves non-proving checks available', async () => {
  const results = await runChecks(checks(), async ({ name }) => ({ code: name === 'circuit-bundle' ? 1 : 0 }), () => {});
  const byName = statuses(results);
  for (const name of ['test-wallet', 'test-relayer', 'web-unit', 'web-assets']) assert.equal(byName[name], 'PASS', name);
  for (const name of ['release-pins', 'rust-tests', 'test-sdk', 'test-lineage', 'e2e-scenarios', 'metamask']) assert.equal(byName[name], 'BLOCKED', name);
});

test('CLI reports failures, success and interruption with saved results and logs', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pcash-ci-all-test.')));
  const fixture = join(directory, 'repo');
  const sourceRoot = resolve(import.meta.dirname, '..');
  mkdirSync(join(fixture, 'scripts'), { recursive: true });
  writeFileSync(join(fixture, 'scripts/ci-all.mjs'), readFileSync(join(sourceRoot, 'scripts/ci-all.mjs')));
  for (const file of ['package.json', 'justfile']) writeFileSync(join(fixture, file), readFileSync(join(sourceRoot, file)));
  for (const p of ['sdk', 'wallet', 'relayer', 'marketplace', 'web/tokens', 'web/board', 'lineage', 'e2e', 'test-support', 'bench', 'web']) {
    mkdirSync(join(fixture, p), { recursive: true });
    writeFileSync(join(fixture, p, 'package.json'), readFileSync(join(sourceRoot, p, 'package.json')));
  }
  mkdirSync(join(fixture, 'marketplace/l1-contracts'), { recursive: true });
  mkdirSync(join(fixture, 'lineage/l1-contracts'), { recursive: true });
  mkdirSync(join(fixture, 'node_modules/.bin'), { recursive: true });
  const stub = `#!${process.execPath}
const { basename } = require('node:path');
const args = process.argv.slice(2);
const tool = basename(process.argv[1]);
if (tool === 'npm' && process.env.CI_ALL_TEST_INTERRUPT === '1') {
  console.log('interrupt-ready ' + process.pid);
  setInterval(() => {}, 1000);
}
console.error('stub ' + tool + ' ' + args.join(' '));
if (tool === 'cargo' && args.includes('clippy')) {
  console.log('bundle=' + process.env.PCASH_CIRCUIT_BUNDLE);
  console.log('require-prover=' + process.env.PCASH_REQUIRE_PROVER);
  console.log('test-suite=' + process.env.PCASH_TEST_SUITE);
}
if (tool === 'node' && args.includes('--print-path')) {
  process.stdout.write(${JSON.stringify(join(directory, 'bundle'))} + '\\n');
} else if (tool === 'cargo' && args.includes('--exact')) {
  console.log('test result: ok. 1 passed; 0 failed; 0 ignored');
}
if (tool === 'cargo' && args.includes('clippy') && process.env.CI_ALL_TEST_FAIL === '1') {
  console.error('fixture lint failure');
  process.exitCode = 7;
}
`;
  for (const tool of ['node', 'npm', 'just', 'cargo', 'forge', 'anvil', 'cast', 'bash']) {
    writeFileSync(join(directory, tool), stub, { mode: 0o755 });
  }
  writeFileSync(join(fixture, 'node_modules/.bin/pcash-relayer-cli'), stub, { mode: 0o755 });
  const result = spawnSync(process.execPath, [join(fixture, 'scripts/ci-all.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CI_ALL_TEST_FAIL: '1', PCASH_TEST_SUITE: 'fast', PCASH_CIRCUIT_BUNDLE: '/ignored-inherited-bundle' },
    timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const logDirectory = /^CI all logs: (.+)$/m.exec(result.stdout)?.[1];
  assert.ok(logDirectory, result.stdout);
  const { results } = JSON.parse(readFileSync(join(logDirectory, 'results.json'), 'utf8'));
  assert.equal(statuses(results)['rust-clippy'], 'FAIL');
  assert.equal(statuses(results)['rust-tests'], 'PASS');
  assert.equal(statuses(results).metamask, 'PASS');
  const lintLog = readFileSync(join(logDirectory, 'rust-clippy.log'), 'utf8');
  assert.match(lintLog, /fixture lint failure/);
  assert.ok(lintLog.includes(`bundle=${join(directory, 'bundle')}\n`), lintLog);
  assert.match(lintLog, /require-prover=1/);
  assert.match(lintLog, /test-suite=undefined/);
  assert.doesNotMatch(lintLog, /ignored-inherited-bundle/);
  assert.ok(result.stdout.indexOf('FAIL rust-clippy') < result.stdout.indexOf('==> rust-tests'));
  assert.match(result.stdout, /CI all summary/);
  assert.match(result.stdout, /1 failed, 0 blocked/);

  const success = spawnSync(process.execPath, [join(fixture, 'scripts/ci-all.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CI_ALL_TEST_FAIL: '0' },
    timeout: 60_000,
  });
  assert.ifError(success.error);
  assert.equal(success.status, 0, success.stdout + success.stderr);
  assert.match(success.stdout, /0 failed, 0 blocked/);

  const interrupted = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [join(fixture, 'scripts/ci-all.mjs')], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CI_ALL_TEST_INTERRUPT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let sent = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      const stubPid = /interrupt-ready (\d+)/.exec(stdout)?.[1];
      if (stubPid) {
        try { process.kill(-Number(stubPid), 'SIGKILL'); } catch {}
      }
      rejectRun(new Error('CI runner did not exit after SIGTERM'));
    }, 10_000);
    child.stdout.on('data', data => {
      stdout += data;
      if (!sent && /interrupt-ready \d+/.test(stdout)) {
        sent = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timeout); rejectRun(error); });
    child.on('close', code => { clearTimeout(timeout); resolveRun({ code, stdout, stderr }); });
  });
  assert.equal(interrupted.code, 143, interrupted.stdout + interrupted.stderr);
  assert.match(interrupted.stdout, /interrupted by SIGTERM/);
  assert.doesNotMatch(interrupted.stdout, /==> forge/);
  const interruptedDirectory = /^CI all logs: (.+)$/m.exec(interrupted.stdout)?.[1];
  const saved = JSON.parse(readFileSync(join(interruptedDirectory, 'results.json'), 'utf8'));
  assert.equal(saved.signal, 'SIGTERM');
  assert.deepEqual(saved.results.map(({ name }) => name), ['node-version', 'npm']);
});
