// PCASH structural parameters (tree depths and range-check bit widths). Domain tags live in `pcash_constants` (generated); these are hand
// maintained protocol constants used by L1 derivation and transaction relations.

// --- Merkle tree depths ---
// The output-commitment tree and the account-state tree are indexed by a 40-bit
// position.
pub global MERKLE_DEPTH: u32 = 40;
// The account-rule-set commitment is a depth-8 sparse root over active
// account-rule-entry commitments.
pub global ACCOUNT_RULE_SET_DEPTH: u32 = 8;
// Typed block-header and state commitments are depth-4 sparse Poseidon trees.
pub global BLOCK_HEADER_TREE_DEPTH: u32 = 4;
pub global STATE_TREE_DEPTH: u32 = 4;
// The L1 origin tree and the PCASH history tree are depth-40 append-only trees.
pub global L1_ORIGIN_TREE_DEPTH: u32 = 40;
pub global HISTORY_TREE_DEPTH: u32 = 40;
// Each L1 origin leaf commits its block's normalized logs in a depth-64 tree.
pub global L1_LOG_TREE_DEPTH: u32 = 64;

// --- Range-check bit widths ---
pub global ADDRESS_BITS: u32 = 160; // uint160(address) inputs
pub global AMOUNT_BITS: u32 = 128; // note amounts and fees
// The largest initial supply of a standard fungible asset: five maximal notes.
pub global MAX_ASSET_SUPPLY: Field = 5 * 0xffffffffffffffffffffffffffffffff;
// The width of MAX_ASSET_SUPPLY, which bounds every asset aggregate: an initial
// supply and a burn amount.
pub global ASSET_AGGREGATE_BITS: u32 = 131;
pub global VALID_UNTIL_BITS: u32 = 64; // transaction timestamps
// The uint64 block number, timestamp, and log count of an L1 origin leaf.
pub global L1_ORIGIN_INTEGER_BITS: u32 = 64;
