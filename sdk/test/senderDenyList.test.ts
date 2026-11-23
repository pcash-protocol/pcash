import { describe, expect, it } from "vitest";
import { encodeAbiParameters, toHex as viemHex } from "viem";
import {
  applyListChanges,
  buildDenyListTree,
  decodeListChangedLog,
  decodePublicationLog,
  DENY_LIST_TREE_DEPTH,
  denyListConfigurationCommitment,
  denyListGapLeaf,
  LIST_CHANGED_TOPIC0,
  PUBLICATION_TOPIC0,
  senderDenyListWitness,
  type SenderDenyListWitnessParams,
} from "../src/rules/senderDenyList.ts";
import { rootFromIndex } from "../src/crypto/merkle.ts";
import { BN254_SCALAR_MODULUS } from "../src/crypto/field.ts";
import { l1LogGroundingWitnessMap, normalizedL1LogLeaf, type L1LogGrounding, type L1LogInput } from "../src/protocol/l1Logs.ts";
import { beBytes } from "../src/utils/bytes.ts";
import { fromHex, toHex } from "../src/utils/hex.ts";

const CONTRACT = 0x5fbdb2315678afecb367f032d93f642f64180aa3n;
const LIST_ID = fromHex("0x0123456789abcdef0123456789abcdeffedcba9876543210fedcba9876543210");
const DENIED_A = 0x1000000000000000000000000000000000000001n;
const DENIED_B = 0x3000000000000000000000000000000000000003n;
const OWNER = 0x2000000000000000000000000000000000000002n;
const ADDRESS_LIMIT = 1n << 160n;
const BLOCK_TIME = 1_700_000_000n;
const DELTA = 3600n;
const MAX_DELTA = 7200n;

// Frozen in the circuit's test_formulas_match_the_sdk
// (circuits/rules/sender_deny_list/src/main.nr).
const KAT = {
  configurationCommitment: 0x016a1f64fcf60005031453f0546bbd3ae9d4d835bb8e3a7d337cd7f97f81913en,
  gapLeaf: 0x019c14ddb43c21d299d7316c9302618c1b689109d603f2f31f20f147ca8c1e98n,
  root: 0x0f15b8a54c25218b91735ae5541e4dd2bf8c8434619ed3d84438ac7823d7fe0an,
  emptyRoot: 0x1bf25e297989559b9950a906acb89a45c9968cb23b309cf510055e5b22cbe282n,
  publicationLeaf: 0x0f6e44e4309c266eabcfeb9ec5a9efe63973a6d0b501cbd6404cfd307eede3f6n,
};

function publicationData(root: bigint, paused: bigint, delta: bigint): Uint8Array {
  const data = new Uint8Array(96);
  data.set(beBytes(root, 32), 0);
  data.set(beBytes(paused, 32), 32);
  data.set(beBytes(delta, 32), 64);
  return data;
}

function publicationLog(root: bigint, overrides: Partial<L1LogInput> = {}): L1LogInput {
  return {
    transactionIndex: 5,
    logIndex: 2,
    emitter: CONTRACT,
    topics: [PUBLICATION_TOPIC0, LIST_ID],
    data: publicationData(root, 0n, DELTA),
    ...overrides,
  };
}

function listChangedLog(added: bigint[], removed: bigint[]): L1LogInput {
  const address = (value: bigint) => viemHex(value, { size: 20 });
  const data = encodeAbiParameters(
    [{ type: "address[]" }, { type: "address[]" }],
    [added.map(address), removed.map(address)],
  );
  return { transactionIndex: 1, logIndex: 0, emitter: CONTRACT, topics: [LIST_CHANGED_TOPIC0, LIST_ID], data: fromHex(data) };
}

// The witness builder reads the opening's block time and passes the rest to
// the circuit unchanged.
const OPENING: L1LogGrounding = {
  l1OriginRoot: 0n,
  l1OriginRootSiblings: [7n, 8n, 9n, 10n],
  l1BlockNumber: 100n,
  l1BlockHash: new Uint8Array(32).fill(0xab),
  l1BlockTimestamp: BLOCK_TIME,
  l1OriginIndex: 0n,
  l1OriginSiblings: Array<bigint>(40).fill(0n),
  logsRoot: 0n,
  logCount: 1n,
  logLeafIndex: 0n,
  logSiblings: Array<bigint>(64).fill(0n),
  transactionIndex: 5n,
  logIndex: 2n,
};

function witnessParams(overrides: Partial<SenderDenyListWitnessParams> = {}): SenderDenyListWitnessParams {
  const tree = buildDenyListTree([DENIED_A, DENIED_B]);
  return {
    assetId: 0xabcn,
    ownerAddress: OWNER,
    validUntilTimestamp: BLOCK_TIME + 60n,
    configuration: { contractAddress: CONTRACT, listId: LIST_ID, maxDelta: MAX_DELTA },
    publicationLog: publicationLog(tree.root),
    publicationOpening: OPENING,
    gap: tree.gapOpening(OWNER),
    actionCommitment: 0xac7n,
    recentPcashBlockHash: 0x5ebn,
    eventEntry: 0xe7n,
    ...overrides,
  };
}

describe("sender deny list", () => {
  it("names the contract's Publication event", () => {
    expect(toHex(PUBLICATION_TOPIC0)).toBe("0x926351d1bdc982eb7b14f6579a5b0bba64f919d051adf326ea4cb58d3e0e1796");
  });

  it("matches the circuit's configuration, gap, root and log formulas", () => {
    expect(denyListConfigurationCommitment({ contractAddress: CONTRACT, listId: LIST_ID, maxDelta: MAX_DELTA })).toBe(KAT.configurationCommitment);
    expect(denyListGapLeaf(DENIED_A, DENIED_B)).toBe(KAT.gapLeaf);
    expect(buildDenyListTree([DENIED_A, DENIED_B]).root).toBe(KAT.root);
    expect(buildDenyListTree([]).root).toBe(KAT.emptyRoot);
    expect(normalizedL1LogLeaf(publicationLog(KAT.root))).toBe(KAT.publicationLeaf);
  });

  it("builds gaps over the sorted, deduplicated list without address zero", () => {
    const tree = buildDenyListTree([DENIED_B, DENIED_A, DENIED_B, 0n]);
    expect(tree.denied).toEqual([DENIED_A, DENIED_B]);
    expect(tree.root).toBe(KAT.root);
    expect(tree.isDenied(DENIED_A)).toBe(true);
    expect(tree.isDenied(OWNER)).toBe(false);
    expect(tree.isDenied(0n)).toBe(false);
    const expectations: [bigint, bigint, bigint, number][] = [
      [1n, 0n, DENIED_A, 0],
      [DENIED_A - 1n, 0n, DENIED_A, 0],
      [DENIED_A + 1n, DENIED_A, DENIED_B, 1],
      [OWNER, DENIED_A, DENIED_B, 1],
      [DENIED_B + 1n, DENIED_B, ADDRESS_LIMIT, 2],
      [ADDRESS_LIMIT - 1n, DENIED_B, ADDRESS_LIMIT, 2],
    ];
    for (const [address, lower, upper, index] of expectations) {
      const gap = tree.gapOpening(address);
      expect([gap.lower, gap.upper, gap.index]).toEqual([lower, upper, index]);
      expect(gap.siblings).toHaveLength(DENY_LIST_TREE_DEPTH);
      expect(rootFromIndex(denyListGapLeaf(gap.lower, gap.upper), gap.index, gap.siblings)).toBe(tree.root);
    }
    expect(() => tree.gapOpening(DENIED_A)).toThrow("address is denied");
    expect(() => tree.gapOpening(DENIED_B)).toThrow("address is denied");
    expect(() => tree.gapOpening(0n)).toThrow("address zero has no gap");
    expect(() => buildDenyListTree([ADDRESS_LIMIT])).toThrow("160 bits");
  });

  it("opens every address of an empty list in the one gap", () => {
    const tree = buildDenyListTree([]);
    expect(tree.gapOpening(1n)).toMatchObject({ lower: 0n, upper: ADDRESS_LIMIT, index: 0 });
    expect(tree.gapOpening(ADDRESS_LIMIT - 1n)).toMatchObject({ lower: 0n, upper: ADDRESS_LIMIT, index: 0 });
  });

  it("decodes exactly the Publication event", () => {
    expect(decodePublicationLog(publicationLog(KAT.root))).toEqual({ listId: LIST_ID, root: KAT.root, paused: false, delta: DELTA });
    expect(decodePublicationLog(publicationLog(KAT.root, { data: publicationData(KAT.root, 1n, DELTA) })).paused).toBe(true);
    const reject = (overrides: Partial<L1LogInput>, message: string) =>
      expect(() => decodePublicationLog(publicationLog(KAT.root, overrides))).toThrow(message);
    reject({ topics: [LIST_CHANGED_TOPIC0, LIST_ID] }, "not a deny-list Publication log");
    reject({ topics: [PUBLICATION_TOPIC0] }, "not a deny-list Publication log");
    reject({ topics: [PUBLICATION_TOPIC0, LIST_ID, LIST_ID] }, "not a deny-list Publication log");
    reject({ data: publicationData(KAT.root, 0n, DELTA).subarray(0, 64) }, "96 bytes");
    reject({ data: new Uint8Array(128) }, "96 bytes");
    reject({ data: publicationData(KAT.root, 2n, DELTA) }, "bool");
    reject({ data: publicationData(KAT.root, 0n, 1n << 64n) }, "uint64");
    reject({ data: publicationData(BN254_SCALAR_MODULUS, 0n, DELTA) }, "field element");
  });

  it("rebuilds a list from ListChanged events", () => {
    const first = decodeListChangedLog(listChangedLog([DENIED_A, DENIED_B, OWNER], []));
    expect(first).toEqual({ listId: LIST_ID, added: [DENIED_A, DENIED_B, OWNER], removed: [] });
    const set = applyListChanges(new Set(), first);
    applyListChanges(set, decodeListChangedLog(listChangedLog([], [OWNER])));
    expect(buildDenyListTree(set).root).toBe(KAT.root);
    // Removals apply first, so an address both added and removed stays denied.
    applyListChanges(set, decodeListChangedLog(listChangedLog([OWNER], [OWNER, DENIED_A])));
    expect(set).toEqual(new Set([DENIED_B, OWNER]));
  });

  it("decodes exactly the canonical ListChanged encoding", () => {
    const log = listChangedLog([DENIED_A], [DENIED_B]);
    const mutate = (edit: (data: Uint8Array) => Uint8Array) => ({ ...log, data: edit(log.data.slice()) });
    expect(() => decodeListChangedLog({ ...log, topics: [PUBLICATION_TOPIC0, LIST_ID] })).toThrow("not a deny-list ListChanged log");
    // A second offset that points past the first array's end.
    expect(() => decodeListChangedLog(mutate((data) => { data[63] = data[63]! + 32; return data; }))).toThrow("canonically");
    // A trailing word.
    expect(() => decodeListChangedLog(mutate((data) => new Uint8Array([...data, ...new Uint8Array(32)])))).toThrow("canonically");
    // An array length past the data.
    expect(() => decodeListChangedLog(mutate((data) => { data[95] = 9; return data; }))).toThrow("canonically");
    // An entry with bits above 160.
    expect(() => decodeListChangedLog(mutate((data) => { data[96] = 1; return data; }))).toThrow("addresses");
    expect(() => decodeListChangedLog(mutate((data) => data.subarray(0, 100)))).toThrow("32-byte words");
  });

  it("builds the circuit's witness", () => {
    const params = witnessParams();
    const tree = buildDenyListTree([DENIED_A, DENIED_B]);
    const gap = tree.gapOpening(OWNER);
    const field = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
    expect(senderDenyListWitness(params)).toEqual({
      asset_id: field(0xabcn),
      owner_address: field(OWNER),
      valid_until_timestamp: field(BLOCK_TIME + 60n),
      action_commitment: field(0xac7n),
      recent_pcash_block_hash: field(0x5ebn),
      event_entry: field(0xe7n),
      configuration: {
        contract_address: field(CONTRACT),
        list_id_high: field(0x0123456789abcdef0123456789abcdefn),
        list_id_low: field(0xfedcba9876543210fedcba9876543210n),
        max_delta: field(MAX_DELTA),
      },
      publication: {
        root_high: field(KAT.root >> 128n),
        root_low: field(KAT.root & ((1n << 128n) - 1n)),
        delta: field(DELTA),
        log: l1LogGroundingWitnessMap(OPENING),
      },
      gap: { lower: field(DENIED_A), upper: field(DENIED_B), index: field(1n), siblings: gap.siblings.map(field) },
    });
    expect(() => senderDenyListWitness({ ...params, validUntilTimestamp: BLOCK_TIME + DELTA })).not.toThrow();
  });

  it("refuses a witness the circuit would reject", () => {
    const root = buildDenyListTree([DENIED_A, DENIED_B]).root;
    const reject = (overrides: Partial<SenderDenyListWitnessParams>, message: string) =>
      expect(() => senderDenyListWitness(witnessParams(overrides))).toThrow(message);
    reject({ publicationLog: publicationLog(root, { data: publicationData(root, 1n, DELTA) }) }, "paused");
    reject({ publicationLog: publicationLog(root, { emitter: CONTRACT + 1n }) }, "configured deny list");
    reject({ configuration: { contractAddress: CONTRACT, listId: new Uint8Array(32), maxDelta: MAX_DELTA } }, "configured deny list");
    reject({ validUntilTimestamp: BLOCK_TIME + DELTA + 1n }, "window");
    reject({ ownerAddress: DENIED_A }, "does not contain the owner");
    // The list rebuilt from the events lacks a later addition the publication covers.
    reject({ gap: buildDenyListTree([DENIED_A]).gapOpening(OWNER) }, "published root");
  });
});
