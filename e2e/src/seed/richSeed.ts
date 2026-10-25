import { transactionIdentity as submissionIdentity } from "@pcash/sdk/protocol";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "../framework/logger.ts";
import {
  createPscanClient,
  PcashNodeClient,
  type BatchExclusionReason,
  type ContractSourceView,
  type CarrierType,
  type L1DeliveryBatchResult,
  type PscanClient,
  type ReceiptResult,
  type SourceVerificationInfo,
  type StatusResult,
} from "@pcash/sdk/clients";
import { createSelectedRelayQuote, privateKeyPcashActionSigner, type SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
import { buildSponsoredContractCreation } from "../scenarios/contractPublication.ts";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { MAX_PCASH_BATCH_BYTES } from "@pcash/sdk/l1";
import type { PrivateKeyRelaySubmitter } from "@pcash/sdk/node";
import {
  decodeTransaction,
  ownerCommitment,
  posterPayoutOpening,
  generateMlKemKeyPair,
  transactionIdentity,
  networkConfigFromStatus,
  privateValuePublicInputs,
  selectBatchVersion,
  VERSION,
} from "@pcash/sdk/protocol";
import { addressHex, fromHex, randomFieldEntropy } from "@pcash/sdk/utils";
import { stringify } from "viem";
import {
  derivePcashProfileFromPrivateKey,
  walletExtendedCode,
  type DurableSubmissionAdapter,
  type PcashProfile,
  type Wallet,
} from "@pcash/sdk/wallet";
import {
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletProvers } from "@pcash/sdk/wallet/node";
import { openNodeWallet } from "@pcash/wallet";
import { scanWallet } from "@pcash/sdk/wallet/scanning";
import {
  runMarketplaceScenarioFlow,
  type MarketplaceEscrowSeedEvidence,
  type MarketplaceSubmission,
} from "../scenarios/marketplace.ts";
import { runAssetScenarioFlow, type AssetScenarioResult } from "../scenarios/assets.ts";
import { assertSystemPayoutRecovered } from "../scenarios/payouts.ts";
import type { ScenarioWalletActor } from "../scenarios/types.ts";
import { eventually } from "../framework/eventually.ts";
import { sourceVerificationPublicationWithConfigurationOpenings } from "../../../scripts/source-verification/index.mts";
import { MIN_CLAIM_WINDOW_SECONDS, marketplaceSourceConfigurationOpenings, type Offer } from "@pcash/marketplace";
import { PURCHASE_MARGIN_SECONDS, type PaymentRouterConfig } from "@pcash/marketplace/client";
import {
  EXCLUDED_CARRIER_CONTROLS,
  isItemExclusion,
  nonzeroSeedQuotient,
  plannedOutcomes,
  seedFee,
  seedWave,
  type ExpectedOutcome,
  type SeedCarrier,
} from "./richSeedPlan.ts";
import * as controls from "./seedControls.ts";

export const SEED_ACTOR_ORDER = ["S", "R", "M", "X", "O", "F"] as const;
/** The seeded unpaid offer stays open for new purchases for a full day. */
export const SEED_UNPAID_OFFER_DEADLINE_LEAD_SECONDS = 24n * 60n * 60n + MIN_CLAIM_WINDOW_SECONDS + PURCHASE_MARGIN_SECONDS;
export type ActorName = typeof SEED_ACTOR_ORDER[number];

export interface SeedEntry {
  label: string;
  entry: Uint8Array;
  contentHash: string;
  expectedOutcome: ExpectedOutcome;
  resolve?: (submission: MarketplaceSubmission) => void;
  reject?: (error: unknown) => void;
}

interface WaveEntryResult {
  label: string;
  contentHash: string;
  transactionId: string | null;
  expectedOutcome: ExpectedOutcome;
  outcome: string;
  kind: string | null;
  batchItemIndex: bigint;
  outputLeafStart: bigint | null;
  nullifiers: string[] | null;
  settledOpenFeeAmount: bigint | null;
  settledIssuanceAmount: bigint | null;
  issuanceOwnerCommitment: string | null;
}

interface WaveCarrierResult {
  carrierIndex: number;
  carrierType: CarrierType;
  l1TransactionHash: Hex;
  l1BlockNumber: bigint;
  l1BlockHash: Hex;
  l1TransactionIndex: bigint;
  entries: WaveEntryResult[];
}

interface ExcludedCarrierResult {
  label: string;
  l1TransactionHash: Hex;
  exclusionReason: BatchExclusionReason;
}

interface WaveResult {
  index: number;
  carriers: WaveCarrierResult[];
  entries: WaveEntryResult[];
}

export interface SeedNodeIdentity {
  pcashChainId: number;
  genesisHash: string;
  l1ChainId: bigint;
  inboxAddress: string;
  genesisL1Block: bigint;
  genesisL1BlockHash: string;
}

type SeedWaveNode = Pick<PcashNodeClient, "status" | "getReceipt" | "getMempoolTransaction" | "getInboxDeliveryBatch">;

interface SeedActor {
  name: ActorName;
  privateKey: Hex;
  profile: PcashProfile;
  address: `0x${string}`;
  submitter: PlannedWalletSubmission;
  wallet: Wallet<undefined, undefined>;
}

export interface RichSeedResult {
  version: 1;
  network: SeedNodeIdentity;
  waves: WaveResult[];
  canonicalEntries: Array<{
    label: string;
    contentHash: string;
    transactionId: string | null;
    expectedOutcome: ExpectedOutcome;
    observedOutcome: string;
    kind: string | null;
    settledOpenFeeAmount: bigint | null;
    l1TransactionHash: string;
    l1BlockHash: string;
    l1TransactionIndex: bigint;
    batchItemIndex: bigint;
  }>;
  assets: AssetScenarioResult;
  marketplace: MarketplaceEscrowSeedEvidence;
  pendingContentHashes: string[];
  contractAddresses: string[];
  actors: Record<ActorName, string>;
  routerAddress: Address;
  routerConfig: PaymentRouterConfig;
  pendingConflicts: Array<{ contentHash: string; conflicts: bigint; conflictKeys: string[] }>;
  finalPrivateBalances: Record<ActorName, string>;
  contracts: { marketplace: string[]; verified: string[]; unverified: string[] };
  pending: {
    contentHashes: string[];
    conflicts: Array<{ contentHash: string; conflictKeys: string[] }>;
  };
  richness: {
    repeatedEarningIssuance: bigint;
    sellerChangeInputCount: number;
    recipientMultiInputCount: number;
  };
  /** Identities and carriers the Explorer fixture recorder cannot discover from the node alone. */
  explorer: {
    relayerAddress: string;
    keylessAccountAddress: string;
    privateVaultAddress: string;
    excludedCarriers: ExcludedCarrierResult[];
    volumeTransferCount: number;
  };
}

export interface RichSeedParams {
  repoRoot: string;
  root: string;
  rpcUrl: string;
  pscanUrl: string;
  l1Rpc: string;
  sourceManifest: string;
  routerAddress: Address;
  routerConfig: PaymentRouterConfig;
  relayerPrivateKey: Hex;
  /** The relayer key's journaled submitter, which posts every carrier. */
  submitter: PrivateKeyRelaySubmitter;
  actorKeys: Record<ActorName, Hex>;
  expectedNode: SeedNodeIdentity;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  ethPriceWei?: bigint;
  pcashAmount?: bigint;
  assetInitialSupply?: bigint;
  assetActionFee?: bigint;
  /** Plain transfers among the four funded actors after the planned waves, for list volume. */
  volumeTransfers: number;
}

export function assertRichSeedEvidence(evidence: RichSeedResult): void {
  const outcomes = new Set(evidence.canonicalEntries.map((entry) => entry.observedOutcome));
  for (const expected of plannedOutcomes()) {
    if (!outcomes.has(expected)) throw new Error(`rich seed evidence is missing outcome ${expected}`);
  }
  if (evidence.canonicalEntries.some((entry) => entry.expectedOutcome !== entry.observedOutcome)) {
    throw new Error("rich seed evidence contains an unexpected canonical outcome");
  }
  const carriers = evidence.waves.flatMap((wave) => wave.carriers);
  const multiEntryCarriers = carriers.filter((carrier) => carrier.entries.length > 1);
  if (multiEntryCarriers.length === 0 || multiEntryCarriers.some((carrier) =>
    carrier.entries.some((entry, index) => entry.batchItemIndex !== BigInt(index)))) {
    throw new Error("rich seed evidence has no exact ordered multi-entry carrier");
  }
  if (!carriers.some((carrier) => carrier.carrierType === "blob") || !carriers.some((carrier) => carrier.carrierType === "calldata")) {
    throw new Error("rich seed evidence must deliver through both a blob carrier and a calldata carrier");
  }
  const oversizedItemCarrier = carriers.find((carrier) =>
    carrier.entries.some((entry) => entry.expectedOutcome === "itemTooLarge"));
  if (oversizedItemCarrier?.carrierType !== "blob") {
    throw new Error("rich seed itemTooLarge control must use a blob carrier");
  }
  const excluded = evidence.explorer.excludedCarriers.map((carrier) => carrier.exclusionReason);
  if (EXCLUDED_CARRIER_CONTROLS.some((control) => !excluded.includes(control.reason))) {
    throw new Error("rich seed evidence is missing an excluded L1 carrier");
  }
  const succeededFees = evidence.canonicalEntries
    .filter((entry) => entry.observedOutcome === "succeeded" && entry.kind === "privateValue")
    .map((entry) => entry.settledOpenFeeAmount ?? 0n);
  if (!succeededFees.some((fee) => fee > 0n) || !succeededFees.some((fee) => fee === 0n)) {
    throw new Error("rich seed evidence must settle public open fees on some private-value transactions and none on others");
  }
  if (evidence.contracts.marketplace.length !== 2 || evidence.contracts.verified.length !== 2 || evidence.contracts.unverified.length !== 1) {
    throw new Error("rich seed evidence must identify two verified Marketplace contracts and one unverified private vault");
  }
  if (
    evidence.marketplace.paidOffer.claimContentHash === ""
    || evidence.marketplace.paidOffer.paymentTxHash.length <= 2
    || evidence.marketplace.unpaidOffer.fundingContentHash === ""
  ) throw new Error("rich seed evidence is missing paid or unpaid Marketplace lifecycle state");
  if (
    evidence.pending.conflicts.length !== 2
    || evidence.pending.conflicts.some((entry) => entry.conflictKeys.length === 0)
    || evidence.pending.contentHashes.length < 3
  ) throw new Error("rich seed evidence is missing the pending lane or conflict pair");
  if (
    evidence.richness.repeatedEarningIssuance <= 0n
    || evidence.richness.sellerChangeInputCount !== 1
    || evidence.richness.recipientMultiInputCount !== 2
  ) throw new Error("rich seed evidence is missing repeated-earning, change, or multi-input coverage");
  if (!/nullifier/i.test(evidence.assets.controls.reshapedRecreationRejected)) {
    throw new Error("rich seed evidence is missing the private asset re-creation control");
  }
  if (SEED_ACTOR_ORDER.some((name) => evidence.actors[name] === undefined || evidence.finalPrivateBalances[name] === undefined)) {
    throw new Error("rich seed evidence is missing an actor or final balance");
  }
}

/** scanWallet decrypts and verifies each recovered note against its final output commitment. */
async function assertSelectedPrivateFeeRecovered(params: {
  node: PcashNodeClient;
  chainId: bigint;
  entry: WaveEntryResult;
  relayer: PcashProfile;
  expectedAmount: bigint;
}): Promise<void> {
  if (params.expectedAmount <= 0n) throw new Error(`${params.entry.label}: selected relay fee must be positive`);
  const receipt = (await params.node.getReceipt({ contentHash: params.entry.contentHash }))
    .find((candidate) => candidate.outcome === "succeeded");
  if (receipt?.outputLeafStart === null || receipt === undefined) {
    throw new Error(`${params.entry.label}: selected transfer has no successful output range`);
  }
  const first = receipt.outputLeafStart;
  const last = first + receipt.outputsAdded;
  const matching = await eventually(
    `${params.entry.label} private relay fee output`,
    async () => (await scanWallet(params.node, params.relayer, params.chainId, { fromOutputIndex: first })).recovered
      .filter((note) => note.leafIndex >= first && note.leafIndex < last
        && note.assetId === 0n && note.amount === params.expectedAmount),
    (notes) => notes.length === 1,
    { timeoutMs: 60_000 },
  );
  const feeNote = matching[0]!;
  const privateOwner = ownerCommitment(feeNote.owner, feeNote.noteSecret);
  if (receipt.issuanceOwnerCommitment !== null
    && privateOwner === BigInt(receipt.issuanceOwnerCommitment)) {
    throw new Error(`${params.entry.label}: private relay note reused public issuance owner commitment`);
  }
}

function assertSeedPscanIdentity(info: SourceVerificationInfo, expected: SeedNodeIdentity): void {
  if (info.status !== "ready"
    || !info.writable
    || info.sourceSubmissionStatus !== "ready"
    || info.invalidConfigurationOpeningCount !== 0n
    || info.pcashChainId !== expected.pcashChainId
    || info.genesisHash?.toLowerCase() !== expected.genesisHash.toLowerCase()) {
    throw new Error("running Pscan service does not expose a matching writable public source registry");
  }
}

function assertSeedNodeIdentity(status: Pick<StatusResult,
  "pcashChainId" | "genesisHash" | "l1ChainId" | "inboxAddress" | "genesisL1Block" | "genesisL1BlockHash">,
expected: SeedNodeIdentity): void {
  const comparisons = [
    ["pcashChainId", BigInt(status.pcashChainId), BigInt(expected.pcashChainId)],
    ["genesisHash", status.genesisHash.toLowerCase(), expected.genesisHash.toLowerCase()],
    ["l1ChainId", status.l1ChainId, expected.l1ChainId],
    ["inboxAddress", status.inboxAddress.toLowerCase(), expected.inboxAddress.toLowerCase()],
    ["genesisL1Block", status.genesisL1Block, expected.genesisL1Block],
    ["genesisL1BlockHash", status.genesisL1BlockHash.toLowerCase(), expected.genesisL1BlockHash.toLowerCase()],
  ] as const;
  for (const [label, actual, wanted] of comparisons) {
    if (actual !== wanted) throw new Error(`running node ${label} changed during the rich seed: ${actual}, expected ${wanted}`);
  }
}

const SEED_PROGRESS_INTERVAL_MS = 15_000;
export const SEED_MAX_BATCH_CALLDATA_BYTES = 128_000;

function seedLog(message: string): void {
  logger.context("seed").info(`[${new Date().toISOString()}] ${message}`);
}

function seedElapsed(startedAt: number): string {
  const elapsedMs = Date.now() - startedAt;
  return elapsedMs < 1_000 ? `${elapsedMs}ms` : `${(elapsedMs / 1_000).toFixed(1)}s`;
}

export function seedErrorKind(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : "UnknownError";
}

function redactSeedErrorMessage(message: string, env: NodeJS.ProcessEnv): string {
  let redacted = message;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < 4 || !/(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/i.test(name)) continue;
    redacted = redacted.replaceAll(value, "<redacted>");
  }
  redacted = redacted
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, "<redacted-url>")
    .replace(/\b(authorization|proxy-authorization)(\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s,;]+/gi, "$1$2<redacted>")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>")
    .replace(
      /\b(authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|private[_-]?key|secret)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1$2<redacted>",
    )
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length <= 1_000 ? redacted : `${redacted.slice(0, 997)}...`;
}

/** Preserve actionable failures without printing RPC credentials or signing secrets. */
export function seedErrorSummary(error: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const kind = seedErrorKind(error);
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const redacted = redactSeedErrorMessage(message, env);
  return redacted === "" ? kind : `${kind}: ${redacted}`;
}

export interface SeedBarrier {
  wait(): Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

export function createSeedBarrier(): SeedBarrier {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // A failure can precede the Marketplace consumer reaching the barrier.
  void promise.catch(() => undefined);
  return {
    wait: () => promise,
    resolve() {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

export async function settleSeedInitializations<T>(
  initializations: readonly Promise<T>[],
  openedResources: readonly { close(): Promise<void> }[],
): Promise<T[]> {
  const settled = await Promise.allSettled(initializations);
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure !== undefined) {
    await Promise.allSettled(openedResources.map((resource) => resource.close()));
    throw failure.reason;
  }
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
}

export function partitionSeedEntries(
  entries: readonly SeedEntry[],
  maximumCalldataBytes = SEED_MAX_BATCH_CALLDATA_BYTES,
): SeedEntry[][] {
  if (!Number.isSafeInteger(maximumCalldataBytes) || maximumCalldataBytes < 1) {
    throw new Error("rich seed carrier calldata limit must be a positive safe integer");
  }
  const carriers: SeedEntry[][] = [];
  let current: SeedEntry[] = [];
  for (const entry of entries) {
    const candidate = [...current, entry];
    if (controls.frameSeedBatch(candidate.map((item) => item.entry), VERSION, 1n, 0n).byteLength <= maximumCalldataBytes) {
      current = candidate;
      continue;
    }
    if (current.length === 0) {
      throw new Error(`${entry.label} cannot fit in one rich seed carrier transaction`);
    }
    carriers.push(current);
    current = [entry];
    if (controls.frameSeedBatch([entry.entry], VERSION, 1n, 0n).byteLength > maximumCalldataBytes) {
      throw new Error(`${entry.label} cannot fit in one rich seed carrier transaction`);
    }
  }
  if (current.length > 0) carriers.push(current);
  return carriers;
}

export interface PlannedSeedCarrier {
  carrier: SeedCarrier;
  entries: SeedEntry[];
}

/** Preserve wave order while splitting carrier overrides from the wave default. */
export function planSeedWaveCarriers(
  descriptor: Pick<ReturnType<typeof seedWave>, "carrier" | "entries">,
  entries: readonly SeedEntry[],
): PlannedSeedCarrier[] {
  const requested = new Map(descriptor.entries.map((planned) => [
    planned.label,
    planned.carrier ?? descriptor.carrier,
  ]));
  const groups: PlannedSeedCarrier[] = [];
  for (const item of entries) {
    const carrier = requested.get(item.label);
    if (carrier === undefined) throw new Error(`rich seed carrier plan has no entry ${item.label}`);
    const current = groups.at(-1);
    if (current?.carrier === carrier) current.entries.push(item);
    else groups.push({ carrier, entries: [item] });
  }
  return groups.flatMap((group) => partitionSeedEntries(
    group.entries,
    group.carrier === "blobs" ? MAX_PCASH_BATCH_BYTES : SEED_MAX_BATCH_CALLDATA_BYTES,
  ).map((partition) => ({ carrier: group.carrier, entries: partition })));
}

async function withSeedRuntimeProgress<T>(
  label: string,
  operation: () => Promise<T>,
  detail?: () => Promise<string>,
): Promise<T> {
  const startedAt = Date.now();
  let reporting = false;
  let finished = false;
  seedLog(`${label}: starting`);
  const heartbeat = setInterval(() => {
    if (reporting) return;
    reporting = true;
    void (async () => {
      let suffix = "";
      if (detail !== undefined) {
        try {
          suffix = `; ${await detail()}`;
        } catch (error) {
          suffix = `; progress probe failed (${seedErrorSummary(error)})`;
        }
      }
      if (!finished) seedLog(`${label}: still running (${seedElapsed(startedAt)})${suffix}`);
    })().finally(() => { reporting = false; });
  }, SEED_PROGRESS_INTERVAL_MS);
  heartbeat.unref();
  try {
    const result = await operation();
    seedLog(`${label}: complete (${seedElapsed(startedAt)})`);
    return result;
  } catch (error) {
    seedLog(`${label}: failed after ${seedElapsed(startedAt)} (${seedErrorSummary(error)})`);
    throw error;
  } finally {
    finished = true;
    clearInterval(heartbeat);
  }
}

export class WaveGate {
  readonly waves = new Map<number, SeedEntry[]>();
  readonly satisfied = new Map<number, Set<string>>();
  #waiters = new Set<() => void>();
  #failure: unknown;

  add(index: number, label: string, entry: Uint8Array, expectedOutcome: ExpectedOutcome = "succeeded"): SeedEntry {
    if (this.#failure !== undefined) throw this.#failure;
    const item = { label, entry: Uint8Array.from(entry), contentHash: transactionIdentity(entry).contentHash, expectedOutcome };
    const values = this.waves.get(index) ?? [];
    values.push(item);
    this.waves.set(index, values);
    this.#notify();
    return item;
  }

  satisfy(index: number, label: string): void {
    const labels = this.satisfied.get(index) ?? new Set<string>();
    labels.add(label);
    this.satisfied.set(index, labels);
    this.#notify();
  }

  marketplace(entry: Uint8Array, label: string): Promise<MarketplaceSubmission> {
    const waveByLabel: Record<string, number> = {
      "paid-offer:contract": 0,
      "unpaid-offer:contract": 0,
      "paid-offer:fund": 3,
      "unpaid-offer:fund": 4,
    };
    const index = waveByLabel[label];
    if (index === undefined) throw new Error(`unexpected Marketplace seed submission ${label}`);
    return new Promise((resolve, reject) => {
      const item = this.add(index, label, entry);
      item.resolve = resolve;
      item.reject = reject;
    });
  }

  async waitRequired(index: number, timeoutMs = 20 * 60_000, required = seedWave(index).requiredLabels): Promise<SeedEntry[]> {
    const ready = () => {
      const values = this.waves.get(index) ?? [];
      const satisfied = this.satisfied.get(index) ?? new Set<string>();
      return required.every((label) => satisfied.has(label) || values.some((entry) => entry.label === label)) ? values : undefined;
    };
    if (this.#failure !== undefined) throw this.#failure;
    const current = ready();
    if (current !== undefined) return current;
    const describe = () => {
      const prepared = new Set([
        ...(this.waves.get(index) ?? []).map((entry) => entry.label),
        ...(this.satisfied.get(index) ?? []),
      ]);
      const missing = required.filter((label) => !prepared.has(label));
      return `missing [${missing.join(", ")}]; prepared [${[...prepared].join(", ")}]`;
    };
    const startedAt = Date.now();
    seedLog(`Wave ${index} ${seedWave(index).id}: waiting for required entries; ${describe()}`);
    return await new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      let nextProgressAt = Date.now() + SEED_PROGRESS_INTERVAL_MS;
      const check = () => {
        if (this.#failure !== undefined) {
          clearInterval(timer);
          this.#waiters.delete(check);
          reject(this.#failure);
          return;
        }
        const values = ready();
        if (values !== undefined) {
          clearInterval(timer);
          this.#waiters.delete(check);
          seedLog(`Wave ${index} ${seedWave(index).id}: all required entries prepared (${seedElapsed(startedAt)})`);
          resolve(values);
        } else if (Date.now() >= deadline) {
          clearInterval(timer);
          this.#waiters.delete(check);
          reject(new Error(`timed out preparing rich seed wave ${index}; have ${(this.waves.get(index) ?? []).map((entry) => entry.label).join(", ")}`));
        } else if (Date.now() >= nextProgressAt) {
          seedLog(`Wave ${index} ${seedWave(index).id}: still waiting (${seedElapsed(startedAt)}); ${describe()}`);
          nextProgressAt = Date.now() + SEED_PROGRESS_INTERVAL_MS;
        }
      };
      const timer = setInterval(check, 250);
      timer.unref();
      this.#waiters.add(check);
      check();
    });
  }

  async waitForLabel(index: number, label: string, timeoutMs = 20 * 60_000): Promise<SeedEntry> {
    if (this.#failure !== undefined) throw this.#failure;
    const current = () => this.waves.get(index)?.find((entry) => entry.label === label);
    const found = current();
    if (found !== undefined) return found;
    const startedAt = Date.now();
    seedLog(`Wave ${index} ${seedWave(index).id}: waiting for entry ${label}`);
    return await new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      let nextProgressAt = Date.now() + SEED_PROGRESS_INTERVAL_MS;
      const check = () => {
        if (this.#failure !== undefined) {
          clearInterval(timer);
          this.#waiters.delete(check);
          reject(this.#failure);
          return;
        }
        const value = current();
        if (value !== undefined) {
          clearInterval(timer);
          this.#waiters.delete(check);
          seedLog(`Wave ${index} ${seedWave(index).id}: entry ${label} prepared (${seedElapsed(startedAt)})`);
          resolve(value);
        } else if (Date.now() >= deadline) {
          clearInterval(timer);
          this.#waiters.delete(check);
          reject(new Error(`timed out preparing rich seed entry ${label} in wave ${index}`));
        } else if (Date.now() >= nextProgressAt) {
          seedLog(`Wave ${index} ${seedWave(index).id}: still waiting for entry ${label} (${seedElapsed(startedAt)})`);
          nextProgressAt = Date.now() + SEED_PROGRESS_INTERVAL_MS;
        }
      };
      const timer = setInterval(check, 250);
      timer.unref();
      this.#waiters.add(check);
      check();
    });
  }

  fail(error: unknown): void {
    this.#failure = error;
    for (const values of this.waves.values()) for (const entry of values) entry.reject?.(error);
    this.#notify();
  }

  #notify(): void {
    for (const waiter of this.#waiters) waiter();
  }
}

export class PlannedWalletSubmission implements DurableSubmissionAdapter<undefined, undefined> {
  readonly mode = "mempool" as const;
  readonly #plans: Array<{ wave: number; label: string }> = [];
  readonly #pendingEntries = new Map<string, string>();
  readonly #capturedEntries = new Map<string, SeedEntry>();
  readonly gate: WaveGate;
  readonly node: PcashNodeClient;
  constructor(gate: WaveGate, node: PcashNodeClient) {
    this.gate = gate;
    this.node = node;
  }

  plan(wave: number, label: string): void {
    this.#plans.push({ wave, label });
  }

  planPending(label: string): void {
    this.#plans.push({ wave: PENDING_PLAN, label });
  }

  /** The next submission is held for the caller instead of a planned wave or the mempool. */
  planCaptured(label: string): void {
    this.#plans.push({ wave: CAPTURED_PLAN, label });
  }

  pendingEntry(contentHash: string): string {
    const entry = this.#pendingEntries.get(contentHash.toLowerCase());
    if (entry === undefined) throw new Error(`pending seed transaction ${contentHash} has no captured raw entry`);
    return entry;
  }

  capturedEntry(contentHash: string): SeedEntry {
    const entry = this.#capturedEntries.get(contentHash.toLowerCase());
    if (entry === undefined) throw new Error(`captured seed transaction ${contentHash} has no raw entry`);
    return entry;
  }

  async preflight(): Promise<undefined> { return undefined; }

  async submit({ transactionBytes: entry }: { transactionBytes: Uint8Array }): Promise<{ accepted: boolean; queued: boolean; output: undefined }> {
    const { contentHash: expectedContentHash } = submissionIdentity(entry);

    const plan = this.#plans.shift();
    if (plan === undefined) throw new Error("wallet produced an unplanned seed submission");
    if (plan.wave === PENDING_PLAN) {
      const transactionHex = toHex(entry);
      const admitted = await this.node.submitRawTransaction(transactionHex);
      if (admitted.contentHash.toLowerCase() !== expectedContentHash.toLowerCase()) throw new Error(`${plan.label} changed content identity`);
      this.#pendingEntries.set(admitted.contentHash.toLowerCase(), transactionHex);
      return { accepted: false, queued: true, output: undefined };
    }
    if (plan.wave === CAPTURED_PLAN) {
      this.#capturedEntries.set(expectedContentHash.toLowerCase(), {
        label: plan.label,
        entry: Uint8Array.from(entry),
        contentHash: transactionIdentity(entry).contentHash,
        expectedOutcome: "succeeded",
      });
      return { accepted: false, queued: true, output: undefined };
    }
    this.gate.add(plan.wave, plan.label, entry);
    return { accepted: false, queued: true, output: undefined };
  }
}

const PENDING_PLAN = -1;
const CAPTURED_PLAN = -2;

export async function prepareSeedSiblings<const Values extends readonly unknown[]>(
  preparations: { [Index in keyof Values]: () => Promise<Values[Index]> },
): Promise<Values> {
  return await Promise.all(preparations.map((prepare) => prepare())) as unknown as Values;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function recordSeedActorCredentials(root: string, keys: Record<ActorName, Hex>): Promise<void> {
  const credentialDirectory = join(root, "credentials");
  await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  await chmod(credentialDirectory, 0o700);
  for (const [offset, name] of SEED_ACTOR_ORDER.entries()) {
    const path = join(credentialDirectory, `actor-${offset + 1}.json`);
    try {
      await writeFile(path, `${JSON.stringify({ privateKey: keys[name] })}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(path, "utf8")) as { privateKey?: unknown };
      if (existing.privateKey !== keys[name]) throw new Error(`refusing to overwrite existing actor credential ${path}`);
    }
    await chmod(path, 0o600);
  }
}

async function createActors(params: RichSeedParams, node: PcashNodeClient, status: StatusResult, gate: WaveGate): Promise<Record<ActorName, SeedActor>> {
  const keys = params.actorKeys;
  await recordSeedActorCredentials(params.root, keys);
  const network = networkConfigFromStatus(status);
  const provers = createWalletProvers("native");
  const openedWallets: Wallet<undefined, undefined>[] = [];
  const initializations = SEED_ACTOR_ORDER.map((name) =>
    withSeedRuntimeProgress(`Actor ${name}: open wallet at current output boundary`, async () => {
      const privateKey = keys[name];
      const signer = privateKeyPcashActionSigner(fromHex(privateKey));
      const profile = derivePcashProfileFromPrivateKey(fromHex(privateKey), network);
      const submitter = new PlannedWalletSubmission(gate, node);
      const wallet = await openNodeWallet({
        dataDir: join(params.root, "wallet"),
        node,
        profile,
        signer,
        provers,
        submission: submitter,
        userAccountCreationSubmission: submitter,
        settlePollMaxAttempts: 1,
      });
      openedWallets.push(wallet);
      await wallet.sync({ anchorAtCurrentBoundary: true });
      return [name, { name, privateKey, profile, address: addressHex(profile.address), submitter, wallet }] as const;
    }));
  const pairs = await settleSeedInitializations(initializations, openedWallets);
  return Object.fromEntries(pairs) as unknown as Record<ActorName, SeedActor>;
}

function receiptSubmission(receipt: ReceiptResult): MarketplaceSubmission {
  return {
    contentHash: receipt.contentHash,
    kind: receipt.kind,
    inclusionBlock: receipt.inclusion.l1BlockNumber,
    inclusionBlockHash: receipt.inclusion.l1BlockHash,
    outputLeafStart: receipt.outputLeafStart,
  };
}

function scenarioActor(root: string, actor: SeedActor): ScenarioWalletActor {
  return {
    name: actor.name,
    privateKey: actor.privateKey,
    signer: privateKeyPcashActionSigner(fromHex(actor.privateKey)),
    wallet: actor.profile,
    address: actor.address,
    walletDatabasePath: join(root, "wallet"),
  };
}

export async function submitWave(
  params: RichSeedParams,
  node: SeedWaveNode,
  gate: WaveGate,
  index: number,
  committedCarriers: readonly WaveCarrierResult[] = [],
): Promise<WaveResult> {
  const descriptor = seedWave(index);
  const preparedEntries = await withSeedRuntimeProgress(
    `Wave ${index} ${descriptor.id}: dependency gate`,
    () => gate.waitRequired(index),
  );
  const byLabel = new Map(preparedEntries.map((entry) => [entry.label, entry]));
  if (byLabel.size !== preparedEntries.length) {
    throw new Error(`Wave ${index} ${descriptor.id} contains a duplicate entry label`);
  }
  const entries = descriptor.entries.map((planned) => {
    const entry = byLabel.get(planned.label);
    if (entry === undefined) throw new Error(`Wave ${index} ${descriptor.id} is missing planned entry ${planned.label}`);
    if (entry.expectedOutcome !== planned.expectedOutcome) {
      throw new Error(`Wave ${index} ${descriptor.id} entry ${planned.label} expects ${entry.expectedOutcome}, planned ${planned.expectedOutcome}`);
    }
    return entry;
  });
  if (entries.length !== preparedEntries.length) {
    const planned = new Set(descriptor.entries.map((entry) => entry.label));
    const unexpected = preparedEntries.filter((entry) => !planned.has(entry.label)).map((entry) => entry.label);
    throw new Error(`Wave ${index} ${descriptor.id} has unexpected entries: ${unexpected.join(", ")}`);
  }
  const committed = new Set(committedCarriers.flatMap((carrier) => carrier.entries.map((entry) => entry.label)));
  const partitions = planSeedWaveCarriers(
    descriptor,
    entries.filter((entry) => !committed.has(entry.label)),
  );
  seedLog(`Wave ${index} ${descriptor.id}: ${entries.length} entries require ${partitions.length} carrier transaction(s); carriers=[${partitions.map((partition) => `${partition.carrier}:${controls.frameSeedBatch(partition.entries.map((entry) => entry.entry), VERSION, 1n, 0n).byteLength}`).join(", ")}]`);
  const carriers: WaveCarrierResult[] = [...committedCarriers];
  for (let carrierIndex = 0; carrierIndex < partitions.length; carrierIndex += 1) {
    carriers.push(await submitWaveCarrier({
      params,
      node,
      descriptor: { id: descriptor.id, carrier: partitions[carrierIndex]!.carrier },
      index,
      carrierIndex: carrierIndex + committedCarriers.length,
      carrierCount: partitions.length + committedCarriers.length,
      entries: partitions[carrierIndex]!.entries,
    }));
  }
  return { index, carriers, entries: carriers.flatMap((carrier) => carrier.entries) };
}

interface CarrierInclusion {
  txHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  transactionIndex: number;
}

/**
 * Post carrier bytes that carry no transaction the node could classify: a
 * calldata carrier goes out as a plain journaled call, since there is no
 * outcome to observe, and a blob carrier discovers its exclusions from the
 * node's delivery record.
 */
async function postCarrierBytes(
  params: RichSeedParams,
  node: SeedWaveNode,
  label: string,
  bytes: Uint8Array,
  carrier: SeedCarrier,
  selected: readonly { contentHash: string; batchItemIndex: number }[] = [],
): Promise<{ inclusion: CarrierInclusion; delivery: L1DeliveryBatchResult }> {
  const status = await node.status();
  assertSeedNodeIdentity(status, params.expectedNode);
  const { submitter } = params;
  if (carrier === "blobs") {
    if (selected.length === 0) throw new Error(`${label} blob direct post requires item coordinates`);
    const batchHex = toHex(bytes);
    const quotes = await withSeedRuntimeProgress(
      `${label}: quote blob direct post`,
      () => submitter.quote(status, batchHex, "blobs"),
    );
    const submission = await withSeedRuntimeProgress(
      `${label}: submit blob direct post`,
      async () => (await submitter.send(status, batchHex, quotes.selected, {
        source: "direct",
        selected: selected.map((entry) => entry.contentHash),
        batchItemIndexes: selected.map((entry) => entry.batchItemIndex),
        observationMode: "batch",
        collectibleOpenFee: 0n,
        headCheckedBlock: status.latestBlock,
        headCheckedBlockHash: status.latestBlockHash,
      })).settle(),
    );
    if (submission.delivery === undefined) throw new Error(`${label} has no L1 delivery record`);
    return {
      inclusion: {
        txHash: submission.txHash as Hex,
        blockNumber: submission.receipt.blockNumber,
        blockHash: submission.receipt.blockHash as Hex,
        transactionIndex: submission.receipt.transactionIndex,
      },
      delivery: submission.delivery,
    };
  }
  const receipt = await withSeedRuntimeProgress(`${label}: post ${bytes.length} carrier bytes`, async () =>
    (await submitter.sendCall({ to: status.inboxAddress, data: toHex(bytes) })).settle());
  const txHash = receipt.txHash as Hex;
  const delivery = await withSeedRuntimeProgress(`${label}: wait for delivery diagnostics`, () =>
    eventually(
      `L1 delivery record for ${label}`,
      () => node.getInboxDeliveryBatch(txHash),
      (value) => value !== null,
      { timeoutMs: 10 * 60_000, intervalMs: 500 },
    ));
  if (delivery === null) throw new Error(`${label} has no L1 delivery record`);
  return {
    inclusion: { txHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash as Hex, transactionIndex: receipt.transactionIndex },
    delivery,
  };
}

async function submitWaveCarrier(input: {
  params: RichSeedParams;
  node: SeedWaveNode;
  descriptor: Pick<ReturnType<typeof seedWave>, "id" | "carrier">;
  index: number;
  carrierIndex: number;
  carrierCount: number;
  entries: SeedEntry[];
  /** Whose poster commitment the carrier names, collecting its open-route fees and issuance; the relayer by default. */
  publisher?: Pick<PcashProfile, "address" | "nkRoot">;
}): Promise<WaveCarrierResult> {
  const { params, node, descriptor, index, carrierIndex, carrierCount, entries } = input;
  const carrierLabel = `Wave ${index} ${descriptor.id} carrier ${carrierIndex + 1}/${carrierCount}`;
  const status = await node.status();
  assertSeedNodeIdentity(status, params.expectedNode);
  const posterProfile = input.publisher ?? derivePcashProfileFromPrivateKey(fromHex(params.relayerPrivateKey), networkConfigFromStatus(status));
  const poster = posterPayoutOpening(posterProfile.address, posterProfile.nkRoot, randomFieldEntropy());
  const batch = controls.frameSeedBatch(entries.map((entry) => entry.entry), selectBatchVersion(status), poster.ownerCommitment, poster.context);
  const carrierSuffix = carrierCount === 1 ? "" : `-carrier-${carrierIndex + 1}-of-${carrierCount}`;
  const evidencePath = join(params.root, `wave-${index}-${descriptor.id}${carrierSuffix}.json`);
  const batchHex = toHex(batch);
  const transactionIndexes = entries.flatMap((entry, batchItemIndex) => isItemExclusion(entry.expectedOutcome) ? [] : [batchItemIndex]);
  let inclusion: CarrierInclusion;
  let delivery: L1DeliveryBatchResult | null;
  const observedByIndex = new Map<number, { outcome: string }>();
  if (transactionIndexes.length === 0) {
    ({ inclusion, delivery } = await postCarrierBytes(
      params,
      node,
      carrierLabel,
      batch,
      descriptor.carrier,
      entries.map((entry, batchItemIndex) => ({ contentHash: entry.contentHash, batchItemIndex })),
    ));
  } else {
    const { submitter } = params;
    const quotes = await withSeedRuntimeProgress(
      `${carrierLabel}: quote ${descriptor.carrier} relayer submission`,
      () => submitter.quote(status, batchHex, descriptor.carrier),
    );
    const submission = await withSeedRuntimeProgress(
      `${carrierLabel}: submit exact batch`,
      async () => (await submitter.send(status, batchHex, quotes.selected, {
        selected: transactionIndexes.map((batchItemIndex) => entries[batchItemIndex]!.contentHash),
        batchItemIndexes: transactionIndexes,
        collectibleOpenFee: 0n,
        headCheckedBlock: status.latestBlock,
        headCheckedBlockHash: status.latestBlockHash,
      })).settle(),
    );
    if (submission.outcomes === undefined || submission.outcomes.length !== transactionIndexes.length) {
      throw new Error(`${carrierLabel} did not observe every transaction outcome`);
    }
    for (const outcome of submission.outcomes) observedByIndex.set(Number(outcome.batchItemIndex), outcome);
    inclusion = {
      txHash: submission.txHash as Hex,
      blockNumber: submission.receipt.blockNumber,
      blockHash: submission.receipt.blockHash as Hex,
      transactionIndex: submission.receipt.transactionIndex,
    };
    delivery = await node.getInboxDeliveryBatch(submission.txHash);
  }
  if (delivery === null || delivery.exclusionReason !== null || delivery.items.length !== entries.length) {
    throw new Error(`${carrierLabel} delivery diagnostics are missing or incomplete`);
  }
  const items = delivery.items;
  const matched = await Promise.all(entries.map(async (entry, batchItemIndex) => {
    const item = items[batchItemIndex];
    if (
      item === undefined
      || item.batchItemIndex !== BigInt(batchItemIndex)
      || item.contentHash.toLowerCase() !== entry.contentHash.toLowerCase()
    ) {
      throw new Error(`${entry.label} returned different delivery coordinates`);
    }
    if (isItemExclusion(entry.expectedOutcome)) {
      if (item.exclusionReason !== entry.expectedOutcome) {
        throw new Error(`${entry.label} was excluded as ${item.exclusionReason ?? "nothing"}, expected ${entry.expectedOutcome}`);
      }
      return { entry, receipt: null, transactionId: null, outcome: entry.expectedOutcome, batchItemIndex: item.batchItemIndex };
    }
    const observed = observedByIndex.get(batchItemIndex);
    if (observed === undefined || item.exclusionReason !== null) {
      throw new Error(`${entry.label} transaction outcome is missing`);
    }
    if (observed.outcome !== entry.expectedOutcome) {
      const error = new Error(`${entry.label} outcome ${observed.outcome}, expected ${entry.expectedOutcome}`);
      entry.reject?.(error);
      throw error;
    }
    const receipts = await node.getReceipt({ inclusionId: {
      l1BlockHash: inclusion.blockHash,
      l1TransactionIndex: inclusion.transactionIndex,
      batchItemIndex,
    } });
    if (receipts.length !== 1) throw new Error(`${entry.label} exact inclusion receipt is missing or ambiguous`);
    const receipt = receipts[0]!;
    if (entry.expectedOutcome === "succeeded") entry.resolve?.(receiptSubmission(receipt));
    return { entry, receipt, transactionId: receipt.transactionId, outcome: receipt.outcome, batchItemIndex: receipt.inclusion.batchItemIndex };
  }));
  const result: WaveCarrierResult = {
    carrierIndex,
    carrierType: delivery.carrierType,
    l1TransactionHash: inclusion.txHash,
    l1BlockNumber: inclusion.blockNumber,
    l1BlockHash: inclusion.blockHash,
    l1TransactionIndex: BigInt(inclusion.transactionIndex),
    entries: matched.map(({ entry, receipt, transactionId, outcome, batchItemIndex }) => ({
      label: entry.label,
      contentHash: entry.contentHash,
      transactionId,
      expectedOutcome: entry.expectedOutcome,
      outcome,
      kind: receipt?.kind ?? null,
      batchItemIndex,
      outputLeafStart: receipt?.outputLeafStart ?? null,
      nullifiers: receipt?.nullifiers ?? null,
      settledOpenFeeAmount: receipt?.settledOpenFeeAmount ?? null,
      settledIssuanceAmount: receipt?.settledIssuanceAmount ?? null,
      issuanceOwnerCommitment: receipt?.issuanceOwnerCommitment ?? null,
    })),
  };
  await writeJsonAtomic(evidencePath, {
    version: 1,
    wave: index,
    carrierIndex,
    carrierCount,
    carrier: delivery.carrierType,
    batchBytes: batchHex,
    batchHash: keccak256(batchHex),
    transactionHash: inclusion.txHash,
    observation: result,
  });
  seedLog(`${carrierLabel}: ${delivery.carrierType} carrier observed outcomes [${result.entries.map((entry) => `${entry.label}=${entry.outcome}`).join(", ")}]`);
  return result;
}

/** Post carrier bytes the node must reject as a whole, and confirm the recorded reason. */
async function postExcludedCarrier(
  params: RichSeedParams,
  node: SeedWaveNode,
  label: string,
  bytes: Uint8Array,
  expectedReason: BatchExclusionReason,
): Promise<ExcludedCarrierResult> {
  const { inclusion, delivery } = await postCarrierBytes(
    params,
    node,
    `Excluded carrier ${label}`,
    bytes,
    "calldata",
  );
  if (delivery.exclusionReason !== expectedReason || delivery.items.length !== 0) {
    throw new Error(`${label} was excluded as ${delivery.exclusionReason ?? "nothing"}, expected ${expectedReason}`);
  }
  const result: ExcludedCarrierResult = { label, l1TransactionHash: inclusion.txHash, exclusionReason: expectedReason };
  await writeJsonAtomic(join(params.root, `${label}.json`), { version: 1, batchBytes: toHex(bytes), ...result });
  seedLog(`Excluded carrier ${label}: ${delivery.exclusionReason}`);
  return result;
}

function privateValueNullifiers(entry: Uint8Array): bigint[] {
  const decoded = decodeTransaction(entry);
  if (decoded.kind !== 0) throw new Error("nullifier comparison requires a private-value entry");
  return privateValuePublicInputs(decoded).slice(2, 6).filter((value) => value !== 0n);
}

function assertDisjointProgrammableInputs(left: SeedEntry, right: SeedEntry): void {
  const leftNullifiers = new Set(privateValueNullifiers(left.entry).map(String));
  const overlap = privateValueNullifiers(right.entry).filter((value) => leftNullifiers.has(value.toString()));
  if (overlap.length > 0) {
    throw new Error(`${left.label} and ${right.label} selected the same current-run note nullifier`);
  }
}

function assertIndependentSellerValueLanes(noteEntry: SeedEntry, earningEntry: SeedEntry): void {
  if (decodeTransaction(noteEntry.entry).kind !== 0) throw new Error(`${noteEntry.label} is not private value`);
  if (decodeTransaction(earningEntry.entry).kind !== 0) throw new Error(`${earningEntry.label} is not private value`);
  const noteNullifiers = new Set(privateValueNullifiers(noteEntry.entry).map(String));
  if (privateValueNullifiers(earningEntry.entry).some((value) => noteNullifiers.has(value.toString()))) {
    throw new Error("seller private-value lanes share an input nullifier");
  }
  if (noteEntry.contentHash.toLowerCase() === earningEntry.contentHash.toLowerCase()) {
    throw new Error("seller note and earning lanes unexpectedly share one content identity");
  }
}

function isOfferSourceReady(view: ContractSourceView | null, offer: Offer): view is ContractSourceView {
  if (view === null
    || view.verificationStatus !== "verified"
    || BigInt(view.address) !== offer.l2ContractAddress
    || view.implementations.length !== 2
    || view.contract.functions.length !== 2
    || view.configurationOpenings.length !== 2) return false;
  const expectedFunctions = [
    { selector: 0n, applicationVkHash: offer.claimApplicationVkHash, commitment: offer.claimConfigurationCommitment },
    { selector: 1n, applicationVkHash: offer.reclaimApplicationVkHash, commitment: offer.reclaimConfigurationCommitment },
  ];
  const applicationVkHashes = new Set(view.implementations.map((entry) => BigInt(entry.applicationVkHash).toString()));
  if (!expectedFunctions.every((expected) => applicationVkHashes.has(expected.applicationVkHash.toString()))) return false;
  return expectedFunctions.every((expected) => {
    const fn = view.contract.functions.find((entry) => BigInt(entry.selector) === expected.selector);
    const opening = view.configurationOpenings.find((entry) => entry.selector === expected.selector);
    return fn !== undefined
      && BigInt(fn.applicationVkHash) === expected.applicationVkHash
      && BigInt(fn.configurationCommitment) === expected.commitment
      && opening !== undefined
      && opening.status === "verified"
      && BigInt(opening.expectedConfigurationCommitment) === expected.commitment
      && opening.computedConfigurationCommitment !== null
      && BigInt(opening.computedConfigurationCommitment) === expected.commitment;
  });
}

async function sync(...actors: SeedActor[]): Promise<void> {
  await Promise.all(actors.map((actor) => withSeedRuntimeProgress(
    `Actor ${actor.name}: wallet sync`,
    () => actor.wallet.sync(),
  )));
}

async function publishOfferSource(
  pscan: PscanClient,
  expectedNode: SeedNodeIdentity,
  sourceManifest: string,
  offer: Offer,
): Promise<void> {
  const openings = marketplaceSourceConfigurationOpenings({
    address: offer.l2ContractAddress,
    reclaimAuthority: offer.reclaimAuthority,
    claimConfigurationSalt: offer.claimConfigurationSalt,
    reclaimConfigurationSalt: offer.reclaimConfigurationSalt,
    terms: offer.terms,
    network: offer.network,
  });
  const address = addressHex(offer.l2ContractAddress);
  const submitted = await withSeedRuntimeProgress(`Pscan ${address}: submit source package and openings`, async () => {
    assertSeedPscanIdentity(await pscan.sourceVerificationInfo(), expectedNode);
    return pscan.submitContractSource({
      contractAddresses: [address],
      publication: sourceVerificationPublicationWithConfigurationOpenings(sourceManifest, openings),
    });
  });
  if (submitted.configurationOpeningCount !== 2n) {
    throw new Error(`Pscan accepted ${submitted.configurationOpeningCount} configuration openings for ${address}, expected 2`);
  }
  await withSeedRuntimeProgress(
    `Pscan ${address}: waiting for verified source readback`,
    () => eventually(
      `verified Marketplace source and openings for ${address}`,
      () => pscan.getContractSource(address),
      (view): view is ContractSourceView => isOfferSourceReady(view, offer),
      { timeoutMs: 30_000, intervalMs: 250 },
    ),
  );
}

export async function runRichSeed(params: RichSeedParams): Promise<RichSeedResult> {
  await mkdir(params.root, { recursive: true, mode: 0o700 });
  const node = new PcashNodeClient(params.rpcUrl);
  const status = await node.status();
  assertSeedNodeIdentity(status, params.expectedNode);
  const pscan = createPscanClient(params.pscanUrl, undefined, node);
  assertSeedPscanIdentity(await pscan.sourceVerificationInfo(), params.expectedNode);
  const catalog = await node.catalogInfo();
  if (catalog.status !== "available") throw new Error("rich seed requires the node Marketplace catalog");
  const gate = new WaveGate();
  const actors = await createActors(params, node, status, gate);
  const sellerEarningSubmitter = new PlannedWalletSubmission(gate, node);
  let sellerEarningWallet: Wallet | undefined;
  const waves: WaveResult[] = [];
  const network = networkConfigFromStatus(status);
  const relayerAddress = privateKeyToAccount(params.relayerPrivateKey).address.toLowerCase();
  const relayerProfile = derivePcashProfileFromPrivateKey(fromHex(params.relayerPrivateKey), network);
  // The quote authenticates independent private payment and issuance destinations.
  const selectedRelayQuote: SelectedRelayQuoteProvider = {
    recipient: relayerProfile.address,
    requestQuote: (request) => {
      const { issuanceEligible, ...quoteRequest } = request;
      return createSelectedRelayQuote({
        ...quoteRequest,
        ...(issuanceEligible === undefined ? {} : { issuanceEligible }),
        network,
        nkRoot: relayerProfile.nkRoot,
        receiveKey: relayerProfile.mlKemPublicKey,
        signer: privateKeyPcashActionSigner(fromHex(params.relayerPrivateKey)),
      });
    },
  };
  let marketplaceTask: Promise<MarketplaceEscrowSeedEvidence> | undefined;
  const paidFundingBarrier = createSeedBarrier();
  try {
    await Promise.all([actors.S, actors.R, actors.M, actors.O].map((actor) =>
      withSeedRuntimeProgress(`Actor ${actor.name}: prepare user account`, async () => {
        const label = `account-${actor.name.toLowerCase()}`;
        if (await node.getAccount(actor.address) !== null) {
          gate.satisfy(0, label);
          return;
        }
        actor.submitter.plan(0, label);
        await actor.wallet.updateAccount();
      })));

    const accountEntries = [...(gate.waves.get(0) ?? [])].sort((left, right) =>
      seedWave(0).entries.findIndex((entry) => entry.label === left.label)
      - seedWave(0).entries.findIndex((entry) => entry.label === right.label));
    const accountCarriers = accountEntries.length === 0 ? [] : [await submitWaveCarrier({
      params, node, descriptor: { id: "accounts-bootstrap", carrier: "calldata" },
      index: 0, carrierIndex: 0, carrierCount: 1, entries: accountEntries,
    })];
    await sync(actors.S, actors.R, actors.M, actors.O);

    marketplaceTask = withSeedRuntimeProgress("Marketplace: paid and unpaid offer lifecycle", () => runMarketplaceScenarioFlow({
      repoRoot: params.repoRoot,
      workDir: join(params.root, "marketplace"),
      l1RpcUrl: params.l1Rpc,
      node,
      network,
      seller: actors.S.profile,
      sellerSigner: privateKeyPcashActionSigner(fromHex(actors.S.privateKey)),
      sellerWallet: actors.S.wallet,
      buyer: actors.M.profile,
      buyerSigner: privateKeyPcashActionSigner(fromHex(actors.M.privateKey)),
      sellerWalletDatabasePath: join(params.root, "wallet"),
      sellerL1PrivateKey: actors.S.privateKey,
      buyerL1PrivateKey: actors.M.privateKey,
      routerDeployerPrivateKey: params.relayerPrivateKey,
      maxFeePerGas: params.maxFeePerGas,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      openFeeAmount: 0n,
      routerAddress: params.routerAddress,
      routerConfig: params.routerConfig,
      ...(params.ethPriceWei === undefined ? {} : { ethPriceWei: params.ethPriceWei }),
      ...(params.pcashAmount === undefined ? {} : { pcashAmount: params.pcashAmount }),
      submitAndWait: (entry, label) => gate.marketplace(entry, label),
      // The seed posts every carrier itself; a zero-open-fee creation pays no
      // system payout whichever poster its carrier names.
      selfPublish: (entry, label) => gate.marketplace(entry, label),
      publishSourceVerification: async (offer) => publishOfferSource(pscan, params.expectedNode, params.sourceManifest, offer),
      leaveUnpaidEscrowed: true,
      deferFundingInventory: true,
      beforePaidFunding: () => paidFundingBarrier.wait(),
      // The paid offer stays open for purchases for the seed's whole run.
      claimDeadlineLeadSeconds: MIN_CLAIM_WINDOW_SECONDS + PURCHASE_MARGIN_SECONDS + 4n * 60n * 60n,
      reclaimDeadlineLeadSeconds: SEED_UNPAID_OFFER_DEADLINE_LEAD_SECONDS,
      pollIntervalMs: 1_000,
      checkpoint: (label, value) => writeJsonAtomic(join(params.root, `${label.replace(/:/g, "-")}.json`), value),
      log: (message) => seedLog(`Marketplace: ${message}`),
    })).then((result) => {
      if (!("paidOffer" in result) || !("unpaidOffer" in result)) throw new Error("Marketplace seed returned incomplete evidence");
      return result as MarketplaceEscrowSeedEvidence;
    }).catch((error) => {
      gate.fail(error);
      throw error;
    });

    const paidPrepared = await gate.waitRequired(0, 20 * 60_000, ["paid-offer:contract"]);
    const paidCreation = paidPrepared.find((entry) => entry.label === "paid-offer:contract")!;
    accountCarriers.push(await submitWaveCarrier({
      params, node, descriptor: { id: "paid-contract", carrier: "calldata" },
      index: 0, carrierIndex: accountCarriers.length, carrierCount: accountCarriers.length + 1,
      entries: [paidCreation],
    }));
    const wave0 = await gate.waitRequired(0);
    const accountO = wave0.find((entry) => entry.label === "account-o");
    const paidContract = wave0.find((entry) => entry.label === "paid-offer:contract")!;
    if (accountO === undefined) throw new Error("fresh control account O was not prepared");
    const head0 = await node.status();
    const keyless = controls.controlIdentity("account-k", network);
    gate.add(0, "account-k", await controls.signedAccountCreation({
      identity: keyless,
      network,
      recentPcashBlockHash: BigInt(head0.latestBlockHash),
      validUntilTimestamp: head0.latestBlockTimestamp + 1_800n,
      receiveKey: false,
    }));
    const vault = controls.privateVaultContract("private-vault", [actors.S.profile, actors.R.profile, actors.M.profile]);
    // The vault's sponsored creation pays a zero fee: it spends nothing and
    // only authorizes the publication.
    const vaultEntry = await buildSponsoredContractCreation({
      node,
      sponsor: {
        wallet: actors.S.profile,
        signer: privateKeyPcashActionSigner(fromHex(actors.S.privateKey)),
      },
      contract: { body: vault.body, address: vault.contractAddress },
    });
    gate.add(0, "private-vault:contract", vaultEntry);
    const unfundedVault = controls.privateVaultContract("unfunded-vault", [actors.S.profile, actors.R.profile, actors.M.profile]);
    gate.add(0, "unfunded-vault:contract", controls.unfundedContractCreation({
      network,
      body: unfundedVault.body,
      recentPcashBlockHash: BigInt(head0.latestBlockHash),
      validUntilTimestamp: head0.latestBlockTimestamp + 1_800n,
    }));
    gate.add(0, "control-account-already-exists", accountO.entry, "accountAlreadyExists");
    gate.add(0, "control-account-bad-signature", controls.badSignatureCreation(accountO.entry), "invalidAccountSignature");
    gate.add(0, "control-account-y-parity", controls.unknownYParityCreation(accountO.entry), "unknownYParity");
    gate.add(0, "control-account-receive-key-mode", controls.unknownReceiveKeyModeCreation(accountO.entry), "unknownReceiveKeyMode");
    const windows = controls.creationWindowControls(head0);
    for (const [label, window, expected] of [
      ["control-account-stale-window", windows.staleWindow, "recentPcashBlockNotInWindow"],
      ["control-account-expired", windows.expired, "expired"],
    ] as const) {
      gate.add(0, label, await controls.signedAccountCreation({
        identity: controls.controlIdentity(label, network),
        network,
        ...window,
        receiveKey: true,
      }), expected);
    }
    gate.add(0, "control-contract-address-exists", paidContract.entry, "contractAddressExists");
    gate.add(0, "control-contract-funding-mode", controls.unknownFundingModeContract(paidContract.entry), "unknownFundingMode");
    gate.add(0, "control-contract-nk-root-flag", controls.unknownNkRootFlagContract(paidContract.entry), "unknownPublishesNkRootFlag");
    gate.add(0, "control-contract-noncanonical-field", controls.nonCanonicalFieldContract(paidContract.entry), "nonCanonicalContractField");
    gate.add(0, "control-contract-empty-functions", controls.emptyFunctionsContract(paidContract.entry), "emptyContractFunctionSet");
    gate.add(0, "control-contract-selector-order", controls.swappedSelectorsContract(paidContract.entry), "selectorsNotStrictlyIncreasing");
    gate.add(0, "control-unknown-kind", controls.unknownTypeItem(network.pcashChainId), "unknownKind");
    waves.push(await submitWave(params, node, gate, 0, accountCarriers));
    await sync(actors.S, actors.R, actors.M);

    actors.S.submitter.plan(1, "earn-s");
    await withSeedRuntimeProgress("Wave 1: earn S native notes through authorized asset creation", () => actors.S.wallet.createAsset({
      metadata:{name:"Seed participation",symbol:"PART",decimals:0,contentDigest:new Uint8Array(32)},initialSupply:1n,
    }));
    // S's earning actions are built for relay on the open route and framed in
    // S's own batches, so S's poster commitment collects their issuance.
    const initialFundingCarriers = [await submitWaveCarrier({
      params, node, descriptor: { id: "seller-earning", carrier: "calldata" },
      index: 1, carrierIndex: 0, carrierCount: 1,
      entries: [await gate.waitForLabel(1, "earn-s")],
      publisher: actors.S.profile,
    })];
    await sync(actors.S);
    const sellerAmount = (await actors.S.wallet.nativeFunds()).spendablePrivate * 4n / 5n;
    if (sellerAmount < 5n) throw new Error("Seed requires positive native issuance in the active window");
    actors.S.submitter.plan(1, "fund-m");
    await withSeedRuntimeProgress("Wave 1: fund M with an ordinary note payment from S", () => actors.S.wallet.send({
      to: actors.M.address, amount: sellerAmount / 4n, openFeeAmount: 0n,
    }));
    initialFundingCarriers.push(await submitWaveCarrier({
      params, node, descriptor: { id: "merchant-funding", carrier: "calldata" },
      index: 1, carrierIndex: 1, carrierCount: 2,
      entries: [await gate.waitForLabel(1, "fund-m")],
    }));
    await sync(actors.S, actors.M);
    const merchantNotes = (await actors.M.wallet.nativeFunds()).spendablePrivate;
    const merchantAmount = merchantNotes * 4n / 5n;
    actors.M.submitter.plan(1, "transfer-m-self");
    await withSeedRuntimeProgress("Wave 1: prove M note-funded payment", () => actors.M.wallet.send({
      to: actors.M.address, amount: merchantAmount, openFeeAmount: 0n,
      privateRelayFeeAmount: seedFee(merchantAmount), selectedRelayQuote,
      submission: actors.M.submitter,
    }));
    const wave1Result = await submitWave(params, node, gate, 1, initialFundingCarriers);
    waves.push(wave1Result);
    await sync(actors.S, actors.M);
    const merchantSelfEntry = wave1Result.entries.find((entry) => entry.label === "transfer-m-self");
    if (merchantSelfEntry === undefined) throw new Error("selected merchant self-transfer is missing");
    await withSeedRuntimeProgress("Wave 1: recover private relay fee", () => assertSelectedPrivateFeeRecovered({
      node, chainId: network.pcashChainId, entry: merchantSelfEntry,
      relayer: relayerProfile, expectedAmount: seedFee(merchantAmount),
    }));

    const [snapshotS, snapshotM] = await Promise.all([actors.S.wallet.snapshot(), actors.M.wallet.snapshot()]);
    const balanceS = snapshotS.balances.find((balance) => balance.assetId === 0n)?.spendable ?? 0n;
    const balanceM = snapshotM.balances.find((balance) => balance.assetId === 0n)?.spendable ?? 0n;
    actors.S.submitter.plan(2, "transfer-s-r");
    actors.M.submitter.plan(2, "transfer-m-r");
    sellerEarningSubmitter.plan(2, "earn-s-again");
    sellerEarningWallet = await openNodeWallet({
      dataDir: join(params.root, "wallet-earn-s"),
      node,
      profile: actors.S.profile,
      signer: privateKeyPcashActionSigner(fromHex(actors.S.privateKey)),
      provers: createWalletProvers("native"),
      submission: sellerEarningSubmitter,
      userAccountCreationSubmission: sellerEarningSubmitter,
      settlePollMaxAttempts: 1,
    });
    await sellerEarningWallet.sync({ anchorAtCurrentBoundary: true });
    await prepareSeedSiblings([
      () => withSeedRuntimeProgress("Wave 2: prove S to R note transfer", () =>
        actors.S.wallet.send({ to: actors.R.address, amount: balanceS / 8n, openFeeAmount: seedFee(balanceS / 8n) })),
      () => withSeedRuntimeProgress("Wave 2: prove M to R note transfer", () =>
        actors.M.wallet.send({
          to: actors.R.address,
          amount: balanceM / 8n,
          openFeeAmount: 0n,
          privateRelayFeeAmount: seedFee(balanceM / 8n),
          selectedRelayQuote,
          submission: actors.M.submitter,
        })),
      () => withSeedRuntimeProgress("Wave 2: earn S more issuance without consuming its payment notes", () =>
        sellerEarningWallet!.createAsset({metadata:{name:"Second participation",symbol:"PART",decimals:0,contentDigest:new Uint8Array(32)},initialSupply:1n,submission:sellerEarningSubmitter})),
    ] as const);
    const sellerNoteEntry = await gate.waitForLabel(2, "transfer-s-r");
    const sellerEarningEntry = await gate.waitForLabel(2, "earn-s-again");
    assertIndependentSellerValueLanes(sellerNoteEntry, sellerEarningEntry);
    const sellerEarningCarrier = await submitWaveCarrier({
      params, node, descriptor: { id: "seller-earning-again", carrier: "calldata" },
      index: 2, carrierIndex: 0, carrierCount: 1,
      entries: [sellerEarningEntry],
      publisher: actors.S.profile,
    });
    const validM = gate.waves.get(2)!.find((entry) => entry.label === "transfer-m-r")!;
    gate.add(2, "control-proof-rejected", controls.proofRejectedTransfer(validM.entry), "proofRejected");
    gate.add(2, "control-transfer-output-byte-zero", controls.outputByteZeroProofMutationTransfer(validM.entry), "proofRejected");
    gate.add(2, "control-nullifier-reuse", validM.entry, "nullifierAlreadySpent");
    gate.add(2, "control-transfer-stale-window", controls.staleWindowTransfer(validM.entry), "recentPcashBlockNotInWindow");
    gate.add(2, "control-transfer-expired", controls.expiredTransfer(validM.entry), "expired");
    gate.add(2, "control-transfer-not-yet-valid", controls.notYetValidTransfer(validM.entry), "notYetValid");
    gate.add(2, "control-transfer-carrier-context", controls.carrierContextMismatchTransfer(validM.entry), "carrierContextMismatch");
    gate.add(2, "control-transfer-zero-nullifier", controls.zeroNullifierTransfer(validM.entry), "zeroNullifier");
    gate.add(2, "control-transfer-duplicate-nullifier", controls.duplicateNullifierTransfer(validM.entry), "duplicateInputNullifier");
    gate.add(2, "control-transfer-public-input-not-in-field", controls.publicInputNotInFieldTransfer(validM.entry), "publicInputNotInField");
    gate.add(2, "control-wrong-chain-id", controls.wrongChainIdTransfer(validM.entry), "wrongChainId");
    gate.add(2, "control-empty-item", controls.emptyItem(), "empty");
    gate.add(2, "control-truncated-item", controls.truncatedItem(validM.entry), "truncated");
    gate.add(2, "control-trailing-bytes-item", controls.trailingBytesItem(validM.entry), "trailingBytes");
    gate.add(2, "control-item-too-large", controls.oversizedItem(validM.entry), "itemTooLarge");
    const wave2Result = await submitWave(params, node, gate, 2, [sellerEarningCarrier]);
    waves.push(wave2Result);
    const initialEarning = wave1Result.entries.find((entry) => entry.label === "earn-s");
    const secondEarning = wave2Result.entries.find((entry) => entry.label === "earn-s-again");
    if (initialEarning?.outputLeafStart === null
      || initialEarning === undefined
      || secondEarning?.outputLeafStart === null
      || secondEarning === undefined
      || secondEarning.outputLeafStart <= initialEarning.outputLeafStart) {
      throw new Error("W2 repeated earning action did not append later outputs");
    }
    // Open fees and issuance recover through system payouts; selected relay
    // payment recovers as an ordinary private note.
    const payoutChecks = [
      { entry: initialEarning, sourceKind: "posterPayout", recipient: actors.S.profile },
      { entry: secondEarning, sourceKind: "posterPayout", recipient: actors.S.profile },
      { entry: wave2Result.entries.find((entry) => entry.label === "transfer-s-r"), sourceKind: "posterPayout", recipient: relayerProfile },
      { entry: wave2Result.entries.find((entry) => entry.label === "transfer-m-r"), sourceKind: "designatedIssuance", recipient: relayerProfile },
    ] as const;
    for (const { entry, sourceKind, recipient } of payoutChecks) {
      if (entry === undefined) throw new Error("seed payout check names a missing wave entry");
      await withSeedRuntimeProgress(`Payout: ${entry.label} pays ${sourceKind}`, () => assertSystemPayoutRecovered({
        node, chainId: network.pcashChainId, contentHash: entry.contentHash, label: entry.label, sourceKind, recipient,
      }));
    }
    const selectedMerchantEntry = wave2Result.entries.find((entry) => entry.label === "transfer-m-r");
    if (selectedMerchantEntry === undefined) throw new Error("selected merchant transfer is missing");
    await withSeedRuntimeProgress("Wave 2: recover private relay fee", () => assertSelectedPrivateFeeRecovered({
      node, chainId: network.pcashChainId, entry: selectedMerchantEntry,
      relayer: relayerProfile, expectedAmount: seedFee(balanceM / 8n),
    }));
    const repeatedEarningIssuance = secondEarning.settledIssuanceAmount ?? 0n;
    if (repeatedEarningIssuance <= 0n) throw new Error("second self-published earning action issued nothing");
    await sync(actors.S, actors.M, actors.R);

    const transferSReceipt = wave2Result.entries.find((entry) => entry.label === "transfer-s-r");
    if (transferSReceipt?.outputLeafStart === null || transferSReceipt === undefined) {
      throw new Error("W2 S to R transfer did not expose its current-run output leaves");
    }
    const sellerChangeOutput = transferSReceipt.outputLeafStart + 1n;
    const sellerChangeNote = (await actors.S.wallet.notes({ assetId: 0n, status: "spendable" }))
      .find((note) => note.leafIndex === sellerChangeOutput && note.commitment !== null);
    if (sellerChangeNote?.commitment == null) throw new Error("W2 S to R current-run change note was not recovered");
    if (sellerChangeNote.amount < 2n) throw new Error("W2 S to R current-run change note is too small for the W3 change lane");
    const recipientNotes = await actors.R.wallet.notes({ assetId: 0n, status: "spendable" });
    if (recipientNotes.length !== 2 || recipientNotes.some((note) => note.commitment === null)) {
      throw new Error(`fresh R recovered ${recipientNotes.length} spendable notes after two W2 deliveries; expected exactly 2`);
    }
    const recipientTotal = recipientNotes.reduce((sum, note) => sum + note.amount, 0n);
    const recipientLargest = recipientNotes.reduce((largest, note) => note.amount > largest ? note.amount : largest, 0n);
    const recipientRemainder = recipientTotal - recipientLargest;
    const multiInputAmount = recipientLargest + (recipientRemainder > 1n ? recipientRemainder / 2n : recipientRemainder);
    if (multiInputAmount <= recipientLargest || multiInputAmount > recipientTotal) {
      throw new Error("fresh R deliveries cannot form the required two-input transfer");
    }
    const sellerChangeIntent = {
      to: actors.R.address,
      noteSelector: sellerChangeNote.commitment,
      amount: sellerChangeNote.amount / 2n,
      openFeeAmount: seedFee(sellerChangeNote.amount / 2n),
    } as const;
    const multiInputIntent = {
      to: walletExtendedCode(actors.X.profile, network.pcashChainId),
      amount: multiInputAmount,
      openFeeAmount: 0n,
      privateRelayFeeAmount: (recipientTotal - multiInputAmount) / 2n,
      selectedRelayQuote,
      submission: actors.R.submitter,
    } as const;
    const [sellerChangePreflight, recipientPreflight] = await Promise.all([
      withSeedRuntimeProgress("Wave 3: preflight exact S change note", () => actors.S.wallet.preflightSend(sellerChangeIntent)),
      withSeedRuntimeProgress("Wave 3: preflight exact R two-input transfer", () => actors.R.wallet.preflightSend(multiInputIntent)),
    ]);
    if (sellerChangePreflight.inputCount !== 1) {
      throw new Error("W3 S change transfer did not select one private note");
    }
    if (recipientPreflight.inputCount !== 2
      || recipientPreflight.inputTotal !== recipientTotal) {
      throw new Error("W3 R transfer did not select exactly the two current-run delivery notes");
    }
    actors.S.submitter.plan(3, "transfer-s-change-r");
    actors.R.submitter.plan(3, "transfer-r-x");
    const sellerChangePreparation = withSeedRuntimeProgress(
      "Wave 3: prove S change-note transfer",
      () => actors.S.wallet.send(sellerChangeIntent),
    );
    const multiInputPreparation = withSeedRuntimeProgress(
      "Wave 3: prove R two-input transfer to recordless X",
      () => actors.R.wallet.send(multiInputIntent),
    );
    void sellerChangePreparation.catch((error) => gate.fail(error));
    void multiInputPreparation.catch((error) => gate.fail(error));
    const sellerChangeEntry = await gate.waitForLabel(3, "transfer-s-change-r");
    paidFundingBarrier.resolve();
    await Promise.all([sellerChangePreparation, multiInputPreparation]);
    const paidFundingEntry = await gate.waitForLabel(3, "paid-offer:fund");
    assertDisjointProgrammableInputs(paidFundingEntry, sellerChangeEntry);
    const wave3Result = await submitWave(params, node, gate, 3);
    waves.push(wave3Result);
    await sync(actors.S, actors.R, actors.X);
    const selectedRecipientEntry = wave3Result.entries.find((entry) => entry.label === "transfer-r-x");
    if (selectedRecipientEntry === undefined) throw new Error("selected two-input transfer is missing");
    await withSeedRuntimeProgress("Wave 3: recover private relay fee", () => assertSelectedPrivateFeeRecovered({
      node, chainId: network.pcashChainId, entry: selectedRecipientEntry,
      relayer: relayerProfile, expectedAmount: multiInputIntent.privateRelayFeeAmount,
    }));

    actors.X.submitter.plan(4, "account-x");
    await withSeedRuntimeProgress("Wave 4: prepare X user account", () => actors.X.wallet.updateAccount());
    actors.R.submitter.plan(4, "update-r-receive-key");
    const rSnapshot = await actors.R.wallet.snapshot();
    const rBalance = rSnapshot.balances.find((balance) => balance.assetId === 0n)?.spendable ?? 0n;
    await withSeedRuntimeProgress("Wave 4: prove R receive-key replacement", () =>
      actors.R.wallet.updateAccount({
        receiveKey: { operation: "replace", keyPair: generateMlKemKeyPair() },
        openFeeAmount: seedFee(rBalance),
      }));
    const updateTemplate = await gate.waitForLabel(4, "update-r-receive-key");
    const paidContractTxId = waves[0]!.entries.find((entry) => entry.label === "paid-offer:contract")?.transactionId;
    if (paidContractTxId == null) throw new Error("paid offer contract has no transaction id");
    const paidContractAccount = (await node.getReceipt(paidContractTxId))[0]?.account;
    if (paidContractAccount == null) throw new Error("paid offer contract receipt names no account");
    const head4 = await node.status();
    gate.add(4, "control-update-noncanonical-field", controls.nonCanonicalFieldUpdate(updateTemplate.entry), "nonCanonicalAccountField");
    gate.add(4, "control-update-stale-window", controls.staleWindowUpdate(updateTemplate.entry), "recentPcashBlockNotInWindow");
    gate.add(4, "control-update-expired", controls.expiredUpdate(updateTemplate.entry), "expired");
    gate.add(4, "control-update-account-not-found", controls.retargetedUpdate(updateTemplate.entry, controls.controlAddress("account-not-found"), "account-not-found control"), "accountNotFound");
    gate.add(4, "control-update-wrong-kind", controls.retargetedUpdate(updateTemplate.entry, paidContractAccount.address, "wrong-kind control"), "wrongAccountKind");
    gate.add(4, "control-update-clear-without-key", controls.clearWithoutReceiveKeyUpdate({
      template: updateTemplate.entry,
      address: keyless.address,
      pcashChainId: params.expectedNode.pcashChainId,
      recentPcashBlockHash: BigInt(head4.latestBlockHash),
      validUntilTimestamp: head4.latestBlockTimestamp + 1_800n,
    }), "clearWithoutReceiveKey");
    gate.add(4, "control-update-commitment", controls.accountUpdateCommitmentMismatchUpdate(updateTemplate.entry), "accountUpdateCommitmentMismatch");
    gate.add(4, "control-update-proof-rejected", controls.proofRejectedUpdate(updateTemplate.entry), "proofRejected");
    waves.push(await submitWave(params, node, gate, 4));
    await sync(actors.S, actors.M, actors.R, actors.X);

    const xSnapshot = await actors.X.wallet.snapshot();
    const xBalance = xSnapshot.balances.find((balance) => balance.assetId === 0n)?.spendable ?? 0n;
    actors.X.submitter.plan(5, "transfer-x-s");
    await withSeedRuntimeProgress("Wave 5: prove X to S transfer", () =>
      actors.X.wallet.send({ to: actors.S.address, amount: xBalance / 2n, openFeeAmount: seedFee(xBalance / 2n) }));
    gate.add(5, "control-update-identical-key", updateTemplate.entry, "replaceWithIdenticalReceiveKey");
    waves.push(await submitWave(params, node, gate, 5));
    await sync(actors.S, actors.X);

    const volumeCarriers: WaveCarrierResult[] = [];
    const selectedVolumeFees = new Map<string, bigint>();
    const volumeActors = [actors.S, actors.M, actors.R, actors.X];
    for (let round = 0; round * volumeActors.length < params.volumeTransfers; round += 1) {
      const senders = volumeActors.slice(0, Math.min(volumeActors.length, params.volumeTransfers - round * volumeActors.length));
      await sync(...senders);
      const sent = await Promise.all(senders.map(async (actor, offset) => {
        const recipient = volumeActors[(volumeActors.indexOf(actor) + 1 + round % (volumeActors.length - 1)) % volumeActors.length]!;
        const balances = await actor.wallet.balances({ assetId: 0n });
        const amount = nonzeroSeedQuotient(balances[0]?.spendable ?? 0n, 10n);
        if (amount === null) throw new Error(`volume round ${round + 1}: actor ${actor.name} has no spendable balance`);
        const feeLane = (round + offset) % 3;
        const label = `volume-${round + 1}-${actor.name.toLowerCase()}`;
        if (feeLane === 2) selectedVolumeFees.set(label, seedFee(amount));
        actor.submitter.planCaptured(label);
        const result = await withSeedRuntimeProgress(`Volume ${label}: prove transfer to ${recipient.name}`, () => actor.wallet.send({
          ...(round === 0 && offset === 0 ? { shape: PRIVATE_VALUE_PROFILES.L.shapeId } : {}),
          to: recipient.address,
          amount,
          openFeeAmount: feeLane === 1 ? seedFee(amount) : 0n,
          ...(feeLane === 2 ? {
            privateRelayFeeAmount: seedFee(amount), selectedRelayQuote,
            submission: actor.submitter,
          } : {}),
        }));
        return actor.submitter.capturedEntry(result.contentHash);
      }));
      const partitions = partitionSeedEntries(sent);
      for (const [carrierIndex, entries] of partitions.entries()) {
        const carrier = await submitWaveCarrier({
          params,
          node,
          descriptor: { id: `volume-${round + 1}`, carrier: "calldata" },
          index: 100 + round,
          carrierIndex,
          carrierCount: partitions.length,
          entries,
        });
        volumeCarriers.push(carrier);
        for (const entry of carrier.entries) {
          const expectedAmount = selectedVolumeFees.get(entry.label);
          if (expectedAmount === undefined) continue;
          await withSeedRuntimeProgress(`Volume ${entry.label}: recover private relay fee`, () => assertSelectedPrivateFeeRecovered({
            node, chainId: network.pcashChainId, entry,
            relayer: relayerProfile, expectedAmount,
          }));
        }
      }
    }
    await sync(...volumeActors);

    const excludedCarriers: ExcludedCarrierResult[] = [];
    for (const control of EXCLUDED_CARRIER_CONTROLS) {
      const bytes = control.reason === "unsupportedBatchVersion"
        ? controls.unsupportedVersionCarrier()
        : controls.trailingBytesCarrier(validM.entry, selectBatchVersion(status));
      excludedCarriers.push(await postExcludedCarrier(params, node, control.label, bytes, control.reason));
    }

    const marketplace = await withSeedRuntimeProgress("Marketplace: wait for lifecycle evidence", () => marketplaceTask!);
    const assetCarriers: WaveCarrierResult[] = [];
    let assetSubmissionIndex = 0;
    const submitAssetEntry = async (
      entry: Uint8Array,
      label: string,
      expectedOutcome: ExpectedOutcome,
    ): Promise<WaveEntryResult> => {
      const seedEntry: SeedEntry = { label, entry, contentHash: transactionIdentity(entry).contentHash, expectedOutcome };
      const index = 6 + assetSubmissionIndex;
      assetSubmissionIndex += 1;
      const carrier = await submitWaveCarrier({
        params,
        node,
        descriptor: { id: `asset-${assetSubmissionIndex}`, carrier: "calldata" },
        index,
        carrierIndex: 0,
        carrierCount: 1,
        entries: [seedEntry],
      });
      assetCarriers.push(carrier);
      return carrier.entries[0]!;
    };
    const assets = await withSeedRuntimeProgress("Assets: complete private asset lifecycle", () =>
      runAssetScenarioFlow({
        network,
        node,
        proofDirectory: join(params.root, "proofs", "assets"),
        creator: scenarioActor(params.root, actors.S),
        holder: scenarioActor(params.root, actors.M),
        recipient: scenarioActor(params.root, actors.R),
        initialSupply: params.assetInitialSupply ?? 1_000_000n,
        openFeeAmount: params.assetActionFee ?? 1n,
        expectUnfinalizedReservation: false,
        burnAmount: (params.assetInitialSupply ?? 1_000_000n) / 100n,
        nextValidUntilTimestamp: async () => (await node.status()).latestBlockTimestamp + 1_800n,
        async submitAndWait(entry, label) {
          const observed = await submitAssetEntry(entry, label, "succeeded");
          if (observed.transactionId === null) throw new Error(`${label} did not receive a transaction id`);
          return { label, contentHash: observed.contentHash };
        },
        async submitExpectingRejection(entry, label) {
          return (await submitAssetEntry(entry, label, "nullifierAlreadySpent")).outcome;
        },
      }));
    const pendingEntries: Array<{ contentHash: string; transactionHex: string }> = [];
    for (const actor of [actors.S, actors.M]) {
      await withSeedRuntimeProgress(`Pending lane: sync actor ${actor.name}`, () => actor.wallet.sync());
      const snapshot = await actor.wallet.snapshot();
      const amount = snapshot.balances.find((balance) => balance.assetId === 0n)?.spendable ?? 0n;
      const payment = nonzeroSeedQuotient(amount, 16n);
      if (payment !== null) {
        actor.submitter.planPending(`pending-${actor.name.toLowerCase()}-transfer`);
        const pending = await withSeedRuntimeProgress(`Pending lane: prove actor ${actor.name} transfer`, () =>
          actor.wallet.send({ to: actor === actors.S ? actors.M.address : actors.R.address, amount: payment, openFeeAmount: 1n }));
        pendingEntries.push({ contentHash: pending.contentHash, transactionHex: pending.transactionHex });
      }
    }


    const conflictSubmitter = new PlannedWalletSubmission(gate, node);
    const conflictWallet = await openNodeWallet({
      dataDir: join(params.root, "wallet-conflict-m"),
      node,
      profile: actors.M.profile,
      signer: privateKeyPcashActionSigner(fromHex(actors.M.privateKey)),
      provers: createWalletProvers("native"),
      submission: conflictSubmitter,
      userAccountCreationSubmission: conflictSubmitter,
      settlePollMaxAttempts: 1,
    });
    let pendingConflicts: Array<{ contentHash: string; conflicts: bigint; conflictKeys: string[] }> = [];
    try {
      await Promise.all([
        withSeedRuntimeProgress("Pending conflict lane: full M mirror rescan", () => conflictWallet.sync({ rescan: true })),
        withSeedRuntimeProgress("Pending conflict lane: sync primary M wallet", () => actors.M.wallet.sync()),
      ]);
      const [primaryNotes, competingNotes] = await Promise.all([
        actors.M.wallet.notes({ assetId: 0n, status: "spendable" }),
        conflictWallet.notes({ assetId: 0n, status: "spendable" }),
      ]);
      const selected = primaryNotes.map((note) => ({
        note,
        firstPayment: nonzeroSeedQuotient(note.amount, 3n),
        secondPayment: nonzeroSeedQuotient(note.amount, 4n),
      })).find(({ note, firstPayment, secondPayment }) => note.commitment !== null
        && firstPayment !== null
        && secondPayment !== null
        && competingNotes.some((candidate) => candidate.commitment?.toLowerCase() === note.commitment?.toLowerCase()));
      if (selected === undefined
        || selected.note.commitment === null
        || selected.firstPayment === null
        || selected.secondPayment === null) {
        throw new Error("M has no shared current-run note with two nonzero pending conflict payments");
      }
      const firstPayment = selected.firstPayment;
      const secondPayment = selected.secondPayment;
      // Both variants spend exactly the shared note, whatever else either inventory holds.
      const sharedNote = selected.note.commitment;
      actors.M.submitter.planPending("pending-m-conflict-a");
      conflictSubmitter.planPending("pending-m-conflict-b");
      const [first, second] = await Promise.all([
        withSeedRuntimeProgress("Pending conflict lane: prove M variant A", () =>
          actors.M.wallet.send({ to: actors.S.address, noteSelector: sharedNote, amount: firstPayment, openFeeAmount: 1n })),
        withSeedRuntimeProgress("Pending conflict lane: prove M variant B", () =>
          conflictWallet.send({ to: actors.R.address, noteSelector: sharedNote, amount: secondPayment, openFeeAmount: 1n })),
      ]);
      pendingEntries.push(
        { contentHash: first.contentHash, transactionHex: first.transactionHex },
        { contentHash: second.contentHash, transactionHex: second.transactionHex },
      );
      const items = await Promise.all([first.contentHash, second.contentHash].map((id) => node.getMempoolTransaction(id)));
      if (items.some((item) => item === null)) throw new Error("pending M conflict pair is absent from the mempool");
      const retained = items as [NonNullable<(typeof items)[number]>, NonNullable<(typeof items)[number]>];
      const sharedConflictKeys = retained[0].conflictKeys.filter((key) => retained[1].conflictKeys.includes(key));
      if (sharedConflictKeys.length === 0) throw new Error("pending M variants do not expose their shared input conflict key");
      pendingConflicts = retained.map((item, index) => {
        const expected = pendingEntries[pendingEntries.length - 2 + index]!;
        if (item.contentHash.toLowerCase() !== expected.contentHash.toLowerCase()
          || item.rawTransaction?.toLowerCase() !== expected.transactionHex.toLowerCase()
          || item.status !== "ready"
          || item.conflictCount !== 1n
          || !sharedConflictKeys.every((key) => item.conflictKeys.includes(key))) {
          throw new Error(`pending M conflict ${index + 1} does not retain the exact ready transaction and mutual conflict`);
        }
        return { contentHash: item.contentHash, conflicts: item.conflictCount, conflictKeys: sharedConflictKeys };
      });
    } finally {
      await conflictWallet.close();
    }
    await withSeedRuntimeProgress("Pending lanes: verify exact ready mempool entries", () => Promise.all(
      pendingEntries.map(async (expected) => {
        const item = await node.getMempoolTransaction(expected.contentHash);
        if (item === null
          || item.contentHash.toLowerCase() !== expected.contentHash.toLowerCase()
          || item.rawTransaction?.toLowerCase() !== expected.transactionHex.toLowerCase()
          || item.status !== "ready") {
          throw new Error(`pending seed transaction ${expected.contentHash} is not retained byte-exactly in ready state`);
        }
      }),
    ));
    const pendingContentHashes = pendingEntries.map((entry) => entry.contentHash);
    const contractAddresses = [marketplace.paidOffer.contractAddress, marketplace.unpaidOffer.contractAddress];
    const canonicalEntries = [...waves.flatMap((wave) => wave.carriers), ...volumeCarriers, ...assetCarriers].flatMap((carrier) =>
      carrier.entries.map((entry) => ({
        label: entry.label,
        contentHash: entry.contentHash,
        transactionId: entry.transactionId,
        expectedOutcome: entry.expectedOutcome,
        observedOutcome: entry.outcome,
        kind: entry.kind,
        settledOpenFeeAmount: entry.settledOpenFeeAmount,
        l1TransactionHash: carrier.l1TransactionHash,
        l1BlockHash: carrier.l1BlockHash,
        l1TransactionIndex: carrier.l1TransactionIndex,
        batchItemIndex: entry.batchItemIndex,
      })));
    const result: RichSeedResult = {
      version: 1,
      network: params.expectedNode,
      waves,
      canonicalEntries,
      assets,
      marketplace,
      pendingContentHashes,
      contractAddresses,
      actors: Object.fromEntries(SEED_ACTOR_ORDER.map((name) => [name, actors[name].address])) as Record<ActorName, string>,
      routerAddress: params.routerAddress,
      routerConfig: params.routerConfig,
      pendingConflicts,
      contracts: { marketplace: contractAddresses, verified: contractAddresses, unverified: [vault.address] },
      explorer: {
        relayerAddress,
        keylessAccountAddress: keyless.address,
        privateVaultAddress: vault.address,
        excludedCarriers,
        volumeTransferCount: volumeCarriers.reduce((total, carrier) => total + carrier.entries.length, 0),
      },
      pending: {
        contentHashes: pendingContentHashes,
        conflicts: pendingConflicts.map(({ contentHash, conflictKeys }) => ({ contentHash, conflictKeys })),
      },
      richness: {
        repeatedEarningIssuance,
        sellerChangeInputCount: sellerChangePreflight.inputCount,
        recipientMultiInputCount: recipientPreflight.inputCount,
      },
      finalPrivateBalances: Object.fromEntries(await Promise.all(SEED_ACTOR_ORDER.map(async (name) => {
        const balances = await actors[name].wallet.balances({ assetId: 0n });
        return [name, (balances[0]?.spendable ?? 0n).toString()] as const;
      }))) as Record<ActorName, string>,
    };
    assertRichSeedEvidence(result);
    await withSeedRuntimeProgress("Evidence: write final seed evidence", () =>
      writeJsonAtomic(join(params.root, "seed-evidence.json"), result));
    return result;
  } catch (error) {
    gate.fail(error);
    paidFundingBarrier.reject(error);
    await marketplaceTask?.catch(() => undefined);
    throw error;
  } finally {
    await Promise.allSettled([
      ...Object.values(actors).map((actor) => actor.wallet.close()),
      ...(sellerEarningWallet === undefined ? [] : [sellerEarningWallet.close()]),
    ]);
  }
}
