import { setupPaymentRouter } from "@pcash/marketplace/tooling/paymentRouterSetup";
import { expect, it, vi } from "vitest";
import { loadE2eConfig } from "../src/config.ts";
import { e2eSettings } from "../src/settings.ts";
import type { ScenarioFixture } from "../src/fixture/scenarioFixture.ts";
import { runSeedScenario } from "../src/scenarios/seed.ts";

vi.mock("@pcash/marketplace/tooling/paymentRouterSetup", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pcash/marketplace/tooling/paymentRouterSetup")>(),
  setupPaymentRouter: vi.fn(),
}));
vi.mock("../src/seed/relayerPreflight.ts", () => ({
  assertPollingRelayerStopped: vi.fn().mockResolvedValue(undefined),
}));

const harnessKey = `0x${"5".padStart(64, "0")}`;

it.each([
  { mode: "live", anvil: true, devRoot: undefined, cacheRoot: "/checkout/.cache/pcash/dev/anvil/marketplace" },
  { mode: "live", anvil: true, devRoot: "/custom-dev", cacheRoot: "/custom-dev/marketplace" },
  { mode: "local", anvil: true, devRoot: undefined, cacheRoot: "/run/marketplace" },
  { mode: "live", anvil: false, devRoot: undefined, cacheRoot: "/run/marketplace" },
])("keeps router state for a $mode run on anvil=$anvil (root=$devRoot)", async ({ mode, anvil, devRoot, cacheRoot }) => {
  const stop = new Error("router setup boundary");
  vi.mocked(setupPaymentRouter).mockRejectedValueOnce(stop);
  const fixture = {
    mode,
    repoRoot: "/checkout",
    artifacts: { root: "/run" },
    config: loadE2eConfig(e2eSettings({})),
    settings: e2eSettings(devRoot === undefined ? {} : { PCASH_E2E_DEV_ROOT: devRoot }),
    sourceVerificationManifest: "source-manifest.json",
    harness: { privateKey: harnessKey },
    nodeA: {
      rpcUrl: "http://127.0.0.1:8645",
      pscanUrl: "http://127.0.0.1:8648",
      adminUrl: "http://127.0.0.1:8647",
      client: {
        status: vi.fn().mockResolvedValue({ latestBlockTimestamp: 100n, pcashChainId: 4242 }),
        getIssuanceQuote: async () => ({ rewardPossible: true, maxSingleActionReward: 1n, exhausted: false }),
      },
    },
    network: { l1ChainId: 31337n },
    backend: { anvil, rpcUrl: "http://127.0.0.1:8545" },
  } as unknown as ScenarioFixture;

  await expect(runSeedScenario(fixture)).rejects.toThrow(stop);
  expect(setupPaymentRouter).toHaveBeenCalledWith(expect.objectContaining({
    cacheRoot,
    privateKey: harnessKey,
    routerConfig: expect.objectContaining({ feeBps: 500 }),
  }));
});

it("refuses a node that exposes no admin or Explorer endpoint", async () => {
  const fixture = { nodeA: { rpcUrl: "https://test1.example/rpc" } } as unknown as ScenarioFixture;
  await expect(runSeedScenario(fixture)).rejects.toThrow(/PCASH_E2E_ADMIN_URL and PCASH_E2E_PSCAN_URL/);
});
