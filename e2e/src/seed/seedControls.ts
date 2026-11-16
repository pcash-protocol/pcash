// Crafted seed entries. Each one is a byte-level edit of a real entry (or a
// freshly signed creation) that the node must classify with one specific
// outcome. The edits rely on the derive engine's check order: a control
// carrying a garbage proof still reaches its intended check because every
// check it targets precedes proof verification.

import { PRIVATE_VALUE_PROFILES, MULTISIG_RULE_VK_HASH, OUTPUT_DATA_BYTES, privateValueProfile, type PrivateValueProfile } from "@pcash/sdk/constants";
import { buildAuthorizedReferenceUserAccountCreation } from "@pcash/sdk/builders";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import { buildPrivateMultisigContract } from "@pcash/sdk/fixtures";
import {
  CARRIER_KIND_EVENT,
  carrierContextHash,
  decodeTransaction,
  encodeContractAccountCreation,
  encodePrivateValueTransaction,
  encodeUserAccountCreation,
  encodeUserAccountUpdate,
  MAX_TX_BYTES,
  privateValuePublicInputs,
  privateValueSectionPublicInputs,
  WIRE_PROOF_BYTES,
  type BatchVersion,
  type NetworkConfig,
  type RawContractBody,
  type RawPrivateValueTransaction,
  type RawUserAccountUpdate,
} from "@pcash/sdk/protocol";
import { bytes32Hex, bytesToBigInt, concatBytes, fromHex } from "@pcash/sdk/utils";
import { derivePcashProfileFromPrivateKey, type PcashProfile } from "@pcash/sdk/wallet";
import { keccak256, toHex, type Hex } from "viem";

const ENVELOPE_BYTES = 5;
const WORD_BYTES = 32;
const ADDRESS_BYTES = 20;
const CONTRACT_FUNCTION_BYTES = 1 + 2 * WORD_BYTES;

// ------------------------------------------------------------------ bytes

function withBytes(entry: Uint8Array, offset: number, replacement: Uint8Array): Uint8Array {
  if (offset < 0 || offset + replacement.length > entry.length) {
    throw new Error(`seed control edit at ${offset} falls outside a ${entry.length}-byte entry`);
  }
  const out = Uint8Array.from(entry);
  out.set(replacement, offset);
  return out;
}

function flipByte(entry: Uint8Array, offset: number): Uint8Array {
  return withBytes(entry, offset, Uint8Array.of(entry[offset]! ^ 1));
}

function wordBytes(value: bigint): Uint8Array {
  return fromHex(`0x${value.toString(16).padStart(WORD_BYTES * 2, "0")}`);
}

function u64Bytes(value: bigint): Uint8Array {
  return fromHex(`0x${value.toString(16).padStart(16, "0")}`);
}

function addressBytes(address: string): Uint8Array {
  const bytes = fromHex(address);
  if (bytes.length !== ADDRESS_BYTES) throw new Error(`${address} is not a 20-byte address`);
  return bytes;
}

const NON_CANONICAL_WORD = new Uint8Array(WORD_BYTES).fill(0xff);

/** A field element that names no PCASH block. */
export const UNKNOWN_RECENT_BLOCK_HASH = 1n;

/** Deterministic material for a control, so re-recording keeps the same addresses. */
function controlDigest(label: string): Hex {
  return keccak256(toHex(`pcash-seed-control:${label}`));
}

function controlField(label: string): bigint {
  return BigInt(controlDigest(label)) >> 8n;
}

export function controlPrivateKey(label: string): Hex {
  return controlDigest(label);
}

export function controlAddress(label: string): string {
  return `0x${controlDigest(label).slice(2, 2 + ADDRESS_BYTES * 2)}`;
}

// ------------------------------------------------------------ framing

/** Batch framing without the per-entry size cap the SDK encoder enforces. */
export function frameSeedBatch(items: readonly Uint8Array[], version: BatchVersion, posterOwnerCommitment: bigint, posterContext: bigint): Uint8Array {
  if (items.length > 0xffff) throw new Error("too many seed batch items");
  const header = concatBytes(Uint8Array.of(version), fromHex(bytes32Hex(posterOwnerCommitment)), fromHex(bytes32Hex(posterContext)), Uint8Array.of(items.length >> 8, items.length & 0xff));
  const framed = items.map((item) => {
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, item.length);
    return concatBytes(length, item);
  });
  return concatBytes(header, ...framed);
}

export function unsupportedVersionCarrier(): Uint8Array {
  return Uint8Array.of(0x02, 0x00, 0x00);
}

export function trailingBytesCarrier(item: Uint8Array, version: BatchVersion): Uint8Array {
  return concatBytes(frameSeedBatch([item], version, 1n, 0n), Uint8Array.of(0x00));
}

// ------------------------------------------------------- private value

function privateValue(entry: Uint8Array, label: string): RawPrivateValueTransaction {
  const decoded = decodeTransaction(entry);
  if (decoded.kind !== 0) throw new Error(`${label} requires a private-value entry`);
  return decoded;
}

function corruptedProof(proof: Uint8Array): Uint8Array {
  return flipByte(proof, Math.floor(proof.length / 2));
}

/** Re-encode a private-value entry with edited public inputs and an invalid proof. */
function editedPrivateValue(template: Uint8Array, label: string, edit: (publicInputs: bigint[], profile: PrivateValueProfile) => void): Uint8Array {
  const decoded = privateValue(template, label);
  const publicInputs = privateValuePublicInputs(decoded);
  edit(publicInputs, privateValueProfile(decoded.shape));
  return encodePrivateValueTransaction({
    shape: decoded.shape,
    publicInputs,
    proof: corruptedProof(decoded.proof),
    outputData: decoded.outputData,
    arena: decoded.arena,
    ...(decoded.accountCreation === undefined ? {} : { accountCreation: decoded.accountCreation }),
  });
}

export function proofRejectedTransfer(template: Uint8Array): Uint8Array {
  return editedPrivateValue(template, "proof-rejection control", () => undefined);
}

export function staleWindowTransfer(template: Uint8Array): Uint8Array {
  return editedPrivateValue(template, "stale-window control", (pi) => { pi[1] = UNKNOWN_RECENT_BLOCK_HASH; });
}

export function expiredTransfer(template: Uint8Array): Uint8Array {
  return editedPrivateValue(template, "expired control", (pi, profile) => { pi[profile.offsets.validUntil] = 1n; });
}

export function notYetValidTransfer(template: Uint8Array): Uint8Array {
  return editedPrivateValue(template, "not-yet-valid control", (pi, profile) => { pi[profile.offsets.notBefore] = 1n << 40n; });
}

/** Requires delivery by another contract's event, which the seed's Inbox carrier is not. */
export function carrierContextMismatchTransfer(template: Uint8Array): Uint8Array {
  const required = carrierContextHash(CARRIER_KIND_EVENT, controlAddress("carrier-context") as Hex, new Uint8Array());
  return editedPrivateValue(template, "carrier-context control", (pi, profile) => { pi[profile.offsets.carrierContextHash] = required; });
}

export function zeroNullifierTransfer(template: Uint8Array): Uint8Array {
  return editedPrivateValue(template, "zero-nullifier control", (pi) => { pi[2] = 0n; });
}

export function duplicateNullifierTransfer(template: Uint8Array): Uint8Array {
  return editedPrivateValue(template, "duplicate-nullifier control", (pi) => { pi[3] = pi[2]!; });
}

/** The recent-block word is the first serialized public input; a word at or above the field modulus is not a field element. */
export function publicInputNotInFieldTransfer(template: Uint8Array): Uint8Array {
  privateValue(template, "public-input control");
  return withBytes(template, ENVELOPE_BYTES + 1, NON_CANONICAL_WORD);
}

/** The output-data items and then the arena close the entry; this edits byte zero of the first item. */
export function outputByteZeroProofMutationTransfer(template: Uint8Array): Uint8Array {
  const decoded = privateValue(template, "output-data byte-zero control");
  return flipByte(template, ENVELOPE_BYTES + 1 + privateValueProfile(decoded.shape).wireInputs * WORD_BYTES + WIRE_PROOF_BYTES);
}

export function wrongChainIdTransfer(template: Uint8Array): Uint8Array {
  const decoded = privateValue(template, "wrong-chain-id control");
  const publicInputs = privateValuePublicInputs(decoded);
  publicInputs[0] = publicInputs[0]! + 1n;
  return encodePrivateValueTransaction({ shape: decoded.shape, publicInputs, proof: decoded.proof, outputData: decoded.outputData, arena: decoded.arena });
}

export function truncatedItem(template: Uint8Array): Uint8Array {
  return template.slice(0, 100);
}

export function trailingBytesItem(template: Uint8Array): Uint8Array {
  return concatBytes(template, Uint8Array.of(0x00));
}

export function emptyItem(): Uint8Array {
  return new Uint8Array(0);
}

/** A complete envelope for this chain whose type byte, the first unassigned one, names no transaction type. */
export function unknownTypeItem(pcashChainId: bigint): Uint8Array {
  return concatBytes(Uint8Array.of(0x04), fromHex(`0x${pcashChainId.toString(16).padStart(8, "0")}`));
}

export function oversizedItem(template: Uint8Array): Uint8Array {
  return concatBytes(template, new Uint8Array(MAX_TX_BYTES + 1 - template.length));
}

// ---------------------------------------------------- account creation

export interface ControlIdentity {
  label: string;
  privateKey: Hex;
  profile: PcashProfile;
  address: string;
}

export function controlIdentity(label: string, network: NetworkConfig): ControlIdentity {
  const privateKey = controlPrivateKey(label);
  const profile = derivePcashProfileFromPrivateKey(fromHex(privateKey), network);
  return { label, privateKey, profile, address: `0x${profile.address.toString(16).padStart(ADDRESS_BYTES * 2, "0")}` };
}

/** A creation the account owner actually signed, with the window fields the caller chose. */
export async function signedAccountCreation(params: {
  identity: ControlIdentity;
  network: NetworkConfig;
  recentPcashBlockHash: bigint;
  validUntilTimestamp: bigint;
  receiveKey: boolean;
}): Promise<Uint8Array> {
  const { identity, network } = params;
  const built = await buildAuthorizedReferenceUserAccountCreation({
    chainId: network.pcashChainId,
    network,
    wallet: identity.profile,
    defaultRuleSecrets: identity.profile.defaultUserRuleSecrets,
    ...(params.receiveKey ? { mlKemPublicKey: identity.profile.mlKemPublicKey } : {}),
    recentPcashBlockHash: params.recentPcashBlockHash,
    validUntilTimestamp: params.validUntilTimestamp,
  }, privateKeyPcashActionSigner(fromHex(identity.privateKey)));
  return encodeUserAccountCreation(network.pcashChainId, built.body);
}

/** Window values for the two signed creation controls, relative to the node head they reference. */
export function creationWindowControls(head: { latestBlockHash: string; latestBlockTimestamp: bigint }) {
  return {
    staleWindow: { recentPcashBlockHash: UNKNOWN_RECENT_BLOCK_HASH, validUntilTimestamp: head.latestBlockTimestamp + 1_800n },
    expired: { recentPcashBlockHash: BigInt(head.latestBlockHash), validUntilTimestamp: head.latestBlockTimestamp - 1n },
  };
}

/**
 * A signed creation ends with r, s, and yParity. A signature that still
 * recovers would create whatever account it recovers to, so this control
 * zeroes s: no ECDSA recovery accepts s = 0, and the creation names no account.
 */
export function badSignatureCreation(template: Uint8Array): Uint8Array {
  const decoded = decodeTransaction(template);
  if (decoded.kind !== 1 || decoded.authorization.kind !== "signed") {
    throw new Error("bad-signature control requires a signed user account creation entry");
  }
  return withBytes(template, template.length - 1 - WORD_BYTES, new Uint8Array(WORD_BYTES));
}

function signedCreation(template: Uint8Array, label: string): void {
  const decoded = decodeTransaction(template);
  if (decoded.kind !== 1 || decoded.authorization.kind !== "signed") {
    throw new Error(`${label} requires a signed user account creation entry`);
  }
}

/** yParity, the last byte of a signed creation, outside {0, 1}: the item does not decode. */
export function unknownYParityCreation(template: Uint8Array): Uint8Array {
  signedCreation(template, "y-parity control");
  return withBytes(template, template.length - 1, Uint8Array.of(2));
}

/** The receive-key mode follows the authorization mode and two words; 2 is outside {absent, present}. */
export function unknownReceiveKeyModeCreation(template: Uint8Array): Uint8Array {
  signedCreation(template, "receive-key-mode control");
  return withBytes(template, ENVELOPE_BYTES + 1 + 2 * WORD_BYTES, Uint8Array.of(2));
}

// ------------------------------------------------------------ contracts

function contract(entry: Uint8Array, label: string): RawContractBody {
  const decoded = decodeTransaction(entry);
  if (decoded.kind === 2) return decoded;
  if (decoded.kind === 0 && decoded.accountCreation?.kind === "contract") {
    const body = decodeTransaction(encodeContractAccountCreation(decoded.pcashChainId, decoded.accountCreation.body, {
      recentPcashBlockHash: 0n, validUntilTimestamp: 1n,
    }));
    if (body.kind !== 2) throw new Error("contract body decoding failed");
    return body;
  }
  throw new Error(`${label} requires a contract creation or attachment`);
}

/** The standalone body or attachment closes the entry. */
function contractBodyOffset(entry: Uint8Array, decoded: RawContractBody): number {
  return entry.length - decoded.body.length;
}

/** Body layout: publishesNkRoot, material word, receive-key mode, key when present, function count, functions. */
function contractFunctionCountOffset(entry: Uint8Array, decoded: RawContractBody): number {
  return contractBodyOffset(entry, decoded) + 1 + WORD_BYTES + 1 + (decoded.mlKemPublicKey?.length ?? 0);
}

/** An attachment tag outside {none, user, contract}: the item does not decode. */
export function unknownAttachmentTagContract(template: Uint8Array): Uint8Array {
  const body = contract(template, "attachment-tag control");
  if (decodeTransaction(template).kind !== 0) throw new Error("attachment-tag control requires a private-value transaction");
  return withBytes(template, contractBodyOffset(template, body) - 1, Uint8Array.of(3));
}

/** publishesNkRoot, the first body byte, outside {0, 1}: the item does not decode. */
export function unknownNkRootFlagContract(template: Uint8Array): Uint8Array {
  const decoded = contract(template, "nk-root-flag control");
  return withBytes(template, contractBodyOffset(template, decoded), Uint8Array.of(2));
}

export function nonCanonicalFieldContract(template: Uint8Array): Uint8Array {
  const decoded = contract(template, "non-canonical-field control");
  return withBytes(template, contractBodyOffset(template, decoded) + 1, NON_CANONICAL_WORD);
}

export function emptyFunctionsContract(template: Uint8Array): Uint8Array {
  const decoded = contract(template, "empty-functions control");
  return concatBytes(template.slice(0, contractFunctionCountOffset(template, decoded)), Uint8Array.of(0));
}

export function swappedSelectorsContract(template: Uint8Array): Uint8Array {
  const decoded = contract(template, "selector-order control");
  if (decoded.functions.length < 2) throw new Error("selector-order control requires two contract functions");
  const start = contractFunctionCountOffset(template, decoded) + 1;
  const first = template.slice(start, start + CONTRACT_FUNCTION_BYTES);
  const second = template.slice(start + CONTRACT_FUNCTION_BYTES, start + 2 * CONTRACT_FUNCTION_BYTES);
  return withBytes(withBytes(template, start, second), start + CONTRACT_FUNCTION_BYTES, first);
}

/** An unverified 2-of-3 vault whose body publishes only the nullifier-key
 * commitment. The caller funds and publishes its creation. */
export function privateVaultContract(
  label: string,
  signers: readonly [PcashProfile, PcashProfile, PcashProfile],
): { body: Uint8Array; contractAddress: bigint; address: string } {
  const vault = buildPrivateMultisigContract({
    nkRoot: controlField(`${label}:nk-root`),
    signers: signers.map((signer) => ({ pubX: signer.pubX, pubY: signer.pubY })),
    applicationVkHash: MULTISIG_RULE_VK_HASH,
    configurationSalt: controlField(`${label}:salt`),
  });
  return {
    body: vault.build.body,
    contractAddress: vault.build.address,
    address: `0x${vault.build.address.toString(16).padStart(ADDRESS_BYTES * 2, "0")}`,
  };
}

/** An unfunded creation of `body`: no fee section, only the recent block and deadline. */
export function unfundedContractCreation(params: {
  network: NetworkConfig;
  body: Uint8Array;
  recentPcashBlockHash: bigint;
  validUntilTimestamp: bigint;
}): Uint8Array {
  return encodeContractAccountCreation(params.network.pcashChainId, params.body, {
    recentPcashBlockHash: params.recentPcashBlockHash,
    validUntilTimestamp: params.validUntilTimestamp,
  });
}

// ------------------------------------------------------ account update

function update(entry: Uint8Array, label: string): RawUserAccountUpdate {
  const decoded = decodeTransaction(entry);
  if (decoded.kind !== 3) throw new Error(`${label} requires a user account update entry`);
  return decoded;
}

/**
 * Layout after the envelope: address, new rule-set commitment, receive-key
 * operation, key for REPLACE, account update commitment, then the private-value
 * section: serialized words (recent block first, event commitment last), proof,
 * output data.
 */
function updateOffsets(decoded: RawUserAccountUpdate) {
  const fieldsEnd = ENVELOPE_BYTES + decoded.proposedAccountFields.length;
  const sectionStart = fieldsEnd + WORD_BYTES;
  // The decoder restores the zero issuance word, which an account action does not serialize.
  const sectionWords = decoded.section.serializedPublicInputs.length;
  return {
    address: ENVELOPE_BYTES,
    ruleSet: ENVELOPE_BYTES + ADDRESS_BYTES,
    accountUpdateCommitment: fieldsEnd,
    recentBlock: sectionStart,
    /**
     * The validUntil word's low eight bytes. The section omits three earlier
     * verifier inputs: the chain ID, the delivery commitment, and the issuance word.
     */
    validUntil: sectionStart + (PRIVATE_VALUE_PROFILES.S.offsets.validUntil - 3) * WORD_BYTES + (WORD_BYTES - 8),
    proof: sectionStart + sectionWords * WORD_BYTES,
  };
}

function corruptedUpdateProof(template: Uint8Array, decoded: RawUserAccountUpdate): Uint8Array {
  return flipByte(template, updateOffsets(decoded).proof + Math.floor(decoded.section.proof.length / 2));
}

export function proofRejectedUpdate(template: Uint8Array): Uint8Array {
  return corruptedUpdateProof(template, update(template, "update proof-rejection control"));
}

export function nonCanonicalFieldUpdate(template: Uint8Array): Uint8Array {
  const decoded = update(template, "update non-canonical-field control");
  return withBytes(corruptedUpdateProof(template, decoded), updateOffsets(decoded).ruleSet, NON_CANONICAL_WORD);
}

export function staleWindowUpdate(template: Uint8Array): Uint8Array {
  const decoded = update(template, "update stale-window control");
  return withBytes(corruptedUpdateProof(template, decoded), updateOffsets(decoded).recentBlock, wordBytes(UNKNOWN_RECENT_BLOCK_HASH));
}

export function expiredUpdate(template: Uint8Array): Uint8Array {
  const decoded = update(template, "update expired control");
  return withBytes(corruptedUpdateProof(template, decoded), updateOffsets(decoded).validUntil, u64Bytes(1n));
}

export function retargetedUpdate(template: Uint8Array, address: string, label: string): Uint8Array {
  const decoded = update(template, label);
  return withBytes(corruptedUpdateProof(template, decoded), updateOffsets(decoded).address, addressBytes(address));
}

export function accountUpdateCommitmentMismatchUpdate(template: Uint8Array): Uint8Array {
  const decoded = update(template, "account-update-commitment control");
  return withBytes(corruptedUpdateProof(template, decoded), updateOffsets(decoded).accountUpdateCommitment, wordBytes(1n));
}

/** A CLEAR against an account that never registered a receive key. */
export function clearWithoutReceiveKeyUpdate(params: {
  template: Uint8Array;
  address: string;
  pcashChainId: number;
  recentPcashBlockHash: bigint;
  validUntilTimestamp: bigint;
}): Uint8Array {
  const decoded = update(params.template, "clear-without-key control");
  const publicInputs = privateValueSectionPublicInputs(decoded.section, params.pcashChainId);
  publicInputs[1] = params.recentPcashBlockHash;
  publicInputs[PRIVATE_VALUE_PROFILES.S.offsets.validUntil] = params.validUntilTimestamp;
  return encodeUserAccountUpdate({
    pcashChainId: params.pcashChainId,
    proposedAccountFields: {
      address: params.address,
      newRuleSetCommitment: bytesToBigInt(decoded.newRuleSetCommitment),
      receiveKey: { operation: "clear" },
    },
    accountUpdateCommitment: 1n,
    section: {
      publicInputs,
      proof: decoded.section.proof,
      outputData: decoded.section.outputData,
      arena: decoded.section.arena,
    },
  });
}
