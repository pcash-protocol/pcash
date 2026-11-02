/*!
 * fs.ts - filesystem access for bcfg
 * Adapted from bcfg v0.2.2 lib/fs.js and lib/fs-browser.js; see PROVENANCE.md.
 */

// Upstream swapped this module for fs-browser.js through the package.json
// `browser` field. Resolving node:fs at runtime instead keeps the module free of
// static node: imports, so a browser gets `unsupported` from this same file.
const fs = globalThis.process?.getBuiltinModule?.('node:fs');

export function readFileSync(path: string, encoding: 'utf8'): string {
  if (fs === undefined)
    throw new Error('node:fs is unavailable.');
  return fs.readFileSync(path, encoding);
}

export const unsupported = fs === undefined;
