// PCASH EIP-712 typed data for protocol messages and SDK account rules.
//
// Domain:
//   EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
//   name = "PCASH"  version = "1"  chainId = L1_CHAIN_ID  verifyingContract = INBOX_ADDRESS
//
// Every message is typed data built from its pinned type string, and its
// signing digest is viem's hashTypedData over that exact payload, so the digest
// a circuit verifies and the payload a wallet displays cannot diverge.

import { hashTypedData } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256 } from "../utils/keccak.ts";
import { addressHex, bytes32Hex, fromHex, fromHexSized, toHex } from "../utils/hex.ts";
import { uintBelow, U32_LIMIT, U64_LIMIT, U128_LIMIT } from "../utils/validate.ts";
import { beBytes, bytesToBigInt, concatBytes } from "../utils/bytes.ts";
import { type FieldNumberish, toAddressField, toField, toNonnegativeBigInt } from "../crypto/field.ts";
import {
  DOMAIN_TYPE,
  PCASH_DOMAIN_NAME,
  PCASH_DOMAIN_VERSION,
  USER_ACCOUNT_CREATION_TYPE,
  USER_ACCOUNT_UPDATE_TYPE,
} from "../constants/networkProfile.ts";
import {
  inboxAddressHex,
  type NetworkConfig,
  type NetworkConfigLike,
  resolveNetworkConfig,
} from "../protocol/network.ts";

export { PCASH_DOMAIN_NAME, PCASH_DOMAIN_VERSION };

export interface PcashTypedDataField {
  name: string;
  type: string;
}

/** Browser-wallet-neutral EIP-712 payload. */
export interface PcashTypedData<
  PrimaryType extends string = string,
  Message = unknown,
> {
  domain: {
    name: string;
    version: string;
    chainId: string | number | bigint;
    verifyingContract: string;
  };
  types: Record<string, PcashTypedDataField[]>;
  primaryType: PrimaryType;
  message: Message;
}

/** The PCASH EIP-712 domain of a resolved network, as a typed-data payload carries it. */
export function pcashTypedDataDomain(network: NetworkConfig): PcashTypedData["domain"] {
  return {
    name: PCASH_DOMAIN_NAME,
    version: PCASH_DOMAIN_VERSION,
    // Keep this numeric. EIP-712 clients infer the domain field type from the
    // JavaScript value, and a decimal string is not consistently inferred as uint256.
    chainId: network.l1ChainId,
    verifyingContract: inboxAddressHex(network),
  };
}

/** Primary type and fields of a flat EIP-712 type string, e.g. "T(uint32 a,address b)". */
function parseTypeString(typeString: string): { primaryType: string; fields: PcashTypedDataField[] } {
  const match = /^(\w+)\((.*)\)$/.exec(typeString);
  if (match === null) throw new Error(`malformed EIP-712 type string ${typeString}`);
  return {
    primaryType: match[1]!,
    fields: match[2]!.split(",").map((entry) => {
      const [type, name] = entry.split(" ");
      return { name: name!, type: type! };
    }),
  };
}

/** A message value before encoding: numbers, raw 32-byte words, booleans, or text. */
export type PcashTypedValue = FieldNumberish | boolean | Uint8Array;

/**
 * Encode one value as `eth_signTypedData_v4` expects it for its declared type.
 *
 * PCASH `uint256` and numeric `bytes32` words are BN254 field elements; a
 * `bytes32` may also be given as its raw 32 bytes. Narrower integers are
 * range-checked against their width.
 */
function encodeTypedValue(type: string, value: PcashTypedValue | undefined, label: string): string | boolean {
  if (value === undefined) throw new Error(`${label} is missing`);
  if (type === "bool" || type === "string") {
    if (typeof value !== (type === "bool" ? "boolean" : "string")) throw new Error(`${label} must be a ${type}`);
    return value as string | boolean;
  }
  if (typeof value === "boolean") throw new Error(`${label} must be a number`);
  if (type === "bytes32") {
    if (typeof value === "string" && value.startsWith("0x")) return toHex(fromHexSized(value, 32, label));
    if (!(value instanceof Uint8Array)) return bytes32Hex(uintBelow(value, 1n << 256n, label));
    if (value.length !== 32) throw new Error(`${label} must be 32 bytes`);
    return toHex(value);
  }
  if (value instanceof Uint8Array) throw new Error(`${label} must be a number`);
  if (type === "address") return addressHex(toAddressField(value, label));
  const bits = /^uint(\d+)$/.exec(type)?.[1];
  if (bits === undefined) throw new Error(`unsupported EIP-712 field type ${type}`);
  return (bits === "256" ? toField(value, label) : uintBelow(value, 1n << BigInt(bits), label)).toString();
}

/**
 * The PCASH typed-data payload of one flat message: its fields come from the
 * pinned type string, and each value is encoded by its declared type.
 */
export function pcashTypedData<PrimaryType extends string, Message = Record<string, string | boolean>>(
  network: NetworkConfigLike,
  typeString: string,
  values: Readonly<Record<string, PcashTypedValue>>,
): PcashTypedData<PrimaryType, Message> {
  const { primaryType, fields } = parseTypeString(typeString);
  return {
    domain: pcashTypedDataDomain(resolveNetworkConfig(network)),
    types: { EIP712Domain: parseTypeString(DOMAIN_TYPE).fields, [primaryType]: fields },
    primaryType: primaryType as PrimaryType,
    message: Object.fromEntries(
      fields.map(({ name, type }) => [name, encodeTypedValue(type, values[name], name)]),
    ) as Message,
  };
}

/** keccak(0x1901 ‖ domainSeparator ‖ hashStruct(message)) of a typed-data payload. */
export function pcashSigningHash(typedData: PcashTypedData): Uint8Array {
  return fromHex(hashTypedData(typedData as never));
}

/** Resolve a message's network, which must be the one its own PCASH chain id names. */
function messageNetwork(network: NetworkConfigLike, pcashChainId: FieldNumberish, label: string): NetworkConfig {
  const resolved = resolveNetworkConfig(network);
  if (toField(pcashChainId, `${label}.pcashChainId`) !== resolved.pcashChainId) {
    throw new Error(`${label} PCASH chain id does not match network config`);
  }
  return resolved;
}

// ===========================================================================
// PcashUserAccountCreation
// ===========================================================================

/** The signer is the account being created: the node takes its address from signature recovery. */
export interface AccountCreationMessage {
  pcashChainId: FieldNumberish;
  nullifierKeyCommitment: FieldNumberish; // P
  ruleSetCommitment: FieldNumberish;
  receiveKeyHash: FieldNumberish; // bytes32 word of receiveKeyHash(mlKemPubKey), or zero
  recentPcashBlockHash: FieldNumberish;
  validUntilTimestamp: FieldNumberish;
}

export interface AccountCreationTypedMessage {
  pcashChainId: string;
  nullifierKeyCommitment: string;
  ruleSetCommitment: string;
  receiveKeyHash: string;
  recentPcashBlockHash: string;
  validUntilTimestamp: string;
}

/** Exact PcashUserAccountCreation payload for `eth_signTypedData_v4`. */
export function accountCreationTypedData(
  network: NetworkConfigLike,
  msg: AccountCreationMessage,
): PcashTypedData<"PcashUserAccountCreation", AccountCreationTypedMessage> {
  return pcashTypedData(messageNetwork(network, msg.pcashChainId, "account creation"), USER_ACCOUNT_CREATION_TYPE, {
    ...msg,
    receiveKeyHash: toField(msg.receiveKeyHash, "receiveKeyHash"),
    validUntilTimestamp: uintBelow(msg.validUntilTimestamp, U64_LIMIT, "validUntilTimestamp"),
  });
}

// ===========================================================================
// PcashUserAccountUpdate
// ===========================================================================

export interface AccountUpdateMessage {
  pcashChainId: FieldNumberish;
  account: FieldNumberish;
  currentAccountRevision: FieldNumberish;
  nullifierKeyCommitment: FieldNumberish;
  currentRuleSetCommitment: FieldNumberish;
  /** bytes32 word of receiveKeyHash(mlKemPubKey), or zero. */
  currentReceiveKeyHash: FieldNumberish;
  newRuleSetCommitment: FieldNumberish;
  newReceiveKeyHash: FieldNumberish;
  openFeeAmount: FieldNumberish;
  relayFeeAmount: FieldNumberish;
  relayFeeOwnerCommitment: FieldNumberish;
  transactionContext: FieldNumberish;
  notBefore: FieldNumberish;
  validUntil: FieldNumberish;
}

export interface AccountUpdateTypedMessage {
  pcashChainId: string;
  account: string;
  currentAccountRevision: string;
  nullifierKeyCommitment: string;
  currentRuleSetCommitment: string;
  currentReceiveKeyHash: string;
  newRuleSetCommitment: string;
  newReceiveKeyHash: string;
  openFeeAmount: string;
  relayFeeAmount: string;
  relayFeeOwnerCommitment: string;
  transactionContext: string;
  notBefore: string;
  validUntil: string;
}

export function accountUpdateTypedData(
  network: NetworkConfigLike,
  msg: AccountUpdateMessage,
): PcashTypedData<"PcashUserAccountUpdate", AccountUpdateTypedMessage> {
  return pcashTypedData(messageNetwork(network, msg.pcashChainId, "account update"), USER_ACCOUNT_UPDATE_TYPE, {
    ...msg,
    currentAccountRevision: uintBelow(msg.currentAccountRevision, U32_LIMIT, "currentAccountRevision"),
    currentReceiveKeyHash: toField(msg.currentReceiveKeyHash, "currentReceiveKeyHash"),
    newReceiveKeyHash: toField(msg.newReceiveKeyHash, "newReceiveKeyHash"),
    openFeeAmount: uintBelow(msg.openFeeAmount, U128_LIMIT, "openFeeAmount"),
  });
}

// SDK wallet-derivation profile.
export const KEY_DERIVATION_TYPE =
  "PcashKeyDerivation(uint256 pcashChainId,address account,string context)";

export interface KeyDerivationTypedMessage {
  pcashChainId: string;
  account: string;
  context: string;
}

/**
 * The exact key-derivation payload to hand a wallet. The domain carries the
 * **L1** chain id; the PCASH chain id travels in the message.
 */
export function keyDerivationTypedData(
  network: NetworkConfigLike,
  account: FieldNumberish,
  context: string,
): PcashTypedData<"PcashKeyDerivation", KeyDerivationTypedMessage> {
  const resolved = resolveNetworkConfig(network);
  return pcashTypedData(resolved, KEY_DERIVATION_TYPE, {
    pcashChainId: resolved.pcashChainId,
    account,
    context,
  });
}

// ===========================================================================
// secp256k1 signing / recovery
// ===========================================================================

export interface Ecdsa {
  r: bigint;
  s: bigint;
  yParity: number; // 0 or 1
  compact: Uint8Array; // r(32) || s(32), canonical low-s
}

/** `r || s || v` as returned by an EIP-1193 wallet. */
export type EcdsaSignatureInput = Uint8Array | string;

export interface RecoveredEcdsa extends Ecdsa {
  pubX: Uint8Array;
  pubY: Uint8Array;
  address: bigint;
}

const SECP256K1_SCALAR_ORDER = secp256k1.Point.Fn.ORDER;
const SECP256K1_HALF_SCALAR_ORDER = SECP256K1_SCALAR_ORDER >> 1n;

function ecdsaSignatureBytes(signature: EcdsaSignatureInput, label: string): Uint8Array {
  if (typeof signature === "string") {
    const body = signature.startsWith("0x") ? signature : `0x${signature}`;
    if (!/^0x[0-9a-fA-F]{130}$/.test(body)) {
      throw new Error(`${label} must be 65 bytes of hex (r ‖ s ‖ v)`);
    }
    return fromHexSized(body, 65, label);
  }
  if (!(signature instanceof Uint8Array) || signature.length !== 65) {
    throw new Error(`${label} must be 65 bytes (r ‖ s ‖ v)`);
  }
  return signature.slice();
}

/**
 * Parse an EIP-1193 signature and canonicalize equivalent encodings.
 *
 * Both 0/1 and 27/28 recovery bytes are accepted. A high-s signature is
 * reflected to its low-s twin and the recovery parity is flipped, so identity
 * derivation never depends on which equivalent representation a wallet emits.
 */
function parseEcdsaSignature(
  signature: EcdsaSignatureInput,
  label = "ECDSA signature",
): Ecdsa {
  const raw = ecdsaSignatureBytes(signature, label);
  const r = bytesToBigInt(raw.slice(0, 32));
  let s = bytesToBigInt(raw.slice(32, 64));
  const encodedV = raw[64]!;
  let yParity = encodedV >= 27 ? encodedV - 27 : encodedV;
  if (yParity !== 0 && yParity !== 1) {
    throw new Error(`${label} has unusable recovery byte ${encodedV}`);
  }
  if (r <= 0n || r >= SECP256K1_SCALAR_ORDER) {
    throw new Error(`${label} r is outside the secp256k1 scalar range`);
  }
  if (s <= 0n || s >= SECP256K1_SCALAR_ORDER) {
    throw new Error(`${label} s is outside the secp256k1 scalar range`);
  }
  if (s > SECP256K1_HALF_SCALAR_ORDER) {
    s = SECP256K1_SCALAR_ORDER - s;
    yParity ^= 1;
  }
  return {
    r,
    s,
    yParity,
    compact: concatBytes(beBytes(r, 32), beBytes(s, 32)),
  };
}

/** Serialize canonical signature material for an injected wallet boundary. */
export function serializeEcdsaSignature(
  signature: Pick<Ecdsa, "r" | "s" | "yParity">,
  recoveryByte: "parity" | "legacy" = "parity",
): Uint8Array {
  if (signature.yParity !== 0 && signature.yParity !== 1) {
    throw new Error("ECDSA signature yParity must be 0 or 1");
  }
  if (signature.r <= 0n || signature.r >= SECP256K1_SCALAR_ORDER) {
    throw new Error("ECDSA signature r is outside the secp256k1 scalar range");
  }
  if (signature.s <= 0n || signature.s > SECP256K1_HALF_SCALAR_ORDER) {
    throw new Error("ECDSA signature s must be canonical low-s");
  }
  return concatBytes(
    beBytes(signature.r, 32),
    beBytes(signature.s, 32),
    Uint8Array.from([signature.yParity + (recoveryByte === "legacy" ? 27 : 0)]),
  );
}

/** Sign a 32-byte digest (prehashed) with a raw private key; canonical low-s. */
export function signDigest(privKey: Uint8Array, digest32: Uint8Array): Ecdsa {
  if (digest32.length !== 32) throw new Error("digest must be 32 bytes");
  const signed = secp256k1.sign(digest32, privKey); // msgHash mode (no re-hash)
  return {
    r: signed.r,
    s: signed.s,
    yParity: signed.recovery,
    compact: concatBytes(beBytes(signed.r, 32), beBytes(signed.s, 32)),
  };
}

/** low160(keccak256(pubX || pubY)) from a 64-byte uncompressed key body. */
export function addressFromPublicKeyXY(xy64: Uint8Array): bigint {
  if (xy64.length !== 64) throw new Error("public key body must be 64 bytes (x||y)");
  return bytesToBigInt(keccak256(xy64).slice(12, 32));
}

/** Recover the uncompressed secp256k1 public-key coordinates. */
function recoverPublicKeyXY(
  digest32: Uint8Array,
  sig: { r: bigint; s: bigint; yParity: number } | { compact: Uint8Array; yParity: number },
): { x: Uint8Array; y: Uint8Array } {
  if (digest32.length !== 32) throw new Error("digest must be 32 bytes");
  if (sig.yParity !== 0 && sig.yParity !== 1) {
    throw new Error("ECDSA signature yParity must be 0 or 1");
  }
  const compact =
    "compact" in sig ? sig.compact : concatBytes(beBytes(sig.r, 32), beBytes(sig.s, 32));
  if (compact.length !== 64) throw new Error("ECDSA compact signature must be 64 bytes");
  const recovered = secp256k1.Signature.fromCompact(compact)
    .addRecoveryBit(sig.yParity)
    .recoverPublicKey(digest32);
  const uncompressed = recovered.toRawBytes(false); // 0x04 || x || y
  return { x: uncompressed.slice(1, 33), y: uncompressed.slice(33, 65) };
}

/** Recover the Ethereum address (uint160) that signed `digest32`. */
export function recoverAddress(
  digest32: Uint8Array,
  sig: { r: bigint; s: bigint; yParity: number } | { compact: Uint8Array; yParity: number },
): bigint {
  const { x, y } = recoverPublicKeyXY(digest32, sig);
  return addressFromPublicKeyXY(concatBytes(x, y));
}

/** Parse, normalize, and recover one externally produced signature. */
export function recoverEcdsaSignature(
  digest32: Uint8Array,
  signature: EcdsaSignatureInput,
  label = "ECDSA signature",
): RecoveredEcdsa {
  const parsed = parseEcdsaSignature(signature, label);
  const { x, y } = recoverPublicKeyXY(digest32, parsed);
  return {
    ...parsed,
    pubX: x,
    pubY: y,
    address: addressFromPublicKeyXY(concatBytes(x, y)),
  };
}

/** Uncompressed public key (x, y) for a raw private key. */
export function publicKeyXY(privKey: Uint8Array): { x: Uint8Array; y: Uint8Array } {
  const uncompressed = secp256k1.getPublicKey(privKey, false); // 0x04 || x || y
  return { x: uncompressed.slice(1, 33), y: uncompressed.slice(33, 65) };
}

/** Sanity: numeric value of a private key (must be a valid scalar). */
export function assertValidPrivKey(privKey: Uint8Array): void {
  if (privKey.length !== 32) throw new Error("private key must be 32 bytes");
  const v = toNonnegativeBigInt(bytesToBigInt(privKey), "privKey");
  if (v === 0n || v >= SECP256K1_SCALAR_ORDER) {
    throw new Error("private key must be a nonzero secp256k1 scalar");
  }
}
