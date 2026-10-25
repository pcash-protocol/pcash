import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
import type { NativeTransferBuild } from "../builders/index.ts";
import type { UserAccountUpdateBuild } from "../builders/accountUpdate.ts";
import type { SponsoredContractCreationBuild } from "../builders/contractCreation.ts";
import type { AssetActionBuild } from "../builders/assetAction.ts";
import type { ChonkCircuitKind, ChonkVkArtifacts } from "../protocol/account.ts";
import { privateValuePublicInputNames, type WitnessMap } from "../protocol/witness.ts";
import { eventEntry, eventStatementFromKernel, noOpEventWitness, type PreparedEvent } from "../protocol/events.ts";
import { randomFieldEntropy } from "../utils/bytes.ts";
import { toField, type FieldNumberish } from "../crypto/field.ts";
import { fieldToHex } from "../crypto/field.ts";
import {
  proveChonkStack,
  type ChonkBackend,
  type ChonkProgress,
  type NativeChonkResult,
  type NativeChonkStep,
} from "./chonk.ts";

export type { ChonkBackend } from "./chonk.ts";

export interface ChonkCircuitMaterial extends ChonkVkArtifacts {
  kind: ChonkCircuitKind;
  artifact: { bytecode: string; abi: unknown };
  verificationKey: Uint8Array;
}

export type ChonkCircuitResolver = (
  packageName: string,
  kind: ChonkCircuitKind,
) => Promise<ChonkCircuitMaterial>;

const fields = (values: readonly bigint[]): string[] => values.map(fieldToHex);
const vk = (material: ChonkCircuitMaterial): { key: readonly string[]; hash: string } => {
  return { key: material.vkFields, hash: material.vkHash };
};

const TYPE0_NAMES = privateValuePublicInputNames(PRIVATE_VALUE_PROFILES.S);

/** The no-op event application used when a transaction has no substantive event application. */
export const NO_OP_EVENT_APPLICATION = "no_op_event_application";

function step(name: string, material: ChonkCircuitMaterial, witnessMap: WitnessMap): NativeChonkStep {
  return { name, kind: material.kind, artifact: material.artifact, witnessMap, verificationKey: material.verificationKey };
}

/** The circuits of one transaction in folding order, and the statement its hiding kernel exposes. */
export interface ChonkStack {
  steps: NativeChonkStep[];
  publicInputs: readonly bigint[];
}

interface ProveOptions {
  onProgress?: (progress: ChonkProgress) => void;
  backend: ChonkBackend;
  threads?: number;
  signal?: AbortSignal;
}

function proveStack(stack: ChonkStack, options: ProveOptions): Promise<NativeChonkResult> {
  const backend = options.threads === undefined
    ? options.backend
    : { ...options.backend, threads: options.threads };
  return proveChonkStack(stack.steps, stack.publicInputs, backend, { onProgress: options.onProgress, signal: options.signal });
}

export interface PreparedEventApplication extends PreparedEvent {
  application: { packageName: string; material: ChonkCircuitMaterial; event: bigint };
}

/** Resolve the application identity before building or authorizing its transaction. */
export async function prepareEventApplication(params: {
  packageName: string;
  event: FieldNumberish;
  eventSalt?: FieldNumberish;
  resolve: ChonkCircuitResolver;
}): Promise<PreparedEventApplication> {
  const material = await params.resolve(params.packageName, "app");
  const event = toField(params.event);
  const eventSalt = toField(params.eventSalt ?? randomFieldEntropy());
  const applicationVkHash = toField(material.vkHash);
  return {
    eventEntry: eventEntry({ applicationVkHash, event }),
    eventSalt,
    application: { packageName: params.packageName, material, event },
  };
}

export interface EventApplication {
  preparedEvent: PreparedEventApplication;
  witnessMap: WitnessMap;
}

interface TransferTransactionParams {
  eventApplication?: EventApplication | undefined;
  build: NativeTransferBuild | {
    shape?: PrivateValueShape;
    publicInputs: bigint[];
    buildKernelWitnessMap: (authorizationVk: ChonkVkArtifacts) => WitnessMap;
  };
  authorizationPackage: string;
  authorizationWitnessMap: WitnessMap;
  resolve: ChonkCircuitResolver;
}

/** The hiding-kernel step that checks `kernel` against its allowlist and exposes the statement. */
function hidingStep(
  name: string,
  material: ChonkCircuitMaterial,
  kernel: ChonkCircuitMaterial,
  publicInputNames: readonly string[],
  publicInputs: readonly bigint[],
): NativeChonkStep {
  const statement = fields(publicInputs);
  return step(name, material, {
    ...Object.fromEntries(publicInputNames.map((input, index) => [input, statement[index]!])),
    transaction_statement: statement,
    kernel_vk: vk(kernel),
  });
}

interface SingleRuleStackParams {
  eventApplication?: EventApplication | undefined;
  rule: { packageName: string; witnessMap: WitnessMap };
  kernelName: string;
  buildKernelWitnessMap: (ruleVk: ChonkVkArtifacts) => WitnessMap;
  hidingKernelName: string;
  publicInputNames: readonly string[];
  publicInputs: readonly bigint[];
  resolve: ChonkCircuitResolver;
}

/** One rule, the no-op event application, the kernel that consumes the rule, and the family's hiding kernel. */
async function singleRuleStack(params: SingleRuleStackParams): Promise<ChonkStack> {
  // Key derivation may launch a native prover; resolve serially to bound memory.
  const rule = await params.resolve(params.rule.packageName, "app");
  const applicationName = params.eventApplication?.preparedEvent.application.packageName ?? NO_OP_EVENT_APPLICATION;
  const eventApplication = params.eventApplication?.preparedEvent.application.material
    ?? await params.resolve(applicationName, "app");
  const kernel = await params.resolve(params.kernelName, "kernel");
  const hidingKernel = await params.resolve(params.hidingKernelName, "hiding");
  const kernelWitness = params.buildKernelWitnessMap(rule);
  const eventStatement = eventStatementFromKernel(kernelWitness, params.eventApplication?.preparedEvent.application.event);
  return { steps: [
    step(params.rule.packageName, rule, params.rule.witnessMap),
    step(applicationName, eventApplication, params.eventApplication?.witnessMap ?? noOpEventWitness(eventStatement)),
    step(params.kernelName, kernel, {
      ...kernelWitness,
      event_application_vk: vk(eventApplication),
      event_statement: fields(eventStatement),
    }),
    hidingStep(params.hidingKernelName, hidingKernel, kernel, params.publicInputNames, params.publicInputs),
  ], publicInputs: params.publicInputs };
}

const privateValuePrefix = (shape: PrivateValueShape): string =>
  shape === PRIVATE_VALUE_PROFILES.L.shapeId ? "private_value_large" : "private_value";

/** Fold one installed application into the type-0 transfer kernel. */
export async function proveTransferTransactionChonk(params: TransferTransactionParams & ProveOptions): Promise<NativeChonkResult> {
  return proveStack(await transferTransactionStack(params), params);
}

export function transferTransactionStack(params: TransferTransactionParams): Promise<ChonkStack> {
  const shape = params.build.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId;
  const prefix = privateValuePrefix(shape);
  return singleRuleStack({
    rule: { packageName: params.authorizationPackage, witnessMap: params.authorizationWitnessMap },
    eventApplication: params.eventApplication,
    kernelName: `${prefix}_transfer_kernel`,
    buildKernelWitnessMap: params.build.buildKernelWitnessMap,
    hidingKernelName: `${prefix}_hiding_kernel`,
    publicInputNames: privateValuePublicInputNames(privateValueProfile(shape)),
    publicInputs: params.build.publicInputs,
    resolve: params.resolve,
  });
}

interface UserAccountUpdateParams {
  eventApplication?: EventApplication;
  build: UserAccountUpdateBuild;
  authorizationPackage: string;
  authorizationWitnessMap: WitnessMap;
  resolve: ChonkCircuitResolver;
}

/** Fold the selected administration application into a user-account update. */
export async function proveUserAccountUpdateChonk(params: UserAccountUpdateParams & ProveOptions): Promise<NativeChonkResult> {
  return proveStack(await userAccountUpdateStack(params), params);
}

export function userAccountUpdateStack(params: UserAccountUpdateParams): Promise<ChonkStack> {
  return singleRuleStack({
    rule: { packageName: params.authorizationPackage, witnessMap: params.authorizationWitnessMap },
    eventApplication: params.eventApplication,
    kernelName: "user_account_update_kernel",
    buildKernelWitnessMap: params.build.buildKernelWitnessMap,
    hidingKernelName: "user_account_update_hiding_kernel",
    publicInputNames: [...TYPE0_NAMES, "account_update_commitment"],
    publicInputs: params.build.publicInputs,
    resolve: params.resolve,
  });
}

interface SponsoredContractCreationParams {
  eventApplication?: EventApplication;
  build: SponsoredContractCreationBuild;
  authorizationPackage: string;
  authorizationWitnessMap: WitnessMap;
  resolve: ChonkCircuitResolver;
}

/** Fold the sponsor's installed sponsorship rule into a contract-account creation. */
export async function proveSponsoredContractCreationChonk(
  params: SponsoredContractCreationParams & ProveOptions,
): Promise<NativeChonkResult> {
  return proveStack(await sponsoredContractCreationStack(params), params);
}

export function sponsoredContractCreationStack(params: SponsoredContractCreationParams): Promise<ChonkStack> {
  return singleRuleStack({
    rule: { packageName: params.authorizationPackage, witnessMap: params.authorizationWitnessMap },
    eventApplication: params.eventApplication,
    kernelName: "contract_creation_kernel",
    buildKernelWitnessMap: params.build.buildKernelWitnessMap,
    hidingKernelName: "contract_creation_hiding_kernel",
    publicInputNames: [...TYPE0_NAMES, "contract_address"],
    publicInputs: params.build.publicInputs,
    resolve: params.resolve,
  });
}

interface AssetCreationParams {
  eventApplication?: EventApplication;
  build: AssetActionBuild;
  authorization: { packageName: string; witnessMap: WitnessMap };
  resolve: ChonkCircuitResolver;
}

/** Fold the initiating account's installed authorization into the asset-creation kernel. */
export async function proveAssetCreationChonk(params: AssetCreationParams & ProveOptions): Promise<NativeChonkResult> {
  return proveStack(await assetCreationStack(params), params);
}

export function assetCreationStack(params: AssetCreationParams): Promise<ChonkStack> {
  const prefix = privateValuePrefix(params.build.shape);
  return singleRuleStack({
    rule: params.authorization,
    eventApplication: params.eventApplication,
    kernelName: `${prefix}_asset_creation_kernel`,
    buildKernelWitnessMap: params.build.buildAssetCreationKernelWitnessMap,
    hidingKernelName: `${prefix}_hiding_kernel`,
    publicInputNames: privateValuePublicInputNames(privateValueProfile(params.build.shape)),
    publicInputs: params.build.publicInputs,
    resolve: params.resolve,
  });
}

interface SponsoredTransferParams {
  eventApplication?: EventApplication | undefined;
  build: AssetActionBuild;
  primary: { packageName: string; witnessMap: WitnessMap };
  feePayer: { packageName: string; witnessMap: WitnessMap };
  buildKernelWitnessMap: (
    primaryVk: ChonkVkArtifacts,
    feePayerVk: ChonkVkArtifacts,
  ) => WitnessMap;
  resolve: ChonkCircuitResolver;
}

/** Fold two installed applications into the two-account sponsored-transfer kernel. */
export async function proveSponsoredTransferChonk(params: SponsoredTransferParams & ProveOptions): Promise<NativeChonkResult> {
  return proveStack(await sponsoredTransferStack(params), params);
}

export async function sponsoredTransferStack(params: SponsoredTransferParams): Promise<ChonkStack> {
  const prefix = privateValuePrefix(params.build.shape);
  const kernelName = `${prefix}_sponsored_transfer_kernel`;
  const hidingKernelName = `${prefix}_hiding_kernel`;
  const primary = await params.resolve(params.primary.packageName, "app");
  const fee = await params.resolve(params.feePayer.packageName, "app");
  const applicationName = params.eventApplication?.preparedEvent.application.packageName ?? NO_OP_EVENT_APPLICATION;
  const eventApplication = params.eventApplication?.preparedEvent.application.material
    ?? await params.resolve(applicationName, "app");
  const kernel = await params.resolve(kernelName, "kernel");
  const hidingKernel = await params.resolve(hidingKernelName, "hiding");
  const kernelWitness = params.buildKernelWitnessMap(primary, fee);
  const eventStatement = eventStatementFromKernel(kernelWitness, params.eventApplication?.preparedEvent.application.event);
  return { steps: [
    step(params.primary.packageName, primary, params.primary.witnessMap),
    step(params.feePayer.packageName, fee, params.feePayer.witnessMap),
    step(applicationName, eventApplication, params.eventApplication?.witnessMap ?? noOpEventWitness(eventStatement)),
    step(kernelName, kernel, { ...kernelWitness,
      event_application_vk: vk(eventApplication),
      event_statement: fields(eventStatement),
    }),
    hidingStep(hidingKernelName, hidingKernel, kernel,
      privateValuePublicInputNames(privateValueProfile(params.build.shape)), params.build.publicInputs),
  ], publicInputs: params.build.publicInputs };
}
