import type { FieldNumberish } from "../crypto/field.ts";
import { encodeContractAccountCreation } from "../protocol/codec.ts";
import { buildContractBody, type BuildContractParams, type ContractBuild } from "../protocol/contract.ts";

export interface BuildUnfundedContractCreationParams {
  pcashChainId: FieldNumberish;
  contract: BuildContractParams;
  recentPcashBlockHash: FieldNumberish;
  validUntilTimestamp: FieldNumberish;
}

export interface UnfundedContractCreationBuild extends ContractBuild {
  transactionBytes: Uint8Array;
}

/** Build the canonical contract body and its unfunded creation transaction. */
export function buildUnfundedContractCreation(
  params: BuildUnfundedContractCreationParams,
): UnfundedContractCreationBuild {
  const contract = buildContractBody(params.contract);
  return {
    ...contract,
    transactionBytes: encodeContractAccountCreation(params.pcashChainId, contract.body, {
      recentPcashBlockHash: params.recentPcashBlockHash,
      validUntilTimestamp: params.validUntilTimestamp,
    }),
  };
}
