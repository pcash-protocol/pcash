import { describe, expect, it } from "vitest";
import {
  L1_LOG_DOMAIN,
  L1_LOG_TREE_DEPTH,
  l1LogGroundingWitnessMap,
  normalizeL1Logs,
  normalizedL1LogLeaf,
  verifyNormalizedL1LogPath,
  type L1LogGrounding,
  type L1LogInput,
} from "../src/protocol/l1Logs.ts";
import { poseidon } from "../src/crypto/poseidon2.ts";
import { fromHex } from "../src/utils/hex.ts";

const bytes = (value: string): Uint8Array => fromHex(`0x${value}`);

/** Shared with the node's and the Marketplace claim circuit's payment-leaf tests. */
const PAYMENT_LEAF = 0x045d9f041cb3d786fb8f1bfe2e1fa41e448a40180259f5b9630817a8f180cb4fn;

/** The leaf's sponge inputs, built from hex text: 16-byte chunks, at least eight. */
function expectedInputs(log: { transactionIndex: bigint; logIndex: bigint; emitter: bigint; topics: string[]; data: string }): bigint[] {
  const topicLimbs = [...log.topics, ...Array<string>(4 - log.topics.length).fill("0".repeat(64))]
    .flatMap((topic) => [BigInt(`0x${topic.slice(0, 32)}`), BigInt(`0x${topic.slice(32)}`)]);
  const chunks = (log.data.match(/.{1,32}/g) ?? []).map((chunk) => BigInt(`0x${chunk}`));
  while (chunks.length < 8) chunks.push(0n);
  return [
    L1_LOG_DOMAIN, log.transactionIndex, log.logIndex, log.emitter, BigInt(log.topics.length),
    ...topicLimbs, BigInt(log.data.length / 2), ...chunks,
  ];
}

describe("normalized L1 logs", () => {
  it("matches the Rust and Noir Marketplace payment leaf, exactly 128 data bytes in 22 inputs", () => {
    const topics = [
      "c02c8dd7548cf1c2910d8245edc9a318c696615c2bd0d630c6d0e9a130754b0c",
      "0000000000000000000000000000000000000000000000000ffe100000000001",
      "000000000000000000000000000000000000000000000000000000000000d0d0",
      "000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    ];
    const data =
      "0000000000000000000000000000000000000000000000000000000050435348" +
      "0000000000000000000000000000000000000000000000000de0b6b3a7640000" +
      "0000000000000000000000000000000000000000000000000000000077359400" +
      "23881371056048ee03fb4e8941cc78741871ed41c13e31684712d985e69c57e2";
    const emitter = 0x5fbdb2315678afecb367f032d93f642f64180aa3n;
    const inputs = expectedInputs({ transactionIndex: 1n, logIndex: 1n, emitter, topics, data });
    expect(inputs).toHaveLength(22);
    const leaf = normalizedL1LogLeaf({ transactionIndex: 1, logIndex: 1, emitter, topics: topics.map(bytes), data: bytes(data) });
    expect(leaf).toBe(poseidon(inputs));
    expect(leaf).toBe(PAYMENT_LEAF);
  });

  it("appends the chunks of a log longer than 128 bytes, the last one unpadded", () => {
    const topics = ["ab".repeat(32)];
    const data = Array.from({ length: 145 }, (_, index) => ((index * 7 + 3) & 0xff).toString(16).padStart(2, "0")).join("");
    const inputs = expectedInputs({ transactionIndex: 9n, logIndex: 4n, emitter: 0x1234n, topics, data });
    expect(inputs).toHaveLength(24);
    expect(inputs.at(-1)).toBe(BigInt(`0x${data.slice(-2)}`));
    expect(normalizedL1LogLeaf({ transactionIndex: 9, logIndex: 4, emitter: 0x1234n, topics: topics.map(bytes), data: bytes(data) }))
      .toBe(poseidon(inputs));
  });

  it("builds and opens a dense block tree", () => {
    const normalized = normalizeL1Logs(Array.from({ length: 256 }, (_, logIndex) => ({
      transactionIndex: 0,
      logIndex,
      emitter: 0n,
      topics: [],
      data: Uint8Array.of(logIndex & 0xff),
    })));
    expect(normalized.logs).toHaveLength(256);
    expect(normalized.proof(255)).toHaveLength(64);
  });
});

const log = (logIndex: number, data: Uint8Array = Uint8Array.of(logIndex)): L1LogInput => ({
  transactionIndex: 0,
  logIndex,
  emitter: 0x1234n,
  topics: [new Uint8Array(32).fill(logIndex)],
  data,
});

describe("normalized L1 log edges", () => {
  it("roots an empty block at the all-empty depth-64 root", () => {
    let empty = 0n;
    for (let height = 0; height < L1_LOG_TREE_DEPTH; height++) empty = poseidon([empty, empty]);
    const normalized = normalizeL1Logs([]);
    expect(normalized.root).toBe(empty);
    expect(normalized.logs).toEqual([]);
    expect(() => normalized.proof(0)).toThrow("L1 log index out of range");
  });

  it("rejects a proof index outside the log list", () => {
    const normalized = normalizeL1Logs([log(0), log(1), log(2)]);
    expect(() => normalized.proof(3)).toThrow("L1 log index out of range");
    expect(() => normalized.proof(-1)).toThrow("L1 log index out of range");
    expect(normalized.proof(2)).toHaveLength(L1_LOG_TREE_DEPTH);
  });

  it("rejects more than four topics and topics that are not 32 bytes", () => {
    const topic = new Uint8Array(32);
    expect(() => normalizedL1LogLeaf({ ...log(0), topics: [topic, topic, topic, topic, topic] }))
      .toThrow("an L1 log has at most four topics");
    expect(() => normalizedL1LogLeaf({ ...log(0), topics: [topic, new Uint8Array(31)] }))
      .toThrow("topic 1 must be 32 bytes");
    expect(normalizedL1LogLeaf({ ...log(0), topics: [topic, topic, topic, topic] })).toBeTypeOf("bigint");
  });

  it("pads a short log to eight chunks with its partial chunk unpadded", () => {
    const data = Array.from({ length: 17 }, (_, index) => (index + 1).toString(16).padStart(2, "0")).join("");
    const inputs = expectedInputs({ transactionIndex: 2n, logIndex: 3n, emitter: 5n, topics: [], data });
    expect(inputs).toHaveLength(22);
    expect(inputs[15]).toBe(17n);
    expect(normalizedL1LogLeaf({ transactionIndex: 2, logIndex: 3, emitter: 5n, topics: [], data: bytes(data) }))
      .toBe(poseidon(inputs));
  });

  it("separates a zero topic from an absent one and leading zero data bytes from none", () => {
    const base = { transactionIndex: 0, logIndex: 0, emitter: 1n, topics: [] as Uint8Array[], data: Uint8Array.of(1) };
    expect(normalizedL1LogLeaf({ ...base, topics: [new Uint8Array(32)] })).not.toBe(normalizedL1LogLeaf(base));
    expect(normalizedL1LogLeaf({ ...base, data: Uint8Array.of(0, 1) })).not.toBe(normalizedL1LogLeaf(base));
  });

  it("verifies a path only with 64 siblings and an index below the count", () => {
    const logs = [log(0), log(1), log(2)];
    const normalized = normalizeL1Logs(logs);
    const grounding = { logsRoot: normalized.root, logCount: 3, logLeafIndex: 2, logSiblings: normalized.proof(2) };
    expect(verifyNormalizedL1LogPath(grounding, logs[2]!)).toBe(true);
    expect(verifyNormalizedL1LogPath(grounding, logs[1]!)).toBe(false);
    expect(verifyNormalizedL1LogPath({ ...grounding, logSiblings: grounding.logSiblings.slice(1) }, logs[2]!))
      .toBe(false);
    expect(verifyNormalizedL1LogPath({ ...grounding, logCount: 2 }, logs[2]!)).toBe(false);
  });
});

describe("l1LogGroundingWitnessMap", () => {
  const grounding = (): L1LogGrounding => ({
    l1OriginRoot: 1n,
    l1OriginRootSiblings: new Array(4).fill(0n),
    l1BlockNumber: 7,
    l1BlockHash: new Uint8Array(32).fill(0xab),
    l1BlockTimestamp: 1_700_000_000,
    l1OriginIndex: 3,
    l1OriginSiblings: new Array(40).fill(0n),
    logsRoot: 2n,
    logCount: 1,
    logLeafIndex: 0,
    logSiblings: new Array(L1_LOG_TREE_DEPTH).fill(0n),
    transactionIndex: 0,
    logIndex: 0,
  });

  it("maps a well-formed grounding with the block hash as its two halves", () => {
    const map = l1LogGroundingWitnessMap(grounding());
    expect(map.l1_block_hash_high).toBe(`0x${"0".repeat(32)}${"ab".repeat(16)}`);
    expect(map.l1_block_hash_low).toBe(`0x${"0".repeat(32)}${"ab".repeat(16)}`);
    expect(map.log_siblings).toHaveLength(L1_LOG_TREE_DEPTH);
  });

  it.each([
    ["l1OriginRootSiblings", "l1OriginRootSiblings must have depth 4", 3],
    ["l1OriginSiblings", "l1OriginSiblings must have depth 40", 41],
    ["logSiblings", `logSiblings must have depth ${L1_LOG_TREE_DEPTH}`, 63],
  ] as const)("rejects %s of the wrong depth", (key, message, length) => {
    expect(() => l1LogGroundingWitnessMap({ ...grounding(), [key]: new Array(length).fill(0n) }))
      .toThrow(message);
  });

  it("rejects a block hash that is not 32 bytes", () => {
    expect(() => l1LogGroundingWitnessMap({ ...grounding(), l1BlockHash: new Uint8Array(31) }))
      .toThrow("l1BlockHash must be 32 bytes");
  });
});
