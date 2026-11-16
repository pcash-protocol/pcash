// The canonical Keccak-256 used everywhere in this SDK.
//
// It sits in utils/ rather than eip712/ because most of its callers — the wire
// codec, the note store, the node client — want a hash function and nothing
// else, and routing them through the EIP-712 layer would put it above them in
// the import order.
//
// Deliberately @noble rather than viem's keccak256: viem's is itself a @noble
// wrapper that defaults to returning `Hex`, and this codebase is Uint8Array-native
// because these values are circuit witnesses, not EVM words.

import { keccak_256 } from "@noble/hashes/sha3.js";

export const keccak256 = (bytes: Uint8Array): Uint8Array => keccak_256(bytes);
