import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { circuitCatalog } from "./catalog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "../..");
const BROWSER_PROVER_MANIFEST_VERSION = 1;

// Every non-fixture circuit except lineage's, which the lineage package pins
// and hosts itself; native-only circuits are included. `provingRuntimes` is
// the reference wallet's proving policy, not a hosting decision: serving L lets
// the proof lab measure it against the same release the website uses.
const catalog = circuitCatalog(REPOSITORY_ROOT);
const releaseCircuits = catalog.filter((circuit) => circuit.fixture !== true && circuit.owner !== "lineage");
const releaseCircuitIds = new Set(releaseCircuits.map((circuit) => circuit.artifactId));
export const BROWSER_SRS_POINTS = [...new Set(releaseCircuits.map((circuit) => circuit.srsPoints))]
  .sort((a, b) => a - b);
const BROWSER_G1_BYTES = Math.max(...BROWSER_SRS_POINTS) * 64;

function comparePath(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function slashPath(path) {
  return path.split(sep).join("/");
}

function requireDirectory(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing at ${path}`);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (!entry.isDirectory()) throw new Error(`${label} is not a directory at ${path}`);
}

function requireFile(path, label, minimumBytes = 1) {
  if (!existsSync(path)) throw new Error(`${label} is missing at ${path}`);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (!entry.isFile()) throw new Error(`${label} is not a file at ${path}`);
  if (entry.size < minimumBytes) {
    throw new Error(`${label} at ${path} is ${entry.size} bytes; expected at least ${minimumBytes}`);
  }
  return entry.size;
}

function walkFiles(root) {
  const files = [];
  const visit = (path) => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error(`browser prover asset must not be a symbolic link: ${path}`);
    if (entry.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (entry.isFile()) {
      files.push(path);
    }
  };
  visit(root);
  return files;
}

function fileAsset(logicalPath, source, size = requireFile(source, `browser prover asset ${logicalPath}`)) {
  if (!/^\/(?:prover|chonk-vks|crs)\//.test(logicalPath) || logicalPath.includes("..")) {
    throw new Error(`invalid browser prover logical path: ${logicalPath}`);
  }
  return { logicalPath, source, size };
}

/**
 * Resolve the browser-visible paths and sizes of a bundle's prover assets and
 * the tool root's CRS. Nothing here hashes them: callers authenticate the plan,
 * as `exportBrowserProverAssetSet` does against the checked-in release.
 */
export function resolveBrowserProverAssets({ bundle, toolRoot, required = false }) {
  const configuredBundle = bundle?.trim();
  if (!configuredBundle) {
    if (required) throw new Error("PCASH_CIRCUIT_BUNDLE is required for browser proving assets");
    return undefined;
  }

  // A configured bundle path may itself be a symlink; check the directory it
  // names. Paths inside the bundle still may not be symlinks.
  const configuredRoot = resolve(configuredBundle);
  const bundleRoot = existsSync(configuredRoot) ? realpathSync(configuredRoot) : configuredRoot;
  const resolvedToolRoot = resolve(toolRoot);
  const proverRoot = join(bundleRoot, "prover-assets");
  const verificationKeyRoot = join(bundleRoot, "vks");
  const crsRoot = join(resolvedToolRoot, "crs");
  const g1 = join(crsRoot, "bn254_g1.dat");
  const g2 = join(crsRoot, "bn254_g2.dat");
  const grumpkin = join(crsRoot, "grumpkin_g1_v2.flat.dat");

  requireDirectory(bundleRoot, "PCASH circuit bundle");
  requireDirectory(proverRoot, "circuit bundle prover-assets directory");
  requireDirectory(verificationKeyRoot, "circuit bundle verification-key directory");
  requireDirectory(crsRoot, "pinned prover CRS directory");
  requireFile(g1, "BN254 G1 CRS", BROWSER_G1_BYTES);
  requireFile(g2, "BN254 G2 CRS");
  requireFile(grumpkin, "Grumpkin G1 CRS");

  const proverFiles = walkFiles(proverRoot).filter((path) => {
    const id = slashPath(relative(proverRoot, path)).replace(/\.json$/, "");
    return path.endsWith(".json") && releaseCircuitIds.has(id);
  });
  const verificationKeys = walkFiles(verificationKeyRoot).filter((path) => {
    const id = slashPath(relative(verificationKeyRoot, path)).replace(/\.chonk\.vk$/, "");
    return path.endsWith(".chonk.vk") && releaseCircuitIds.has(id);
  });
  if (proverFiles.length !== releaseCircuitIds.size || verificationKeys.length !== releaseCircuitIds.size) {
    throw new Error("circuit bundle does not contain the complete browser prover asset set");
  }

  const assets = [
    ...proverFiles.map((source) =>
      fileAsset(`/prover/${slashPath(relative(proverRoot, source))}`, source)),
    ...verificationKeys.map((source) => {
      const id = slashPath(relative(verificationKeyRoot, source)).replace(/\.chonk\.vk$/, ".vk");
      return fileAsset(`/chonk-vks/${id}`, source);
    }),
    ...BROWSER_SRS_POINTS.map((points) =>
      fileAsset(`/crs/${points}/bn254_g1.dat`, g1, points * 64)),
    fileAsset("/crs/bn254_g2.dat", g2),
    fileAsset("/crs/grumpkin_g1_v2.flat.dat", grumpkin),
  ].sort((a, b) => comparePath(a.logicalPath, b.logicalPath));

  const byLogicalPath = new Map();
  for (const asset of assets) {
    if (byLogicalPath.has(asset.logicalPath)) {
      throw new Error(`duplicate browser prover asset path: ${asset.logicalPath}`);
    }
    byLogicalPath.set(asset.logicalPath, asset);
  }
  return { assets, bundleRoot, toolRoot: resolvedToolRoot, byLogicalPath };
}

function sha256FilePrefix(path, bytes) {
  requireFile(path, `browser prover asset`, bytes);
  const descriptor = openSync(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(bytes, 1024 * 1024));
  let remaining = bytes;
  try {
    while (remaining > 0) {
      const count = readSync(descriptor, buffer, 0, Math.min(remaining, buffer.length), null);
      if (count === 0) throw new Error(`browser prover asset ended before ${bytes} bytes: ${path}`);
      hash.update(buffer.subarray(0, count));
      remaining -= count;
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function canonicalBrowserProverManifestPayload(artifacts) {
  return JSON.stringify({
    artifacts: [...artifacts]
      .sort((a, b) => comparePath(a.path, b.path))
      .map(({ path, bytes, sha256 }) => ({ bytes, path, sha256 })),
    version: BROWSER_PROVER_MANIFEST_VERSION,
  });
}

export function createBrowserProverManifest(plan) {
  const artifacts = plan.assets.map((asset) => ({
    path: asset.logicalPath,
    bytes: asset.size,
    sha256: sha256FilePrefix(asset.source, asset.size),
  }));
  const assetSetId = createHash("sha256")
    .update(canonicalBrowserProverManifestPayload(artifacts), "utf8")
    .digest("hex");
  return { version: BROWSER_PROVER_MANIFEST_VERSION, assetSetId, artifacts };
}

/** Copy the plan's files into an unversioned developer/static-web directory. */
export function stageBrowserProverAssets(plan, destination) {
  requireRealDirectory(resolve(destination), "browser prover staging root");
  for (const asset of plan.assets) {
    const output = join(destination, ...asset.logicalPath.slice(1).split("/"));
    mkdirSync(dirname(output), { recursive: true });
    if (statSync(asset.source).size === asset.size) {
      copyFileSync(asset.source, output);
      continue;
    }
    const source = openSync(asset.source, "r");
    const target = openSync(output, "wx");
    const buffer = Buffer.allocUnsafe(Math.min(asset.size, 1024 * 1024));
    let remaining = asset.size;
    try {
      while (remaining > 0) {
        const count = readSync(source, buffer, 0, Math.min(remaining, buffer.length), null);
        if (count === 0) throw new Error(`browser prover asset ended before ${asset.size} bytes: ${asset.source}`);
        writeSync(target, buffer, 0, count);
        remaining -= count;
      }
    } finally {
      closeSync(source);
      closeSync(target);
    }
  }
}

function assertManifest(expected, actual) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`browser prover asset set ${actual.assetSetId} does not match the checked-in release ${expected?.assetSetId ?? "<missing>"}`);
  }
}

function requireRealDirectory(path, label) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
    return;
  }
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${label} must be a real directory: ${path}`);
}

export function exportBrowserProverAssetSet(plan, publicRoot, expectedManifest) {
  const manifest = createBrowserProverManifest(plan);
  assertManifest(expectedManifest, manifest);
  const resolvedPublicRoot = resolve(publicRoot);
  requireRealDirectory(resolvedPublicRoot, "browser prover public root");
  if (readdirSync(resolvedPublicRoot).length !== 0) {
    throw new Error(`browser prover public root must be empty: ${resolvedPublicRoot}`);
  }
  const output = join(resolvedPublicRoot, "proving", manifest.assetSetId);
  mkdirSync(output, { recursive: true });
  stageBrowserProverAssets(plan, output);
  const text = `${JSON.stringify(manifest)}\n`;
  writeFileSync(join(output, "manifest.json"), text, { flag: "wx" });
  writeFileSync(join(resolvedPublicRoot, "browser-prover-manifest.json"), text, { flag: "wx" });
  walkFiles(resolvedPublicRoot);
  return { manifest, output };
}

function argument(config, name) {
  const value = config.str(name);
  if (value === null || value === "true") throw new Error(`--${name} requires a value`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { Config } = await import("../../sdk/src/bcfg/index.ts");
  const config = new Config("pcash");
  config.load({ argv: true, env: true });
  if (config.str(0) !== "export") throw new Error("usage: browser_assets.mjs export --bundle DIR --tool-root DIR --output DIR --release FILE");
  const bundle = argument(config, "bundle");
  const { validateCircuitBundle } = await import("./bundle.mjs");
  const { Logger } = await import("../../sdk/src/blgr/index.ts");
  validateCircuitBundle(bundle);
  const plan = resolveBrowserProverAssets({
    bundle,
    toolRoot: argument(config, "tool-root"),
    required: true,
  });
  const expected = JSON.parse(readFileSync(argument(config, "release"), "utf8"));
  const result = exportBrowserProverAssetSet(plan, argument(config, "output"), expected);
  new Logger().raw(result.manifest.assetSetId);
}
