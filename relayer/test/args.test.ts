import { describe, expect, it } from "vitest";
import { relayBatchCapacity } from "@pcash/sdk/relay";
import { parseRelayerArgs } from "../src/args.ts";

describe("relayer arguments", () => {
  it("parses the operational serve policy", () => {
    const options = parseRelayerArgs([
      "--rpc-url", "http://node.test",
      "--l1-rpc", "http://l1.test",
      "--da-mode", "blob",
      "--max-batch-bytes", "500",
      "--max-transactions", "12",
      "--max-wait-ms", "1000",
      "--sponsor-unpaid",
      "--min-value-per-byte", "3",
      "--issuance-haircut-bps", "2500",
      "--max-fee-per-gas", "0x2a",
      "serve",
      "--poll-interval-ms", "0",
      "--http-addr", "127.0.0.1:9999",
    ], {});

    expect(options).toMatchObject({
      rpcUrl: "http://node.test",
      l1Rpc: "http://l1.test",
      daMode: "blobs",
      maxBatchBytes: 500n,
      maxTransactions: 12,
      maxWaitMs: 1000n,
      sponsorUnpaid: true,
      minValuePerByte: 3n,
      issuanceHaircutBps: 2500,
      maxFeePerGas: 42n,
      command: { kind: "serve", pollIntervalMs: 0, httpAddr: "127.0.0.1:9999" },
    });
  });

  it("defaults valuation to no byte floor, no sponsorship, and a half issuance haircut", () => {
    expect(parseRelayerArgs(["relay"], {})).toMatchObject({ minValuePerByte: 0n, sponsorUnpaid: false, issuanceHaircutBps: 5000 });
    expect(parseRelayerArgs(["--issuance-haircut-bps", "0", "relay"], {}).issuanceHaircutBps).toBe(0);
    expect(parseRelayerArgs(["--issuance-haircut-bps", "10000", "relay"], {}).issuanceHaircutBps).toBe(10_000);
  });

  it.each([["-1"], ["10001"], ["1.5"], ["half"]])("rejects issuance haircut %s", (value) => {
    expect(() => parseRelayerArgs([`--issuance-haircut-bps=${value}`, "relay"], {})).toThrow(/issuance-haircut-bps/);
  });

  it("uses the six-blob protocol ceiling and validates operator limits", () => {
    expect(parseRelayerArgs(["relay"], {}).maxBatchBytes).toBe(relayBatchCapacity(6));
    expect(() => parseRelayerArgs(["--max-transactions", "65", "relay"], {})).toThrow(/between 1 and 64/);
    expect(() => parseRelayerArgs([
      "--max-batch-bytes", (relayBatchCapacity(6) + 1n).toString(), "relay",
    ], {})).toThrow(/max-batch-bytes/);
    expect(() => parseRelayerArgs(["--max-fee-per-gas", "0", "relay"], {})).toThrow(/positive/);
    expect(() => parseRelayerArgs(["--env-file", "operator.env", "relay"], {})).toThrow(/unknown option --envfile/);
    expect(() => parseRelayerArgs(["relay", `--l1-key=0x${"ab".repeat(32)}`], {})).toThrow(/unknown option --l1key/);
    expect(parseRelayerArgs(["--max-fee-per-gas", "42", "relay"], {
      PCASH_RELAYER_MAX_FEE_PER_GAS: "99",
    }).maxFeePerGas).toBe(42n);
  });

  it("normalizes explicit relay ids and recognizes journal inspection", () => {
    const ids = [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`];
    expect(parseRelayerArgs(["relay", ids[0]!.slice(2), ids[1]!], {}).command)
      .toEqual({ kind: "relay", contentHashes: ids });
    expect(parseRelayerArgs(["journal", "show"], {}).command).toEqual({ kind: "journal-show" });
    expect(parseRelayerArgs(["submit-batch", "transactions.json"], {}).command)
      .toEqual({ kind: "submit-batch", inputPath: "transactions.json" });
    expect(parseRelayerArgs(["submit-batch"], {}).command)
      .toEqual({ kind: "submit-batch", inputPath: "-" });
    expect(() => parseRelayerArgs(["submit-batch", "a.json", "b.json"], {})).toThrow(/one input path/);
  });

  it("reads endpoints and the signing key only from the relayer namespace", () => {
    const shared = {
      PCASH_RPC_URL: "http://node.shared",
      PCASH_L1_RPC: "http://l1.shared",
      PCASH_L1_KEY: `0x${"cd".repeat(32)}`,
      PCASH_L1_MAX_FEE_PER_GAS: "1",
    };
    expect(parseRelayerArgs(["relay"], {
      ...shared,
      PCASH_RELAYER_RPC_URL: "http://node.canonical",
      PCASH_RELAYER_L1_RPC: "http://l1.canonical",
      PCASH_RELAYER_L1_KEY: `0x${"ab".repeat(32)}`,
      PCASH_RELAYER_JOURNAL_PATH: "/tmp/canonical-relayer-journal.json",
      PCASH_RELAYER_MAX_FEE_PER_GAS: "123456789",
      PCASH_RELAYER_RPC_TIMEOUT_SECS: "7",
    })).toMatchObject({
      rpcUrl: "http://node.canonical",
      l1Rpc: "http://l1.canonical",
      l1Key: `0x${"ab".repeat(32)}`,
      journalPath: "/tmp/canonical-relayer-journal.json",
      maxFeePerGas: 123456789n,
      nodeRpcTimeoutMs: 7_000,
    });
    const defaults = parseRelayerArgs(["relay"], shared);
    expect(defaults).toMatchObject({ rpcUrl: "http://127.0.0.1:8645", l1Rpc: "http://127.0.0.1:8545" });
    expect(defaults.l1Key).toBeUndefined();
    expect(defaults.maxFeePerGas).toBeUndefined();
  });

  it("reads operational policy from environment with CLI precedence", () => {
    const env = {
      PCASH_RELAYER_DA_MODE: "calldata",
      PCASH_RELAYER_MAX_TRANSACTIONS: "7",
      PCASH_RELAYER_JOURNAL_PATH: "/tmp/relayer-journal.json",
      PCASH_RELAYER_SPONSOR_UNPAID: "true",
      PCASH_RELAYER_MIN_VALUE_PER_BYTE: "4",
      PCASH_RELAYER_ISSUANCE_HAIRCUT_BPS: "7500",
      PCASH_RELAYER_POLL_INTERVAL_MS: "250",
    };
    expect(parseRelayerArgs(["serve"], env)).toMatchObject({
      daMode: "calldata",
      maxTransactions: 7,
      journalPath: "/tmp/relayer-journal.json",
      sponsorUnpaid: true,
      minValuePerByte: 4n,
      issuanceHaircutBps: 7500,
      command: { kind: "serve", pollIntervalMs: 250 },
    });
    expect(parseRelayerArgs(["--max-transactions", "9", "serve"], env).maxTransactions).toBe(9);
    expect(parseRelayerArgs(["--min-value-per-byte", "1", "--issuance-haircut-bps", "100", "serve"], env))
      .toMatchObject({ minValuePerByte: 1n, issuanceHaircutBps: 100 });
  });

  it("bounds selected quote lifetime", () => {
    expect(parseRelayerArgs(["serve"], {})).toMatchObject({
      selectedMaxQuoteLifetimeSeconds: 3_600n,
    });
    expect(parseRelayerArgs(["--selected-max-quote-lifetime-seconds", "7200", "serve"], {})).toMatchObject({
      selectedMaxQuoteLifetimeSeconds: 7_200n,
    });
    for (const seconds of ["0", "86401"]) {
      expect(() => parseRelayerArgs(["--selected-max-quote-lifetime-seconds", seconds, "serve"], {}))
        .toThrow(/selected-max-quote-lifetime-seconds/);
    }
  });

  it("scans the default bounded mempool while preserving an explicit page cap", () => {
    expect(parseRelayerArgs(["serve"], {}).maxPages).toBe(41);
    expect(parseRelayerArgs(["--max-pages", "32", "serve"], {}).maxPages).toBe(32);
  });

  it("enables explicit in-memory development mode", () => {
    expect(parseRelayerArgs(["serve"], { PCASH_RELAYER_DEV: "true" }).dev).toBe(true);
    expect(parseRelayerArgs(["serve"], { PCASH_RELAYER_DEV: "false" }).dev).toBe(false);
    expect(parseRelayerArgs(["serve", "--dev"], { PCASH_RELAYER_DEV: "false" }).dev).toBe(true);
    expect(() => parseRelayerArgs(["serve"], { PCASH_RELAYER_DEV: "invalid" })).toThrow(/dev must be a boolean/);
    expect(parseRelayerArgs(["--dev=true", "serve"], {})).toMatchObject({
      dev: true,
      command: { kind: "serve" },
    });
    // A bare boolean option consumes the next word, so it goes after the command.
    expect(() => parseRelayerArgs(["--dev", "serve"], {})).toThrow(/dev must be a boolean/);
    expect(parseRelayerArgs(["serve"], {}).dev).toBe(false);
  });

  it("reads the log level and file with CLI precedence", () => {
    const defaults = parseRelayerArgs(["serve"], {});
    expect(defaults.logLevel).toBe("info");
    expect(defaults.logFile).toBeUndefined();
    const env = { PCASH_RELAYER_LOG_LEVEL: "debug", PCASH_RELAYER_LOG_FILE: "/var/log/relayer.log" };
    expect(parseRelayerArgs(["serve"], env)).toMatchObject({ logLevel: "debug", logFile: "/var/log/relayer.log" });
    expect(parseRelayerArgs(["--log-level", "SPAM", "--log-file", "/tmp/r.log", "serve"], env))
      .toMatchObject({ logLevel: "spam", logFile: "/tmp/r.log" });
    expect(() => parseRelayerArgs(["--log-level", "verbose", "serve"], {})).toThrow(/--log-level expects none, error/);
  });
});

it("recognizes read-only fee-wallet status", () => {
  expect(parseRelayerArgs(["wallet-status"], {}).command).toEqual({ kind: "wallet-status" });
});

it.each(["setup-account", "consolidate"])("rejects wallet spending command %s", (command) => {
  expect(() => parseRelayerArgs([command], {})).toThrow(/expected relay/);
});

it.each(["--execute", "--consolidation-fee=7", "--max-consolidations=3"])("rejects wallet spending option %s", (flag) => {
  expect(() => parseRelayerArgs(["wallet-status", flag], {})).toThrow(/unknown option/);
});
