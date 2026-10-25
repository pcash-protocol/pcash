import { describe, expect, it } from "vitest";
import { DEFAULT_MARKETPLACE_FEE_RECIPIENT, loadE2eConfig, parseDuration } from "../src/config.ts";
import { e2eSettings } from "../src/settings.ts";
import { parseRunOptions } from "../src/run.ts";
import { selectCatalogScenarios } from "../src/scenarios/catalog.ts";

describe("run configuration", () => {
  it("defaults every setting and reads the operator overrides", () => {
    expect(loadE2eConfig(e2eSettings({}))).toEqual({
      assets: { initialSupply: 1_000_000n, actionFee: 1n },
      marketplace: { feeRecipient: DEFAULT_MARKETPLACE_FEE_RECIPIENT, feeBps: 500, ethPriceWei: 1_000_000_000_000_000n },
      seed: { volumeTransfers: 8 },
    });
    const router = `0x${"AB".repeat(20)}`;
    expect(loadE2eConfig(e2eSettings({
      PCASH_E2E_L1_MAX_FEE_PER_GAS: "30000000000",
      PCASH_E2E_PAYMENT_ROUTER_ADDRESS: router,
      PCASH_E2E_PAYMENT_ROUTER_FEE_RECIPIENT: `0x${"12".repeat(20)}`,
      PCASH_E2E_PAYMENT_ROUTER_FEE_BPS: "750",
      PCASH_E2E_SEED_VOLUME_TRANSFERS: " 40 ",
      // The shared names a checkout's .envrc sets for other programs never reach a run.
      PCASH_L1_MAX_FEE_PER_GAS: "1",
    }))).toMatchObject({
      maxFeePerGas: 30_000_000_000n,
      marketplace: { routerAddress: router.toLowerCase(), feeRecipient: `0x${"12".repeat(20)}`, feeBps: 750 },
      seed: { volumeTransfers: 40 },
    });
  });

  it("rejects malformed overrides", () => {
    expect(() => loadE2eConfig(e2eSettings({ PCASH_E2E_SEED_VOLUME_TRANSFERS: "many" }))).toThrow(/decimal integer/);
    expect(() => loadE2eConfig(e2eSettings({ PCASH_E2E_L1_MAX_FEE_PER_GAS: "0" }))).toThrow(/PCASH_E2E_L1_MAX_FEE_PER_GAS must be at least 1/);
    expect(() => loadE2eConfig(e2eSettings({ PCASH_E2E_PAYMENT_ROUTER_FEE_BPS: "10000" }))).toThrow(/between 1 and 9999/);
    expect(() => loadE2eConfig(e2eSettings({ PCASH_E2E_PAYMENT_ROUTER_ADDRESS: "0x12" }))).toThrow(/20-byte/);
  });

  it("parses bounded durations", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("2m")).toBe(120_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(() => parseDuration("0m")).toThrow(/positive integer/);
    expect(() => parseDuration("10d")).toThrow(/s, m, or h/);
  });
});

describe("E2E runner options", () => {
  it("takes scenario names, a network, and run flags", () => {
    const options = parseRunOptions(["core,assets", "reorg", "--out=artifacts", "--keep-artifacts"]);
    expect(options).toMatchObject({ mode: "local", scenarios: ["core", "assets", "reorg"], keepArtifacts: true, up: false });
    expect(options.outputDir).toMatch(/artifacts$/);
    expect(parseRunOptions(["--network", "live", "traffic", "--duration", "2h", "--marketplace"]))
      .toMatchObject({ mode: "live", scenarios: ["traffic"], durationMs: 7_200_000, marketplace: true });
    expect(() => parseRunOptions(["--network", "sepolia"])).toThrow(/local or live/);
    expect(() => parseRunOptions(["--scenario", "core"])).toThrow(/unknown E2E option --scenario/);
  });

  it("keeps live runs to scenarios a remote network can host", () => {
    expect(() => parseRunOptions(["--network", "live", "reorg"])).toThrow(/needs a local network/);
    expect(parseRunOptions(["--network", "live", "traffic"]).durationMs).toBeUndefined();
    expect(() => parseRunOptions(["definitely-not-a-scenario"])).toThrow(/unknown E2E scenario/);
  });

  it("serves a stack without running scenarios", () => {
    expect(parseRunOptions(["--up"])).toMatchObject({ up: true, mode: "local", scenarios: [] });
    expect(() => parseRunOptions(["--up", "core"])).toThrow(/runs no scenarios/);
    expect(() => parseRunOptions(["--up", "--network", "live"])).toThrow(/runs no scenarios/);
  });

  it("defaults to every scenario the mode can host, leaving development scenarios out", () => {
    const local = selectCatalogScenarios([], "local").map((scenario) => scenario.name);
    const live = selectCatalogScenarios([], "live").map((scenario) => scenario.name);
    expect(local).toEqual(expect.arrayContaining(["core", "reorg", "p2p", "persistence", "source-verification", "seed-wallet", "issuance-boundary"]));
    expect(live).toEqual(["core", "assets", "marketplace", "selected-relay", "private-value-profiles", "registration-mining"]);
    for (const selected of [local, live]) {
      expect(selected).not.toContain("traffic");
      expect(selected).not.toContain("seed");
    }
    expect(selectCatalogScenarios(["seed"], "live").map((scenario) => scenario.name)).toEqual(["seed"]);
  });
});
