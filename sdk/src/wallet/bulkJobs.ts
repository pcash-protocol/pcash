import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueProfile, type PrivateValueShape } from "@pcash/sdk/constants";
import { fieldToHex, toField } from "@pcash/sdk/crypto";
import { beBytes, bytes32Hex, concatBytes, fromHex, keccak256, randomFieldEntropy, toHex, U128_LIMIT, utf8 } from "@pcash/sdk/utils";
import { defineRecordSchema, packed } from "../protocol/packed.ts";
import { readRecord, type DataRecord } from "../protocol/records.ts";
import { selectNotes } from "./coinSelect.ts";
import { spendableNotes, type PendingAssetAction, type StoredSentOutput, type WalletFileData, type WalletNote } from "./noteStore.ts";

export const BULK_RECOVERY_OBSERVATION_SECONDS = 1_800n;
/** The longest app tag. The fullest S or L chunk still fits its arena with a tag this long. */
export const BULK_RECOVERY_MAX_APP_TAG_BYTES = 255;
const BULK_RECOVERY_MAX_RECIPIENTS = 10_000;

export interface BulkRecipient {
  /** Receive code or authenticated address; ordering and duplicates are preserved. */
  to: string;
  amount: string;
  /** Open the note under this secret with no delivery envelope; the approver keeps the opening. */
  noteSecret?: string;
  /** Captured at job approval. A chunk seals to an extended code's key as captured and reads a bare address's key from its own snapshot, keeping the captured key when the recipient has since cleared its own. No key is captured for a `noteSecret` recipient. */
  delivery?: { address: string; receiveKey?: string };
}

export interface BulkChunk {
  shape: PrivateValueShape;
  firstRecipient: number;
  recipientCount: number;
  /** Retained after settlement, including all exact bytes, nullifiers and local openings. */
  action: PendingAssetAction;
  outcome: "unresolved" | "succeeded" | "expired" | "conflicted";
  /** The PCASH block whose transaction included this chunk. */
  inclusion?: { blockNumber: string; blockHash: string };
}

/** Stable application identity and original-list positions carried by every recoverable chunk. */
export interface BulkJobRecovery {
  recoveryJobId: string;
  appTag: string;
  manifestDigest: string;
  originalRecipientCount: number;
  /** One original full-list position for each recipient in this local job. */
  originalIndexes: number[];
  /** Canonical chunks treated as paid when a recovered job was resumed. */
  baselineContentHashes?: string[];
  /** A reorg removed at least one baseline chunk; this local continuation may not run. */
  invalidated?: true;
  /** A later local job replaced this job's terminal or unallocated positions. */
  supersededByJobId?: string;
}

export interface BulkRecoveryObservation {
  recoveryJobId: string;
  fingerprint: string;
  observedAtTimestamp: string;
  observedThroughTimestamp: string;
}

/** Local restart state, never an onchain registry or a source of anticipated funding. */
export interface BulkJob {
  jobId: string;
  kind: "payment" | "consolidation";
  assetId: string;
  recipients: BulkRecipient[];
  /** Approved public open fee for each chunk, by the shape that chunk uses. */
  openFeeAmounts: Record<PrivateValueShape, string>;
  /** Explicit authorization ceiling, including consolidation rounds. */
  maxTransactions: number;
  targetNotes: number;
  shape?: PrivateValueShape;
  recovery?: BulkJobRecovery;
  chunks: BulkChunk[];
}

export function createBulkJob(params: {
  kind: BulkJob["kind"];
  assetId?: bigint;
  recipients?: readonly { to: string; amount: bigint; noteSecret?: bigint }[];
  /** One amount applies to every shape. */
  openFeeAmount: bigint | Readonly<Record<PrivateValueShape, bigint>>;
  maxTransactions: number;
  targetNotes?: number;
  shape?: PrivateValueShape;
  recovery?: BulkJobRecovery;
}): BulkJob {
  const assetId = toField(params.assetId ?? 0n, "bulk assetId");
  const fees = typeof params.openFeeAmount === "bigint"
    ? { [PRIVATE_VALUE_PROFILES.S.shapeId]: params.openFeeAmount, [PRIVATE_VALUE_PROFILES.L.shapeId]: params.openFeeAmount }
    : params.openFeeAmount;
  if (Object.values(fees).some(fee => fee < 0n || fee >= U128_LIMIT)) throw new Error("bulk fee must fit uint128");
  if (!Number.isSafeInteger(params.maxTransactions) || params.maxTransactions < 1) throw new Error("maxTransactions must be positive");
  const targetNotes = params.targetNotes ?? PRIVATE_VALUE_PROFILES.S.inputs;
  if (!Number.isSafeInteger(targetNotes) || targetNotes < 1) throw new Error("targetNotes must be positive");
  if (params.shape !== undefined) privateValueProfile(params.shape);
  const recipients = (params.recipients ?? []).map(recipient => {
    if (!recipient.to || recipient.amount <= 0n || recipient.amount >= U128_LIMIT) throw new Error("bulk recipients require a delivery target and uint128 positive amount");
    return { to: recipient.to, amount: recipient.amount.toString(),
      ...(recipient.noteSecret === undefined ? {} : { noteSecret: fieldToHex(recipient.noteSecret) }) };
  });
  if ((params.kind === "payment") !== (recipients.length > 0)) throw new Error("only payment jobs require recipients");
  if (params.recovery !== undefined) {
    if (params.kind !== "payment") throw new Error("only payment jobs are recoverable");
    if (params.recovery.originalIndexes.length !== recipients.length
      || new Set(params.recovery.originalIndexes).size !== recipients.length
      || params.recovery.originalIndexes.some(index => !Number.isSafeInteger(index) || index < 0 || index >= params.recovery!.originalRecipientCount)) {
      throw new Error("bulk recovery original indexes must name each local recipient once");
    }
    canonicalRecoveryId(params.recovery.recoveryJobId);
    canonicalDigest(params.recovery.manifestDigest);
    recoveryTagBytes(fromHex(params.recovery.appTag));
  }
  return { jobId: randomFieldEntropy().toString(16), kind: params.kind, assetId: assetId.toString(), recipients,
    openFeeAmounts: {
      [PRIVATE_VALUE_PROFILES.S.shapeId]: fees[PRIVATE_VALUE_PROFILES.S.shapeId].toString(),
      [PRIVATE_VALUE_PROFILES.L.shapeId]: fees[PRIVATE_VALUE_PROFILES.L.shapeId].toString(),
    },
    maxTransactions: params.maxTransactions, targetNotes,
    ...(params.shape === undefined ? {} : { shape: params.shape }),
    ...(params.recovery === undefined ? {} : { recovery: structuredClone(params.recovery) }), chunks: [] };
}

function canonicalRecoveryId(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || BigInt(value) === 0n) throw new Error("bulk recovery job id must be a nonzero 32-byte hex word");
  return value.toLowerCase();
}

function canonicalDigest(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("bulk recovery manifest digest must be a 32-byte hex word");
  return value.toLowerCase();
}

function recoveryTagBytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length < 1 || value.length > BULK_RECOVERY_MAX_APP_TAG_BYTES) {
    throw new Error(`bulk recovery app tag must contain 1..${BULK_RECOVERY_MAX_APP_TAG_BYTES} bytes`);
  }
  return Uint8Array.from(value);
}

/** Digest one complete approved list after every destination has resolved to an address. */
export function bulkRecoveryManifestDigest(params: {
  chainId: bigint;
  assetId: bigint;
  recipients: readonly BulkRecipient[];
}): string {
  if (params.recipients.length < 1 || params.recipients.length > BULK_RECOVERY_MAX_RECIPIENTS) {
    throw new Error(`bulk recovery needs 1..${BULK_RECOVERY_MAX_RECIPIENTS} recipients`);
  }
  const entries = params.recipients.map((recipient) => {
    if (recipient.delivery === undefined) throw new Error("bulk recovery digest requires resolved recipients");
    const noteSecret = recipient.noteSecret === undefined ? new Uint8Array(32) : fromHex(recipient.noteSecret);
    return concatBytes(
      beBytes(BigInt(recipient.delivery.address), 20),
      beBytes(BigInt(recipient.amount), 16),
      Uint8Array.of(recipient.noteSecret === undefined ? 0 : 1),
      noteSecret,
    );
  });
  return toHex(keccak256(concatBytes(
    utf8("pcash.bulk-recovery.manifest.v1"),
    beBytes(params.chainId, 4),
    beBytes(params.assetId, 32),
    beBytes(params.recipients.length, 2),
    ...entries,
  )));
}

export function freshBulkJobRecovery(params: {
  appTag: Uint8Array;
  manifestDigest: string;
  originalRecipientCount: number;
  originalIndexes?: readonly number[];
  recoveryJobId?: string;
  baselineContentHashes?: readonly string[];
}): BulkJobRecovery {
  if (!Number.isSafeInteger(params.originalRecipientCount) || params.originalRecipientCount < 1
    || params.originalRecipientCount > BULK_RECOVERY_MAX_RECIPIENTS) throw new Error("bulk recovery recipient count is out of range");
  const originalIndexes = params.originalIndexes === undefined
    ? Array.from({ length: params.originalRecipientCount }, (_, index) => index)
    : [...params.originalIndexes];
  if (originalIndexes.length < 1 || new Set(originalIndexes).size !== originalIndexes.length
    || originalIndexes.some(index => !Number.isSafeInteger(index) || index < 0 || index >= params.originalRecipientCount)) {
    throw new Error("bulk recovery original indexes are invalid");
  }
  return {
    recoveryJobId: canonicalRecoveryId(params.recoveryJobId ?? bytes32Hex(randomFieldEntropy())),
    appTag: toHex(recoveryTagBytes(params.appTag)),
    manifestDigest: canonicalDigest(params.manifestDigest),
    originalRecipientCount: params.originalRecipientCount,
    originalIndexes,
    ...(params.baselineContentHashes === undefined ? {} : {
      baselineContentHashes: params.baselineContentHashes.map(canonicalDigest),
    }),
  };
}

/**
 * One chunk's sender-region record. `originalIndexes` holds one original-list
 * position per recipient, in output-slot order.
 */
export const bulkRecoverySchema = defineRecordSchema("org.pcash.bulk-recovery", packed.struct({
  recoveryJobId: packed.bytes(32),
  manifestDigest: packed.bytes(32),
  originalRecipientCount: packed.uint,
  appTag: packed.bytes(),
  originalIndexes: packed.list(packed.uint),
}));

/** The record of the chunk paying `count` local recipients from `localFirst`. */
export function bulkRecoveryRecord(recovery: BulkJobRecovery, localFirst: number, count: number): DataRecord {
  return bulkRecoverySchema.encode({
    recoveryJobId: fromHex(recovery.recoveryJobId),
    manifestDigest: fromHex(recovery.manifestDigest),
    originalRecipientCount: recovery.originalRecipientCount,
    appTag: fromHex(recovery.appTag),
    originalIndexes: recovery.originalIndexes.slice(localFirst, localFirst + count),
  });
}

type BulkRecoveryRecord = ReturnType<typeof bulkRecoverySchema.decode>;

export interface RecoveredBulkRecipient {
  originalIndex: number;
  recipientAddress: string;
  amount: string;
  noteSecret: string;
}

export interface RecoveredBulkChunk {
  contentHash: string;
  shape: PrivateValueShape;
  recipients: RecoveredBulkRecipient[];
  inclusion: { blockNumber: string; blockHash: string; blockTimestamp: string };
}

export interface RecoveredBulkGroup {
  recoveryJobId: string;
  appTag: Uint8Array;
  manifestDigest: string;
  assetId: string;
  originalRecipientCount: number;
  chunks: RecoveredBulkChunk[];
  paidOriginalIndexes: number[];
  fingerprint: string;
}

/** Canonical recovery groups rebuilt only from individually verified sent outputs. */
export function recoveredBulkGroups(sentOutputs: readonly StoredSentOutput[]): RecoveredBulkGroup[] {
  const byTransaction = new Map<string, StoredSentOutput[]>();
  for (const output of sentOutputs) {
    const key = output.transactionId.toLowerCase();
    const group = byTransaction.get(key) ?? [];
    group.push(output);
    byTransaction.set(key, group);
  }
  const chunks: Array<{ record: BulkRecoveryRecord; assetId: string; chunk: RecoveredBulkChunk }> = [];
  for (const outputs of byTransaction.values()) {
    outputs.sort((left, right) => left.slot - right.slot);
    // Every output of a transaction carries that transaction's sender records.
    const first = outputs[0]!;
    const record = readRecord(first.senderRecords?.map(({ schema, data }) => ({ schema, data: fromHex(data) })), bulkRecoverySchema);
    if (record === undefined || first.privateValueShape === null) continue;
    // A chunk pays its recipients from slot 0 in list order; its change and relay fee are not sent outputs.
    if (outputs.length !== record.originalIndexes.length || outputs.some((output, index) => output.slot !== index)) continue;
    chunks.push({ record, assetId: first.assetId.toLowerCase(), chunk: {
      contentHash: first.contentHash.toLowerCase(), shape: first.privateValueShape,
      recipients: outputs.map((output, index) => ({
        originalIndex: record.originalIndexes[index]!, recipientAddress: output.recipientAddress.toLowerCase(),
        amount: output.amount, noteSecret: output.noteSecret.toLowerCase(),
      })),
      inclusion: { blockNumber: first.blockNumber, blockHash: first.blockHash.toLowerCase(), blockTimestamp: first.blockTimestamp },
    } });
  }
  const grouped = new Map<string, typeof chunks>();
  for (const chunk of chunks) {
    const recoveryJobId = toHex(chunk.record.recoveryJobId);
    const list = grouped.get(recoveryJobId) ?? [];
    list.push(chunk);
    grouped.set(recoveryJobId, list);
  }
  const recovered: RecoveredBulkGroup[] = [];
  for (const [recoveryJobId, list] of grouped) {
    const first = list[0]!;
    const compatible = list.every(({ record, assetId }) => toHex(record.manifestDigest) === toHex(first.record.manifestDigest)
      && record.originalRecipientCount === first.record.originalRecipientCount && toHex(record.appTag) === toHex(first.record.appTag)
      && assetId === first.assetId);
    if (!compatible) continue;
    const ordered = list.map(item => item.chunk).sort((left, right) => {
      const block = BigInt(left.inclusion.blockNumber) - BigInt(right.inclusion.blockNumber);
      if (block !== 0n) return block < 0n ? -1 : 1;
      return left.contentHash.localeCompare(right.contentHash);
    });
    const paidOriginalIndexes = [...new Set(ordered.flatMap(chunk => chunk.recipients.map(recipient => recipient.originalIndex)))].sort((a, b) => a - b);
    const fingerprint = toHex(keccak256(concatBytes(...ordered.flatMap(chunk => [
      fromHex(chunk.contentHash),
      ...chunk.recipients.map(recipient => beBytes(recipient.originalIndex, 2)),
    ]))));
    recovered.push({ recoveryJobId, appTag: Uint8Array.from(first.record.appTag), manifestDigest: toHex(first.record.manifestDigest),
      assetId: first.assetId, originalRecipientCount: first.record.originalRecipientCount,
      chunks: ordered, paidOriginalIndexes, fingerprint });
  }
  return recovered.sort((left, right) => left.recoveryJobId.localeCompare(right.recoveryJobId));
}

export function reconcileBulkRecoveryObservations(
  data: WalletFileData,
  observedAtUpperBound: bigint,
  observedThroughTimestamp: bigint,
): void {
  const groups = recoveredBulkGroups(data.sentOutputs ?? []);
  const groupsById = new Map(groups.map(group => [group.recoveryJobId, group]));
  const current = new Map((data.bulkRecoveryObservations ?? []).map(observation => [observation.recoveryJobId, observation]));
  const observation = (recoveryJobId: string, fingerprint: string): BulkRecoveryObservation => {
    const previous = current.get(recoveryJobId);
    const reset = previous === undefined || previous.fingerprint !== fingerprint
      || BigInt(previous.observedAtTimestamp) > observedAtUpperBound
      || BigInt(previous.observedThroughTimestamp) > observedThroughTimestamp;
    return {
      recoveryJobId, fingerprint,
      observedAtTimestamp: reset ? observedAtUpperBound.toString() : previous.observedAtTimestamp,
      observedThroughTimestamp: observedThroughTimestamp.toString(),
    };
  };
  const next = new Map(groups.map(group => [group.recoveryJobId, observation(group.recoveryJobId, group.fingerprint)]));
  const contentHashes = new Map(groups.map(group => [group.recoveryJobId,
    new Set(group.chunks.map(chunk => chunk.contentHash.toLowerCase()))]));
  for (const job of data.bulkJobs ?? []) {
    const baseline = job.recovery?.baselineContentHashes;
    if (baseline === undefined) continue;
    const canonical = contentHashes.get(job.recovery!.recoveryJobId);
    if (baseline.length === 0 || (canonical !== undefined && baseline.every(contentHash => canonical.has(contentHash.toLowerCase())))) {
      delete job.recovery!.invalidated;
    } else {
      job.recovery!.invalidated = true;
      if (!groupsById.has(job.recovery!.recoveryJobId) && !next.has(job.recovery!.recoveryJobId)) {
        const fingerprint = toHex(keccak256(concatBytes(
          utf8("pcash.bulk-recovery.empty.v1"), fromHex(job.recovery!.recoveryJobId),
        )));
        next.set(job.recovery!.recoveryJobId, observation(job.recovery!.recoveryJobId, fingerprint));
      }
    }
  }
  if (next.size === 0) delete data.bulkRecoveryObservations;
  else data.bulkRecoveryObservations = [...next.values()];
}

export interface BulkChunkPlan {
  shape: PrivateValueShape;
  firstRecipient: number;
  recipientCount: number;
  inputs: WalletNote[];
  change: { assetId: bigint; amount: bigint }[];
}

function splitAmount(assetId: bigint, amount: bigint): BulkChunkPlan["change"] {
  const maximum = U128_LIMIT - 1n;
  const outputs: BulkChunkPlan["change"] = [];
  for (let remainder = amount; remainder > 0n; remainder -= maximum) {
    outputs.push({ assetId, amount: remainder > maximum ? maximum : remainder });
  }
  return outputs;
}

/**
 * Allocate only currently spendable notes. Pending change and system payouts never
 * fund a chunk. `issuanceNote` reserves inventory for the issuance note a
 * self-published chunk pays this wallet; a relayed chunk pays its publisher.
 */
export function planNextBulkChunk(data: WalletFileData, job: BulkJob, options: {
  issuanceNote?: boolean;
  /** The native fee every shape funds instead of the job's open fee, as a selected relay's private fee. */
  fundingFeeAmount?: bigint;
  /** Output slots held back, for the selected relay fee. */
  reservedOutputs?: number;
  /** Shapes the executing prover can prove; defaults to both. */
  shapes?: readonly PrivateValueShape[];
} = {}): BulkChunkPlan | null {
  if (job.chunks.length >= job.maxTransactions) return null;
  const profiles = (job.shape === undefined ? [PRIVATE_VALUE_PROFILES.S, PRIVATE_VALUE_PROFILES.L] : [privateValueProfile(job.shape)])
    .filter(profile => options.shapes === undefined || options.shapes.includes(profile.shapeId));
  const assetId = BigInt(job.assetId);
  const feeFor = (profile: PrivateValueProfile) => options.fundingFeeAmount ?? BigInt(job.openFeeAmounts[profile.shapeId]);
  const reservedOutputs = options.reservedOutputs ?? 0;
  if (!Number.isInteger(reservedOutputs) || reservedOutputs < 0 || reservedOutputs > 1) throw new Error("reservedOutputs must be 0..1");
  const available = spendableNotes(data, assetId);
  const native = assetId === 0n ? available : spendableNotes(data, 0n);
  const firstRecipient = job.chunks.reduce((sum, chunk) => sum + chunk.recipientCount, 0);
  const pick = (notes: WalletNote[], need: bigint, capacity: number): WalletNote[] | null => {
    if (need === 0n) return [];
    if (capacity < 1) return null;
    return selectNotes(notes.map(note => ({ amount: BigInt(note.amount), note })), need, capacity)?.selected.map(item => item.note) ?? null;
  };
  const sum = (notes: WalletNote[]) => notes.reduce((total, note) => total + BigInt(note.amount), 0n);
  // Largest native notes establish the minimum fee-input budget. Reserving it
  // prevents asset dust consolidation from crowding out an otherwise funded fee.
  const nativeDescending = native.map(note => BigInt(note.amount)).sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
  const feeInputReserve = (fee: bigint): number | null => {
    if (assetId === 0n || fee === 0n) return 0;
    let feeTotal = 0n;
    let count = 0;
    for (const amount of nativeDescending) {
      feeTotal += amount;
      count++;
      if (feeTotal >= fee) return count;
    }
    return null;
  };
  if (job.kind === "consolidation") {
    if (available.length <= job.targetNotes) return null;
    // Small notes minimize output splitting and maximize target-asset progress.
    const ascending = [...available].sort((a, b) => BigInt(a.amount) < BigInt(b.amount) ? -1 : BigInt(a.amount) > BigInt(b.amount) ? 1 : 0);
    // The issuance note's forecast funding value remains zero; it is a native note.
    const potentialPayouts = Number(options.issuanceNote === true);
    let best: BulkChunkPlan | null = null;
    let bestReduction = 0;
    for (const profile of profiles) {
      const fee = feeFor(profile);
      const reserve = feeInputReserve(fee);
      if (reserve === null || reserve >= profile.inputs) continue;
      // Fee dust must not take slots away from the asset this job consolidates.
      const funding = assetId === 0n ? [] : pick(native, fee, reserve);
      if (funding === null) continue;
      const selected = ascending.slice(0, profile.inputs - funding.length);
      let value = sum(selected) - (assetId === 0n ? fee : 0n);
      // A dust-only native selection may not cover the fee. Replace its smallest
      // notes with the largest unselected notes until a positive output remains.
      for (let i = 0; value <= 0n && i < selected.length && i < ascending.length - selected.length; i++) {
        const replacement = ascending[ascending.length - 1 - i]!;
        value += BigInt(replacement.amount) - BigInt(selected[i]!.amount);
        selected[i] = replacement;
      }
      if (value <= 0n) continue;
      const assetChange = splitAmount(assetId, value);
      const change = [...assetChange, ...splitAmount(0n, sum(funding) - (assetId === 0n ? 0n : fee))];
      // Require target-asset progress, maximizing it across profiles (S wins ties).
      const reduction = selected.length - assetChange.length - (assetId === 0n ? potentialPayouts : 0);
      if (reduction <= bestReduction || change.length > profile.outputs - reservedOutputs
        || change.length + potentialPayouts >= selected.length + funding.length) continue;
      best = { shape: profile.shapeId, firstRecipient, recipientCount: 0, inputs: [...selected, ...funding], change };
      bestReduction = reduction;
    }
    return best;
  }
  const remaining = job.recipients.slice(firstRecipient);
  const maximumOutputs = Math.max(...profiles.map(profile => profile.outputs - reservedOutputs));
  for (let count = Math.min(remaining.length, maximumOutputs); count > 0; count--) {
    const amount = remaining.slice(0, count).reduce((total, recipient) => total + BigInt(recipient.amount), 0n);
    for (const profile of profiles) {
      if (count > profile.outputs - reservedOutputs) continue;
      const fee = feeFor(profile);
      const reserve = feeInputReserve(fee);
      if (reserve === null) continue;
      const selected = pick(available, amount + (assetId === 0n ? fee : 0n), profile.inputs - reserve);
      if (selected === null) continue;
      const funding = assetId === 0n ? [] : pick(native, fee, profile.inputs - selected.length);
      if (funding === null) continue;
      const change = [...splitAmount(assetId, sum(selected) - amount - (assetId === 0n ? fee : 0n)),
        ...splitAmount(0n, sum(funding) - (assetId === 0n ? 0n : fee))];
      if (count + change.length <= profile.outputs - reservedOutputs) {
        return { shape: profile.shapeId, firstRecipient, recipientCount: count, inputs: [...selected, ...funding], change };
      }
    }
  }
  return null;
}
