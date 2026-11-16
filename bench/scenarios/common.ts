import {
  CIRCUIT_URLS,
  type AssetProver,
  type ChonkProofStep,
  type ChonkProver,
  type ProofResult,
  type ProveStatus,
  type Prover,
} from "@pcash/sdk/browser-prover";
import { privateValuePublicInputNames, type WitnessMap } from "@pcash/sdk/builders";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { eventStatementFromKernel, noOpEventWitness, functionSelector } from "@pcash/sdk/protocol";
import { numberToHex } from "viem";

export type PerformanceScenarioId =
  | "lineageControl"
  | "lineageEvent"
  | "notesNative"
  | "asset-creation"
  | "ordinaryAssetTransfer"
  | "userAssetTransfer"
  | "marketplaceClaim"
  | "contractCreation"
  | "largeAssetBatchTransfer"
  | "largeNativeBatchTransfer";

export type ScenarioProver = Prover & AssetProver & ChonkProver;

export interface ChonkVk {
  fields: string[];
  hash: string;
  url: string;
}

/** What a scenario may read from the asset source it is proved against. */
export interface ScenarioContext {
  /** Whether the source serves both the compiled circuit and its CHONK VK. */
  available(circuit: string): boolean;
  /** The CHONK VK of one served circuit, fetched once per page. */
  vk(circuit: string): Promise<ChonkVk>;
}

export interface PreparedScenario {
  assetId?: bigint;
  privateValueCommitment: bigint;
  run: (prover: ScenarioProver, onStatus?: (status: ProveStatus) => void) => Promise<ProofResult>;
}

export interface PerformanceScenario {
  id: PerformanceScenarioId;
  label: string;
  description: string;
  /** Every circuit proved by this scenario, in proving order. */
  circuits: readonly string[];
  /** Build the witnesses. Called only when every circuit is available. */
  prepare: (context: ScenarioContext) => Promise<PreparedScenario>;
}

const HIDING_KERNEL_PUBLIC_INPUT_NAMES = privateValuePublicInputNames(PRIVATE_VALUE_PROFILES.S);

/** The SDK-selected event application for a kernel that consumes one rule. */
export const NO_OP_EVENT_APPLICATION = "no_op_event_application";

export function noOpEventApplicationStep(vk: ChonkVk, kernel: WitnessMap): ChonkProofStep {
  return { circuitUrl: CIRCUIT_URLS.no_op_event_application, vkUrl: vk.url, kind: "app", witnessMap: noOpEventWitness(eventStatementFromKernel(kernel)), label: "no-op event application" };
}

/** The kernel witness that verifies the no-op event application. */
export function noOpEventApplicationWitness(vk: ChonkVk, kernel: WitnessMap): WitnessMap {
  return { event_application_vk: { key: vk.fields, hash: vk.hash }, event_statement: eventStatementFromKernel(kernel).map(String) };
}

export function hidingKernelWitness(publicInputs: readonly bigint[], kernelVk: ChonkVk): WitnessMap {
  return {
    ...Object.fromEntries(HIDING_KERNEL_PUBLIC_INPUT_NAMES.map((name, index) => [name, numberToHex(publicInputs[index]!)])),
    transaction_statement: publicInputs.map((value) => numberToHex(value)),
    kernel_vk: { key: kernelVk.fields, hash: kernelVk.hash },
  };
}

export const pcashChainId = 0x1ff6n;
export const selector = functionSelector(0);
export const covenantMaxNativeOpenFeeAmount = 10n;

export const nativeRuleSecrets = {
  paymentCommitmentBlinder: 0x202n,
  assetPaymentCommitmentBlinder: 0x204n,
  assetBurnCommitmentBlinder: 0x206n,
  batchTransferCommitmentBlinder: 0x208n,
  largeBatchTransferCommitmentBlinder: 0x131n,
  largeAssetCreationCommitmentBlinder: 0x133n,
  largeContractFeeCommitmentBlinder: 0x135n,
  accountAdminCommitmentBlinder: 0x20an,
  contractFeeCommitmentBlinder: 0x20cn,
  assetCreationCommitmentBlinder: 0x20en,
};

export function authorizationAccount(params: {
  address: bigint;
  nkRoot: bigint;
  accountIndex: number;
  accountSiblings: readonly bigint[];
  accountRuleSetCommitment: bigint;
  accountKind: bigint;
  configurationCommitment: bigint;
  commitmentBlinder?: bigint;
  entryIndex: number;
  entrySiblings: readonly bigint[];
}) {
  return {
    address: params.address,
    nkRoot: params.nkRoot,
    accountIndex: params.accountIndex,
    accountSiblings: params.accountSiblings,
    accountRuleSetCommitment: params.accountRuleSetCommitment,
    accountKind: params.accountKind,
    accountRevision: 1n,
    receiveKeyHash: 0n,
    rule: {
      configurationCommitment: params.configurationCommitment,
      commitmentBlinder: params.commitmentBlinder ?? 0n,
      entryIndex: params.entryIndex,
      siblings: params.entrySiblings,
    },
  };
}
