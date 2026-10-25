import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { proverRuntimePlugin } from "../scripts/proverRuntime.ts";

const require = createRequire(import.meta.url);
let server: ViteDevServer;
let origin: string;
beforeAll(async () => {
  server = await createServer({
    configFile: false,
    logLevel: "silent",
    plugins: [proverRuntimePlugin()],
    optimizeDeps: { noDiscovery: true },
    server: { host: "127.0.0.1", port: 0, headers: { "Cache-Control": "no-store" } },
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!;
});
afterAll(async () => { await server?.close(); });

async function assetModule(file: string, query = "") {
  const response = await fetch(`${origin}@fs${file}${query}`);
  expect(response.status).toBe(200);
  const source = await response.text();
  expect(source.length).toBeLessThan(2_000);
  const assetUrl = /export default "([^"]+)"/.exec(source)![1]!;
  return new URL(assetUrl, origin).href;
}

it.each(["barretenberg", "barretenberg-threads"])("serves %s as unchanged binary bytes instead of base64 JavaScript", async (name) => {
  const file = resolve(dirname(require.resolve("@aztec-foundation/bb.js")), `../browser/barretenberg_wasm/fetch_code/browser/${name}.js`);
  const expected = Buffer.from((await import(pathToFileURL(file).href)).default.split(",")[1], "base64");
  const url = await assetModule(file);
  const response = await fetch(url);
  expect(response.headers.get("cache-control")).toContain("immutable");
  expect(response.headers.get("content-type")).toBe("application/gzip");
  expect(response.headers.get("content-encoding")).toBeNull();
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.equals(expected)).toBe(true);
  expect(gunzipSync(bytes).subarray(0, 4)).toEqual(Buffer.from([0, 97, 115, 109]));
  const cached = await fetch(url, { headers: { "If-None-Match": response.headers.get("etag")! } });
  expect(cached.status).toBe(304);
  expect(await cached.text()).toBe("");
});

it.each([
  ["@noir-lang/acvm_js", "acvm_js_bg.wasm"],
  ["@noir-lang/noirc_abi", "noirc_abi_wasm_bg.wasm"],
])("compresses and caches %s WASM independently of fresh application state", async (pkg, name) => {
  const file = resolve(dirname(require.resolve(pkg!)), `../web/${name}`);
  const expected = readFileSync(file);
  const url = await assetModule(file, "?import&url");
  const response = await fetch(url, { headers: { "Accept-Encoding": "gzip" } });
  expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(response.headers.get("content-type")).toBe("application/wasm");
  expect(response.headers.get("content-encoding")).toBe("gzip");
  expect(response.headers.get("vary")).toBe("Accept-Encoding");
  expect(Number(response.headers.get("content-length"))).toBeLessThan(expected.length);
  expect(Buffer.from(await response.arrayBuffer()).equals(expected)).toBe(true);
  for (const encoding of ["identity", "gzip;q=0, identity"]) {
    const raw = await fetch(url, { headers: { "Accept-Encoding": encoding } });
    expect(raw.headers.get("content-encoding")).toBeNull();
    expect(Buffer.from(await raw.arrayBuffer()).equals(expected)).toBe(true);
  }
});

it("keeps the application uncached and leaves production builds to Vite", async () => {
  expect(proverRuntimePlugin().apply).toBe("serve");
  const response = await fetch(origin);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("serves a cached runtime URL after a server restart without reloading its importing module", async () => {
  const file = resolve(dirname(require.resolve("@noir-lang/acvm_js")), "../web/acvm_js_bg.wasm");
  const url = await assetModule(file, "?import&url");
  const restarted = await createServer({
    configFile: false,
    logLevel: "silent",
    plugins: [proverRuntimePlugin()],
    optimizeDeps: { noDiscovery: true },
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await restarted.listen();
    const response = await fetch(new URL(new URL(url).pathname, restarted.resolvedUrls!.local[0]!));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(readFileSync(file))).toBe(true);
  } finally {
    await restarted.close();
  }
});
