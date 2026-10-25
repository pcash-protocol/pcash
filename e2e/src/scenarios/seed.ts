import { verifySeedResultProofs } from "../seed/verifyResultProofs.ts";
import { join, resolve } from "node:path";
import { setupPaymentRouter, localPaymentRouterCacheRoot } from "@pcash/marketplace/tooling/paymentRouterSetup";
import type { PaymentRouterConfig } from "@pcash/marketplace/client";
import { createPscanClient } from "@pcash/sdk/clients";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { withAnvilMiningPaused } from "../backends/anvil.ts";
import { logger } from "../framework/logger.ts";
import { l1FeeCaps } from "../backends/rpc.ts";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { recordExplorerFixture } from "../seed/recordExplorerFixture.ts";
import {
  assertRichSeedEvidence,
  runRichSeed,
  SEED_ACTOR_ORDER,
  SEED_UNPAID_OFFER_DEADLINE_LEAD_SECONDS,
  type RichSeedResult,
} from "../seed/richSeed.ts";
import { freshSeedActorFunding, seedWave } from "../seed/richSeedPlan.ts";
import { assertPollingRelayerStopped } from "../seed/relayerPreflight.ts";
import { marketplaceRouterConfig } from "./marketplace.ts";
import { ensureIssuanceActive } from "./setup.ts";

async function paymentRouter(
  fixture: ScenarioFixture,
  config: PaymentRouterConfig | undefined,
) {
  // A local stack shares its router with `just web`; every other run deploys into its own artifacts.
  const sharedAnvil = fixture.mode === "live" && fixture.backend.anvil;
  return setupPaymentRouter({
    rpcUrl: fixture.backend.rpcUrl,
    l1ChainId: fixture.network.l1ChainId,
    cacheRoot: sharedAnvil
      ? localPaymentRouterCacheRoot(fixture.repoRoot, fixture.settings.str("dev-root") ?? undefined)
      : join(fixture.artifacts.root, "marketplace"),
    ...(config === undefined ? {} : { routerConfig: config }),
    explicitAddress: fixture.config.marketplace.routerAddress,
    privateKey: fixture.harness.privateKey,
    fees: () => l1FeeCaps(fixture.backend.rpcUrl, fixture.config.maxFeePerGas),
  });
}

/**
 * Build the complete Explorer fixture: canonical, skipped, marketplace, source,
 * and pending state. It needs the node's admin and Explorer endpoints, so it
 * runs locally or against a local stack, not against a remote network.
 */
export async function runSeedScenario(fixture: ScenarioFixture): Promise<RichSeedResult> {
  const node = fixture.nodeA;
  if (node.pscanUrl === undefined || node.adminUrl === undefined) {
    throw new Error("the seed needs the node's admin and Explorer endpoints: set PCASH_E2E_ADMIN_URL and PCASH_E2E_PSCAN_URL");
  }
  // The seed publishes every carrier itself; a polling relayer beside a local stack would race its waves.
  if (fixture.mode === "live") await assertPollingRelayerStopped(fixture.settings.str("relayer-url")?.trim() || "http://127.0.0.1:9464");
  await ensureIssuanceActive(fixture);
  const sourceManifest = fixture.sourceVerificationManifest;
  if (sourceManifest === undefined) {
    throw new Error("rich seed requires an explicit source-verification manifest");
  }
  const initial = await node.client.status();
  const configuredAddress = fixture.config.marketplace.routerAddress;
  const router = await paymentRouter(
    fixture,
    configuredAddress === undefined ? marketplaceRouterConfig(fixture.config) : undefined,
  );
  const routerAddress = router.address;
  const fees = await l1FeeCaps(fixture.backend.rpcUrl, fixture.config.maxFeePerGas);
  const actorKeys = Object.fromEntries(SEED_ACTOR_ORDER.map((name) => [name, generatePrivateKey()])) as
    Record<typeof SEED_ACTOR_ORDER[number], Hex>;
  // Only the buyer transacts on L1 itself; the harness publishes every carrier.
  await fixture.harness.fundEth(
    privateKeyToAccount(actorKeys.M).address,
    freshSeedActorFunding({ maxFeePerGas: fees.maxFeePerGas, marketplaceEthPriceWei: fixture.config.marketplace.ethPriceWei }).M,
  );

  const plan = Array.from({ length: 6 }, (_, index) => seedWave(index));
  const actorAddresses = Object.fromEntries(SEED_ACTOR_ORDER.map((name) =>
    [name, privateKeyToAccount(actorKeys[name]).address]));
  const seedLog = logger.context("seed");
  seedLog.info(`plan=${JSON.stringify({
    network: {
      pcashChainId: initial.pcashChainId.toString(),
      genesisHash: initial.genesisHash,
      l1ChainId: initial.l1ChainId.toString(),
      inboxAddress: initial.inboxAddress,
    },
    actors: actorAddresses,
    fees: {
      maxFeePerGas: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
    },
    infrastructure: { routerAddress, sourceManifest },
    waves: plan,
    assetLifecycle: ["issue", "funded-transfer", "merge-burn", "funded-issuance", "nullifier-reuse-control"],
    pending: ["actor-transfers", "recordless-account", "mutually-conflicting-pair"],
  })}`);
  const result = await runRichSeed({
    repoRoot: fixture.repoRoot,
    root: join(fixture.artifacts.root, "rich-seed"),
    rpcUrl: node.rpcUrl,
    pscanUrl: node.pscanUrl,
    l1Rpc: fixture.backend.rpcUrl,
    sourceManifest,
    routerAddress,
    routerConfig: router.routerConfig,
    relayerPrivateKey: fixture.harness.privateKey,
    submitter: fixture.harness.submitter,
    actorKeys,
    expectedNode: {
      pcashChainId: initial.pcashChainId,
      genesisHash: initial.genesisHash,
      l1ChainId: initial.l1ChainId,
      inboxAddress: initial.inboxAddress,
      genesisL1Block: initial.genesisL1Block,
      genesisL1BlockHash: initial.genesisL1BlockHash,
    },
    ...fees,
    ethPriceWei: fixture.config.marketplace.ethPriceWei,
    assetInitialSupply: fixture.config.assets.initialSupply,
    assetActionFee: fixture.config.assets.actionFee,
    // The first volume transfer supplies the L result-opening fixture.
    volumeTransfers: Math.max(1, fixture.config.seed.volumeTransfers),
  });
  assertRichSeedEvidence(result);
  await verifySeedResultProofs(node.client, result);
  const final = await node.client.status();
  if (BigInt(result.marketplace.unpaidOffer.deadlineT) - final.latestBlockTimestamp < SEED_UNPAID_OFFER_DEADLINE_LEAD_SECONDS - 60n * 60n) {
    throw new Error("the seed's unpaid offer would expire before the fixture can be browsed");
  }
  const evidencePath = join(fixture.artifacts.root, "rich-seed", "seed-evidence.json");
  fixture.artifacts.record("seed-complete", {
    evidence: evidencePath,
    waves: result.waves.length,
    pending: result.pendingContentHashes.length,
    contracts: result.contractAddresses,
    richness: result.richness,
  });
  seedLog.info(`waves=${result.waves.length} pending=${result.pendingContentHashes.length} evidence=${evidencePath}`);
  const recordDir = fixture.settings.str("seed-record-dir")?.trim();
  if (recordDir) {
    const record = () => recordExplorerFixture({
      node: node.client,
      pscan: createPscanClient(node.pscanUrl!, undefined, node.client),
      evidence: result,
      outDir: resolve(recordDir),
      log: (message) => seedLog.info(`record: ${message}`),
    });
    if (fixture.backend.anvil) {
      await withAnvilMiningPaused(fixture.backend.rpcUrl, async () => {
        await fixture.waitForNodesAtL1Head();
        await record();
      });
    } else {
      await record();
    }
  }
  return result;
}
