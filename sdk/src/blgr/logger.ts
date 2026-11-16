/*!
 * logger.js - basic logger for bcoin
 * Copyright (c) 2014-2017, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 *
 * Adapted from blgr v0.2.1 lib/logger.js; see PROVENANCE.md.
 */

import { format } from './format.ts';
import * as fs from './fs.ts';
import type { LogStream } from './fs.ts';

// Upstream required node's path module at load. Resolving it at runtime keeps
// this module importable in a browser, where fs.unsupported stops rotation
// before it is used.
const Path = globalThis.process?.getBuiltinModule?.('node:path');

function assert(value: unknown, message?: string): asserts value {
  if (!value)
    throw new Error(message ?? 'Assertion failed.');
}

/**
 * @typedef {Object} LoggerOptions
 * @property {String} [level=none]
 * @property {Boolean} [colors]
 * @property {Boolean} [console]
 * @property {String} [filename]
 * @property {Number} [maxFileSize]
 * @property {Number} [maxFiles]
 */

export interface LoggerOptions {
  level?: string | undefined;
  colors?: boolean | undefined;
  console?: boolean | undefined;
  filename?: string | undefined;
  maxFileSize?: number | undefined;
  maxFiles?: number | undefined;
}

/**
 * Logger
 */

export class Logger {
  /**
   * Whether stdout is a tty FD.
   * @const {Boolean}
   */

  static HAS_TTY = Boolean(globalThis.process?.stdout?.isTTY);

  /**
   * Maximum file size.
   * @const {Number}
   * @default
   */

  static MAX_FILE_SIZE = 20 << 20;

  /**
   * Maximum number of archival log files to keep on disk.
   * @const {Number}
   * @default
   */

  static MAX_ARCHIVAL_FILES = 10;

  /**
   * Available log levels.
   * @enum {Number}
   */

  static levels = {
    NONE: 0,
    ERROR: 1,
    WARNING: 2,
    INFO: 3,
    DEBUG: 4,
    SPAM: 5
  };

  /**
   * Available log levels.
   * @const {String[]}
   * @default
   */

  static levelsByVal = [
    'none',
    'error',
    'warning',
    'info',
    'debug',
    'spam'
  ];

  /**
   * Available log levels.
   * @const {String[]}
   * @default
   */

  static prefixByVal = [
    'N',
    'E',
    'W',
    'I',
    'D',
    'S'
  ];

  /**
   * Default CSI colors.
   * @const {String[]}
   * @default
   */

  static styles = [
    '0',
    '1;31',
    '1;33',
    '94',
    '90',
    '90'
  ];

  level: number;
  colors: boolean;
  maxFileSize: number;
  maxFiles: number;
  console: boolean;
  closed: boolean;
  closing: boolean;
  filename: string | null;
  stream: LogStream | null;
  contexts: Record<string, LoggerContext>;
  fmt: typeof format;
  rotating: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  _fileSize: number;
  _buffer: string[];

  /**
   * Create a logger.
   * @constructor
   * @param {(String|LoggerOptions)} [options]
   */

  constructor(options?: string | LoggerOptions) {
    this.level = Logger.levels.NONE;
    this.colors = Logger.HAS_TTY;
    this.maxFileSize = Logger.MAX_FILE_SIZE;
    this.maxFiles = Logger.MAX_ARCHIVAL_FILES;
    this.console = true;
    this.closed = true;
    this.closing = false;
    this.filename = null;
    this.stream = null;
    this.contexts = Object.create(null);
    this.fmt = format;
    this.rotating = false;
    this.timer = null;

    this._fileSize = 0;
    this._buffer = [];

    if (options)
      this.set(options);
  }

  /**
   * Set logger options.
   * @param {Object} options
   */

  set(options: string | LoggerOptions): void {
    assert(options);
    assert(this.closed);

    if (typeof options === 'string') {
      this.setLevel(options);
      return;
    }

    if (options.level != null) {
      assert(typeof options.level === 'string');
      this.setLevel(options.level);
    }

    if (options.colors != null && Logger.HAS_TTY) {
      assert(typeof options.colors === 'boolean');
      this.colors = options.colors;
    }

    if (options.console != null) {
      assert(typeof options.console === 'boolean');
      this.console = options.console;
    }

    if (options.filename != null) {
      assert(typeof options.filename === 'string', 'Bad file.');
      this.filename = options.filename;
    }

    if (options.maxFileSize != null) {
      assert((options.maxFileSize >>> 0) === options.maxFileSize);
      this.maxFileSize = options.maxFileSize;
    }

    if (options.maxFiles != null) {
      assert((options.maxFiles >>> 0) === options.maxFiles);
      this.maxFiles = options.maxFiles;
    }
  }

  /**
   * Open the logger.
   * @method
   * @returns {Promise}
   */

  async open(): Promise<void> {
    if (!this.filename) {
      this.closed = false;
      return;
    }

    if (this.stream) {
      this.closed = false;
      return;
    }

    if (fs.unsupported) {
      this.closed = false;
      return;
    }

    this._fileSize = await this.getSize();

    this.stream = await openStream(this.filename);
    this.stream.once('error', this.handleError.bind(this));
    this.closed = false;
  }

  /**
   * Destroy the write stream.
   * @method
   * @returns {Promise}
   */

  async close(): Promise<void> {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (fs.unsupported) {
      this.closed = true;
      this.stream = null;
      return;
    }

    if (this.stream) {
      try {
        this.closing = true;
        await closeStream(this.stream);
      } finally {
        this.closing = false;
      }
      this.stream = null;
    }

    this._fileSize = 0;

    this.closed = true;
  }

  /**
   * Rotate out the current log file.
   * @method
   * @private
   * @returns {Promise} - Returns String
   */

  async rotate(): Promise<string | null> {
    if (this.rotating)
      return null;

    if (!this.filename)
      return null;

    if (fs.unsupported)
      return null;

    this.rotating = true;

    await this.close();

    // Current log file is closed. Rename it.
    const ext = Path!.extname(this.filename);
    const base = Path!.basename(this.filename, ext);
    const dir = Path!.dirname(this.filename);

    const rename = Path!.join(dir, base + '_' + dateString() + ext);

    await fs.rename(this.filename, rename);

    await this.open();

    while (this._buffer.length > 0) {
      const msg = this._buffer.shift()!;
      this.stream!.write(msg);
      this._fileSize += msg.length;
    }

    this.rotating = false;
    this.prune(dir, base, ext);

    return rename;
  }

  /**
   * Remove old log files
   * @method
   * @private
   * @param {String} dir
   * @param {String} base
   * @param {String} ext
   * @returns {Promise} - Returns Number
   */

  async prune(dir: string, base: string, ext: string): Promise<void> {
    // Find all the archival files in the target directory
    const files = await fs.readdir(dir);
    const re = new RegExp(`${base}_.*${ext}`);
    const oldFiles = files.filter(filename => re.test(filename));

    if (oldFiles.length <= this.maxFiles)
      return;

    // Archival files are named with year-month-day-hour-min-sec
    // so they should already be in order from oldest to newest.
    // But just in case readdir() isn't reliable for this...
    oldFiles.sort();

    const prune = oldFiles.slice(0, -1 * this.maxFiles);

    for (const file of prune)
      await fs.unlink(Path!.join(dir, file));
  }

  /**
   * Get the size of the current log file in bytes.
   * @method
   * @private
   * @returns {Promise} - Returns Number
   */

  async getSize(): Promise<number> {
    try {
      const stat = await fs.stat(this.filename!);
      return stat.size;
    } catch (e) {
      if ((e as { code?: unknown }).code === 'ENOENT')
        return 0;
      throw e;
    }
  }

  /**
   * Handle write stream error.
   * @param {Error} err
   */

  handleError(_err: Error): void {
    try {
      this.stream?.close();
    } catch (e) {
      ;
    }

    this.stream = null;
    this.retry();
  }

  /**
   * Try to reopen the logger.
   * @method
   * @private
   * @returns {Promise}
   */

  async reopen(): Promise<void> {
    if (this.stream)
      return;

    if (this.closed)
      return;

    if (fs.unsupported)
      return;

    try {
      this.stream = await openStream(this.filename!);
    } catch (e) {
      this.retry();
      return;
    }

    this.stream.once('error', e => this.handleError(e));
  }

  /**
   * Try to reopen the logger after a timeout.
   * @method
   * @private
   * @returns {Promise}
   */

  retry(): void {
    if (this.timer != null)
      return;

    this.timer = setTimeout(() => {
      this.timer = null;
      this.reopen();
    }, 10000);
  }

  /**
   * Set the log file location.
   * @param {String} filename
   */

  setFile(filename: string): void {
    assert(typeof filename === 'string');
    assert(!this.stream, 'Log stream has already been created.');
    this.filename = filename;
  }

  /**
   * Set or reset the log level.
   * @param {String} levelName
   */

  setLevel(levelName: string): void {
    const levels: Record<string, number | undefined> = Logger.levels;
    const level = levels[levelName.toUpperCase()];
    assert(level != null, 'Invalid log level.');
    this.level = level;
  }

  /**
   * Output a log to the `error` log level.
   * @param {...Object} args
   */

  error(...args: unknown[]): void {
    if (this.level < Logger.levels.ERROR)
      return;

    const err = args[0];

    if (err instanceof Error) {
      this.logError(Logger.levels.ERROR, null, err);
      return;
    }

    this.log(Logger.levels.ERROR, null, args);
  }

  /**
   * Output a log to the `warning` log level.
   * @param {...Object} args
   */

  warning(...args: unknown[]): void {
    if (this.level < Logger.levels.WARNING)
      return;

    const err = args[0];

    if (err instanceof Error) {
      this.logError(Logger.levels.WARNING, null, err);
      return;
    }

    this.log(Logger.levels.WARNING, null, args);
  }

  /**
   * Output a log to the `info` log level.
   * @param {...Object} args
   */

  info(...args: unknown[]): void {
    if (this.level < Logger.levels.INFO)
      return;

    const err = args[0];

    if (err instanceof Error) {
      this.logError(Logger.levels.INFO, null, err);
      return;
    }

    this.log(Logger.levels.INFO, null, args);
  }

  /**
   * Output a log to the `debug` log level.
   * @param {...Object} args
   */

  debug(...args: unknown[]): void {
    if (this.level < Logger.levels.DEBUG)
      return;

    const err = args[0];

    if (err instanceof Error) {
      this.logError(Logger.levels.DEBUG, null, err);
      return;
    }

    this.log(Logger.levels.DEBUG, null, args);
  }

  /**
   * Output a log to the `spam` log level.
   * @param {...Object} args
   */

  spam(...args: unknown[]): void {
    if (this.level < Logger.levels.SPAM)
      return;

    const err = args[0];

    if (err instanceof Error) {
      this.logError(Logger.levels.SPAM, null, err);
      return;
    }

    this.log(Logger.levels.SPAM, null, args);
  }

  /**
   * Write program output to stdout. This is not a log line: it has no
   * prefix, and it ignores the level, the open state, the console option,
   * and the log file, so a CLI's result reaches its reader unchanged.
   * @param {...Object} args
   */

  raw(...args: unknown[]): void {
    const msg = format(args, false);

    if (!globalThis.process?.stdout) {
      console.log(msg);
      return;
    }

    process.stdout.write(msg + '\n');
  }

  /**
   * Output a log to the desired log level.
   * Note that this bypasses the level check.
   * @param {Number} level
   * @param {String|null} module
   * @param {Object[]} args
   */

  log(level: number, module: string | null, args: unknown[]): void {
    if (this.closed && !this.rotating)
      return;

    if (this.level < level)
      return;

    this.writeConsole(level, module, args);
    this.writeStream(level, module, args);
  }

  /**
   * Create logger context.
   * @param {String} module
   * @returns {LoggerContext}
   */

  context(module: string): LoggerContext {
    let ctx = this.contexts[module];

    if (!ctx) {
      ctx = new LoggerContext(this, module);
      this.contexts[module] = ctx;
    }

    return ctx;
  }

  /**
   * Write log to the console.
   * @param {Number} level
   * @param {String|null} module
   * @param {Object[]} args
   */

  writeConsole(level: number, module: string | null, args: unknown[]): boolean | void {
    const name = Logger.levelsByVal[level];

    assert(name, 'Invalid log level.');

    if (!this.console)
      return false;

    if (!globalThis.process?.stdout) {
      let msg = `[${name}] `;

      if (module)
        msg += `(${module}) `;

      if (args.length > 0) {
        const [obj] = args;
        if (obj && typeof obj === 'object') {
          return level === Logger.levels.ERROR
            ? console.error(msg, obj)
            : console.log(msg, obj);
        }
      }

      msg += format(args, false);

      if (level === Logger.levels.ERROR)
        console.error(msg);
      else
        console.log(msg);

      return true;
    }

    let msg;
    if (this.colors) {
      const color = Logger.styles[level];
      assert(color);

      msg = `\x1b[${color}m[${name}]\x1b[m `;
    } else {
      msg = `[${name}] `;
    }

    if (module)
      msg += `(${module}) `;

    msg += format(args, this.colors);
    msg += '\n';

    return level === Logger.levels.ERROR
      ? process.stderr.write(msg)
      : process.stdout.write(msg);
  }

  /**
   * Write a string to the output stream (usually a file).
   * @param {Number} level
   * @param {String|null} module
   * @param {Object[]} args
   */

  writeStream(level: number, module: string | null, args: unknown[]): void {
    const name = Logger.prefixByVal[level];

    assert(name, 'Invalid log level.');

    if (!this.stream && !this.rotating)
      return;

    if (this.closing && !this.rotating)
      return;

    const date = new Date().toISOString().slice(0, -5) + 'Z';

    let msg = `[${name}:${date}] `;

    if (module)
      msg += `(${module}) `;

    msg += format(args, false);
    msg += '\n';

    if (this.rotating) {
      this._buffer.push(msg);
    } else {
      this.stream!.write(msg);
      this._fileSize += msg.length;
      if (this._fileSize >= this.maxFileSize)
        this.rotate();
    }
  }

  /**
   * Helper to parse an error into a nicer
   * format. Call's `log` internally.
   * @param {Number} level
   * @param {String|null} module
   * @param {Error} err
   */

  logError(level: number, module: string | null, err: Error): void {
    if (this.closed && !this.rotating)
      return;

    if (fs.unsupported && this.console) {
      if (level <= Logger.levels.WARNING)
        console.error(err);
    }

    let msg = String(err.message).replace(/^ *Error: */, '');

    // Do not prepend "Error" for error logs.
    if (level !== Logger.levels.ERROR)
      msg = `Error: ${msg}`;

    if (level <= Logger.levels.WARNING) {
      if (err.stack) {
        // Strip first line of stack (same as err.message)
        msg += '\n' + String(err.stack).split('\n').slice(1).join('\n');
      }
    }

    this.log(level, module, [msg]);
  }

  /**
   * Get the current memory usage.
   * @returns {Object}
   */

  memoryUsage() {
    if (!globalThis.process?.memoryUsage) {
      return {
        total: 0,
        jsHeap: 0,
        jsHeapTotal: 0,
        nativeHeap: 0,
        external: 0
      };
    }

    const mem = process.memoryUsage();

    return {
      total: mb(mem.rss),
      jsHeap: mb(mem.heapUsed),
      jsHeapTotal: mb(mem.heapTotal),
      nativeHeap: mb(mem.rss - mem.heapTotal),
      external: mb(mem.external)
    };
  }

  /**
   * Log the current memory usage.
   * @param {String|null} module
   */

  memory(module: string | null): void {
    const mem = this.memoryUsage();

    this.log(Logger.levels.DEBUG, module, [
      'Memory: rss=%dmb, js-heap=%d/%dmb native-heap=%dmb',
      mem.total,
      mem.jsHeap,
      mem.jsHeapTotal,
      mem.nativeHeap
    ]);
  }
}

/**
 * Logger Context
 */

export class LoggerContext {
  logger: Logger;
  module: string;

  /**
   * Create a logger context.
   * @constructor
   * @ignore
   * @param {Logger} logger
   * @param {String} module
   */

  constructor(logger: Logger, module: string) {
    assert(typeof module === 'string');

    this.logger = logger;
    this.module = module;
  }

  /**
   * Open the logger.
   * @returns {Promise}
   */

  open(): Promise<void> {
    return this.logger.open();
  }

  /**
   * Destroy the write stream.
   * @returns {Promise}
   */

  close(): Promise<void> {
    return this.logger.close();
  }

  /**
   * Set the log file location.
   * @param {String} filename
   */

  setFile(filename: string): void {
    this.logger.setFile(filename);
  }

  /**
   * Set or reset the log level.
   * @param {String} name
   */

  setLevel(name: string): void {
    this.logger.setLevel(name);
  }

  /**
   * Output a log to the `error` log level.
   * @param {...Object} args
   */

  error(...args: unknown[]): void {
    if (this.logger.level < Logger.levels.ERROR)
      return;

    const err = args[0];

    if (err instanceof Error) {
      this.logError(Logger.levels.ERROR, err);
      return;
    }

    this.log(Logger.levels.ERROR, args);
  }

  /**
   * Output a log to the `warning` log level.
   * @param {...Object} args
   */

  warning(...args: unknown[]): void {
    if (this.logger.level < Logger.levels.WARNING)
      return;

    const err = args[0];

    if (err instanceof Error) {
      this.logError(Logger.levels.WARNING, err);
      return;
    }

    this.log(Logger.levels.WARNING, args);
  }

  /**
   * Output a log to the `info` log level.
   * @param {...Object} args
   */

  info(...args: unknown[]): void {
    if (this.logger.level < Logger.levels.INFO)
      return;

    const err = args[0];

    if (err instanceof Error) {
      this.logError(Logger.levels.INFO, err);
      return;
    }

    this.log(Logger.levels.INFO, args);
  }

  /**
   * Output a log to the `debug` log level.
   * @param {...Object} args
   */

  debug(...args: unknown[]): void {
    if (this.logger.level < Logger.levels.DEBUG)
      return;

    const err = args[0];

    if (err instanceof Error) {
      this.logError(Logger.levels.DEBUG, err);
      return;
    }

    this.log(Logger.levels.DEBUG, args);
  }

  /**
   * Output a log to the `spam` log level.
   * @param {...Object} args
   */

  spam(...args: unknown[]): void {
    if (this.logger.level < Logger.levels.SPAM)
      return;

    const err = args[0];

    if (err instanceof Error) {
      this.logError(Logger.levels.SPAM, err);
      return;
    }

    this.log(Logger.levels.SPAM, args);
  }

  /**
   * Write program output to stdout. See Logger#raw.
   * @param {...Object} args
   */

  raw(...args: unknown[]): void {
    this.logger.raw(...args);
  }

  /**
   * Output a log to the desired log level.
   * Note that this bypasses the level check.
   * @param {Number} level
   * @param {Object[]} args
   */

  log(level: number, args: unknown[]): void {
    this.logger.log(level, this.module, args);
  }

  /**
   * Create logger context.
   * @param {String} module
   * @returns {LoggerContext}
   */

  context(module: string): LoggerContext {
    return new LoggerContext(this.logger, module);
  }

  /**
   * Helper to parse an error into a nicer
   * format. Call's `log` internally.
   * @private
   * @param {Number} level
   * @param {Error} err
   */

  logError(level: number, err: Error): void {
    this.logger.logError(level, this.module, err);
  }

  /**
   * Get the current memory usage.
   * @returns {Object}
   */

  memoryUsage() {
    return this.logger.memoryUsage();
  }

  /**
   * Log the current memory usage.
   */

  memory(): void {
    this.logger.memory(this.module);
  }
}

/*
 * Helpers
 */

function mb(num: number): number {
  return Math.floor(num / (1 << 20));
}

function openStream(filename: string): Promise<LogStream> {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filename, { flags: 'a' });

    const cleanup = () => {
      stream.removeListener('error', onError);
      stream.removeListener('open', onOpen);
    };

    const onError = (err: Error) => {
      try {
        stream.close();
      } catch (e) {
        ;
      }
      cleanup();
      reject(err);
    };

    const onOpen = () => {
      cleanup();
      resolve(stream);
    };

    stream.once('error', onError);
    stream.once('open', onOpen);
  });
}

function closeStream(stream: LogStream): Promise<LogStream> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onClose = () => {
      cleanup();
      resolve(stream);
    };

    stream.removeAllListeners('error');
    stream.removeAllListeners('close');
    stream.once('error', onError);
    stream.once('close', onClose);

    stream.close();
  });
}

function dateString(): string {
  // '2019-10-28T19:02:45.122Z'
  let now = new Date().toJSON();

  // '2019-10-28_19-01-15-122'
  now = now.replace(/:/g,'-').replace('T','_').replace('.','-').slice(0,-1);

  return now;
}
