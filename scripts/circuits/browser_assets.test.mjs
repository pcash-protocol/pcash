import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  BROWSER_SRS_POINTS,
  canonicalBrowserProverManifestPayload,
  createBrowserProverManifest,
  exportBrowserProverAssetSet,
  resolveBrowserProverAssets,
} from "./browser_assets.mjs";
import { circuitCatalog } from "./catalog.mjs";

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pcash-browser-assets-"));
  const bundle = join(root, "bundle");
  const toolRoot = join(root, "tools");
  for (const circuit of circuitCatalog().filter((entry) => !entry.fixture)) {
    write(join(bundle, "prover-assets", `${circuit.artifactId}.json`), `{"bytecode":"${circuit.artifactId}"}\n`);
    write(join(bundle, "vks", `${circuit.artifactId}.chonk.vk`), Buffer.from(circuit.artifactId));
  }
  write(join(bundle, "prover-assets", "unexpected.json"), "must not ship\n");
  write(join(bundle, "vks", "unexpected.chonk.vk"), "must not ship\n");
  const g1 = join(toolRoot, "crs", "bn254_g1.dat");
  write(g1, Buffer.from([1]));
  truncateSync(g1, Math.max(...BROWSER_SRS_POINTS) * 64 + 7);
  write(join(toolRoot, "crs", "bn254_g2.dat"), Buffer.from([2, 3]));
  write(join(toolRoot, "crs", "grumpkin_g1_v2.flat.dat"), Buffer.from([4, 5]));
  return { root, bundle, toolRoot };
}

describe("browser asset identity", () => {
  it("locks canonical JSON and asset-set hashing", () => {
    const artifacts = [{
      path: "/prover/a.json",
      bytes: 3,
      sha256: "0".repeat(64),
    }];
    const canonical = canonicalBrowserProverManifestPayload(artifacts);
    assert.equal(
      canonical,
      `{"artifacts":[{"bytes":3,"path":"/prover/a.json","sha256":"${"0".repeat(64)}"}],"version":1}`,
    );
    assert.equal(createHash("sha256").update(canonical).digest("hex"), "344d567fd0361ab6cfd89241719ebf08e9c56eef6069a6683d4b8bfe555145eb");
  });

  it("selects every non-fixture, non-lineage catalog circuit and preserves nested logical paths", () => {
    const { bundle, toolRoot } = fixture();
    const plan = resolveBrowserProverAssets({ bundle, toolRoot, required: true });
    assert.equal([...plan.byLogicalPath.keys()].some((path) => path.includes("unexpected")), false);
    assert.ok(plan.byLogicalPath.has("/prover/account_rule_large_batch_transfer_ecdsa.json"));
    assert.ok(plan.byLogicalPath.has("/crs/1048576/bn254_g1.dat"));
    assert.ok(plan.byLogicalPath.has("/prover/contracts/escrow/claim.json"));
    assert.ok(plan.byLogicalPath.has("/chonk-vks/contracts/escrow/claim.vk"));
  });

  it("exports one versioned tree and identical fixed-path descriptor", () => {
    const { root, bundle, toolRoot } = fixture();
    const plan = resolveBrowserProverAssets({ bundle, toolRoot, required: true });
    const expected = createBrowserProverManifest(plan);
    const publicRoot = join(root, "public");
    const { output } = exportBrowserProverAssetSet(plan, publicRoot, expected);
    const versioned = readFileSync(join(output, "manifest.json"), "utf8");
    assert.equal(readFileSync(join(publicRoot, "browser-prover-manifest.json"), "utf8"), versioned);
    assert.deepEqual(JSON.parse(versioned), expected);
    assert.equal(readFileSync(join(output, "prover", "contracts", "escrow", "claim.json"), "utf8").includes("claim"), true);
    assert.throws(
      () => exportBrowserProverAssetSet(plan, join(root, "other"), { ...expected, assetSetId: "f".repeat(64) }),
      /does not match the checked-in release/,
    );
  });

  it("resolves and exports through a symlinked bundle root", () => {
    const { root, bundle, toolRoot } = fixture();
    const link = join(root, "linked-bundle");
    symlinkSync(bundle, link, "dir");
    const plan = resolveBrowserProverAssets({ bundle: link, toolRoot, required: true });
    assert.ok(plan.byLogicalPath.has("/prover/contracts/escrow/claim.json"));
    const expected = createBrowserProverManifest(plan);
    const { output } = exportBrowserProverAssetSet(plan, join(root, "public"), expected);
    assert.equal(readFileSync(join(output, "prover", "contracts", "escrow", "claim.json"), "utf8").includes("claim"), true);
  });

  it("rejects symbolic links in selected bundle and CRS inputs", () => {
    const { root, bundle, toolRoot } = fixture();
    const target = join(root, "claim.json");
    write(target, "{}\n");
    symlinkSync(target, join(bundle, "prover-assets", "linked.json"));
    assert.throws(
      () => resolveBrowserProverAssets({ bundle, toolRoot, required: true }),
      /symbolic link/,
    );
    const g2 = join(toolRoot, "crs", "bn254_g2.dat");
    symlinkSync(g2, join(toolRoot, "crs", "linked-g2.dat"));
    assert.throws(() => {
      const fake = { assets: [{ logicalPath: "/crs/bn254_g2.dat", source: join(toolRoot, "crs", "linked-g2.dat"), size: 2 }] };
      createBrowserProverManifest(fake);
    }, /symbolic link/);
  });
});
