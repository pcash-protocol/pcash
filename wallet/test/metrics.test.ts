import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PrometheusWalletMetrics,
} from "../src/service/metrics.ts";
import { walletActionMetricType } from "@pcash/sdk/wallet/testing";
import {
  normalizeWalletHttpMethod,
  normalizeWalletHttpRoute,
} from "../src/service/metricsTypes.ts";
import {
  startWalletMetricsServer,
} from "../src/service/serve.ts";

const ACCOUNT = `0x${"12".repeat(20)}`;

function requestStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("wallet OpenMetrics recorder", () => {
  it("exposes counters, gauges, durations, and only bounded labels", async () => {
    const metrics = new PrometheusWalletMetrics();
    const secretTransaction = `0x${"ab".repeat(32)}`;
    const secretRecipient = `pcash1-recipient-${"cd".repeat(16)}`;
    const secretCredential = "https://operator:password@rpc.example";
    const action = walletActionMetricType(`send:${secretTransaction}:${secretRecipient}`);

    metrics.recordSyncStarted({ account: ACCOUNT, mode: "full" });
    metrics.recordSyncFinished({
      account: ACCOUNT,
      mode: "full",
      outcome: "success",
      durationSeconds: 1.25,
      outputsScanned: 7,
      trialDecryptAttempts: 11,
      decryptions: 3,
      recoveredNotes: 2,
    });
    metrics.recordSyncStarted({ account: ACCOUNT, mode: "incremental" });
    metrics.recordSyncFinished({
      account: ACCOUNT,
      mode: "incremental",
      outcome: "error",
      durationSeconds: 0.5,
      outputsScanned: 0,
      trialDecryptAttempts: 0,
      decryptions: 0,
      recoveredNotes: 0,
    });
    metrics.recordActionStarted({ account: ACCOUNT, action });
    expect(await metrics.metrics()).toContain(
      `pcash_wallet_actions_in_flight{account="${ACCOUNT}",action="custom"} 1`,
    );
    metrics.recordActionFinished({
      account: ACCOUNT,
      action,
      outcome: "error",
      durationSeconds: 2.5,
    });
    metrics.recordAccountState({
      account: ACCOUNT,
      scanCursor: 8n,
      nodeTip: 11n,
      finalizedCursor: 6n,
      noteCount: 4,
      pendingActionCount: 2,
      receiveKeyCount: 3,
    });
    metrics.setServiceHealth(true);
    metrics.setLoadedAccounts(1);
    metrics.recordHttpRequest({
      method: normalizeWalletHttpMethod("delete"),
      route: normalizeWalletHttpRoute(
        `${secretCredential}/transfer/${secretTransaction}?recipient=${secretRecipient}`,
      ),
      status: 503,
      durationSeconds: 0.25,
    });

    const body = await metrics.metrics();
    expect(metrics.contentType).toBe("application/openmetrics-text; version=1.0.0; charset=utf-8");
    expect(body).toContain(`pcash_wallet_sync_attempts_total{account="${ACCOUNT}",mode="full"} 1`);
    expect(body).toContain(`pcash_wallet_sync_outcomes_total{account="${ACCOUNT}",mode="full",outcome="success"} 1`);
    expect(body).toContain(`pcash_wallet_sync_outputs_scanned_total{account="${ACCOUNT}",mode="full"} 7`);
    expect(body).toContain(`pcash_wallet_sync_trial_decrypt_attempts_total{account="${ACCOUNT}",mode="full"} 11`);
    expect(body).toContain(`pcash_wallet_sync_decryptions_total{account="${ACCOUNT}",mode="full"} 3`);
    expect(body).toContain(`pcash_wallet_sync_recovered_notes_total{account="${ACCOUNT}",mode="full"} 2`);
    expect(body).toContain(`pcash_wallet_action_outcomes_total{account="${ACCOUNT}",action="custom",outcome="error"} 1`);
    expect(body).toContain(`pcash_wallet_actions_in_flight{account="${ACCOUNT}",action="custom"} 0`);
    expect(body).toContain(`pcash_wallet_account_scan_cursor{account="${ACCOUNT}"} 8`);
    expect(body).toContain(`pcash_wallet_account_node_tip_lag_blocks{account="${ACCOUNT}"} 3`);
    expect(body).toContain(`pcash_wallet_account_finalized_cursor{account="${ACCOUNT}"} 6`);
    expect(body).toContain(`pcash_wallet_account_notes{account="${ACCOUNT}"} 4`);
    expect(body).toContain(`pcash_wallet_account_pending_actions{account="${ACCOUNT}"} 2`);
    expect(body).toContain(`pcash_wallet_account_receive_keys{account="${ACCOUNT}"} 3`);
    expect(body).toContain("pcash_wallet_service_up 1");
    expect(body).toContain("pcash_wallet_service_loaded_accounts 1");
    expect(body).toContain('pcash_wallet_http_requests_total{method="OTHER",route="/unknown"} 1');
    expect(body).toContain('pcash_wallet_http_responses_total{method="OTHER",route="/unknown",status="503"} 1');
    expect(body).toContain('pcash_wallet_http_errors_total{method="OTHER",route="/unknown",status="503"} 1');
    expect(body).toContain("pcash_wallet_sync_duration_seconds_sum");
    expect(body).toContain("pcash_wallet_action_duration_seconds_sum");
    expect(body).toContain("pcash_wallet_http_request_duration_seconds_sum");
    expect(body).toContain("process_resident_memory_bytes");
    expect(body).toContain("nodejs_heap_size_used_bytes");
    expect(body).toContain("nodejs_eventloop_lag_seconds");
    expect(body).toContain("# EOF");
    for (const sensitive of [secretTransaction, secretRecipient, secretCredential, "password"]) {
      expect(body).not.toContain(sensitive);
    }
  });

  it("uses a dedicated metrics listener with OpenMetrics content type and clean shutdown", async () => {
    const metrics = new PrometheusWalletMetrics();
    const server = await startWalletMetricsServer(metrics, "127.0.0.1:0");

    const response = await fetch(`${server.url}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(metrics.contentType);
    expect(await response.text()).toContain("pcash_wallet_service_up");
    expect((await fetch(`${server.url}/health`)).status).toBe(404);

    await expect(requestStatus(`${server.url}/metrics`, {
      host: "metrics.attacker.test",
    })).resolves.toBe(400);
    expect((await fetch(`${server.url}/metrics`, {
      headers: { origin: "http://metrics.attacker.test" },
    })).status).toBe(403);
    expect((await fetch(`${server.url}/metrics`, {
      headers: { origin: server.url },
    })).status).toBe(200);

    const port = new URL(server.url).port;
    await expect(requestStatus(`${server.url}/metrics`, {
      host: `[::1]:${port}`,
      origin: `http://[::1]:${port}`,
    })).resolves.toBe(200);

    await server.close();
    await expect(fetch(`${server.url}/metrics`)).rejects.toThrow();
  });

  it("rejects a metrics bind conflict without disturbing the existing listener", async () => {
    const occupied = createServer((_request, response) => response.end("occupied"));
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (typeof address !== "object" || address === null) throw new Error("test server did not bind");

    await expect(startWalletMetricsServer(
      new PrometheusWalletMetrics(),
      `127.0.0.1:${address.port}`,
    )).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(occupied.listening).toBe(true);

    await new Promise<void>((resolve, reject) => {
      occupied.close((error) => error === undefined ? resolve() : reject(error));
    });
  });

  it("removes every account-labelled series when an unpublished account is discarded", async () => {
    const metrics = new PrometheusWalletMetrics();
    metrics.recordSyncStarted({ account: ACCOUNT, mode: "full" });
    metrics.recordSyncFinished({
      account: ACCOUNT,
      mode: "full",
      outcome: "error",
      durationSeconds: 1,
      outputsScanned: 0,
      trialDecryptAttempts: 0,
      decryptions: 0,
      recoveredNotes: 0,
    });
    metrics.recordActionStarted({ account: ACCOUNT, action: "custom" });
    metrics.recordActionFinished({
      account: ACCOUNT,
      action: "custom",
      outcome: "error",
      durationSeconds: 1,
    });
    metrics.recordAccountState({
      account: ACCOUNT,
      scanCursor: null,
      nodeTip: 1n,
      finalizedCursor: null,
      noteCount: 0,
      pendingActionCount: 0,
      receiveKeyCount: 1,
    });
    expect(await metrics.metrics()).toContain(ACCOUNT);

    metrics.removeAccount(ACCOUNT);

    expect(await metrics.metrics()).not.toContain(ACCOUNT);
  });

  it("ships valid Grafana JSON whose metric queries match the recorder", () => {
    const source = readFileSync(
      new URL("../dashboards/pcash-wallet.json", import.meta.url),
      "utf8",
    );
    type DashboardPanel = {
      title?: string;
      targets?: Array<{ expr?: string }>;
      fieldConfig?: {
        defaults?: { unit?: string };
        overrides?: Array<{
          matcher?: { options?: string };
          properties?: Array<{ id?: string; value?: string }>;
        }>;
      };
    };
    const dashboard = JSON.parse(source) as {
      title?: unknown;
      panels?: DashboardPanel[];
      templating?: { list?: Array<{
        definition?: string;
        includeAll?: boolean;
        multi?: boolean;
        name?: string;
      }> };
    };
    expect(dashboard.title).toBe("PCASH Wallet");
    expect(dashboard.panels?.length).toBeGreaterThanOrEqual(15);

    const registered = new Set(
      new PrometheusWalletMetrics().registry.getMetricsAsArray().map(({ name }) => name),
    );
    const queried = new Set(source.match(/pcash_wallet_[a-z0-9_]+/g) ?? []);
    for (const required of [
      "pcash_wallet_service_up",
      "pcash_wallet_service_loaded_accounts",
      "pcash_wallet_account_node_tip_lag_blocks",
      "pcash_wallet_sync_outcomes_total",
      "pcash_wallet_sync_outputs_scanned_total",
      "pcash_wallet_sync_trial_decrypt_attempts_total",
      "pcash_wallet_action_outcomes_total",
      "pcash_wallet_http_requests_total",
      "pcash_wallet_http_errors_total",
    ]) expect(queried.has(required), `dashboard does not query ${required}`).toBe(true);
    for (const name of queried) {
      const base = name.replace(/_(?:bucket|count|sum)$/, "");
      expect(registered.has(name) || registered.has(base), `unregistered dashboard metric ${name}`)
        .toBe(true);
    }
    for (const processMetric of [
      "process_resident_memory_bytes",
      "nodejs_heap_size_used_bytes",
      "process_cpu_seconds_total",
      "nodejs_eventloop_lag_p99_seconds",
    ]) expect(source).toContain(processMetric);
    expect(source).toContain("min(up{instance=~\\\"$instance\\\"}) or vector(0)");
    for (const panel of dashboard.panels ?? []) {
      for (const target of panel.targets ?? []) {
        if (target.expr?.includes("pcash_wallet_")) {
          expect(target.expr, `${panel.title ?? "untitled"} is not scoped to the selected instance`)
            .toContain('instance=~"$instance"');
        }
      }
    }
    const instanceVariable = dashboard.templating?.list?.find(({ name }) => name === "instance");
    expect(instanceVariable).toMatchObject({ includeAll: false, multi: false });
    const accountVariable = dashboard.templating?.list?.find(({ name }) => name === "account");
    expect(accountVariable?.definition).toContain('instance=~"$instance"');

    const unitFor = (title: string, refId: string): string | undefined => {
      const panel = dashboard.panels?.find((candidate) => candidate.title === title);
      const override = panel?.fieldConfig?.overrides?.find(
        (candidate) => candidate.matcher?.options === refId,
      );
      return override?.properties?.find((property) => property.id === "unit")?.value
        ?? panel?.fieldConfig?.defaults?.unit;
    };
    expect(unitFor("Sync outcomes and p95 latency", "A")).toBe("ops");
    expect(unitFor("Sync outcomes and p95 latency", "B")).toBe("s");
    expect(unitFor("Wallet action usage, failures, and latency", "A")).toBe("ops");
    expect(unitFor("Wallet action usage, failures, and latency", "B")).toBe("short");
    expect(unitFor("Wallet action usage, failures, and latency", "C")).toBe("s");
  });
});

describe("wallet HTTP metric normalization", () => {
  it("maps arbitrary methods and paths to bounded labels", () => {
    expect(normalizeWalletHttpMethod("get")).toBe("GET");
    expect(normalizeWalletHttpMethod("PATCH-with-user-data")).toBe("OTHER");
    expect(normalizeWalletHttpRoute("/scan?account=0xsecret")).toBe("/scan");
    expect(normalizeWalletHttpRoute("/wallets/0xsecret/private")).toBe("/unknown");
    expect(normalizeWalletHttpRoute("https://user:pass@example.test/transfer/0xsecret"))
      .toBe("/unknown");
  });
});
