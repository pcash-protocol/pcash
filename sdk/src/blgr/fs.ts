/*!
 * fs.ts - filesystem access for blgr
 * Adapted from blgr v0.2.1 lib/fs.js and lib/fs-browser.js; see PROVENANCE.md.
 */

// Upstream swapped this module for fs-browser.js through the package.json
// `browser` field. Resolving node:fs at runtime instead keeps the module free of
// static node: imports, so a browser gets `unsupported` from this same file.
const fs = globalThis.process?.getBuiltinModule?.('node:fs');

/**
 * The parts of a node:fs WriteStream the logger uses.
 */

export interface LogStream {
  write(msg: string): boolean;
  close(): void;
  once(event: string, listener: (...args: any[]) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
  removeAllListeners(event: string): this;
}

function node() {
  if (fs === undefined)
    throw new Error('node:fs is unavailable.');
  return fs;
}

export const stat = (path: string): Promise<{ size: number }> =>
  node().promises.stat(path);

export const rename = (from: string, to: string): Promise<void> =>
  node().promises.rename(from, to);

export const readdir = (path: string): Promise<string[]> =>
  node().promises.readdir(path);

export const unlink = (path: string): Promise<void> =>
  node().promises.unlink(path);

export const createWriteStream = (path: string, options: { flags: string }): LogStream =>
  node().createWriteStream(path, options);

export const unsupported = fs === undefined;
