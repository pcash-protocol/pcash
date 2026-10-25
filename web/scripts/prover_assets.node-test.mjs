import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  BROWSER_SRS_POINTS,
  browserProverAssetsMiddleware,
  resolveBrowserProverAssets,
  stageBrowserProverAssets,
} from "./prover_assets.mjs";
import { circuitCatalog } from "../../scripts/circuits/catalog.mjs";

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function fixture({ includeG1 = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pcash-web-prover-assets-"));
  const bundle = join(root, "bundle");
  const toolRoot = join(root, "tools");
  for (const circuit of circuitCatalog().filter((entry) => !entry.fixture)) {
    write(join(bundle, "prover-assets", `${circuit.artifactId}.json`), `{"bytecode":"${circuit.artifactId}"}\n`);
    write(join(bundle, "vks", `${circuit.artifactId}.chonk.vk`), Buffer.from([1, 2, 3]));
  }
  write(join(bundle, "prover-assets", "account_rule_full_ecdsa.json"), '{"bytecode":"fixture"}\n');
  write(join(bundle, "prover-assets", "account_rule_multisig.json"), '{"bytecode":"fixture"}\n');
  write(join(bundle, "prover-assets", "account_rule_asset_covenant.json"), '{"bytecode":"fixture"}\n');
  write(join(bundle, "vks", "account_rule_full_ecdsa.chonk.vk"), Buffer.from([7]));
  write(join(bundle, "vks", "account_rule_multisig.chonk.vk"), Buffer.from([7]));
  write(join(bundle, "vks", "account_rule_asset_covenant.chonk.vk"), Buffer.from([7]));
  write(join(bundle, "vks", "ignored.plonk.vk"), Buffer.from([7]));
  if (includeG1) {
    const g1 = join(toolRoot, "crs", "bn254_g1.dat");
    write(g1, Buffer.from([9]));
    truncateSync(g1, Math.max(...BROWSER_SRS_POINTS) * 64 + 19);
  }
  write(join(toolRoot, "crs", "bn254_g2.dat"), Buffer.from([10, 11]));
  write(join(toolRoot, "crs", "grumpkin_g1_v2.flat.dat"), Buffer.from([12, 13]));
  return { root, bundle, toolRoot };
}

describe("browser prover asset resolution", () => {
  it("keeps an unconfigured ordinary web run asset-free", () => {
    assert.equal(resolveBrowserProverAssets({ toolRoot: "/not/used" }), undefined);
    assert.throws(
      () => resolveBrowserProverAssets({ toolRoot: "/not/used", required: true }),
      /PCASH_CIRCUIT_BUNDLE is required/,
    );
  });

  it("fails before startup when a configured pinned CRS is incomplete", () => {
    const { bundle, toolRoot } = fixture({ includeG1: false });
    assert.throws(
      () => resolveBrowserProverAssets({ bundle, toolRoot }),
      /BN254 G1 CRS is missing/,
    );
  });

  it("shares recursive URL mapping and G1 truncation with production staging", () => {
    const { root, bundle, toolRoot } = fixture();
    const plan = resolveBrowserProverAssets({ bundle, toolRoot, required: true });
    assert.ok(plan);
    assert.ok(plan.byLogicalPath.has("/prover/account_rule_large_batch_transfer_ecdsa.json"));
    assert.equal([...plan.byLogicalPath.keys()].some((path) => /full_ecdsa|multisig|asset_covenant/.test(path)), false);
    assert.ok(plan.byLogicalPath.has("/prover/contracts/escrow/claim.json"));
    assert.ok(plan.byLogicalPath.has("/chonk-vks/contracts/escrow/claim.vk"));
    assert.deepEqual(
      [...plan.byLogicalPath.keys()].filter((path) => path.startsWith("/crs/")),
      [
        ...BROWSER_SRS_POINTS.map((points) => `/crs/${points}/bn254_g1.dat`),
        "/crs/bn254_g2.dat",
        "/crs/grumpkin_g1_v2.flat.dat",
      ].sort(),
    );

    const dist = join(root, "dist");
    stageBrowserProverAssets(plan, dist);
    assert.equal(readFileSync(join(dist, "chonk-vks", "contracts", "escrow", "claim.vk")).toString("hex"), "010203");
    for (const points of BROWSER_SRS_POINTS) assert.equal(statSync(join(dist, "crs", String(points), "bn254_g1.dat")).size, points * 64);
  });
});

describe("browser prover asset middleware", () => {
  const { bundle, toolRoot } = fixture();
  const plan = resolveBrowserProverAssets({ bundle, toolRoot, required: true });
  const middleware = browserProverAssetsMiddleware(plan);
  const versionedMiddleware = browserProverAssetsMiddleware(plan, "/release-id");
  let server;
  let origin;

  before(async () => {
    server = createServer((request, response) => {
      middleware(request, response, () => {
        versionedMiddleware(request, response, () => {
          response.statusCode = 404;
          response.end("not found");
        });
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("serves only exact planned paths and ignores query strings", async () => {
    const key = await fetch(`${origin}/chonk-vks/contracts/escrow/claim.vk?cache=ignored`);
    assert.equal(key.status, 200);
    assert.equal(key.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(new Uint8Array(await key.arrayBuffer()), new Uint8Array([1, 2, 3]));

    const versioned = await fetch(`${origin}/release-id/chonk-vks/contracts/escrow/claim.vk`);
    assert.equal(versioned.status, 200);
    assert.deepEqual(new Uint8Array(await versioned.arrayBuffer()), new Uint8Array([1, 2, 3]));

    assert.equal((await fetch(`${origin}/chonk-vks/contracts/escrow/claim.chonk.vk`)).status, 404);
    assert.equal((await fetch(`${origin}/prover/../bundle-manifest.json`)).status, 404);
  });
});
