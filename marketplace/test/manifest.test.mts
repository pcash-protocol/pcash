import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  decodeContractBody,
  resolveContractFunction,
  verifyContractManifest,
  type ContractManifest,
} from "@pcash/sdk/protocol";
import {
  DEFAULT_NETWORK_CONFIG,
  field32,
} from "@pcash/sdk/browser";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import {
  CLAIM_FUNCTION_SELECTOR,
  CLAIM_APPLICATION_VK_HASH,
  RECLAIM_APPLICATION_VK_HASH,
  RECLAIM_FUNCTION_SELECTOR,
} from "../src/commitments.mts";
import { createOffer } from "../src/offer.mts";
import { buildClaimWitnessMap } from "../src/client/claimWitness.ts";
import { buildClaimKernelFixture } from "./claimKernelFixture.mts";

const manifest = JSON.parse(readFileSync(
  fileURLToPath(new URL("../l2-contracts/escrow/manifest.json", import.meta.url)),
  "utf8",
)) as ContractManifest;
const circuitBundle = process.env.PCASH_CIRCUIT_BUNDLE?.trim();
if (!circuitBundle) throw new Error("PCASH_CIRCUIT_BUNDLE is required for marketplace circuit tests");

type ReleaseCircuit = { applicationVkHash: string } & Record<string, unknown>;
const releaseManifest = JSON.parse(readFileSync(
  join(circuitBundle, "marketplace-manifest.json"),
  "utf8",
)) as {
  schemaVersion: number;
  circuits: { claim: ReleaseCircuit; reclaim: ReleaseCircuit };
};

const claimArtifactBytes = readFileSync(
  join(circuitBundle, "prover-assets", "contracts", "escrow", "claim.json"),
);
const claimArtifact = JSON.parse(claimArtifactBytes.toString("utf8")) as {
  bytecode: string;
  abi: {
    parameters: Array<{ name: string }>;
  };
};

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

test("marketplace release manifest exposes application VK hashes without aliases", () => {
  assert.equal(releaseManifest.schemaVersion, 2);
  assert.equal(BigInt(releaseManifest.circuits.claim.applicationVkHash), CLAIM_APPLICATION_VK_HASH);
  assert.equal(BigInt(releaseManifest.circuits.reclaim.applicationVkHash), RECLAIM_APPLICATION_VK_HASH);
  assert.equal("computeCircuitVkHash" in releaseManifest.circuits.claim, false);
  assert.equal("computeCircuitVkHash" in releaseManifest.circuits.reclaim, false);
});

test("claim browser artifact matches the release circuit and witness ABI", () => {
  const claimRelease = releaseManifest.circuits.claim as ReleaseCircuit & {
    acirSha256: string;
  };
  assert.equal(sha256(Buffer.from(claimArtifact.bytecode, "base64")), claimRelease.acirSha256);
  const witness = buildClaimWitnessMap(buildClaimKernelFixture().claim);
  assert.deepEqual(
    Object.keys(witness).sort(),
    claimArtifact.abi.parameters.map((parameter) => parameter.name).sort(),
  );
});

test("escrow manifest binds function names, selectors, implementations, and schemas", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.contract, "Escrow");
  assert.equal(manifest.functions.length, 2);

  const claim = manifest.functions.find((entry) => entry.name === "claim");
  const reclaim = manifest.functions.find((entry) => entry.name === "reclaim");
  assert.ok(claim);
  assert.ok(reclaim);
  assert.equal(claim.selector, CLAIM_FUNCTION_SELECTOR);
  assert.equal(reclaim.selector, RECLAIM_FUNCTION_SELECTOR);
  assert.equal(BigInt(claim.applicationVkHash), CLAIM_APPLICATION_VK_HASH);
  assert.equal(BigInt(reclaim.applicationVkHash), RECLAIM_APPLICATION_VK_HASH);
  assert.ok(claim.arguments);
  assert.deepEqual(
    claim.arguments.map(({ name, type }) => [name, type]),
    [
      ["recipient", "uint160"],
      ["claimKey", "field"],
    ],
  );
  assert.ok(reclaim.arguments);
  assert.deepEqual(
    reclaim.arguments.map(({ name, type }) => [name, type]),
    [
      ["escrowContract", "uint160"],
      ["offerId", "field"],
      ["assetId", "field"],
      ["recipient", "uint160"],
      ["payoutAmount", "uint128"],
      ["openFeeAmount", "uint128"],
      ["issuanceRecipient", "uint160"],
      ["issuanceOwnerCommitment", "field"],
      ["relayFeeAmount", "uint128"],
      ["relayFeeOwnerCommitment", "field"],
      ["transactionContext", "field"],
      ["notBefore", "uint64"],
      ["validUntil", "uint64"],
      ["payoutOpeningCommitment", "bytes32"],
      ["sellerSignature", "secp256k1Signature"],
    ],
  );
  assert.deepEqual(claim.configurationCommitment, {
    scheme: "poseidon",
    domain: "REFERENCE_CONFIGURATION_DOMAIN",
    fields: ["configurationSalt", "router", "seller", "offerId", "assetId", "amount", "ethPriceWei", "deadlineT"],
  });
  assert.deepEqual(reclaim.configurationCommitment, {
    scheme: "poseidon",
    domain: "REFERENCE_CONFIGURATION_DOMAIN",
    fields: ["configurationSalt", "seller", "offerId", "deadlineT", "domainSeparatorHigh", "domainSeparatorLow"],
  });
});

test("escrow manifest binds exactly to a constructed Smart Contract body", () => {
  const sellerWallet = derivePcashProfileFromPrivateKey(field32(1n), DEFAULT_NETWORK_CONFIG);
  const offer = createOffer({
    network: DEFAULT_NETWORK_CONFIG,
    terms: {
      router: 0x100n,
      seller: sellerWallet.address,
      assetId: 0n,
      amount: 1_000n,
      ethPriceWei: 2_000n,
      deadlineT: 3_000n,
    },
    sellerWallet,
    l2ContractNkRoot: 3n,
    claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
    reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
  });

  const verified = verifyContractManifest(decodeContractBody(offer.l2ContractBody), manifest);
  const claim = resolveContractFunction(verified, "claim");
  const reclaim = resolveContractFunction(verified, RECLAIM_FUNCTION_SELECTOR);
  assert.equal(claim.selector, CLAIM_FUNCTION_SELECTOR);
  assert.equal(claim.function.configurationCommitment, offer.claimConfigurationCommitment);
  assert.equal(reclaim.name, "reclaim");
  assert.equal(reclaim.function.configurationCommitment, offer.reclaimConfigurationCommitment);
});
