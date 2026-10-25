import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const issuance = readFileSync(join(root, ".github/workflows/issuance-conformance.yml"), "utf8");

function triggers(workflow) {
  return /^on:\n((?:[ \t].*(?:\n|$))*)/m.exec(workflow)?.[1] ?? "";
}

describe("manual hosted validation workflows", () => {
  it("keeps CI manual and exposes the same typed controls to the UI and CLI", () => {
    const on = triggers(ci);
    assert.match(on, /^  workflow_dispatch:\s*$/m);
    assert.doesNotMatch(on, /^  (?:push|pull_request|release|schedule):/m);
    assert.match(ci, /core:\n\s+description: Core validation gate\n\s+type: choice[\s\S]*options:\n\s+- fast\n\s+- full\n\s+default: fast/);
    assert.match(ci, /browser:\n\s+description: [^\n]+\n\s+type: boolean\n\s+default: false/);
    assert.match(ci, /acceptance:\n\s+description: [^\n]+\n\s+type: boolean\n\s+default: false/);
    assert.match(ci, /if: inputs\.acceptance\n\s+run: just ci-acceptance/);
    assert.match(ci, /metamask:\n\s+description: [^\n]+\n\s+type: boolean\n\s+default: false/);
    assert.match(ci, /if: inputs\.core == 'fast'[\s\S]*run: just ci-fast/);
    assert.match(ci, /if: inputs\.core == 'full'[\s\S]*run: just ci/);
    assert.match(ci, /name: Browser\n\s+if: inputs\.browser\n\s+needs: core/);
    assert.match(ci, /name: MetaMask\n\s+if: inputs\.metamask\n\s+needs: core/);
  });

  it("keeps issuance conformance manual with optional portability", () => {
    const on = triggers(issuance);
    assert.match(on, /^  workflow_dispatch:\s*$/m);
    assert.doesNotMatch(on, /^  (?:push|pull_request|release|schedule):/m);
    assert.match(issuance, /portability:\n\s+description: [^\n]+\n\s+type: boolean\n\s+default: false/);
    assert.match(issuance, /name: Vectors \(Linux x64\)/);
    assert.match(issuance, /name: Independent Python/);
    assert.match(issuance, /name: Vectors \(\$\{\{ matrix\.os \}\}\)\n\s+if: inputs\.portability/);
  });
});
