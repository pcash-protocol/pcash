import { createServer, request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  activateWallet,
  buildWalletRegistry,
  closeWalletRegistryAfterRequests,
  createWalletActivator,
  createRequestDrain,
  startWalletServiceListeners,
} from "../../src/service/serve.ts";
import { handleWalletHttp, type WalletHttpContext } from "../../src/service/http.ts";
import { PrometheusWalletMetrics } from "../../src/service/metrics.ts";

const report = {
  syncedThrough: { pcashNumber: 0n, pcashHash: `0x${"00".repeat(32)}` },
} as never;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function wallet(events: string[], failSync = false) {
  return {
    close: vi.fn(async () => { events.push("close"); }),
    startSync: vi.fn((_options?: { intervalMs?: number }) => { events.push("follow"); }),
    sync: vi.fn(async (options?: { rescan?: boolean }) => {
      events.push(options?.rescan === true ? "rescan" : "sync");
      if (failSync) throw new Error("sync failed");
      return report;
    }),
  };
}

describe("wallet service lifecycle", () => {
  it("closes the HTTP listener and opened wallets when the metrics bind fails", async () => {
    const occupied = createServer((_request, response) => response.end("occupied"));
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const occupiedAddress = occupied.address();
    if (typeof occupiedAddress !== "object" || occupiedAddress === null) {
      throw new Error("occupied test server did not bind");
    }
    const serviceServer = createServer((_request, response) => response.end("service"));
    const runtime = wallet([]);

    await expect(startWalletServiceListeners({
      server: serviceServer,
      host: "127.0.0.1",
      port: 0,
      wallets: [runtime],
      metrics: {
        recorder: new PrometheusWalletMetrics(),
        address: `127.0.0.1:${occupiedAddress.port}`,
      },
    })).rejects.toMatchObject({ code: "EADDRINUSE" });

    expect(serviceServer.listening).toBe(false);
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(occupied.listening).toBe(true);
    await new Promise<void>((resolve, reject) => {
      occupied.close((error) => error === undefined ? resolve() : reject(error));
    });
  });

  it("does not accept wallet imports while a delayed metrics bind is pending", async () => {
    const portProbe = createServer();
    await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
    const probeAddress = portProbe.address();
    if (typeof probeAddress !== "object" || probeAddress === null) {
      throw new Error("port probe did not bind");
    }
    const servicePort = probeAddress.port;
    await new Promise<void>((resolve, reject) => {
      portProbe.close((error) => error === undefined ? resolve() : reject(error));
    });
    const metricsBindStarted = deferred<void>();
    const metricsBind = deferred<{ close: () => Promise<void>; url: string }>();
    const serviceServer = createServer((_request, response) => response.end("service"));
    const runtime = wallet([]);
    const startup = startWalletServiceListeners({
      server: serviceServer,
      host: "127.0.0.1",
      port: servicePort,
      wallets: [runtime],
      metrics: {
        recorder: new PrometheusWalletMetrics(),
        address: "127.0.0.1:0",
      },
      startMetricsServer: async () => {
        metricsBindStarted.resolve();
        return metricsBind.promise;
      },
    });
    const startupFailure = expect(startup).rejects.toThrow("metrics bind failed");
    await metricsBindStarted.promise;

    await expect(new Promise<void>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: servicePort,
        method: "POST",
        path: "/wallets/import",
      }, (response) => {
        response.resume();
        response.on("end", resolve);
      });
      request.on("error", reject);
      request.end();
    })).rejects.toMatchObject({ code: "ECONNREFUSED" });

    metricsBind.reject(new Error("metrics bind failed"));
    await startupFailure;
    expect(serviceServer.listening).toBe(false);
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("closes an unpublished new wallet and removes its metrics when its rescan fails", async () => {
    const events: string[] = [];
    const runtime = wallet(events, true);
    const metrics = new PrometheusWalletMetrics();
    metrics.recordAccountState({
      account: "unpublished",
      scanCursor: null,
      nodeTip: 0n,
      finalizedCursor: null,
      noteCount: 0,
      pendingActionCount: 0,
      receiveKeyCount: 1,
    });
    await expect(activateWallet(
      undefined,
      async () => runtime,
      () => { events.push("publish"); },
      1,
      () => metrics.removeAccount("unpublished"),
    ))
      .rejects.toThrow("sync failed");
    expect(events).toEqual(["rescan", "close"]);
    expect(await metrics.metrics()).not.toContain("unpublished");
  });

  it("rescans an existing wallet before publishing a re-import", async () => {
    const events: string[] = [];
    const runtime = wallet(events);
    await activateWallet(runtime, async () => { throw new Error("must not build"); }, () => { events.push("publish"); }, 1);
    expect(events).toEqual(["rescan", "publish"]);
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("closes a new wallet when durable publication fails", async () => {
    const events: string[] = [];
    const runtime = wallet(events);
    await expect(activateWallet(undefined, async () => runtime, () => { throw new Error("save failed"); }, 1))
      .rejects.toThrow("save failed");
    expect(events).toEqual(["rescan", "close"]);
  });

  it("keeps an existing wallet following when durable publication fails", async () => {
    const events: string[] = [];
    const runtime = wallet(events);
    await expect(activateWallet(
      runtime,
      async () => { throw new Error("must not build"); },
      () => { events.push("publish"); throw new Error("save failed"); },
      1,
    )).rejects.toThrow("save failed");
    expect(events).toEqual(["rescan", "publish"]);
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("builds only one wallet for concurrent first activation", async () => {
    const events: string[] = [];
    const firstScanStarted = deferred<void>();
    const finishFirstScan = deferred<void>();
    const runtime = wallet(events);
    let scans = 0;
    runtime.sync.mockImplementation(async () => {
      scans += 1;
      events.push(`rescan-${scans}`);
      if (scans === 1) {
        firstScanStarted.resolve();
        await finishFirstScan.promise;
      }
      return report;
    });
    const runtimes = new Map<string, typeof runtime>();
    const activateStoredWallet = createWalletActivator();
    let builds = 0;
    const activate = () => activateStoredWallet(
      "0xaccount",
      () => runtimes.get("0xaccount"),
      async () => { builds += 1; return runtime; },
      (value) => { runtimes.set("0xaccount", value); },
      1,
    );

    const first = activate();
    await firstScanStarted.promise;
    const second = activate();
    await Promise.resolve();
    expect(builds).toBe(1);

    finishFirstScan.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(runtime);
    expect(secondResult).toBe(runtime);
    expect(builds).toBe(1);
    expect(runtime.close).not.toHaveBeenCalled();
    expect(events).toEqual([
      "rescan-1",
      "follow",
      "rescan-2",
    ]);
  });

  it("closes wallets built before a restored-wallet startup failure", async () => {
    const first = wallet([]);
    const wallets = [{ address: "first" }, { address: "broken" }, { address: "unreached" }];
    const built: string[] = [];

    await expect(buildWalletRegistry(wallets, async (storedWallet) => {
      built.push(storedWallet.address);
      if (storedWallet.address === "broken") throw new Error("open failed");
      return first;
    })).rejects.toThrow("open failed");

    expect(built).toEqual(["first", "broken"]);
    expect(first.close).toHaveBeenCalledOnce();
  });

  it("drains an aborted wallet import before closing its published wallet", async () => {
    const importStarted = deferred<void>();
    const finishImport = deferred<void>();
    const runtimes = new Map<string, ReturnType<typeof wallet>>();
    const imported = wallet([]);
    const requests = createRequestDrain();
    const context = {
      logger: { error: () => undefined },
      node: {},
      runtimeFor: () => { throw new Error("unused"); },
      listWallets: () => [],
      submissionFor: () => { throw new Error("unused"); },
      sync: async () => { throw new Error("unused"); },
      createReceiveKey: async () => { throw new Error("unused"); },
      importReceiveKey: async () => { throw new Error("unused"); },
      listReceiveKeys: async () => { throw new Error("unused"); },
      importWallet: async () => {
        importStarted.resolve();
        await finishImport.promise;
        runtimes.set("imported", imported);
        return { address: "imported" };
      },
    } as unknown as WalletHttpContext;
    const server = createServer((request, response) => {
      void requests.track(handleWalletHttp(request, response, context)).catch(() => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("test server did not bind");
    const client = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: "/wallets/import",
      headers: { "content-type": "application/json" },
    });
    client.on("error", () => undefined);
    client.end(JSON.stringify({ keyFile: "test-key.json" }));
    await importStarted.promise;
    client.destroy();

    const serverClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
    const closing = closeWalletRegistryAfterRequests((async () => {
      await serverClosed;
      await requests.drain();
    })(), runtimes);
    await serverClosed;

    await Promise.resolve();
    expect(imported.close).not.toHaveBeenCalled();

    finishImport.resolve();
    await closing;
    expect(imported.close).toHaveBeenCalledOnce();
  });
});
