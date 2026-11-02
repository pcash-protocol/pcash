import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  PACKAGE_GRAPH,
  packageBoundaryFailures,
  packageManifestFailures,
} from "./check_package_boundaries.mjs";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), "pcash-package-boundaries-"));
  await writeJson(join(root, "package.json"), { workspaces: Object.keys(PACKAGE_GRAPH) });
  for (const [packageRoot, definition] of Object.entries(PACKAGE_GRAPH)) {
    await writeJson(join(root, packageRoot, "package.json"), { name: definition.name });
  }
  await mkdir(join(root, "wallet", "src"), { recursive: true });
  await writeFile(join(root, "wallet", "src", "index.ts"), "export {};\n");
  await mkdir(join(root, "sdk", "src", "wallet"), { recursive: true });
  await writeFile(join(root, "sdk", "src", "wallet", "index.ts"), "export {};\n");
  return root;
}

test("the checked-in repository obeys the declared package graph", () => {
  assert.deepEqual(packageBoundaryFailures(), []);
});

test("package manifests reject architecture-reversing dependencies", () => {
  assert.deepEqual(
    packageManifestFailures("sdk", {
      name: "@pcash/sdk",
      dependencies: { "@pcash/web": "^0.1.0" },
    }),
    ["sdk/package.json: @pcash/sdk cannot depend on @pcash/web"],
  );
  assert.deepEqual(
    packageManifestFailures("wallet", {
      name: "@pcash/wallet",
      devDependencies: { "@pcash/marketplace": "^0.1.0" },
    }),
    ["wallet/package.json: @pcash/wallet cannot depend on @pcash/marketplace"],
  );
});

test("source imports reject edges outside the declared graph", async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, "sdk", "src"), { recursive: true });
  await writeFile(join(root, "sdk", "src", "bad.ts"), 'import "@pcash/web";\n');
  await mkdir(join(root, "wallet", "src"), { recursive: true });
  await writeFile(
    join(root, "wallet", "src", "bad.ts"),
    'import "@pcash/marketplace";\n',
  );

  const failures = packageBoundaryFailures(root);
  assert.ok(failures.includes("sdk/src/bad.ts: @pcash/sdk cannot import @pcash/web"));
  assert.ok(failures.includes(
    "wallet/src/bad.ts: @pcash/wallet cannot import @pcash/marketplace",
  ));
});

test("allowed source imports must also be declared in package.json", async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, "wallet", "src"), { recursive: true });
  await writeFile(join(root, "wallet", "src", "missing.ts"), 'import "@pcash/sdk/protocol";\n');
  assert.ok(packageBoundaryFailures(root).includes(
    "wallet/src/missing.ts: @pcash/sdk is imported but absent from wallet/package.json",
  ));
});

test("test-only dependencies are importable from tests and never from sources", async () => {
  const root = await repositoryFixture();
  await writeJson(join(root, "wallet", "package.json"), {
    name: "@pcash/wallet",
    devDependencies: { "@pcash/test-support": "0.0.0" },
  });
  await mkdir(join(root, "wallet", "test"), { recursive: true });
  await writeFile(join(root, "wallet", "test", "sim.test.ts"), 'import "@pcash/test-support/chain-sim";\n');
  await writeFile(join(root, "wallet", "src", "bad.ts"), 'import "@pcash/test-support/chain-sim";\n');
  const failures = packageBoundaryFailures(root);
  assert.ok(failures.includes("wallet/src/bad.ts: @pcash/wallet cannot import @pcash/test-support/chain-sim"));
  assert.ok(!failures.some((failure) => failure.startsWith("wallet/test/")));
});

test("the web product can import only the headless Marketplace app surface", async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, "web", "src"), { recursive: true });
  await writeJson(join(root, "web", "package.json"), {
    name: "@pcash/web",
    dependencies: { "@pcash/marketplace": "0.1.0" },
  });
  await writeFile(join(root, "web", "src", "bad.ts"), 'import "@pcash/marketplace";\n');
  assert.ok(packageBoundaryFailures(root).includes(
    "web/src/bad.ts: web must import the headless Marketplace app surface, not @pcash/marketplace",
  ));
});

test("the web product can import only the headless Tokens app surface", async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, "web", "src"), { recursive: true });
  await writeJson(join(root, "web", "package.json"), {
    name: "@pcash/web",
    dependencies: { "@pcash/tokens": "0.1.0" },
  });
  await writeFile(join(root, "web", "src", "bad.ts"), 'import "@pcash/tokens";\n');
  await writeFile(join(root, "web", "src", "good.ts"), 'import "@pcash/tokens/app";\n');
  assert.deepEqual(packageBoundaryFailures(root), [
    "web/src/bad.ts: web must import the headless Tokens app surface, not @pcash/tokens",
  ]);
});

test("token templates are browser-safe", async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, "web", "tokens", "src"), { recursive: true });
  await writeFile(join(root, "web", "tokens", "src", "bad.ts"), 'import { readFileSync } from "node:fs";\n');
  assert.ok(packageBoundaryFailures(root).includes("web/tokens/src/bad.ts: browser-safe source imports node:"));
});

test("a package nested in web is checked under its own rules, not web's", async () => {
  const root = await repositoryFixture();
  await writeJson(join(root, "web", "tokens", "package.json"), {
    name: "@pcash/tokens",
    dependencies: { "@pcash/sdk": "0.1.0" },
  });
  await mkdir(join(root, "web", "tokens", "src"), { recursive: true });
  await writeFile(join(root, "web", "tokens", "src", "index.ts"), 'import "@pcash/sdk/utils";\nimport "./app.ts";\n');
  await writeFile(join(root, "web", "tokens", "src", "app.ts"), "export {};\n");
  await mkdir(join(root, "web", "src"), { recursive: true });
  await writeFile(join(root, "web", "src", "reach.ts"), 'import "../tokens/src/app.ts";\n');
  assert.deepEqual(packageBoundaryFailures(root), ["web/src/reach.ts: cross-package relative import ../tokens/src/app.ts"]);
});

test("the wallet root cannot reach browser adapters through another barrel", async () => {
  const root = await repositoryFixture();
  await mkdir(join(root, "sdk", "src", "wallet", "web"), { recursive: true });
  await writeFile(join(root, "sdk", "src", "wallet", "index.ts"), 'export * from "./walletApi.ts";\n');
  await writeFile(join(root, "sdk", "src", "wallet", "walletApi.ts"), 'export * from "./web/browserDatabase.ts";\n');
  await writeFile(join(root, "sdk", "src", "wallet", "web", "browserDatabase.ts"), "export {};\n");
  assert.ok(packageBoundaryFailures(root).includes(
    "sdk/src/wallet/index.ts: root export closure reaches a web adapter; use @pcash/sdk/wallet/web",
  ));
});
