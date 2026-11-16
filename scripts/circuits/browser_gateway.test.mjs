import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "../..");

describe("browser asset gateway packaging", () => {
  it("packages only the dedicated public tree and fixed node descriptor", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
    assert.match(dockerfile, /FROM circuits AS browser-assets/);
    assert.match(dockerfile, /browser_assets\.mjs export/);
    assert.match(dockerfile, /COPY --from=browser-assets \/opt\/pcash-public\/proving \/srv\/proving/);
    assert.match(dockerfile, /COPY --from=browser-assets \/opt\/pcash-public\/browser-prover-manifest\.json \/opt\/pcash-browser-prover-manifest\.json/);
    assert.doesNotMatch(dockerfile, /COPY --from=browser-assets \/opt\/pcash-tools/);
  });

  it("keeps proving files isolated behind immutable CORS file serving", () => {
    const caddy = readFileSync(join(root, "compose/gateway.Caddyfile"), "utf8");
    assert.match(caddy, /method OPTIONS[\s\S]*path \/proving\/\*/);
    assert.match(caddy, /method GET HEAD[\s\S]*path \/proving\/\*/);
    assert.match(caddy, /Access-Control-Allow-Origin "\*"/);
    assert.match(caddy, /Access-Control-Allow-Headers "Range"/);
    assert.match(caddy, /Cross-Origin-Resource-Policy "cross-origin"/);
    assert.match(caddy, /Cache-Control "public, max-age=31536000, immutable"/);
    assert.match(caddy, /@proving_file file[\s\S]*header @proving_file Cache-Control/);
    assert.match(caddy, /@proving_other path \/proving\/\*[\s\S]*respond "method not allowed" 405/);
    assert.match(caddy, /respond 404\s*\n\}/);
    assert.doesNotMatch(caddy, /browse/);
  });
});

describe("operator Marketplace source packaging", () => {
  it("packages one generic source publication and keeps admin loopback-only", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
    const caddy = readFileSync(join(root, "compose/gateway.Caddyfile"), "utf8");
    assert.match(dockerfile, /FROM circuits AS marketplace-source/);
    assert.match(dockerfile, /npm run build --workspace @pcash\/sdk[\s\S]*source-verification\/index\.mts build/);
    assert.match(dockerfile, /source-verification\/index\.mts build/);
    assert.match(dockerfile, /marketplace\/src\/tooling\/sourceVerification\.mts/);
    assert.match(dockerfile, /operator-publication\.json/);
    assert.match(dockerfile, /COPY --from=marketplace-source \/opt\/pcash-marketplace-source \/opt\/pcash-marketplace-source/);
    assert.doesNotMatch(caddy, /8647|admin/);
  });
});
