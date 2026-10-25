// PCASH wire codec (batch calldata, txBytes, body).
// All integers are unsigned big-endian; field elements are 32-byte BE.
//
// Every transaction begins with type(u8) ‖ pcashChainId(u32be).
//   privateValueSection: wireWords×serializedPubInput(32) ‖ proof ‖ O×outputData ‖ arena
//     wireWords is I+O+7; account fee sections also omit the zero issuance word.
//     The proof is the WIRE_PROOF_BYTES body without its public-input prefix;
//     each output-data item is exactly OUTPUT_DATA_BYTES and the arena exactly
//     the profile's arenaBytes.
//   receiveKey: mode(u8: 0 absent, 1 present) ‖ 1184 key bytes when present
// Private-value I/O capacities come from the subtype; account fee sections use S.
// type 0 private value: envelope ‖ shape(u8) ‖ privateValueSection
// type 1 user account creation: envelope ‖ authorizationMode ‖ creation fields ‖ optional signature
// type 2 contract account creation: envelope ‖ fundingMode(u8) ‖ funding ‖ contractBody
//   mode 0 unfunded: recentPcashBlockHash(32) ‖ validUntilTimestamp(u64)
//   mode 1 sponsored: privateValueSection
// type 3 user account update: envelope ‖ proposedAccountFields ‖ accountUpdateCommitment ‖ privateValueSection
//   batch calldata: version(1, 0x01) ‖ posterOwnerCommitment(32) ‖ posterContext(32) ‖ count(u16) ‖ count×[len(u32) ‖ txBytes]

import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
import { type FieldNumberish, toAddressField, toField, toNonnegativeBigInt } from "../crypto/field.ts";
import { beBytes, bytesToBigInt } from "../utils/bytes.ts";
import { ByteReader, ByteWriter } from "../utils/byteCursor.ts";
import { ML_KEM_768_PUBLIC_KEY_LENGTH, OUTPUT_DATA_BYTES } from "../constants/params.ts";
import { assertArena, deliveryCommitment } from "./transfer.ts";
import { assertOutputDataItems } from "./envelope.ts";

export const VERSION = 0x01;
export type BatchVersion = typeof VERSION;
export const TX_KIND_PRIVATE_VALUE = 0;
export const TX_KIND_USER_ACCOUNT_CREATION = 1;
export const TX_KIND_CONTRACT_ACCOUNT_CREATION = 2;
export const TX_KIND_USER_ACCOUNT_UPDATE = 3;
export const FUNDING_MODE_UNFUNDED = 0;
export const FUNDING_MODE_SPONSORED = 1;
/** A contract creation's funding mode follows the type byte and chain ID. */
export const FUNDING_MODE_OFFSET = 5;
export const RECEIVE_KEY_OPERATION_KEEP = 0;
export const RECEIVE_KEY_OPERATION_CLEAR = 1;
export const RECEIVE_KEY_OPERATION_REPLACE = 2;
export type TransactionType =
  | typeof TX_KIND_PRIVATE_VALUE
  | typeof TX_KIND_USER_ACCOUNT_CREATION
  | typeof TX_KIND_CONTRACT_ACCOUNT_CREATION
  | typeof TX_KIND_USER_ACCOUNT_UPDATE;

// Limits fixed by the network profile.
export const MAX_BATCH_ENTRIES = 1024;

// Wire sections omit the envelope chain ID at position 0 and the delivery
// commitment reconstructed from the attached output data and arena. A
// user-account update and a sponsored contract-account creation verify the S
// section's statement plus one word: the account update commitment, or the
// derived contract address.
export const PRIVATE_VALUE_PUBLIC_INPUTS = PRIVATE_VALUE_PROFILES.S.publicInputs;
export const PRIVATE_VALUE_WIRE_PUBLIC_INPUTS = PRIVATE_VALUE_PROFILES.S.wireInputs;
export const USER_ACCOUNT_UPDATE_PUBLIC_INPUTS = PRIVATE_VALUE_PUBLIC_INPUTS + 1;
export const CONTRACT_CREATION_PUBLIC_INPUTS = PRIVATE_VALUE_PUBLIC_INPUTS + 1;

export type PrivateValueOutputData = readonly Uint8Array[];

export type PrivateValueOutputDataOverrides = readonly (Uint8Array | undefined)[];

// Compressed CHONK proof body without the public-input prefix: the hiding
// kernel's IO words and the fixed-size compressed proof, 32 bytes each. The
// enclosing transaction supplies the statement, reconstructed before
// decompression.
const HIDING_KERNEL_IO_WORDS = 28;
const COMPRESSED_CHONK_FIXED_WORDS = 673;
export const WIRE_PROOF_BYTES = (HIDING_KERNEL_IO_WORDS + COMPRESSED_CHONK_FIXED_WORDS) * 32;

export type SectionLayout = { kind: "privateValue"; shape: PrivateValueShape }
  | { kind: "userAccountUpdate" | "contractAccountCreation" };

function sectionProfile(layout: SectionLayout) {
  return privateValueProfile(layout.kind === "privateValue" ? layout.shape : PRIVATE_VALUE_PROFILES.S.shapeId);
}

export function sectionWireInputs(layout: SectionLayout): number {
  return sectionProfile(layout).wireInputs - Number(layout.kind !== "privateValue");
}

/** Encoded section length: serialized words, the pinned-size proof, every output-data item, and the arena. */
export function privateValueSectionBytes(
  proofBytes: number, layout: SectionLayout = { kind: "privateValue", shape: PRIVATE_VALUE_PROFILES.S.shapeId },
): number {
  const profile = sectionProfile(layout);
  return sectionWireInputs(layout) * 32 + proofBytes + profile.outputs * OUTPUT_DATA_BYTES + profile.arenaBytes;
}

export function privateValueTransactionSize(shape: PrivateValueShape = PRIVATE_VALUE_PROFILES.S.shapeId): number {
  return 6 + privateValueSectionBytes(WIRE_PROOF_BYTES, { kind: "privateValue", shape });
}

export type ContractFundingMode = "unfunded" | "sponsored";

/** The funding payload after the mode byte: a recent block and deadline, or the sponsor's section. */
export function contractFundingBytes(funding: ContractFundingMode): number {
  return funding === "unfunded" ? 32 + 8 : privateValueSectionBytes(WIRE_PROOF_BYTES, { kind: "contractAccountCreation" });
}

export function contractAccountCreationSize(bodyByteSize: number, funding: ContractFundingMode): number {
  return 5 + 1 + contractFundingBytes(funding) + bodyByteSize;
}

/** `replacementKeyByteSize` is the ML-KEM key length for REPLACE, else zero. */
export function userAccountUpdateSize(replacementKeyByteSize: number): number {
  return 5 + 20 + 32 + 1 + replacementKeyByteSize + 32
    + privateValueSectionBytes(WIRE_PROOF_BYTES, { kind: "userAccountUpdate" });
}

export const PRIVATE_VALUE_MAX_TX_BYTES = Math.max(...Object.values(PRIVATE_VALUE_PROFILES).map((profile) =>
  privateValueTransactionSize(profile.shapeId)));
export const USER_ACCOUNT_AUTH_DIRECT = 0;
export const USER_ACCOUNT_AUTH_SIGNED = 1;
export const RECEIVE_KEY_ABSENT = 0;
export const RECEIVE_KEY_PRESENT = 1;

/** Signed creation with a receive key: mode, three words, the key, the deadline, and the signature. */
export const USER_ACCOUNT_CREATION_MAX_TX_BYTES =
  5 + 1 + 32 + 32 + 1 + ML_KEM_768_PUBLIC_KEY_LENGTH + 32 + 8 + 32 + 32 + 1;

/**
 * selector(1) + applicationVkHash(32) + configurationCommitment(32).
 * A contract function's account-rule blinder is the canonical `0` and is not
 * serialized: a contract publishes its complete function list on Ethereum DA,
 * so a published per-function blinder hides nothing.
 */
export const CONTRACT_FUNCTION_BYTES = 1 + 32 * 2;
/**
 * Maximum unsigned contract-account body: the publishesNkRoot tag and its one
 * 32-byte nullifier-key material field, a present receive key, and all 255
 * function entries. `functionSetCommitment` is derived from the function list,
 * never serialized beside it.
 */
export const CONTRACT_MAX_BODY_BYTES =
  1 +
  32 +
  1 +
  ML_KEM_768_PUBLIC_KEY_LENGTH +
  1 +
  255 * CONTRACT_FUNCTION_BYTES;
/** Maximum type 2 transaction: envelope, sponsored funding, and the contract-account body. */
export const CONTRACT_MAX_TX_BYTES = contractAccountCreationSize(CONTRACT_MAX_BODY_BYTES, "sponsored");

export const USER_ACCOUNT_UPDATE_MAX_TX_BYTES = userAccountUpdateSize(ML_KEM_768_PUBLIC_KEY_LENGTH);

/** Largest currently valid transaction shape, mirrored by RPC/P2P admission guards. */
export const MAX_VALID_TX_BYTES = Math.max(
  PRIVATE_VALUE_MAX_TX_BYTES,
  CONTRACT_MAX_TX_BYTES,
  USER_ACCOUNT_UPDATE_MAX_TX_BYTES,
);

// SDK decoders reject transactions above this bound, including items inside
// batch calldata. Node consensus instead excludes an intact oversized item while
// preserving its siblings; per-type decoders enforce the exact formats.
export const MAX_TX_BYTES = 131_072;

/**
 * An account action's S-profile private-value section: public inputs in
 * verifier order, proof, all output-data slots, and the arena. The section's
 * chain ID must equal the envelope's.
 */
export interface PrivateValueSectionInput {
  publicInputs: readonly FieldNumberish[];
  proof: Uint8Array;
  outputData: PrivateValueOutputData;
  arena: Uint8Array;
}

interface CanonicalSection {
  pcashChainId: number;
  serializedPublicInputs: bigint[];
  proof: Uint8Array;
  outputData: PrivateValueOutputData;
  arena: Uint8Array;
}

/**
 * Check a caller-supplied section against its layout. The wire carries no
 * length prefixes, so a proof, output-data item, or arena of the wrong size
 * would shift every following field.
 */
function canonicalSection(
  input: PrivateValueSectionInput,
  label: string,
  proofBytes: number,
  expectedPcashChainId?: number,
  layout: SectionLayout = { kind: "privateValue", shape: PRIVATE_VALUE_PROFILES.S.shapeId },
): CanonicalSection {
  const profile = sectionProfile(layout);
  assertOutputDataItems(input.outputData, profile.shapeId);
  assertArena(input.arena, profile.shapeId);
  const publicInputs = canonicalPublicInputs(input.publicInputs, profile.publicInputs, label);
  if (input.proof.length !== proofBytes) throw new Error(`${label} proof must be ${proofBytes} bytes`);
  const pcashChainId = pcashChainIdU32(publicInputs[0]!, `${label} public input 0`);
  if (expectedPcashChainId !== undefined && pcashChainId !== expectedPcashChainId) {
    throw new Error(`${label} section chain id does not match the envelope`);
  }
  if (layout.kind !== "privateValue" && publicInputs[profile.offsets.issuanceOwner] !== 0n) {
    throw new Error("account operations cannot designate issuance");
  }
  return {
    pcashChainId,
    serializedPublicInputs: publicInputs.filter((_, index) => serializedWordIndex(layout, index) !== null),
    proof: input.proof,
    outputData: input.outputData,
    arena: input.arena,
  };
}

/**
 * The serialized word holding verifier input `index` of a section, or null for
 * an input the section omits: the envelope chain ID, the delivery commitment,
 * or an account section's zero issuance word.
 */
function serializedWordIndex(layout: SectionLayout, index: number): number | null {
  const { offsets } = sectionProfile(layout);
  const account = layout.kind !== "privateValue";
  if (index === offsets.chainId) return null;
  if (index < offsets.deliveryCommitment) return index - 1;
  if (index === offsets.deliveryCommitment) return null;
  if (account && index === offsets.issuanceOwner) return null;
  return index - 2 - Number(account && index > offsets.issuanceOwner);
}

/** Write one private-value section: serialized words, the proof, the output data, and the arena. */
function writePrivateValueSection(w: ByteWriter, section: CanonicalSection): void {
  for (const pi of section.serializedPublicInputs) w.field(pi);
  w.bytes(section.proof);
  for (const data of section.outputData) w.bytes(data);
  w.bytes(section.arena);
}

function pcashChainIdU32(value: FieldNumberish, label = "pcashChainId"): number {
  const chainId = toNonnegativeBigInt(value, label);
  if (chainId >= 1n << 32n) throw new Error(`${label} must fit in u32`);
  return Number(chainId);
}

/** Canonical 32-byte verifier/signature word for the common-envelope chain ID. */
export function pcashChainIdWord(pcashChainId: number): Uint8Array {
  return beBytes(BigInt(pcashChainIdU32(pcashChainId)), 32);
}

function encodeEnvelope(type: TransactionType, pcashChainId: FieldNumberish, payload: Uint8Array): Uint8Array {
  const transaction = new ByteWriter().u8(type).u32(pcashChainIdU32(pcashChainId)).bytes(payload).done();
  if (transaction.length > MAX_TX_BYTES) throw new Error(`transaction exceeds MAX_TX_BYTES (${MAX_TX_BYTES})`);
  return transaction;
}

function canonicalPublicInputs(
  publicInputs: readonly FieldNumberish[],
  expectedCount: number,
  label: string,
): bigint[] {
  if (publicInputs.length !== expectedCount) {
    throw new Error(`${label} requires ${expectedCount} public inputs`);
  }
  return publicInputs.map((value, index) => toField(value, `${label} public input ${index}`));
}

/** A receive-key field: the presence mode, then the key when present. */
export function encodeReceiveKey(mlKemPublicKey: Uint8Array | undefined): Uint8Array {
  if (mlKemPublicKey === undefined) return Uint8Array.of(RECEIVE_KEY_ABSENT);
  if (mlKemPublicKey.length !== ML_KEM_768_PUBLIC_KEY_LENGTH) {
    throw new Error(`mlKemPublicKey must be ${ML_KEM_768_PUBLIC_KEY_LENGTH} bytes`);
  }
  return new ByteWriter().u8(RECEIVE_KEY_PRESENT).bytes(mlKemPublicKey).done();
}

export type UserAccountReceiveKeyUpdate =
  | { operation: "keep" }
  | { operation: "clear" }
  | { operation: "replace"; mlKemPublicKey: Uint8Array };

/** A user-account update's proposed fields: address, rule set, and the receive-key operation. */
export interface ProposedAccountFields {
  address: FieldNumberish;
  newRuleSetCommitment: FieldNumberish;
  receiveKey: UserAccountReceiveKeyUpdate;
}

/** `address(20) ‖ newRuleSetCommitment(32) ‖ operation(u8)`, then the key for REPLACE. */
export function encodeProposedAccountFields(fields: ProposedAccountFields): Uint8Array {
  const w = new ByteWriter()
    .bytes(beBytes(toAddressField(fields.address, "address"), 20))
    .field(fields.newRuleSetCommitment);
  if (fields.receiveKey.operation === "keep") return w.u8(RECEIVE_KEY_OPERATION_KEEP).done();
  if (fields.receiveKey.operation === "clear") return w.u8(RECEIVE_KEY_OPERATION_CLEAR).done();
  if (fields.receiveKey.mlKemPublicKey.length !== ML_KEM_768_PUBLIC_KEY_LENGTH) {
    throw new Error(`replacement mlKemPublicKey must be ${ML_KEM_768_PUBLIC_KEY_LENGTH} bytes`);
  }
  return w.u8(RECEIVE_KEY_OPERATION_REPLACE).bytes(fields.receiveKey.mlKemPublicKey).done();
}

export interface PrivateValueTransactionInput {
  shape?: PrivateValueShape;
  publicInputs: readonly FieldNumberish[];
  proof: Uint8Array;
  /**
   * All output slots of the selected profile and its arena. The codec omits
   * the delivery commitment word; the verifier statement reconstructs it from
   * these bytes.
   */
  outputData: PrivateValueOutputData;
  arena: Uint8Array;
}

export function encodePrivateValueTransaction(input: PrivateValueTransactionInput): Uint8Array {
  const shape = input.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId;
  const section = canonicalSection(input, "transfer", WIRE_PROOF_BYTES, undefined, { kind: "privateValue", shape });
  const w = new ByteWriter().u8(TX_KIND_PRIVATE_VALUE).u32(section.pcashChainId).u8(shape);
  writePrivateValueSection(w, section);
  const transaction = w.done();
  if (transaction.length > MAX_TX_BYTES) throw new Error(`transaction exceeds MAX_TX_BYTES (${MAX_TX_BYTES})`);
  return transaction;
}

export function encodeUserAccountCreation(
  pcashChainId: FieldNumberish,
  body: Uint8Array,
): Uint8Array {
  return encodeEnvelope(TX_KIND_USER_ACCOUNT_CREATION, pcashChainId, body);
}

/**
 * How a contract creation is funded. Unfunded creation names a recent block
 * and a deadline. Sponsored creation carries the sponsor's private-value
 * section: its statement is the payment, and the derived contract address is
 * the final verifier input, not serialized. A zero `openFeeAmount`
 * over all-dummy slots is a valid section.
 */
export type ContractFundingInput =
  | { mode: "unfunded"; recentPcashBlockHash: FieldNumberish; validUntilTimestamp: FieldNumberish }
  | { mode: "sponsored"; section: PrivateValueSectionInput };

/** Encode a contract-account creation: the funding mode and its payload, then the unsigned body. */
export function encodeContractAccountCreation(
  pcashChainId: FieldNumberish,
  body: Uint8Array,
  funding: ContractFundingInput,
): Uint8Array {
  const chainId = pcashChainIdU32(pcashChainId);
  const w = new ByteWriter().u8(TX_KIND_CONTRACT_ACCOUNT_CREATION).u32(chainId);
  if (funding.mode === "unfunded") {
    w.u8(FUNDING_MODE_UNFUNDED)
      .field(toField(funding.recentPcashBlockHash, "recentPcashBlockHash"))
      .u64(toNonnegativeBigInt(funding.validUntilTimestamp, "validUntilTimestamp"));
  } else {
    const section = canonicalSection(funding.section, "contract creation fee", WIRE_PROOF_BYTES, chainId, { kind: "contractAccountCreation" });
    w.u8(FUNDING_MODE_SPONSORED);
    writePrivateValueSection(w, section);
  }
  const transaction = w.bytes(body).done();
  if (transaction.length > MAX_TX_BYTES) throw new Error(`contract creation exceeds MAX_TX_BYTES (${MAX_TX_BYTES})`);
  return transaction;
}

export interface UserAccountUpdateInput {
  pcashChainId: FieldNumberish;
  proposedAccountFields: ProposedAccountFields;
  accountUpdateCommitment: FieldNumberish;
  /** The fee payment section: its public inputs, proof, five output-data items, and arena. */
  section: PrivateValueSectionInput;
}

export function encodeUserAccountUpdate(input: UserAccountUpdateInput): Uint8Array {
  const chainId = pcashChainIdU32(input.pcashChainId);
  const section = canonicalSection(input.section, "user account update", WIRE_PROOF_BYTES, chainId, { kind: "userAccountUpdate" });
  const w = new ByteWriter()
    .u8(TX_KIND_USER_ACCOUNT_UPDATE)
    .u32(chainId)
    .bytes(encodeProposedAccountFields(input.proposedAccountFields))
    .field(input.accountUpdateCommitment);
  writePrivateValueSection(w, section);
  const transaction = w.done();
  if (transaction.length > MAX_TX_BYTES) {
    throw new Error(`user account update exceeds MAX_TX_BYTES (${MAX_TX_BYTES})`);
  }
  return transaction;
}

function assertBatchVersion(version: number): asserts version is BatchVersion {
  if (version !== VERSION) {
    throw new Error(`unsupported batch version ${version}`);
  }
}

/** Exact count-and-length-delimited bytes committed by poster recovery. */
export function encodeBatchItems(items: readonly Uint8Array[]): Uint8Array {
  if (items.length > MAX_BATCH_ENTRIES) throw new Error("too many batch items");
  const w = new ByteWriter().u16(items.length);
  for (const [index, item] of items.entries()) {
    if (item.length > MAX_TX_BYTES) throw new Error(`batch item ${index} exceeds MAX_TX_BYTES (${MAX_TX_BYTES})`);
    w.u32(item.length).bytes(item);
  }
  return w.done();
}

export function encodeBatchForVersion(
  items: readonly Uint8Array[],
  version: BatchVersion,
  posterOwnerCommitment: FieldNumberish,
  posterContext: FieldNumberish,
): Uint8Array {
  assertBatchVersion(version);
  return new ByteWriter().u8(version).field(toField(posterOwnerCommitment, "posterOwnerCommitment")).field(toField(posterContext, "posterContext")).bytes(encodeBatchItems(items)).done();
}

export function encodeBatch(items: readonly Uint8Array[], posterOwnerCommitment: FieldNumberish, posterContext: FieldNumberish): Uint8Array {
  return encodeBatchForVersion(items, VERSION, posterOwnerCommitment, posterContext);
}

// --- Decoding ---

/** A structurally decoded private-value section. */
export interface RawPrivateValueSection {
  layout: SectionLayout;
  /** Raw words actually serialized, in the selected profile’s order. */
  serializedPublicInputs: Uint8Array[];
  proof: Uint8Array;
  outputData: readonly Uint8Array[];
  arena: Uint8Array;
}

export interface RawPrivateValueTransaction extends RawPrivateValueSection {
  kind: 0;
  shape: PrivateValueShape;
  pcashChainId: number;
}

/**
 * A user-account creation names no address: direct mode creates the carrying
 * Ethereum transaction's sender, signed mode the signature's recovered signer.
 */
export interface RawUserAccountCreation {
  kind: 1;
  pcashChainId: number;
  body: Uint8Array;
  nullifierKeyCommitment: Uint8Array;
  ruleSetCommitment: Uint8Array;
  /** The ML-KEM-768 receive key, or null when absent. */
  mlKemPublicKey: Uint8Array | null;
  recentPcashBlockHash: Uint8Array;
  validUntilTimestamp: bigint;
  authorization:
    | { kind: "direct" }
    | { kind: "signed"; sigR: Uint8Array; sigS: Uint8Array; yParity: 0 | 1 };
}

export interface RawContractFunction {
  selector: number;
  applicationVkHash: Uint8Array;
  configurationCommitment: Uint8Array;
}

export interface RawContractBody {
  body: Uint8Array;
  publishesNkRoot: boolean;
  nullifierKeyMaterial: Uint8Array;
  /** The ML-KEM-768 receive key, or null when absent. */
  mlKemPublicKey: Uint8Array | null;
  functions: RawContractFunction[];
}

export type RawContractFunding =
  | { mode: "unfunded"; recentPcashBlockHash: Uint8Array; validUntilTimestamp: bigint }
  /** The sponsor's fee payment. */
  | { mode: "sponsored"; section: RawPrivateValueSection };

export interface RawContractAccountCreation extends RawContractBody {
  kind: 2;
  pcashChainId: number;
  funding: RawContractFunding;
}

export interface RawUserAccountUpdate {
  kind: 3;
  pcashChainId: number;
  body: Uint8Array;
  proposedAccountFields: Uint8Array;
  address: Uint8Array;
  newRuleSetCommitment: Uint8Array;
  receiveKey: UserAccountReceiveKeyUpdate;
  accountUpdateCommitment: Uint8Array;
  /** The fee payment: the account's own notes leave only as the fee and its change. */
  section: RawPrivateValueSection;
}

/** Structurally decoded transaction. Semantic-invalid bytes remain representable. */
export type RawTransaction =
  | RawPrivateValueTransaction
  | RawUserAccountCreation
  | RawContractAccountCreation
  | RawUserAccountUpdate;

/** Decode one private-value section of the given layout; the caller checks for trailing bytes. */
function decodePrivateValueSection(
  r: ByteReader,
  proofBytes: number,
  layout: SectionLayout = { kind: "privateValue", shape: PRIVATE_VALUE_PROFILES.S.shapeId },
): RawPrivateValueSection {
  const profile = sectionProfile(layout);
  const serializedPublicInputs: Uint8Array[] = [];
  for (let i = 0; i < sectionWireInputs(layout); i += 1) serializedPublicInputs.push(r.word());
  const proof = Uint8Array.from(r.bytes(proofBytes));
  const outputData: Uint8Array[] = [];
  for (let i = 0; i < profile.outputs; i += 1) outputData.push(Uint8Array.from(r.bytes(OUTPUT_DATA_BYTES)));
  const arena = Uint8Array.from(r.bytes(profile.arenaBytes));
  return { layout, serializedPublicInputs, proof, outputData, arena };
}

function decodeReceiveKey(r: ByteReader, label: string): Uint8Array | null {
  const mode = r.u8();
  if (mode === RECEIVE_KEY_ABSENT) return null;
  if (mode === RECEIVE_KEY_PRESENT) return Uint8Array.from(r.bytes(ML_KEM_768_PUBLIC_KEY_LENGTH));
  throw new Error(`unknown ${label} receive-key mode ${mode}`);
}

function decodePrivateValueTransaction(r: ByteReader, pcashChainId: number): RawPrivateValueTransaction {
  const shape = privateValueProfile(r.u8()).shapeId;
  const section = decodePrivateValueSection(r, WIRE_PROOF_BYTES, { kind: "privateValue", shape });
  if (!r.atEnd()) throw new Error("trailing bytes in private-value transaction");
  return { kind: TX_KIND_PRIVATE_VALUE, shape, pcashChainId, ...section };
}

/**
 * Verifier input `index` of a section, read from its serialized words; an
 * account section's omitted issuance word reads as zero. The chain ID and the
 * delivery commitment are not section words: only the verifier statement
 * reconstructs them.
 */
export function sectionPublicInput(section: RawPrivateValueSection, index: number): bigint {
  const word = serializedWordIndex(section.layout, index);
  if (word !== null) {
    return toField(bytesToBigInt(section.serializedPublicInputs[word]!), `private-value public input ${index}`);
  }
  if (index === sectionProfile(section.layout).offsets.issuanceOwner) return 0n;
  throw new Error(`private-value public input ${index} is not a serialized word`);
}

/** Verifier order, including the reconstructed chain ID and delivery commitment. */
export function privateValueSectionPublicInputs(
  section: RawPrivateValueSection,
  pcashChainId: number,
): bigint[] {
  const { offsets, publicInputs } = sectionProfile(section.layout);
  return Array.from({ length: publicInputs }, (_, index) => {
    if (index === offsets.chainId) return BigInt(pcashChainId);
    if (index === offsets.deliveryCommitment) return deliveryCommitment(section.outputData, section.arena);
    return sectionPublicInput(section, index);
  });
}

/** Construct the complete semantic verifier statement from a raw private-value transaction. */
export function privateValuePublicInputs(transaction: RawPrivateValueTransaction): bigint[] {
  return privateValueSectionPublicInputs(transaction, transaction.pcashChainId);
}

/** The verifier inputs of a user-account update: the section, then the account update commitment. */
export function userAccountUpdatePublicInputs(update: RawUserAccountUpdate): bigint[] {
  return [
    ...privateValueSectionPublicInputs(update.section, update.pcashChainId),
    toField(bytesToBigInt(update.accountUpdateCommitment), "accountUpdateCommitment"),
  ];
}

/**
 * The verifier inputs of a sponsored contract-account creation: the section,
 * then the contract address the node derives from the body.
 */
export function contractCreationPublicInputs(
  creation: RawContractAccountCreation,
  contractAddress: FieldNumberish,
): bigint[] {
  if (creation.funding.mode !== "sponsored") throw new Error("an unfunded contract creation carries no proof statement");
  return [
    ...privateValueSectionPublicInputs(creation.funding.section, creation.pcashChainId),
    toNonnegativeBigInt(contractAddress, "contractAddress"),
  ];
}

function decodeUserAccountCreation(
  r: ByteReader,
  pcashChainId: number,
  bodyStart: number,
): RawUserAccountCreation {
  const mode = r.u8();
  if (mode !== USER_ACCOUNT_AUTH_DIRECT && mode !== USER_ACCOUNT_AUTH_SIGNED) {
    throw new Error(`unknown user account creation authorization mode ${mode}`);
  }
  const nullifierKeyCommitment = r.word();
  const ruleSetCommitment = r.word();
  const mlKemPublicKey = decodeReceiveKey(r, "user account creation");
  const recentPcashBlockHash = r.word();
  const validUntilTimestamp = r.u64();
  let authorization: RawUserAccountCreation["authorization"] = { kind: "direct" };
  if (mode === USER_ACCOUNT_AUTH_SIGNED) {
    const sigR = r.word();
    const sigS = r.word();
    const yParity = r.u8();
    if (yParity !== 0 && yParity !== 1) throw new Error(`user account creation yParity must be 0 or 1, got ${yParity}`);
    authorization = { kind: "signed", sigR, sigS, yParity };
  }
  if (!r.atEnd()) throw new Error("trailing bytes in user account creation");
  return {
    kind: TX_KIND_USER_ACCOUNT_CREATION,
    pcashChainId,
    body: r.slice(bodyStart, r.offset),
    nullifierKeyCommitment,
    ruleSetCommitment,
    mlKemPublicKey,
    recentPcashBlockHash,
    validUntilTimestamp,
    authorization,
  };
}

function decodeRawContractBody(r: ByteReader, bodyStart: number): RawContractBody {
  const publishesNkRoot = r.u8();
  if (publishesNkRoot !== 0 && publishesNkRoot !== 1) {
    throw new Error(`contract publishesNkRoot must be 0 or 1, got ${publishesNkRoot}`);
  }
  const nullifierKeyMaterial = r.word();
  const mlKemPublicKey = decodeReceiveKey(r, "contract");
  const functionCount = r.u8();
  const functions: RawContractFunction[] = [];
  for (let index = 0; index < functionCount; index += 1) {
    functions.push({
      selector: r.u8(),
      applicationVkHash: r.word(),
      configurationCommitment: r.word(),
    });
  }
  return {
    body: r.slice(bodyStart, r.offset),
    publishesNkRoot: publishesNkRoot === 1,
    nullifierKeyMaterial,
    mlKemPublicKey,
    functions,
  };
}

function decodeContractAccountCreation(r: ByteReader, pcashChainId: number): RawContractAccountCreation {
  const mode = r.u8();
  let funding: RawContractFunding;
  if (mode === FUNDING_MODE_UNFUNDED) {
    funding = { mode: "unfunded", recentPcashBlockHash: r.word(), validUntilTimestamp: r.u64() };
  } else if (mode === FUNDING_MODE_SPONSORED) {
    funding = { mode: "sponsored", section: decodePrivateValueSection(r, WIRE_PROOF_BYTES, { kind: "contractAccountCreation" }) };
  } else {
    throw new Error(`unknown contract creation funding mode ${mode}`);
  }
  const body = decodeRawContractBody(r, r.offset);
  if (!r.atEnd()) throw new Error("trailing bytes in contract creation");
  return {
    kind: TX_KIND_CONTRACT_ACCOUNT_CREATION,
    pcashChainId,
    ...body,
    funding,
  };
}

function decodeUserAccountUpdate(
  r: ByteReader,
  pcashChainId: number,
  bodyStart: number,
): RawUserAccountUpdate {
  const address = Uint8Array.from(r.bytes(20));
  const newRuleSetCommitment = r.word();
  const operation = r.u8();
  let receiveKey: UserAccountReceiveKeyUpdate;
  if (operation === RECEIVE_KEY_OPERATION_KEEP) receiveKey = { operation: "keep" };
  else if (operation === RECEIVE_KEY_OPERATION_CLEAR) receiveKey = { operation: "clear" };
  else if (operation === RECEIVE_KEY_OPERATION_REPLACE) {
    receiveKey = { operation: "replace", mlKemPublicKey: Uint8Array.from(r.bytes(ML_KEM_768_PUBLIC_KEY_LENGTH)) };
  } else throw new Error(`unknown user account update receive-key operation ${operation}`);
  const proposedAccountFields = r.slice(bodyStart, r.offset);
  const accountUpdateCommitment = r.word();
  const section = decodePrivateValueSection(r, WIRE_PROOF_BYTES, { kind: "userAccountUpdate" });
  if (!r.atEnd()) throw new Error("trailing bytes in user account update");
  return {
    kind: TX_KIND_USER_ACCOUNT_UPDATE,
    pcashChainId,
    body: r.slice(bodyStart, r.offset),
    proposedAccountFields,
    address,
    newRuleSetCommitment,
    receiveKey,
    accountUpdateCommitment,
    section,
  };
}

export function decodeTransaction(bytes: Uint8Array): RawTransaction {
  if (bytes.length > MAX_TX_BYTES) throw new Error(`transaction exceeds MAX_TX_BYTES (${MAX_TX_BYTES})`);
  const r = new ByteReader(bytes);
  const kind = r.u8();
  if (
    kind !== TX_KIND_PRIVATE_VALUE
    && kind !== TX_KIND_USER_ACCOUNT_CREATION
    && kind !== TX_KIND_CONTRACT_ACCOUNT_CREATION
    && kind !== TX_KIND_USER_ACCOUNT_UPDATE
  ) {
    throw new Error(`unknown transaction kind ${kind}`);
  }
  const pcashChainId = r.u32();
  const bodyStart = r.offset;
  if (kind === TX_KIND_PRIVATE_VALUE) return decodePrivateValueTransaction(r, pcashChainId);
  if (kind === TX_KIND_USER_ACCOUNT_CREATION) {
    return decodeUserAccountCreation(r, pcashChainId, bodyStart);
  }
  if (kind === TX_KIND_CONTRACT_ACCOUNT_CREATION) return decodeContractAccountCreation(r, pcashChainId);
  if (kind === TX_KIND_USER_ACCOUNT_UPDATE) {
    return decodeUserAccountUpdate(r, pcashChainId, bodyStart);
  }
  throw new Error("unreachable transaction kind");
}

/** Structural decode plus the common-envelope network admission check. */
export function decodeTransactionForChain(
  bytes: Uint8Array,
  expectedPcashChainId: FieldNumberish,
): RawTransaction {
  const transaction = decodeTransaction(bytes);
  if (transaction.pcashChainId !== pcashChainIdU32(expectedPcashChainId, "expectedPcashChainId")) {
    throw new Error("wrong PCASH chain ID");
  }
  return transaction;
}

export interface DecodedBatch {
  version: BatchVersion;
  posterOwnerCommitment: bigint;
  posterContext: bigint;
  items: Uint8Array[];
}

/** Decode a known batch framing version. */
export function decodeBatchVersioned(calldata: Uint8Array): DecodedBatch {
  const r = new ByteReader(calldata);
  const version = r.u8();
  assertBatchVersion(version);
  const posterOwnerCommitment = toField(bytesToBigInt(r.word()), "posterOwnerCommitment");
  const posterContext = toField(bytesToBigInt(r.word()), "posterContext");
  const count = r.u16();
  if (count > MAX_BATCH_ENTRIES) throw new Error("too many batch items");
  const items: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const len = r.u32();
    if (len > MAX_TX_BYTES) throw new Error(`batch item ${i} exceeds MAX_TX_BYTES (${MAX_TX_BYTES})`);
    items.push(Uint8Array.from(r.bytes(len)));
  }
  if (!r.atEnd()) throw new Error("trailing bytes after final batch item");
  return { version, posterOwnerCommitment, posterContext, items };
}

/** Decode only when the framing byte matches the expected batch version. */
export function decodeBatchForVersion(
  calldata: Uint8Array,
  expectedVersion: BatchVersion,
): DecodedBatch {
  assertBatchVersion(expectedVersion);
  const decoded = decodeBatchVersioned(calldata);
  if (decoded.version !== expectedVersion) {
    throw new Error(
      `batch version ${decoded.version} does not match expected version ${expectedVersion}`,
    );
  }
  return decoded;
}

/** Decode batch framing version 1. */
export function decodeBatch(calldata: Uint8Array): DecodedBatch {
  return decodeBatchForVersion(calldata, VERSION);
}

/** The proof-bound public fee and issuance route of a transaction's private-value section. */
export interface TransactionPublication {
  kind: TransactionType;
  shape: PrivateValueShape;
  openFeeAmount: bigint;
  /** Zero selects the open route (the including poster). */
  issuanceOwnerCommitment: bigint;
  nullifiers: bigint[];
}

/**
 * The transaction's private-value section, or null for user-account and
 * unfunded contract creation. Reads serialized words only.
 */
export function transactionPublication(transaction: Uint8Array | RawTransaction): TransactionPublication | null {
  const decoded = transaction instanceof Uint8Array ? decodeTransaction(transaction) : transaction;
  let section: RawPrivateValueSection;
  switch (decoded.kind) {
    case TX_KIND_PRIVATE_VALUE:
      section = decoded;
      break;
    case TX_KIND_USER_ACCOUNT_UPDATE:
      section = decoded.section;
      break;
    case TX_KIND_CONTRACT_ACCOUNT_CREATION:
      if (decoded.funding.mode === "unfunded") return null;
      section = decoded.funding.section;
      break;
    case TX_KIND_USER_ACCOUNT_CREATION:
      return null;
  }
  const { shapeId, inputs, offsets } = sectionProfile(section.layout);
  return {
    kind: decoded.kind,
    shape: shapeId,
    openFeeAmount: sectionPublicInput(section, offsets.openFeeAmount),
    issuanceOwnerCommitment: sectionPublicInput(section, offsets.issuanceOwner),
    nullifiers: Array.from({ length: inputs }, (_, i) => sectionPublicInput(section, offsets.nullifiers + i)),
  };
}

/** The proof-bound PCASH fee, or zero for a transaction without a private-value section. */
export function transactionOpenFee(transaction: Uint8Array): bigint {
  return transactionPublication(transaction)?.openFeeAmount ?? 0n;
}

/**
 * The node's bounded unpaid class: proof-bearing non-type-0 transactions with no
 * open fee, plus user-account and unfunded contract creation. Type-0 remains
 * issuance-eligible regardless of its designated issuance destination.
 */
export function isUnpaidTransaction(transaction: Uint8Array): boolean {
  const publication = transactionPublication(transaction);
  if (publication === null) return true;
  return publication.openFeeAmount === 0n && publication.kind !== TX_KIND_PRIVATE_VALUE;
}
