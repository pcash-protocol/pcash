// Reference 2-of-3 multisig account rule adapted to an immutable private contract.

import { secp256k1 } from "@noble/curves/secp256k1";
import { concatBytes } from "../utils/bytes.ts";
import {
  buildMultisigRule,
  type BuildMultisigRuleParams,
  type MultisigApproval,
  type MultisigRuleBuild,
  type MultisigSignerPubkey,
} from "./authorizationRules.ts";
import {
  buildContractBody,
  functionSelector,
  type ContractBody,
  type ContractBuild,
  type ContractFunction,
  type FunctionSelector,
} from "../protocol/contract.ts";
import {
  buildContractFunctionCall,
  type BuildContractFunctionCallParams,
  type ContractFunctionCallBuild,
} from "./contractCall.ts";
import { addressFromPublicKeyXY } from "../eip712/eip712.ts";
import { type FieldNumberish, toField } from "../crypto/field.ts";
import { nullifierKeyCommitment } from "../protocol/notes.ts";
import { multisigRuleConfigurationCommitment } from "../rules/referenceRules.ts";

export const MULTISIG_2_OF_3_THRESHOLD = 2n;
const MULTISIG_2_OF_3_SIGNER_COUNT = 3;
const MULTISIG_CONTRACT_FUNCTION_SELECTOR = functionSelector(0);

function signerAddress(signer: MultisigSignerPubkey): bigint {
  if (signer.pubX.length !== 32 || signer.pubY.length !== 32) {
    throw new Error("multisig signer public-key coordinates must be 32 bytes each");
  }
  try {
    secp256k1.Point.fromBytes(concatBytes(Uint8Array.of(0x04), signer.pubX, signer.pubY));
  } catch {
    throw new Error("multisig signer public key is not a valid secp256k1 point");
  }
  return addressFromPublicKeyXY(concatBytes(signer.pubX, signer.pubY));
}

function canonicalSigners(
  signers: readonly MultisigSignerPubkey[],
): { signers: MultisigSignerPubkey[]; addresses: bigint[] } {
  if (signers.length !== MULTISIG_2_OF_3_SIGNER_COUNT) {
    throw new Error("the reference multisig rule requires exactly three signers");
  }
  const entries = signers.map((signer) => ({
    signer: {
      pubX: Uint8Array.from(signer.pubX),
      pubY: Uint8Array.from(signer.pubY),
    },
    address: signerAddress(signer),
  }));
  entries.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  for (let i = 1; i < entries.length; i++) {
    if (entries[i]!.address === entries[i - 1]!.address) {
      throw new Error("multisig signers must be distinct");
    }
  }
  return {
    signers: entries.map((entry) => entry.signer),
    addresses: entries.map((entry) => entry.address),
  };
}

export interface BuildPrivateMultisigContractParams {
  /** Shared privately by the signers. Only P is placed in the public contract body. */
  nkRoot: FieldNumberish;
  signers: readonly MultisigSignerPubkey[];
  /** `computeCircuitVkHash` of the repository's `account_rule_multisig` VK. */
  applicationVkHash: FieldNumberish;
  configurationSalt: FieldNumberish;
  selector?: FunctionSelector;
  mlKemPublicKey?: Uint8Array;
}

/** Local construction material for an immutable private multisig vault. */
export interface PrivateMultisigContract {
  build: ContractBuild;
  /** Public contract body. This never publishes `nkRoot`. */
  contract: ContractBody;
  /** Private nullifier material required to recover and spend contract-owned notes. */
  nkRoot: bigint;
  selector: FunctionSelector;
  function: ContractFunction;
  signers: MultisigSignerPubkey[];
  signerAddresses: bigint[];
  configurationSalt: bigint;
}

/**
 * Build a private 2-of-3 vault whose only spending law is the reference multisig
 * rule. The public body commits to P and the signer configuration; it
 * intentionally omits `nkRoot`. The signers approve the exact action and the
 * contract's address.
 */
export function buildPrivateMultisigContract(
  params: BuildPrivateMultisigContractParams,
): PrivateMultisigContract {
  const nkRoot = toField(params.nkRoot, "nkRoot");
  const selector = functionSelector(params.selector ?? MULTISIG_CONTRACT_FUNCTION_SELECTOR);
  const canonical = canonicalSigners(params.signers);
  const configurationSalt = toField(params.configurationSalt, "configurationSalt");
  const configurationCommitment = multisigRuleConfigurationCommitment(
    configurationSalt,
    MULTISIG_2_OF_3_THRESHOLD,
    canonical.addresses,
  );
  const fn: ContractFunction = {
    selector,
    applicationVkHash: toField(params.applicationVkHash, "applicationVkHash"),
    configurationCommitment,
  };
  const build = buildContractBody({
    nullifierKey: {
      publishesNkRoot: false,
      nullifierKeyCommitment: nullifierKeyCommitment(nkRoot),
    },
    ...(params.mlKemPublicKey !== undefined
      ? { mlKemPublicKey: Uint8Array.from(params.mlKemPublicKey) }
      : {}),
    functions: [fn],
  });
  const contract = build.contract;
  return {
    build,
    contract,
    nkRoot,
    selector,
    function: fn,
    signers: canonical.signers,
    signerAddresses: canonical.addresses,
    configurationSalt,
  };
}

type MultisigContractTransferParams = Omit<
  BuildContractFunctionCallParams,
  "contract" | "selector" | "nkRoot"
>;

/** Build the kernel statement for a spend from a private multisig contract. */
export function buildMultisigContractCall(
  params: MultisigContractTransferParams & {
    multisigContract: PrivateMultisigContract;
  },
): ContractFunctionCallBuild {
  const { multisigContract, ...transfer } = params;
  return buildContractFunctionCall({
    ...transfer,
    contract: multisigContract.contract,
    selector: multisigContract.selector,
    nkRoot: multisigContract.nkRoot,
  });
}

type MultisigContractAuthorizationParams = Omit<
  BuildMultisigRuleParams,
  | "transaction"
  | "createdAssetId"
  | "accountAddress"
  | "recentPcashBlockHash"
  | "pcashChainId"
  | "configurationSalt"
  | "signers"
  | "threshold"
  | "approvals"
> & {
  multisigContract: PrivateMultisigContract;
  call: ContractFunctionCallBuild;
  approvals: readonly MultisigApproval[];
};

/**
 * Build the authorization application for one multisig-contract call.
 */
export function buildMultisigContractAuthorization(
  params: MultisigContractAuthorizationParams,
): MultisigRuleBuild {
  const { multisigContract, call, approvals, ...proving } = params;
  if (call.contractAddress !== multisigContract.build.address) {
    throw new Error("multisig call does not belong to the supplied contract");
  }
  if (
    toField(call.function.configurationCommitment, "configurationCommitment") !==
    toField(multisigContract.function.configurationCommitment, "configurationCommitment")
  ) {
    throw new Error("multisig call configuration does not match the supplied contract");
  }
  if (approvals.length !== Number(MULTISIG_2_OF_3_THRESHOLD)) {
    throw new Error("the reference multisig rule requires exactly two approvals");
  }
  const approvingAddresses = approvals.map((approval) => signerAddress(approval));
  if (approvingAddresses[0] === approvingAddresses[1]) {
    throw new Error("multisig approvals must come from distinct signers");
  }

  const result = buildMultisigRule({
    ...proving,
    transaction: call.transaction,
    createdAssetId: 0n,
    accountAddress: call.contractAddress,
    recentPcashBlockHash: call.recentPcashBlockHash,
    pcashChainId: call.pcashChainId,
    configurationSalt: multisigContract.configurationSalt,
    signers: multisigContract.signers,
    threshold: MULTISIG_2_OF_3_THRESHOLD,
    approvals,
  });
  if (
    result.configurationCommitment !==
    toField(multisigContract.function.configurationCommitment, "configurationCommitment")
  ) {
    throw new Error("multisig application configuration does not match the contract function");
  }
  return result;
}
