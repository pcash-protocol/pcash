import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config } from "@pcash/sdk/bcfg";
import { Logger } from "@pcash/sdk/blgr";
import { defineConfig, type Plugin } from "vite";

const logger = new Logger("info");
await logger.open();
const root = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const config = new Config("pcash");
config.load({ env: true });
const outDir = config.str("proof-lab-dist");
if (!outDir) throw new Error("PCASH_PROOF_LAB_DIST is required");
// Staged local assets. A hosted build has none: it proves against a node's release set.
const publicDir = config.str("proof-lab-public", false);
const resultsDir = config.str("proof-lab-results") ?? undefined;

const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_SAVED_REPORTS = 200;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RESULT_BYTES) {
        rejectBody(new Error("result is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectBody);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
}

/**
 * `just bench` saves every finished run on the machine serving the lab, so a
 * phone reached through the tunnel needs no way to move files off itself.
 *
 * Anyone holding the tunnel URL can reach this endpoint, so it lists only what
 * this launch saved, never replaces a file, and stops accepting after a bound.
 * Reports from earlier launches stay on disk for the page's file input.
 */
function resultsPlugin(directory: string): Plugin {
  const saved: string[] = [];
  const fileName = (report: { startedAt?: unknown; device?: { name?: unknown } }) => {
    const started = typeof report.startedAt === "string" ? report.startedAt : new Date().toISOString();
    const device = typeof report.device?.name === "string" && report.device.name.trim() !== ""
      ? report.device.name
      : "device";
    const slug = device.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "device";
    return `${started.replace(/[^0-9TZ-]/g, "-").slice(0, 32)}-${slug}-${randomBytes(4).toString("hex")}.json`;
  };
  return {
    name: "pcash-proof-lab-results",
    configurePreviewServer(server) {
      mkdirSync(directory, { recursive: true });
      server.middlewares.use("/results", (request, response) => {
        void (async () => {
          try {
            if (request.method === "POST") {
              if (saved.length >= MAX_SAVED_REPORTS) {
                sendJson(response, 429, { error: `this launch already saved ${MAX_SAVED_REPORTS} reports` });
                return;
              }
              const report = JSON.parse(await readBody(request)) as { kind?: unknown };
              if (report.kind !== "pcash-proof-lab") throw new Error("not a proof lab report");
              const path = join(directory, fileName(report as Parameters<typeof fileName>[0]));
              writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
              saved.push(path);
              logger.info(`proof lab result saved: ${path}`);
              sendJson(response, 200, { path });
              return;
            }
            if (request.method === "GET") {
              sendJson(response, 200, saved.map((path) => JSON.parse(readFileSync(path, "utf8")) as unknown));
              return;
            }
            sendJson(response, 405, { error: "method not allowed" });
          } catch (error) {
            sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        })();
      });
    },
  };
}

export default defineConfig({
  root,
  base: config.str("proof-lab-base", "/"),
  envDir: false,
  publicDir,
  define: {
    "import.meta.env.VITE_PROOF_LAB_RPC_URL": JSON.stringify(config.str("proof-lab-rpc-url", "")),
    "import.meta.env.VITE_PROOF_LAB_SAVES_RESULTS": JSON.stringify(resultsDir === undefined ? "" : "1"),
  },
  plugins: resultsDir === undefined ? [] : [resultsPlugin(resultsDir)],
  worker: { format: "es" },
  build: { outDir, emptyOutDir: true },
  server: {
    host: true,
    allowedHosts: true,
    fs: { allow: [repositoryRoot] },
    headers,
  },
  preview: {
    host: true,
    allowedHosts: true,
    headers,
  },
});
