// EIP-712 typed data for every PCASH message, plus the ECDSA signature handling
// the protocol pins.
//
// Each signing digest is viem's hashTypedData over the exact payload a wallet
// is shown. The circuits recompute the struct hash from the message fields in
// their witness; no struct hash is itself a witness input.

export {
  PCASH_DOMAIN_NAME,
  PCASH_DOMAIN_VERSION,
  pcashTypedData,
  pcashSigningHash,
  accountCreationTypedData,
  accountUpdateTypedData,
  KEY_DERIVATION_TYPE,
  keyDerivationTypedData,
  serializeEcdsaSignature,
  signDigest,
  addressFromPublicKeyXY,
  recoverAddress,
  recoverEcdsaSignature,
  publicKeyXY,
  assertValidPrivKey,
} from "./eip712.ts";
export type {
  PcashTypedDataField,
  PcashTypedData,
  PcashTypedValue,
  AccountCreationMessage,
  AccountCreationTypedMessage,
  AccountUpdateMessage,
  AccountUpdateTypedMessage,
  KeyDerivationTypedMessage,
  Ecdsa,
  EcdsaSignatureInput,
  RecoveredEcdsa,
} from "./eip712.ts";
export * from "./authorization.ts";

export * from "./selectedRelayQuote.ts";
