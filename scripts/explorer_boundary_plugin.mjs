import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function resolvedPath(id) {
  let value = id.replace(/^\0/, "").split(/[?#]/, 1)[0];
  if (value.startsWith("/@fs/")) value = value.slice("/@fs".length);
  if (value.startsWith("file://")) value = fileURLToPath(value);
  if (!isAbsolute(value)) return undefined;
  const path = normalize(value);
  return existsSync(path) ? realpathSync(path) : path;
}

function inside(path, root) {
  return path === root || path.startsWith(`${root}${sep}`);
}

export function explorerBoundaryPlugin({ repositoryRoot, webRoot, explorerEntry, requireExplorerEntry }) {
  const repository = realpathSync(repositoryRoot);
  const web = realpathSync(webRoot);
  const configuredExplorerEntry = existsSync(explorerEntry)
    ? realpathSync(explorerEntry)
    : normalize(resolve(explorerEntry));
  const explorerRoot = dirname(configuredExplorerEntry);
  const sdkRoot = resolve(repository, "sdk");
  const sdkReadEntries = new Set([
    resolve(sdkRoot, "dist", "clients", "index.js"),
    resolve(sdkRoot, "src", "clients", "index.ts"),
    resolve(sdkRoot, "dist", "delivery", "index.js"),
    resolve(sdkRoot, "src", "delivery", "index.ts"),
    resolve(sdkRoot, "dist", "names", "index.js"),
    resolve(sdkRoot, "src", "names", "index.ts"),
    resolve(sdkRoot, "dist", "protocol", "index.js"),
    resolve(sdkRoot, "src", "protocol", "index.ts"),
    resolve(sdkRoot, "dist", "utils", "index.js"),
    resolve(sdkRoot, "src", "utils", "index.ts"),
  ].map((path) => existsSync(path) ? realpathSync(path) : normalize(path)));
  const forbiddenRoots = [
    resolve(repository, "wallet"),
    resolve(repository, "marketplace"),
    resolve(web, "src", "lib"),
    resolve(web, "src", "routes", "wallet"),
    resolve(web, "src", "routes", "marketplace"),
  ];
  return {
    name: "pcash-explorer-resolved-boundary",
    apply: "build",
    buildEnd(error) {
      if (error !== undefined) return;
      const roots = [];
      let foundExplorerEntry = false;
      for (const id of this.getModuleIds()) {
        const path = resolvedPath(id);
        if (path === configuredExplorerEntry) {
          foundExplorerEntry = true;
          roots.push(id);
        } else if (path !== undefined && inside(path, explorerRoot) && this.getModuleInfo(id)?.isEntry === true) {
          roots.push(id);
        }
      }
      if (requireExplorerEntry && !foundExplorerEntry) {
        this.error(`Explorer resolved module graph is missing its configured entry: ${configuredExplorerEntry}`);
      }
      const visited = new Set();
      const pending = [...roots];
      while (pending.length > 0) {
        const id = pending.pop();
        if (id === undefined || visited.has(id)) continue;
        visited.add(id);
        const path = resolvedPath(id);
        if (path !== undefined && forbiddenRoots.some((root) => inside(path, root))) {
          this.error(`Explorer resolved module graph reaches private product code: ${path}`);
        }
        const info = this.getModuleInfo(id);
        if (info === null) continue;
        if (/\bnew\s+(?:Shared)?Worker\s*\(/.test(info.code ?? "")) {
          this.error(`Explorer resolved module graph may not spawn workers: ${path ?? id}`);
        }
        for (const importedId of [...info.importedIds, ...info.dynamicallyImportedIds]) {
          const importedPath = resolvedPath(importedId);
          if (importedPath !== undefined
            && inside(importedPath, sdkRoot)
            && (path === undefined || !inside(path, sdkRoot))
            && !sdkReadEntries.has(importedPath)) {
            this.error(`Explorer may enter the SDK only through @pcash/sdk/clients, @pcash/sdk/delivery, @pcash/sdk/names, @pcash/sdk/protocol, or @pcash/sdk/utils: ${importedPath}`);
          }
          pending.push(importedId);
        }
      }
    },
  };
}
