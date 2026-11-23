import { CIRCUIT_URLS, type AssetActionProofRequest } from "@pcash/sdk/browser-prover";
import {
  restrictedSponsoredTransferFixture,
  restrictedTransferFixture,
} from "@pcash/test-support/restricted-fixtures";
import { NO_OP_EVENT_APPLICATION, type PerformanceScenario } from "./common.ts";

const ASSET_PAYMENT = "account_rule_asset_payment_ecdsa";
const DENY_LIST = "transfer_rule_sender_deny_list";
const SHARED_ASSET_CLAIM = "account_rule_shared_asset_claim";
const FEE_SPONSORSHIP = "account_rule_contract_fee_sponsorship_ecdsa";

/** Transfers of an asset with a transfer rule, which fold the rule beside the owner's. */
export function restrictedScenarios(): PerformanceScenario[] {
  return [
    {
      id: "restricted-transfer",
      label: "Restricted asset transfer",
      description: "A person pays an asset with a transfer rule, authorized by the asset-payment rule; the sender deny list folds as the asset's rule, opening one list publication from the L1 origin tree.",
      circuits: [ASSET_PAYMENT, DENY_LIST, NO_OP_EVENT_APPLICATION, "private_value_restricted_transfer_kernel", "private_value_hiding_kernel"],
      async prepare(context) {
        const [authorizationVk, policyVk] = await Promise.all([context.vk(ASSET_PAYMENT), context.vk(DENY_LIST)]);
        const fixture = restrictedTransferFixture({ authorizationVkHash: BigInt(authorizationVk.hash), policyVkHash: BigInt(policyVk.hash) });
        const request: AssetActionProofRequest = {
          operation: "restricted-transfer",
          authorization: { circuitUrl: CIRCUIT_URLS[ASSET_PAYMENT], witnessMap: fixture.signed.witnessMap, label: "user asset-payment authorization" },
          policy: { circuitUrl: CIRCUIT_URLS[DENY_LIST], witnessMap: fixture.policyWitness(), label: "sender deny list" },
          buildKernelWitnessMap: fixture.build.buildRestrictedKernelWitnessMap,
          expectedPublicInputs: fixture.build.publicInputs,
        };
        return {
          assetId: fixture.assetId,
          privateValueCommitment: fixture.build.privateValueCommitment,
          run: (prover, onStatus) => prover.proveAssetAction(request, onStatus),
        };
      },
    },
    {
      id: "restricted-sponsored-transfer",
      label: "Restricted sponsored transfer",
      description: "A contract releases an asset with a transfer rule through a shared claim while a second account pays the fee; the sender deny list folds as the asset's rule.",
      circuits: [SHARED_ASSET_CLAIM, FEE_SPONSORSHIP, DENY_LIST, NO_OP_EVENT_APPLICATION, "private_value_restricted_sponsored_transfer_kernel", "private_value_hiding_kernel"],
      async prepare(context) {
        const [claimVk, sponsorVk, policyVk] = await Promise.all([context.vk(SHARED_ASSET_CLAIM), context.vk(FEE_SPONSORSHIP), context.vk(DENY_LIST)]);
        const fixture = restrictedSponsoredTransferFixture({
          claimVkHash: BigInt(claimVk.hash),
          sponsorVkHash: BigInt(sponsorVk.hash),
          policyVkHash: BigInt(policyVk.hash),
        });
        const request: AssetActionProofRequest = {
          operation: "sponsored-transfer",
          primary: { circuitUrl: `/prover/${SHARED_ASSET_CLAIM}.json`, witnessMap: fixture.claimWitnessMap, label: "shared asset claim" },
          feePayer: { circuitUrl: CIRCUIT_URLS[FEE_SPONSORSHIP], witnessMap: fixture.signed.witnessMap, label: "fee sponsorship authorization" },
          policy: { circuitUrl: CIRCUIT_URLS[DENY_LIST], witnessMap: fixture.policyWitness(), label: "sender deny list" },
          buildKernelWitnessMap: fixture.kernelWitnessMap,
          expectedPublicInputs: fixture.build.publicInputs,
        };
        return {
          assetId: fixture.build.assetId,
          privateValueCommitment: fixture.build.privateValueCommitment,
          run: (prover, onStatus) => prover.proveAssetAction(request, onStatus),
        };
      },
    },
  ];
}
