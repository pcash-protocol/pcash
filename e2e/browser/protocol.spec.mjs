import assert from "node:assert/strict";
import { test } from "./fixtures.mjs";

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { circuitCatalog } from "../../scripts/circuits/catalog.mjs";
import { hkdfSync } from "node:crypto";
import { generateMlKemKeyPair, ML_KEM_768_SEED_LENGTH } from "@pcash/sdk/protocol";
import { beBytes, concatBytes } from "@pcash/sdk/utils";
import { assertToolchain } from "@pcash/sdk/node/toolchain";
import { logger } from "../src/framework/logger.ts";
import { circuitBundle, e2eSettings } from "../src/settings.ts";

test("proves protocol actions in browser WASM with pinned release assets", async ({ journey }, testInfo) => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "../..");
  const probeRoot = join(here, "protocol");
  const settings = e2eSettings();
  const bundle = circuitBundle()?.trim();
  if (!bundle) throw new Error("PCASH_CIRCUIT_BUNDLE is required");
  const tools = assertToolchain();
  const timeoutMs = settings.uint("asset-browser-timeout-ms", 1_200_000);
  const scratch = testInfo.outputPath("protocol");
  const publicDir = join(scratch, "public");
  const distDir = join(scratch, "dist");
  const resultPath = resolve(settings.str("asset-browser-result")?.trim() || join(scratch, "result.json"));
  const crsDir = join(publicDir, "crs");
  mkdirSync(crsDir, { recursive: true });
  for (const circuit of circuitCatalog(root).filter(circuit => circuit.provingRuntimes.includes("browser"))) {
    const destination = join(publicDir, "prover", circuit.proverArtifactPath.replace(/^prover-assets\//, ""));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(bundle, circuit.proverArtifactPath), destination);
  }
  // The browser prover refuses to start unless the page hosts every pinned CRS
  // file, and it never falls back to a CDN.
  const probeSrsPoints = 2 ** 19;
  const profileDir = join(crsDir, String(probeSrsPoints));
  mkdirSync(profileDir, { recursive: true });
  copyFileSync(tools.bn254G1, join(profileDir, "bn254_g1.dat"));
  truncateSync(join(profileDir, "bn254_g1.dat"), probeSrsPoints * 64);
  copyFileSync(tools.bn254G2, join(crsDir, "bn254_g2.dat"));
  copyFileSync(tools.grumpkinG1, join(crsDir, "grumpkin_g1_v2.flat.dat"));
  writeFileSync(join(crsDir, "profile.json"), `${JSON.stringify({ srsProfiles: [probeSrsPoints] }, null, 2)}\n`);

  function vkFields(path) {
    const bytes = readFileSync(path);
    if (bytes.length % 32 !== 0) throw new Error(`VK byte length is not field-aligned: ${path}`);
    return Array.from({ length: bytes.length / 32 }, (_, index) =>
      `0x${bytes.subarray(index * 32, (index + 1) * 32).toString("hex")}`);
  }

  // The release shared-claim fixture uses this deterministic recipient receive seed.
  const largeRecipient = generateMlKemKeyPair(new Uint8Array(hkdfSync(
    "sha256", concatBytes(new Uint8Array(32).fill(9), beBytes(987n, 32)),
    "pcash.mlkem-receive-seed", "ml-kem-768", ML_KEM_768_SEED_LENGTH,
  )));
  writeFileSync(join(publicDir, "scenario.json"), `${JSON.stringify({
    allDummyOnly: settings.bool("asset-browser-all-dummy-only", false),
    threads: settings.uint("asset-browser-threads", "auto"),
    largeClaim: {
      transactionHex: "0x" + readFileSync(join(bundle, "known-answers/shared_claim_l/tx_bytes")).toString("hex"),
      receiveSecretKey: "0x" + Buffer.from(largeRecipient.secretKey).toString("hex"),
      receivePublicKey: "0x" + Buffer.from(largeRecipient.publicKey).toString("hex"),
    },
    covenantVkFields: vkFields(join(bundle, "vks", "account_rule_asset_covenant.chonk.vk")),
  }, null, 2)}\n`);

  // Every circuit this probe proves; readable asset creation requires 2^19.
  const circuitNames = [
    "account_rule_payment_ecdsa",
    "account_rule_asset_payment_ecdsa",
    "account_rule_asset_creation_ecdsa",
    "account_rule_asset_covenant",
    "no_op_event_application",
    "private_value_asset_creation_kernel",
    "private_value_transfer_kernel",
    "private_value_hiding_kernel",
  ];
  const chonkVkDir = join(publicDir, "chonk-vks");
  mkdirSync(chonkVkDir, { recursive: true });
  for (const name of circuitNames) {
    copyFileSync(
      join(bundle, "vks", `${name}.chonk.vk`),
      join(chonkVkDir, `${name}.vk`),
    );
  }
  const protocolManifest = JSON.parse(readFileSync(join(bundle, "protocol-manifest.json"), "utf8"));
  const circuitSizes = Object.fromEntries(circuitNames.map((name) =>
    [name, protocolManifest.circuits[name].circuitSize]));
  const maximumCircuitSize = Math.max(...Object.values(circuitSizes));
  if (maximumCircuitSize > probeSrsPoints) {
    throw new Error(`asset browser circuit ${maximumCircuitSize} exceeds the 2^19 profile`);
  }

  const vite = join(root, "node_modules", ".bin", "vite");
  const viteConfig = join(probeRoot, "vite.config.ts");
  const viteEnv = {
    ...process.env,
    PCASH_E2E_ASSET_BROWSER_PUBLIC: publicDir,
    PCASH_E2E_ASSET_BROWSER_DIST: distDir,
  };
  execFileSync(vite, ["build", "--config", viteConfig], {
    cwd: probeRoot,
    env: viteEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  function descendants(rootPid) {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" }).trim();
    if (output === "") return 0;
    const rows = output.split("\n").map((line) => line.trim().split(/\s+/).map(Number));
    const wanted = new Set([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, parentPid] of rows) {
        if (wanted.has(parentPid) && !wanted.has(pid)) {
          wanted.add(pid);
          changed = true;
        }
      }
    }
    return rows.filter(([pid]) => wanted.has(pid)).reduce((sum, [, , rss]) => sum + rss, 0);
  }

  // Use the same static headers as the production browser fixtures.
  writeFileSync(join(distDir, "_headers"), "/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n  Cross-Origin-Resource-Policy: same-origin\n");
  writeFileSync(join(distDir, "_redirects"), "/* /index.html 200\n");
  const site = await journey.host({ root: distDir });
  const session = await journey.browser();
  const browser = session.context.browser();
  const cdp = await browser.newBrowserCDPSession();
  let sampleTimer;
  let peakChromeRssKiB = 0;
  let report;
  try {
    const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
    const pid = processInfo.find(info => info.type === "browser").id;
    const sample = () => { peakChromeRssKiB = Math.max(peakChromeRssKiB, descendants(pid)); };
    sampleTimer = setInterval(() => { try { sample(); } catch {} }, 100);
    await session.navigate(site.url);
    const result = await session.waitFor("window.__PCASH_ASSET_BROWSER_RESULT__", {
      description: "browser protocol proving completes", timeoutMs, intervalMs: 500,
    });
    sample();
    report = { ...result, circuitSizes, maximumCircuitSize, peakChromeProcessTreeRssBytes: peakChromeRssKiB * 1024,
      chromeVersion: browser.version(), scratch };
    assert.equal(result.ok, true, JSON.stringify(result));
  } catch (error) {
    report ??= { ok: false, error: String(error), circuitSizes, maximumCircuitSize,
      peakChromeProcessTreeRssBytes: peakChromeRssKiB * 1024, chromeVersion: browser.version(), scratch };
    throw error;
  } finally {
    clearInterval(sampleTimer);
    await cdp.detach();
    writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
    await testInfo.attach("protocol-result", { path: resultPath, contentType: "application/json" });
    logger.info(`browser protocol result: ${resultPath}`);
  }
});
