import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { normalizePath, type Plugin } from "vite";

const require = createRequire(import.meta.url);
const bbRoot = resolve(dirname(require.resolve("@aztec-foundation/bb.js")), "../browser/barretenberg_wasm/fetch_code/browser");
const sources = new Map([
  [normalizePath(resolve(dirname(require.resolve("@noir-lang/acvm_js")), "../web/acvm_js_bg.wasm")), "acvm.wasm"],
  [normalizePath(resolve(dirname(require.resolve("@noir-lang/noirc_abi")), "../web/noirc_abi_wasm_bg.wasm")), "noirc-abi.wasm"],
  [normalizePath(resolve(bbRoot, "barretenberg.js")), "barretenberg.wasm.gz"],
  [normalizePath(resolve(bbRoot, "barretenberg-threads.js")), "barretenberg-threads.wasm.gz"],
]);

interface RuntimeAsset {
  bytes: Buffer;
  compressed?: Buffer;
  etag: string;
  contentType: string;
}

/** Keep immutable vendor binaries out of Vite's JS/source-map transforms and fresh-state resets. */
export function proverRuntimePlugin(): Plugin {
  const assets = new Map<string, RuntimeAsset>();
  const modules = new Map<string, string>();
  return {
    name: "pcash-prover-runtime",
    apply: "serve",
    enforce: "pre",
    load(id) {
      const [file, query] = id.split("?");
      const name = sources.get(file!);
      if (name === undefined) return;
      const wasm = name.endsWith(".wasm");
      if (wasm && !new URLSearchParams(query).has("url")) return;
      return { code: modules.get(file!)!, map: null };
    },
    configureServer(server) {
      // Populate every URL at startup: a cached importing module can request a
      // binary directly after the dev server restarts.
      for (const [file, name] of sources) {
        const wasm = name.endsWith(".wasm");
        // bb.js ships compressed WASM inside a base64 data-URL module. Serve
        // its binary without the JavaScript wrapper or Vite's inline source map.
        const bytes = wasm ? readFileSync(file) : Buffer.from(
          /"data:application\/gzip;base64,([^"]+)"/.exec(readFileSync(file, "utf8"))![1]!, "base64",
        );
        const digest = createHash("sha256").update(bytes).digest("hex");
        const url = `/__pcash_prover_runtime/${digest}/${name}`;
        assets.set(url, {
          bytes,
          ...(wasm ? { compressed: gzipSync(bytes) } : {}),
          etag: `"${digest}"`,
          contentType: wasm ? "application/wasm" : "application/gzip",
        });
        modules.set(file, `export default ${JSON.stringify(url)};`);
      }
      server.middlewares.use((request, response, next) => {
        const asset = assets.get(request.url?.split("?")[0] ?? "");
        if (asset === undefined || (request.method !== "GET" && request.method !== "HEAD")) return next();
        response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        response.setHeader("Content-Type", asset.contentType);
        response.setHeader("ETag", asset.etag);
        if (asset.compressed !== undefined) response.setHeader("Vary", "Accept-Encoding");
        if (request.headers["if-none-match"] === asset.etag) {
          response.statusCode = 304;
          response.end();
          return;
        }
        const acceptsGzip = (request.headers["accept-encoding"] ?? "").split(",").some((entry) => {
          const [encoding, ...parameters] = entry.trim().split(";");
          const quality = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith("q="));
          return encoding === "gzip" && (quality === undefined || Number(quality.slice(2)) > 0);
        });
        const compressed = asset.compressed !== undefined && acceptsGzip;
        const body = compressed ? asset.compressed! : asset.bytes;
        if (compressed) response.setHeader("Content-Encoding", "gzip");
        response.setHeader("Content-Length", body.length);
        response.end(request.method === "HEAD" ? undefined : body);
      });
    },
  };
}
