import { applicationSchemaId, MAX_RECORD_BYTES } from "@pcash/sdk/delivery";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLI_USAGE, cliHelp, COMMAND_DEFINITIONS, parseCli, tokenize } from "../src/cli/cli.ts";
import { WalletHttpClient, WalletHttpError } from "../src/cli/client.ts";
import {
  DEV_ANVIL_WALLET_PRIVATE_KEY,
  devAnvilWallet,
  parseListen,
  parseMetricsAddress,
  parseServeArgs,
} from "../src/service/serve.ts";

const TX_ID = `0x${"ab".repeat(32)}`;
const DIGEST = `0x${"cd".repeat(32)}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tokenize", () => {
  it("splits flags and positionals", () => {
    expect(tokenize(["status", "--json", "--wallet-url", "http://x"])).toEqual({
      positionals: ["status"],
      flags: { json: true, "wallet-url": "http://x" },
    });
  });

  it("keeps every value of a repeatable option in order", () => {
    expect(tokenize(["send", "--record", "a.b=0x01", "--public-record=a.b=0x02", "--json", "--record=c.d=@x"])).toEqual({
      positionals: ["send"],
      flags: { json: true, record: ["a.b=0x01", "c.d=@x"], "public-record": ["a.b=0x02"] },
    });
    expect(() => tokenize(["send", "--record"])).toThrow(/--record requires a value/);
  });
});

describe("parseCli", () => {
  it("reads the wallet endpoint and token from flags or the environment, never operands", () => {
    const env = { PCASH_WALLET_URL: "http://127.0.0.1:9745", PCASH_WALLET_TOKEN: "secret", PCASH_TO: "0x2", PCASH_L1_RPC: "http://l1.test" };
    expect(parseCli(["status"], env)).toMatchObject({ url: "http://127.0.0.1:9745", token: "secret" });
    expect(parseCli(["status", "--wallet-url", "http://127.0.0.1:9746", "--wallet-token", "other"], env))
      .toMatchObject({ url: "http://127.0.0.1:9746", token: "other" });
    const transfer = parseCli(["send", "--to", "0x1", "--amount", "1"], env);
    expect(transfer.to).toBe("0x1");
    expect(transfer).not.toHaveProperty("l1Rpc");
    expect(() => parseCli(["status", "--token", "secret"], {})).toThrow(/unknown option --token/);
  });

  it("requires an explicit bulk budget and a separate execution step", () => {
    expect(parseCli(["bulk", "consolidate", "--fee", "1", "--max-transactions", "12", "--shape", "L"]))
      .toMatchObject({ command: "bulk", subcommand: "consolidate", fee: 1n, maxTransactions: 12, shape: 1 });
    expect(parseCli(["bulk", "step", "--job-id", "abc", "--chunk-index", "1", "--submit", "l1"]))
      .toMatchObject({ jobId: "abc", chunkIndex: 1, submit: "l1" });
    expect(parseCli(["bulk", "start", "--file", "job.json"])).toMatchObject({ file: "job.json" });
    expect(() => parseCli(["bulk", "consolidate", "--fee", "1"])).toThrow("--max-transactions");
    expect(parseCli(["bulk", "consolidate", "--max-transactions", "2"])).not.toHaveProperty("fee");
    expect(() => parseCli(["bulk", "step"])).toThrow("--job-id");
    expect(() => parseCli(["bulk", "start"])).toThrow("--file");
    expect(() => parseCli(["bulk", "consolidate", "--fee", "1", "--max-transactions", "0"])).toThrow("integer");
    expect(() => parseCli(["send", "--to", "x", "--amount", "1", "--shape", "M"])).toThrow("--shape");
  });

  it("sends bulk approval and execution as distinct requests", async () => {
    const requests: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, body: init.body === undefined ? null : JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    });
    const client = new WalletHttpClient("http://wallet.test");
    await client.dispatch(parseCli(["bulk", "consolidate", "--fee", "1", "--max-transactions", "2"]));
    await client.dispatch(parseCli(["bulk", "step", "--job-id", "abc", "--submit", "l1"]));
    await client.dispatch(parseCli(["bulk", "consolidate", "--max-transactions", "3"]));
    expect(requests[0]).toEqual({ url: "http://wallet.test/bulk", body: {
      job: { kind: "consolidation", openFeeAmount: "1", maxTransactions: 2 },
    } });
    expect(requests[1]).toEqual({ url: "http://wallet.test/bulk/step", body: {
      jobId: "abc", submit: "l1", waitMode: "latest",
    } });
    expect(requests[2]).toEqual({ url: "http://wallet.test/bulk", body: {
      job: { kind: "consolidation", maxTransactions: 3 },
    } });
  });

  it("leaves the publication path to the service unless --submit names one", () => {
    const cli = parseCli(["status"], {});
    expect(cli).not.toHaveProperty("submit");
    expect(cli.url).toBe("http://127.0.0.1:8745");
    expect(parseCli(["account", "ensure"])).not.toHaveProperty("submit");
    expect(parseCli(["account", "ensure", "--submit", "mempool"]).submit).toBe("mempool");
  });

  it("parses a private selected relay fee and rejects mixed publication modes", () => {
    expect(parseCli(["send", "--to", "0x1", "--amount", "1", "--submit", "selected", "--private-relay-fee", "2"]))
      .toMatchObject({ submit: "selected", privateRelayFee: 2n });
    expect(parseCli(["account", "ensure", "--submit", "selected", "--private-relay-fee", "2"]))
      .toMatchObject({ submit: "selected", privateRelayFee: 2n });
    expect(parseCli(["asset", "create", "--name", "Asset", "--symbol", "AST", "--supply", "1", "--content-digest", DIGEST, "--submit", "selected", "--private-relay-fee", "2"]))
      .toMatchObject({ submit: "selected", privateRelayFee: 2n });
    expect(() => parseCli(["send", "--to", "0x1", "--amount", "1", "--submit", "selected"]))
      .toThrow(/positive --private-relay-fee/);
    expect(() => parseCli(["send", "--to", "0x1", "--amount", "1", "--submit", "selected", "--private-relay-fee", "2", "--fee", "1"]))
      .toThrow(/cannot carry a public --fee/);
    expect(() => parseCli(["send", "--to", "0x1", "--amount", "1", "--private-relay-fee", "2"]))
      .toThrow(/requires --submit selected/);
    expect(() => parseCli(["receive-key", "create", "--submit", "selected", "--private-relay-fee", "2"]))
      .toThrow(/requires --receive-key replace/);
  });

  it("accepts seed onboarding without putting recovery material on the command line", () => {
    expect(parseCli(["wallet", "create"])).toMatchObject({ command: "wallet", subcommand: "create" });
    expect(parseCli(["wallet", "import"])).toMatchObject({ command: "wallet", subcommand: "import" });
    expect(parseCli(["wallet", "import", "--seed-file", "./seed.txt"])).toMatchObject({ seedFile: "./seed.txt" });
    expect(() => parseCli(["wallet", "create", "--seed-file", "./seed.txt"])).toThrow(/not valid/);
    expect(() => parseCli(["wallet", "import", "--mnemonic", "secret"])).toThrow(/unknown option/);
    expect(() => parseCli(["wallet", "import", "--address", "0xabc"])).toThrow(/unknown option --address/);
  });

  it("uses the dedicated executable in command diagnostics", () => {
    expect(() => parseCli(["asset", "create", "extra"])).toThrow(/pcash-wallet-cli asset create/);
    expect(() => parseCli(["wallet"])).toThrow(/pcash-wallet-cli wallet/);
  });

  it("reserves raw signing-key imports for explicit development use", () => {
    expect(() => parseCli(["wallet", "import", "--key-file", "./k.json"])).toThrow(/requires --dev/);
    expect(() => parseCli(["wallet", "import", "--dev"])).toThrow(/requires --key-file/);
    expect(() => parseCli(["wallet", "import", "--dev", "--key-file", "./k.json", "--seed-file", "./seed.txt"])).toThrow(/cannot be combined/);
    const cli = parseCli(["wallet", "import", "--dev", "--key-file", "./k.json"]);
    expect(cli.subcommand).toBe("import");
    expect(cli.keyFile).toBe("./k.json");
    expect(cli.dev).toBe(true);
    expect(cli.publishReceiveKey).toBe(false);
  });

  it("accepts receive-key publication settings on the receive-key command", () => {
    const cli = parseCli(["receive-key", "create", "--receive-key", "replace", "--submit", "l1"]);
    expect(cli.publishReceiveKey).toBe(true);
    expect(cli.submit).toBe("l1");
    expect(parseCli(["receive-key", "create", "--receive-key", "replace", "--fee", "5"]).fee).toBe(5n);
    expect(() => parseCli(["receive-key", "create", "--fee", "5"])).toThrow(/require --receive-key replace/);
  });

  it("rejects unknown subcommands instead of treating them as imports", () => {
    expect(() => parseCli(["wallet", "ls"])).toThrow(/<subcommand>/);
    expect(() => parseCli(["receive-key", "rotate"])).toThrow(/<subcommand>/);
  });

  it("rejects flags that a command would ignore", () => {
    expect(() => parseCli(["account", "ensure", "--receive-key", "replace"])).toThrow(/not valid for account/);
    expect(() => parseCli(["receive-key", "create", "--submit", "l1"])).toThrow(
      /require --receive-key replace/,
    );
  });

  it("retains wallet selection for status and asset creation", () => {
    expect(parseCli(["status", "--wallet", "0xabc"]).wallet).toBe("0xabc");
    expect(parseCli(["asset", "create", "--name", "Asset", "--symbol", "AST", "--supply", "1", "--content-digest", DIGEST, "--wallet", "0xabc"]).wallet).toBe("0xabc");
  });

  it("rejects missing asset metadata", () => {
    expect(() => parseCli(["asset", "create", "--name", "Asset"])).toThrow(/requires --name, --symbol and --supply/);
  });

  it("requires an explicit content digest and one creation retry mode", () => {
    const create = ["asset", "create", "--name", "Asset", "--symbol", "AST", "--supply", "1"];
    expect(() => parseCli(create)).toThrow(/requires --content-digest/);
    expect(() => parseCli([...create, "--content-digest", "0x12"])).toThrow(/requires --content-digest/);
    expect(parseCli([...create, "--content-digest", DIGEST, "--asset-id", "0x55"]))
      .toMatchObject({ assetContentDigest: DIGEST, assetId: 0x55n });
    expect(() => parseCli([...create, "--content-digest", DIGEST, "--asset-id", "0x55", "--retry-content-hash", TX_ID]))
      .toThrow(/mutually exclusive/);
  });

  it("parses asset list, send, burn, and import", () => {
    expect(parseCli(["asset", "list", "--wallet", "0xabc"])).toMatchObject({ command: "asset", subcommand: "list", wallet: "0xabc" });
    expect(parseCli(["asset", "send", "--asset-id", "0x55", "--to", "code", "--amount", "3", "--note-secret", "0x7", "--fee", "1"]))
      .toMatchObject({ subcommand: "send", assetId: 0x55n, to: "code", amount: 3n, noteSecret: 7n, fee: 1n });
    expect(parseCli(["asset", "send", "--asset-id", "5", "--file", "outputs.json"])).toMatchObject({ assetId: 5n, file: "outputs.json" });
    expect(parseCli(["asset", "burn", "--asset-id", "5", "--amount", "2", "--submit", "l1"]))
      .toMatchObject({ subcommand: "burn", assetId: 5n, amount: 2n, submit: "l1" });
    expect(parseCli(["asset", "import", "--definition", "text"])).toMatchObject({ subcommand: "import", definition: "text" });
    expect(() => parseCli(["asset", "send", "--to", "code", "--amount", "3"])).toThrow(/requires --asset-id/);
    expect(() => parseCli(["asset", "send", "--asset-id", "5"])).toThrow(/either --to with --amount or --file/);
    expect(() => parseCli(["asset", "send", "--asset-id", "5", "--to", "code", "--amount", "3", "--file", "o.json"]))
      .toThrow(/either --to with --amount or --file/);
    expect(() => parseCli(["asset", "send", "--asset-id", "5", "--to", "code", "--amount", "0"])).toThrow(/positive --amount/);
    expect(() => parseCli(["asset", "send", "--asset-id", "5", "--file", "o.json", "--amount", "3"])).toThrow(/--file carries/);
    expect(() => parseCli(["asset", "burn", "--asset-id", "5", "--amount", "0"])).toThrow(/positive --amount/);
    expect(() => parseCli(["asset", "burn", "--asset-id", "5"])).toThrow(/positive --amount/);
    expect(() => parseCli(["asset", "import"])).toThrow(/requires --definition/);
    expect(() => parseCli(["asset", "list", "--asset-id", "5"])).toThrow(/not valid for asset list/);
    expect(() => parseCli(["asset", "mint"])).toThrow(/<subcommand>/);
  });

  it("sends asset commands to the asset routes", async () => {
    const requests: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ method: init.method!, url, body: init.body === undefined ? null : JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    });
    const client = new WalletHttpClient("http://wallet.test");
    await client.dispatch(parseCli(["asset", "list", "--wallet", "0xabc"]));
    await client.dispatch(parseCli(["asset", "send", "--asset-id", "0x55", "--to", "code", "--amount", "3", "--note-secret", "7", "--fee", "1"]));
    await client.dispatch(parseCli(["asset", "burn", "--asset-id", "0x55", "--amount", "2", "--wallet", "0xabc", "--retry-content-hash", TX_ID]));
    await client.dispatch(parseCli(["asset", "import", "--definition", "text", "--wallet", "0xabc"]));
    await client.dispatch(parseCli(["asset", "create", "--name", "Asset", "--symbol", "AST", "--supply", "1", "--content-digest", DIGEST, "--asset-id", "0x55"]));
    expect(requests).toEqual([
      { method: "GET", url: "http://wallet.test/assets?wallet=0xabc", body: null },
      { method: "POST", url: "http://wallet.test/assets/send", body: {
        waitMode: "latest", openFeeAmount: "1", assetId: "85", outputs: [{ to: "code", amount: "3", noteSecret: "7" }],
      } },
      { method: "POST", url: "http://wallet.test/assets/burn", body: {
        waitMode: "latest", wallet: "0xabc", retryContentHash: TX_ID, assetId: "85", amount: "2",
      } },
      { method: "POST", url: "http://wallet.test/assets/import", body: { definition: "text", wallet: "0xabc" } },
      { method: "POST", url: "http://wallet.test/assets", body: {
        waitMode: "latest", name: "Asset", symbol: "AST", decimals: 0, initialSupply: "1", contentDigest: DIGEST, assetId: "85",
      } },
    ]);
  });

  it("accepts a zero transfer amount and rejects a negative one", () => {
    expect(parseCli(["send", "--to", "0x1", "--amount", "0"]).amount).toBe(0n);
    expect(() => parseCli(["send", "--to", "0x1", "--amount=-1"])).toThrow(/nonnegative/);
  });

  it("takes an approved fee and has no destination-commitment flag", () => {
    const cli = parseCli(["send", "--to", "0x1", "--amount", "1", "--fee", "2"]);
    expect(cli.fee).toBe(2n);
    expect(parseCli(["send", "--to", "0x1", "--amount", "1", "--fee", "0"]).fee).toBe(0n);
    expect(parseCli(["send", "--to", "0x1", "--amount", "1"])).not.toHaveProperty("fee");
    for (const command of [["send", "--to", "0x1", "--amount", "1"], ["account", "ensure"]]) {
      expect(() => parseCli([...command, "--fee-owner-commitment", "3"])).toThrow(/unknown option --feeownercommitment/);
    }
  });

  it("takes a transfer memo and sender choice", () => {
    expect(parseCli(["send", "--to", "0x1", "--amount", "1", "--memo", "rent — March", "--include-sender"]))
      .toMatchObject({ memo: "rent — March", includeSender: true });
    const plain = parseCli(["send", "--to", "0x1", "--amount", "1"]);
    expect(plain.includeSender).toBe(false);
    expect(plain).not.toHaveProperty("memo");
    expect(() => parseCli(["account", "ensure", "--memo", "x"])).toThrow(/--memo is not valid for account/);
    expect(() => parseCli(["asset", "send", "--asset-id", "1", "--to", "0x1", "--amount", "1", "--include-sender"]))
      .toThrow(/--include-sender is not valid for asset send/);
  });

  it("parses transfer records by audience as schema IDs and hex or a local file", () => {
    const transfer = ["send", "--to", "0x1", "--amount", "0"];
    const note = applicationSchemaId("com.example.note");
    expect(parseCli([...transfer, "--record", "com.example.note=0xABCD", "--record", "0x8A1B2C3D=@note.bin",
      "--self-record", "com.example.note=0x", "--public-record", "org.example.post=@post=1.bin"]).records).toEqual({
      to: [{ schema: note, data: "0xabcd" }, { schema: "0x8a1b2c3d", file: "note.bin" }],
      self: [{ schema: note, data: "0x" }],
      public: [{ schema: applicationSchemaId("org.example.post"), file: "post=1.bin" }],
    });
    expect(parseCli(transfer).records).toEqual({ to: [], self: [], public: [] });
    expect(() => parseCli([...transfer, "--record", "com.example.note"])).toThrow(/--record expects <schema>=<value>/);
    expect(() => parseCli([...transfer, "--public-record", "com.example.note=0x123"])).toThrow(/--public-record com.example.note hex string has odd length/);
    expect(() => parseCli([...transfer, "--self-record", "note=0x00"])).toThrow(/namespaced/);
    expect(() => parseCli(["account", "ensure", "--public-record", "com.example.note=0x00"])).toThrow(/--public-record is not valid for account/);
    expect(() => parseCli(["asset", "send", "--asset-id", "1", "--to", "0x1", "--amount", "1", "--record", "com.example.note=0x00"]))
      .toThrow(/--record is not valid for asset send/);
  });

  it("reads record files locally, bounded by the record limit, and sends one data request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pcash-wallet-cli-"));
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    });
    try {
      writeFileSync(join(dir, "note.bin"), Uint8Array.of(1, 2, 3));
      writeFileSync(join(dir, "full.bin"), new Uint8Array(MAX_RECORD_BYTES));
      writeFileSync(join(dir, "large.bin"), new Uint8Array(MAX_RECORD_BYTES + 1));
      const client = new WalletHttpClient("http://wallet.test");
      const note = applicationSchemaId("com.example.note");
      const transfer = ["send", "--to", "code", "--amount", "0"];
      await client.dispatch(parseCli([...transfer, "--memo", "hi", "--record", `com.example.note=@${join(dir, "note.bin")}`,
        "--self-record", "com.example.note=0x01", "--public-record", `com.example.note=@${join(dir, "full.bin")}`]));
      await client.dispatch(parseCli([...transfer, "--public-record", "com.example.note=0x02"]));
      expect(bodies).toEqual([
        { waitMode: "latest", to: "code", amount: "0", data: {
          recipients: [{ to: "code", records: [{ schema: "0x01", data: "0x6869" }, { schema: note, data: "0x010203" }] }],
          self: [{ schema: note, data: "0x01" }],
          public: [{ schema: note, data: `0x${"00".repeat(MAX_RECORD_BYTES)}` }],
        } },
        { waitMode: "latest", to: "code", amount: "0", data: { public: [{ schema: note, data: "0x02" }] } },
      ]);
      for (const path of [join(dir, "large.bin"), "/dev/zero"]) {
        await expect(client.dispatch(parseCli([...transfer, "--public-record", `com.example.note=@${path}`])))
          .rejects.toThrow(`${path} exceeds the ${MAX_RECORD_BYTES}-byte record limit`);
      }
      expect(bodies).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires transfer amount and recipient", () => {
    expect(() => parseCli(["send", "--to", "0x1"])).toThrow(/--amount/);
  });

  it("rejects submission wait modes for a scan", () => {
    expect(() => parseCli(["sync", "--wait"])).toThrow(/not valid for sync/);
    expect(() => parseCli(["sync", "--wait", "none"])).toThrow(/not valid for sync/);
    expect(() => parseCli(["sync", "--wait", "finalized"])).toThrow(/not valid for sync/);
  });

  it("accepts per-command L1 RPC override", () => {
    const cli = parseCli(["send", "--to", "0x1", "--amount", "1", "--submit", "l1", "--l1-rpc", "http://127.0.0.1:8545"]);
    expect(cli.l1Rpc).toBe("http://127.0.0.1:8545");
    expect(cli.submit).toBe("l1");
  });

  it("parses mempool inspection and relay policy without selecting a wallet account", () => {
    expect(parseCli(["mempool", TX_ID]).mempoolContentHash).toBe(TX_ID);
    const mempool = parseCli(["mempool", "--cursor", "next", "--limit", "20", "--min-fee", "3"]);
    expect(mempool).toMatchObject({ cursor: "next", limit: 20, minOpenFee: 3n });

    const relay = parseCli(["relay", TX_ID, "--no-submit", "--blobs", "--max-blobs", "5"]);
    expect(relay).toMatchObject({
      relayContentHashes: [TX_ID],
      noSubmit: true,
      daMode: "blobs",
      maxBlobs: 5,
    });
  });

  it("validates relay carrier and blob-count flags", () => {
    expect(() => parseCli(["relay", "0x12"])).toThrow(/32-byte/);
    expect(() => parseCli(["relay", "--calldata", "--blobs"])).toThrow(/mutually exclusive/);
    expect(() => parseCli(["relay", "--max-blobs", "0"])).toThrow(/1 through 6/);
    expect(() => parseCli(["relay", "--max-blobs", "7"])).toThrow(/1 through 6/);
  });

  it("parses exact relay-journal recovery commands", () => {
    expect(parseCli(["relay-journal", "show"]).subcommand).toBe("show");
    expect(parseCli(["relay-journal", "reconcile"]).subcommand).toBe("reconcile");
    expect(parseCli([
      "relay-journal",
      "resolve",
      "--transaction-hash",
      TX_ID,
    ])).toMatchObject({ subcommand: "resolve", transactionHash: TX_ID });
    expect(() => parseCli(["relay-journal", "resolve"])).toThrow(/requires --transaction-hash/);
    expect(() => parseCli([
      "relay-journal",
      "resolve",
      "--transaction-hash",
      "0x12",
    ])).toThrow(/32-byte/);
  });
});

describe("CLI help", () => {
  it("has concise grouped root help and command-specific options", () => {
    expect(CLI_USAGE).toContain("Usage: pcash-wallet-cli <command> [options]");
    expect(CLI_USAGE).toContain("Everyday use:");
    expect(CLI_USAGE).toContain("Wallet management:");
    expect(CLI_USAGE).toContain("Advanced:");
    expect(CLI_USAGE).not.toContain("--private-relay-fee");
    expect(cliHelp(["send"])).toContain("--wait <accepted|finalized|none>");
    expect(cliHelp(["send"])).not.toContain("--seed-file");
    expect(cliHelp(["asset", "create"])).toContain("--content-digest");
    expect(cliHelp(["receive-key", "create"])).toContain("development wallets only");
  });

  it("documents the allowed flags of every executable command", () => {
    for (const [path, definition] of Object.entries(COMMAND_DEFINITIONS)) {
      const help = cliHelp(path.split(" "));
      for (const flag of definition.flags) expect(help).toContain(`--${flag}`);
    }
  });

  it("removes obsolete commands and wait flags", () => {
    for (const name of ["transfer", "scan", "code", "create-asset", "account"]) {
      expect(() => parseCli([name], {})).toThrow();
    }
    for (const flag of ["--wait-finalized", "--no-wait"]) {
      expect(() => parseCli(["account", "ensure", flag], {})).toThrow(/unknown option/);
    }
    expect(() => parseCli(["account", "ensure", "--submit", "l1", "--wait", "none"], {})).toThrow(/requires --wait/);
    expect(() => parseCli(["account", "ensure", "--wait", "unknown"], {})).toThrow(/--wait expects/);
    expect(parseCli(["account", "ensure", "--wait", "accepted"], {}).waitMode).toBe("latest");
  });
});

describe("WalletHttpClient", () => {
  it("maps the complete command surface to HTTP requests and bearer authentication", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const text = await request.text();
      requests.push({
        url: request.url,
        method: request.method,
        headers: request.headers,
        ...(text === "" ? {} : { body: JSON.parse(text) as unknown }),
      });
      return new Response(JSON.stringify({ address: "0xabc" }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const client = new WalletHttpClient("http://wallet.test/", "secret");

    for (const args of [
      ["status", "--wallet", "0xabc"],
      ["asset", "create", "--name", "Asset", "--symbol", "AST", "--supply", "1", "--content-digest", DIGEST, "--wallet", "0xabc"],
      ["receive", "--wallet", "0xabc"],
      ["sync", "--wallet", "0xabc", "--full"],
      ["account", "ensure", "--wallet", "0xabc", "--submit", "l1", "--wait", "finalized"],
      [
        "send", "--wallet", "0xabc", "--to", "code", "--amount", "12",
        "--fee", "2", "--memo", "rent — March", "--include-sender", "--wait", "none",
      ],
      ["wallet", "list"],
      ["wallet", "import", "--dev", "--key-file", "/keys/wallet.json"],
      ["receive-key", "list", "--wallet", "0xabc"],
      ["receive-key", "create", "--wallet", "0xabc"],
      ["receive-key", "import", "--wallet", "0xabc", "--file", "/keys/receive.json"],
      ["mempool", "--cursor", "next", "--limit", "20", "--kind", "privateValue", "--min-fee", "3"],
      ["relay", TX_ID, "--no-submit", "--blobs", "--max-blobs", "5", "--l1-rpc", "http://l1.test"],
      ["relay-journal", "show"],
      ["relay-journal", "reconcile"],
      ["relay-journal", "resolve", "--transaction-hash", TX_ID],
    ] as const) {
      await client.dispatch(parseCli(args));
    }

    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "http://wallet.test/status?wallet=0xabc"],
      ["POST", "http://wallet.test/assets"],
      ["GET", "http://wallet.test/code?wallet=0xabc"],
      ["POST", "http://wallet.test/scan"],
      ["POST", "http://wallet.test/account"],
      ["GET", "http://wallet.test/status?wallet=0xabc"],
      ["POST", "http://wallet.test/transfer"],
      ["GET", "http://wallet.test/wallets"],
      ["POST", "http://wallet.test/wallets/import"],
      ["GET", "http://wallet.test/receive-keys?wallet=0xabc"],
      ["POST", "http://wallet.test/receive-keys"],
      ["POST", "http://wallet.test/receive-keys"],
      ["GET", "http://wallet.test/mempool?cursor=next&limit=20&kind=privateValue&minOpenFee=3"],
      ["POST", "http://wallet.test/relay"],
      ["GET", "http://wallet.test/relay-journal"],
      ["POST", "http://wallet.test/relay-journal/reconcile"],
      ["POST", "http://wallet.test/relay-journal/resolve"],
    ]);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer secret")).toBe(true);
    expect(requests[3]?.body).toEqual({ wallet: "0xabc", full: true });
    expect(requests[4]?.body).toEqual({ wallet: "0xabc", submit: "l1", waitMode: "finalized" });
    expect(requests[6]?.body).toEqual({
      wallet: "0xabc",
      waitMode: "none",
      to: "code",
      amount: "12",
      data: { recipients: [{ to: "code", records: [
        { schema: "0x01", data: "0x72656e7420e28094204d61726368" },
        { schema: "0x03", data: "0x0000000000000000000000000000000000000abc" },
      ] }] },
      openFeeAmount: "2",
    });
    expect(requests[8]?.body).toEqual({ keyFile: "/keys/wallet.json" });
    expect(requests[10]?.body).toEqual({ wallet: "0xabc", waitMode: "latest", create: true });
    expect(requests[11]?.body).toEqual({
      wallet: "0xabc",
      waitMode: "latest",
      file: "/keys/receive.json",
    });
    expect(requests[12]?.body).toBeUndefined();
    expect(requests[13]?.body).toEqual({
      contentHashes: [TX_ID],
      noSubmit: true,
      daMode: "blobs",
      maxBlobs: 5,
      l1Rpc: "http://l1.test",
    });
    expect(requests[14]?.body).toBeUndefined();
    expect(requests[15]?.body).toEqual({});
    expect(requests[16]?.body).toEqual({ transactionHash: TX_ID });
  });

  it("surfaces structured server errors with their HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "active scan" }),
      { status: 409, headers: { "content-type": "application/json" } },
    )));

    await expect(new WalletHttpClient("http://wallet.test").dispatch(parseCli(["status"])))
      .rejects.toEqual(expect.objectContaining<Partial<WalletHttpError>>({
        name: "WalletHttpError",
        message: "active scan",
        status: 409,
      }));
  });

  it("keeps the content hash of a transaction in doubt", async () => {
    const contentHash = `0x${"ab".repeat(32)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: `admitting transaction ${contentHash} to the node failed (HttpRequestError)`, contentHash }),
      { status: 502, headers: { "content-type": "application/json" } },
    )));

    await expect(new WalletHttpClient("http://wallet.test").dispatch(parseCli(["status"])))
      .rejects.toEqual(expect.objectContaining<Partial<WalletHttpError>>({
        name: "WalletHttpError",
        status: 502,
        contentHash,
      }));
  });
});

describe("parseServeArgs", () => {
  it("defaults prover to wasm and listen to loopback", () => {
    const opts = parseServeArgs(["serve"]);
    expect(opts.prover).toBe("wasm");
    expect(opts.listen).toBe("127.0.0.1:8745");
    expect(opts.metricsAddr).toBeUndefined();
    expect(opts.dev).toBe(false);
  });

  it("enables explicit in-memory development mode", () => {
    expect(parseServeArgs(["serve"], { PCASH_WALLET_DEV: "true" }).dev).toBe(true);
    expect(parseServeArgs(["serve"], { PCASH_WALLET_DEV: "false" }).dev).toBe(false);
    expect(parseServeArgs(["serve", "--dev"], { PCASH_WALLET_DEV: "false" }).dev).toBe(true);
    expect(() => parseServeArgs(["serve"], { PCASH_WALLET_DEV: "invalid" })).toThrow(/dev must be a boolean/);
    expect(parseServeArgs(["serve", "--dev"]).dev).toBe(true);
    expect(devAnvilWallet()).toEqual({
      address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      privateKey: DEV_ANVIL_WALLET_PRIVATE_KEY,
    });
  });

  it("accepts an optional loopback metrics address", () => {
    expect(parseServeArgs(["serve", "--metrics-addr", "127.0.0.1:9465"]).metricsAddr)
      .toBe("127.0.0.1:9465");
    expect(parseMetricsAddress("localhost:0")).toEqual({ host: "localhost", port: 0 });
    expect(parseMetricsAddress("[::1]:9465")).toEqual({ host: "::1", port: 9465 });
    expect(parseListen("[::1]:8745")).toEqual({ host: "::1", port: 8745 });
  });

  it("rejects non-loopback and malformed metrics addresses", () => {
    expect(() => parseServeArgs(["serve", "--metrics-addr", "0.0.0.0:9465"]))
      .toThrow(/only on/);
    expect(() => parseMetricsAddress("127.0.0.1"))
      .toThrow(/expects host:port/);
    expect(() => parseMetricsAddress("127.0.0.1:"))
      .toThrow(/invalid metrics port/);
    expect(() => parseMetricsAddress("127.0.0.1:70000"))
      .toThrow(/invalid metrics port/);
  });

  it("accepts native prover", () => {
    expect(parseServeArgs(["serve", "--prover", "native"]).prover).toBe("native");
  });

  it("reads server configuration from the wallet namespace with CLI precedence", () => {
    const env = {
      PCASH_WALLET_LISTEN: "127.0.0.1:9001",
      PCASH_WALLET_RPC_URL: "http://node.test",
      PCASH_WALLET_L1_RPC: "http://l1.test",
      PCASH_WALLET_MAX_FEE_PER_GAS: "7",
      PCASH_WALLET_DATA_DIR: "/tmp/wallet-test",
      PCASH_WALLET_PROVER: "native",
      PCASH_WALLET_SCAN_INTERVAL_MS: "42",
      PCASH_WALLET_TOKEN: "secret",
    };
    expect(parseServeArgs(["serve"], env)).toMatchObject({
      listen: "127.0.0.1:9001",
      rpc: "http://node.test",
      dataDir: "/tmp/wallet-test",
      prover: "native",
      scanIntervalMs: 42,
      token: "secret",
      l1Rpc: "http://l1.test",
      maxFeePerGas: 7n,
    });
    expect(parseServeArgs(["serve", "--listen", "127.0.0.1:9002"], env).listen).toBe("127.0.0.1:9002");
    expect(parseServeArgs(["serve", "--rpc-url", "http://node.flag"], env).rpc).toBe("http://node.flag");
    const shared = parseServeArgs(["serve"], {
      PCASH_RPC_URL: "http://node.shared",
      PCASH_L1_RPC: "http://l1.shared",
      PCASH_L1_KEY: `0x${"ab".repeat(32)}`,
      PCASH_L1_MAX_FEE_PER_GAS: "1",
      PCASH_SELECTED_RELAYER_URL: "http://127.0.0.1:9090",
    });
    expect(shared.rpc).toBe("http://127.0.0.1:8645");
    expect(shared).not.toHaveProperty("l1Rpc");
    expect(shared).not.toHaveProperty("l1Key");
    expect(shared).not.toHaveProperty("maxFeePerGas");
    expect(shared).not.toHaveProperty("selectedRelayerUrl");
  });

  it("reads the L1 key only from the environment, exclusive of a key file", () => {
    const key = `0x${"ab".repeat(32)}`;
    expect(parseServeArgs(["serve"], { PCASH_WALLET_L1_KEY: key }).l1Key).toBe(key);
    expect(() => parseServeArgs(["serve", `--l1-key=${key}`], {})).toThrow(/unknown option --l1key/);
    expect(() => parseServeArgs(["serve", "--l1-key-file", "/tmp/key.json"], { PCASH_WALLET_L1_KEY: key }))
      .toThrow(/mutually exclusive/);
  });

  it("keeps automatic direct delivery by default and accepts an explicit carrier", () => {
    expect(parseServeArgs(["serve"], {}).daMode).toBe("auto");
    expect(parseServeArgs(["serve"], { PCASH_WALLET_DA_MODE: "calldata" }).daMode).toBe("calldata");
    expect(parseServeArgs(["serve", "--da-mode", "blobs"], { PCASH_WALLET_DA_MODE: "calldata" }).daMode).toBe("blobs");
    expect(() => parseServeArgs(["serve", "--da-mode", "invalid"], {})).toThrow(/--da-mode/);
  });

  it("reads the log level and file with CLI precedence", () => {
    const defaults = parseServeArgs(["serve"], {});
    expect(defaults.logLevel).toBe("info");
    expect(defaults.logFile).toBeUndefined();
    const env = { PCASH_WALLET_LOG_LEVEL: "warning", PCASH_WALLET_LOG_FILE: "/var/log/wallet.log" };
    expect(parseServeArgs(["serve"], env)).toMatchObject({ logLevel: "warning", logFile: "/var/log/wallet.log" });
    expect(parseServeArgs(["serve", "--log-level", "DEBUG", "--log-file", "/tmp/w.log"], env))
      .toMatchObject({ logLevel: "debug", logFile: "/tmp/w.log" });
    expect(() => parseServeArgs(["serve", "--log-level", "trace"], {})).toThrow(/--log-level expects none, error/);
  });

  it("parses wallet relay fee policies", () => {
    expect(parseServeArgs([
      "serve",
      "--max-fee-per-gas",
      "0x64",
      "--min-value-per-byte",
      "3",
    ])).toMatchObject({ maxFeePerGas: 100n, minValuePerByte: 3n });
    expect(() => parseServeArgs(["serve", "--max-fee-per-gas=-1"])).toThrow(/nonnegative/);
  });

  it("configures one selected relayer endpoint from flag or environment", () => {
    expect(parseServeArgs(["serve", "--selected-relayer-url", "https://relay.test"], {}).selectedRelayerUrl)
      .toBe("https://relay.test");
    expect(parseServeArgs(["serve"], { PCASH_WALLET_SELECTED_RELAYER_URL: "http://127.0.0.1:9090" }).selectedRelayerUrl)
      .toBe("http://127.0.0.1:9090");
    expect(() => parseServeArgs(["serve", "--selected-relayer-url", "file:///tmp/relay"], {}))
      .toThrow(/HTTP or HTTPS/);
  });

  it("rejects unknown or incomplete server flags", () => {
    expect(() => parseServeArgs(["--wat"])).toThrow(/unknown option --wat/);
    expect(() => parseServeArgs(["--rpc", "http://node.test"])).toThrow(/unknown option --rpc/);
    expect(() => parseServeArgs(["serve", "extra"])).toThrow(/unexpected argument extra/);
    expect(() => parseServeArgs(["--scan-interval-ms", "0"])).toThrow(/positive integer/);
  });
});
