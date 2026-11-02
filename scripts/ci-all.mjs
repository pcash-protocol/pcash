import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');

// Dependencies describe required outputs, never whether an earlier test passed.
export const SUITES = ['fast', 'core', 'acceptance', 'browser', 'metamask', 'all'];

export function checks(suite = 'all') {
  if (!SUITES.includes(suite)) throw new Error(`unknown suite ${suite}; choose ${SUITES.join(', ')}`);
  const fast = suite === 'fast';
  const tasks = [];
  const add = (name, command, needs = [], extra = {}) => tasks.push({ name, command, needs, suites: ['fast', 'core'], ...extra });
  const nodeTest = (name, file, needs = ['npm']) => add(name, ['node', '--test', file], needs);
  add('node-version', ['node', '-e', `const min = JSON.parse(require('fs').readFileSync('package.json')).engines.node.replace(/^>=/, ''); const rank = v => v.split('.').reduce((a, p) => a * 1e5 + Number(p), 0); if (rank(process.versions.node) < rank(min)) { console.error('Node ' + min + ' or newer is required'); process.exit(1); }`]);
  add('npm', ['npm', 'ci'], ['node-version']);
  for (const tool of ['forge', 'anvil', 'cast']) {
    add(tool, ['node', '-e', `const {spawnSync}=require('child_process'); const r=spawnSync('${tool}',['--version'],{encoding:'utf8'}); const m=r.stdout?.match(/(\\d+)\\.(\\d+)\\.(\\d+)/); const rank=m=>Number(m[1])*1e8+Number(m[2])*1e5+Number(m[3]); const min=require('fs').readFileSync('justfile','utf8').match(/foundry-min := "([^"]+)"/)[1]; if(r.status!==0 || !m || rank(m)<rank(['',...min.split('.')])) { console.error('${tool} '+min+' or newer is required'); process.exit(1); }`]);
  }
  nodeTest('runner-tests', 'scripts/ci-all.test.mjs', ['node-version']);
  nodeTest('lockfile-tests', 'scripts/package_lock.test.mjs', ['node-version']);
  nodeTest('bootstrap-tests', 'scripts/bootstrap_prover_toolchain.test.mjs');
  add('boundaries', ['node', 'scripts/check_package_boundaries.mjs'], ['npm']);
  add('boundary-tests', ['npm', 'run', 'boundaries:test'], ['npm']);
  for (const [name, file] of Object.entries({
    'workflow-tests': 'scripts/manual_workflows.test.mjs',
    'profile-tests': 'scripts/circuits/profiles.test.mjs',
    'network-tests': 'scripts/network_profile.test.mjs',
  })) nodeTest(name, file);
  add('generated', ['just', 'generate', '--check'], ['npm']);
  add('issuance-rust', ['cargo', 'run', '--locked', '--quiet', '-p', 'pcash-issuance', '--bin', 'issuance-vectors', '--', '--check', 'vectors/issuance.json']);
  add('issuance-python', ['just', 'test-issuance-python']);
  add('bundle-tests', ['npm', 'run', 'circuit-bundle:test'], ['npm']);

  const packages = ['sdk', 'wallet', 'relayer', 'marketplace', 'tokens', 'lineage', 'board'];
  const builds = packages.map(p => `build-${p}`);
  // The web app's feature packages live under web/.
  const packageDirectory = p => ['tokens', 'board'].includes(p) ? `web/${p}` : p;
  const packageNeeds = p => {
    const pkg = JSON.parse(readFileSync(join(root, packageDirectory(p), 'package.json'), 'utf8'));
    return packages.filter(other => other !== p && pkg.dependencies?.[`@pcash/${other}`]).map(other => `build-${other}`);
  };
  for (const p of packages) add(`build-${p}`, ['npm', 'run', 'build', '--workspace', `@pcash/${p}`], ['npm', ...packageNeeds(p)]);
  for (const p of [...packages, 'e2e', 'test-support', 'bench']) {
    add(`typecheck-${p}`, ['npm', 'run', 'typecheck', '--ignore-scripts', '--workspace', `@pcash/${p}`], ['npm', ...packageNeeds(p), ...(p === 'sdk' ? ['build-sdk'] : [])]);
  }
  // Attempt CRS installation before wallet tests decide whether the pinned CRS is available.
  add('tools', ['just', 'tools'], ['npm'], { suites: ['core'] });
  add('noir-format', ['just', '_ci-noir-format'], ['tools'], { suites: ['core'] });
  for (const p of ['relayer', 'wallet', 'board']) add(`test-${p}`, ['npm', 'test', '--ignore-scripts', '--workspace', `@pcash/${p}`], ['npm', ...packageNeeds(p)]);
  add('dev-tests', ['npm', 'run', 'dev:test'], ['npm']);
  add('solidity-dependencies', ['just', '_solidity-dependencies'], ['forge']);
  add('solidity-build', ['forge', 'build'], ['solidity-dependencies'], { cwd: 'marketplace/l1-contracts' });
  add('lineage-solidity-tests', ['forge', 'test'], ['forge'], { cwd: 'lineage/l1-contracts' });
  add('solidity-tests', ['forge', 'test'], ['solidity-dependencies'], { cwd: 'marketplace/l1-contracts' });
  add('profile-compile', ['node', '--test', 'scripts/circuits/profile_compile.test.mjs'], ['npm', 'tools'], { suites: ['core'] });
  add('circuit-bundle', ['node', 'scripts/circuits/bundle.mjs', '--print-path'], ['npm', 'tools'], { bundle: true, suites: ['core'] });
  add('release-pins', ['just', 'pins', '--check'], ['circuit-bundle'], { suites: ['core'] });
  add('evm-known-answers', ['node', 'scripts/circuits/bundle.mjs', 'exec', '--', 'node', 'node/crates/verify/fixtures/evm_kat/check.mjs'], ['circuit-bundle'], { suites: ['core'] });
  for (const name of ['startup_known_answers_pass', 'rejects_canonical_all_zero_proofs']) {
    add(name, ['cargo', 'test', '-p', 'pcash-verify', `tests::${name}`, '--', '--ignored', '--exact'], ['circuit-bundle'], { exactTest: true, suites: ['core'] });
  }
  const rustSelection = fast
    ? ['crypto', 'da', 'issuance', 'l1', 'metrics', 'p2p', 'state'].flatMap(p => ['-p', `pcash-${p}`])
    : ['--workspace'];
  add('rust-clippy', ['cargo', 'clippy', ...rustSelection, '--all-targets'], fast ? [] : ['circuit-bundle']);
  add('rust-tests', ['cargo', 'test', ...rustSelection, '--no-fail-fast'], fast ? [] : ['circuit-bundle']);
  add('rust-real-proof', ['cargo', 'test', '--locked', '-p', 'pcash-derive', '--test', 'real_proof', '--', '--ignored'], ['circuit-bundle'], { suites: ['core'] });
  for (const p of ['sdk', 'marketplace', 'tokens', 'lineage']) {
    add(`test-${p}`, ['npm', 'run', fast ? 'test:fast' : 'test', '--ignore-scripts', '--workspace', `@pcash/${p}`],
      ['npm', ...(p === 'sdk' ? ['build-sdk'] : []), ...packageNeeds(p), ...(fast ? [] : ['circuit-bundle']),
        ...(p === 'marketplace' ? ['solidity-build', 'anvil'] : p === 'sdk' ? ['anvil'] : [])],
      { env: p === 'marketplace' ? { PCASH_REQUIRE_L1_ARTIFACTS: '1' } : {} });
  }
  add('source-verification', ['npm', 'run', 'source-verification:test'], ['build-sdk']);
  // Split compound npm test scripts so their second test runner still runs.
  add('e2e-unit', ['npm', 'exec', '--', 'vitest', 'run', '--config', 'vitest.config.ts'], builds, { cwd: 'e2e' });
  add('journey-unit', ['bash', '-c', 'node --test browser/journey/*.test.mjs'], builds, { cwd: 'e2e' });
  const webBuilds = packageNeeds('web');
  const webEnv = { PCASH_RPC_URL: 'https://pcash.invalid/rpc', PCASH_CHAIN_ID: '1346589512', PCASH_BROWSER_L1_RPC_URLS: 'https://ethereum.invalid/rpc', PCASH_L1_CHAIN_ID: '11155111' };
  add('web-build', ['npm', 'run', 'build', '--workspace', '@pcash/web'], webBuilds, { env: webEnv });
  add('web-unit', ['npm', 'exec', '--', 'vitest', 'run'], webBuilds, { cwd: 'web', env: webEnv });
  add('web-assets', ['node', '--test', 'scripts/prover_assets.node-test.mjs'], webBuilds, { cwd: 'web', env: webEnv });
  for (const script of ['pcash-wallet-cli', 'pcash-wallet']) add(script, ['npm', 'run', script, '--', '--help'], ['build-wallet', 'circuit-bundle'], { cwd: 'wallet', suites: ['core'] });
  add('pcash-relayer', ['npm', 'run', 'pcash-relayer', '--workspace', '@pcash/relayer', '--', '--help'], ['build-relayer', 'circuit-bundle'], { suites: ['core'] });
  add('pcash-relayer-cli', [join(root, 'node_modules/.bin/pcash-relayer-cli'), '--help'], ['build-relayer', 'circuit-bundle'], { suites: ['core'] });
  const integration = [...builds, 'circuit-bundle', 'solidity-dependencies', 'anvil', 'cast'];
  add('e2e-scenarios', ['just', 'e2e'], integration, { env: { PCASH_NETWORK: 'testnet' }, suites: ['acceptance'] });
  add('browser-chromium', ['npm', 'exec', '--workspace', '@pcash/e2e', '--', 'playwright', 'install', '--with-deps', 'chromium'], ['npm'], { suites: [] });
  add('browser-fixtures', ['node', '--test', 'e2e/browser/fixtures.test.mjs'], ['build-sdk', 'browser-chromium'], { suites: ['browser'] });
  for (const project of ['connection', 'wallet', 'marketplace', 'protocol', 'metamask']) {
    add(project === 'metamask' ? 'metamask' : `browser-${project}`,
      ['npm', 'run', '--ignore-scripts', 'test:browser', '--workspace', '@pcash/e2e', '--', '--project', project, '--output', `test-results/${project}`],
      [...(project === 'connection' ? [...webBuilds, 'circuit-bundle'] : project === 'protocol' ? ['build-sdk', 'circuit-bundle'] : integration), 'browser-chromium'],
      { suites: [project === 'metamask' ? 'metamask' : 'browser'],
        env: { PLAYWRIGHT_HTML_OUTPUT_DIR: join(root, 'e2e/playwright-report', project) } });
  }
  const selected = new Set(tasks.filter(task => suite === 'all' || task.suites.includes(suite)).map(task => task.name));
  // Dependencies are earlier tasks; one reverse pass includes their transitive closure.
  for (const task of [...tasks].reverse()) if (selected.has(task.name)) for (const need of task.needs) selected.add(need);
  return tasks.filter(task => selected.has(task.name));
}

export async function runChecks(tasks, execute, report = console.log, interrupted = () => false) {
  const results = [];
  for (const task of tasks) {
    if (interrupted()) break;
    const blocked = task.needs.filter(name => results.find(r => r.name === name)?.status !== 'PASS');
    if (blocked.length) {
      const result = { name: task.name, status: 'BLOCKED', blocked };
      results.push(result);
      report(`BLOCKED ${task.name}: ${blocked.join(', ')}`);
      continue;
    }
    report(`==> ${task.name}`);
    const started = Date.now();
    let outcome;
    try { outcome = await execute(task); }
    catch (error) { outcome = { code: 1, error: String(error) }; }
    const result = { name: task.name, status: outcome.code === 0 ? 'PASS' : 'FAIL', seconds: Math.round((Date.now() - started) / 1000), ...outcome };
    results.push(result);
    report(`${result.status} ${task.name} (${result.seconds}s)${result.log ? ` — ${result.log}` : ''}${result.error ? `: ${result.error}` : ''}`);
  }
  return results;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length > 2 || (args[1] !== undefined && args[1] !== '--list')) {
    throw new Error('usage: node scripts/ci-all.mjs [suite] [--list]');
  }
  const suite = args[0] ?? 'all';
  const tasks = checks(suite);
  if (args.includes('--list')) {
    console.log(tasks.map(({ name }) => name).join('\n'));
    return 0;
  }
  const started = Date.now();
  const parent = join(root, '.cache/pcash/ci-all-runs');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'run.'));
  const env = { ...process.env, npm_config_cache: join(root, '.cache/pcash/npm') };
  if (suite === 'fast') delete env.PCASH_REQUIRE_PROVER;
  else env.PCASH_REQUIRE_PROVER = '1';
  delete env.PCASH_TEST_SUITE;
  delete env.PCASH_CIRCUIT_BUNDLE;
  delete env.PCASH_CIRCUIT_CACHE;
  delete env.PCASH_CIRCUIT_CACHE_ISOLATED;
  let child;
  let signal;
  const stop = s => {
    signal = s;
    if (child?.pid) {
      try { process.kill(-child.pid, s); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const onInt = () => stop('SIGINT');
  const onTerm = () => stop('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  console.log(`CI all logs: ${directory}`);
  try {
    const results = await runChecks(tasks, task => new Promise(resolveTask => {
      const log = join(directory, `${task.name}.log`);
      const stream = createWriteStream(log);
      let captured = '';
      const taskEnv = { ...env, ...task.env };
      const command = task.name === 'e2e-scenarios' ? [...task.command, '--out', join(directory, 'acceptance')] : task.command;
      if (task.bundle) Object.assign(taskEnv, { PCASH_CIRCUIT_CACHE: join(directory, 'circuits'), PCASH_CIRCUIT_CACHE_ISOLATED: '1' });
      stream.write(`$ ${command.join(' ')}\n`);
      child = spawn(command[0], command.slice(1), { cwd: resolve(root, task.cwd ?? '.'), env: taskEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', data => {
        process.stdout.write(data);
        stream.write(data);
        if (task.bundle || task.exactTest) captured += data;
      });
      child.stderr.on('data', data => { process.stderr.write(data); stream.write(data); });
      let error;
      child.on('error', e => { error = String(e); stream.write(`${error}\n`); });
      child.on('close', code => {
        child = undefined;
        if (code === 0 && task.exactTest && !/^test result: ok\. 1 passed/m.test(captured)) {
          code = 1;
          error = 'live gate did not run exactly one test';
          stream.write(`${error}\n`);
        }
        if (code === 0 && task.bundle) env.PCASH_CIRCUIT_BUNDLE = captured.trim();
        stream.end(() => resolveTask({ code: code ?? 1, log, ...(error ? { error } : {}) }));
      });
    }), console.log, () => Boolean(signal));
    const counts = status => results.filter(r => r.status === status).length;
    console.log('\n==> CI all summary');
    for (const r of results) console.log(`${r.status.padEnd(7)} ${r.name}${r.blocked ? ` (requires ${r.blocked.join(', ')})` : ''}${r.status === 'FAIL' ? ` — ${r.log}` : ''}`);
    console.log(`${Math.round((Date.now() - started) / 1000)}s elapsed; ${counts('PASS')} passed, ${counts('FAIL')} failed, ${counts('BLOCKED')} blocked${signal ? `; interrupted by ${signal}` : ''}`);
    writeFileSync(join(directory, 'results.json'), `${JSON.stringify({ suite, signal, results }, null, 2)}\n`);
    return signal ? (signal === 'SIGINT' ? 130 : 143) : results.some(r => r.status !== 'PASS') ? 1 : 0;
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
