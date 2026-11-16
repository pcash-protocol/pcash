/*!
 * inspect.ts - value inspection for blgr
 * Adapted from blgr v0.2.1 lib/inspect.js and lib/inspect-browser.js; see PROVENANCE.md.
 */

// Upstream swapped in inspect-browser.js through the package.json `browser`
// field. Resolving node:util at runtime selects the same implementation without
// a static node: import.
const util = globalThis.process?.getBuiltinModule?.('node:util');

export interface InspectOptions {
  showHidden: boolean;
  depth: number;
  colors: boolean;
  customInspect: boolean;
  showProxy: boolean;
  maxArrayLength: number;
  breakLength: number;
  compact: boolean;
}

function browserInspect(obj: unknown): string {
  if (obj === undefined)
    return 'undefined';

  if (obj !== obj)
    return 'NaN';

  try {
    return JSON.stringify(obj, null, 2);
  } catch (e) {
    return '{}';
  }
}

export const inspect: (obj: unknown, options: InspectOptions) => string =
  util === undefined ? browserInspect : util.inspect;
