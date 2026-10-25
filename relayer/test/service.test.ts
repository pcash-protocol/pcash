import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRelayerArgs } from "../src/args.ts";
import {
  DEV_ANVIL_RELAYER_PRIVATE_KEY,
  resolveRelayerPrivateKey,
  runRelayerCli,
} from "../src/run.ts";
import { serveRelayer } from "../src/service.ts";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import { DEFAULT_NETWORK_CONFIG } from "@pcash/sdk/protocol";
import { fromHexSized } from "@pcash/sdk/utils";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import { Logger } from "@pcash/sdk/blgr";
import { PcashNodeClient } from "@pcash/sdk/clients";
import { Relayer, RelayFeeCeilingError, RelayJournalConflictError } from "@pcash/sdk/relay";
import { HttpRequestError } from "viem";

// Never opened, so the service's own log lines stay out of test output.
const logger = new Logger().context("relayer");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test listener has no port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  let value: T;
  do {
    try {
      value = await read();
      if (accept(value)) return value;
    } catch { /* listener may not be ready yet */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error("condition was not reached");
}

const status = {
  l1ChainId: 11_155_111n,
  inboxAddress: `0x${"22".repeat(20)}`,
};
const idleResult = {
  status,
  automatic: true,
  requested: [],
  maxBlobs: 6,
  maxBatchBytes: 761_825n,
  considered: 0,
  batch: "0x010000",
  selectedContentHashes: [],
  rejected: [],
  collectibleOpenFee: 0n,
  collectiblePrivateFee: 0n,
  collectibleQualifyingActions: 0n,
  selectedQualifyingActions: 0n,
  valuation: null,
  batchBytes: 3n,
  headCheckedBlock: 1n,
  headCheckedBlockHash: `0x${"33".repeat(32)}`,
  submitted: false,
  carrier: null,
  quotes: null,
};

afterEach(() => vi.restoreAllMocks());

describe("relayer service", () => {
  it("defaults development mode to Anvil account 1 without overriding an explicit key", () => {
    expect(resolveRelayerPrivateKey(undefined, true)).toBe(DEV_ANVIL_RELAYER_PRIVATE_KEY);
    expect(resolveRelayerPrivateKey(`0x${"ab".repeat(32)}`, true))
      .toBe(`0x${"ab".repeat(32)}`);
    expect(() => resolveRelayerPrivateKey(undefined, false)).toThrow(/set PCASH_RELAYER_L1_KEY/);
  });

  it("uses a process-local journal in development mode", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(runRelayerCli(["journal", "show", "--dev"], {})).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith("[]\n");
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("RELAYER DEVELOPMENT MODE IS ON"));
  });

  it("reports configuration errors before attempting network access", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(runRelayerCli(["relay"], {
      PCASH_L1_KEY: `0x${"ab".repeat(32)}`,
    })).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("no relayer signing key"));
  });

  it("serves credential-safe health, status, and OpenMetrics while cycling serially", async () => {
    const port = await freePort();
    const options = parseRelayerArgs([
      "--rpc-url", "https://node.example/v1/SECRET",
      "--l1-rpc", "https://user:SECRET@l1.example/v2",
      "serve", "--poll-interval-ms", "60000", "--http-addr", `127.0.0.1:${port}`,
    ], {});
    let active = 0;
    const relay = {
      relay: vi.fn(async () => {
        active += 1;
        expect(active).toBe(1);
        active -= 1;
        return idleResult;
      }),
    };
    const submitter = { address: `0x${"11".repeat(20)}`, balance: vi.fn(async () => 5n) };
    const journal = { path: options.journalPath, read: vi.fn(async () => []) };
    const running = serveRelayer({
      options,
      logger,
      relayer: relay as never,
      submitter: submitter as never,
      journal: journal as never,
    });

    const snapshot = await eventually<any>(
      async () => fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json()),
      (value: any) => value.state === "idle",
    );
    expect(snapshot).toMatchObject({
      state: "idle",
      l1ChainId: 11_155_111,
      inboxAddress: status.inboxAddress,
      nodeOrigin: "https://node.example",
      l1Origin: "https://l1.example",
    });
    expect(JSON.stringify(snapshot)).not.toContain("SECRET");
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(metrics.headers.get("content-type")).toContain("application/openmetrics-text");
    expect(await metrics.text()).toContain("pcash_relayer_up 1");

    process.emit("SIGTERM", "SIGTERM");
    await expect(running).resolves.toBeUndefined();
  });

  it("reports valuation policy and a submitted batch's fee and expected issuance", async () => {
    const port = await freePort();
    const options = parseRelayerArgs([
      "--min-value-per-byte", "2", "--sponsor-unpaid", "--issuance-haircut-bps", "2500",
      "serve", "--poll-interval-ms", "60000", "--http-addr", `127.0.0.1:${port}`,
    ], {});
    const whole = 10n ** 18n;
    const relayed = {
      ...idleResult,
      selectedContentHashes: [`0x${"55".repeat(32)}`],
      collectibleOpenFee: 2n * whole,
      collectiblePrivateFee: whole,
      collectibleQualifyingActions: 3n,
      selectedQualifyingActions: 4n,
      valuation: { otherQualifyingActions: 1n, rewardEach: whole, expectedIssuance: 3n * whole, discountedExpectedIssuance: 9n * whole / 4n },
      submitted: true,
      carrier: "calldata",
      txHash: `0x${"66".repeat(32)}`,
      receipt: { status: 1, blockNumber: 9n, blockHash: `0x${"77".repeat(32)}`, transactionIndex: 0, gasUsed: 21_000n },
    };
    const running = serveRelayer({
      options,
      logger,
      relayer: { relay: vi.fn(async () => relayed) } as never,
      submitter: { address: `0x${"11".repeat(20)}`, balance: vi.fn(async () => 5n) } as never,
      journal: { read: vi.fn(async () => []) } as never,
    });

    const snapshot = await eventually<any>(
      async () => fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json()),
      (value: any) => value.cycles.relayed === 1,
    );
    expect(snapshot.policy).toMatchObject({ minValuePerByte: "2", sponsorUnpaid: true, issuanceHaircutBps: 2500 });
    expect(snapshot.lastCycle).toMatchObject({
      collectibleOpenFee: (2n * whole).toString(),
      collectiblePrivateFee: whole.toString(),
      collectibleQualifyingActions: 3,
      selectedQualifyingActions: 4,
      expectedIssuance: (3n * whole).toString(),
      discountedExpectedIssuance: (9n * whole / 4n).toString(),
    });
    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`).then((response) => response.text());
    expect(metrics).toMatch(/^pcash_relayer_collectible_open_fee_total 2$/m);
    expect(metrics).toMatch(/^pcash_relayer_collectible_private_fee_total 1$/m);
    expect(metrics).toMatch(/^pcash_relayer_expected_issuance_total 3$/m);

    process.emit("SIGTERM", "SIGTERM");
    await expect(running).resolves.toBeUndefined();
  });

  it("keeps signal handlers installed until an in-flight cycle finishes", async () => {
    const port = await freePort();
    const options = parseRelayerArgs([
      "serve", "--poll-interval-ms", "60000", "--http-addr", `127.0.0.1:${port}`,
    ], {});
    const initialSigintListeners = process.listenerCount("SIGINT");
    const initialSigtermListeners = process.listenerCount("SIGTERM");
    let finish!: (result: typeof idleResult) => void;
    const pending = new Promise<typeof idleResult>((resolve) => { finish = resolve; });
    const relay = vi.fn(() => pending);
    const running = serveRelayer({
      options,
      logger,
      relayer: { relay } as never,
      submitter: { address: `0x${"11".repeat(20)}`, balance: vi.fn(async () => 5n) } as never,
      journal: { read: vi.fn(async () => []) } as never,
    });

    await eventually(async () => relay.mock.calls.length, (calls) => calls === 1);
    process.emit("SIGINT", "SIGINT");
    process.emit("SIGINT", "SIGINT");
    process.emit("SIGTERM", "SIGTERM");
    process.emit("SIGTERM", "SIGTERM");
    expect(process.listenerCount("SIGINT")).toBe(initialSigintListeners + 1);
    expect(process.listenerCount("SIGTERM")).toBe(initialSigtermListeners + 1);

    finish(idleResult);
    await expect(running).resolves.toBeUndefined();
    expect(process.listenerCount("SIGINT")).toBe(initialSigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(initialSigtermListeners);
  });

  it("clears status and metrics when a balance refresh fails", async () => {
    const port = await freePort();
    const options = parseRelayerArgs([
      "serve", "--poll-interval-ms", "1", "--http-addr", `127.0.0.1:${port}`,
    ], {});
    const balance = vi.fn()
      .mockResolvedValueOnce(5n)
      .mockRejectedValue(new Error("balance unavailable"));
    let finishSecond!: (result: typeof idleResult) => void;
    let finishLater!: (result: typeof idleResult) => void;
    const second = new Promise<typeof idleResult>((resolve) => { finishSecond = resolve; });
    const later = new Promise<typeof idleResult>((resolve) => { finishLater = resolve; });
    const relay = vi.fn()
      .mockResolvedValueOnce(idleResult)
      .mockImplementationOnce(() => second)
      .mockImplementation(() => later);
    const running = serveRelayer({
      options,
      logger,
      relayer: { relay } as never,
      submitter: { address: `0x${"11".repeat(20)}`, balance } as never,
      journal: { read: vi.fn(async () => []) } as never,
    });
    const statusUrl = `http://127.0.0.1:${port}/status`;

    await eventually(
      () => fetch(statusUrl).then((response) => response.json()),
      (value: any) => value.l1BalanceWei === "5",
    );
    finishSecond(idleResult);
    const snapshot = await eventually<any>(
      () => fetch(statusUrl).then((response) => response.json()),
      (value: any) => value.cycles.total >= 2 && value.l1BalanceWei === null,
    );
    expect(snapshot.l1BalanceWei).toBeNull();
    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`).then((response) => response.text());
    expect(metrics).toMatch(/^pcash_relayer_l1_balance_ether Nan$/m);

    process.emit("SIGTERM", "SIGTERM");
    finishLater(idleResult);
    await expect(running).resolves.toBeUndefined();
  });

  it("stops with operator HTTP available after a hashless latched failure", async () => {
    const port = await freePort();
    const options = parseRelayerArgs([
      "serve", "--poll-interval-ms", "60000", "--http-addr", `127.0.0.1:${port}`,
    ], {});
    const failure = new Error("relay outcome is ambiguous");
    const selectedKey = fromHexSized(`0x${"01".repeat(32)}`, 32);
    const running = serveRelayer({
      options,
      logger,
      relayer: { relay: vi.fn(async () => { throw failure; }) } as never,
      submitter: { address: `0x${"11".repeat(20)}` } as never,
      journal: { read: vi.fn(async () => [{ transactionHash: null }]) } as never,
      selected: { node: { status: vi.fn() } as never,
        profile: derivePcashProfileFromPrivateKey(selectedKey, DEFAULT_NETWORK_CONFIG),
        signer: privateKeyPcashActionSigner(selectedKey), minPrivateFee: 1n,
        minValuePerByte: 0n, maxQuoteLifetimeSeconds: 3_600n },
    });

    const health = await eventually(
      () => fetch(`http://127.0.0.1:${port}/health`),
      (response) => response.status === 503,
    );
    expect(await health.text()).toBe("stopped\n");
    for (const [path, init] of [["/selected/info", undefined],
      ["/selected/quote", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }]] as const) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
      expect(response.status).toBe(503);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }
    await expect(fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json()))
      .resolves.toMatchObject({
        state: "stopped",
        journalLatched: true,
        stopped: { message: failure.message, transactionHash: null },
      });

    process.emit("SIGTERM", "SIGTERM");
    await expect(running).rejects.toThrow(failure.message);
  });

  it("keeps cycling through a latched failure that names its transaction", async () => {
    const port = await freePort();
    const options = parseRelayerArgs([
      "serve", "--poll-interval-ms", "10", "--http-addr", `127.0.0.1:${port}`,
    ], {});
    const transactionHash = `0x${"44".repeat(32)}`;
    // The carrier is mined but the node has not derived its block yet: the
    // submitter refuses to post again until it has, and the service must keep
    // polling rather than stop, so the latch settles on its own.
    let latched = true;
    const running = serveRelayer({
      options,
      logger,
      relayer: { relay: vi.fn(async () => {
        if (latched) throw new Error("relay journal is unobserved");
        return idleResult;
      }) } as never,
      submitter: { address: `0x${"11".repeat(20)}`, balance: async () => 10n ** 18n } as never,
      journal: { read: vi.fn(async () => (latched ? [{ transactionHash }] : [])) } as never,
    });
    const snapshot = () => fetch(`http://127.0.0.1:${port}/status`)
      .then((response) => response.json() as Promise<Record<string, unknown>>);

    const failing = await eventually(snapshot, (value) => (value.cycles as { failed: number }).failed >= 2);
    expect(failing).toMatchObject({ journalLatched: true, stopped: null });
    expect((failing.lastCycle as { outcome: string; l1TransactionHash: string }))
      .toMatchObject({ outcome: "failed", l1TransactionHash: transactionHash, collectiblePrivateFee: "0" });

    latched = false;
    const recovered = await eventually(snapshot, (value) => (value.cycles as { idle: number }).idle >= 1);
    expect(recovered).toMatchObject({ journalLatched: false, stopped: null });
    expect(recovered.lastCycle).toMatchObject({ outcome: "idle", collectiblePrivateFee: "0" });
    expect(Object.keys(failing.lastCycle as object).sort())
      .toEqual(Object.keys(recovered.lastCycle as object).sort());

    process.emit("SIGTERM", "SIGTERM");
    await expect(running).resolves.toBeUndefined();
  });

  it.each(["mined", "repriced"])("reports unhealthy at the fee ceiling and recovers when %s", async (recovered) => {
    const port = await freePort();
    const options = parseRelayerArgs([
      "serve", "--poll-interval-ms", "10", "--http-addr", `127.0.0.1:${port}`,
    ], {});
    const transactionHash = `0x${"44".repeat(32)}`;
    let state = "capped";
    const relay = vi.fn(async () => {
      if (state === "capped") throw new RelayFeeCeilingError(transactionHash, transactionHash, 13n);
      if (state === "rpc-error") throw new Error("RPC unavailable");
      if (state === "repriced") throw new RelayJournalConflictError("relay journal is pending");
      return idleResult;
    });
    const running = serveRelayer({
      options, logger, relayer: { relay } as never,
      submitter: { address: `0x${"11".repeat(20)}`, balance: async () => 10n ** 18n } as never,
      journal: { read: async () => state === "mined" ? [] : [{ transactionHash }] } as never,
    });
    try {
      const health = () => fetch(`http://127.0.0.1:${port}/health`);
      const snapshot = () => fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json());
      const unhealthy = await eventually(health, (response) => response.status === 503);
      expect(await unhealthy.text()).toBe("fee ceiling\n");
      expect(await snapshot()).toMatchObject({ stopped: null, journalLatched: true,
        feeCeiling: { resolutionId: transactionHash, transactionHash, maxFeePerGas: "13" } });
      state = "rpc-error";
      const previous = relay.mock.calls.length;
      await eventually(async () => relay.mock.calls.length, (count) => count >= previous + 2);
      expect((await health()).status).toBe(503);
      state = recovered;
      await eventually(health, (response) => response.status === 200);
      expect(await snapshot()).toMatchObject({ stopped: null, feeCeiling: null, journalLatched: recovered !== "mined" });
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      await running;
    }
  });
  it("keeps a credentialed node URL out of status, which shows our own message", async () => {
    const port = await freePort();
    const nodeUrl = "https://node.example/rpc/SECRETKEY?apikey=SECRET2";
    const options = parseRelayerArgs([
      "--rpc-url", nodeUrl,
      "serve", "--poll-interval-ms", "60000", "--http-addr", `127.0.0.1:${port}`,
    ], {});
    const node = new PcashNodeClient(nodeUrl, { fetchFn: async () => { throw new TypeError("fetch failed"); } });
    const submitter = {
      address: `0x${"11".repeat(20)}`, supportedCarriers: ["calldata"],
      assertAvailable: async () => undefined, inFlight: async () => [], balance: async () => 5n,
    };
    const relayer = new Relayer({ node, payoutRecipient: { address: 1n, nkRoot: 2n }, submitterFor: () => submitter as never });
    const running = serveRelayer({
      options,
      logger,
      relayer,
      submitter: submitter as never,
      journal: { read: vi.fn(async () => []) } as never,
    });

    const snapshot = await eventually<any>(
      async () => fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json()),
      (value: any) => value.cycles.failed >= 1,
    );
    expect(snapshot.lastCycle).toMatchObject({ outcome: "failed", error: "reading a mempool page failed (HttpRequestError)" });
    expect(JSON.stringify(snapshot)).not.toMatch(/SECRETKEY|SECRET2/);

    process.emit("SIGTERM", "SIGTERM");
    await expect(running).resolves.toBeUndefined();
  });

  it("shows a viem fee-wallet failure by its short description", async () => {
    const port = await freePort();
    const options = parseRelayerArgs([
      "serve", "--poll-interval-ms", "60000", "--http-addr", `127.0.0.1:${port}`,
    ], {});
    const running = serveRelayer({
      options,
      logger,
      relayer: { relay: vi.fn(async () => idleResult) } as never,
      submitter: { address: `0x${"11".repeat(20)}`, balance: async () => 5n } as never,
      journal: { read: vi.fn(async () => []) } as never,
      observeFees: async () => {
        throw new HttpRequestError({ url: "https://node.example/rpc/SECRETKEY?apikey=SECRET2", details: "fetch failed" });
      },
    });

    const snapshot = await eventually<any>(
      async () => fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json()),
      (value: any) => value.feeWallet !== null,
    );
    expect(snapshot.feeWallet).toEqual({ error: "HTTP request failed." });
    expect(JSON.stringify(snapshot)).not.toMatch(/SECRETKEY|SECRET2/);

    process.emit("SIGTERM", "SIGTERM");
    await expect(running).resolves.toBeUndefined();
  });
});
