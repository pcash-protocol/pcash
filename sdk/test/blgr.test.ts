// Ported from blgr v0.2.1 test/logger-test.js (MIT License, see
// src/blgr/LICENSE), then extended with the stream split and `raw`.

import assert from "node:assert/strict";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import Path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, it, vi } from "vitest";
import { Logger } from "../src/blgr/index.ts";

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(Path.join(tmpdir(), "blgr-test-"));
  return Path.join(dir, `${name}.log`);
}

// Prints specified number of 1000-character lines to file.
// Returns total increase to file size in bytes.
function logLines(logger: Logger, lines: number): number {
  let perLine = 0;
  perLine += "[D:2019-10-21T19:58:44Z] ".length; // timestamp
  perLine += 1;                                  // \n end of every line
  perLine += 14;                                 // Date.now() plus space
  perLine += 1000;                               // 500 byte Buffer.toString()

  for (let i = 0; i < lines; i++) {
    logger.debug(
      Date.now().toString()
      + " "
      + Buffer.alloc(500).toString("hex"),
    );
  }
  return perLine * lines;
}

describe("Logger", () => {
  describe("log", () => {
    const msg = "Test.";

    function counting(logger: Logger) {
      const counts = { writeConsole: 0, writeStream: 0 };
      logger.writeConsole = () => { counts.writeConsole += 1; };
      logger.writeStream = () => { counts.writeStream += 1; };
      return counts;
    }

    function logAll(logger: Logger, levels: number[]) {
      for (const level of levels) logger.log(level, "module", [msg]);
    }

    const { ERROR, WARNING, INFO, DEBUG, SPAM } = Logger.levels;

    it("not log (level)", async () => {
      const logger = new Logger({ level: "none" });
      await logger.open();
      const counts = counting(logger);

      logAll(logger, [ERROR, WARNING, INFO, DEBUG, SPAM]);

      assert.equal(counts.writeConsole, 0);
      assert.equal(counts.writeStream, 0);
    });

    it("not log (not open)", async () => {
      const logger = new Logger({ level: "spam" });
      const counts = counting(logger);

      logAll(logger, [ERROR, WARNING, INFO, DEBUG, SPAM]);

      assert.equal(counts.writeConsole, 0);
      assert.equal(counts.writeStream, 0);
    });

    it("log error", async () => {
      const logger = new Logger({ level: "error" });
      await logger.open();
      assert.equal(logger.level, ERROR);
      const counts = counting(logger);

      logAll(logger, [WARNING, INFO, DEBUG, SPAM]);
      assert.equal(counts.writeConsole, 0);
      assert.equal(counts.writeStream, 0);

      logAll(logger, [ERROR]);
      assert.equal(counts.writeConsole, 1);
      assert.equal(counts.writeStream, 1);
    });

    it("log error and warning", async () => {
      const logger = new Logger({ level: "warning" });
      await logger.open();
      assert.equal(logger.level, WARNING);
      const counts = counting(logger);

      logAll(logger, [INFO, DEBUG, SPAM]);
      assert.equal(counts.writeConsole, 0);
      assert.equal(counts.writeStream, 0);

      logAll(logger, [ERROR, WARNING]);
      assert.equal(counts.writeConsole, 2);
      assert.equal(counts.writeStream, 2);
    });

    it("log error, warning and info", async () => {
      const logger = new Logger({ level: "info" });
      await logger.open();
      assert.equal(logger.level, INFO);
      const counts = counting(logger);

      logAll(logger, [DEBUG, SPAM]);
      assert.equal(counts.writeConsole, 0);
      assert.equal(counts.writeStream, 0);

      logAll(logger, [INFO, ERROR, WARNING]);
      assert.equal(counts.writeConsole, 3);
      assert.equal(counts.writeStream, 3);
    });

    it("log error, warning, info, debug", async () => {
      const logger = new Logger({ level: "debug" });
      await logger.open();
      assert.equal(logger.level, DEBUG);
      const counts = counting(logger);

      logAll(logger, [SPAM]);
      assert.equal(counts.writeConsole, 0);
      assert.equal(counts.writeStream, 0);

      logAll(logger, [DEBUG, INFO, ERROR, WARNING]);
      assert.equal(counts.writeConsole, 4);
      assert.equal(counts.writeStream, 4);
    });

    it("log error, warning, info, debug, spam", async () => {
      const logger = new Logger({ level: "spam" });
      await logger.open();
      assert.equal(logger.level, SPAM);
      const counts = counting(logger);

      logAll(logger, [DEBUG, SPAM, INFO, ERROR, WARNING]);
      assert.equal(counts.writeConsole, 5);
      assert.equal(counts.writeStream, 5);
    });

    it("rejects an unknown level", () => {
      assert.throws(() => new Logger("verbose"), /Invalid log level/);
    });
  });

  describe("logError", () => {
    const logger = new Logger();
    const log = logger.log;
    const err = new Error("Test.");
    let called: { level: number; module: string | null; args: unknown[] } | null = null;

    beforeAll(async () => {
      await logger.open();
    });

    beforeEach(() => {
      called = null;
      logger.log = (level, module, args) => {
        called = { level, module, args };
      };
    });

    afterEach(() => {
      logger.log = log;
    });

    function checkMsg(msg: unknown, error: boolean, stack: boolean) {
      assert.equal(typeof msg, "string");
      const lines = (msg as string).split("\n");
      if (stack)
        assert.ok(lines.length > 1, "Should include the stack.");
      else
        assert.equal(lines.length, 1);

      const lead = /Error:/.test(lines[0]!);
      const message = /Test\./.test(lines[0]!);

      if (error)
        assert.ok(lead, "Should not strip \"Error\".");
      else
        assert.ok(!lead, "Should strip \"Error: \".");

      assert.ok(message);
    }

    function logged(level: number, error: boolean, stack: boolean) {
      logger.logError(level, "module", err);
      assert.ok(called);
      assert.equal(called.level, level);
      assert.equal(called.args.length, 1);
      checkMsg(called.args[0], error, stack);
    }

    it("should log stack with error() level", () => {
      logged(Logger.levels.ERROR, false, true);
    });

    it("should log stack with warning() level", () => {
      logged(Logger.levels.WARNING, true, true);
    });

    it("should not log stack with info() level", () => {
      logged(Logger.levels.INFO, true, false);
    });

    it("should not log stack with debug() level", () => {
      logged(Logger.levels.DEBUG, true, false);
    });

    it("should not log stack with spam() level", () => {
      logged(Logger.levels.SPAM, true, false);
    });
  });

  describe("File rotation", { timeout: 30_000 }, () => {
    let filename: string;
    let logger: Logger;

    beforeEach(async () => {
      filename = await tempFile("file-size");

      logger = new Logger({
        level: "spam",
        filename: filename,
        console: false,
      });
      await logger.open();
    });

    afterEach(async () => {
      if (!logger.closed)
        await logger.close();
    });

    it("should get current log file size", async () => {
      assert.strictEqual(logger._fileSize, 0);

      const bytes = logLines(logger, 1000);
      assert.strictEqual(logger._fileSize, bytes);

      // Reset
      await logger.close();
      assert.strictEqual(logger._fileSize, 0);

      // Get file size on reopen
      await logger.open();
      assert.strictEqual(logger._fileSize, bytes);
    });

    it("should rotate out log file", async () => {
      // Write some junk
      const bytes = logLines(logger, 100);

      // Move current log file to archive file
      const rename = await logger.rotate();
      assert.ok(rename);
      assert.ok(await stat(rename));
      assert.ok(await stat(filename));

      // Archive file should have the junk
      const stat1 = await stat(rename);
      assert.strictEqual(stat1.size, bytes);

      // Internal file size property should be reset
      assert.strictEqual(logger._fileSize, 0);

      // New log file should be empty
      const stat2 = await stat(filename);
      assert.strictEqual(stat2.size, 0);
    });

    it("should rotate out log files when limit is reached", async () => {
      logger.maxFileSize = 1 << 18; // ~260kB
      logger.maxFiles = 100; // effectively disable pruning

      let bytes = 0;
      for (let i = 0; i < 1000; i++) {
        bytes += logLines(logger, 1);
        // In practice, we wouldn't be logging thousands of lines in a
        // single operation. Slow down the test loop so that writeStream()
        // has a chance to flush to disk and rotate the file out.
        await new Promise(r => setTimeout(r, 0));
      }

      await logger.close();

      // Should be 4 files about 260kB each
      const dir = Path.dirname(filename);
      const files = await readdir(dir);
      assert.strictEqual(files.length, 4);

      // With the write loop slowed down, every single byte should be written.
      let actual = 0;
      for (const file of files) {
        const path = Path.join(dir, file);
        actual += (await stat(path)).size;
      }
      assert.strictEqual(bytes, actual);
    });

    it("should prune old log files", async () => {
      logger.maxFileSize = 1 << 18; // ~260kB
      logger.maxFiles = 4;

      for (let i = 0; i < 2000; i++) {
        logLines(logger, 1);
        await new Promise(r => setTimeout(r, 0));
      }

      await logger.close();

      // 2000 lines of 1000 bytes = 2,000,000 bytes.
      // With a max file size of ~260k, that should produce 8 files.
      // After pruning, only 4 archival + 1 current file should remain.
      const dir = Path.dirname(filename);
      const files = await readdir(dir);
      assert.strictEqual(files.length, 5);
    });
  });

  describe("console streams", () => {
    function capture() {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      return {
        stdout: () => stdout.mock.calls.map(([chunk]) => String(chunk)),
        stderr: () => stderr.mock.calls.map(([chunk]) => String(chunk)),
      };
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("writes error to stderr and every other level to stdout", async () => {
      const logger = new Logger({ level: "spam", colors: false });
      await logger.open();
      const out = capture();

      logger.context("svc").error("boom");
      logger.warning("careful");
      logger.info("hello %s", "world");
      logger.debug("detail");
      logger.spam("noise");

      assert.deepEqual(out.stderr(), ["[error] (svc) boom\n"]);
      assert.deepEqual(out.stdout(), [
        "[warning] careful\n",
        "[info] hello world\n",
        "[debug] detail\n",
        "[spam] noise\n",
      ]);
    });

    it("raw writes unprefixed stdout regardless of level or open state", () => {
      const logger = new Logger({ level: "none" });
      const out = capture();

      logger.raw("{\"ok\":true}");
      logger.context("cli").raw("100%% done %s", "now");

      assert.deepEqual(out.stdout(), ["{\"ok\":true}\n", "100% done now\n"]);
      assert.deepEqual(out.stderr(), []);
    });
  });
});
