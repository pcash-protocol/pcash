import { createReadStream } from "node:fs";
export {
  BROWSER_SRS_POINTS,
  resolveBrowserProverAssets,
  stageBrowserProverAssets,
} from "../../scripts/circuits/browser_assets.mjs";

function contentType(path) {
  return path.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream";
}

/** Vite-compatible middleware for the resolved, exact developer asset set. */
export function browserProverAssetsMiddleware(plan, prefix = "") {
  return (request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") return next();
    let pathname;
    try {
      pathname = new URL(request.url ?? "/", "http://pcash.invalid").pathname;
    } catch {
      return next();
    }
    const logicalPath = prefix !== "" && pathname.startsWith(`${prefix}/`)
      ? pathname.slice(prefix.length)
      : prefix === "" ? pathname : undefined;
    const asset = logicalPath === undefined ? undefined : plan.byLogicalPath.get(logicalPath);
    if (asset === undefined) return next();

    response.statusCode = 200;
    response.setHeader("Content-Type", contentType(asset.logicalPath));
    response.setHeader("Content-Length", String(asset.size));
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(asset.source, { start: 0, end: asset.size - 1 })
      .on("error", (error) => {
        if (!response.headersSent) return next(error);
        response.destroy(error);
      })
      .pipe(response);
  };
}
