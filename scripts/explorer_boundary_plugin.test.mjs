import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { build } from "vite";
import { explorerBoundaryPlugin } from "./explorer_boundary_plugin.mjs";

async function write(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

// Vite resolves modules to real paths but keeps `root` as given, so a symlinked
// temp directory (macOS /var -> /private/var) breaks the HTML emit.
async function temporaryRepository(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function rejectedExplorerBuild(explorerSource, files = {}) {
  const repositoryRoot = await temporaryRepository("pcash-explorer-boundary-");
  const webRoot = join(repositoryRoot, "web");
  await write(join(webRoot, "index.html"), '<script type="module" src="/src/main.ts"></script>\n');
  await write(join(webRoot, "src", "main.ts"), 'import "./routes/explorer/ExplorerRoute.tsx";\n');
  const source = typeof explorerSource === "function" ? explorerSource({ repositoryRoot, webRoot }) : explorerSource;
  await write(join(webRoot, "src", "routes", "explorer", "ExplorerRoute.tsx"), source);
  await write(join(webRoot, "src", "lib", "private.ts"), "export const privateState = true;\n");
  for (const [path, value] of Object.entries(files)) {
    await write(join(webRoot, path), typeof value === "function" ? value({ repositoryRoot, webRoot }) : value);
  }
  const explorerEntry = join(webRoot, "src", "routes", "explorer", "ExplorerRoute.tsx");
  const boundary = (requireExplorerEntry) => explorerBoundaryPlugin({
    repositoryRoot,
    webRoot,
    explorerEntry,
    requireExplorerEntry,
  });
  await assert.rejects(build({
    root: webRoot,
    logLevel: "silent",
    plugins: [boundary(true)],
    worker: { format: "es", plugins: () => [boundary(false)] },
    build: { write: false },
  }), /Explorer (?:resolved module graph reaches private product code|resolved module graph may not spawn workers|may enter the SDK only)/);
}

test("the main build requires the configured Explorer entry in its graph", async () => {
  const repositoryRoot = await temporaryRepository("pcash-explorer-boundary-");
  const webRoot = join(repositoryRoot, "web");
  const configuredExplorerEntry = join(webRoot, "src", "routes", "explorer", "ExplorerRoute.tsx");
  const renamedExplorerEntry = join(webRoot, "src", "routes", "explorer", "RenamedRoute.tsx");
  await write(join(webRoot, "index.html"), '<script type="module" src="/src/main.ts"></script>\n');
  await write(join(webRoot, "src", "main.ts"), 'import "./routes/explorer/RenamedRoute.tsx";\n');
  await write(configuredExplorerEntry, "export {};\n");
  await write(renamedExplorerEntry, "export {};\n");
  await assert.rejects(build({
    root: webRoot,
    logLevel: "silent",
    plugins: [explorerBoundaryPlugin({
      repositoryRoot,
      webRoot,
      explorerEntry: configuredExplorerEntry,
      requireExplorerEntry: true,
    })],
    build: { write: false },
  }), /Explorer resolved module graph is missing its configured entry/);

  await write(join(webRoot, "src", "lib", "private.ts"), "export const privateState = true;\n");
  await write(renamedExplorerEntry, 'import "../../lib/private.ts";\n');
  await assert.rejects(build({
    root: webRoot,
    logLevel: "silent",
    plugins: [explorerBoundaryPlugin({
      repositoryRoot,
      webRoot,
      explorerEntry: renamedExplorerEntry,
      requireExplorerEntry: true,
    })],
    build: { write: false },
  }), /Explorer resolved module graph reaches private product code/);
});

test("the resolved Explorer graph rejects Vite query and worker edges", async () => {
  await rejectedExplorerBuild(
    'import Worker from "./bridge.ts?worker";\nvoid Worker;\n',
    { "src/routes/explorer/bridge.ts": 'import "../../lib/private.ts";\n' },
  );
  await rejectedExplorerBuild(
    'new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });\n',
    { "src/routes/explorer/worker.ts": 'import "../../lib/private.ts";\n' },
  );
  await rejectedExplorerBuild(
    'import "../../components/worker-launcher.ts";\n',
    {
      "src/components/worker-launcher.ts": 'new Worker(new URL("../shared/worker.ts", import.meta.url), { type: "module" });\n',
      "src/shared/worker.ts": 'import "../lib/private.ts";\n',
    },
  );
  await rejectedExplorerBuild(
    'import Worker from "../../shared/worker.ts?worker";\nvoid Worker;\n',
    { "src/shared/worker.ts": 'import "../lib/private.ts";\n' },
  );
});

test("the resolved Explorer graph rejects glob and root-absolute edges", async () => {
  await rejectedExplorerBuild('const modules = import.meta.glob("/src/lib/*.ts", { eager: true });\nvoid modules;\n');
  await rejectedExplorerBuild('import "/src/lib/private.ts";\n');
  await rejectedExplorerBuild(({ webRoot }) => `import "/@fs/${join(webRoot, "src", "lib", "private.ts")}";\n`);
  await rejectedExplorerBuild('import(`../../lib/private.ts`);\n');
});

test("the resolved Explorer graph follows Vite extension precedence", async () => {
  await rejectedExplorerBuild(
    'import "./collision";\n',
    {
      "src/routes/explorer/collision.js": "export {};\n",
      "src/routes/explorer/collision.mjs": 'import "../../lib/private.ts";\n',
    },
  );
});

test("the resolved Explorer graph follows CommonJS bridges", async () => {
  await rejectedExplorerBuild(
    'import "./bridge.cjs";\n',
    { "src/routes/explorer/bridge.cjs": 'module.exports = require("../../lib/private.ts");\n' },
  );
});

test("the resolved Explorer graph can enter SDK only through its read entries", async () => {
  await rejectedExplorerBuild(
    'import "../../components/sdk-bridge.ts";\n',
    {
      "src/components/sdk-bridge.ts": ({ repositoryRoot }) => `import "/@fs/${join(repositoryRoot, "sdk", "dist", "wallet", "index.js")}";\n`,
      "../sdk/dist/wallet/index.js": "export const wallet = true;\n",
    },
  );
});

test("the Explorer can use the SDK utils entry", async () => {
  const repositoryRoot = await temporaryRepository("pcash-explorer-utils-");
  const webRoot = join(repositoryRoot, "web");
  const explorerEntry = join(webRoot, "src/routes/explorer/ExplorerRoute.tsx");
  await write(join(webRoot, "index.html"), '<script type="module" src="/src/routes/explorer/ExplorerRoute.tsx"></script>');
  await write(explorerEntry, `import "/@fs/${join(repositoryRoot, "sdk/dist/utils/index.js")}";`);
  await write(join(repositoryRoot, "sdk/dist/utils/index.js"), 'console.log("hex helpers");');
  await build({ root: webRoot, logLevel: "silent", build: { write: false }, plugins: [explorerBoundaryPlugin({ repositoryRoot, webRoot, explorerEntry, requireExplorerEntry: true })] });
});

test("the Explorer can use the shared names UI and SDK entry without private product code", async () => {
  const repositoryRoot = await temporaryRepository("pcash-explorer-names-");
  const webRoot = join(repositoryRoot, "web");
  const explorerEntry = join(webRoot, "src/routes/explorer/ExplorerRoute.tsx");
  await write(join(webRoot, "index.html"), '<script type="module" src="/src/routes/explorer/ExplorerRoute.tsx"></script>');
  await write(explorerEntry, 'import "../../names/names.ts";');
  await write(join(webRoot, "src/names/names.ts"), `import "/@fs/${join(repositoryRoot, "sdk/dist/names/index.js")}";`);
  await write(join(repositoryRoot, "sdk/dist/names/index.js"), 'console.log("public naming reads");');
  await build({ root: webRoot, logLevel: "silent", build: { write: false }, plugins: [explorerBoundaryPlugin({ repositoryRoot, webRoot, explorerEntry, requireExplorerEntry: true })] });
});
