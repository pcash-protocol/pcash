import { fieldToHex, type FieldNumberish, toField } from "../crypto/field.ts";
import { poseidon } from "../crypto/poseidon2.ts";
import { rootFromIndex } from "../crypto/merkle.ts";
import { L1_ORIGIN_DOMAIN, L1_LOG_DOMAIN } from "../constants/domainTags.ts";
import { U64_LIMIT, uintBelow } from "../utils/validate.ts";
import { splitHash256 } from "../utils/bytes.ts";

export { L1_ORIGIN_DOMAIN, L1_LOG_DOMAIN } from "../constants/domainTags.ts";

export const L1_LOG_TREE_DEPTH = 64;
export interface L1LogInput {
  transactionIndex: bigint | number;
  logIndex: bigint | number;
  emitter: FieldNumberish;
  topics: readonly Uint8Array[];
  data: Uint8Array;
}

export interface NormalizedL1Log extends L1LogInput {
  leafIndex: number;
  leaf: bigint;
}

export interface L1LogGrounding {
  l1OriginRoot: FieldNumberish;
  l1OriginRootSiblings: readonly FieldNumberish[];
  l1BlockNumber: bigint | number;
  /** The full 32-byte Ethereum block hash; the L1 origin leaf commits its two 128-bit halves. */
  l1BlockHash: Uint8Array;
  l1BlockTimestamp: bigint | number;
  l1OriginIndex: bigint | number;
  l1OriginSiblings: readonly FieldNumberish[];
  logsRoot: FieldNumberish;
  logCount: bigint | number;
  logLeafIndex: bigint | number;
  logSiblings: readonly FieldNumberish[];
  transactionIndex: bigint | number;
  logIndex: bigint | number;
}

/** Data chunk slots every leaf carries; a longer log appends its remaining chunks. */
const L1_LOG_MIN_DATA_CHUNKS = 8;

/**
 * Log data, and a carrier context, as 16-byte big-endian chunks, the last one
 * the big-endian integer of its own bytes, zero-padded to at least eight.
 */
export function logDataChunks(data: Uint8Array): bigint[] {
  const chunks = new Array<bigint>(Math.max(L1_LOG_MIN_DATA_CHUNKS, Math.ceil(data.length / 16))).fill(0n);
  for (let offset = 0; offset < data.length; offset += 16) {
    let chunk = 0n;
    for (const byte of data.subarray(offset, offset + 16)) chunk = (chunk << 8n) | BigInt(byte);
    chunks[offset / 16] = chunk;
  }
  return chunks;
}

/**
 * One sponge over the log: indices, emitter, topic count, four topics as
 * high/low 128-bit limbs (zero when absent), data length, and the data chunks.
 */
export function normalizedL1LogLeaf(log: L1LogInput): bigint {
  if (log.topics.length > 4) throw new Error("an L1 log has at most four topics");
  const topicLimbs = new Array<bigint>(8).fill(0n);
  log.topics.forEach((topic, index) => {
    const split = splitHash256(topic, `topic ${index}`);
    topicLimbs[index * 2] = split.high128;
    topicLimbs[index * 2 + 1] = split.low128;
  });
  const dataLength = uintBelow(log.data.length, U64_LIMIT, "data.length");
  return poseidon([
    L1_LOG_DOMAIN,
    uintBelow(log.transactionIndex, U64_LIMIT, "transactionIndex"),
    uintBelow(log.logIndex, U64_LIMIT, "logIndex"),
    toField(log.emitter, "emitter"),
    BigInt(log.topics.length),
    ...topicLimbs,
    dataLength,
    ...logDataChunks(log.data),
  ]);
}

export function verifyNormalizedL1LogPath(
  grounding: Pick<L1LogGrounding, "logsRoot" | "logCount" | "logLeafIndex" | "logSiblings">,
  log: L1LogInput,
): boolean {
  const count = uintBelow(grounding.logCount, U64_LIMIT, "logCount");
  const index = uintBelow(grounding.logLeafIndex, U64_LIMIT, "logLeafIndex");
  if (grounding.logSiblings.length !== L1_LOG_TREE_DEPTH || index >= count) return false;
  return rootFromIndex(normalizedL1LogLeaf(log), index, grounding.logSiblings) ===
    toField(grounding.logsRoot, "logsRoot");
}

export function l1LogGroundingWitnessMap(grounding: L1LogGrounding): Record<string, unknown> {
  if (grounding.l1OriginRootSiblings.length !== 4) {
    throw new Error("l1OriginRootSiblings must have depth 4");
  }
  if (grounding.l1OriginSiblings.length !== 40) {
    throw new Error("l1OriginSiblings must have depth 40");
  }
  if (grounding.logSiblings.length !== L1_LOG_TREE_DEPTH) {
    throw new Error(`logSiblings must have depth ${L1_LOG_TREE_DEPTH}`);
  }
  const field = (value: FieldNumberish): string => fieldToHex(toField(value));
  const blockHash = splitHash256(grounding.l1BlockHash, "l1BlockHash");
  return {
    l1_origin_root_siblings: grounding.l1OriginRootSiblings.map(field),
    l1_block_number: field(grounding.l1BlockNumber),
    l1_block_hash_high: field(blockHash.high128),
    l1_block_hash_low: field(blockHash.low128),
    l1_block_timestamp: field(grounding.l1BlockTimestamp),
    l1_origin_index: field(grounding.l1OriginIndex),
    l1_origin_siblings: grounding.l1OriginSiblings.map(field),
    log_count: field(grounding.logCount),
    log_leaf_index: field(grounding.logLeafIndex),
    log_siblings: grounding.logSiblings.map(field),
    transaction_index: field(grounding.transactionIndex),
    log_index: field(grounding.logIndex),
  };
}

export function normalizeL1Logs(logs: readonly L1LogInput[]): {
  root: bigint;
  logs: NormalizedL1Log[];
  proof(leafIndex: number): bigint[];
} {
  const normalized = logs.map((log, leafIndex) => {
    const leaf = normalizedL1LogLeaf(log);
    return { ...log, leafIndex, leaf };
  });
  const empty = new Array<bigint>(L1_LOG_TREE_DEPTH + 1).fill(0n);
  for (let height = 0; height < L1_LOG_TREE_DEPTH; height++) {
    empty[height + 1] = poseidon([empty[height]!, empty[height]!]);
  }
  const levels: bigint[][] = [normalized.map((log) => log.leaf)];
  for (let height = 0; height < L1_LOG_TREE_DEPTH; height++) {
    const current = levels[height]!;
    const next: bigint[] = [];
    for (let index = 0; index < current.length; index += 2) {
      next.push(poseidon([current[index]!, current[index + 1] ?? empty[height]!]));
    }
    levels.push(next);
  }
  return {
    root: levels[L1_LOG_TREE_DEPTH]![0] ?? empty[L1_LOG_TREE_DEPTH]!,
    logs: normalized,
    proof(leafIndex: number): bigint[] {
      if (leafIndex < 0 || leafIndex >= normalized.length) throw new Error("L1 log index out of range");
      let index = leafIndex;
      const siblings: bigint[] = [];
      for (let height = 0; height < L1_LOG_TREE_DEPTH; height++) {
        siblings.push(levels[height]![index ^ 1] ?? empty[height]!);
        index >>= 1;
      }
      return siblings;
    },
  };
}

/**
 * The L1 origin leaf of one Ethereum block. It commits the full Ethereum block
 * hash as its two 128-bit halves, so an opening authenticates all 256 bits.
 */
export function l1OriginLeaf(params: {
  blockNumber: bigint | number;
  blockHash: Uint8Array;
  timestamp: bigint | number;
  logsRoot: FieldNumberish;
  logCount: bigint | number;
}): bigint {
  const blockHash = splitHash256(params.blockHash, "Ethereum block hash");
  return poseidon([
    L1_ORIGIN_DOMAIN,
    uintBelow(params.blockNumber, U64_LIMIT, "blockNumber"),
    blockHash.high128,
    blockHash.low128,
    uintBelow(params.timestamp, U64_LIMIT, "timestamp"),
    toField(params.logsRoot, "logsRoot"),
    uintBelow(params.logCount, U64_LIMIT, "logCount"),
  ]);
}
