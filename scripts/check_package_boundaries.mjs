#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "../sdk/src/blgr/index.ts";

const DEFAULT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

export const PACKAGE_GRAPH = Object.freeze({
  sdk: { name: "@pcash/sdk", dependencies: [], testDependencies: ["@pcash/test-support"] },
  relayer: { name: "@pcash/relayer", dependencies: ["@pcash/sdk", "@pcash/wallet"] },
  wallet: { name: "@pcash/wallet", dependencies: ["@pcash/sdk"], testDependencies: ["@pcash/test-support"] },
  marketplace: {
    name: "@pcash/marketplace",
    dependencies: ["@pcash/sdk"],
    testDependencies: ["@pcash/test-support", "@pcash/wallet"],
  },
  "web/board": { name: "@pcash/board", dependencies: ["@pcash/sdk"] },
  "web/tokens": { name: "@pcash/tokens", dependencies: ["@pcash/sdk"] },
  lineage: { name: "@pcash/lineage", dependencies: ["@pcash/sdk", "@pcash/test-support"] },
  web: {
    name: "@pcash/web",
    dependencies: ["@pcash/sdk", "@pcash/marketplace", "@pcash/tokens", "@pcash/board"],
  },
  e2e: {
    name: "@pcash/e2e",
    dependencies: ["@pcash/sdk", "@pcash/wallet", "@pcash/marketplace", "@pcash/tokens", "@pcash/relayer", "@pcash/test-support", "@pcash/lineage", "@pcash/board"],
  },
  bench: {
    name: "@pcash/bench",
    dependencies: ["@pcash/sdk", "@pcash/marketplace", "@pcash/test-support", "@pcash/lineage"],
  },
  "test-support": { name: "@pcash/test-support", dependencies: ["@pcash/sdk"] },
});

const PACKAGE_ROOTS = Object.keys(PACKAGE_GRAPH);
// Application packages the web product reaches only through their `/app` entry.
const WEB_APP_SURFACES = new Map([["@pcash/marketplace", "Marketplace"], ["@pcash/tokens", "Tokens"]]);
const ROOT_BY_PACKAGE = new Map(Object.entries(PACKAGE_GRAPH).map(([root, entry]) => [entry.name, root]));

function filesUnder(repositoryRoot, packageRoot) {
  const files = [];
  const visit = (path) => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (["dist", "node_modules", "target"].includes(name)) continue;
        visit(join(path, name));
      }
    } else if (SOURCE_EXTENSIONS.has(extname(path))) files.push(path);
  };
  visit(resolve(repositoryRoot, packageRoot));
  return files;
}

// The innermost package root: web's feature packages sit inside web/.
function ownerOf(repositoryRoot, path) {
  return PACKAGE_ROOTS.filter((root) => {
    const absolute = resolve(repositoryRoot, root);
    return path === absolute || path.startsWith(`${absolute}${sep}`);
  }).sort((a, b) => b.length - a.length)[0];
}

function importSpecifiers(text) {
  return [...text.matchAll(/(?:from\s*|import\s*\(|import\s+)["']([^"']+)["']/g)]
    .map((match) => match[1]);
}

function internalPackage(specifier) {
  for (const packageName of ROOT_BY_PACKAGE.keys()) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) return packageName;
  }
  return undefined;
}

function relativeModules(fromFile, specifier) {
  const normalizedSpecifier = specifier.split(/[?#]/, 1)[0];
  if (normalizedSpecifier === undefined || normalizedSpecifier === "") return [];
  const path = resolve(dirname(fromFile), normalizedSpecifier);
  const extension = extname(path);
  const candidates = [path];
  if (extension === "") {
    for (const sourceExtension of SOURCE_EXTENSIONS) candidates.push(`${path}${sourceExtension}`);
    for (const sourceExtension of SOURCE_EXTENSIONS) candidates.push(join(path, `index${sourceExtension}`));
  } else if (SOURCE_EXTENSIONS.has(extension)) {
    const stem = path.slice(0, -extension.length);
    for (const sourceExtension of SOURCE_EXTENSIONS) candidates.push(`${stem}${sourceExtension}`);
  }
  return [...new Set(candidates)].filter((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function relativeImportClosure(entry) {
  const visited = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || visited.has(path)) continue;
    visited.add(path);
    const text = readFileSync(path, "utf8");
    for (const specifier of importSpecifiers(text)) {
      if (!specifier.startsWith(".")) continue;
      pending.push(...relativeModules(path, specifier));
    }
  }
  return visited;
}

function declaredDependencies(manifest) {
  const names = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      throw new Error(`package.json ${field} must be an object`);
    }
    for (const name of Object.keys(dependencies)) names.add(name);
  }
  return names;
}

export function packageManifestFailures(packageRoot, manifest) {
  const expected = PACKAGE_GRAPH[packageRoot];
  if (expected === undefined) throw new Error(`unknown package root ${packageRoot}`);
  const failures = [];
  if (manifest.name !== expected.name) {
    failures.push(`${packageRoot}/package.json: expected package name ${expected.name}`);
  }
  const allowed = new Set([...expected.dependencies, ...(expected.testDependencies ?? [])]);
  for (const dependency of declaredDependencies(manifest)) {
    if (!dependency.startsWith("@pcash/")) continue;
    if (!ROOT_BY_PACKAGE.has(dependency)) {
      failures.push(`${packageRoot}/package.json: unknown internal dependency ${dependency}`);
    } else if (!allowed.has(dependency)) {
      failures.push(`${packageRoot}/package.json: ${expected.name} cannot depend on ${dependency}`);
    }
  }
  return failures;
}

export function packageBoundaryFailures(repositoryRoot = DEFAULT_ROOT) {
  const failures = [];
  const manifests = new Map();
  const rootManifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
  const actualWorkspaces = [...(Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : [])].sort();
  const expectedWorkspaces = [...PACKAGE_ROOTS].sort();
  if (JSON.stringify(actualWorkspaces) !== JSON.stringify(expectedWorkspaces)) {
    failures.push(`package.json: workspaces must be exactly ${expectedWorkspaces.join(", ")}`);
  }

  for (const packageRoot of PACKAGE_ROOTS) {
    const manifestPath = resolve(repositoryRoot, packageRoot, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifests.set(packageRoot, manifest);
    failures.push(...packageManifestFailures(packageRoot, manifest));
  }

  for (const packageRoot of PACKAGE_ROOTS) {
    const declared = declaredDependencies(manifests.get(packageRoot));
    const testRoot = resolve(repositoryRoot, packageRoot, "test");
    for (const path of filesUnder(repositoryRoot, packageRoot)) {
      if (ownerOf(repositoryRoot, path) !== packageRoot) continue;
      const text = readFileSync(path, "utf8");
      const shown = relative(repositoryRoot, path);
      // Test-only dependencies are importable from the package's tests, never its sources.
      const allowed = new Set([
        ...PACKAGE_GRAPH[packageRoot].dependencies,
        ...(path.startsWith(`${testRoot}${sep}`) ? PACKAGE_GRAPH[packageRoot].testDependencies ?? [] : []),
      ]);
      for (const specifier of importSpecifiers(text)) {
        if (specifier === "@pcash/sdk/wallet/testing" || specifier.startsWith("@pcash/sdk/wallet/testing/")) {
          const walletTests = resolve(repositoryRoot, "wallet", "test");
          if (!path.startsWith(`${walletTests}${sep}`)) {
            failures.push(`${shown}: only wallet tests may import @pcash/sdk/wallet/testing`);
          }
        }
        if (specifier.startsWith("@pcash/")) {
          const importedPackage = internalPackage(specifier);
          if (importedPackage === undefined) {
            failures.push(`${shown}: unknown internal package import ${specifier}`);
          } else if (importedPackage !== PACKAGE_GRAPH[packageRoot].name) {
            const appSurface = WEB_APP_SURFACES.get(importedPackage);
            if (packageRoot === "web" && appSurface !== undefined && specifier !== `${importedPackage}/app`) {
              failures.push(`${shown}: web must import the headless ${appSurface} app surface, not ${specifier}`);
            }
            if (!allowed.has(importedPackage)) {
              failures.push(`${shown}: ${PACKAGE_GRAPH[packageRoot].name} cannot import ${specifier}`);
            } else if (!declared.has(importedPackage)) {
              failures.push(`${shown}: ${importedPackage} is imported but absent from ${packageRoot}/package.json`);
            }
          }
        }
        if (!specifier.startsWith(".")) continue;
        const targetOwner = ownerOf(repositoryRoot, resolve(dirname(path), specifier));
        if (targetOwner !== undefined && targetOwner !== packageRoot) {
          failures.push(`${shown}: cross-package relative import ${specifier}`);
        }
      }
    }
  }

  for (const [root, excluded] of [
    ["sdk/src/browser-prover", []],
    ["sdk/src/delivery", []],
    ["sdk/src/names", []],
    ["sdk/src/wallet", ["node"]],
    ["marketplace/src", ["tooling"]],
    ["web/tokens/src", ["tooling"]],
  ]) {
    for (const path of filesUnder(repositoryRoot, root)) {
      const relativePath = relative(resolve(repositoryRoot, root), path);
      if (excluded.some((name) => relativePath === name || relativePath.startsWith(`${name}${sep}`))) continue;
      const text = readFileSync(path, "utf8");
      if (text.includes('"node:') || text.includes("'node:")) {
        failures.push(`${relative(repositoryRoot, path)}: browser-safe source imports node:`);
      }
    }
  }

  const walletRoot = resolve(repositoryRoot, "sdk/src/wallet/index.ts");
  if (existsSync(walletRoot)) {
    const walletWebRoot = resolve(repositoryRoot, "sdk/src/wallet/web");
    const closure = relativeImportClosure(walletRoot);
    if ([...closure].some((path) => path.startsWith(`${walletWebRoot}${sep}`))) {
      failures.push("sdk/src/wallet/index.ts: root export closure reaches a web adapter; use @pcash/sdk/wallet/web");
    }
    if (closure.has(resolve(repositoryRoot, "sdk/src/wallet/testing.ts"))) {
      failures.push("sdk/src/wallet/index.ts: root export closure reaches the testing seam; use @pcash/sdk/wallet/testing");
    }
    if (closure.has(resolve(repositoryRoot, "sdk/src/wallet/database.ts"))) {
      failures.push("sdk/src/wallet/index.ts: root export closure reaches the database host; use @pcash/sdk/wallet/database");
    }
  }
  return failures;
}

const invokedAs = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedAs === fileURLToPath(import.meta.url)) {
  const failures = packageBoundaryFailures();
  if (failures.length > 0) throw new Error(`package boundary violations:\n${failures.join("\n")}`);
  const logger = new Logger("info");
  await logger.open();
  logger.info("package boundaries passed");
}
