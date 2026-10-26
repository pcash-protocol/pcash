// Generate cross-language PCASH conformance vectors.
// Run: node scripts/gen_vectors.mjs [--check]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { readPrivateValueProfiles } from "./circuits/profile_config.mjs";
import { BN254_SCALAR_MODULUS as P, fieldToHex } from "../sdk/src/crypto/field.ts";
import { poseidon as sdkPoseidon } from "../sdk/src/crypto/poseidon2.ts";
import { defaultNetwork as NETWORK, networkProfile } from "./network_profile.mjs";
import { generatedHeader, runGenerator } from "./generated_files.mjs";
import * as noir from "./noir_layout.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const outputs = new Map();
const write = (relativePath, value) => outputs.set(relativePath, `${JSON.stringify(value, null, 2)}\n`);
const writeText = (relativePath, value) => outputs.set(relativePath, value);

// Generator inputs are reduced modulo the scalar field here; the SDK's
// Poseidon2 implementation accepts only canonical field elements.
const normalize = (value) => {
  const reduced = BigInt(value) % P;
  return reduced < 0n ? reduced + P : reduced;
};
const poseidon = (...inputs) => sdkPoseidon(inputs.map(normalize));
const toFieldHex32 = (value) => fieldToHex(normalize(value));
/** Serialize a raw uint256 value without applying field reduction. */
const toUint256Hex32 = (value) => {
  const integer = BigInt(value);
  if (integer < 0n || integer >= 1n << 256n) throw new RangeError("value is outside uint256 range");
  return `0x${integer.toString(16).padStart(64, "0")}`;
};

const utf8 = (value) => new TextEncoder().encode(value);
const bytesHex = (value) => `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
const addressHex = (value) => `0x${value.toString(16).padStart(40, "0")}`;
const concatBytes = (...parts) => {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};
const uintBytes = (value, width) => {
  if (value < 0n || value >= 1n << BigInt(width * 8)) throw new Error(`value does not fit in ${width} bytes`);
  const output = new Uint8Array(width);
  let remaining = value;
  for (let index = width - 1; index >= 0; index--) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
};
const uint256Bytes = (value) => uintBytes(value, 32);
const hexBytes = (value) => {
  if (!/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) throw new Error("invalid hex");
  return Uint8Array.from({ length: (value.length - 2) / 2 }, (_, index) =>
    Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16));
};
const keccak = (...parts) => Uint8Array.from(keccak_256(concatBytes(...parts)));
// A hash-derived commitment operand: uint256(digest) mod p.
const digestField = (digest) => BigInt(bytesHex(digest)) % P;
const patternBytes = (length, seed, step) => Uint8Array.from({ length }, (_, index) => (seed + step * index) & 0xff);
// Byte-string hash inputs: domain, byte length, then 16-byte big-endian chunks.
const byteHashInputs = (domain, bytes) => {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 16) chunks.push(BigInt(bytesHex(bytes.subarray(offset, offset + 16))));
  return [domain, BigInt(bytes.length), ...chunks];
};
const poseidonBytes = (domain, bytes) => poseidon(...byteHashInputs(domain, bytes));

// Poseidon sponge vectors.
const poseidonInputs = [
  [],
  [1],
  [1, 2],
  [1, 2, 3],
  [1, 2, 3, 4],
  [1, 2, 3, 4, 5],
  [1, 2, 3, 4, 5, 6, 7],
  [5, 8, 13, 21, 34, 55],
  Array.from({ length: 17 }, (_, index) => index + 1),
];
// Byte-string hash vectors across chunk boundaries, including a short final
// chunk with a leading zero byte.
const BYTE_HASH_VECTOR_DOMAIN = 0x5043n;
const byteHashInputsList = [
  new Uint8Array(0),
  Uint8Array.of(0x01),
  Uint8Array.of(0x00, 0x01),
  patternBytes(15, 0x11, 3),
  patternBytes(16, 0x22, 5),
  patternBytes(17, 0x33, 7),
  patternBytes(33, 0x00, 11),
];
write("vectors/poseidon2_vectors.json", {
  scheme: "poseidon2-bn254-t4-rf8-rp56-length-tagged-sponge",
  spec: "Poseidon2 hash",
  fieldModulus: toUint256Hex32(P),
  note: "poseidon(x_1..x_N) = Poseidon2_sponge; state init [0,0,0,N<<64], rate-3 absorb, return state[0].",
  poseidonVectors: poseidonInputs.map((inputs) => ({
    inputs: inputs.map((value) => toFieldHex32(BigInt(value))),
    output: toFieldHex32(poseidon(...inputs.map(BigInt))),
  })),
  byteHashNote: "poseidonBytes(DOMAIN, b) = poseidon(DOMAIN, uint64(len(b)), 16-byte big-endian chunks of b; the final chunk may be short).",
  byteHashVectors: byteHashInputsList.map((bytes) => ({
    domain: toFieldHex32(BYTE_HASH_VECTOR_DOMAIN),
    bytes: bytesHex(bytes),
    inputs: byteHashInputs(BYTE_HASH_VECTOR_DOMAIN, bytes).map(toFieldHex32),
    output: toFieldHex32(poseidonBytes(BYTE_HASH_VECTOR_DOMAIN, bytes)),
  })),
});

// Poseidon Merkle vectors.
const FIELD_TREE_DEPTH = 64;
const fieldEmpty = [0n];
for (let height = 0; height < FIELD_TREE_DEPTH; height++) {
  fieldEmpty.push(poseidon(fieldEmpty[height], fieldEmpty[height]));
}
const fieldPathRoot = (leaf, index, siblings) => {
  let current = leaf;
  let cursor = index;
  for (const sibling of siblings) {
    current = (cursor & 1n) === 0n ? poseidon(current, sibling) : poseidon(sibling, current);
    cursor >>= 1n;
  }
  return current;
};
const depth4Example = (label, leaf, index, siblings) => {
  let current = leaf;
  let cursor = index;
  const steps = siblings.map((sibling, height) => {
    const bit = cursor & 1n;
    const left = bit === 0n ? current : sibling;
    const right = bit === 0n ? sibling : current;
    current = poseidon(left, right);
    cursor >>= 1n;
    return {
      height,
      keyBit: Number(bit),
      side: bit === 0n ? "left" : "right",
      left: toFieldHex32(left),
      right: toFieldHex32(right),
      parent: toFieldHex32(current),
    };
  });
  return {
    label,
    depth: 4,
    leaf: toFieldHex32(leaf),
    index: Number(index),
    indexBitsLSBFirst: [0, 1, 2, 3].map((height) => Number((index >> BigInt(height)) & 1n)),
    siblings: siblings.map(toFieldHex32),
    steps,
    expectedRoot: toFieldHex32(current),
  };
};
write("vectors/merkle_vectors.json", {
  spec: "Merkle trees",
  fieldModulus: toUint256Hex32(P),
  node: "internal node = poseidon(left, right); empty leaf = 0",
  emptyLadderRule: "EMPTY[0]=0; EMPTY[h+1]=poseidon(EMPTY[h],EMPTY[h]); depth-D empty root = EMPTY[D]",
  pathRule: "D siblings leaf->root; key bit h (LSB-first) selects side; bit 0 => current node is LEFT child",
  emptyLadder: fieldEmpty.map((value, height) => ({ height, value: toFieldHex32(value) })),
  emptyRoots: {
    output_commitment_tree_depth_40: toFieldHex32(fieldEmpty[40]),
    address_account_state_tree_depth_40: toFieldHex32(fieldEmpty[40]),
    account_rule_set_tree_depth_8: toFieldHex32(fieldEmpty[8]),
    l1_origin_tree_depth_40: toFieldHex32(fieldEmpty[40]),
    l1_log_tree_depth_64: toFieldHex32(fieldEmpty[64]),
    pcash_history_tree_depth_40: toFieldHex32(fieldEmpty[40]),
  },
  membershipExamples: [
    depth4Example("index-0-empty-siblings", poseidon(42n), 0n, fieldEmpty.slice(0, 4)),
    depth4Example("index-11-mixed-sides", poseidon(7n, 8n), 11n, [100n, 101n, 102n, 103n].map((value) => poseidon(value))),
  ],
});

const DOMAIN_ASSET = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/domain_tags.json"), "utf8"));
const REFERENCE_ASSET = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/reference_rule_profile.json"), "utf8"));
const tag = (name) => BigInt(DOMAIN_ASSET.tags[name]);
const referenceTag = (name) => BigInt(REFERENCE_ASSET.tags[name]);
const PCASH_CHAIN_ID = BigInt(NETWORK.pcashChainId);
const L1_CHAIN_ID = BigInt(NETWORK.l1ChainId);
const INBOX_ADDRESS = BigInt(NETWORK.inboxAddress);
const ADDRESS = 0x87c018ef0000000000000000000000000000a1a9n;
const U160_MASK = (1n << 160n) - 1n;

const sparseFieldTree = (depth, entries) => {
  const levels = [new Array(1 << depth).fill(0n)];
  for (const [key, value] of entries) levels[0][key] = value;
  for (let height = 0; height < depth; height++) {
    const previous = levels[height];
    const next = [];
    for (let index = 0; index < previous.length; index += 2) next.push(poseidon(previous[index], previous[index + 1]));
    levels.push(next);
  }
  return {
    root: levels[depth][0],
    proof(key) {
      let index = key;
      const siblings = [];
      for (let height = 0; height < depth; height++) {
        siblings.push(levels[height][index ^ 1]);
        index >>= 1;
      }
      return siblings;
    },
  };
};

const typedFieldTree = (domain, entries) => {
  const depth = 4;
  const levels = [new Array(1 << depth).fill(0n)];
  for (const [key, value] of entries) levels[0][key] = value;
  for (let height = 0; height < depth; height++) {
    const previous = levels[height];
    const next = [];
    for (let index = 0; index < previous.length; index += 2) {
      next.push(poseidon(domain, previous[index], previous[index + 1]));
    }
    levels.push(next);
  }
  return {
    root: levels[depth][0],
    proof(key) {
      let index = key;
      const siblings = [];
      for (let height = 0; height < depth; height++) {
        siblings.push(levels[height][index ^ 1]);
        index >>= 1;
      }
      return siblings;
    },
  };
};

// Transaction, output, account, and contract commitments.
const nkRoot = 0x1234n;
const noteNullifierKey = poseidon(tag("NOTE_NULLIFIER_KEY_DOMAIN"), nkRoot);
const inputCommitmentValue = 0x5678n;
const noteSecretInput = 0xbeefn;
const dummyInputSeed = 0x123456789abcdefn;
const realNullifier = poseidon(tag("NULLIFIER_DOMAIN"), inputCommitmentValue, noteNullifierKey, noteSecretInput);
const transactionNullifiers = [
  realNullifier,
  ...[1n, 2n, 3n].map((index) => poseidon(tag("DUMMY_NULLIFIER_DOMAIN"), dummyInputSeed, index)),
];
const inputSlotClasses = [1n, 0n, 0n, 0n];
const inputCommitments = [inputCommitmentValue, 0n, 0n, 0n];
const outputSlotClasses = [1n, 0n, 0n, 0n, 0n];
const outputBodyCommitments = [0x7001n, 0x7002n, 0x7003n, 0x7004n, 0x7005n];
const outputDataHashes = [0x8001n, 0x8002n, 0x8003n, 0x8004n, 0x8005n];
const outputDataItem = patternBytes(1_213, 0x07, 29);
const smallProfile = readPrivateValueProfiles(ROOT).find((profile) => profile.name === "S");
const arenaItem = patternBytes(smallProfile.arenaBytes, 0x0b, 31);
const arenaHashValue = poseidonBytes(tag("ARENA_HASH_DOMAIN"), arenaItem);
const deliveryCommitmentOf = (hashes, arena) => poseidon(tag("DELIVERY_COMMITMENT_DOMAIN"), ...hashes, arena);
const deliveryCommitmentValue = deliveryCommitmentOf(outputDataHashes, arenaHashValue);
const payoutSeed = poseidon(tag("PAYOUT_SEED_DOMAIN"), noteNullifierKey);
const payoutTxContext = poseidon(tag("PAYOUT_TX_CONTEXT_DOMAIN"), PCASH_CHAIN_ID, 0n, 4n, 5n, ...transactionNullifiers);
const issuanceSecret = poseidon(tag("PAYOUT_NOTE_SECRET_DOMAIN"), payoutSeed, 3n, payoutTxContext);
const issuanceOwnerCommitment = poseidon(tag("OWNER_COMMITMENT_DOMAIN"), ADDRESS, issuanceSecret);
const payoutBatchItems = hexBytes("0x000200000003010203000000020405");
const posterContext = 0xc2c2n;
const posterSecret = poseidon(tag("PAYOUT_NOTE_SECRET_DOMAIN"), payoutSeed, 2n, posterContext);
const posterOwnerCommitment = poseidon(tag("OWNER_COMMITMENT_DOMAIN"), ADDRESS, posterSecret);
const transactionGlobal = {
  openFeeAmount: 0n,
  issuanceOwnerCommitment,
  notBeforeTimestamp: 10n,
  validUntilTimestamp: 999n,
  carrierContextHash: 0xcc01n,
  assetBurnAmount: 12n,
  deliveryCommitment: deliveryCommitmentValue,
  accountCreationCommitment: 0xcca1n,
};
const privateValueCommitmentValue = poseidon(
  tag("PRIVATE_VALUE_COMMITMENT_DOMAIN"),
  0n, 4n, 5n,
  transactionGlobal.openFeeAmount,
  transactionGlobal.issuanceOwnerCommitment,
  transactionGlobal.notBeforeTimestamp,
  transactionGlobal.validUntilTimestamp,
  transactionGlobal.carrierContextHash,
  transactionGlobal.assetBurnAmount,
  transactionGlobal.deliveryCommitment,
  transactionGlobal.accountCreationCommitment,
  ...inputSlotClasses.flatMap((slotClass, index) => [slotClass, inputCommitments[index], transactionNullifiers[index]]),
  ...outputSlotClasses.flatMap((slotClass, index) => [slotClass, outputBodyCommitments[index]]),
);
const standardAssetMetadataCommitment = 0xa0a0n;
const standardAssetInitialSupply = 1_000_000n;
const standardAssetSecret = 0xb0b0n;
const standardAssetSecretCommitment = poseidon(
  tag("ASSET_SECRET_COMMITMENT_DOMAIN"), standardAssetSecret,
);
const assetIdValue = poseidon(
  tag("ASSET_ID_DOMAIN"),
  standardAssetMetadataCommitment,
  standardAssetInitialSupply,
  standardAssetSecretCommitment,
);
const assetCreationMarker = poseidon(
  tag("ASSET_CREATION_MARKER_DOMAIN"), assetIdValue, standardAssetSecret,
);
const assetInputNoteCommitment = 0xc0c0n;
const assetInputAmount = 41n;
const assetInputNullifier = 0xd0d0n;
const outputNoteSecretSeed = poseidon(tag("IMPLICIT_NOTE_SECRET_SEED_DOMAIN"), noteNullifierKey);
const outputNoteIndex = 1n;
const outputEntropy = 5n;
const outputNoteSecret = poseidon(
  tag("TRANSACT_NOTE_SECRET_DOMAIN"),
  outputNoteSecretSeed,
  0n, 4n, 5n,
  ...transactionNullifiers,
  outputNoteIndex,
  outputEntropy,
);
const noteBody = 0x123456789abcdefn;
const outputIndex = 7n;
const outputCommitmentValue = poseidon(tag("OUTPUT_COMMITMENT_DOMAIN"), noteBody, outputIndex);

// The PCASH EIP-712 domain separator, which the reference ECDSA rules sign
// under and commit as two 128-bit halves.
const domainTypeHash = keccak_256(utf8(networkProfile.eip712.domainType));
const nameHash = keccak_256(utf8(networkProfile.eip712.name));
const versionHash = keccak_256(utf8(networkProfile.eip712.version));
const domainSeparator = keccak_256(concatBytes(
  domainTypeHash,
  nameHash,
  versionHash,
  uint256Bytes(L1_CHAIN_ID),
  uint256Bytes(INBOX_ADDRESS),
));
const domainSeparatorValue = BigInt(bytesHex(domainSeparator));
const domainSeparatorHigh = domainSeparatorValue >> 128n;
const domainSeparatorLow = domainSeparatorValue & ((1n << 128n) - 1n);

const configurationSalt = 0x102030405060708090a0b0c0d0e0f01n;
const genericConfigurationFields = [7n, 8n, 9n];
const commitConfiguration = (fields) => poseidon(
  referenceTag("REFERENCE_CONFIGURATION_DOMAIN"),
  configurationSalt,
  ...fields,
);
const genericConfiguration = commitConfiguration(genericConfigurationFields);
const nullifierKeyCommitmentValue = poseidon(tag("NULLIFIER_KEY_COMMITMENT_DOMAIN"), nkRoot);
const ecdsaConfiguration = poseidon(
  referenceTag("REFERENCE_CONFIGURATION_DOMAIN"),
  domainSeparatorHigh,
  domainSeparatorLow,
  nullifierKeyCommitmentValue,
);
const multisigThreshold = 2n;
const multisigSigners = [0x3333n, 0x1111n, 0x2222n].sort((left, right) => left < right ? -1 : 1);
const multisigConfiguration = commitConfiguration([multisigThreshold, ...multisigSigners]);
const referenceAssetDomain = referenceTag("REFERENCE_ASSET_CONFIGURATION_DOMAIN");
const covenantSuccessorFields = [
  5n,
  0x1234567890abcdef1234567890abcdef12345678n,
  0x2345n,
  0x3456n,
  1n,
  0n,
];
const covenantSuccessorConfiguration = poseidon(
  referenceAssetDomain,
  3n,
  ...covenantSuccessorFields,
);

const applicationVkHash = 0x5555n;
const accountConfigurationCommitment = 0x4444n;
const commitmentBlinder = 0xc0ffeen;
// A user-account rule entry carries an explicit blinder: its entries are
// never published, so the blinder is what stops a known rule template from
// being recognized.
const accountRuleEntry = poseidon(
  tag("ACCOUNT_RULE_ENTRY_DOMAIN"),
  applicationVkHash,
  accountConfigurationCommitment,
  commitmentBlinder,
);
const accountRuleTree = sparseFieldTree(8, [[0, accountRuleEntry]]);
const accountRuleSetCommitment = accountRuleTree.root;

// A contract function is the same four-field entry with the canonical blinder
// 0 (§12.4). A contract publishes its complete function list on Ethereum DA,
// so a published per-function blinder would hide nothing. The two roots are
// deliberately distinct: user-account vectors use the blinded root above,
// contract vectors use this one.
const contractFunctionCommitment = poseidon(
  tag("ACCOUNT_RULE_ENTRY_DOMAIN"),
  applicationVkHash,
  accountConfigurationCommitment,
  0n,
);
const contractFunctionSetCommitment = sparseFieldTree(8, [[0, contractFunctionCommitment]]).root;

const contractPreimage = poseidon(tag("CONTRACT_ADDRESS_DOMAIN"), nullifierKeyCommitmentValue, contractFunctionSetCommitment, 0n, 1n);
const contractAddress = contractPreimage & U160_MASK;

const ML_KEM768_PUBLIC_KEY_LEN = 1_184;
const receiveKey = patternBytes(ML_KEM768_PUBLIC_KEY_LEN, 0x5a, 13);
const receiveKeyHash = poseidonBytes(tag("RECEIVE_KEY_HASH_DOMAIN"), receiveKey);
const accountRevision = 9n;
const userAccountStateCommitmentFor = (keyHash) => poseidon(
  tag("ACCOUNT_STATE_COMMITMENT_DOMAIN"),
  ADDRESS,
  nullifierKeyCommitmentValue,
  accountRuleSetCommitment,
  0n,
  accountRevision,
  keyHash,
);
const userAccountStateCommitment = userAccountStateCommitmentFor(receiveKeyHash);
const clearedUserAccountStateCommitment = userAccountStateCommitmentFor(0n);
const contractAccountStateCommitment = poseidon(
  tag("ACCOUNT_STATE_COMMITMENT_DOMAIN"), contractAddress, nullifierKeyCommitmentValue, contractFunctionSetCommitment, 1n, 1n, 0n,
);

const newAccountRuleSetCommitment = 0x9999n;
const newReceiveKeyHash = 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefn;
const newAccountRevision = accountRevision + 1n;
const newUserAccountStateCommitment = poseidon(
  tag("ACCOUNT_STATE_COMMITMENT_DOMAIN"),
  ADDRESS,
  nullifierKeyCommitmentValue,
  newAccountRuleSetCommitment,
  0n,
  newAccountRevision,
  newReceiveKeyHash,
);
const accountUpdateCommitmentValue = poseidon(
  tag("ACCOUNT_UPDATE_COMMITMENT_DOMAIN"),
  userAccountStateCommitment,
  newUserAccountStateCommitment,
);

// The rule statement's authorization and action commitments.
const authorizationCommitmentValue = poseidon(
  tag("AUTHORIZATION_COMMITMENT_DOMAIN"), ADDRESS, accountConfigurationCommitment,
);
const actionCommitmentVector = (domainName, extraData) => ({
  domain: toFieldHex32(tag(domainName)),
  extraData: toFieldHex32(extraData),
  value: toFieldHex32(poseidon(tag(domainName), PCASH_CHAIN_ID, privateValueCommitmentValue, extraData)),
});
const nativeInput = {
  slot: 1n,
  inputCommitment: 0xc1c1n,
  amount: 7n,
  nullifier: 0xd1d1n,
};

// Indexed nullifier tree. Leaf 0 is the sentinel. Each insertion appends the
// new value's leaf with its predecessor's next pointer, then points the
// predecessor at the new leaf.
const NULLIFIER_TREE_DEPTH = 41;
const nullifierLeafHash = (leaf) =>
  poseidon(tag("NULLIFIER_LEAF_DOMAIN"), leaf.value, leaf.nextValue, leaf.nextIndex);
const isLowNullifierLeaf = (leaf, value) =>
  leaf.value < value && (value < leaf.nextValue || (leaf.nextValue === 0n && leaf.nextIndex === 0n));
const sentinelNullifierLeaf = { value: 0n, nextValue: 0n, nextIndex: 0n };
const indexedNullifierTree = () => {
  const leaves = [];
  const nodes = new Map();
  const node = (height, index) => nodes.get(`${height}:${index}`) ?? fieldEmpty[height];
  const path = (index) => Array.from({ length: NULLIFIER_TREE_DEPTH }, (_, height) =>
    node(height, (index >> BigInt(height)) ^ 1n));
  const setLeaf = (index, leaf) => {
    leaves[Number(index)] = leaf;
    let current = nullifierLeafHash(leaf);
    nodes.set(`0:${index}`, current);
    let cursor = index;
    for (let height = 0; height < NULLIFIER_TREE_DEPTH; height++) {
      const sibling = node(height, cursor ^ 1n);
      current = (cursor & 1n) === 0n ? poseidon(current, sibling) : poseidon(sibling, current);
      cursor >>= 1n;
      nodes.set(`${height + 1}:${cursor}`, current);
    }
  };
  // The leaf with the largest value not above `value`.
  const lowIndex = (value) => leaves.reduce(
    (best, leaf, index) => (leaf.value <= value && leaf.value >= leaves[best].value ? index : best), 0);
  setLeaf(0n, sentinelNullifierLeaf);
  return {
    root: () => node(NULLIFIER_TREE_DEPTH, 0n),
    count: () => BigInt(leaves.length - 1),
    leaves: () => leaves.map((leaf, index) => ({ index: BigInt(index), ...leaf })),
    path,
    insert(value) {
      const low = BigInt(lowIndex(value));
      const lowLeaf = leaves[Number(low)];
      if (lowLeaf.value === value) throw new Error("nullifier is already in the tree");
      const index = BigInt(leaves.length);
      setLeaf(index, { value, nextValue: lowLeaf.nextValue, nextIndex: lowLeaf.nextIndex });
      setLeaf(low, { ...lowLeaf, nextValue: value, nextIndex: index });
    },
    proof(nullifier) {
      const index = BigInt(lowIndex(nullifier));
      return { nullifier, leaf: { ...leaves[Number(index)] }, leafIndex: index, siblings: path(index) };
    },
  };
};
const nullifierProofRoot = (proof) => fieldPathRoot(nullifierLeafHash(proof.leaf), proof.leafIndex, proof.siblings);
// True for membership, false for absence, null when the leaf neither holds nor brackets the nullifier.
const nullifierProofSpent = (proof) =>
  proof.leaf.value === proof.nullifier ? true : isLowNullifierLeaf(proof.leaf, proof.nullifier) ? false : null;
// Every word must be canonical: the leaf hash reduces modulo p and the
// comparisons do not, so x + p would hash as x while comparing above it.
const nullifierProofVerifies = (proof, root) =>
  [proof.nullifier, proof.leaf.value, proof.leaf.nextValue].every((word) => word < P) &&
  nullifierProofSpent(proof) !== null &&
  nullifierProofRoot(proof) === root;
// One predecessor (100) rewritten three times in one block, a new maximum and
// minimum at the field's ends, and gaps filled from both sides.
const nullifierInsertions = [100n, 300n, 200n, 150n, P - 1n, 1n, 250n, P - 2n, 299n];
const nullifierBlockSizes = [1, 3, 5];
if (nullifierBlockSizes.reduce((sum, size) => sum + size, 0) !== nullifierInsertions.length) {
  throw new Error("nullifier blocks must partition the insertions");
}
// Proofs taken after this many insertions: the sentinel alone, the sentinel
// as the low leaf below the minimum, the end of the list, a predecessor
// before its pointer moves, and membership and absence in the full tree.
const nullifierProofRequests = new Map([
  [0, [7n]],
  [1, [50n, 101n]],
  [2, [200n]],
  [nullifierInsertions.length, [150n, 1n, P - 1n, 2n, 151n, 249n, 301n]],
]);
const nullifierTree = indexedNullifierTree();
const nullifierInsertionVectors = [];
const nullifierProofs = [];
const takeNullifierProofs = (insertions) => {
  for (const nullifier of nullifierProofRequests.get(insertions) ?? []) {
    const proof = { insertions, root: nullifierTree.root(), ...nullifierTree.proof(nullifier) };
    if (!nullifierProofVerifies(proof, proof.root)) {
      throw new Error(`nullifier proof for ${nullifier} does not verify`);
    }
    nullifierProofs.push(proof);
  }
};
takeNullifierProofs(0);
for (const [offset, value] of nullifierInsertions.entries()) {
  nullifierTree.insert(value);
  nullifierInsertionVectors.push({ value, index: BigInt(offset + 1), root: nullifierTree.root() });
  takeNullifierProofs(offset + 1);
}
const nullifierRoot = nullifierTree.root();
const nullifierCount = nullifierTree.count();
const unusedNullifierIndex = nullifierCount + 1n;
const finalNullifierProof = (nullifier) =>
  nullifierProofs.find((proof) => proof.insertions === nullifierInsertions.length && proof.nullifier === nullifier);
const forgedNullifierProofs = [
  // An unallocated slot is 0, which no allocated leaf hashes to, so an
  // all-zero or end-of-list preimage there does not open.
  { name: "sentinelPreimageAtUnusedIndex", nullifier: 150n, leaf: sentinelNullifierLeaf,
    leafIndex: unusedNullifierIndex, siblings: nullifierTree.path(unusedNullifierIndex) },
  { name: "endOfListPreimageAtUnusedIndex", nullifier: 150n, leaf: { value: 149n, nextValue: 0n, nextIndex: 0n },
    leafIndex: unusedNullifierIndex, siblings: nullifierTree.path(unusedNullifierIndex) },
  { name: "nextValueEqualsNullifier", ...finalNullifierProof(151n), nullifier: 200n },
  { name: "nullifierAboveNextValue", ...nullifierTree.proof(100n), nullifier: 151n },
  { name: "stalePredecessor", ...nullifierProofs.find((proof) => proof.insertions === 2) },
  // The real leaf (150, 200, 3) with nextValue written as 200 + p: it hashes
  // like the real leaf and, compared as raw words, brackets the spent 200.
  { name: "nonCanonicalNextValue", ...nullifierTree.proof(150n),
    leaf: { ...nullifierTree.proof(150n).leaf, nextValue: 200n + P }, nullifier: 200n },
];
const nonCanonicalNextValue = forgedNullifierProofs.at(-1);
if (nullifierProofSpent(nonCanonicalNextValue) !== false || nullifierProofRoot(nonCanonicalNextValue) !== nullifierRoot) {
  throw new Error("the non-canonical next value must open and bracket the nullifier once reduced");
}
for (const forged of forgedNullifierProofs) {
  if (nullifierProofVerifies(forged, nullifierRoot)) {
    throw new Error(`forged nullifier proof ${forged.name} verifies`);
  }
}
const lowLeafCase = (value, nextValue, nextIndex, nullifier) => ({ leaf: { value, nextValue, nextIndex }, nullifier });
const nullifierLowLeafCases = [
  lowLeafCase(11n, 13n, 2n, 12n),
  lowLeafCase(11n, 13n, 2n, 11n),
  lowLeafCase(11n, 13n, 2n, 13n),
  lowLeafCase(11n, 13n, 2n, 14n),
  lowLeafCase(11n, 13n, 2n, 10n),
  lowLeafCase(11n, 0n, 0n, 12n),
  lowLeafCase(11n, 0n, 0n, 11n),
  lowLeafCase(11n, 0n, 3n, 12n),
  lowLeafCase(0n, 0n, 0n, 1n),
  lowLeafCase(0n, 0n, 0n, P - 1n),
  lowLeafCase(P - 2n, P - 1n, 5n, P - 1n),
].map((entry) => ({ ...entry, isLowLeaf: isLowNullifierLeaf(entry.leaf, entry.nullifier) }));
// Raw words, so a forged non-canonical word reaches the verifier unreduced.
const nullifierLeafVector = (leaf) => ({
  value: toUint256Hex32(leaf.value),
  nextValue: toUint256Hex32(leaf.nextValue),
  nextIndex: Number(leaf.nextIndex),
});
const nullifierProofVector = (proof) => ({
  nullifier: toUint256Hex32(proof.nullifier),
  leaf: nullifierLeafVector(proof.leaf),
  leafIndex: Number(proof.leafIndex),
  siblings: proof.siblings.map(toFieldHex32),
});

// Genesis identity and the Ethereum append-only root at its anchor.
const genesisL1Block = 5_678_901n;
// The hash exceeds p, so only its two halves commit it exactly.
const genesisL1BlockHash = hexBytes("0xfedcba98765432100123456789abcdefffeeddccbbaa99887766554433221100");
if (BigInt(bytesHex(genesisL1BlockHash)) < P) throw new Error("genesis L1 block hash must exceed p");
const genesisL1BlockHashHigh = BigInt(bytesHex(genesisL1BlockHash.subarray(0, 16)));
const genesisL1BlockHashLow = BigInt(bytesHex(genesisL1BlockHash.subarray(16)));
const genesisL1BlockTimestamp = 1_700_000_000n;
const genesisL1LogsRoot = fieldEmpty[64];
const genesisL1LogCount = 0n;
const genesisParentHash = poseidon(
  tag("GENESIS_PARENT_DOMAIN"),
  PCASH_CHAIN_ID,
  L1_CHAIN_ID,
  INBOX_ADDRESS,
);
const l1OriginLeafValue = poseidon(
  tag("L1_ORIGIN_DOMAIN"),
  genesisL1Block,
  genesisL1BlockHashHigh,
  genesisL1BlockHashLow,
  genesisL1BlockTimestamp,
  genesisL1LogsRoot,
  genesisL1LogCount,
);
const l1OriginRoot = fieldPathRoot(l1OriginLeafValue, 0n, fieldEmpty.slice(0, 40));

// Typed intrinsic state and block-header commitments.
const state = {
  outputRoot: outputCommitmentValue,
  outputCount: 17n,
  issuedSoFar: 1234567890000000000000000n,
  lagQ: -(8n * 86_400n << 128n),
  accountStateRoot: userAccountStateCommitment,
  accountCount: 1n,
  nullifierRoot,
  nullifierCount,
};
const encodedLag = (1n << 256n) + state.lagQ;
const lagSplit = { high128: encodedLag >> 128n, low128: encodedLag & ((1n << 128n) - 1n) };
const stateNames = [
  "outputRoot",
  "outputCount",
  "issuedSoFar",
  "lagHigh128",
  "lagLow128",
  "accountStateRoot",
  "accountCount",
  "nullifierRoot",
  "nullifierCount",
];
const stateValues = [
  state.outputRoot,
  state.outputCount,
  state.issuedSoFar,
  lagSplit.high128,
  lagSplit.low128,
  state.accountStateRoot,
  state.accountCount,
  state.nullifierRoot,
  state.nullifierCount,
];
const stateTree = typedFieldTree(tag("STATE_COMMITMENT_DOMAIN"), stateValues.map((value, key) => [key, value]));
const stateRoot = stateTree.root;
const historicalBlockNumber = 0n;
const historicalBlockHash = 0x123456789abcdefn;
const historyLeafValue = poseidon(tag("HISTORY_LEAF_DOMAIN"), historicalBlockHash);
const historyRoot = fieldPathRoot(historyLeafValue, historicalBlockNumber, fieldEmpty.slice(0, 40));

// Log data and carrier contexts share one chunking: max(8, ceil(length / 16))
// zero-padded 16-byte big-endian chunks.
const dataChunks = (bytes) => {
  const chunks = Array(Math.max(8, Math.ceil(bytes.length / 16))).fill(0n);
  for (let offset = 0; offset < bytes.length; offset += 16) {
    chunks[offset / 16] = BigInt(bytesHex(bytes.subarray(offset, offset + 16)));
  }
  return chunks;
};

// Normalized L1 logs: one sponge over the coordinates, topic halves, data
// length, and the data chunks.
const normalizedLogFields = (log) => {
  const topicLimbs = Array(8).fill(0n);
  log.topics.forEach((topic, index) => {
    topicLimbs[2 * index] = BigInt(bytesHex(topic.subarray(0, 16)));
    topicLimbs[2 * index + 1] = BigInt(bytesHex(topic.subarray(16, 32)));
  });
  const chunks = dataChunks(log.data);
  return [
    tag("L1_LOG_DOMAIN"),
    log.transactionIndex,
    log.logIndex,
    log.emitter,
    BigInt(log.topics.length),
    ...topicLimbs,
    BigInt(log.data.length),
    ...chunks,
  ];
};
const normalizedLogVector = (log) => {
  const fields = normalizedLogFields(log);
  return {
    transactionIndex: Number(log.transactionIndex),
    logIndex: Number(log.logIndex),
    emitter: addressHex(log.emitter),
    topics: log.topics.map(bytesHex),
    data: bytesHex(log.data),
    inputCount: fields.length,
    inputs: fields.map(toFieldHex32),
    leaf: toFieldHex32(poseidon(...fields)),
  };
};
const logBytes = (length, seed) => Uint8Array.from({ length }, (_, index) => (seed + 7 * index) & 0xff);
const l1LogVectors = [
  {
    transactionIndex: 3n,
    logIndex: 7n,
    emitter: 0x1111111111111111111111111111111111111111n,
    topics: [logBytes(32, 0xa1), logBytes(32, 0x00), logBytes(32, 0x5c)],
    data: logBytes(128, 0x01),
  },
  {
    transactionIndex: 4n,
    logIndex: 0n,
    emitter: 0x2222222222222222222222222222222222222222n,
    topics: [logBytes(32, 0x33)],
    data: logBytes(200, 0x80),
  },
].map(normalizedLogVector);
// Carrier contexts: one sponge over the domain, kind, address, context length,
// and the context chunks.
const CARRIER_KIND_INBOX = 0n;
const CARRIER_KIND_EVENT = 1n;
const carrierContextVector = ({ name, kind, address, context }) => {
  const fields = [tag("CARRIER_CONTEXT_DOMAIN"), kind, address, BigInt(context.length), ...dataChunks(context)];
  return {
    name,
    kind: Number(kind),
    address: addressHex(address),
    context: bytesHex(context),
    inputCount: fields.length,
    inputs: fields.map(toFieldHex32),
    hash: toFieldHex32(poseidon(...fields)),
  };
};
const carrierContextVectors = [
  { name: "inbox sender, empty context", kind: CARRIER_KIND_INBOX, address: 0x3333333333333333333333333333333333333333n, context: new Uint8Array(0) },
  { name: "event emitter, empty context", kind: CARRIER_KIND_EVENT, address: 0x3333333333333333333333333333333333333333n, context: new Uint8Array(0) },
  { name: "event emitter, 17-byte context", kind: CARRIER_KIND_EVENT, address: 0x4444444444444444444444444444444444444444n, context: logBytes(17, 0x21) },
  {
    name: "event emitter, abi.encode(offerId, seller, amount, claimKeyCommitment)",
    kind: CARRIER_KIND_EVENT,
    address: 0x5555555555555555555555555555555555555555n,
    context: concatBytes(uint256Bytes(0x0ffe100000000001n), uint256Bytes(0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266n),
      uint256Bytes(10n ** 18n), uint256Bytes(0x23881371056048ee03fb4e8941cc78741871ed41c13e31684712d985e69c57e2n)),
  },
  { name: "event emitter, 200-byte context", kind: CARRIER_KIND_EVENT, address: 0x6666666666666666666666666666666666666666n, context: logBytes(200, 0x90) },
].map(carrierContextVector);
const header = {
  parentHash: historicalBlockHash,
  number: 42n,
  timestamp: 1_725_000_123n,
  transactionResultsRoot: digestField(hexBytes("0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210")),
  stateRoot,
  l1OriginRoot,
  historyRoot,
};
const headerNames = [
  "parentHash",
  "number",
  "timestamp",
  "transactionResultsRoot",
  "stateRoot",
  "l1OriginRoot",
  "historyRoot",
  "unassigned",
];
const headerValues = [
  header.parentHash,
  header.number,
  header.timestamp,
  header.transactionResultsRoot,
  header.stateRoot,
  header.l1OriginRoot,
  header.historyRoot,
  0n,
];
const headerTree = typedFieldTree(tag("BLOCK_HEADER_DOMAIN"), headerValues.map((value, key) => [key, value]));
const blockHash = headerTree.root;

const protocolVectors = {
  spec: "PCASH typed state, block header, history, authorization, and recovery commitments",
  fieldModulus: toUint256Hex32(P),
  chainId: Number(PCASH_CHAIN_ID),
  privateValueCommitment: {
    global: Object.fromEntries(Object.entries(transactionGlobal).map(([name, value]) => [name, toFieldHex32(value)])),
    inputs: inputSlotClasses.map((slotClass, index) => ({
      slotClass: Number(slotClass),
      inputCommitment: toFieldHex32(inputCommitments[index]),
      nullifier: toFieldHex32(transactionNullifiers[index]),
    })),
    outputs: outputSlotClasses.map((slotClass, index) => ({
      slotClass: Number(slotClass),
      outputBodyCommitment: toFieldHex32(outputBodyCommitments[index]),
    })),
    value: toFieldHex32(privateValueCommitmentValue),
  },
  outputDataHash: {
    outputData: bytesHex(outputDataItem),
    value: toFieldHex32(poseidonBytes(tag("OUTPUT_DATA_HASH_DOMAIN"), outputDataItem)),
  },
  arenaHash: {
    arena: bytesHex(arenaItem),
    value: toFieldHex32(arenaHashValue),
  },
  deliveryCommitment: {
    outputDataHashes: outputDataHashes.map(toFieldHex32),
    arenaHash: toFieldHex32(arenaHashValue),
    value: toFieldHex32(deliveryCommitmentValue),
  },
  payouts: {
    nkRoot: toFieldHex32(nkRoot),
    owner: toFieldHex32(ADDRESS),
    seed: toFieldHex32(payoutSeed),
    transactionContext: toFieldHex32(payoutTxContext),
    nullifiers: transactionNullifiers.map(toFieldHex32),
    issuanceSecret: toFieldHex32(issuanceSecret),
    issuanceOwnerCommitment: toFieldHex32(issuanceOwnerCommitment),
    batchItemBytes: bytesHex(payoutBatchItems),
    posterContext: toFieldHex32(posterContext),
    posterSecret: toFieldHex32(posterSecret),
    posterOwnerCommitment: toFieldHex32(posterOwnerCommitment),
  },
  authorizationCommitment: {
    address: toFieldHex32(ADDRESS),
    configurationCommitment: toFieldHex32(accountConfigurationCommitment),
    value: toFieldHex32(authorizationCommitmentValue),
  },
  actionCommitments: {
    pcashChainId: toFieldHex32(PCASH_CHAIN_ID),
    privateValueCommitment: toFieldHex32(privateValueCommitmentValue),
    transfer: actionCommitmentVector("TRANSFER_ACTION_DOMAIN", 0n),
    assetCreation: actionCommitmentVector("ASSET_CREATION_ACTION_DOMAIN", assetIdValue),
    sponsoredTransfer: actionCommitmentVector("SPONSORED_TRANSFER_ACTION_DOMAIN", 0n),
    contractFeeSponsorship: actionCommitmentVector("CONTRACT_FEE_SPONSORSHIP_ACTION_DOMAIN", contractAddress),
    accountUpdate: actionCommitmentVector("ACCOUNT_UPDATE_ACTION_DOMAIN", accountUpdateCommitmentValue),
  },
  assetComposition: {
    metadataCommitment: toFieldHex32(standardAssetMetadataCommitment),
    initialSupply: toFieldHex32(standardAssetInitialSupply),
    assetSecret: toFieldHex32(standardAssetSecret),
    assetSecretCommitment: toFieldHex32(standardAssetSecretCommitment),
    assetId: toFieldHex32(assetIdValue),
    marker: toFieldHex32(assetCreationMarker),
    input: {
      slot: 0,
      inputCommitment: toFieldHex32(assetInputNoteCommitment),
      amount: toFieldHex32(assetInputAmount),
      nullifier: toFieldHex32(assetInputNullifier),
    },
    nativeInput: {
      slot: Number(nativeInput.slot),
      inputCommitment: toFieldHex32(nativeInput.inputCommitment),
      amount: toFieldHex32(nativeInput.amount),
      nullifier: toFieldHex32(nativeInput.nullifier),
    },
  },
  outputNoteSecret: {
    noteNk: toFieldHex32(noteNullifierKey),
    noteSecretSeed: { operands: [toFieldHex32(noteNullifierKey)], value: toFieldHex32(outputNoteSecretSeed) },
    operands: {
      noteSecretSeed: toFieldHex32(outputNoteSecretSeed),
      nullifiers: transactionNullifiers.map(toFieldHex32),
      outputIndex: Number(outputNoteIndex),
      outputEntropy: toFieldHex32(outputEntropy),
    },
    noteSecret: toFieldHex32(outputNoteSecret),
  },
  outputCommitment: {
    outputBody: toFieldHex32(noteBody),
    outputIndex: Number(outputIndex),
    value: toFieldHex32(outputCommitmentValue),
  },
  accountStateCommitment: {
    address: toFieldHex32(ADDRESS),
    nullifierKeyCommitment: toFieldHex32(nullifierKeyCommitmentValue),
    accountRuleSetCommitment: toFieldHex32(accountRuleSetCommitment),
    accountRuleEntryCommitment: toFieldHex32(accountRuleEntry),
    applicationVkHash: toFieldHex32(applicationVkHash),
    configurationCommitment: toFieldHex32(accountConfigurationCommitment),
    commitmentBlinder: toFieldHex32(commitmentBlinder),
    accountRevision: toFieldHex32(accountRevision),
    receiveKey: bytesHex(receiveKey),
    receiveKeyHash: toFieldHex32(receiveKeyHash),
    userPresent: toFieldHex32(userAccountStateCommitment),
    userAbsent: toFieldHex32(clearedUserAccountStateCommitment),
    contractRevision: toFieldHex32(1n),
    contractAbsent: toFieldHex32(contractAccountStateCommitment),
  },
  contractAddress: {
    nkRoot: toFieldHex32(nkRoot),
    applicationVkHash: toFieldHex32(applicationVkHash),
    configurationCommitment: toFieldHex32(accountConfigurationCommitment),
    functionCommitment: toFieldHex32(contractFunctionCommitment),
    functionSetCommitment: toFieldHex32(contractFunctionSetCommitment),
    receiveKeyHash: toFieldHex32(0n),
    publishesNkRoot: true,
    preimage: toFieldHex32(contractPreimage),
    address: toFieldHex32(contractAddress),
  },
  accountUpdateCommitment: {
    domain: toFieldHex32(tag("ACCOUNT_UPDATE_COMMITMENT_DOMAIN")),
    operands: {
      address: toFieldHex32(ADDRESS),
      nullifierKeyCommitment: toFieldHex32(nullifierKeyCommitmentValue),
      currentRuleSetCommitment: toFieldHex32(accountRuleSetCommitment),
      currentAccountKind: 0,
      currentAccountRevision: toFieldHex32(accountRevision),
      currentReceiveKeyHash: toFieldHex32(receiveKeyHash),
      newRuleSetCommitment: toFieldHex32(newAccountRuleSetCommitment),
      newAccountKind: 0,
      newAccountRevision: toFieldHex32(newAccountRevision),
      newReceiveKeyHash: toFieldHex32(newReceiveKeyHash),
    },
    derived: {
      currentAccountStateCommitment: toFieldHex32(userAccountStateCommitment),
      newAccountStateCommitment: toFieldHex32(newUserAccountStateCommitment),
    },
    value: toFieldHex32(accountUpdateCommitmentValue),
  },
  nullifiers: {
    nkRoot: toFieldHex32(nkRoot),
    noteNk: toFieldHex32(noteNullifierKey),
    inputCommitment: toFieldHex32(inputCommitmentValue),
    noteSecret: toFieldHex32(noteSecretInput),
    dummyInputSeed: toFieldHex32(dummyInputSeed),
    inputIndex: 3,
    real: toFieldHex32(realNullifier),
    dummy: toFieldHex32(transactionNullifiers[3]),
  },
  nullifierTree: {
    depth: NULLIFIER_TREE_DEPTH,
    sentinel: {
      leaf: toFieldHex32(nullifierLeafHash(sentinelNullifierLeaf)),
      root: toFieldHex32(nullifierProofs[0].root),
    },
    insertions: nullifierInsertionVectors.map(({ value, index, root }) => ({
      value: toFieldHex32(value),
      index: Number(index),
      root: toFieldHex32(root),
    })),
    blockSizes: nullifierBlockSizes,
    leaves: nullifierTree.leaves().map((leaf) => ({
      index: Number(leaf.index),
      ...nullifierLeafVector(leaf),
      hash: toFieldHex32(nullifierLeafHash(leaf)),
    })),
    root: toFieldHex32(nullifierRoot),
    count: Number(nullifierCount),
    proofs: nullifierProofs.map((proof) => ({
      insertions: proof.insertions,
      root: toFieldHex32(proof.root),
      ...nullifierProofVector(proof),
      spent: nullifierProofSpent(proof),
    })),
    forgedProofs: forgedNullifierProofs.map((proof) => ({ name: proof.name, ...nullifierProofVector(proof) })),
    lowLeafCases: nullifierLowLeafCases.map((entry) => ({
      leaf: nullifierLeafVector(entry.leaf),
      nullifier: toFieldHex32(entry.nullifier),
      isLowLeaf: entry.isLowLeaf,
    })),
  },
  genesisParentHash: {
    pcashChainId: toFieldHex32(PCASH_CHAIN_ID),
    l1ChainId: toFieldHex32(L1_CHAIN_ID),
    inboxAddress: toFieldHex32(INBOX_ADDRESS),
    value: toFieldHex32(genesisParentHash),
  },
  l1OriginLeaf: {
    blockNumber: toFieldHex32(genesisL1Block),
    blockHash: bytesHex(genesisL1BlockHash),
    blockHashHigh128: toFieldHex32(genesisL1BlockHashHigh),
    blockHashLow128: toFieldHex32(genesisL1BlockHashLow),
    blockTimestamp: toFieldHex32(genesisL1BlockTimestamp),
    l1LogsRoot: toFieldHex32(genesisL1LogsRoot),
    l1LogCount: toFieldHex32(genesisL1LogCount),
    leaf: toFieldHex32(l1OriginLeafValue),
    root: toFieldHex32(l1OriginRoot),
    siblings: fieldEmpty.slice(0, 40).map(toFieldHex32),
  },
  l1Logs: l1LogVectors,
  carrierContexts: carrierContextVectors,
  transactionId: {
    l1BlockHash: bytesHex(genesisL1BlockHash),
    l1TransactionIndex: 2,
    batchItemIndex: 3,
    value: toFieldHex32(poseidon(tag("TRANSACTION_ID_DOMAIN"), genesisL1BlockHashHigh, genesisL1BlockHashLow, 2n, 3n)),
  },
  history: {
    depth: 40,
    blockNumber: toFieldHex32(historicalBlockNumber),
    blockHash: toFieldHex32(historicalBlockHash),
    leaf: toFieldHex32(historyLeafValue),
    root: toFieldHex32(historyRoot),
    siblings: fieldEmpty.slice(0, 40).map(toFieldHex32),
  },
  stateCommitment: {
    depth: 4,
    input: {
      ...Object.fromEntries(Object.entries(state).map(([name, value]) =>
        [name, name === "lagQ" ? value.toString() : toFieldHex32(value)])),
    },
    leaves: stateValues.map((value, key) => ({ key, name: stateNames[key], value: toFieldHex32(value) })),
    root: toFieldHex32(stateRoot),
    openings: stateValues.map((value, key) => ({
      key,
      value: toFieldHex32(value),
      siblings: stateTree.proof(key).map(toFieldHex32),
    })),
  },
  blockHeader: {
    depth: 4,
    parentHash: toFieldHex32(header.parentHash),
    number: toFieldHex32(header.number),
    timestamp: toFieldHex32(header.timestamp),
    transactionResultsRoot: toFieldHex32(header.transactionResultsRoot),
    stateRoot: toFieldHex32(header.stateRoot),
    l1OriginRoot: toFieldHex32(header.l1OriginRoot),
    historyRoot: toFieldHex32(header.historyRoot),
    leaves: headerValues.map((value, key) => ({ key, name: headerNames[key], value: toFieldHex32(value) })),
    openings: headerValues.map((value, key) => ({
      key,
      value: toFieldHex32(value),
      siblings: headerTree.proof(key).map(toFieldHex32),
    })),
    hash: toFieldHex32(blockHash),
  },
};
// Independent profile formulas: no SDK builder or shared witness code is used.
protocolVectors.privateValueProfiles = readPrivateValueProfiles(ROOT).map(profile => {
  const { shapeId: shape, inputs: I, outputs: O } = profile;
  const nullifiers = Array.from({ length: I }, (_, i) => i === 0 ? realNullifier
    : poseidon(tag("DUMMY_NULLIFIER_DOMAIN"), dummyInputSeed, BigInt(i)));
  const context = poseidon(tag("PAYOUT_TX_CONTEXT_DOMAIN"), PCASH_CHAIN_ID, BigInt(shape), BigInt(I), BigInt(O), ...nullifiers);
  const issuance = poseidon(tag("PAYOUT_NOTE_SECRET_DOMAIN"), payoutSeed, 3n, context);
  const profileOutputDataHashes = Array.from({ length: O }, (_, i) => 0x8001n + BigInt(i));
  const global = { ...transactionGlobal, assetBurnAmount: 0n,
    issuanceOwnerCommitment: poseidon(tag("OWNER_COMMITMENT_DOMAIN"), ADDRESS, issuance),
    deliveryCommitment: deliveryCommitmentOf(profileOutputDataHashes, arenaHashValue) };
  const inputs = nullifiers.map((nullifier, i) => ({ slotClass: i === 0 ? 1 : 0,
    inputCommitment: toFieldHex32(i === 0 ? inputCommitmentValue : 0n), nullifier: toFieldHex32(nullifier) }));
  const outputs = Array.from({ length: O }, (_, i) => ({ slotClass: i === O - 1 ? 1 : 0,
    outputBodyCommitment: toFieldHex32(0x7001n + BigInt(i)) }));
  const commitment = poseidon(tag("PRIVATE_VALUE_COMMITMENT_DOMAIN"), BigInt(shape), BigInt(I), BigInt(O), ...Object.values(global),
    ...inputs.flatMap((input) => [BigInt(input.slotClass), BigInt(input.inputCommitment), BigInt(input.nullifier)]),
    ...outputs.flatMap((output) => [BigInt(output.slotClass), BigInt(output.outputBodyCommitment)]));
  return { shape, inputCount: I, outputCount: O, nullifiers: nullifiers.map(toFieldHex32),
    delivery: { outputDataHashes: profileOutputDataHashes.map(toFieldHex32), arenaHash: toFieldHex32(arenaHashValue) },
    privateValue: { global: Object.fromEntries(Object.entries(global).map(([key, value]) => [key, toFieldHex32(value)])), inputs, outputs },
    privateValueCommitment: toFieldHex32(commitment), transactionContext: toFieldHex32(context),
    issuanceSecret: toFieldHex32(issuance),
    outputIndex: O - 1, outputEntropy: toFieldHex32(outputEntropy),
    outputNoteSecret: toFieldHex32(poseidon(tag("TRANSACT_NOTE_SECRET_DOMAIN"), outputNoteSecretSeed,
      BigInt(shape), BigInt(I), BigInt(O), ...nullifiers, BigInt(O - 1), outputEntropy)) };
});
// Transaction and payout results: one depth-64 tree, transactions in block
// order then payouts in settlement order, bound with both counts.
const denseFieldRoot = (leaves, depth) => {
  let level = leaves;
  for (let height = 0; height < depth; height++) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) next.push(poseidon(level[index], level[index + 1] ?? fieldEmpty[height]));
    level = next;
  }
  return level[0] ?? fieldEmpty[depth];
};
const resultsPoster = posterOwnerCommitment;
const resultsReward = 2n * 10n ** 18n;
const resultsOpenFee = 1_000n;
// The statement binds an example event under a per-transaction salt, followed by its attachment commitment.
const resultsEventEntry = poseidon(tag("EVENT_ENTRY_DOMAIN"), 0xe7e0n, 0n);
const resultsEventsCommitment = (salt) => poseidon(tag("EVENT_DOMAIN"), resultsEventEntry, salt);
const feeSection = (seed, fee) => [PCASH_CHAIN_ID, historicalBlockHash,
  ...[1n, 2n, 3n, 4n].map((slot) => seed + slot), ...[1n, 2n, 3n, 4n, 5n].map((slot) => seed + 0x100n + slot),
  seed + 0x200n, fee, 0n, 0n, 999n, 0xeeee01n, resultsEventsCommitment(seed + 0x300n), 0n];
const largeStatement = [PCASH_CHAIN_ID, historicalBlockHash,
  ...Array.from({ length: 32 }, (_, slot) => 0xa000n + BigInt(slot)),
  ...Array.from({ length: 32 }, (_, slot) => 0xb000n + BigInt(slot)),
  0xc000n, 0n, issuanceOwnerCommitment, 0n, 999n, 0xeeee02n, resultsEventsCommitment(0xc300n), 0n];
const attachmentCommitment = 0x5ec0n;
const resultTransactions = [
  {
    txType: 0, accountCreation: 0, l1TransactionIndex: 2n, batchItemIndex: 0n, outcomeCode: 0,
    posterOwnerCommitment: resultsPoster, outputStartIndex: 40n,
    statement: [PCASH_CHAIN_ID, historicalBlockHash, ...transactionNullifiers, ...outputBodyCommitments,
      deliveryCommitmentValue, 0n, issuanceOwnerCommitment, 10n, 999n, 0xeeee03n, resultsEventsCommitment(0xe300n), transactionGlobal.accountCreationCommitment],
  },
  {
    txType: 0, accountCreation: 0, l1TransactionIndex: 2n, batchItemIndex: 1n, outcomeCode: 0,
    posterOwnerCommitment: resultsPoster, outputStartIndex: 45n, statement: largeStatement,
  },
  {
    txType: 3, accountCreation: 0, l1TransactionIndex: 2n, batchItemIndex: 2n, outcomeCode: 0,
    posterOwnerCommitment: resultsPoster, outputStartIndex: 77n,
    statement: [...feeSection(0x9000n, resultsOpenFee), accountUpdateCommitmentValue],
  },
  {
    txType: 0, accountCreation: 1, l1TransactionIndex: 3n, batchItemIndex: 0n, outcomeCode: 0,
    posterOwnerCommitment: resultsPoster, outputStartIndex: 82n,
    statement: [...feeSection(0x9800n, 0n).slice(0, -1), attachmentCommitment],
  },
  {
    txType: 1, accountCreation: 1, l1TransactionIndex: 3n, batchItemIndex: 1n, outcomeCode: 0,
    posterOwnerCommitment: resultsPoster, outputStartIndex: 0n,
    statement: [ADDRESS, nullifierKeyCommitmentValue, accountRuleSetCommitment, receiveKeyHash],
  },
  {
    txType: 2, accountCreation: 1, l1TransactionIndex: 3n, batchItemIndex: 3n, outcomeCode: 0,
    posterOwnerCommitment: resultsPoster, outputStartIndex: 0n,
    statement: [contractAddress, nullifierKeyCommitmentValue, contractFunctionSetCommitment, 0n],
  },
  {
    txType: 2, accountCreation: 0, l1TransactionIndex: 4n, batchItemIndex: 0n, outcomeCode: 8,
    posterOwnerCommitment: 0x5151n, outputStartIndex: 0n, statement: null,
  },
].map((result) => {
  const statementHash = result.statement === null ? 0n : poseidon(tag("TRANSACTION_STATEMENT_DOMAIN"), ...result.statement);
  // The leaf's tree index is the transaction's position, so the leaf omits it.
  const leaf = poseidon(tag("TRANSACTION_RESULT_DOMAIN"), BigInt(result.txType), BigInt(result.accountCreation),
    result.l1TransactionIndex, result.batchItemIndex, BigInt(result.outcomeCode),
    result.posterOwnerCommitment, result.outputStartIndex, statementHash);
  return { ...result, statementHash, leaf };
});
const resultPayouts = [
  { outputIndex: 87n, ownerCommitment: issuanceOwnerCommitment, openFeeAmount: 0n, issuanceAmount: resultsReward },
  { outputIndex: 88n, ownerCommitment: resultsPoster, openFeeAmount: resultsOpenFee, issuanceAmount: 0n },
  { outputIndex: 89n, ownerCommitment: resultsPoster, openFeeAmount: 0n, issuanceAmount: resultsReward },
].map((payout) => ({
  ...payout,
  leaf: poseidon(tag("PAYOUT_RESULT_DOMAIN"), payout.outputIndex, payout.ownerCommitment, payout.openFeeAmount, payout.issuanceAmount),
}));
const resultsTreeRoot = denseFieldRoot([...resultTransactions, ...resultPayouts].map((result) => result.leaf), FIELD_TREE_DEPTH);
protocolVectors.transactionResults = {
  depth: FIELD_TREE_DEPTH,
  transactions: resultTransactions.map((result) => ({
    txType: result.txType,
    accountCreation: result.accountCreation,
    l1TransactionIndex: Number(result.l1TransactionIndex),
    batchItemIndex: Number(result.batchItemIndex),
    outcomeCode: result.outcomeCode,
    posterOwnerCommitment: toFieldHex32(result.posterOwnerCommitment),
    outputStartIndex: Number(result.outputStartIndex),
    statement: result.statement === null ? null : result.statement.map(toFieldHex32),
    statementHash: toFieldHex32(result.statementHash),
    leaf: toFieldHex32(result.leaf),
  })),
  payouts: resultPayouts.map((payout) => ({
    outputIndex: Number(payout.outputIndex),
    ownerCommitment: toFieldHex32(payout.ownerCommitment),
    openFeeAmount: toFieldHex32(payout.openFeeAmount),
    issuanceAmount: toFieldHex32(payout.issuanceAmount),
    leaf: toFieldHex32(payout.leaf),
  })),
  treeRoot: toFieldHex32(resultsTreeRoot),
  root: toFieldHex32(poseidon(tag("TRANSACTION_RESULTS_ROOT_DOMAIN"), BigInt(resultTransactions.length),
    BigInt(resultPayouts.length), resultsTreeRoot)),
  emptyRoot: toFieldHex32(poseidon(tag("TRANSACTION_RESULTS_ROOT_DOMAIN"), 0n, 0n, fieldEmpty[FIELD_TREE_DEPTH])),
};
write("vectors/protocol_vectors.json", protocolVectors);

// The assets the Noir known answers derive from. They are written from the same
// in-memory vectors as the JSON files, not read back from them.
const VECTOR_INPUTS = ["assets/network_profile.json", "assets/domain_tags.json", "assets/private_value_profiles.json"];

const assertCall = (callee, args, expected) => noir.noirStatement(noir.assert(noir.eq(noir.call(callee, ...args), expected)));
const assertEq = (actual, expected) => noir.noirStatement(noir.assert(noir.eq(actual, expected)));
const letValue = (name, value, type) => noir.noirStatement(value, { name, type });
const protocolNoirVectors = () => {
  const l1Origin = protocolVectors.l1OriginLeaf;
  const history = protocolVectors.history;
  const stateCommitment = protocolVectors.stateCommitment;
  const blockHeader = protocolVectors.blockHeader;
  const accountUpdate = protocolVectors.accountUpdateCommitment;
  const asset = protocolVectors.assetComposition;
  const accountUpdateOperands = accountUpdate.operands;
  const accountUpdateDerived = accountUpdate.derived;
  const authorization = protocolVectors.authorizationCommitment;
  const actions = protocolVectors.actionCommitments;
  const accountState = protocolVectors.accountStateCommitment;
  const contract = protocolVectors.contractAddress;
  const tests = [];
  const test = (name, ...statements) => tests.push(noir.noirTest(name, statements));
  test("test_standard_asset_composition_matches_published_vector",
    assertCall("asset_secret_commitment", [asset.assetSecret], asset.assetSecretCommitment),
    assertCall("standard_fungible_asset_id", [asset.metadataCommitment, asset.initialSupply, asset.assetSecretCommitment], asset.assetId),
    assertCall("asset_creation_marker", [asset.assetId, asset.assetSecret], asset.marker));
  const userAccountState = (receiveKeyHash) => [accountState.address, accountState.nullifierKeyCommitment, accountState.accountRuleSetCommitment, "ACCOUNT_KIND_USER", accountState.accountRevision, receiveKeyHash];
  test("test_account_state_commitments_match_published_vectors",
    assertCall("account_state_commitment", userAccountState(accountState.receiveKeyHash), accountState.userPresent),
    assertCall("account_state_commitment", userAccountState(0), accountState.userAbsent),
    assertCall("account_state_commitment", [contract.address, accountState.nullifierKeyCommitment, contract.functionSetCommitment, "ACCOUNT_KIND_CONTRACT", accountState.contractRevision, 0], accountState.contractAbsent));
  const nullifiers = protocolVectors.nullifiers;
  test("test_nullifiers_match_published_vectors",
    assertCall("note_nk", [nullifiers.nkRoot], nullifiers.noteNk),
    assertCall("nullifier", [nullifiers.inputCommitment, nullifiers.noteNk, nullifiers.noteSecret], nullifiers.real),
    assertCall("dummy_nullifier", [nullifiers.dummyInputSeed, nullifiers.inputIndex], nullifiers.dummy));
  const output = protocolVectors.outputCommitment;
  test("test_output_commitment_matches_published_vector",
    assertCall("output_commitment", [output.outputBody, output.outputIndex], output.value));
  test("test_account_rule_entry_commitment_matches_published_vector",
    assertCall("account_rule_entry_commitment", [accountState.applicationVkHash, accountState.configurationCommitment, accountState.commitmentBlinder], accountState.accountRuleEntryCommitment));
  test("test_authorization_commitment_matches_published_vector",
    assertCall("authorization_commitment", [authorization.address, authorization.configurationCommitment], authorization.value));
  test("test_action_commitments_match_published_vectors",
    letValue("pcash_chain_id", actions.pcashChainId),
    letValue("commitment", actions.privateValueCommitment),
    assertCall("transfer_action_commitment", ["pcash_chain_id", "commitment"], actions.transfer.value),
    assertCall("asset_creation_action_commitment", ["pcash_chain_id", "commitment", actions.assetCreation.extraData], actions.assetCreation.value),
    assertCall("sponsored_transfer_action_commitment", ["pcash_chain_id", "commitment"], actions.sponsoredTransfer.value),
    assertCall("contract_fee_sponsorship_action_commitment", ["pcash_chain_id", "commitment", actions.contractFeeSponsorship.extraData], actions.contractFeeSponsorship.value),
    assertCall("account_update_action_commitment", ["pcash_chain_id", "commitment", actions.accountUpdate.extraData], actions.accountUpdate.value));
  const accountStateOf = (ruleSetCommitment, revision, receiveKeyHash) => noir.call("account_state_commitment",
    accountUpdateOperands.address, accountUpdateOperands.nullifierKeyCommitment, ruleSetCommitment, "ACCOUNT_KIND_USER", revision, receiveKeyHash);
  test("test_account_update_commitment_matches_published_vector",
    letValue("current_account_state_commitment", accountStateOf(accountUpdateOperands.currentRuleSetCommitment, accountUpdateOperands.currentAccountRevision, accountUpdateOperands.currentReceiveKeyHash)),
    assertEq("current_account_state_commitment", accountUpdateDerived.currentAccountStateCommitment),
    letValue("new_account_state_commitment", accountStateOf(accountUpdateOperands.newRuleSetCommitment, accountUpdateOperands.newAccountRevision, accountUpdateOperands.newReceiveKeyHash)),
    assertEq("new_account_state_commitment", accountUpdateDerived.newAccountStateCommitment),
    assertCall("account_update_commitment", ["current_account_state_commitment", "new_account_state_commitment"], accountUpdate.value));
  test("test_l1_origin_leaf_and_path_match_published_vector",
    letValue("siblings", noir.array(l1Origin.siblings), "[Field; 40]"),
    assertCall("l1_origin_leaf", [l1Origin.blockNumber, l1Origin.blockHashHigh128, l1Origin.blockHashLow128, l1Origin.blockTimestamp, l1Origin.l1LogsRoot, l1Origin.l1LogCount], l1Origin.leaf),
    assertCall("binary_root_from_index", [l1Origin.leaf, 0, "siblings"], l1Origin.root));
  for (const [index, log] of protocolVectors.l1Logs.entries()) {
    if (log.inputCount !== 22) continue;
    const inputs = log.inputs;
    test(`test_normalized_log_leaf_${index}_matches_published_vector`,
      assertCall("normalized_log_leaf", [...inputs.slice(1, 5), noir.array(inputs.slice(5, 13)), inputs[13], noir.array(inputs.slice(14, 22))], log.leaf));
  }
  for (const [index, vector] of protocolVectors.carrierContexts.entries()) {
    const context = hexBytes(vector.context);
    test(`test_carrier_context_hash_${index}_matches_published_vector`,
      letValue("context", noir.byteArray(context), `[u8; ${context.length}]`),
      assertCall("carrier_context_hash", [vector.kind === 0 ? "CARRIER_KIND_INBOX" : "CARRIER_KIND_EVENT", toFieldHex32(BigInt(vector.address)), "context"], vector.hash));
  }
  test("test_history_leaf_and_path_match_published_vector",
    letValue("siblings", noir.array(history.siblings), "[Field; 40]"),
    assertCall("history_leaf", [history.blockHash], history.leaf),
    assertCall("binary_root_from_index", [history.leaf, history.blockNumber, "siblings"], history.root));
  for (const opening of stateCommitment.openings) {
    test(`test_state_opening_${opening.key}_matches_published_vector`,
      letValue("siblings", noir.array(opening.siblings), `[Field; ${stateCommitment.depth}]`),
      assertCall("state_root_from_opening", [opening.value, opening.key, "siblings"], stateCommitment.root));
  }
  for (const opening of blockHeader.openings) {
    test(`test_block_header_opening_${opening.key}_matches_published_vector`,
      letValue("siblings", noir.array(opening.siblings), `[Field; ${blockHeader.depth}]`),
      assertCall("block_hash_from_opening", [opening.value, opening.key, "siblings"], blockHeader.hash));
  }
  for (const profile of protocolVectors.privateValueProfiles) {
    const { privateValue: tx } = profile;
    const fields = Object.fromEntries(Object.entries(tx.global).map(([key, value]) => [key.replace(/[A-Z]/g, letter => "_" + letter.toLowerCase()), value]));
    for (const [field, values] of [
      ["input_slot_classes", tx.inputs.map(input => input.slotClass)], ["input_commitments", tx.inputs.map(input => input.inputCommitment)],
      ["nullifiers", profile.nullifiers], ["output_slot_classes", tx.outputs.map(output => output.slotClass)],
      ["output_body_commitments", tx.outputs.map(output => output.outputBodyCommitment)],
    ]) fields[field] = noir.array(values);
    test(`test_profile_${profile.shape}_private_value_commitment_matches_published_vector`,
      letValue("output_data_hashes", noir.array(profile.delivery.outputDataHashes), `[Field; ${profile.outputCount}]`),
      assertCall("delivery_commitment", ["output_data_hashes", profile.delivery.arenaHash], tx.global.deliveryCommitment),
      letValue("tx", noir.struct("PrivateValue", fields), `PrivateValue<${profile.inputCount}, ${profile.outputCount}, ${profile.shape}>`),
      assertCall("private_value_commitment", ["tx"], profile.privateValueCommitment));
  }
  return generatedHeader("scripts/gen_vectors.mjs", VECTOR_INPUTS)
    + "// Exact cross-language known-answer tests.\n\n"
    + noir.noirUses([
      ["crate::state::block", ["block_hash_from_opening", "history_leaf", "state_root_from_opening"]],
      ["crate::state::carrier_context", ["carrier_context_hash", "CARRIER_KIND_EVENT", "CARRIER_KIND_INBOX"]],
      ["crate::state::l1_logs", ["l1_origin_leaf", "normalized_log_leaf"]],
      ["crate::state::merkle", ["binary_root_from_index"]],
      ["crate::ledger::asset", ["asset_creation_marker", "asset_secret_commitment", "standard_fungible_asset_id"]],
      ["crate::ledger::note", ["dummy_nullifier", "note_nk", "nullifier", "output_commitment"]],
      ["crate::authorization::account", ["account_rule_entry_commitment", "account_state_commitment", "account_update_commitment", "ACCOUNT_KIND_CONTRACT", "ACCOUNT_KIND_USER"]],
      ["crate::authorization::statement", ["account_update_action_commitment", "asset_creation_action_commitment", "authorization_commitment", "contract_fee_sponsorship_action_commitment", "sponsored_transfer_action_commitment", "transfer_action_commitment"]],
      ["crate::ledger::private_value", ["delivery_commitment", "private_value_commitment", "PrivateValue"]],
    ])
    + `\n${tests.join("\n")}`;
};
writeText("circuits/protocol/lib/src/generated/protocol_vectors.nr", protocolNoirVectors());

const referenceRuleVectors = {
  profile: REFERENCE_ASSET.profile,
  status: REFERENCE_ASSET.status,
  domains: Object.fromEntries(
    Object.entries(REFERENCE_ASSET.tags).map(([name, value]) => [name, value]),
  ),
  configurationCommitments: {
    salt: toFieldHex32(configurationSalt),
    generic: { fields: genericConfigurationFields.map(toFieldHex32), value: toFieldHex32(genericConfiguration) },
    ecdsa: {
      nullifierKeyCommitment: toFieldHex32(nullifierKeyCommitmentValue),
      l1ChainId: toFieldHex32(L1_CHAIN_ID),
      inboxAddress: toFieldHex32(INBOX_ADDRESS),
      domainSeparator: bytesHex(domainSeparator),
      domainSeparatorHigh128: toFieldHex32(domainSeparatorHigh),
      domainSeparatorLow128: toFieldHex32(domainSeparatorLow),
      value: toFieldHex32(ecdsaConfiguration),
    },
    multisig: {
      threshold: toFieldHex32(multisigThreshold),
      signerAddresses: multisigSigners.map(toFieldHex32),
      value: toFieldHex32(multisigConfiguration),
    },
    assetCovenantSuccessor: {
      fields: covenantSuccessorFields.map(toFieldHex32),
      value: toFieldHex32(covenantSuccessorConfiguration),
    },
  },
};
write("vectors/reference_rule_vectors.json", referenceRuleVectors);

const referenceNoirVectors = () => {
  const payouts = protocolVectors.payouts;
  const tests = [];
  const test = (name, ...statements) => tests.push(noir.noirTest(name, statements));
  const configuration = noir.struct("Configuration", {
    domain_separator_high: toFieldHex32(domainSeparatorHigh),
    domain_separator_low: toFieldHex32(domainSeparatorLow),
  });
  test("test_reference_configuration_commitments_match_published_vectors",
    letValue("configuration", configuration),
    assertCall("configuration_commitment", ["configuration", toFieldHex32(nullifierKeyCommitmentValue)], toFieldHex32(ecdsaConfiguration)),
    assertCall("asset_covenant_successor_configuration_commitment", covenantSuccessorFields.map(toFieldHex32), toFieldHex32(covenantSuccessorConfiguration)));
  // The payout context and issuance secret are the S profile's, checked below.
  test("test_payout_seed_matches_published_vector",
    assertCall("payout_seed", [payouts.nkRoot], payouts.seed));
  for (const profile of protocolVectors.privateValueProfiles) {
    const generics = `::<${profile.inputCount}, ${profile.outputCount}, ${profile.shape}>`;
    test(`test_profile_${profile.shape}_contexts_match_published_vectors`,
      letValue("nullifiers", noir.array(profile.nullifiers)),
      assertCall(`transaction_context${generics}`, [PCASH_CHAIN_ID, "nullifiers"], profile.transactionContext),
      assertCall("payout_note_secret", [payouts.seed, "ISSUANCE_ROLE", profile.transactionContext], profile.issuanceSecret),
      assertCall(`note_secret${generics}`, [toFieldHex32(outputNoteSecretSeed), "nullifiers", profile.outputIndex, profile.outputEntropy], profile.outputNoteSecret));
  }
  return generatedHeader("scripts/gen_vectors.mjs", [...VECTOR_INPUTS, "assets/reference_rule_profile.json"])
    + "// Exact optional reference-rule known-answer tests.\n\n"
    + noir.noirUses([
      ["crate::asset_covenant", ["asset_covenant_successor_configuration_commitment"]],
      ["crate::configuration", ["configuration_commitment", "Configuration"]],
      ["crate::payout", ["note_secret", "payout_note_secret", "payout_seed", "transaction_context", "ISSUANCE_ROLE"]],
    ])
    + `\n${tests.join("\n")}`;
};
writeText("circuits/rules/lib/src/generated/reference_rule_vectors.nr", referenceNoirVectors());

// Reference ECDSA and readable-rule EIP-712 vectors.
const signingHashFor = (structHash) => keccak_256(concatBytes(Uint8Array.from([0x19, 0x01]), domainSeparator, structHash));
const paymentType = "PcashPayment(uint256 pcashChainId,address recipient,uint256 amount,uint256 openFeeAmount,address issuanceRecipient,uint256 issuanceOwnerCommitment,uint256 relayFeeAmount,uint256 relayFeeOwnerCommitment,uint256 accountCreationCommitment,uint256 transactionContext,uint64 notBefore,uint64 validUntil)";
const detailType = "PcashTransactionDetail(uint256 pcashChainId,address authorizingAddress,uint256 spentAssetId,uint256 spentAssetAmount,uint256 assetBurnAmount," +
  [0, 1, 2, 3, 4].map((index) =>
    `address out${index}Recipient,uint256 out${index}Amount,uint256 out${index}AssetId`).join(",") +
  ",uint256 openFeeAmount,address issuanceRecipient,uint256 issuanceOwnerCommitment,uint256 accountCreationCommitment,uint256 transactionContext,uint64 notBefore,uint64 validUntil,uint256 privateValueCommitment)";
const paymentFields = [
  PCASH_CHAIN_ID,
  0x2222222222222222222222222222222222222222n,
  1000n,
  0n,
  ADDRESS,
  transactionGlobal.issuanceOwnerCommitment,
  0n,
  0n,
  transactionGlobal.accountCreationCommitment,
  payoutTxContext,
  10n,
  999n,
];
const detailFields = [
  PCASH_CHAIN_ID,
  ADDRESS,
  0n,
  0n,
  transactionGlobal.assetBurnAmount,
  ...[0, 1, 2, 3, 4].flatMap((index) => index === 0
    ? [0x2222222222222222222222222222222222222222n, 1000n, 0n]
    : [0n, 0n, 0n]),
  0n,
  ADDRESS,
  transactionGlobal.issuanceOwnerCommitment,
  transactionGlobal.accountCreationCommitment,
  payoutTxContext,
  10n,
  999n,
  privateValueCommitmentValue,
];
const readableVector = (primaryType, type, fields) => {
  const typeHash = keccak_256(utf8(type));
  const structHash = keccak_256(concatBytes(typeHash, ...fields.map(uint256Bytes)));
  return {
    primaryType,
    type,
    typeHash: bytesHex(typeHash),
    fields: fields.map(toUint256Hex32),
    structHash: bytesHex(structHash),
    signingHash: bytesHex(signingHashFor(structHash)),
  };
};
write("vectors/reference_ecdsa_rule_vectors.json", {
  profile: "reference-ecdsa-transaction",
  status: "SDK ECDSA signing examples",
  spec: "Reference ECDSA messages",
  configurationCommitment: {
    domain: toFieldHex32(referenceTag("REFERENCE_CONFIGURATION_DOMAIN")),
    domainSeparatorHigh128: toFieldHex32(domainSeparatorHigh),
    domainSeparatorLow128: toFieldHex32(domainSeparatorLow),
    nullifierKeyCommitment: toFieldHex32(nullifierKeyCommitmentValue),
    value: toFieldHex32(ecdsaConfiguration),
  },
  eip712: {
    domain: {
      type: networkProfile.eip712.domainType,
      name: networkProfile.eip712.name,
      version: networkProfile.eip712.version,
      l1ChainId: NETWORK.l1ChainId,
      verifyingContract: NETWORK.inboxAddress,
      typeHash: bytesHex(domainTypeHash),
      nameHash: bytesHex(nameHash),
      versionHash: bytesHex(versionHash),
      separator: bytesHex(domainSeparator),
    },
  },
  readableRules: {
    payment: readableVector("PcashPayment", paymentType, paymentFields),
    transactionDetail: readableVector("PcashTransactionDetail", detailType, detailFields),
  },
});

await runGenerator(import.meta, outputs);
