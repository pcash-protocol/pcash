import { sha256 } from "@noble/hashes/sha2.js";

import { bytesToBigInt, utf8 } from "../utils/bytes.ts";
import { toHex } from "../utils/hex.ts";
import {
  BN254_SCALAR_MODULUS,
  type FieldNumberish,
  toField,
  toNonnegativeBigInt,
} from "../crypto/field.ts";
import { poseidon } from "../crypto/poseidon2.ts";
import { computeCircuitVkHash, VK_LEN } from "../protocol/account.ts";

export const SOURCE_VERIFICATION_BUNDLE_FORMAT = "pcash-contract-source-bundle-v1" as const;
export const SOURCE_VERIFICATION_SCHEMA_VERSION = 1 as const;
export const SOURCE_VERIFICATION_PROOF_PROFILE = "pcash-chonk-application-v1" as const;
export const CHONK_VERIFIER_TARGET = "chonk" as const;
export const CONTRACT_PRESENTATION_PROFILE_SCHEMA_VERSION = 1 as const;
/** ABI schema version the pinned Noir compiler emits. */
export const NOIR_ABI_VERSION = 1 as const;

export const CONTRACT_PRESENTATION_DISPLAY_FORMATS = [
  "field",
  "uint",
  "hex",
  "ethereum-address",
  "pcash-amount",
  "eth-amount",
  "unix-timestamp",
  "chain-id",
] as const;

/** An application returns the rule statement `[authorizationCommitment, actionCommitment, recentPcashBlockHash, eventEntry]`. */
export const PCASH_APPLICATION_RETURN_FIELDS = 4 as const;

export type Sha256Hex = string;
export type FieldHex = `0x${string}`;
export type AddressHex = `0x${string}`;

export interface SourceFileAttachment {
  path: string;
  attachment: string;
  length: number;
  sha256: Sha256Hex;
}

export interface ToolchainIdentity {
  releaseManifestSha256: Sha256Hex;
  producerPlatform: "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";
  nargo: {
    version: string;
    noircCommit: string;
    archiveSha256: Sha256Hex;
  };
  barretenberg: {
    version: string;
    verifierTarget: typeof CHONK_VERIFIER_TARGET;
    archiveSha256: Sha256Hex;
  };
  crs: {
    bn254G1Sha256: Sha256Hex;
    bn254G2Sha256: Sha256Hex;
  };
}

export interface ConfigurationFieldSchema {
  name: string;
  type: "field" | `uint${number}`;
  bits?: number;
}

export interface ContractConfigurationProfile {
  id: string;
  implementationLabel: string;
  selector: number;
  scheme: "poseidon-explicit-domain-positional-v1";
  domain: FieldHex;
  fields: readonly ConfigurationFieldSchema[];
}

export type ContractPresentationDisplayFormat = typeof CONTRACT_PRESENTATION_DISPLAY_FORMATS[number];

export interface ContractConfigurationFieldPresentation {
  position: number;
  name: string;
  label: string;
  description: string;
  displayFormat: ContractPresentationDisplayFormat;
  overviewOrder: number | null;
}

export interface ContractProofInputPresentation {
  abiParameter: string;
  description: string;
}

export interface ContractProofGroupPresentation {
  title: string;
  description: string;
  items: readonly ContractProofInputPresentation[];
}

export interface ContractFunctionPresentation {
  selector: number;
  applicationVkHash: FieldHex;
  name: string;
  summary: string;
  configurationFields: readonly ContractConfigurationFieldPresentation[];
  proofGroups: readonly ContractProofGroupPresentation[];
}

/** Self-declared display metadata bound to one exact ordered contract function set. */
export interface ContractPresentationProfile {
  schemaVersion: typeof CONTRACT_PRESENTATION_PROFILE_SCHEMA_VERSION;
  publisherLabel: string;
  contractName: string;
  contractDescription: string;
  functions: readonly ContractFunctionPresentation[];
}

export interface SourceVerifiedImplementation {
  id: string;
  implementationLabel: string;
  applicationVkHash: FieldHex;
  packageRoot: string;
  packageName: string;
  sourceBundleDigest: Sha256Hex;
  sourceFiles: SourceFileAttachment[];
  compilerArtifact: {
    attachment: string;
    sha256: Sha256Hex;
    decodedAcirSha256: Sha256Hex;
  };
  noirProvingAbi: {
    attachment: string;
    sha256: Sha256Hex;
  };
  verificationKey: {
    attachment: string;
    sha256: Sha256Hex;
    fieldCount: number;
  };
  toolchain: ToolchainIdentity;
}

/** One ordered contract-function slot and the configuration schema it commits to. */
export interface ContractConfigurationBinding {
  applicationVkHash: FieldHex;
  configurationProfile: ContractConfigurationProfile;
}

export interface ConfigurationOpening {
  address: AddressHex;
  selector: number;
  applicationVkHash: FieldHex;
  configurationCommitment: FieldHex;
  domain: FieldHex;
  values: FieldHex[];
}

export interface ContractSourceVerificationManifest {
  schemaVersion: typeof SOURCE_VERIFICATION_SCHEMA_VERSION;
  bundleFormat: typeof SOURCE_VERIFICATION_BUNDLE_FORMAT;
  generatedAt: string;
  serviceName: string;
  proofProfile: {
    id: typeof SOURCE_VERIFICATION_PROOF_PROFILE;
    returnFields: typeof PCASH_APPLICATION_RETURN_FIELDS;
    returnVisibility: "databus";
  };
  presentation: ContractPresentationProfile;
  implementations: SourceVerifiedImplementation[];
  configurationBindings: ContractConfigurationBinding[];
  configurationOpenings: ConfigurationOpening[];
}

export function sha256Hex(value: Uint8Array | string): Sha256Hex {
  return toHex(sha256(typeof value === "string" ? utf8(value) : value)).slice(2);
}

/** RFC 8785-compatible for parsed JSON values used by Noir artifacts and this manifest. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const account = value as Record<string, unknown>;
    return `{${Object.keys(account)
      .sort()
      .map((key) => {
        const entry = account[key];
        if (entry === undefined) throw new Error(`canonical JSON does not allow undefined at ${key}`);
        return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
      })
      .join(",")}}`;
  }
  throw new Error(`canonical JSON does not support ${typeof value}`);
}

export function canonicalAbiSha256(abi: unknown): Sha256Hex {
  return sha256Hex(canonicalJson(abi));
}

function assertRelativeAttachmentPath(path: string, label: string): void {
  if (
    !path
    || path.length > 1024
    || path.startsWith("/")
    || path.includes("\\")
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
    || [...path].some((character) => character !== "/" && !/[A-Za-z0-9._-]/.test(character))
  ) {
    throw new Error(`${label} must be a normalized relative POSIX path`);
  }
}

/** Digest the canonical path-sorted file index; each entry binds exact bytes through SHA-256. */
export function sourceBundleDigest(files: readonly Pick<SourceFileAttachment, "path" | "length" | "sha256">[]): Sha256Hex {
  const sorted = files
    .map(({ path, length, sha256 }) => ({ path, length, sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  for (const file of sorted) {
    assertRelativeAttachmentPath(file.path, "source path");
    if (seen.has(file.path)) throw new Error(`duplicate source path ${file.path}`);
    seen.add(file.path);
    if (!Number.isSafeInteger(file.length) || file.length < 0) throw new Error(`invalid source length for ${file.path}`);
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error(`invalid SHA-256 for ${file.path}`);
  }
  return sha256Hex(`pcash.source-bundle\0${canonicalJson(sorted)}`);
}

interface NoirAbiParameter {
  name?: unknown;
  visibility?: unknown;
  type?: unknown;
}

function assertPresentationText(value: unknown, label: string, maxLength: number): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be nonempty, trimmed display text of at most ${maxLength} characters`);
  }
}

function assertNoirIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${label} must be a Noir identifier`);
  }
}

function assertSelector(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 255) {
    throw new Error(`${label} must be an integer from 0 to 255`);
  }
}

function assertFieldHex(value: unknown, label: string): asserts value is FieldHex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value) || BigInt(value) >= BN254_SCALAR_MODULUS) {
    throw new Error(`${label} must be a canonical lowercase BN254 field`);
  }
}

function assertConfigurationProfile(value: unknown, label: string): asserts value is ContractConfigurationProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const profile = value as Partial<ContractConfigurationProfile>;
  assertPresentationText(profile.id, `${label}.id`, 160);
  assertPresentationText(profile.implementationLabel, `${label}.implementationLabel`, 160);
  assertSelector(profile.selector, `${label}.selector`);
  if (profile.scheme !== "poseidon-explicit-domain-positional-v1") throw new Error(`${label}.scheme is unsupported`);
  assertFieldHex(profile.domain, `${label}.domain`);
  if (!Array.isArray(profile.fields)) throw new Error(`${label}.fields must be an array`);
  const names = new Set<string>();
  for (let index = 0; index < profile.fields.length; index++) {
    const field = profile.fields[index] as Partial<ConfigurationFieldSchema> | null;
    const fieldLabel = `${label}.fields[${index}]`;
    if (!field || typeof field !== "object" || Array.isArray(field)) throw new Error(`${fieldLabel} must be an object`);
    assertNoirIdentifier(field.name, `${fieldLabel}.name`);
    if (names.has(field.name)) throw new Error(`${label} has duplicate field ${field.name}`);
    names.add(field.name);
    if (field.type === "field") {
      if (field.bits !== undefined) throw new Error(`${fieldLabel}.bits must be absent for a field`);
      continue;
    }
    const width = typeof field.type === "string" ? /^uint([1-9][0-9]*)$/.exec(field.type) : null;
    const bits = width === null ? Number.NaN : Number(width[1]);
    if (!(bits <= 253) || field.bits !== bits) {
      throw new Error(`${fieldLabel} must be a field or a uintN of at most 253 bits with matching bits`);
    }
  }
}

type PresentationImplementationBinding = Pick<
  ContractConfigurationBinding,
  "applicationVkHash" | "configurationProfile"
>;

/** Validate display metadata and its exact selector/VK/configuration binding. */
export function assertContractPresentationProfile(
  value: unknown,
  implementations: readonly PresentationImplementationBinding[],
): asserts value is ContractPresentationProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("contract presentation profile must be an object");
  }
  const profile = value as Partial<ContractPresentationProfile>;
  if (profile.schemaVersion !== CONTRACT_PRESENTATION_PROFILE_SCHEMA_VERSION) {
    throw new Error("unsupported contract presentation profile version");
  }
  assertPresentationText(profile.publisherLabel, "presentation.publisherLabel", 160);
  assertPresentationText(profile.contractName, "presentation.contractName", 160);
  assertPresentationText(profile.contractDescription, "presentation.contractDescription", 2_000);
  if (!Array.isArray(profile.functions) || profile.functions.length !== implementations.length) {
    throw new Error("presentation.functions must cover every implementation exactly once");
  }
  const functionNames = new Set<string>();
  const overviewOrders = new Set<number>();
  let previousSelector = -1;
  for (let index = 0; index < profile.functions.length; index++) {
    const fn = profile.functions[index] as Partial<ContractFunctionPresentation>;
    const binding = implementations[index]!;
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) {
      throw new Error(`presentation.functions[${index}] must be an object`);
    }
    assertSelector(fn.selector, `presentation.functions[${index}].selector`);
    if (fn.selector <= previousSelector) throw new Error("presentation function selectors must be strictly increasing");
    previousSelector = fn.selector;
    if (fn.selector !== binding.configurationProfile.selector) {
      throw new Error(`presentation.functions[${index}].selector does not match its implementation`);
    }
    assertFieldHex(fn.applicationVkHash, `presentation.functions[${index}].applicationVkHash`);
    if (fn.applicationVkHash !== binding.applicationVkHash) {
      throw new Error(`presentation.functions[${index}].applicationVkHash does not match its implementation`);
    }
    assertNoirIdentifier(fn.name, `presentation.functions[${index}].name`);
    if (functionNames.has(fn.name)) throw new Error(`duplicate presentation function name ${fn.name}`);
    functionNames.add(fn.name);
    assertPresentationText(fn.summary, `presentation.functions[${index}].summary`, 500);
    if (!Array.isArray(fn.configurationFields) || fn.configurationFields.length !== binding.configurationProfile.fields.length) {
      throw new Error(`presentation.functions[${index}].configurationFields must cover the configuration profile exactly`);
    }
    const configurationFieldNames = new Set<string>();
    for (let position = 0; position < fn.configurationFields.length; position++) {
      const field = fn.configurationFields[position] as Partial<ContractConfigurationFieldPresentation>;
      const configured = binding.configurationProfile.fields[position]!;
      if (!field || typeof field !== "object" || Array.isArray(field)) {
        throw new Error(`presentation.functions[${index}].configurationFields[${position}] must be an object`);
      }
      if (field.position !== position) {
        throw new Error(`presentation.functions[${index}].configurationFields[${position}].position must be ${position}`);
      }
      assertNoirIdentifier(field.name, `presentation.functions[${index}].configurationFields[${position}].name`);
      if (field.name !== configured.name) {
        throw new Error(`presentation.functions[${index}].configurationFields[${position}].name does not match the configuration profile`);
      }
      if (configurationFieldNames.has(field.name)) throw new Error(`duplicate configuration field name ${field.name}`);
      configurationFieldNames.add(field.name);
      assertPresentationText(field.label, `presentation.functions[${index}].configurationFields[${position}].label`, 160);
      assertPresentationText(field.description, `presentation.functions[${index}].configurationFields[${position}].description`, 1_000);
      if (!(CONTRACT_PRESENTATION_DISPLAY_FORMATS as readonly unknown[]).includes(field.displayFormat)) {
        throw new Error(`presentation.functions[${index}].configurationFields[${position}].displayFormat is unsupported`);
      }
      const overviewOrder = field.overviewOrder;
      if (overviewOrder !== null && (typeof overviewOrder !== "number" || !Number.isSafeInteger(overviewOrder) || overviewOrder < 0)) {
        throw new Error(`presentation.functions[${index}].configurationFields[${position}].overviewOrder must be null or a nonnegative integer`);
      }
      if (overviewOrder !== null) {
        if (overviewOrders.has(overviewOrder)) throw new Error(`duplicate overviewOrder ${overviewOrder}`);
        overviewOrders.add(overviewOrder);
      }
    }
    if (!Array.isArray(fn.proofGroups) || fn.proofGroups.length === 0) {
      throw new Error(`presentation.functions[${index}].proofGroups must not be empty`);
    }
    const groupTitles = new Set<string>();
    for (let groupIndex = 0; groupIndex < fn.proofGroups.length; groupIndex++) {
      const group = fn.proofGroups[groupIndex] as Partial<ContractProofGroupPresentation>;
      if (!group || typeof group !== "object" || Array.isArray(group)) {
        throw new Error(`presentation.functions[${index}].proofGroups[${groupIndex}] must be an object`);
      }
      assertPresentationText(group.title, `presentation.functions[${index}].proofGroups[${groupIndex}].title`, 160);
      if (groupTitles.has(group.title)) throw new Error(`duplicate proof group title ${group.title}`);
      groupTitles.add(group.title);
      assertPresentationText(group.description, `presentation.functions[${index}].proofGroups[${groupIndex}].description`, 1_000);
      if (!Array.isArray(group.items) || group.items.length === 0) {
        throw new Error(`presentation.functions[${index}].proofGroups[${groupIndex}].items must not be empty`);
      }
      for (let itemIndex = 0; itemIndex < group.items.length; itemIndex++) {
        const item = group.items[itemIndex] as Partial<ContractProofInputPresentation>;
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new Error(`presentation.functions[${index}].proofGroups[${groupIndex}].items[${itemIndex}] must be an object`);
        }
        assertNoirIdentifier(
          item.abiParameter,
          `presentation.functions[${index}].proofGroups[${groupIndex}].items[${itemIndex}].abiParameter`,
        );
        assertPresentationText(
          item.description,
          `presentation.functions[${index}].proofGroups[${groupIndex}].items[${itemIndex}].description`,
          1_000,
        );
      }
    }
  }
  for (let order = 0; order < overviewOrders.size; order++) {
    if (!overviewOrders.has(order)) throw new Error("presentation overviewOrder values must be dense from zero");
  }
}

function isNoirFieldType(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { kind?: unknown }).kind === "field";
}

/** Enforce the interface of a PCASH account-rule proof: private inputs and a four-Field databus return. */
export function validatePcashNoirAbi(abi: unknown): asserts abi is { parameters: NoirAbiParameter[]; return_type: object } {
  if (!abi || typeof abi !== "object") throw new Error("Noir ABI must be an object");
  const account = abi as { abi_version?: unknown; parameters?: unknown; return_type?: unknown; error_types?: unknown };
  if (!Array.isArray(account.parameters)) throw new Error("Noir ABI parameters must be an array");
  for (let index = 0; index < account.parameters.length; index++) {
    const parameter = account.parameters[index] as unknown;
    if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) {
      throw new Error(`Noir ABI parameter ${index} must be an object`);
    }
  }
  for (let index = 0; index < account.parameters.length; index++) {
    if ((account.parameters[index] as NoirAbiParameter).visibility !== "private") {
      throw new Error(`Noir ABI parameter ${index} must be private`);
    }
  }
  const returnType = account.return_type as {
    abi_type?: { kind?: unknown; length?: unknown; type?: unknown };
    visibility?: unknown;
  } | null;
  if (
    returnType === null
    || returnType.visibility !== "databus"
    || returnType.abi_type?.kind !== "array"
    || returnType.abi_type.length !== PCASH_APPLICATION_RETURN_FIELDS
    || !isNoirFieldType(returnType.abi_type.type)
  ) {
    throw new Error("PCASH contract ABI must return a four-Field databus statement");
  }
  if (
    account.abi_version !== NOIR_ABI_VERSION
    || !account.error_types
    || typeof account.error_types !== "object"
    || Array.isArray(account.error_types)
    || Object.keys(account).length !== 4
  ) {
    throw new Error(`Noir ABI must contain exactly abi_version ${NOIR_ABI_VERSION}, parameters, return_type, and error_types`);
  }
}

/** Require publisher proof metadata to cover every ABI parameter exactly once. */
export function assertContractFunctionPresentationAbi(
  presentation: ContractFunctionPresentation,
  abi: unknown,
): void {
  validatePcashNoirAbi(abi);
  const expected = new Set<string>();
  for (let index = 0; index < abi.parameters.length; index++) {
    const name = abi.parameters[index]!.name;
    assertNoirIdentifier(name, `Noir ABI parameter ${index}`);
    if (expected.has(name)) throw new Error(`Noir ABI has duplicate parameter ${name}`);
    expected.add(name);
  }
  const described = new Set<string>();
  for (const group of presentation.proofGroups) {
    for (const item of group.items) {
      if (!expected.has(item.abiParameter)) {
        throw new Error(`${presentation.name} presentation references unknown ABI parameter ${item.abiParameter}`);
      }
      if (described.has(item.abiParameter)) {
        throw new Error(`${presentation.name} presentation describes ABI parameter ${item.abiParameter} more than once`);
      }
      described.add(item.abiParameter);
    }
  }
  const missing = [...expected].filter((name) => !described.has(name));
  if (missing.length > 0) throw new Error(`${presentation.name} presentation omits ABI parameter(s): ${missing.join(", ")}`);
}

export function verificationKeyFields(rawVerificationKey: Uint8Array): bigint[] {
  const expectedBytes = VK_LEN * 32;
  if (rawVerificationKey.length !== expectedBytes) {
    throw new Error(`verification key must be ${VK_LEN} 32-byte fields (${expectedBytes} bytes), got ${rawVerificationKey.length}`);
  }
  const fields: bigint[] = [];
  for (let offset = 0; offset < rawVerificationKey.length; offset += 32) {
    const field = bytesToBigInt(rawVerificationKey.subarray(offset, offset + 32));
    if (field >= BN254_SCALAR_MODULUS) throw new Error(`verification key field ${offset / 32} is not canonical`);
    fields.push(field);
  }
  return fields;
}

export function applicationVkHash(rawVerificationKey: Uint8Array): bigint {
  return computeCircuitVkHash(verificationKeyFields(rawVerificationKey));
}

export function configurationProfileValues(
  profile: ContractConfigurationProfile,
  input: Readonly<Record<string, FieldNumberish>>,
): bigint[] {
  const expectedNames = new Set(profile.fields.map((field) => field.name));
  for (const name of Object.keys(input)) if (!expectedNames.has(name)) throw new Error(`unexpected ${profile.id} field ${name}`);
  return profile.fields.map((field) => {
    if (!Object.prototype.hasOwnProperty.call(input, field.name)) throw new Error(`missing ${profile.id} field ${field.name}`);
    const value = toNonnegativeBigInt(input[field.name]!, field.name);
    if (field.bits !== undefined && value >= 1n << BigInt(field.bits)) {
      throw new Error(`${field.name} does not fit ${field.type}`);
    }
    return toField(value, field.name);
  });
}

export function configurationProfileCommitment(
  profile: ContractConfigurationProfile,
  input: Readonly<Record<string, FieldNumberish>>,
): bigint {
  return poseidon([toField(profile.domain, "configuration domain"), ...configurationProfileValues(profile, input)]);
}

export function assertSourceVerificationManifest(value: unknown): asserts value is ContractSourceVerificationManifest {
  if (!value || typeof value !== "object") throw new Error("source verification manifest must be an object");
  const manifest = value as Partial<ContractSourceVerificationManifest>;
  if (manifest.schemaVersion !== SOURCE_VERIFICATION_SCHEMA_VERSION || manifest.bundleFormat !== SOURCE_VERIFICATION_BUNDLE_FORMAT) {
    throw new Error("unsupported source verification manifest version");
  }
  if (!Array.isArray(manifest.implementations) || manifest.implementations.length === 0) {
    throw new Error("source verification manifest must contain implementations");
  }
  if (!Array.isArray(manifest.configurationBindings) || manifest.configurationBindings.length === 0) {
    throw new Error("source verification manifest must contain configurationBindings");
  }
  if (
    manifest.proofProfile?.id !== SOURCE_VERIFICATION_PROOF_PROFILE
    || manifest.proofProfile.returnFields !== PCASH_APPLICATION_RETURN_FIELDS
    || manifest.proofProfile.returnVisibility !== "databus"
  ) {
    throw new Error("source verification manifest has the wrong proof profile");
  }
  if (!Array.isArray(manifest.configurationOpenings)) throw new Error("configurationOpenings must be an array");
  const applicationVkHashes = new Set<string>();
  for (let index = 0; index < manifest.implementations.length; index++) {
    const implementation = manifest.implementations[index] as Partial<SourceVerifiedImplementation>;
    assertFieldHex(implementation.applicationVkHash, `implementations[${index}].applicationVkHash`);
    if (applicationVkHashes.has(implementation.applicationVkHash)) {
      throw new Error(`duplicate applicationVkHash ${implementation.applicationVkHash}`);
    }
    applicationVkHashes.add(implementation.applicationVkHash);
  }
  const boundApplicationVkHashes = new Set<string>();
  for (let index = 0; index < manifest.configurationBindings.length; index++) {
    const binding = manifest.configurationBindings[index] as Partial<ContractConfigurationBinding>;
    assertFieldHex(binding.applicationVkHash, `configurationBindings[${index}].applicationVkHash`);
    if (!applicationVkHashes.has(binding.applicationVkHash)) {
      throw new Error(`configurationBindings[${index}] names an implementation absent from the bundle`);
    }
    boundApplicationVkHashes.add(binding.applicationVkHash);
    assertConfigurationProfile(binding.configurationProfile, `configurationBindings[${index}].configurationProfile`);
  }
  if (boundApplicationVkHashes.size !== applicationVkHashes.size) {
    throw new Error("every source implementation must be used by a configuration binding");
  }
  assertContractPresentationProfile(manifest.presentation, manifest.configurationBindings);
}
