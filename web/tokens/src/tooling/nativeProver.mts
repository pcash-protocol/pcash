// The template proof requests the browser prover takes, proved on the native
// CHONK stack for Node hosts, tests, and end-to-end scenarios.

import { createReleaseChonkCircuitResolver, nativeChonkBackend } from "@pcash/sdk/node";
import { proveRestrictedTransferChonk, proveSponsoredTransferChonk, proveTransferTransactionChonk } from "@pcash/sdk/prover";
import type { AssetActionBuild } from "@pcash/sdk/builders";
import type { AssetProver } from "@pcash/sdk/browser-prover/requests";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";

/** The release artifact ID a pinned browser circuit URL serves. */
function packageOf(circuitUrl: string): string {
  const match = /^\/prover\/(.+)\.json$/.exec(circuitUrl);
  if (match === null) throw new Error(`${circuitUrl} is not a pinned circuit URL`);
  return match[1]!;
}

/** Proves S template actions, unsponsored, restricted, or sponsored, from the active circuit bundle. */
export function nativeTokensProver(options: { threads?: number } = {}): AssetProver {
  const backend = nativeChonkBackend(options.threads);
  const resolve = createReleaseChonkCircuitResolver({ backend });
  return {
    async proveAssetAction(args) {
      const statement = { shape: PRIVATE_VALUE_PROFILES.S.shapeId, publicInputs: [...args.expectedPublicInputs] };
      let result;
      if (args.operation === "transfer") {
        result = await proveTransferTransactionChonk({
          build: { ...statement, buildKernelWitnessMap: args.buildKernelWitnessMap },
          authorizationPackage: packageOf(args.authorization.circuitUrl),
          authorizationWitnessMap: args.authorization.witnessMap,
          resolve,
          backend,
        });
      } else if (args.operation === "restricted-transfer") {
        result = await proveRestrictedTransferChonk({
          // The restricted-transfer stack reads only the shape, the statement, and the kernel witness.
          build: { ...statement, buildRestrictedKernelWitnessMap: args.buildKernelWitnessMap } as unknown as AssetActionBuild,
          authorization: { packageName: packageOf(args.authorization.circuitUrl), witnessMap: args.authorization.witnessMap },
          policy: { packageName: packageOf(args.policy.circuitUrl), witnessMap: args.policy.witnessMap },
          resolve,
          backend,
        });
      } else if (args.operation === "sponsored-transfer") {
        result = await proveSponsoredTransferChonk({
          // The sponsored-transfer stack reads only the shape and the statement.
          build: statement as AssetActionBuild,
          primary: { packageName: packageOf(args.primary.circuitUrl), witnessMap: args.primary.witnessMap },
          feePayer: { packageName: packageOf(args.feePayer.circuitUrl), witnessMap: args.feePayer.witnessMap },
          ...(args.policy === undefined ? {} : { policy: { packageName: packageOf(args.policy.circuitUrl), witnessMap: args.policy.witnessMap } }),
          buildKernelWitnessMap: args.buildKernelWitnessMap,
          resolve,
          backend,
        });
      } else {
        throw new Error("token templates never prove an issuance");
      }
      return { proof: result.proof };
    },
  };
}
