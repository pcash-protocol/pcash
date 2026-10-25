import {
  blockHash,
  stateRoot,
  type BlockHeaderCommitment,
  type StateCommitment,
} from "./block.ts";
import { type FieldNumberish, fieldToHex, toField, toNonnegativeBigInt } from "../crypto/field.ts";
import { fixedHex } from "../utils/hex.ts";
import { U40_LIMIT, U64_LIMIT, uintBelow } from "../utils/validate.ts";

export interface StateComponents extends StateCommitment {
  outputRoot: bigint;
  outputCount: bigint;
  issuedSoFar: bigint;
  lagQ: bigint;
  accountStateRoot: bigint;
  accountCount: bigint;
  nullifierRoot: bigint;
  nullifierCount: bigint;
}

export interface PcashBlockHeader extends BlockHeaderCommitment {
  parentHash: bigint;
  number: bigint;
  timestamp: bigint;
  transactionResultsRoot: bigint;
  stateRoot: bigint;
  l1OriginRoot: bigint;
  historyRoot: bigint;
}

export interface CurrentBoundaryEnvelope {
  state: StateComponents;
  header: PcashBlockHeader;
  blockHash: bigint;
}

export interface CurrentBoundaryEnvelopeRpc {
  state: {
    outputRoot: string;
    outputCount: string;
    issuedSoFar: string;
    lagQ: string;
    accountStateRoot: string;
    accountCount: string;
    nullifierRoot: string;
    nullifierCount: string;
  };
  header: {
    parentHash: string;
    number: string;
    timestamp: string;
    transactionResultsRoot: string;
    stateRoot: string;
    l1OriginRoot: string;
    historyRoot: string;
  };
  blockHash: string;
}

function fieldHex(value: string, name: string): bigint {
  return toField(BigInt(fixedHex(value, 32, name)), name);
}

function count(value: FieldNumberish, name: string): bigint {
  const parsed = toNonnegativeBigInt(value, name);
  if (parsed > U40_LIMIT) throw new Error(`${name} exceeds the depth-40 tree capacity`);
  return parsed;
}

function money(value: FieldNumberish, name: string): bigint {
  const parsed = toNonnegativeBigInt(value, name);
  if (parsed >= 1n << 192n) throw new Error(`${name} must fit in u192`);
  return parsed;
}

function i256(value: string, name: string): bigint {
  if (!/^-?[0-9]+$/.test(value)) throw new Error(`${name} must be a signed decimal integer`);
  const parsed = BigInt(value);
  if (parsed < -(1n << 255n) || parsed >= 1n << 255n) throw new Error(`${name} must fit in i256`);
  return parsed;
}

export function computeStateRoot(state: StateComponents): bigint {
  return stateRoot(state);
}

export function computeBlockHash(header: PcashBlockHeader): bigint {
  return blockHash(header);
}

export function parseCurrentBoundaryEnvelope(raw: CurrentBoundaryEnvelopeRpc): CurrentBoundaryEnvelope {
  const envelope: CurrentBoundaryEnvelope = {
    state: {
      outputRoot: fieldHex(raw.state.outputRoot, "state.outputRoot"),
      outputCount: count(raw.state.outputCount, "state.outputCount"),
      issuedSoFar: money(raw.state.issuedSoFar, "state.issuedSoFar"),
      lagQ: i256(raw.state.lagQ, "state.lagQ"),
      accountStateRoot: fieldHex(raw.state.accountStateRoot, "state.accountStateRoot"),
      accountCount: count(raw.state.accountCount, "state.accountCount"),
      nullifierRoot: fieldHex(raw.state.nullifierRoot, "state.nullifierRoot"),
      nullifierCount: count(raw.state.nullifierCount, "state.nullifierCount"),
    },
    header: {
      parentHash: fieldHex(raw.header.parentHash, "header.parentHash"),
      number: uintBelow(raw.header.number, U64_LIMIT, "header.number"),
      timestamp: uintBelow(raw.header.timestamp, U64_LIMIT, "header.timestamp"),
      transactionResultsRoot: fieldHex(raw.header.transactionResultsRoot, "header.transactionResultsRoot"),
      stateRoot: fieldHex(raw.header.stateRoot, "header.stateRoot"),
      l1OriginRoot: fieldHex(raw.header.l1OriginRoot, "header.l1OriginRoot"),
      historyRoot: fieldHex(raw.header.historyRoot, "header.historyRoot"),
    },
    blockHash: fieldHex(raw.blockHash, "blockHash"),
  };
  if (computeStateRoot(envelope.state) !== envelope.header.stateRoot) {
    throw new Error("boundary state root mismatch");
  }
  if (computeBlockHash(envelope.header) !== envelope.blockHash) {
    throw new Error("boundary block hash mismatch");
  }
  return envelope;
}

export function boundaryId(envelope: CurrentBoundaryEnvelope): string {
  return fieldToHex(envelope.blockHash);
}

export function requireSameBoundary(
  expected: CurrentBoundaryEnvelope,
  actual: CurrentBoundaryEnvelope,
): void {
  if (expected.header.number !== actual.header.number || expected.blockHash !== actual.blockHash) {
    throw new Error("mixed current-boundary envelopes");
  }
}
