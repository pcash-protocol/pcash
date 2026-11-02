import { REFERENCE_CONFIGURATION_DOMAIN } from "@pcash/sdk/constants";
import { poseidon, fieldToHex } from "@pcash/sdk/crypto";
import { privateValueMap, type NativeTransferBuild, type WitnessMap } from "@pcash/sdk/builders";

/** Account configuration: releases require this application and fixed policy. */
export interface LineageGateConfiguration {
  salt: bigint;
  policyRoot: bigint;
  lineageVk: bigint;
}

export function lineageGateConfigurationCommitment(configuration: LineageGateConfiguration): bigint {
  return poseidon([REFERENCE_CONFIGURATION_DOMAIN, configuration.salt, configuration.policyRoot, configuration.lineageVk]);
}

/** The account function derives the configured lineage event's entry, which the kernel compares with the transaction's event. */
export function lineageGateWitness(params: {
  /** The gated account's address, which the kernel compares with the authorizing account. */
  address: bigint;
  configuration: LineageGateConfiguration;
  build: Pick<NativeTransferBuild, "pcashChainId" | "recentPcashBlockHash" | "transaction">;
}): WitnessMap {
  const { build, configuration } = params;
  return {
    pcash_chain_id: fieldToHex(build.pcashChainId), recent_pcash_block_hash: fieldToHex(build.recentPcashBlockHash),
    address: fieldToHex(params.address), private_value: privateValueMap(build.transaction),
    configuration: { salt: fieldToHex(configuration.salt), policy_root: fieldToHex(configuration.policyRoot), lineage_vk: fieldToHex(configuration.lineageVk) },
  };
}
