// The dedicated source-verification surface served on the node's `pscan_*`
// listener (`--pscan-addr`), reached by URL — never through the ordinary
// `pcash_*` node endpoint. Reads and the permissionless submission channel
// live here; operator publication is an `admin_*` method on the operator-only
// listener, in ./adminClient.ts.
//
// These are the shapes the service SERVES. ../source-verification/ holds the
// operator-side manifest a publisher PRODUCES; they describe the same subject
// from opposite ends and are deliberately different types.
//
// Every view embeds the same authenticated contract payload `pcash_getContract`
// returns, and it is verified here through the same `parseContractResult` — a
// reader that labels a contract "verified" must have checked the account proof
// behind that label, not merely deserialized a response saying so.

import type { PcashNodeClient, VerifiedContract } from "./nodeClient.ts";
import { PcashNodeClient as PcashNodeClientClass } from "./nodeClient.ts";
import {
  array,
  bool,
  nodeRpc,
  nullable,
  oneOf,
  present,
  quantity,
  rpcObject,
  rpcString,
  shape,
  SOURCE_PUBLICATION_MAX_BODY_BYTES,
  str,
  type NodeRpcOptions,
  type Parser,
} from "./jsonRpc.ts";
import { BN254_SCALAR_MODULUS } from "../crypto/field.ts";
import { numberToHex } from "viem";

export type SourceVerificationServiceStatus = "disabled" | "ready" | "unavailable";
export type SubmissionStatus = "disabled" | "ready" | "unavailable";
export type ContractSourceStatus = "verified" | "not_verified";
export type ConfigurationOpeningStatus = "verified" | "invalid";

// The read-side wire allowlist is intentionally local. Publisher manifest
// types live in the higher source-verification layer and must not enter the
// lightweight RPC client dependency graph.
const PUBLISHED_CONTRACT_PRESENTATION_DISPLAY_FORMATS = [
  "field",
  "uint",
  "hex",
  "ethereum-address",
  "pcash-amount",
  "eth-amount",
  "unix-timestamp",
  "chain-id",
] as const;
export type PublishedContractPresentationDisplayFormat =
  typeof PUBLISHED_CONTRACT_PRESENTATION_DISPLAY_FORMATS[number];

export interface SourceVerificationInfo {
  status: SourceVerificationServiceStatus;
  /** Whether this node accepts validated source publications at all. */
  writable: boolean;
  verificationAuthority: string;
  verificationMethod: string;
  manifestSchemaVersion: bigint;
  serviceName: string | null;
  implementationCount: bigint;
  configurationOpeningCount: bigint;
  invalidConfigurationOpeningCount: bigint;
  /** Chain identity of the registry's node, for pinning against the RPC node. */
  pcashChainId: number;
  genesisHash: string | null;
  /** Health of permissionless source-package submissions on this listener. */
  sourceSubmissionStatus: SubmissionStatus;
  /** Health of bounded configuration-opening submissions on this listener. */
  configurationOpeningSubmissionStatus: SubmissionStatus;
  /** Implementations currently served from accepted public submissions. */
  submittedImplementationCount: bigint;
  error: string | null;
}

/** A self-contained publication: the operator bundle plus its attachment bytes. */
export interface SourceVerificationPublication {
  manifest: unknown;
  /** Standard padded base64 bytes keyed by the manifest attachment path. */
  attachments: Record<string, string>;
}

/** One permissionless submission: a target contract plus the publication. */
export interface SubmittedSourceEnvelope {
  /** 20-byte address the submission claims correspondence for. */
  contractAddresses: string[];
  publication: SourceVerificationPublication;
}

export interface SubmitContractSourceResult {
  contentId: string;
  /** True when this exact publication was accepted earlier; nothing was revalidated. */
  deduplicated: boolean;
  /** Implementations this node rebuilt before accepting the publication. */
  reproducedImplementations: bigint;
  configurationOpeningCount: bigint;
  implementations: {
    applicationVkHash: string;
    verificationAuthority: string;
    verificationMethod: string;
  }[];
}

/** One live function's positional configuration opening. */
export interface ContractConfigurationOpeningInput {
  selector: number;
  applicationVkHash: string;
  configurationCommitment: string;
  domain: string;
  values: string[];
}

/** A complete opening set for one already source-verified contract instance. */
export interface ContractConfigurationOpeningSubmission {
  contractAddress: string;
  openings: ContractConfigurationOpeningInput[];
}

/** Acceptance of instance data only; this is not source or audit provenance. */
export interface SubmitContractConfigurationOpeningsResult {
  contractAddress: string;
  contentId: string;
  configurationOpeningCount: bigint;
  deduplicated: boolean;
}

/** Why a contract is or is not verified: per-selector registry presence. */
export interface ContractVerificationSummary {
  address: string;
  verified: boolean;
  functions: {
    selector: VerifiedContract["functions"][number]["selector"];
    name?: string | undefined;
    applicationVkHash: string;
    inRegistry: boolean;
  }[];
}

/** The authenticated contract parsing the views reuse from the node client. */
export type ContractParser = Pick<PcashNodeClient, "parseContractResult">;

export interface SourceToolchain {
  releaseManifestSha256: string;
  producerPlatform: string;
  nargo: { version: string; noircCommit: string; archiveSha256: string };
  barretenberg: { version: string; verifierTarget: string; archiveSha256: string };
  crs: { bn254G1Sha256: string; bn254G2Sha256: string };
}

export interface PublishedImplementation {
  verificationStatus: string;
  verificationAuthority: string;
  verificationMethod: string;
  applicationVkHash: string;
  implementationLabel: string;
  packageRoot: string;
  packageName: string;
  sourceBundleDigest: string;
  compilerArtifactSha256: string;
  decodedAcirSha256: string;
  noirProvingAbiSha256: string;
  verificationKeySha256: string;
  verificationKeyFieldCount: bigint;
  toolchain: SourceToolchain;
}

export interface PublishedConfigurationValue {
  position: bigint;
  value: string;
  name: string | null;
  type: string | null;
}

export interface PublishedConfigurationOpening {
  selector: bigint;
  status: ConfigurationOpeningStatus;
  scheme: string;
  domain: string | null;
  values: PublishedConfigurationValue[];
  expectedConfigurationCommitment: string;
  computedConfigurationCommitment: string | null;
  error: string | null;
}

export interface PublishedContractConfigurationFieldPresentation {
  position: bigint;
  name: string;
  label: string;
  description: string;
  displayFormat: PublishedContractPresentationDisplayFormat;
  overviewOrder: bigint | null;
}

export interface PublishedContractProofInputPresentation {
  abiParameter: string;
  description: string;
}

export interface PublishedContractProofGroupPresentation {
  title: string;
  description: string;
  items: PublishedContractProofInputPresentation[];
}

export interface PublishedContractFunctionPresentation {
  selector: bigint;
  applicationVkHash: string;
  name: string;
  summary: string;
  configurationFields: PublishedContractConfigurationFieldPresentation[];
  proofGroups: PublishedContractProofGroupPresentation[];
}

export interface PublishedContractPresentationProfile {
  schemaVersion: bigint;
  /** Self-declared by the source publisher; not a verification authority. */
  publisherLabel: string;
  contractName: string;
  contractDescription: string;
  functions: PublishedContractFunctionPresentation[];
}

export interface ContractPresentationView {
  /** Pscan ingestion provenance, separate from profile.publisherLabel. */
  verificationAuthority: string;
  verificationMethod: string;
  profile: PublishedContractPresentationProfile;
}

export interface ContractSourceView {
  address: string;
  verificationStatus: ContractSourceStatus;
  /** Authenticated against its account proof, not merely decoded. */
  contract: VerifiedContract;
  implementations: PublishedImplementation[];
  configurationOpenings: PublishedConfigurationOpening[];
  /** Required for verified source; null for an unverified contract. */
  presentation: ContractPresentationView | null;
}

export interface SourceFileMetadata {
  path: string;
  length: bigint;
  sha256: string;
}

export interface ImplementationSourceView {
  implementation: PublishedImplementation;
  sourceFiles: SourceFileMetadata[];
  noirProvingAbi: unknown;
}

export interface ImplementationSourceFile {
  applicationVkHash: string;
  path: string;
  sha256: string;
  content: string;
}

export interface ImplementationBundle {
  source: ImplementationSourceView;
  files: ImplementationSourceFile[];
}

export interface ContractSourceBundle {
  contract: ContractSourceView;
  implementations: ImplementationBundle[];
}

function exactObject(value: unknown, label: string, fields: readonly string[]): Record<string, unknown> {
  const object = rpcObject(value, label);
  const allowed = new Set(fields);
  const unknown = Object.keys(object).find((field) => !allowed.has(field));
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`);
  const missing = fields.find((field) => !Object.hasOwn(object, field));
  if (missing !== undefined) throw new Error(`${label}.${missing} is required`);
  return object;
}

function canonicalFieldHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be a 32-byte 0x-prefixed hex field`);
  }
  if (BigInt(value) >= BN254_SCALAR_MODULUS) {
    throw new Error(`${label} must be a canonical BN254 field`);
  }
  return value;
}

function digestHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be 32-byte 0x-prefixed hex`);
  }
  return value;
}

function addressHexValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${label} must be 20-byte 0x-prefixed hex`);
  }
  return value;
}

const availability = oneOf("disabled", "ready", "unavailable");

const parseToolchain: Parser<SourceToolchain> = shape({
  releaseManifestSha256: str,
  producerPlatform: str,
  nargo: shape({ version: str, noircCommit: str, archiveSha256: str }),
  barretenberg: shape({ version: str, verifierTarget: str, archiveSha256: str }),
  crs: shape({ bn254G1Sha256: str, bn254G2Sha256: str }),
});

const parseImplementation: Parser<PublishedImplementation> = shape({
  verificationStatus: str,
  verificationAuthority: str,
  verificationMethod: str,
  applicationVkHash: str,
  implementationLabel: str,
  packageRoot: str,
  packageName: str,
  sourceBundleDigest: str,
  compilerArtifactSha256: str,
  decodedAcirSha256: str,
  noirProvingAbiSha256: str,
  verificationKeySha256: str,
  verificationKeyFieldCount: quantity,
  toolchain: parseToolchain,
});

const parseConfigurationOpening: Parser<PublishedConfigurationOpening> = shape({
  selector: quantity,
  status: oneOf("verified", "invalid"),
  scheme: str,
  domain: nullable(str),
  values: array(shape({ position: quantity, value: str, name: nullable(str), type: nullable(str) })),
  expectedConfigurationCommitment: str,
  computedConfigurationCommitment: nullable(str),
  error: nullable(str),
});

const parseConfigurationField = shape({
  position: quantity,
  name: str,
  label: str,
  description: str,
  displayFormat: oneOf(...PUBLISHED_CONTRACT_PRESENTATION_DISPLAY_FORMATS),
  overviewOrder: nullable(quantity),
});

const parseProofGroup: Parser<PublishedContractProofGroupPresentation> = shape({
  title: str,
  description: str,
  items: array(shape({ abiParameter: str, description: str })),
});

const parsePresentationFunction = shape({
  selector: quantity,
  applicationVkHash: str,
  name: str,
  summary: str,
  configurationFields: array(parseConfigurationField),
  proofGroups: array(parseProofGroup),
});

const parsePresentationView = shape({
  verificationAuthority: str,
  verificationMethod: str,
  profile: shape({
    schemaVersion: quantity,
    publisherLabel: str,
    contractName: str,
    contractDescription: str,
    functions: array(parsePresentationFunction),
  }),
});

/** A publisher's presentation, bound to the authenticated contract it describes. */
function parseContractPresentation(
  value: unknown,
  contract: VerifiedContract,
  label: string,
): ContractPresentationView {
  const view = parsePresentationView(value, label);
  const { profile } = view;
  if (profile.schemaVersion !== 1n) throw new Error(`${label}.profile.schemaVersion must be 1`);
  if (profile.functions.length !== contract.functions.length) {
    throw new Error(`${label}.profile.functions does not match the authenticated contract shape`);
  }
  profile.functions.forEach((fn, functionIndex) => {
    const functionLabel = `${label}.profile.functions[${functionIndex}]`;
    const authenticated = contract.functions[functionIndex]!;
    if (
      fn.selector !== BigInt(authenticated.selector)
      || fn.applicationVkHash.toLowerCase() !== authenticated.applicationVkHash.toLowerCase()
    ) {
      throw new Error(`${functionLabel} does not match the authenticated contract shape`);
    }
    fn.configurationFields.forEach((field, fieldIndex) => {
      if (field.position !== BigInt(fieldIndex)) {
        throw new Error(`${functionLabel}.configurationFields[${fieldIndex}].position must be ${fieldIndex}`);
      }
    });
  });
  return view;
}

const parseSourceFile: Parser<SourceFileMetadata> = shape({ path: str, length: quantity, sha256: str });

const parseImplementationSourceFile: Parser<ImplementationSourceFile> = shape({
  applicationVkHash: str,
  path: str,
  sha256: str,
  content: str,
});

const parseImplementationSource: Parser<ImplementationSourceView> = shape({
  implementation: parseImplementation,
  sourceFiles: array(parseSourceFile),
  noirProvingAbi: present,
});

function verifiedContract(
  contracts: ContractParser,
  value: Record<string, unknown>,
  address: string,
  label: string,
): VerifiedContract {
  const contract = contracts.parseContractResult(value, address);
  // A source view exists only for a live contract, so anything else means the
  // registry and the chain disagree — surface that rather than render it.
  if (contract.status !== "contract") {
    throw new Error(`${label} published source for a ${contract.status} address`);
  }
  return contract;
}

function parseContractSourceView(
  contracts: ContractParser,
  value: unknown,
  address: string,
  label: string,
): ContractSourceView {
  const v = rpcObject(value, label);
  const returnedAddress = rpcString(v.address, `${label}.address`);
  if (returnedAddress.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`${label} answered for a different contract address`);
  }
  const status = oneOf("verified", "not_verified")(v.verificationStatus, `${label}.verificationStatus`);
  const implementations = array(parseImplementation)(v.implementations, `${label}.implementations`);
  const configurationOpenings = array(parseConfigurationOpening)(v.configurationOpenings, `${label}.configurationOpenings`);
  const contract = verifiedContract(
    contracts,
    rpcObject(v.contract, `${label}.contract`),
    returnedAddress,
    label,
  );
  const presentation = nullable((value, presentationLabel) => parseContractPresentation(value, contract, presentationLabel))(
    v.presentation,
    `${label}.presentation`,
  );
  if ((status === "verified") !== (presentation !== null)) {
    throw new Error(`${label}.presentation must be present exactly when source is verified`);
  }
  return {
    address: returnedAddress,
    verificationStatus: status,
    contract,
    implementations,
    configurationOpenings,
    presentation,
  };
}

/**
 * Registry status as either listener reports it: `pscan_sourceVerificationInfo`
 * and `admin_publishSourceVerification` answer with the same object.
 */
export const parseSourceVerificationInfo: Parser<SourceVerificationInfo> = shape({
  status: availability,
  writable: bool,
  verificationAuthority: str,
  verificationMethod: str,
  manifestSchemaVersion: quantity,
  serviceName: nullable(str),
  implementationCount: quantity,
  configurationOpeningCount: quantity,
  invalidConfigurationOpeningCount: quantity,
  pcashChainId: (value, label) => Number(quantity(value, label)),
  genesisHash: nullable(str),
  sourceSubmissionStatus: availability,
  configurationOpeningSubmissionStatus: availability,
  submittedImplementationCount: quantity,
  error: nullable(str),
});

/** The named surface of the dedicated `pscan_*` JSON-RPC listener. */
export interface PscanClient {
  sourceVerificationInfo(): Promise<SourceVerificationInfo>;
  getContractSource(address: string): Promise<ContractSourceView | null>;
  getImplementationSource(applicationVkHash: string): Promise<ImplementationSourceView | null>;
  getImplementationSourceFile(applicationVkHash: string, path: string): Promise<ImplementationSourceFile | null>;
  getContractSourceBundle(address: string): Promise<ContractSourceBundle | null>;
  submitContractSource(envelope: SubmittedSourceEnvelope): Promise<SubmitContractSourceResult>;
  submitContractConfigurationOpenings(
    submission: ContractConfigurationOpeningSubmission,
  ): Promise<SubmitContractConfigurationOpeningsResult>;
  contractVerificationSummary(address: string): Promise<ContractVerificationSummary>;
}

/**
 * A client for the dedicated `pscan_*` listener — pass its URL, not the
 * ordinary node RPC URL. Contract views are authenticated through
 * {@link PcashNodeClient.parseContractResult}; when no parser is supplied, a
 * parser-only node client is constructed (it never performs network I/O of
 * its own).
 */
export function createPscanClient(
  url: string,
  options: NodeRpcOptions = {},
  contracts: ContractParser = new PcashNodeClientClass(url),
): PscanClient {
  const rpc = nodeRpc(url, SOURCE_PUBLICATION_MAX_BODY_BYTES, options);
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    return await rpc(method, params) as T;
  }

  const client: PscanClient = {
    async sourceVerificationInfo(): Promise<SourceVerificationInfo> {
      return parseSourceVerificationInfo(
        await call("pscan_sourceVerificationInfo", []),
        "sourceVerificationInfo",
      );
    },

    async getContractSource(address: string): Promise<ContractSourceView | null> {
      const r = await call<unknown>("pscan_getContractSource", [address]);
      if (r === null) return null;
      return parseContractSourceView(contracts, r, address, "contractSource");
    },

    async getImplementationSource(applicationVkHash: string): Promise<ImplementationSourceView | null> {
      const r = await call<unknown>("pscan_getImplementationSource", [applicationVkHash]);
      if (r === null) return null;
      const view = parseImplementationSource(r, "implementationSource");
      if (
        view.implementation.applicationVkHash.toLowerCase() !== applicationVkHash.toLowerCase()
      ) throw new Error("implementationSource answered for a different implementation");
      return view;
    },

    async getImplementationSourceFile(
      applicationVkHash: string,
      path: string,
    ): Promise<ImplementationSourceFile | null> {
      const r = await call<unknown>("pscan_getImplementationSourceFile", [applicationVkHash, path]);
      if (r === null) return null;
      const file = parseImplementationSourceFile(r, "implementationSourceFile");
      if (
        file.applicationVkHash.toLowerCase() !== applicationVkHash.toLowerCase()
        || file.path !== path
      ) throw new Error("implementationSourceFile answered for a different file");
      return file;
    },

    async getContractSourceBundle(address: string): Promise<ContractSourceBundle | null> {
      const r = await call<unknown>("pscan_getContractSourceBundle", [address]);
      if (r === null) return null;
      return shape({
        contract: (value, label) => parseContractSourceView(contracts, value, address, label),
        implementations: array(shape({ source: parseImplementationSource, files: array(parseImplementationSourceFile) })),
      })(r, "contractSourceBundle");
    },

    async submitContractSource(envelope: SubmittedSourceEnvelope): Promise<SubmitContractSourceResult> {
      const label = "submitContractSource";
      if (!Array.isArray(envelope.contractAddresses) || envelope.contractAddresses.length === 0) {
        throw new Error(`${label}.contractAddresses must name at least one contract`);
      }
      for (const address of envelope.contractAddresses) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
          throw new Error(`${label}.contractAddresses must be 20-byte hex`);
        }
      }
      return shape({
        contentId: str,
        deduplicated: bool,
        reproducedImplementations: quantity,
        configurationOpeningCount: quantity,
        implementations: array(shape({ applicationVkHash: str, verificationAuthority: str, verificationMethod: str })),
      })(await call<unknown>("pscan_submitContractSource", [envelope]), label);
    },

    async submitContractConfigurationOpenings(
      submission: ContractConfigurationOpeningSubmission,
    ): Promise<SubmitContractConfigurationOpeningsResult> {
      const label = "submitContractConfigurationOpenings";
      const request = exactObject(submission, label, ["contractAddress", "openings"]);
      const contractAddress = addressHexValue(request.contractAddress, `${label}.contractAddress`);
      if (!Array.isArray(request.openings) || request.openings.length === 0) {
        throw new Error(`${label}.openings must name at least one contract function`);
      }
      const selectors = new Set<number>();
      const openings = request.openings.map((raw, index) => {
        const openingLabel = `${label}.openings[${index}]`;
        const opening = exactObject(raw, openingLabel, [
          "selector",
          "applicationVkHash",
          "configurationCommitment",
          "domain",
          "values",
        ]);
        if (
          typeof opening.selector !== "number"
          || !Number.isInteger(opening.selector)
          || opening.selector < 0
          || opening.selector > 0xff
        ) {
          throw new Error(`${openingLabel}.selector must be an integer from 0 through 255`);
        }
        if (selectors.has(opening.selector)) {
          throw new Error(`${label}.openings has duplicate selector ${opening.selector}`);
        }
        selectors.add(opening.selector);
        if (!Array.isArray(opening.values)) {
          throw new Error(`${openingLabel}.values must be an array`);
        }
        return {
          selector: numberToHex(BigInt(opening.selector)),
          applicationVkHash: canonicalFieldHex(
            opening.applicationVkHash,
            `${openingLabel}.applicationVkHash`,
          ),
          configurationCommitment: canonicalFieldHex(
            opening.configurationCommitment,
            `${openingLabel}.configurationCommitment`,
          ),
          domain: canonicalFieldHex(opening.domain, `${openingLabel}.domain`),
          values: opening.values.map((value, position) =>
            canonicalFieldHex(value, `${openingLabel}.values[${position}]`)
          ),
        };
      });
      const wireSubmission = { contractAddress, openings };
      const result = exactObject(
        await call<unknown>("pscan_submitContractConfigurationOpenings", [wireSubmission]),
        label,
        ["contractAddress", "contentId", "configurationOpeningCount", "deduplicated"],
      );
      const returnedAddress = addressHexValue(result.contractAddress, `${label}.contractAddress`);
      if (returnedAddress.toLowerCase() !== contractAddress.toLowerCase()) {
        throw new Error(`${label} answered for a different contract address`);
      }
      const configurationOpeningCount = quantity(result.configurationOpeningCount, `${label}.configurationOpeningCount`);
      if (configurationOpeningCount !== BigInt(openings.length)) {
        throw new Error(`${label}.configurationOpeningCount does not match the submitted set`);
      }
      return {
        contractAddress: returnedAddress,
        contentId: digestHex(result.contentId, `${label}.contentId`),
        configurationOpeningCount,
        deduplicated: bool(result.deduplicated, `${label}.deduplicated`),
      };
    },

    /**
     * Why a contract is or is not verified: every function of its committed
     * set with a registry-presence flag. An unverified contract view omits
     * registry summaries by design, so this point-query diff is the only way
     * to see which selector blocks verification.
     */
    async contractVerificationSummary(address): Promise<ContractVerificationSummary> {
      const view = await client.getContractSource(address);
      if (view === null) throw new Error(`no live contract at ${address}`);
      const functions: ContractVerificationSummary["functions"] = [];
      for (const fn of view.contract.functions) {
        const found = await client.getImplementationSource(fn.applicationVkHash);
        const entry: ContractVerificationSummary["functions"][number] = {
          selector: fn.selector,
          applicationVkHash: fn.applicationVkHash,
          inRegistry: found !== null,
        };
        const name = found?.implementation.implementationLabel;
        if (name !== undefined && name !== "") entry.name = name;
        functions.push(entry);
      }
      return { address: view.address, verified: view.verificationStatus === "verified", functions };
    },
  };
  return client;
}
