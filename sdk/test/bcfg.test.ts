// Ported from bcfg v0.2.2 test/bcfg-test.js (MIT License, see
// src/bcfg/LICENSE), then extended with the behaviour the repository's
// configuration relies on.

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { Config } from "../src/bcfg/index.ts";
import type { LoadOptions } from "../src/bcfg/index.ts";

describe("bcfg", () => {
  it("should filter options", () => {
    const options = {
      testString: "hello",
      childTestString: "goodbye",
    };

    const parent = new Config("bcfg");
    parent.inject(options);
    parent.load(options as LoadOptions);

    assert.strictEqual(parent.str("test-string"), "hello");

    const child = parent.filter("child");
    assert.strictEqual(child.str("test-string"), "goodbye");

    const child2 = parent.filter("child", {
      options: false,
    });

    assert.strictEqual(child2.str("test-string"), null);
  });

  it("should filter argv", () => {
    const parent = new Config("bcfg");

    // process.argv
    parent.parseArg([
      "node",
      "bcfg",
      "--test-string=hello",
      "--child-test-string=goodbye",
    ]);

    assert.strictEqual(parent.str("test-string"), "hello");

    const child = parent.filter("child", {
      // must not have any effect.
      options: false,
    });
    assert.strictEqual(child.str("test-string"), "goodbye");

    const child2 = parent.filter("child", {
      args: false,
    });
    assert.strictEqual(child2.str("test-string"), null);
  });

  it("reads only the environment prefixed by its module name", () => {
    const env = { PCASH_L1_RPC: "http://shared", PCASH_RELAYER_L1_RPC: "http://relayer" };

    const relayer = new Config("pcash-relayer");
    relayer.load({ env });
    assert.strictEqual(relayer.str("l1-rpc"), "http://relayer");

    const shared = new Config("pcash");
    shared.load({ env: { PCASH_L1_RPC: "http://shared" } });
    assert.strictEqual(shared.str("l1-rpc"), "http://shared");

    const isolated = new Config("pcash-relayer");
    isolated.load({ env: { PCASH_L1_RPC: "http://shared" } });
    assert.strictEqual(isolated.str("l1-rpc"), null);
  });

  it("prefers arguments over environment over injected options", () => {
    const config = new Config("pcash");
    config.inject({ rpcUrl: "http://injected" });
    assert.strictEqual(config.str("rpc-url"), "http://injected");

    config.load({ env: { PCASH_RPC_URL: "http://env" } });
    assert.strictEqual(config.str("rpc-url"), "http://env");

    config.load({ argv: ["node", "pcash", "--rpc-url=http://arg"] });
    assert.strictEqual(config.str("rpc-url"), "http://arg");
  });

  it("treats an empty environment value as unset", () => {
    const config = new Config("pcash");
    config.load({ env: { PCASH_DATA_DIR: "" } });
    assert.strictEqual(config.str("data-dir"), null);
    assert.strictEqual(config.has("data-dir"), false);
  });

  it("returns the fallback when a value is missing", () => {
    const config = new Config("pcash");
    config.load({ env: {} });
    const port: number = config.uint("port", 7);
    assert.strictEqual(port, 7);
    const name: string = config.str("name", "default");
    assert.strictEqual(name, "default");
  });

  it("passes a later -- through with the arguments after the first", () => {
    const config = new Config("pcash");
    config.load({ argv: ["node", "bundle", "exec", "--", "npm", "run", "dev", "--", "--host", "127.0.0.1"] });
    assert.deepStrictEqual(config.pass, ["npm", "run", "dev", "--", "--host", "127.0.0.1"]);
  });

  it("consumes a positional after a bare boolean flag as its value", () => {
    const config = new Config("pcash");
    config.load({ argv: ["node", "pcash", "--dev", "serve", "--", "passed"] });
    assert.strictEqual(config.args.dev, "serve");
    assert.deepStrictEqual(config.argv, []);
    assert.deepStrictEqual(config.pass, ["passed"]);
    assert.throws(() => config.bool("dev"), /dev must be a boolean/);
  });
});
