// The standard sender deny-list transfer rule: its configuration, the gap tree
// whose root the issuer's deny-list contract publishes, the decoders for that
// contract's `Publication` and `ListChanged` logs, and the witness of
// `transfer_rule_sender_deny_list`.

import { type FieldNumberish, BN254_SCALAR_MODULUS, toAddressField, toField } from "../crypto/field.ts";
import { DenseMerkleTree } from "../crypto/denseMerkleTree.ts";
import { rootFromIndex } from "../crypto/merkle.ts";
import { poseidon } from "../crypto/poseidon2.ts";
import {
  REFERENCE_DENY_LIST_CONFIGURATION_DOMAIN,
  REFERENCE_DENY_LIST_GAP_DOMAIN,
} from "../constants/referenceRuleConstants.ts";
import { l1LogGroundingWitnessMap, type L1LogGrounding, type L1LogInput } from "../protocol/l1Logs.ts";
import { fieldArrayMap, fm, type WitnessMap } from "../protocol/witness.ts";
import { bytesEqual, bytesToBigInt, splitHash256, utf8 } from "../utils/bytes.ts";
import { keccak256 } from "../utils/keccak.ts";
import { U160_LIMIT, U64_LIMIT, uintBelow } from "../utils/validate.ts";

export const DENY_LIST_TREE_DEPTH = 20;

/** topic0 of `Publication(bytes32 indexed listId, uint256 root, bool paused, uint64 delta)`. */
export const PUBLICATION_TOPIC0 = keccak256(utf8("Publication(bytes32,uint256,bool,uint64)"));
/** topic0 of `ListChanged(bytes32 indexed listId, address[] added, address[] removed)`. */
export const LIST_CHANGED_TOPIC0 = keccak256(utf8("ListChanged(bytes32,address[],address[])"));

export interface DenyListConfiguration {
  contractAddress: FieldNumberish;
  /** The contract's 32-byte list identifier. */
  listId: Uint8Array;
  /** The largest delta, in seconds, a publication may carry: no publication authorizes transfers longer after it. */
  maxDelta: bigint;
}

function maxDeltaOf(configuration: DenyListConfiguration): bigint {
  if (configuration.maxDelta <= 0n || configuration.maxDelta >= U64_LIMIT) throw new Error("maxDelta must be a positive uint64");
  return configuration.maxDelta;
}

export function denyListConfigurationCommitment(configuration: DenyListConfiguration): bigint {
  const listId = splitHash256(configuration.listId, "listId");
  return poseidon([
    REFERENCE_DENY_LIST_CONFIGURATION_DOMAIN,
    toAddressField(configuration.contractAddress, "contractAddress"),
    listId.high128,
    listId.low128,
    maxDeltaOf(configuration),
  ]);
}

/** The leaf of the open interval (lower, upper) between consecutive denied addresses. */
export function denyListGapLeaf(lower: bigint, upper: bigint): bigint {
  return poseidon([REFERENCE_DENY_LIST_GAP_DOMAIN, lower, upper]);
}

export interface DenyListGapOpening {
  lower: bigint;
  upper: bigint;
  index: number;
  siblings: bigint[];
}

export interface DenyListTree {
  root: bigint;
  /** The denied addresses, ascending. */
  denied: readonly bigint[];
  isDenied(address: FieldNumberish): boolean;
  /** The gap strictly containing `address`. Throws for a denied address and for address zero. */
  gapOpening(address: FieldNumberish): DenyListGapOpening;
}

/**
 * The depth-20 tree of gaps between the sorted denied addresses: leaf i is
 * the gap (bounds[i], bounds[i + 1]) of bounds = [0, ...denied, 2^160], and
 * unused leaves are zero. Address zero owns nothing, so it is never in the
 * list. An empty list is the one gap (0, 2^160).
 */
export function buildDenyListTree(addresses: Iterable<FieldNumberish>): DenyListTree {
  const unique = new Set<bigint>();
  for (const address of addresses) unique.add(toAddressField(address, "denied address"));
  unique.delete(0n);
  const denied = [...unique].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (denied.length >= 2 ** DENY_LIST_TREE_DEPTH) {
    throw new Error(`a deny list holds fewer than 2^${DENY_LIST_TREE_DEPTH} addresses`);
  }
  const bounds = [0n, ...denied, U160_LIMIT];
  const tree = new DenseMerkleTree(
    DENY_LIST_TREE_DEPTH,
    Array.from({ length: denied.length + 1 }, (_, index) => denyListGapLeaf(bounds[index]!, bounds[index + 1]!)),
  );
  // The number of denied addresses below `value`, which is the index of its gap.
  const rank = (value: bigint): number => {
    let low = 0, high = denied.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (denied[middle]! < value) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return {
    root: tree.root(),
    denied,
    isDenied(address) {
      const value = toAddressField(address, "address");
      return denied[rank(value)] === value;
    },
    gapOpening(address) {
      const value = toAddressField(address, "address");
      if (value === 0n) throw new Error("address zero has no gap");
      const index = rank(value);
      if (denied[index] === value) throw new Error("address is denied");
      return { lower: bounds[index]!, upper: bounds[index + 1]!, index, siblings: tree.path(index) };
    },
  };
}

export interface DenyListPublication {
  listId: Uint8Array;
  root: bigint;
  paused: boolean;
  delta: bigint;
}

type EventLog = Pick<L1LogInput, "topics" | "data">;

function words(data: Uint8Array): bigint[] {
  if (data.length % 32 !== 0) throw new Error("log data must be whole 32-byte words");
  return Array.from({ length: data.length / 32 }, (_, i) => bytesToBigInt(data.subarray(32 * i, 32 * i + 32)));
}

function listIdOf(log: EventLog, topic0: Uint8Array, name: string): Uint8Array {
  if (log.topics.length !== 2 || !bytesEqual(log.topics[0]!, topic0) || log.topics[1]!.length !== 32) {
    throw new Error(`not a deny-list ${name} log`);
  }
  return log.topics[1]!.slice();
}

/** Decodes a `Publication` log; rejects any other topic layout or data encoding. */
export function decodePublicationLog(log: EventLog): DenyListPublication {
  const listId = listIdOf(log, PUBLICATION_TOPIC0, "Publication");
  if (log.data.length !== 96) throw new Error("Publication data must be 96 bytes");
  const [root, paused, delta] = words(log.data) as [bigint, bigint, bigint];
  if (root >= BN254_SCALAR_MODULUS) throw new Error("Publication root must be a field element");
  if (paused > 1n) throw new Error("Publication paused flag must be a bool");
  if (delta >= U64_LIMIT) throw new Error("Publication delta must be a uint64");
  return { listId, root, paused: paused === 1n, delta };
}

export interface DenyListChange {
  listId: Uint8Array;
  added: bigint[];
  removed: bigint[];
}

/** Decodes a `ListChanged` log; rejects any other topic layout or a non-canonical ABI encoding. */
export function decodeListChangedLog(log: EventLog): DenyListChange {
  const listId = listIdOf(log, LIST_CHANGED_TOPIC0, "ListChanged");
  const data = words(log.data);
  const array = (headWord: number, start: number): bigint[] => {
    const length = data[start];
    if (data[headWord] !== BigInt(32 * start) || length === undefined || length > BigInt(data.length)) {
      throw new Error("ListChanged data must be canonically encoded");
    }
    const values = data.slice(start + 1, start + 1 + Number(length));
    if (values.length !== Number(length)) throw new Error("ListChanged data must be canonically encoded");
    if (values.some((value) => value >= U160_LIMIT)) throw new Error("ListChanged entries must be addresses");
    return values;
  };
  const added = array(0, 2);
  const removed = array(1, 3 + added.length);
  if (data.length !== 4 + added.length + removed.length) throw new Error("ListChanged data must be canonically encoded");
  return { listId, added, removed };
}

/**
 * Applies one `ListChanged` event to `set` in place and returns it. Removals
 * apply before additions, so an address named in both stays denied.
 */
export function applyListChanges(
  set: Set<bigint>,
  change: { added: readonly FieldNumberish[]; removed: readonly FieldNumberish[] },
): Set<bigint> {
  for (const address of change.removed) set.delete(toAddressField(address, "removed address"));
  for (const address of change.added) set.add(toAddressField(address, "added address"));
  return set;
}

export interface SenderDenyListWitnessParams {
  assetId: FieldNumberish;
  ownerAddress: FieldNumberish;
  validUntilTimestamp: bigint | number;
  configuration: DenyListConfiguration;
  publicationLog: L1LogInput;
  /**
   * The log's opening under `recentPcashBlockHash`. A node's L1 log proof
   * supplies it with `logsRoot` and `logCount` named `l1LogsRoot` and `l1LogCount`.
   */
  publicationOpening: L1LogGrounding;
  /** The owner's gap in the list rebuilt from the contract's `ListChanged` logs. */
  gap: DenyListGapOpening;
  actionCommitment: FieldNumberish;
  recentPcashBlockHash: FieldNumberish;
  eventEntry: FieldNumberish;
}

/** The witness map of `transfer_rule_sender_deny_list`. */
export function senderDenyListWitness(params: SenderDenyListWitnessParams): WitnessMap {
  const { configuration, gap } = params;
  const publication = decodePublicationLog(params.publicationLog);
  const contractAddress = toAddressField(configuration.contractAddress, "contractAddress");
  if (toField(params.publicationLog.emitter, "emitter") !== contractAddress ||
    !bytesEqual(publication.listId, configuration.listId)) {
    throw new Error("publication is not from the configured deny list");
  }
  if (publication.paused) throw new Error("the deny list is paused");
  if (publication.delta > maxDeltaOf(configuration)) throw new Error("the publication's delta exceeds the list's maximum");
  const validUntil = uintBelow(params.validUntilTimestamp, U64_LIMIT, "validUntilTimestamp");
  if (validUntil > BigInt(params.publicationOpening.l1BlockTimestamp) + publication.delta) {
    throw new Error("validUntilTimestamp is past the publication's window");
  }
  const owner = toAddressField(params.ownerAddress, "ownerAddress");
  if (!(gap.lower < owner && owner < gap.upper)) throw new Error("gap does not contain the owner");
  if (rootFromIndex(denyListGapLeaf(gap.lower, gap.upper), gap.index, gap.siblings) !== publication.root) {
    throw new Error("the rebuilt deny list does not match the published root");
  }
  const listId = splitHash256(configuration.listId, "listId");
  const root = splitHash256(params.publicationLog.data.subarray(0, 32), "root");
  return {
    asset_id: fm(params.assetId),
    owner_address: fm(owner),
    valid_until_timestamp: fm(validUntil),
    action_commitment: fm(params.actionCommitment),
    recent_pcash_block_hash: fm(params.recentPcashBlockHash),
    event_entry: fm(params.eventEntry),
    configuration: {
      contract_address: fm(contractAddress),
      list_id_high: fm(listId.high128),
      list_id_low: fm(listId.low128),
      max_delta: fm(maxDeltaOf(params.configuration)),
    },
    publication: {
      root_high: fm(root.high128),
      root_low: fm(root.low128),
      delta: fm(publication.delta),
      log: l1LogGroundingWitnessMap(params.publicationOpening),
    },
    gap: {
      lower: fm(gap.lower),
      upper: fm(gap.upper),
      index: fm(BigInt(gap.index)),
      siblings: fieldArrayMap(gap.siblings),
    },
  };
}
