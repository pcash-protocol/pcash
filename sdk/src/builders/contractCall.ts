// A native transfer authorized by one registered smart contract function.
//
// This is the only part of the contract surface that needs the witness builders,
// so it lives here rather than beside the account shape in ../protocol/contract.ts
// — that is what lets ../clients/ decode a contract account without depending on
// the proving layer.

import { type FieldNumberish, toField } from "../crypto/field.ts";
import { ACCOUNT_KIND_CONTRACT } from "../constants/params.ts";
import { nullifierKeyCommitment } from "../protocol/notes.ts";
import type { WalletProfile } from "../protocol/types.ts";
import {
  functionSelector,
  verifyContract,
  type ContractBody,
  type ContractFunction,
  type ContractFunctionMembership,
  type FunctionSelector,
} from "../protocol/contract.ts";
import {
  buildNativeTransfer,
  type BuildNativeTransferParams,
  type NativeTransferBuild,
} from "./nativeTransfer.ts";
import type { AssetAccountAuthorization } from "./assetOutputs.ts";

type ContractFunctionTransferParams = Omit<
  BuildNativeTransferParams,
  | "wallet"
  | "accountKind"
  | "accountRuleSetCommitment"
  | "accountRule"
  | "buildEcdsaApplicationWitness"
  | "publicNkRoot"
  | "ruleSetCommitment"
  | "rule"
  | "slot"
  | "commitmentBlinder"
  | "otherRules"
  | "accountRevision"
  | "receiveKeyHash"
>;

/** Inputs for calling one registered function on a Smart Contract. */
export type BuildContractFunctionCallParams = ContractFunctionTransferParams & {
  contract: ContractBody;
  selector: FunctionSelector;
  /** Required only when the contract body commits to P without publishing nkRoot. */
  nkRoot?: FieldNumberish;
};

/** A transfer authorized by one registered Smart Contract function. */
export interface ContractFunctionCallBuild
  extends Omit<
    NativeTransferBuild,
    | "configurationCommitment"
    | "accountRuleSetCommitment"
    | "accountRuleWitnessMap"
  > {
  contractAddress: bigint;
  functionSetCommitment: bigint;
  function: ContractFunction;
  membership: ContractFunctionMembership;
}

interface ResolvedContractFunction {
  address: bigint;
  nkRoot: bigint;
  functionSetCommitment: bigint;
  function: ContractFunction;
  membership: ContractFunctionMembership;
  receiveKeyHash: bigint;
}

/** Verify a contract body and open one of its functions. */
function resolveContractFunction(
  contract: ContractBody,
  selectorValue: FunctionSelector,
  suppliedNkRoot: FieldNumberish | undefined,
): ResolvedContractFunction {
  const selector = functionSelector(selectorValue);
  const verification = verifyContract(contract);
  const publishedNkRoot = contract.nullifierKey.publishesNkRoot
    ? toField(contract.nullifierKey.nkRoot, "smart contract nkRoot")
    : undefined;
  const resolvedNkRoot = publishedNkRoot ?? suppliedNkRoot;
  if (resolvedNkRoot === undefined) {
    throw new Error("calling a commitment-only smart contract requires nkRoot");
  }
  const nkRoot = toField(resolvedNkRoot, "smart contract nkRoot");
  if (nullifierKeyCommitment(nkRoot) !== verification.nullifierKeyCommitment) {
    throw new Error("smart contract nkRoot does not bind to its nullifierKeyCommitment");
  }
  if (
    publishedNkRoot !== undefined &&
    suppliedNkRoot !== undefined &&
    toField(suppliedNkRoot, "smart contract nkRoot") !== publishedNkRoot
  ) {
    throw new Error("supplied nkRoot does not match the smart contract body");
  }

  return {
    address: verification.address,
    nkRoot,
    functionSetCommitment: verification.functionSetCommitment,
    function: contract.functions.find(
      (candidate) => functionSelector(candidate.selector) === selector,
    )!,
    membership: verification.functionSet.membership(selector),
    receiveKeyHash: verification.receiveKeyHash,
  };
}

/**
 * Build a transfer that calls one registered Smart Contract function. This
 * verifies the contract body, resolves the selector opening, derives the
 * contract-owned wallet identity, and adapts the call to the shared
 * native-transfer machinery without exposing user-rule controls.
 */
export function buildContractFunctionCall(
  params: BuildContractFunctionCallParams,
): ContractFunctionCallBuild {
  const { contract, selector, nkRoot: suppliedNkRoot, ...transfer } = params;
  const resolved = resolveContractFunction(contract, selector, suppliedNkRoot);
  const zeroCoordinate = new Uint8Array(32);
  const wallet: WalletProfile = {
    pubX: zeroCoordinate,
    pubY: new Uint8Array(32),
    address: resolved.address,
    nkRoot: resolved.nkRoot,
    ...(contract.mlKemPublicKey !== undefined
      ? { mlKemPublicKey: contract.mlKemPublicKey }
      : {}),
  };

  const lowLevelBuild = buildNativeTransfer({
    ...transfer,
    wallet,
    ...(contract.mlKemPublicKey === undefined ? {} : { selfReceiveKey: contract.mlKemPublicKey }),
    accountKind: ACCOUNT_KIND_CONTRACT,
    accountRevision: 1n,
    receiveKeyHash: resolved.receiveKeyHash,
    accountRuleSetCommitment: resolved.functionSetCommitment,
    accountRule: {
      configurationCommitment: resolved.function.configurationCommitment,
      commitmentBlinder: 0n,
      entryIndex: resolved.function.selector,
      siblings: resolved.membership.siblings,
    },
    publicNkRoot: contract.nullifierKey.publishesNkRoot,
  });
  const {
    configurationCommitment: _configurationCommitment,
    accountRuleSetCommitment: _accountRuleSetCommitment,
    accountRuleWitnessMap: _accountRuleWitnessMap,
    ...callBuild
  } = lowLevelBuild;
  return {
    ...callBuild,
    contractAddress: resolved.address,
    functionSetCommitment: resolved.functionSetCommitment,
    function: resolved.function,
    membership: resolved.membership,
  };
}

/**
 * The authenticated opening of one Smart Contract function for an asset-action
 * kernel: the contract's account leaf at `accountIndex` and the selected
 * function's entry in its function set.
 */
export function contractFunctionAuthorization(params: {
  contract: ContractBody;
  selector: FunctionSelector;
  accountIndex: number;
  accountSiblings: readonly FieldNumberish[];
  /** Required only when the contract body commits to P without publishing nkRoot. */
  nkRoot?: FieldNumberish;
}): AssetAccountAuthorization {
  const resolved = resolveContractFunction(params.contract, params.selector, params.nkRoot);
  return {
    address: resolved.address,
    nkRoot: resolved.nkRoot,
    accountIndex: params.accountIndex,
    accountSiblings: params.accountSiblings,
    accountRuleSetCommitment: resolved.functionSetCommitment,
    accountKind: ACCOUNT_KIND_CONTRACT,
    accountRevision: 1n,
    receiveKeyHash: resolved.receiveKeyHash,
    rule: {
      configurationCommitment: resolved.function.configurationCommitment,
      commitmentBlinder: 0n,
      entryIndex: resolved.function.selector,
      siblings: resolved.membership.siblings,
    },
  };
}
