import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const outputRoot = join(webRoot, "dist");
const clientShellPath = join(outputRoot, "app.html");

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Link previews need an absolute image URL. Vercel supplies the production
// domain at build time; other builds leave the image out.
const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
const shareImage = productionHost ? escapeHtml(`https://${productionHost}/og.jpg`) : undefined;
const shareTags = [
  '<meta property="og:site_name" content="PCASH" />',
  ...(shareImage === undefined ? ['<meta name="twitter:card" content="summary" />'] : [
    `<meta property="og:image" content="${shareImage}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    '<meta property="og:image:alt" content="PCASH seal beside the words Private money Ethereum can program." />',
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:image" content="${shareImage}" />`,
  ]),
].map((tag) => `  ${tag}\n`).join("");

// Every page, prerendered or client-rendered, carries the site-wide share tags.
// A rerun reads the client shell written by the first run, which has them.
const template = await readFile(clientShellPath, "utf8")
  .then((shell) => shell.replace('<div id="root" data-client-shell="true"></div>', '<div id="root"></div>'))
  .catch(async () => (await readFile(join(outputRoot, "index.html"), "utf8")).replace("</head>", `${shareTags}  </head>`));
const localStylesheet = /<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\bhref=["']\/assets\/[^"']+\.css["'])[^>]*>/;
if (!localStylesheet.test(template)) {
  throw new Error("production HTML must load application CSS before prerendered markup can paint");
}
const vite = await createServer({ root: webRoot, appType: "custom", logLevel: "error", server: { middlewareMode: true } });

try {
  const module = await vite.ssrLoadModule("/src/routes/prerender.tsx");
  const clientShell = template.replace('<div id="root"></div>', '<div id="root" data-client-shell="true"></div>');
  await writeFile(join(outputRoot, "app.html"), clientShell);
  for (const route of module.prerenderRoutes) {
    const page = module.renderPublicPage(route.path);
    const destination = join(outputRoot, route.path.replace(/^\//, ""), "index.html");
    const completeTitle = page.title === "PCASH" ? page.title : `${page.title} · PCASH`;
    const escapedPathname = escapeHtml(page.pathname);
    const escapedTitle = escapeHtml(completeTitle);
    const escapedDescription = escapeHtml(page.description);
    const html = template
      .replace(/<title>.*?<\/title>/s, `<title data-pcash-route-metadata="true">${escapedTitle}</title>`)
      .replace("</head>", `  <meta data-pcash-route-metadata="true" name="description" content="${escapedDescription}" />\n  <meta data-pcash-route-metadata="true" property="og:type" content="${page.type ?? "website"}" />\n  <meta data-pcash-route-metadata="true" property="og:title" content="${escapedTitle}" />\n  <meta data-pcash-route-metadata="true" property="og:description" content="${escapedDescription}" />\n  <meta data-pcash-route-metadata="true" name="twitter:title" content="${escapedTitle}" />\n  <meta data-pcash-route-metadata="true" name="twitter:description" content="${escapedDescription}" />\n  </head>`)
      .replace('<div id="root"></div>', `<div id="root" data-prerender-path="${escapedPathname}">${page.html}</div>`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, html);
  }
  await writeFile(join(outputRoot, "route-manifest.json"), `${JSON.stringify({
    version: 1,
    fallback: "/app.html",
    routes: module.routeManifest,
    clientRoutePrefixes: module.clientRoutePrefixes,
  }, null, 2)}\n`);
} finally {
  await vite.close();
}
