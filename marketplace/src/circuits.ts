import { PROVER_ARTIFACT_SHA256 } from "@pcash/sdk/constants/prover-artifacts";
import type { BrowserCircuitProfile } from "@pcash/sdk/browser-prover";

export const MARKETPLACE_CIRCUITS = {
  claim: "/prover/contracts/escrow/claim.json",
  reclaim: "/prover/contracts/escrow/reclaim.json",
} as const;

/** Release pins for one escrow circuit, served by the pinned circuit bundle. */
function escrowProfile(circuitUrl: string): BrowserCircuitProfile {
  const vkUrl = `/chonk-vks/${
    circuitUrl.replace(/^\/prover\//, "").replace(/\.json$/, "")
  }.vk`;
  const circuitSha256 = PROVER_ARTIFACT_SHA256[circuitUrl];
  const vkSha256 = PROVER_ARTIFACT_SHA256[vkUrl];
  if (circuitSha256 === undefined || vkSha256 === undefined) {
    throw new Error(`no release pin for the escrow circuit ${circuitUrl}`);
  }
  return { srsPoints: 2 ** 18, circuitSha256, vkUrl, vkSha256 };
}

export const MARKETPLACE_CIRCUIT_PROFILES = {
  [MARKETPLACE_CIRCUITS.claim]: escrowProfile(MARKETPLACE_CIRCUITS.claim),
  [MARKETPLACE_CIRCUITS.reclaim]: escrowProfile(MARKETPLACE_CIRCUITS.reclaim),
} as const;
