import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const outputRoot = join(import.meta.dirname, "..", "dist");
const routeManifest = JSON.parse(readFileSync(join(outputRoot, "route-manifest.json"), "utf8"));

function attribute(tag, name) {
  return tag.match(new RegExp(`\\s${name}=["']([^"']*)["']`, "i"))?.[1];
}

function blockingLocalStylesheets(html, label) {
  const head = html.match(/<head>([\s\S]*?)<\/head>/i)?.[1];
  assert.ok(head !== undefined, `${label} has no head`);
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => tag);
  const hrefs = links.flatMap((tag) => {
    const rel = attribute(tag, "rel")?.toLowerCase().split(/\s+/) ?? [];
    const href = attribute(tag, "href");
    const media = attribute(tag, "media")?.toLowerCase();
    const disabled = /\sdisabled(?:\s|=|>)/i.test(tag);
    if (!rel.includes("stylesheet") || href === undefined || disabled) return [];
    if (media !== undefined && !["", "all", "screen"].includes(media)) return [];
    return /^\/assets\/[^?#]+\.css(?:[?#].*)?$/.test(href) ? [href] : [];
  });
  assert.ok(hrefs.length > 0, `${label} has no blocking local application stylesheet`);
  return hrefs;
}

function cssFor(hrefs) {
  return hrefs.map((href) => {
    const path = join(outputRoot, href.replace(/^\//, "").replace(/[?#].*$/, ""));
    assert.ok(existsSync(path), `linked stylesheet does not exist: ${href}`);
    return readFileSync(path, "utf8");
  }).join("\n");
}

function assertApplicationCss(html, label) {
  const css = cssFor(blockingLocalStylesheets(html, label));
  assert.match(css, /--color-canvas:/, `${label} blocking CSS omits global tokens`);
  assert.match(css, /\.app-shell(?:[{,:.#\s])/, `${label} blocking CSS omits the application shell`);
  const moduleClasses = new Set(
    [...html.matchAll(/\sclass=["']([^"']+)["']/gi)]
      .flatMap(([, value]) => value.split(/\s+/))
      .filter((value) => value.startsWith("_")),
  );
  for (const className of moduleClasses) {
    assert.ok(css.includes(`.${className}`), `${label} blocking CSS omits ${className}`);
  }
}

describe("prerendered CSS delivery", () => {
  it("links all visible application CSS before prerendered markup can paint", () => {
    const routes = routeManifest.routes.filter(({ renderMode }) => renderMode === "prerender");
    assert.ok(routes.length > 0, "route manifest has no prerendered routes");
    for (const route of routes) {
      const path = route.path === "/"
        ? join(outputRoot, "index.html")
        : join(outputRoot, route.path.replace(/^\//, ""), "index.html");
      assertApplicationCss(readFileSync(path, "utf8"), route.path);
    }
  });

  it("styles the neutral client shell before JavaScript starts", () => {
    assertApplicationCss(readFileSync(join(outputRoot, "app.html"), "utf8"), "app.html");
  });
});
