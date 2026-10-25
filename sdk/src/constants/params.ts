// PCASH structural parameters, mirroring the circuit
// `pcash_protocol::primitives::params` globals. Domain tags live in `domainTags.ts`; these are
// the hand-maintained protocol constants (tree depths and range-check bit
// widths). Kept byte-for-byte with circuits/protocol/lib/src/primitives/params.nr.

/** Byte length of an ML-KEM-768 public key carried by an account. */
export const ML_KEM_768_PUBLIC_KEY_LENGTH = 1184;

/** Byte length of every output-data item: one encrypted envelope or its size-class filler. */
export const OUTPUT_DATA_BYTES = 1213;

// --- Merkle tree depths ---
/** Note-commitment / address-account tree depth (40-bit leaf index). */
export const MERKLE_DEPTH = 40;
/** Shared account-rule-set sparse tree depth (user-account rule set / contract function set). */
export const ACCOUNT_RULE_SET_DEPTH = 8;
/** Typed block-header and state sparse-tree depths. */
export const BLOCK_HEADER_TREE_DEPTH = 4;
export const STATE_TREE_DEPTH = 4;
/** Append-only L1 origin and prior-PCASH-block history depths. */
export const L1_ORIGIN_TREE_DEPTH = 40;
export const HISTORY_TREE_DEPTH = 40;

// --- Block-header tree keys ---
export const BLOCK_HEADER_KEY_PARENT_HASH = 0;
export const BLOCK_HEADER_KEY_NUMBER = 1;
export const BLOCK_HEADER_KEY_TIMESTAMP = 2;
export const BLOCK_HEADER_KEY_TRANSACTION_RESULTS_ROOT = 3;
export const BLOCK_HEADER_KEY_STATE_ROOT = 4;
export const BLOCK_HEADER_KEY_L1_ORIGIN_ROOT = 5;
export const BLOCK_HEADER_KEY_HISTORY_ROOT = 6;

// --- State tree keys ---
export const STATE_KEY_OUTPUT_ROOT = 0;
export const STATE_KEY_OUTPUT_COUNT = 1;
export const STATE_KEY_ISSUED_SO_FAR = 2;
export const STATE_KEY_LAG_HIGH128 = 3;
export const STATE_KEY_LAG_LOW128 = 4;
export const STATE_KEY_ACCOUNT_STATE_ROOT = 5;
export const STATE_KEY_ACCOUNT_COUNT = 6;
export const STATE_KEY_NULLIFIER_ROOT = 7;
export const STATE_KEY_NULLIFIER_COUNT = 8;

// --- Account kind ---
export const ACCOUNT_KIND_USER = 0n;
export const ACCOUNT_KIND_CONTRACT = 1n;

// --- Range-check bit widths ---
export const ADDRESS_BITS = 160; // uint160(address) and issuanceRecipient inputs
export const AMOUNT_BITS = 128; // note amounts, fee amount
export const ASSET_AGGREGATE_BITS = 131; // standard asset aggregate/burn bound, independent of transaction capacity
export const LEAF_INDEX_BITS = 40; // note/account leaf indices
export const VALID_UNTIL_BITS = 64; // validUntilTimestamp < 2^64
