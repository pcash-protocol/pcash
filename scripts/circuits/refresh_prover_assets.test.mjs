import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIG_HASH = "13030151940514113388";

async function writeJson(root, relative, value) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value)}\n`);
}

/** A repository with one catalog circuit and its own copy of the module, which resolves sources beside itself. */
async function makeRepo() {
  const repo = await mkdtemp(path.join(tmpdir(), "pcash-prover-assets-test-"));
  const module = path.join(repo, "scripts", "circuits", "refresh_prover_assets.mjs");
  await mkdir(path.dirname(module), { recursive: true });
  for (const name of ["refresh_prover_assets.mjs", "catalog.mjs", "profile_config.mjs"]) {
    await copyFile(path.join(HERE, name), path.join(repo, "scripts", "circuits", name));
  }
  await writeJson(repo, "circuits/manifest.json", {
    owner: "protocol",
    circuits: [
      { package: "private_value_asset_creation_kernel", path: "private_value_asset_creation_kernel", role: "kernel", publicInputs: 0, provingRuntimes: ["native", "browser"], srsPoints: 262144 },
    ],
  });
  await writeJson(repo, "marketplace/circuits.json", { owner: "marketplace", circuits: [] });
  await writeJson(repo, "web/tokens/circuits.json", { owner: "tokens", circuits: [] });
  await writeJson(repo, "lineage/circuits.json", { owner: "lineage", circuits: [] });
  const { refreshProverAssets } = await import(pathToFileURL(module).href);
  return { repo, refresh: () => refreshProverAssets({ sourceRoot: repo, outputRoot: repo }) };
}

/** nargo's output for one program, built from sources at `sourcePath` whose text starts with `comment`. */
function builtArtifact(sourcePath, comment, hash) {
  return `{"artifact_version":1,"noir_version":"1.0.0-rc.3","hash":${hash},"abi":{"parameters":[]},"bytecode":"H4sI",`
    + `"debug_symbols":"${Buffer.from(`${sourcePath}:${comment.length}`).toString("base64")}",`
    + `"file_map":{"7":{"source":${JSON.stringify(`${comment}\nfn main() {}\n`)},"path":${JSON.stringify(sourcePath)}}}}`;
}

async function publishedFrom(text) {
  const { repo, refresh } = await makeRepo();
  await mkdir(path.join(repo, "circuits", "target"), { recursive: true });
  await writeFile(path.join(repo, "circuits", "target", "private_value_asset_creation_kernel.json"), text);
  refresh();
  return readFile(path.join(repo, "prover-assets", "private_value_asset_creation_kernel.json"), "utf8");
}

test("refresh installs a built artifact and fails on a circuit that was not built", async () => {
  const { repo, refresh } = await makeRepo();
  assert.throws(refresh, /ENOENT.*private_value_asset_creation_kernel\.json/);
  await writeJson(repo, "circuits/target/private_value_asset_creation_kernel.json", { bytecode: "local", file_map: {} });
  await writeJson(repo, "prover-assets/private_value_asset_creation_kernel.json", { bytecode: "old" });
  refresh();
  assert.deepEqual(
    JSON.parse(await readFile(path.join(repo, "prover-assets", "private_value_asset_creation_kernel.json"), "utf8")),
    { bytecode: "local" },
  );
});

test("a published artifact carries the program and nothing derived from its source text", async () => {
  const published = await publishedFrom(builtArtifact("/private/var/tmp/build/circuits/kernel/src/main.nr", "// kernel", BIG_HASH));
  assert.deepEqual(JSON.parse(published), {
    noir_version: "1.0.0-rc.3",
    abi: { parameters: [] },
    bytecode: "H4sI",
  });
});

test("moving or re-commenting a source leaves the published bytes unchanged", async () => {
  const original = await publishedFrom(builtArtifact("circuits/kernel/src/main.nr", "// kernel", BIG_HASH));
  assert.equal(await publishedFrom(builtArtifact("web/kernel/src/main.nr", "// kernel", BIG_HASH)), original);
  assert.equal(await publishedFrom(builtArtifact("circuits/kernel/src/main.nr", "// the kernel, reworded", "8420111477354347728")), original);
});
