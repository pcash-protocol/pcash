import { lineageScenarios } from "./lineage.ts";
import { contractCreationScenario } from "./contractCreation.ts";
import { largeScenarios } from "./large.ts";
import { marketplaceClaimScenario } from "./marketplace.ts";
import { protocolScenarios } from "./protocol.ts";
import type { PerformanceScenario } from "./common.ts";

export type {
  ChonkVk,
  PerformanceScenario,
  PerformanceScenarioId,
  PreparedScenario,
  ScenarioContext,
} from "./common.ts";

/** One scenario per distinct circuit stack worth measuring. */
export function performanceScenarios(): PerformanceScenario[] {
  return [...lineageScenarios(), ...protocolScenarios(), marketplaceClaimScenario, contractCreationScenario(), ...largeScenarios()];
}
