import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".dat", "application/octet-stream"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

function artifactFile(root, pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = normalize(decoded.replace(/^\/+/, ""));
  const path = resolve(root, relative === "." ? "index.html" : relative);
  if (path !== root && !path.startsWith(`${root}${sep}`)) return undefined;
  if (existsSync(path) && statSync(path).isFile()) return path;
  const index = join(path, "index.html");
  return existsSync(index) && statSync(index).isFile() ? index : undefined;
}

function wildcardHeaders(root) {
  const source = readFileSync(join(root, "_headers"), "utf8");
  const lines = source.split(/\r?\n/);
  const wildcard = lines.findIndex((line) => line.trim() === "/*");
  if (wildcard === -1) throw new Error("built static host contract has no /* header rule");
  const headers = new Map();
  for (const line of lines.slice(wildcard + 1)) {
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break;
    const separator = line.indexOf(":");
    if (separator === -1) throw new Error(`invalid static host header: ${line}`);
    headers.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  for (const required of [
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Cross-Origin-Embedder-Policy", "require-corp"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
  ]) {
    if (headers.get(required[0]) !== required[1]) {
      throw new Error(`built static host contract must set ${required[0]}: ${required[1]}`);
    }
  }
  return headers;
}

function fallback(root) {
  const redirects = readFileSync(join(root, "_redirects"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const rule = redirects.map((line) => line.split(/\s+/))
    .find(([source, target, status]) => source === "/*" && target?.startsWith("/") && status === "200");
  if (rule === undefined) throw new Error("built static host contract has no /* /<shell>.html 200 fallback");
  const path = resolve(root, rule[1].replace(/^\/+/, ""));
  if (!path.startsWith(`${root}${sep}`) || !existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`built static host fallback does not exist: ${rule[1]}`);
  }
  return path;
}

export async function startStaticHost({ root: inputRoot, host = "127.0.0.1", port = 0 }) {
  const root = resolve(inputRoot);
  const headers = wildcardHeaders(root);
  const fallbackFile = fallback(root);
  const server = createServer((request, response) => {
    try {
      for (const [name, value] of headers) response.setHeader(name, value);
      const pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`).pathname;
      const path = artifactFile(root, pathname) ?? fallbackFile;
      const bytes = readFileSync(path);
      response.statusCode = 200;
      response.setHeader("content-type", CONTENT_TYPES.get(extname(path)) ?? "application/octet-stream");
      response.setHeader("content-length", bytes.length);
      if (request.method === "HEAD") response.end();
      else response.end(bytes);
    } catch (cause) {
      response.statusCode = 500;
      response.end(cause instanceof Error ? cause.message : String(cause));
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("static host did not bind a TCP port");
  return {
    url: `http://${host}:${address.port}`,
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  };
}
