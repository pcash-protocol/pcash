import type { WalletRuntimeProvers } from "./actions/walletRuntime.ts";
import {
  createReleaseChonkCircuitResolver,
  nativeChonkBackend,
  pinnedChonkCrs,
} from "@pcash/sdk/node";
import { CIRCUIT_PROVING_RUNTIMES, CIRCUIT_SRS_POINTS, PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import {
  proveTransferTransactionChonk,
  proveAssetCreationChonk,
  proveSponsoredContractCreationChonk,
  proveUserAccountUpdateChonk,
  srsPointsForCircuits,
  wasmChonkBackend,
  type ChonkBackend,
} from "@pcash/sdk/prover";

export type ProverKind = "wasm" | "native";

/** One SRS profile covers every circuit the release marks Wasm-provable. */
const WASM_SRS_POINTS = srsPointsForCircuits(
  Object.keys(CIRCUIT_PROVING_RUNTIMES).filter((id) => CIRCUIT_PROVING_RUNTIMES[id]!.includes("browser")),
  CIRCUIT_SRS_POINTS,
);

export function walletProverBackend(kind: ProverKind): ChonkBackend {
  // bb.js' worker backend keeps Wasm execution and proof generation off the
  // wallet HTTP event loop while retaining the release-pinned resolver and CRS.
  return kind === "native"
    ? nativeChonkBackend()
    : { ...wasmChonkBackend({ crs: pinnedChonkCrs(WASM_SRS_POINTS) }), kind: "wasm-worker" as const };
}

export function createWalletProvers(kind: ProverKind): WalletRuntimeProvers {
  const backend = walletProverBackend(kind);
  const resolve = createReleaseChonkCircuitResolver({ backend });
  return {
    assetCreation: {
      async proveAndEncode(build, authorizationWitnessMap) {
        if (build.shape === PRIVATE_VALUE_PROFILES.L.shapeId && kind !== "native") throw new Error("L transactions require native proving.");
        const proof = await proveAssetCreationChonk({ build, authorization: { packageName: build.shape === PRIVATE_VALUE_PROFILES.L.shapeId ? "account_rule_large_asset_creation_ecdsa" : "account_rule_asset_creation_ecdsa", witnessMap: authorizationWitnessMap }, resolve, backend });
        return build.encodeTransaction(proof.proof);
      },
    },
    assetAction: {
      shapes: kind === "native" ? [PRIVATE_VALUE_PROFILES.S.shapeId, PRIVATE_VALUE_PROFILES.L.shapeId] : [PRIVATE_VALUE_PROFILES.S.shapeId],
      async proveAndEncode(build, authorization) {
        if (build.shape === PRIVATE_VALUE_PROFILES.L.shapeId && kind !== "native") throw new Error("L transactions require native proving.");
        const proof = await proveTransferTransactionChonk({ build, authorizationPackage: authorization.packageName,
          authorizationWitnessMap: authorization.witnessMap, resolve, backend });
        return build.encodeTransaction(proof.proof);
      },
    },
    privateValue: {
      async proveAndEncode(build, signal) {
        if (build.shape === PRIVATE_VALUE_PROFILES.L.shapeId && kind !== "native") throw new Error("L transactions require native proving.");
        const authorizationWitnessMap = build.accountRuleWitnessMap;
        if (authorizationWitnessMap === undefined) {
          throw new Error("default-rule transfer did not produce an ECDSA account-rule witness");
        }
        const proof = await proveTransferTransactionChonk({
          build,
          authorizationPackage: build.authorizationCircuit,
          authorizationWitnessMap,
          resolve,
          backend,
          ...(signal === undefined ? {} : { signal }),
        });
        return build.encodeTransaction(proof.proof);
      },
    },
    userAccountUpdate: {
      async proveAndEncode(build) {
        if (build.readableEcdsaWitnessMap === undefined) {
          throw new Error("user account update authorization did not produce an administration witness");
        }
        const proof = await proveUserAccountUpdateChonk({
          build,
          authorizationPackage: "account_rule_admin_ecdsa",
          authorizationWitnessMap: build.readableEcdsaWitnessMap,
          resolve,
          backend,
        });
        return build.encodeTransaction(proof.proof);
      },
    },
    sponsoredContractCreation: {
      async proveAndEncode(build) {
        if (build.readableEcdsaWitnessMap === undefined) {
          throw new Error("sponsored contract creation did not produce a sponsorship witness");
        }
        const proof = await proveSponsoredContractCreationChonk({
          build,
          authorizationPackage: "account_rule_contract_fee_sponsorship_ecdsa",
          authorizationWitnessMap: build.readableEcdsaWitnessMap,
          resolve,
          backend,
        });
        return build.encodeTransaction(proof.proof);
      },
    },
  };
}
