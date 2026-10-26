import { sourceVerificationDefinition } from "@pcash/marketplace/tooling/sourceVerification";
import type { SourceVerificationDefinition } from "../../../scripts/source-verification/index.mts";
import type { NetworkMode, ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { runAssetsScenario } from "./assets.ts";
import { SCENARIO_CATALOG, selectCatalogScenarios, type ScenarioCatalogEntry } from "./catalog.ts";
import { runLineageScenario } from "./lineage.ts";
import { runBoardScenario } from "./board.ts";
import { runContractPostingScenario } from "./contractPosting.ts";
import { runCoreScenario } from "./core.ts";
import { runDirectSendScenario } from "./directSend.ts";
import { runIssuanceBoundaryScenario } from "./issuanceBoundary.ts";
import { runMarketplaceScenario } from "./marketplace.ts";
import { runP2pScenario } from "./p2p.ts";
import { runPersistenceScenario } from "./persistence.ts";
import { runPrivateValueProfilesScenario } from "./privateValueProfiles.ts";
import { runRegistrationMiningScenario } from "./registrationMining.ts";
import { runReorgScenario } from "./reorg.ts";
import { runSeedScenario } from "./seed.ts";
import { runSeedWalletScenario } from "./seedWallet.ts";
import { runSelectedRelayScenario } from "./selectedRelay.ts";
import { runSourceVerificationScenario } from "./sourceVerification.ts";
import { runTokenAirdropScenario } from "./tokenAirdrop.ts";
import { runTokenClaimsScenario } from "./tokenClaims.ts";
import { runTokenMarketScenario } from "./tokenMarket.ts";
import { runTrafficScenario } from "./traffic.ts";

export interface ScenarioDefinition extends ScenarioCatalogEntry {
  sourceVerificationDefinition?: SourceVerificationDefinition;
  run(fixture: ScenarioFixture): Promise<unknown>;
}

const RUNNERS: Readonly<Record<string, (fixture: ScenarioFixture) => Promise<unknown>>> = {
  core: runCoreScenario,
  board: runBoardScenario,
  lineage: runLineageScenario,
  assets: runAssetsScenario,
  "token-airdrop": runTokenAirdropScenario,
  "token-claims": runTokenClaimsScenario,
  "token-market": runTokenMarketScenario,
  marketplace: runMarketplaceScenario,
  "contract-posting": runContractPostingScenario,
  "selected-relay": runSelectedRelayScenario,
  "private-value-profiles": runPrivateValueProfilesScenario,
  "registration-mining": runRegistrationMiningScenario,
  "direct-send": runDirectSendScenario,
  "seed-wallet": runSeedWalletScenario,
  reorg: runReorgScenario,
  "issuance-boundary": runIssuanceBoundaryScenario,
  p2p: runP2pScenario,
  persistence: runPersistenceScenario,
  "source-verification": runSourceVerificationScenario,
  seed: runSeedScenario,
  traffic: runTrafficScenario,
};

export const SCENARIOS: readonly ScenarioDefinition[] = SCENARIO_CATALOG.map((entry) => {
  const run = RUNNERS[entry.name];
  if (run === undefined) throw new Error(`catalog scenario ${entry.name} has no implementation`);
  return {
    ...entry,
    ...(entry.sourceVerification === true ? { sourceVerificationDefinition } : {}),
    run,
  };
});

export function selectScenarios(names: readonly string[], mode: NetworkMode = "local"): ScenarioDefinition[] {
  return selectCatalogScenarios(names, mode).map((entry) => SCENARIOS.find((scenario) => scenario.name === entry.name)!);
}
