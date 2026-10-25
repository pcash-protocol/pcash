import { CIRCUIT_SRS_POINTS } from "@pcash/sdk/constants";
import { PROVER_ARTIFACT_SHA256 } from "@pcash/sdk/constants/prover-artifacts";
import type { BrowserCircuitProfile } from "@pcash/sdk/browser-prover";

/** Release artifact IDs: native proving resolves these under the bundle's prover assets. */
export const TOKENS_CIRCUIT_PACKAGES = {
  claimLink: "contracts/claim-link/claim",
  dropClaim: "contracts/drop/claim",
  dropReclaim: "contracts/drop/reclaim",
} as const;

/** Browser artifact URLs served by the pinned circuit bundle. */
export const TOKENS_CIRCUITS = {
  claimLink: `/prover/${TOKENS_CIRCUIT_PACKAGES.claimLink}.json`,
  dropClaim: `/prover/${TOKENS_CIRCUIT_PACKAGES.dropClaim}.json`,
  dropReclaim: `/prover/${TOKENS_CIRCUIT_PACKAGES.dropReclaim}.json`,
} as const;

function templateProfile(packageName: string): BrowserCircuitProfile {
  const circuitUrl = `/prover/${packageName}.json`;
  const vkUrl = `/chonk-vks/${packageName}.vk`;
  const circuitSha256 = PROVER_ARTIFACT_SHA256[circuitUrl];
  const vkSha256 = PROVER_ARTIFACT_SHA256[vkUrl];
  if (circuitSha256 === undefined || vkSha256 === undefined) {
    throw new Error(`no release pin for the token template circuit ${circuitUrl}`);
  }
  return { srsPoints: CIRCUIT_SRS_POINTS[packageName] as BrowserCircuitProfile["srsPoints"], circuitSha256, vkUrl, vkSha256 };
}

export const TOKENS_CIRCUIT_PROFILES = {
  [TOKENS_CIRCUITS.claimLink]: templateProfile(TOKENS_CIRCUIT_PACKAGES.claimLink),
  [TOKENS_CIRCUITS.dropClaim]: templateProfile(TOKENS_CIRCUIT_PACKAGES.dropClaim),
  [TOKENS_CIRCUITS.dropReclaim]: templateProfile(TOKENS_CIRCUIT_PACKAGES.dropReclaim),
} as const;
