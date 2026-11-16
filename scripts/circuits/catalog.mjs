import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { readPrivateValueProfiles } from "./profile_config.mjs";

const DEFAULT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const manifests = [
  ["circuits/manifest.json", "circuits"],
  ["marketplace/circuits.json", "marketplace"],
  ["web/tokens/circuits.json", "web/tokens"],
  ["lineage/circuits.json", "lineage"],
];

// Barretenberg's CHONK circuit kind for each manifest role.
const CIRCUIT_KINDS = {
  application: "app",
  kernel: "kernel",
  hiding: "hiding",
};

function stringValue(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function catalogPath(value, label) {
  const input = stringValue(value, label).replaceAll("\\", "/");
  const normalized = posix.normalize(input);
  if (posix.isAbsolute(input) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must stay within its owner root`);
  }
  return normalized;
}

function assertUnique(entries, key, label) {
  const seen = new Map();
  for (const entry of entries) {
    const value = entry[key];
    const previous = seen.get(value);
    if (previous !== undefined) {
      throw new Error(`circuit catalog ${label} collision ${value}: ${previous} and ${entry.releaseId}`);
    }
    seen.set(value, entry.releaseId);
  }
}

export function circuitCatalog(root = DEFAULT_ROOT) {
  const entries = manifests.flatMap(([manifestPath, ownerRoot]) => {
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
    if (!Array.isArray(manifest.circuits) || typeof manifest.owner !== "string") {
      throw new Error(`${manifestPath} is not a circuit manifest`);
    }
    const owner = stringValue(manifest.owner, `${manifestPath}.owner`);
    return manifest.circuits.map((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`${manifestPath}.circuits[${index}] is not a circuit entry`);
      }
      const packageName = stringValue(entry.package, `${manifestPath}.circuits[${index}].package`);
      const packageRelativePath = catalogPath(entry.path, `${manifestPath}.circuits[${index}].path`);
      const targetPath = catalogPath(
        owner === "protocol" ? `target/${packageName}.json` : `${packageRelativePath}/target/${packageName}.json`,
        `${manifestPath}.circuits[${index}].package`,
      );
      const artifactId = catalogPath(entry.artifact ?? packageName, `${manifestPath}.circuits[${index}].artifact`);
      const releaseId = `${owner}/${packageName}`;
      let publicInputs = entry.publicInputs;
      if (publicInputs && typeof publicInputs === "object") {
        const { profile, extra } = publicInputs;
        if ((profile !== "S" && profile !== "L") || (extra !== 0 && extra !== 1)) {
          throw new Error(`${releaseId} has an invalid public-input profile reference`);
        }
        publicInputs = readPrivateValueProfiles(root).find((p) => p.name === profile).publicInputs + extra;
      }
      const kind = Object.hasOwn(CIRCUIT_KINDS, entry.role) ? CIRCUIT_KINDS[entry.role] : undefined;
      if (kind === undefined) throw new Error(`${releaseId} has an unknown role ${String(entry.role)}`);
      const provingRuntimes = entry.provingRuntimes;
      if (!Array.isArray(provingRuntimes) || provingRuntimes.length === 0
        || new Set(provingRuntimes).size !== provingRuntimes.length
        || provingRuntimes.some((runtime) => runtime !== "native" && runtime !== "browser")) {
        throw new Error(`${releaseId} must declare supported provingRuntimes`);
      }
      if (!Number.isSafeInteger(entry.srsPoints) || entry.srsPoints < 2 ** 18
        || 2 ** Math.round(Math.log2(entry.srsPoints)) !== entry.srsPoints) {
        throw new Error(`${releaseId} must pin a power-of-two srsPoints requirement`);
      }
      if (entry.pin !== undefined && !/^[A-Z][A-Z0-9_]*_VK_HASH$/.test(entry.pin)) {
        throw new Error(`${releaseId} has an invalid pin constant name`);
      }
      const links = entry.links ?? [];
      if (!Array.isArray(links) || links.some((link) => !Number.isSafeInteger(link?.callData) || link.callData < 0
        || (link.folds !== "application" && (!Array.isArray(link.folds) || link.folds.length === 0)))
        || new Set(links.map((link) => link.callData)).size !== links.length) {
        throw new Error(`${releaseId} has invalid links`);
      }
      return {
        releaseId,
        owner,
        ownerRoot,
        packageName,
        packagePath: join(ownerRoot, packageRelativePath),
        targetPath,
        sourceArtifactPath: posix.join(ownerRoot, targetPath),
        artifactId,
        proverArtifactPath: `prover-assets/${artifactId}.json`,
        verificationKeyPath: `vks/${artifactId}.chonk.vk`,
        role: entry.role,
        kind,
        publicInputs,
        provingRuntimes,
        srsPoints: entry.srsPoints,
        dependencies: entry.dependencies ?? [],
        profile: entry.profile,
        wrapper: entry.wrapper,
        fixture: entry.fixture === true,
        contractManifest: entry.contractManifest !== false,
        pin: entry.pin,
        links: links.map((link) => ({ callData: link.callData, folds: link.folds })),
      };
    });
  });
  const byPackage = new Map(entries.map((entry) => [entry.packageName, entry]));
  for (const entry of entries) {
    for (const name of entry.links.flatMap((link) => link.folds === "application" ? [] : link.folds)) {
      if (byPackage.get(name)?.pin === undefined) {
        throw new Error(`${entry.releaseId} depends on ${name}, which declares no pin constant`);
      }
    }
  }

  assertUnique(entries, "releaseId", "release identity");
  assertUnique(entries, "packageName", "Noir package name");
  assertUnique(entries, "artifactId", "artifact ID");
  assertUnique(entries, "packagePath", "package path");
  assertUnique(entries, "proverArtifactPath", "prover output path");
  assertUnique(entries, "verificationKeyPath", "verification-key output path");
  assertUnique(entries.filter((entry) => entry.pin !== undefined), "pin", "pin constant");
  return entries;
}

export function circuitByReleaseId(root = DEFAULT_ROOT) {
  return Object.fromEntries(circuitCatalog(root).map((entry) => [entry.releaseId, entry]));
}
