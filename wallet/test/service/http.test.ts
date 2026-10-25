import { memoSchema, claimedSenderSchema } from "@pcash/sdk/delivery";
import { applicationSchemaId, networkConfigFromStatus } from "@pcash/sdk/protocol";
import { execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PcashNodeClient, PcashNodeRpcError } from "@pcash/sdk/clients";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableSubmissionAdapter } from "@pcash/sdk/wallet";
import { serviceSubmissionFor } from "../../src/service/serve.ts";
import { contractCreationFixture } from "../contractCreationFixture.ts";
import { testStatus } from "../statusFixture.ts";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import { emptyWalletState } from "@pcash/sdk/wallet/testing";
import {
  WALLET_DATABASE_STATE_STORE,
} from "@pcash/sdk/wallet/database";
import { PGliteWalletDatabase } from "../../src/pgliteDatabase.ts";
import { OPEN_WALLET_INTERNAL, Wallet } from "@pcash/sdk/wallet";
import { parseCli } from "../../src/cli/cli.ts";
import { WalletHttpClient } from "../../src/cli/client.ts";
import { handleWalletHttp, type WalletHttpContext } from "../../src/service/http.ts";
import { planPublication } from "@pcash/sdk/wallet/actions";
import {
  RelayDeadlineError,
  RelayJournalConflictError,
  RelayPreBroadcastError,
  Relayer,
  RelayUpstreamError,
  RelayValidationError,
} from "@pcash/sdk/relay";
import { MemoryRelayJournal, PrivateKeyRelaySubmitter } from "@pcash/sdk/node";
import { resolveRecipientDelivery } from "@pcash/sdk/delivery";
import { http } from "viem";
import { fieldToHex } from "@pcash/sdk/crypto";
import { ChainSim } from "../chainFixture.ts";
import { TEST_PRIV_KEY } from "../testWallet.ts";
import { PrometheusWalletMetrics } from "../../src/service/metrics.ts";
import { assetDefinitionAssetId, formatAssetDefinition, type AssetDefinition } from "@pcash/sdk/protocol";
import { bytes32Hex, fromHex, keccak256, toHex } from "@pcash/sdk/utils";

const servers: ReturnType<typeof createServer>[] = [];
const DIGEST = `0x${"cd".repeat(32)}`;
const TX_HASH = `0x${"ab".repeat(32)}`;
const definition: AssetDefinition = {
  initialSupply: 123n,
  assetSecretCommitment: 0x32n,
  metadata: { name: "Asset", symbol: "AST", decimals: 6, contentDigest: fromHex(DIGEST) },
};
const assetId = assetDefinitionAssetId(definition);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function serve(context: WalletHttpContext, requests?: string[]): Promise<string> {
  const server = createServer((request, response) => {
    requests?.push(request.url ?? "");
    void handleWalletHttp(request, response, context);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function executeCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [fileURLToPath(new URL("../../src/cli/bin.ts", import.meta.url)), ...args],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function rawGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

function context(): WalletHttpContext {
  return {
    logger: { error: () => undefined },
    node: {
      status: async () => ({ latestBlock: 5n }) as never,
    },
    relay: {
      getMempool: async () => ({ items: [], nextCursor: null }) as never,
      getMempoolTransaction: async () => null,
      relay: async () => ({ submitted: false }) as never,
    },
    relayJournal: {
      show: async () => ({ latched: false, entries: [] }),
      reconcile: async () => ({ latched: false, entries: [] }),
      resolve: async (transactionHash: string) => ({
        latched: false,
        resolutionId: transactionHash,
        transactionHash,
        archivePath: "/archive/relay.json",
      }),
    },
    runtimeFor: () => { throw new Error("runtimeFor must not be called"); },
    listWallets: () => [],
    importWallet: async () => ({}),
    createReceiveKey: async () => ({}),
    importReceiveKey: async () => ({}),
    listReceiveKeys: () => [],
    submissionFor: () => { throw new Error("submissionFor must not be called"); },
    sync: async () => { throw new Error("sync must not be called"); },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe("wallet HTTP boundary", () => {
  it("shows bulk progress without exposing recipient plaintext", async () => {
    const ctx = context();
    ctx.runtimeFor = () => ({
      bulkJobs: async () => [{ jobId: "abc", kind: "payment", assetId: 0n, recipients: [{ to: "secret-recipient", amount: 9n }],
        openFeeAmounts: { 0: 1n, 1: 2n }, maxTransactions: 2, targetNotes: 4, shape: null,
        chunks: [{ shape: 1, firstRecipient: 0, recipientCount: 1, contentHash: "public-content-hash", outcome: "unresolved", inclusion: null }] }],
    }) as never;
    const url = await serve(ctx);
    const response = await fetch(url + "/bulk");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject([{ jobId: "abc", recipientCount: 1, chunks: [{ contentHash: "public-content-hash" }] }]);
    expect(body).not.toContain("secret-recipient");
  });

  it("rejects invalid bulk execution and client job configuration before wallet access", async () => {
    const url = await serve(context());
    const post = (path: string, body: unknown) => fetch(url + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const missingJob = await post("/bulk/step", {});
    expect(missingJob.status).toBe(400);
    expect(await missingJob.json()).toEqual({ error: "jobId is required" });
    expect((await post("/bulk/step", { jobId: "abc", chunkIndex: -1 })).status).toBe(400);
    for (const job of [
      { kind: "consolidation", openFeeAmount: "1", maxTransactions: 0 },
      { kind: "payment", openFeeAmount: "0", maxTransactions: 1, recipients: [] },
      { kind: "consolidation", openFeeAmount: "1", maxTransactions: 1, shape: 2 },
      { kind: "payment", openFeeAmount: "0", maxTransactions: 1, recipients: [{ to: "x", amount: "0" }] },
      { kind: "consolidation", maxTransactions: 1, assetId: "0xzz" },
      { kind: "consolidation", maxTransactions: 1, assetId: `0x${"ff".repeat(32)}` },
    ]) expect((await post("/bulk", { job })).status).toBe(400);
  });

  it("accepts a bulk job assetId in the hex form asset routes return", async () => {
    const testContext = context();
    const jobs: Array<Record<string, unknown>> = [];
    testContext.runtimeFor = () => ({
      startBulkJob: async (job: Record<string, unknown>) => {
        jobs.push(job);
        return { jobId: "abc", kind: "consolidation", assetId: job.assetId, recipients: [], openFeeAmounts: { 0: 1n, 1: 1n },
          maxTransactions: 1, targetNotes: 4, shape: null, chunks: [] };
      },
    }) as never;
    const url = await serve(testContext);
    for (const assetId of [`0x${"00".repeat(31)}55`, "85"]) {
      const response = await fetch(`${url}/bulk`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ job: { kind: "consolidation", maxTransactions: 1, assetId } }) });
      expect(response.status).toBe(200);
    }
    expect(jobs.map((job) => job.assetId)).toEqual([0x55n, 0x55n]);
  });

  it("records normalized HTTP routes, status codes, failures, and latency", async () => {
    const testContext = context();
    const metrics = new PrometheusWalletMetrics();
    testContext.metrics = metrics;
    const url = await serve(testContext);

    expect((await fetch(`${url}/health?token=must-not-be-a-label`)).status).toBe(200);
    expect((await fetch(`${url}/wallets/0xsecret/private`)).status).toBe(404);

    const body = await metrics.metrics();
    expect(body).toContain('pcash_wallet_http_requests_total{method="GET",route="/health"} 1');
    expect(body).toContain('pcash_wallet_http_responses_total{method="GET",route="/health",status="200"} 1');
    expect(body).toContain('pcash_wallet_http_requests_total{method="GET",route="/unknown"} 1');
    expect(body).toContain('pcash_wallet_http_errors_total{method="GET",route="/unknown",status="404"} 1');
    expect(body).toContain('pcash_wallet_http_request_duration_seconds_count{method="GET",route="/health"} 1');
    expect(body).not.toContain("must-not-be-a-label");
    expect(body).not.toContain("0xsecret");
  });

  it("reports health before a wallet is imported", async () => {
    const url = await serve(context());
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(await health.json()).toEqual({ ok: true, latestBlock: "5", wallets: [] });
  });

  it("forwards paginated mempool inspection without selecting a wallet runtime", async () => {
    const testContext = context();
    let received: unknown;
    testContext.relay.getMempool = async (query) => {
      received = query;
      return {
        items: [],
        nextCursor: null,
        headCheckedBlock: 2n,
        headCheckedBlockHash: `0x${"11".repeat(32)}`,
        peerCount: 3n,
      };
    };
    const url = await serve(testContext);

    const response = await fetch(`${url}/mempool?cursor=next&limit=20&kind=privateValue&minOpenFee=7`);

    expect(response.status).toBe(200);
    expect(received).toEqual({ cursor: "next", limit: 20, kind: "privateValue", minOpenFee: 7n });
    expect(await response.json()).toMatchObject({ items: [], peerCount: "3" });
  });

  it("forwards one transaction lookup and one relay request", async () => {
    const testContext = context();
    const contentHash = `0x${"22".repeat(32)}`;
    let lookup: string | undefined;
    let relayOptions: unknown;
    testContext.relay.getMempoolTransaction = async (requestedContentHash) => {
      lookup = requestedContentHash;
      return null;
    };
    testContext.relay.relay = async (options) => {
      relayOptions = options;
      return { batch: "0x010000", submitted: false } as never;
    };
    const url = await serve(testContext);

    const lookupResponse = await fetch(`${url}/mempool?contentHash=${contentHash}`);
    expect(lookupResponse.status).toBe(200);
    expect(await lookupResponse.json()).toBeNull();
    expect(lookup).toBe(contentHash);

    const relayResponse = await fetch(`${url}/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contentHashes: [contentHash],
        noSubmit: true,
        daMode: "blobs",
        maxBlobs: 5,
        l1Rpc: "http://l1.test",
      }),
    });
    expect(relayResponse.status).toBe(200);
    expect(relayOptions).toEqual({
      contentHashes: [contentHash],
      noSubmit: true,
      daMode: "blobs",
      maxBlobs: 5,
      l1Rpc: "http://l1.test",
    });
    expect(await relayResponse.json()).toEqual({ batch: "0x010000", submitted: false });
  });

  it("validates mempool and relay request fields at the HTTP boundary", async () => {
    const url = await serve(context());
    const badLimit = await fetch(`${url}/mempool?limit=0`);
    expect(badLimit.status).toBe(400);
    expect(await badLimit.json()).toEqual({ error: "limit must be a positive integer" });

    const badRelay = await fetch(`${url}/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ daMode: "cheap" }),
    });
    expect(badRelay.status).toBe(400);
    expect(await badRelay.json()).toEqual({ error: "daMode expects auto, calldata, or blobs" });
  });

  it("requires authentication for exact relay-journal recovery endpoints", async () => {
    const testContext = context();
    const transactionHash = `0x${"66".repeat(32)}`;
    testContext.token = "operator-token";
    testContext.relayJournal.show = async () => ({
      latched: true,
      entries: [{ transactionHash, signedTransaction: "0x02aa" } as never],
    });
    const url = await serve(testContext);

    expect((await fetch(`${url}/relay-journal`)).status).toBe(401);
    const client = new WalletHttpClient(url, "operator-token");
    await expect(client.dispatch(parseCli(["relay-journal", "show"]))).resolves.toMatchObject({
      latched: true,
      entries: [{ transactionHash, signedTransaction: "0x02aa" }],
    });
    await expect(client.dispatch(parseCli(["relay-journal", "reconcile"]))).resolves.toEqual({
      latched: false,
      entries: [],
    });
    await expect(client.dispatch(parseCli([
      "relay-journal",
      "resolve",
      "--transaction-hash",
      transactionHash,
    ]))).resolves.toEqual({
      latched: false,
      resolutionId: transactionHash,
      transactionHash,
      archivePath: "/archive/relay.json",
    });
  });

  it.each([
    [new RelayJournalConflictError("latched"), 409],
    [new RelayDeadlineError("deadline"), 504],
    [new RelayUpstreamError("upstream"), 502],
    [new RelayValidationError("invalid"), 400],
    [new Error("unexpected"), 500],
  ])("maps typed relay failures to HTTP %s", async (failure, expectedStatus) => {
    const testContext = context();
    testContext.relay.relay = async () => { throw failure; };
    const url = await serve(testContext);

    const response = await fetch(`${url}/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(expectedStatus);
  });

  describe("a failing node endpoint", () => {
    // A node or L1 URL may carry its credential in the path or the query string.
    const NODE_URL = "https://node.example/rpc/SECRETKEY?apikey=SECRET2";
    const L1_URL = "https://l1.example/rpc/SECRETKEY?apikey=SECRET2";
    const refused = async (): Promise<Response> => { throw new TypeError("fetch failed"); };
    const unreachable = new PcashNodeClient(NODE_URL, { fetchFn: refused });
    // A gateway that forwarded the request and then gave up on the node.
    const gatewayTimeout = new PcashNodeClient(NODE_URL, {
      fetchFn: async () => new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32_603, message: "upstream request timeout" } }),
        { status: 504, headers: { "content-type": "application/json" } },
      ),
    });
    const entry = contractCreationFixture(1, 5n);
    const contentHash = toHex(keccak256(entry));
    const transactionHex = toHex(entry);
    const status = testStatus({ pcashChainId: 1, acceptedTransactionTypes: [0, 1, 2] });
    const key = toHex(TEST_PRIV_KEY);

    /**
     * A service over `node` whose runtime journals the action and then submits
     * it through the request's transport, as the durable submission engine does.
     */
    const serviceOver = (node: PcashNodeClient) => {
      const testContext = context();
      testContext.node = node;
      testContext.relay = new Relayer({
        node,
        payoutRecipient: async () => { throw new Error("no relay reaches payout"); },
        submitterFor: () => ({ address: `0x${"11".repeat(20)}`, supportedCarriers: ["calldata"], assertAvailable: async () => undefined, inFlight: async () => [] }) as never,
      });
      testContext.submissionFor = serviceSubmissionFor({
        node,
        l1Rpc: L1_URL,
        daMode: "auto",
        submitterFor: (l1Rpc) => new PrivateKeyRelaySubmitter({
          rpcUrl: l1Rpc ?? L1_URL,
          privateKey: key,
          node,
          journal: new MemoryRelayJournal(),
          transport: http(l1Rpc ?? L1_URL, { fetchFn: refused, retryCount: 0 }),
        }),
        profileFor: () => derivePcashProfileFromPrivateKey(fromHex(key), networkConfigFromStatus(status)),
      });
      testContext.runtimeFor = () => ({
        address: "0xabc",
        send: async ({ submission, onPrepared }: { submission: DurableSubmissionAdapter; onPrepared: (hash: string, hex: string) => void }) => {
          const prepared = await submission.preflight({ transactionBytes: entry, status, retry: false });
          onPrepared(contentHash, transactionHex);
          return submission.submit({ transactionBytes: entry, status, retry: false, prepared });
        },
      }) as never;
      return testContext;
    };
    /** A node that answers status and admits through `submitRawTransaction`. */
    const admittingThrough = (submitRawTransaction: PcashNodeClient["submitRawTransaction"]) =>
      ({ ...unreachable, status: async () => status, submitRawTransaction }) as unknown as PcashNodeClient;
    const request = async (testContext: WalletHttpContext, path: string, body?: unknown) => {
      const response = await fetch(`${await serve(testContext)}${path}`, body === undefined ? {} : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      for (const secret of ["SECRETKEY", "SECRET2", transactionHex.slice(2)]) expect(text).not.toContain(secret);
      return { status: response.status, body: JSON.parse(text) as { error: string; contentHash?: string } };
    };
    const transfer = { to: "receive-code", amount: "1" };

    it("is the kind of failure whose own message carries the endpoint and request", async () => {
      const { message } = await unreachable.submitRawTransaction(transactionHex).then(
        () => { throw new Error("an unreachable node admitted"); },
        (error: Error) => error,
      );
      expect(message).toContain("SECRETKEY");
      expect(message).toContain("SECRET2");
      expect(message).toContain(transactionHex.slice(2));
    });

    it.each([
      ["GET /health", "/health", undefined, 500, "HTTP request failed."],
      ["GET /mempool", "/mempool", undefined, 502, "reading the mempool failed (HttpRequestError)"],
      ["GET /mempool?contentHash=", `/mempool?contentHash=${contentHash}`, undefined, 502, `reading mempool content ${contentHash} failed (HttpRequestError)`],
      ["POST /relay", "/relay", {}, 502, "reading a mempool page failed (HttpRequestError)"],
      // The status read before admission fails, so nothing was sent.
      ["POST /transfer", "/transfer", transfer, 502, "reading node status before admission failed (HttpRequestError)"],
      ["POST /transfer --submit l1", "/transfer", { ...transfer, submit: "l1" }, 502, "verifying L1 identity failed (HttpRequestError)"],
    ])("keeps the credentialed URL out of %s", async (_label, path, body, expectedStatus, error) => {
      const response = await request(serviceOver(unreachable), path, body);

      expect(response).toEqual({ status: expectedStatus, body: { error } });
    });

    it.each([
      ["fails in transport", admittingThrough((hex) => unreachable.submitRawTransaction(hex))],
      ["reaches a gateway that answers 504 with a JSON-RPC error", admittingThrough((hex) => gatewayTimeout.submitRawTransaction(hex))],
      ["gets an answer that may follow an insert", admittingThrough(async () => {
        throw new PcashNodeRpcError({ code: -32_013, message: "verification unavailable: admission task failed" }, { method: "pcash_submitRawTransaction", url: NODE_URL });
      })],
    ])("names the journaled transaction in doubt when admission %s", async (_label, node) => {
      const testContext = serviceOver(node);
      const logged: string[] = [];
      testContext.logger = { error: (line: unknown) => { logged.push(String(line)); } };

      const response = await request(testContext, "/transfer", transfer);

      // The operator's log keeps the whole chain, including the upstream error.
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(`POST /transfer failed with 502; transaction ${contentHash} may have been submitted`);
      expect(logged[0]).toContain("[cause]");
      expect(logged[0]).toMatch(/SECRETKEY|admission task failed/);
      expect(response.status).toBe(502);
      expect(response.body.contentHash).toBe(contentHash);
      expect(response.body.error).toMatch(new RegExp(`^admitting transaction ${contentHash} to the node failed \\((HttpRequestError|PcashNodeRpcError)\\)$`));
    });

    it("returns the node's own words and no content hash when it refuses the transaction", async () => {
      const node = admittingThrough(async () => {
        throw new PcashNodeRpcError({ code: -32_011, message: "invalid transaction: proof rejected" }, { method: "pcash_submitRawTransaction", url: NODE_URL });
      });
      const testContext = serviceOver(node);
      const logged: unknown[] = [];
      testContext.logger = { error: (line: unknown) => { logged.push(line); } };

      const response = await request(testContext, "/transfer", transfer);

      expect(logged).toEqual([]);
      expect(response).toEqual({ status: 400, body: { error: "node RPC error -32011: invalid transaction: proof rejected" } });
    });

    it("names no transaction in doubt when an account's L1 preflight fails after the action was journaled", async () => {
      const testContext = serviceOver(unreachable);
      const logged: unknown[] = [];
      testContext.logger = { error: (line: unknown) => { logged.push(line); } };
      testContext.runtimeFor = () => ({
        updateAccount: async ({ onPrepared }: { onPrepared: (hash: string, hex: string) => void }) => {
          onPrepared(contentHash, transactionHex);
          throw new RelayPreBroadcastError(new RelayValidationError("not enough ETH for L1 gas"));
        },
      }) as never;

      const response = await request(testContext, "/account", {});

      expect(logged).toEqual([]);
      expect(response).toEqual({ status: 400, body: { error: "not enough ETH for L1 gas" } });
    });

    it("keeps a correctable failure's own words", async () => {
      const testContext = serviceOver(unreachable);
      const recipient = `0x${"12".repeat(20)}`;
      testContext.runtimeFor = () => ({
        send: async () => resolveRecipientDelivery(recipient, 1n, async () => null),
      }) as never;

      const response = await request(testContext, "/transfer", { to: recipient, amount: "1" });

      expect(response.status).toBe(500);
      expect(response.body.error).toMatch(/has no published ML-KEM receive key; they must publish an account with one or share an extended code/);
      expect(response.body.contentHash).toBeUndefined();
    });
  });

  it("rejects unauthenticated requests when a token is configured", async () => {
    const testContext = context();
    testContext.token = "test-token";
    const url = await serve(testContext);

    const unauthorized = await fetch(`${url}/wallets`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });

    const unauthorizedTransfer = await fetch(`${url}/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "receive-code", amount: "1" }),
    });
    expect(unauthorizedTransfer.status).toBe(401);
    expect(await unauthorizedTransfer.json()).toEqual({ error: "unauthorized" });

    const client = new WalletHttpClient(url, "test-token");
    await expect(client.dispatch(parseCli(["wallet", "list"]))).resolves.toEqual([]);
  });

  it("rejects text/plain transfer requests", async () => {
    const url = await serve(context());

    const response = await fetch(`${url}/transfer`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ to: "receive-code", amount: "1" }),
    });

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      error: "mutating requests require content-type application/json",
    });
  });

  it("rejects unexpected Host and Origin values", async () => {
    const url = await serve(context());

    const badHost = await rawGet(`${url}/wallets`, { host: "attacker.example" });
    expect(badHost.status).toBe(400);
    expect(badHost.body).toEqual({ error: "unexpected Host header" });

    const badOrigin = await fetch(`${url}/wallets`, {
      headers: { origin: "https://attacker.example" },
    });
    expect(badOrigin.status).toBe(403);
    expect(await badOrigin.json()).toEqual({ error: "unexpected Origin header" });

    const sameOrigin = await fetch(`${url}/wallets`, { headers: { origin: url } });
    expect(sameOrigin.status).toBe(200);
  });

  it("reports server errors with exit code 1", async () => {
    const testContext = context();
    testContext.runtimeFor = () => { throw new Error("wallet unavailable"); };
    const url = await serve(testContext);

    const result = await executeCli(["status", "--wallet-url", url]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("pcash-wallet-cli: wallet unavailable");
  });

  it("prints help successfully and returns exit code 2 for invalid arguments", async () => {
    const help = await executeCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: pcash-wallet-cli <command> [options]");
    expect(help.stderr).toBe("");

    const transferHelp = await executeCli(["send", "--help"]);
    expect(transferHelp.code).toBe(0);
    expect(transferHelp.stdout).toContain("send --to <receive-code> --amount 10");
    expect(transferHelp.stdout).not.toContain("--funding");
    expect(transferHelp.stdout).toContain("--fee <atomic-units>");

    const invalid = await executeCli(["send", "--to", "0x1"]);
    expect(invalid.code).toBe(2);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("pcash-wallet-cli: send requires --amount");
  });

  it("rejects non-object JSON bodies", async () => {
    const url = await serve(context());
    const response = await fetch(`${url}/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "request body must be a JSON object" });
  });

  it("presents a newly-created account's direct submission result", async () => {
    const testContext = context();
    testContext.runtimeFor = () => ({
      updateAccount: async () => ({
        contentHash: "0xtx",
        accepted: true,
        queued: false,
        output: { path: "mempool", accepted: true },
      }),
    }) as never;
    testContext.submissionFor = () => ({}) as never;
    const url = await serve(testContext);

    const response = await fetch(`${url}/account`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      path: "mempool",
      submit: { path: "mempool", accepted: true },
      accountAccepted: true,
    });
  });

  it("forwards asset creation through the selected wallet runtime", async () => {
    const testContext = context();
    const submission = {} as never;
    let selectedWallet: string | undefined;
    let intent: Record<string, unknown> | undefined;
    testContext.node = { status: async () => ({ latestBlock: 0n, latestBlockHash: "0x0", index: { status: "ready", cursor: { blockNumber: 0n, blockHash: "0x0" } } }) as never };
    testContext.runtimeFor = (wallet) => {
      selectedWallet = wallet;
      return {
        createAsset: async (value: Record<string, unknown>) => {
          intent = value;
          return {
            contentHash: "0xtx",
            accepted: true,
            queued: false,
            output: { path: "mempool", accepted: true },
            assetId,
            definition,
          };
        },
      } as never;
    };
    testContext.submissionFor = () => submission;
    const url = await serve(testContext);

    const response = await fetch(`${url}/assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wallet: "0xabc",
        name: "Asset",
        symbol: "AST",
        decimals: 6,
        initialSupply: "123",
        contentDigest: DIGEST,
        assetId: "0x55",
      }),
    });

    expect(response.status).toBe(200);
    expect(selectedWallet).toBe("0xabc");
    expect(intent).toEqual({
      metadata: {
        name: "Asset",
        symbol: "AST",
        decimals: 6,
        contentDigest: fromHex(DIGEST),
      },
      initialSupply: 123n,
      assetId: 0x55n,
      submission,
      onPrepared: expect.any(Function),
    });
    expect(await response.json()).toMatchObject({
      contentHash: "0xtx",
      path: "mempool",
      submit: { path: "mempool", accepted: true },
      assetId: bytes32Hex(assetId),
      definition: { text: formatAssetDefinition(definition), name: "Asset", symbol: "AST", decimals: 6, contentDigest: DIGEST, initialSupply: "123" },
    });
  });

  it("rejects malformed asset creation requests before selecting a wallet runtime", async () => {
    const testContext = context();
    const url = await serve(testContext);
    const invalidBodies = [
      { symbol: "AST", decimals: 6, initialSupply: "123", contentDigest: DIGEST },
      { name: "Asset", decimals: 6, initialSupply: "123", contentDigest: DIGEST },
      { name: "Asset", symbol: "AST", decimals: "6", initialSupply: "123", contentDigest: DIGEST },
      { name: "Asset", symbol: "AST", decimals: 6, initialSupply: "0", contentDigest: DIGEST },
    ];

    for (const body of invalidBodies) {
      const response = await fetch(`${url}/assets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "asset creation requires name, symbol, numeric decimals and positive initialSupply",
      });
    }
    for (const contentDigest of [undefined, "0x12", "cd".repeat(32)]) {
      const response = await fetch(`${url}/assets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Asset", symbol: "AST", decimals: 6, initialSupply: "123", contentDigest }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "contentDigest must be a 32-byte 0x-hex digest" });
    }
    const zeroAsset = await fetch(`${url}/assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Asset", symbol: "AST", decimals: 6, initialSupply: "123", contentDigest: DIGEST, assetId: "0" }),
    });
    expect(zeroAsset.status).toBe(400);
  });

  it("presents assets with their verified definitions", async () => {
    const testContext = context();
    testContext.runtimeFor = () => ({
      assets: async () => [
        { assetId: 0x55n, definition: null, private: 4n, spendable: 3n, created: false },
        { assetId, definition, private: 123n, spendable: 123n, created: true },
      ],
    }) as never;
    const url = await serve(testContext);
    const response = await fetch(`${url}/assets?wallet=0xabc`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { assetId: bytes32Hex(0x55n), definition: null, private: "4", spendable: "3", created: false },
      { assetId: bytes32Hex(assetId), private: "123", spendable: "123", created: true, definition: {
        text: formatAssetDefinition(definition), name: "Asset", symbol: "AST", decimals: 6, contentDigest: DIGEST, initialSupply: "123",
      } },
    ]);
  });

  it("forwards asset payments and burns and rejects malformed ones before wallet access", async () => {
    const testContext = context();
    const submission = { mode: "mempool" } as never;
    const calls: Array<[string, Record<string, unknown>]> = [];
    testContext.submissionFor = () => submission;
    testContext.runtimeFor = () => ({
      sendAsset: async (intent: Record<string, unknown>) => { calls.push(["send", intent]); return { contentHash: "0xtx", queued: true, assetId }; },
      burnAsset: async (intent: Record<string, unknown>) => { calls.push(["burn", intent]); return { contentHash: "0xtx", queued: true, assetId }; },
    }) as never;
    const url = await serve(testContext);
    const post = (path: string, body: unknown) => fetch(url + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });

    const sent = await post("/assets/send", { assetId: "0x55", openFeeAmount: "2",
      outputs: [{ to: "code", amount: "3" }, { to: "0x1", amount: "4", noteSecret: "7" }, { to: "0x2", amount: "5", noteSecret: "0" }],
      data: { self: [{ schema: applicationSchemaId("com.example.record009"), data: "0x0102" }, { schema: applicationSchemaId("com.example.record012"), data: "0xff" }] } });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ contentHash: "0xtx", path: "mempool", assetId: bytes32Hex(assetId) });
    expect((await post("/assets/burn", { assetId: "85", amount: "5", retryContentHash: TX_HASH })).status).toBe(200);
    expect(calls).toEqual([
      ["send", { assetId: 0x55n, openFeeAmount: 2n, submission, onPrepared: expect.any(Function),
        outputs: [{ to: "code", amount: 3n }, { to: "0x1", amount: 4n, noteSecret: 7n }, { to: "0x2", amount: 5n, noteSecret: 0n }],
        data: { recipients: [], self: [{ schema: applicationSchemaId("com.example.record009"), data: Uint8Array.of(1, 2) }, { schema: applicationSchemaId("com.example.record012"), data: Uint8Array.of(0xff) }], public: [] } }],
      ["burn", { assetId: 0x55n, amount: 5n, retryContentHash: TX_HASH, submission, onPrepared: expect.any(Function) }],
    ]);

    for (const [path, body] of [
      ["/assets/send", { assetId: "0", outputs: [{ to: "code", amount: "3" }] }],
      ["/assets/send", { assetId: "0x55", outputs: [] }],
      ["/assets/send", { assetId: "0x55", outputs: [{ to: "code", amount: "0" }] }],
      ["/assets/send", { assetId: "0x55", outputs: [{ amount: "3" }] }],
      ["/assets/send", { assetId: "0x55", outputs: [{ to: "code", amount: "3" }], retryContentHash: "0x12" }],
      ...[
        { schema: "0x05", data: "0x01" },
        { schema: "not-namespaced", data: "0x01" },
        { schema: applicationSchemaId("com.example.record007"), data: 5 },
        { schema: applicationSchemaId("com.example.record007"), data: "0x123" },
        { type: "7", data: "0x01" },
      ].map((record) => ["/assets/send", { assetId: "0x55", outputs: [{ to: "code", amount: "3" }], data: { self: [record] } }] as const),
      ["/assets/send", { assetId: "0x55", outputs: [{ to: "code", amount: "3" }], data: { self: [{ schema: applicationSchemaId("com.example.record008"), data: "0x01" }, { schema: applicationSchemaId("com.example.record008"), data: "0x02" }] } }],
      ["/assets/send", { assetId: "0x55", outputs: [{ to: "code", amount: "3" }], data: { self: { schema: applicationSchemaId("com.example.record007"), data: "0x01" } } }],
      ["/assets/burn", { assetId: "0x55", amount: "0" }],
      ["/assets/burn", { amount: "1" }],
    ] as const) expect((await post(path, body)).status).toBe(400);
    expect(calls).toHaveLength(2);
  });

  it("imports a verified definition and rejects garbage before wallet access", async () => {
    const testContext = context();
    const imported: unknown[] = [];
    testContext.runtimeFor = () => ({
      importAssetDefinition: async (value: AssetDefinition) => { imported.push(value); return { assetId: assetDefinitionAssetId(value) }; },
    }) as never;
    const url = await serve(testContext);
    const post = (body: unknown) => fetch(`${url}/assets/import`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const response = await post({ definition: `https://pcash.example/token/x#d=${formatAssetDefinition(definition)}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ assetId: bytes32Hex(assetId) });
    expect(imported).toEqual([definition]);
    for (const body of [{ definition: "not-a-definition" }, { definition: 5 }, {}]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(imported).toHaveLength(1);
  });

  it("passes an approved fee through CLI and HTTP and accepts no destination commitment", async () => {
    const testContext = context();
    let intent: Record<string, unknown> | undefined;
    testContext.node = { status: async () => ({ latestBlock: 0n, latestBlockHash: "0x0", index: { status: "ready", cursor: { blockNumber: 0n, blockHash: "0x0" } } }) as never };
    testContext.runtimeFor = () => ({
      address: "0x1", snapshot: async () => ({ address: "0x1", syncedThrough: null }),
      send: async (value: Record<string, unknown>) => {
        intent = value;
        return { contentHash: "0xtx", queued: true, output: { path: "mempool" } };
      },
    }) as never;
    testContext.submissionFor = () => ({}) as never;
    const url = await serve(testContext);
    const client = new WalletHttpClient(url);

    await client.dispatch(parseCli(["send", "--to", "0x1", "--amount", "4", "--fee", "2"]));
    expect(intent).toMatchObject({ to: "0x1", amount: 4n, openFeeAmount: 2n });
    expect(intent).not.toHaveProperty("memo");
    expect(intent).not.toHaveProperty("includeSender");

    await client.dispatch(parseCli(["send", "--to", "0x1", "--amount", "4", "--memo", "rent — March", "--include-sender"]));
    expect(intent).toMatchObject({ to: "0x1", amount: 4n, data: { recipients: [{ to: "0x1", records: [memoSchema.encode("rent — March"), claimedSenderSchema.encode(1n)] }] } });
    await fetch(`${url}/transfer`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "0x1", amount: "4", data: { self: [{ schema: applicationSchemaId("com.example.record007"), data: "0xabcd" }] } }) });
    expect(intent).toMatchObject({ to: "0x1", amount: 4n, data: { self: [{ schema: applicationSchemaId("com.example.record007"), data: Uint8Array.of(0xab, 0xcd) }] } });
    await fetch(`${url}/transfer`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "0x1", amount: "0", data: { public: [{ schema: applicationSchemaId("com.example.post"), data: "0x6869" }] } }) });
    expect(intent).toMatchObject({ data: { public: [{ schema: applicationSchemaId("com.example.post"), data: Uint8Array.of(0x68, 0x69) }] } });
    for (const [field, value, error] of [
      ["data", 5, "data audiences and records must be objects"],
      ["data", { recipients: "yes" }, "data.recipients must be an array"],
      ["data", { self: [{ schema: "0x05", data: "0x01" }] }, "record 0x05 is managed by the SDK"],
      ["data", { public: [{ schema: "0x01", data: "0x01" }] }, "public records must be application records, not 0x01"],
    ] as const) {
      intent = undefined;
      const rejected = await fetch(`${url}/transfer`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "0x1", amount: "4", [field]: value }) });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ error });
      expect(intent).toBeUndefined();
    }

    await fetch(`${url}/transfer`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "0x1", amount: "4", feeOwnerCommitment: "3", issuanceOwnerCommitment: "3" }) });
    expect(intent).not.toHaveProperty("feeOwnerCommitment");
    expect(intent).not.toHaveProperty("issuanceOwnerCommitment");
    expect(intent).not.toHaveProperty("openFeeAmount");
  });

  it("accepts a zero transfer amount and rejects one that is not a nonnegative decimal", async () => {
    const testContext = context();
    let intent: Record<string, unknown> | undefined;
    testContext.node = { status: async () => ({ latestBlock: 0n, latestBlockHash: "0x0", index: { status: "ready", cursor: { blockNumber: 0n, blockHash: "0x0" } } }) as never };
    testContext.runtimeFor = () => ({
      send: async (value: Record<string, unknown>) => {
        intent = value;
        return { contentHash: "0xtx", queued: true, output: { path: "mempool" } };
      },
    }) as never;
    testContext.submissionFor = () => ({}) as never;
    const url = await serve(testContext);

    await new WalletHttpClient(url).dispatch(parseCli(["send", "--to", "0x1", "--amount", "0", "--fee", "0"]));
    expect(intent).toMatchObject({ to: "0x1", amount: 0n, openFeeAmount: 0n });

    const rejected = await fetch(`${url}/transfer`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "0x1", amount: "-1" }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: "transfer requires to and a nonnegative decimal-string amount",
    });
  });

  it("defaults signed registration to L1 while updates and transfers use the mempool", async () => {
    const testContext = context();
    const intents: Record<string, any>[] = [];
    const built: Record<string, unknown>[] = [];
    testContext.runtimeFor = () => ({
      updateAccount: async (intent: Record<string, unknown>) => { intents.push(intent); return { contentHash: "0xtx", queued: true, output: {} }; },
      send: async (intent: Record<string, unknown>) => { intents.push(intent); return { contentHash: "0xtx", queued: true, output: {} }; },
    }) as never;
    testContext.submissionFor = (body) => {
      built.push(body);
      return { mode: body.submit ?? "mempool", preflight: async () => "prepared", submit: async () => { throw new Error("not submitted"); } } as never;
    };
    const url = await serve(testContext);

    expect((await executeCli(["account", "ensure", "--wallet-url", url])).code).toBe(0);
    const defaulted = intents.at(-1)!;
    expect(defaulted.submission.mode).toBe("mempool");
    expect(defaulted.userAccountCreationSubmission.mode).toBe("l1");
    // The L1 transport remains lazy so account updates need no Ethereum RPC.
    expect(built.some((body) => body.submit === "l1")).toBe(false);
    await defaulted.userAccountCreationSubmission.preflight({ entry: new Uint8Array(), contentHash: "0x", status: {}, retry: false });
    expect(built.some((body) => body.submit === "l1")).toBe(true);

    expect((await executeCli(["account", "ensure", "--submit", "mempool", "--wallet-url", url])).code).toBe(0);
    expect(intents.at(-1)!.userAccountCreationSubmission.mode).toBe("mempool");
    expect((await executeCli(["send", "--to", "0x1", "--amount", "4", "--wallet-url", url])).code).toBe(0);
    expect(intents.at(-1)!.submission.mode).toBe("mempool");
    expect(intents.at(-1)).not.toHaveProperty("userAccountCreationSubmission");
  });

  it("honors the user's explicit registration transport choice", async () => {
    const testContext = context();
    const intents: Record<string, any>[] = [];
    testContext.runtimeFor = () => ({
      updateAccount: async (intent: Record<string, unknown>) => { intents.push(intent); return {}; },
    }) as never;
    testContext.submissionFor = (body) => ({ mode: body.submit ?? "mempool" }) as never;
    const url = await serve(testContext);
    expect((await executeCli(["account", "ensure", "--wallet-url", url])).code).toBe(0);
    expect(intents.at(-1)!.userAccountCreationSubmission.mode).toBe("l1");
    expect(intents.at(-1)!.submission.mode).toBe("mempool");
    expect((await executeCli(["account", "ensure", "--submit", "mempool", "--wallet-url", url])).code).toBe(0);
    expect(intents.at(-1)!.userAccountCreationSubmission.mode).toBe("mempool");
    expect((await executeCli(["account", "ensure", "--submit", "l1", "--wallet-url", url])).code).toBe(0);
    expect(intents.at(-1)!.userAccountCreationSubmission.mode).toBe("l1");
  });

  it("returns 400 for a relayed zero-fee account operation and the CLI prints its message", async () => {
    const testContext = context();
    const node = { estimateFee: async () => { throw new Error("no estimate"); } };
    testContext.runtimeFor = () => ({
      updateAccount: async (intent: { openFeeAmount?: bigint }) => planPublication({
        qualifying: false, byteSize: 1n, openFeeAmount: intent.openFeeAmount, publication: "open", node,
      }),
    }) as never;
    testContext.submissionFor = () => ({ mode: "mempool" }) as never;
    const url = await serve(testContext);
    const message = "a relayed account operation with a zero fee pays no publisher; pass a positive fee or publish it yourself";

    const response = await fetch(`${url}/account`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ openFeeAmount: "0", submit: "mempool" }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });

    const cli = await executeCli(["account", "ensure", "--fee", "0", "--submit", "mempool", "--wallet-url", url]);
    expect(cli.code).toBe(1);
    expect(cli.stdout).toBe("");
    expect(cli.stderr).toBe(`pcash-wallet-cli: ${message}\n`);
  });

  it("passes a selected quote session and private fee to proof-bearing wallet actions", async () => {
    const testContext = context();
    const intents: Array<Record<string, any>> = [];
    const quoteProvider = { recipient: 0x123n, requestQuote: async () => { throw new Error("quote is not requested by this boundary test"); } };
    testContext.selectedRelayQuote = quoteProvider;
    testContext.submissionFor = () => ({ mode: "mempool" }) as never;
    testContext.runtimeFor = () => ({
      send: async (intent: Record<string, unknown>) => { intents.push(intent); return { contentHash: "0xtx", queued: true }; },
      updateAccount: async (intent: Record<string, unknown>) => { intents.push(intent); return { contentHash: "0xtx", queued: true }; },
      createAsset: async (intent: Record<string, unknown>) => { intents.push(intent); return { contentHash: "0xtx", queued: true, assetId, definition }; },
    }) as never;
    const url = await serve(testContext);
    const client = new WalletHttpClient(url);
    await client.dispatch(parseCli(["send", "--to", "0x1", "--amount", "4", "--submit", "selected", "--private-relay-fee", "2"]));
    await client.dispatch(parseCli(["account", "ensure", "--submit", "selected", "--private-relay-fee", "3"]));
    await client.dispatch(parseCli(["asset", "create", "--name", "Asset", "--symbol", "AST", "--supply", "1", "--content-digest", DIGEST, "--submit", "selected", "--private-relay-fee", "4"]));
    expect(intents.map((intent) => [intent.submission.mode, intent.privateRelayFeeAmount, intent.selectedRelayQuote])).toEqual([
      ["mempool", 2n, quoteProvider], ["mempool", 3n, quoteProvider], ["mempool", 4n, quoteProvider],
    ]);
    expect(intents[1]!.userAccountCreationSubmission.mode).toBe("mempool");
    await expect(intents[1]!.userAccountCreationSubmission.preflight()).rejects.toThrow(/proof-free account creation cannot pay a selected relayer/);

    const missingFee = await fetch(`${url}/transfer`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "0x1", amount: "4", submit: "selected" }) });
    expect(missingFee.status).toBe(400);
    expect(await missingFee.json()).toEqual({ error: "selected submission requires a positive privateRelayFeeAmount and configured quote session" });

    const unconfigured = context();
    unconfigured.submissionFor = () => ({ mode: "mempool" }) as never;
    unconfigured.runtimeFor = () => ({ send: async () => { throw new Error("must reject before wallet action"); } }) as never;
    const unconfiguredUrl = await serve(unconfigured);
    const missingSession = await fetch(`${unconfiguredUrl}/transfer`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "0x1", amount: "4", submit: "selected", privateRelayFeeAmount: "2" }) });
    expect(missingSession.status).toBe(400);
    expect(await missingSession.json()).toEqual({ error: "selected submission requires a positive privateRelayFeeAmount and configured quote session" });
  });

  it("drains proof-sized CLI JSON before exiting", async () => {
    const transactionHex = `0x${"11".repeat(40_000)}`;
    const testContext = context();
    testContext.runtimeFor = () => ({
      updateAccount: async () => ({
        contentHash: "0xtx",
        accepted: true,
        queued: false,
        output: { path: "l1", transactionHex },
      }),
    }) as never;
    testContext.submissionFor = () => ({}) as never;
    const url = await serve(testContext);

    const result = await executeCli(["account", "ensure", "--wallet-url", url, "--json"]);

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(65_536);
    expect(JSON.parse(result.stdout)).toMatchObject({ submit: { transactionHex } });
  });

  it("returns recovered notes from a scan", async () => {
    const testContext = context();
      const result = {
        startedAtOutputIndex: 0n,
        scanned: 3,
        trialDecryptAttempts: 5,
        decrypted: 1,
        recovered: [{
          chainId: 1n,
          leafIndex: 2n,
          outputIndex: 1,
          assetId: 3n,
          owner: 4n,
          noteSecret: 0x777n,
          amount: 7n,
          noteBodyCommitment: 5n,
          outputCommitment: 6n,
          memo: new TextEncoder().encode("private memo"),
        }],
        syncedThrough: { pcashNumber: 2n, pcashHash: "0xabc" },
        nextOutputIndex: 3n,
      } as never;
    testContext.runtimeFor = () => ({
      snapshot: async () => ({
        address: "0xabc",
        syncedThrough: null,
        finalizedThrough: null,
        ownedNoteCount: 1,
        balances: [{ assetId: 0n, private: 7n, spendable: 7n }],
        receiveKeys: [],
      }),
    }) as never;
    testContext.sync = async () => result;
    const url = await serve(testContext);

    const response = await fetch(`${url}/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { recovered: Array<Record<string, unknown>> };
    expect(body).toMatchObject({
      trialDecryptAttempts: 5,
      recoveredCount: 1,
      recovered: [{
        leafIndex: "2",
        outputIndex: 1,
        assetId: "0x3",
        amount: "7",
        outputCommitment: "0x6",
      }],
      outputRange: { from: "0", to: "3" },
    });
    expect(JSON.stringify(body)).not.toContain("private memo");
    expect(body.recovered[0]).not.toHaveProperty("noteSecret");
    expect(body.recovered[0]).not.toHaveProperty("memo");
    expect(body.recovered[0]).not.toHaveProperty("owner");
    expect(body.recovered[0]).not.toHaveProperty("noteBodyCommitment");
  });

  it("awaits initial sync and leaves continuous following to Wallet", async () => {
    const testContext = context();
    testContext.runtimeFor = () => ({
      snapshot: async () => ({
        address: "0xabc",
        syncedThrough: null,
        finalizedThrough: null,
        ownedNoteCount: 0,
        balances: [],
        receiveKeys: [],
      }),
    }) as never;
    testContext.sync = async () => ({
      startedAtOutputIndex: 0n,
      scanned: 0,
      trialDecryptAttempts: 0,
      decrypted: 0,
      recovered: [],
      syncedThrough: { pcashNumber: 0n, pcashHash: "0xabc" },
      nextOutputIndex: 0n,
    }) as never;
    const url = await serve(testContext);

    const started = await fetch(`${url}/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ recoveredCount: 0 });
  });

  it("queues POST /scan behind an in-flight follower scan and catches up again", async () => {
    const chainId = 8191;
    const inboxAddress = `0x${"22".repeat(20)}`;
    const sim = new ChainSim(BigInt(chainId), { l1ChainId: 11155111n, inboxAddress });
    sim.finalityLag = 100n;
    const genesisHash = sim.genesisHash;
    const followerScanStarted = deferred<void>();
    const releaseFollowerScan = deferred<void>();
    const served = sim.client();
    const node = {
      ...served,
      getOutputs: async (request: Parameters<PcashNodeClient["getOutputs"]>[0]) => {
        if (request.target.pcashNumber === 1n) {
          followerScanStarted.resolve();
          await releaseFollowerScan.promise;
        }
        return served.getOutputs(request);
      },
    } as unknown as PcashNodeClient;
    const profile = derivePcashProfileFromPrivateKey(TEST_PRIV_KEY, {
      pcashChainId: BigInt(chainId),
      l1ChainId: 11155111n,
      inboxAddress,
    });
    const database = await PGliteWalletDatabase.open(await PGlite.create("memory://"), { ownsClient: true });
    const identity = { address: profile.address, network: { chainId: BigInt(chainId), genesisHash } };
    const data = emptyWalletState(identity);
    data.syncedThrough = { blockNumber: "0", blockHash: genesisHash };
    data.finalizedThrough = data.syncedThrough;
    await database[WALLET_DATABASE_STATE_STORE](identity).save(data);
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database, node, profile });
    const following = deferred<void>();
    // The follower has caught up and is watching the tip.
    const unsubscribe = wallet.on("sync:tip", () => following.resolve());
    wallet.startSync({ intervalMs: 1 });
    await following.promise;

    sim.addBlock();
    await followerScanStarted.promise;
    sim.addBlock();
    const head = fieldToHex(sim.head.hash).toLowerCase();
    const endpointSyncStarted = deferred<void>();
    const testContext = context();
    testContext.node = node;
    testContext.runtimeFor = () => wallet;
    testContext.sync = (_account, full) => {
      endpointSyncStarted.resolve();
      return wallet.sync(full ? { rescan: true } : {});
    };
    const url = await serve(testContext);
    const responsePromise = fetch(`${url}/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    await endpointSyncStarted.promise;
    releaseFollowerScan.resolve();

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      syncedThrough: { pcashNumber: "2", pcashHash: head },
      outputRange: { from: "0", to: "0" },
      wallet: { syncedThrough: { pcashNumber: "2", pcashHash: head } },
    });
    await unsubscribe();
    await wallet.close();
    await database.close();
  });

  it("reads the status overview from one snapshot without synchronizing", async () => {
    const testContext = context();
    let reads = 0;
    const hash = `0x${"44".repeat(32)}`;
    testContext.node.status = async () => ({ latestBlock: 7n, latestBlockHash: hash,
      index: { status: "ready", cursor: { blockNumber: 7n, blockHash: hash } } }) as never;
    testContext.runtimeFor = () => ({
      snapshot: async () => {
        reads++;
        return { address: "0xabc", network: { chainId: 42n, genesisHash: "0xgenesis" },
          syncedThrough: { pcashNumber: 7n, pcashHash: hash },
          finalizedThrough: { pcashNumber: 6n, pcashHash: "0xfinal" },
          balances: [{ assetId: 0n, private: 100n, spendable: 80n }], pendingActionCount: 2 };
      },
      sync: () => { throw new Error("status must not synchronize"); },
    }) as never;
    const url = await serve(testContext);
    const result = await executeCli(["status", "--wallet-url", url, "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      address: "0xabc", network: { chainId: "42", genesisHash: "0xgenesis" },
      finalizedThrough: { pcashNumber: "6", pcashHash: "0xfinal" },
      balances: [{ assetId: "0", private: "100", spendable: "80" }], pendingActionCount: 2,
      scan: { syncedThrough: { pcashNumber: "7", pcashHash: hash }, nodeTip: { pcashNumber: "7", pcashHash: hash }, caughtUp: true },
    });
    expect(reads).toBe(1);
    const human = await executeCli(["status", "--wallet-url", url]);
    expect(human.stdout).toContain("PCASH chain: 42");
    expect(human.stdout).toContain("Pending actions: 2");
    expect(human.stdout).toContain("Spendable (atomic units)");
    expect(human.stderr).toBe("");
  });

  it("reports durable sync status without service-owned scan jobs", async () => {
    const testContext = context();
    const hash = `0x${"44".repeat(32)}`;
    testContext.node.status = async () => ({
      latestBlock: 1n, latestBlockHash: hash, index: { status: "ready", cursor: { blockNumber: 1n, blockHash: hash } },
    }) as never;
    testContext.runtimeFor = () => ({
      address: "0xabc",
      snapshot: async () => ({ syncedThrough: null }),
    }) as never;
    const url = await serve(testContext);

    const status = await (await fetch(`${url}/status`)).json() as Record<string, any>;
    expect(status.scan).not.toHaveProperty("job");
    expect(status.scan.caughtUp).toBe(false);
  });

  it("reports a wallet as caught up at the index cursor while the canonical tip is ahead", async () => {
    const testContext = context();
    const synced = `0x${"44".repeat(32)}`;
    const tip = `0x${"55".repeat(32)}`;
    testContext.node.status = async () => ({
      latestBlock: 5n, latestBlockHash: tip, index: { status: "ready", cursor: { blockNumber: 4n, blockHash: synced } },
    }) as never;
    testContext.runtimeFor = () => ({
      address: "0xabc",
      snapshot: async () => ({ syncedThrough: { pcashNumber: 4n, pcashHash: synced } }),
    }) as never;
    const url = await serve(testContext);

    const status = await (await fetch(`${url}/status`)).json() as Record<string, any>;
    // The index serves outputs only through its cursor, so there is nothing more to scan.
    expect(status.scan).toEqual({
      syncedThrough: { pcashNumber: "4", pcashHash: synced },
      nodeTip: { pcashNumber: "5", pcashHash: tip },
      caughtUp: true,
    });
  });

  it("routes every GET command correctly with multiple wallets loaded", async () => {
    const accountA = `0x${"11".repeat(20)}`;
    const accountB = `0x${"22".repeat(20)}`;
    const syncedHash = `0x${"44".repeat(32)}`;
    const tipHash = `0x${"55".repeat(32)}`;
    const requests: string[] = [];
    const runtimeFor: WalletHttpContext["runtimeFor"] = (wallet?: string) => {
      if (wallet === undefined) throw new Error("multiple wallets loaded; pass --wallet");
      if (wallet !== accountA && wallet !== accountB) throw new Error(`unknown wallet ${wallet}`);
      return {
        address: wallet,
        snapshot: async () => ({
          address: wallet,
          syncedThrough: { pcashNumber: 4n, pcashHash: syncedHash },
        }),
        receiveCode: async () => ({ address: wallet, extendedCode: `code:${wallet}` }),
      } as never;
    };
    const testContext = context();
    testContext.node.status = async () => ({
      latestBlock: 5n, latestBlockHash: tipHash, index: { status: "ready", cursor: { blockNumber: 5n, blockHash: tipHash } },
    }) as never;
    testContext.runtimeFor = runtimeFor;
    testContext.listWallets = () => [{ address: accountA }, { address: accountB }];
    testContext.listReceiveKeys = (wallet) => ({
      address: runtimeFor(wallet).address,
      receiveKeys: ["0xreceive"],
    });
    const url = await serve(testContext, requests);
    const client = new WalletHttpClient(url);

    const status = await client.dispatch(parseCli(["status", "--wallet", accountB]));
    const code = await client.dispatch(parseCli(["receive", "--wallet", accountB]));
    const wallets = await client.dispatch(parseCli(["wallet", "list"]));
    const receiveKeys = await client.dispatch(parseCli(["receive-key", "list", "--wallet", accountB]));

    expect(status).toEqual({
      address: accountB,
      scan: {
        syncedThrough: { pcashNumber: "4", pcashHash: syncedHash },
        nodeTip: { pcashNumber: "5", pcashHash: tipHash },
        caughtUp: false,
      },
    });
    expect(code).toEqual({ address: accountB, extendedCode: `code:${accountB}` });
    expect(wallets).toEqual([{ address: accountA }, { address: accountB }]);
    expect(receiveKeys).toEqual({ address: accountB, receiveKeys: ["0xreceive"] });
    expect(requests).toEqual([
      `/status?wallet=${accountB}`,
      `/code?wallet=${accountB}`,
      "/wallets",
      `/receive-keys?wallet=${accountB}`,
    ]);
  });
});
