/*!
 * format.ts - message formatting for blgr
 * Adapted from blgr v0.2.1 lib/format.js; see PROVENANCE.md.
 */

import { inspect, type InspectOptions } from './inspect.ts';

/*
 * Constants
 */

const options: InspectOptions = {
  showHidden: false,
  depth: 20,
  colors: false,
  customInspect: true,
  showProxy: false,
  maxArrayLength: 10000,
  breakLength: 60,
  compact: true
};

/*
 * Helpers
 */

export function format(args: unknown[], colors: boolean): string {
  if (args.length === 0)
    return '';

  const fmt = args[0];

  options.colors = colors;

  if (typeof fmt !== 'string')
    return inspect(fmt, options);

  if (args.length === 1)
    return fmt;

  let str = '';
  let j = 1;
  let pos = 0;
  let tmp: string;

  for (let i = 0; i < fmt.length - 1; i++) {
    if (fmt.charCodeAt(i) !== 37) // '%'
      continue;

    const next = fmt.charCodeAt(++i);

    if (j !== args.length) {
      switch (next) {
        case 115: // 's'
          tmp = String(args[j++]);
          break;
        case 106: // 'j'
          tmp = tryStringify(args[j++]);
          break;
        case 100: // 'd'
          tmp = toNumber(args[j++]);
          break;
        case 79: // 'O'
        case 111: // 'o'
          tmp = inspect(args[j++], options);
          break;
        case 105: // 'i'
          tmp = toInteger(args[j++]);
          break;
        case 102: // 'f'
          tmp = `${parseFloat(String(args[j++]))}`;
          break;
        case 120: // 'x'
          tmp = toHex(args[j++], false);
          break;
        case 104: // 'h'
          tmp = toHex(args[j++], true);
          break;
        case 37: // '%'
          str += fmt.slice(pos, i);
          pos = i + 1;
          continue;
        default:
          continue;
      }

      if (pos !== i - 1)
        str += fmt.slice(pos, i - 1);

      str += tmp;
      pos = i + 1;
    } else if (next === 37) {
      str += fmt.slice(pos, i);
      pos = i + 1;
    }
  }

  if (pos === 0)
    str = fmt;
  else if (pos < fmt.length)
    str += fmt.slice(pos);

  while (j < args.length) {
    const x = args[j++];

    if ((typeof x !== 'object' && typeof x !== 'symbol') || x === null)
      str += ` ${x}`;
    else
      str += ` ${inspect(x, options)}`;
  }

  return str;
}

function tryStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return '[error]';
  }
}

function toHex(buf: unknown, reverse: boolean): string {
  if (buf == null)
    return 'null';

  // Upstream tested Buffer.isBuffer. A Buffer is a Uint8Array, so this prints
  // the same in Node and also accepts plain byte arrays in a browser.
  if (!(buf instanceof Uint8Array)) {
    let str = ((buf as number) >>> 0).toString(16);

    while (str.length < 8)
      str = '0' + str;

    if (reverse)
      str = revHex(str);

    return `0x${str}`;
  }

  const str = Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');

  if (reverse)
    return revHex(str);

  return str;
}

function revHex(str: string): string {
  let out = '';

  for (let i = str.length - 2; i >= 0; i -= 2)
    out += str[i]! + str[i + 1]!;

  return out;
}

function toNumber(num: unknown): string {
  if (typeof num === 'bigint')
    return `${num}n`;
  return `${Number(num)}`;
}

function toInteger(num: unknown): string {
  if (typeof num === 'bigint')
    return `${num}n`;
  return `${parseInt(String(num))}`;
}
