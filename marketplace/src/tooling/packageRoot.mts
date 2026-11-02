// Locate this package's root directory from a module inside it.
//
// These modules shell out to `forge` against contract *sources* that live
// beside the package rather than inside it, so they need a stable anchor. Taking
// that anchor from the module's own URL breaks the moment the package is
// compiled, because a module under `dist/` sits one directory deeper than its
// source and every relative path silently shifts with it — producing a
// not-found for a file that is right where it always was.
//
// Walking up to the nearest package.json gives the same answer from either
// layout.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function packageRootFrom(moduleUrl: string): string {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    if (existsSync(path.join(directory, "package.json"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`no package.json above ${moduleUrl}`);
    }
    directory = parent;
  }
}

/** A path owned by this package, stable from source and emitted modules. */
export function packagePath(moduleUrl: string, ...segments: string[]): string {
  return path.join(packageRootFrom(moduleUrl), ...segments);
}
