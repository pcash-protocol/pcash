// Eligibility drops, creator and claimant sides.
//
// A creator's drop is a stored seed plus terms. Its steps (publish the
// contract, fund the inventory, publish the catalog record) resume from
// chain, wallet, and catalog state. A claimant finds drops
// in the node catalog, rebuilds each from its terms, and claims one random
// unspent inventory note, trying another when it loses a note to a concurrent
// claim.

import { registeredSelfReceiveKey } from "@pcash/sdk/wallet/actions";
import {
  formatAssetDefinition,
  parseAssetDefinition,
  type AssetDefinition,
} from "@pcash/sdk/protocol";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { addressHex, bytes32Hex, randomFieldEntropy } from "@pcash/sdk/utils";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import {
  buildDropClaim,
  buildDropReclaim,
  dropClaimSpec,
  dropReclaimSpec,
  dropClaimMarker,
  dropTermsForCreator,
  eligibilityDrop,
  planDropInventory,
  type DropInventoryNote,
  type EligibilityDrop,
} from "../drop.ts";
import { sponsoredTemplatePrimary } from "../template.ts";
import { TOKENS_CIRCUITS } from "../circuits.ts";
import {
  dropPublication,
  fetchDropPublications,
  publishDropPublication,
  verifyDropPublication,
  type DropPublication,
  type VerifiedDropPublication,
} from "../catalog.ts";
import {
  checkDropEligibility,
  claimantAccount,
  dropInventory,
  readDropClaim,
  readDropEligibility,
  readTemplateWitness,
  unspentDropInventory,
} from "../witness.ts";
import {
  awaitIncluded,
  notify,
  planRole,
  proveAndSubmit,
  resumeTemplateAction,
  templateRole,
  submitSponsoredTemplate,
  usesSponsorship,
  walletRecipient,
  walletSender,
  type TemplateSubmission,
  type TokensActionCallbacks,
  type TokensProgressCallback,
} from "./action.ts";
import { TokensError } from "./errors.ts";
import { TOKENS_VALIDITY_WINDOW_SECONDS, type TokenClaimResult } from "./links.ts";
import {
  fundContractNotes,
  ownRecords,
  patchRecord,
  requireRecord,
  walletNkRoot,
  walletToken,
  withWallet,
  type TokensRuntime,
} from "./runtime.ts";
import { recoverTokenRecords } from "./recovery.ts";
import { dropRecoveryTag } from "./recoveryTag.ts";
import { dropKey, type DropRecord } from "./store.ts";

const S_INPUTS = PRIVATE_VALUE_PROFILES.S.inputs;
/** Fresh inventory notes one claim tries before reporting the drop exhausted. */
const CLAIM_ATTEMPTS = 4;

export type DropPhase = "creating-contract" | "funding" | "publishing" | "ready";

export interface DropView {
  key: string;
  assetId: bigint;
  definition: AssetDefinition;
  contractAddress: string;
  claimAmount: bigint;
  count: number;
  cutoffBlockNumber: bigint;
  claimEndTimestamp: bigint;
  phase: DropPhase;
  createdAt: number;
}

export interface DropStatus extends DropView {
  /** Present once funded. */
  claimed: number | null;
  remaining: number | null;
}

function recordDrop(record: DropRecord, nkRoot: bigint): EligibilityDrop {
  return eligibilityDrop(dropTermsForCreator({
    dropSeed: BigInt(record.dropSeed),
    assetId: BigInt(record.assetId),
    claimAmount: BigInt(record.claimAmount),
    cutoffBlockNumber: BigInt(record.cutoffBlockNumber),
    claimEndTimestamp: BigInt(record.claimEndTimestamp),
    creator: { address: BigInt(record.creator), nkRoot },
  }));
}

function dropView(record: DropRecord, drop: EligibilityDrop): DropView {
  return {
    key: record.key,
    assetId: BigInt(record.assetId),
    definition: parseAssetDefinition(record.definition),
    contractAddress: addressHex(drop.address),
    claimAmount: BigInt(record.claimAmount),
    count: record.count,
    cutoffBlockNumber: BigInt(record.cutoffBlockNumber),
    claimEndTimestamp: BigInt(record.claimEndTimestamp),
    phase: record.publicationContentId !== undefined ? "ready"
      : record.funding !== undefined ? "publishing"
        : record.fundingJobId !== undefined ? "funding" : "creating-contract",
    createdAt: record.createdAt,
  };
}

/**
 * Store a new drop, then run it to ready. Accounts that exist once block
 * `cutoffBlockNumber` (default: the latest block) is final may claim
 * `claimAmount` each until `claimEndTimestamp`, from `count` inventory notes.
 */
export async function createDrop<Prepared, Output>(rt: TokensRuntime<Prepared, Output>, params: {
  assetId: bigint;
  claimAmount: bigint;
  count: number;
  cutoffBlockNumber?: bigint;
  claimEndTimestamp: bigint;
  openFeeAmount?: bigint;
  onProgress?: TokensProgressCallback;
}): Promise<DropView> {
  if (!Number.isSafeInteger(params.count) || params.count < 1) throw new Error("a drop needs at least one inventory note");
  const definition = await walletToken(rt, params.assetId, params.claimAmount * BigInt(params.count));
  const status = await rt.node.status();
  if (params.claimEndTimestamp <= status.latestBlockTimestamp) throw new Error("the claim window must end after the latest block");
  const dropSeed = bytes32Hex(randomFieldEntropy());
  const key = dropKey(rt.wallet.network.chainId, rt.wallet.address, dropSeed);
  const now = rt.now();
  const record: DropRecord = {
    kind: "drop",
    key,
    chainId: rt.wallet.network.chainId.toString(),
    creator: rt.wallet.address,
    assetId: params.assetId.toString(),
    definition: formatAssetDefinition(definition),
    dropSeed,
    claimAmount: params.claimAmount.toString(),
    count: params.count,
    cutoffBlockNumber: (params.cutoffBlockNumber ?? status.latestBlock).toString(),
    claimEndTimestamp: params.claimEndTimestamp.toString(),
    ...(params.openFeeAmount === undefined ? {} : { openFeeAmount: params.openFeeAmount.toString() }),
    createdAt: now,
    updatedAt: now,
  };
  // Deriving the drop checks the terms before anything is stored.
  recordDrop(record, await walletNkRoot(rt));
  await rt.store.update(key, () => record);
  return advanceDrop(rt, key, params.onProgress);
}

/** Run a stored drop's remaining steps: publish the contract, fund the inventory, publish the catalog record. */
export async function advanceDrop<Prepared, Output>(
  rt: TokensRuntime<Prepared, Output>,
  key: string,
  onProgress?: TokensProgressCallback,
): Promise<DropView> {
  let record = await requireRecord<DropRecord>(rt, key, "drop");
  const drop = recordDrop(record, await walletNkRoot(rt));
  if (record.funding === undefined) {
    const openFeeAmount = record.openFeeAmount === undefined ? undefined : BigInt(record.openFeeAmount);
    const funding = await fundContractNotes(rt, key, {
      contract: drop,
      assetId: drop.configuration.assetId,
      notes: planDropInventory(drop, record.count),
      jobId: record.fundingJobId,
      recoveryTag: dropRecoveryTag({
        dropSeed: BigInt(record.dropSeed), claimAmount: BigInt(record.claimAmount), count: record.count,
        cutoffBlockNumber: BigInt(record.cutoffBlockNumber), claimEndTimestamp: BigInt(record.claimEndTimestamp),
      }),
      openFeeAmount,
    }, onProgress);
    record = await patchRecord<DropRecord>(rt, key, (current) => ({ ...current, funding }));
  }
  if (record.publicationContentId === undefined) {
    notify(onProgress, "publishing", "Publishing the drop to the node catalog…");
    let published;
    try {
      published = await publishDropPublication(rt.node, dropPublication(drop, {
        chainId: Number(rt.wallet.network.chainId),
        definition: parseAssetDefinition(record.definition),
        funding: record.funding!,
      }));
    } catch (cause) {
      throw new TokensError("catalog-unavailable", "The node's catalog did not accept the drop; retry publishing later.", { cause });
    }
    record = await patchRecord<DropRecord>(rt, key, (current) => ({ ...current, publicationContentId: published.artifact.contentId }));
  }
  return dropView(record, drop);
}

/** This wallet's drops on its chain, newest first. Reads the store only. */
export async function drops<Prepared, Output>(rt: TokensRuntime<Prepared, Output>): Promise<DropView[]> {
  await recoverTokenRecords(rt);
  const records = await ownRecords<DropRecord>(rt, "drop");
  if (records.length === 0) return [];
  const nkRoot = await walletNkRoot(rt);
  return records.map((record) => dropView(record, recordDrop(record, nkRoot)));
}

/** The creator's inventory at its current leaves. */
async function recordInventory(node: PcashNodeClient, record: DropRecord, drop: EligibilityDrop): Promise<DropInventoryNote[]> {
  if (record.funding === undefined) throw new TokensError("pending", "This drop is not funded yet.");
  const inventory = await dropInventory(node, drop, record.funding);
  if (inventory.length !== record.count) throw new TokensError("pending", "A funding transaction is not on chain right now; try again shortly.");
  return inventory;
}

/** How many inventory notes have been claimed, from the node's current nullifier set. */
export async function dropStatus<Prepared, Output>(rt: TokensRuntime<Prepared, Output>, key: string): Promise<DropStatus> {
  const record = await requireRecord<DropRecord>(rt, key, "drop");
  const drop = recordDrop(record, await walletNkRoot(rt));
  const view = dropView(record, drop);
  if (record.funding === undefined) return { ...view, claimed: null, remaining: null };
  const remaining = (await unspentDropInventory(rt.node, await recordInventory(rt.node, record, drop))).length;
  return { ...view, claimed: record.count - remaining, remaining };
}

export interface DropReclaimResult extends TemplateSubmission {
  /** Inventory notes this transaction returns to the creator. */
  reclaimed: number;
  /** Unspent notes left for another reclaim. */
  remaining: number;
}

/**
 * After the claim window, return up to four unspent inventory notes (fewer
 * when this wallet pays a relay fee) to the creator. Call again while
 * `remaining` is positive.
 */
export async function reclaimDrop<Prepared, Output>(rt: TokensRuntime<Prepared, Output>, key: string, options: {
  openFeeAmount?: bigint;
} & TokensActionCallbacks = {}): Promise<DropReclaimResult> {
  const record = await requireRecord<DropRecord>(rt, key, "drop");
  const definition = parseAssetDefinition(record.definition);
  const sponsored = await withWallet(rt, "reclaim-drop-retry", options, async (run) => {
    if (!usesSponsorship(run, options.openFeeAmount)) return null;
    const drop = recordDrop(record, run.ctx.profile.nkRoot);
    const inventory = await recordInventory(run.ctx.node, record, drop);
    const resumed = await resumeTemplateAction(run, inventory.map((note) => note.nullifier));
    if (resumed !== null) {
      const submission = await awaitIncluded(run, resumed.submission);
      const inFlight = new Set(resumed.nullifiers);
      const remaining = (await unspentDropInventory(run.ctx.node, inventory)).filter((note) => !inFlight.has(note.nullifier));
      return { result: { ...submission, reclaimed: inventory.filter((note) => inFlight.has(note.nullifier)).length, remaining: remaining.length } };
    }
    const status = await run.ctx.node.status();
    if (status.latestBlockTimestamp < drop.configuration.claimEndTimestamp) throw new TokensError("drop-open", "The claim window is still open; reclaim after it closes.");
    const unspent = await unspentDropInventory(run.ctx.node, inventory);
    if (unspent.length === 0) throw new TokensError("nothing-to-reclaim", "Every inventory note has been claimed.");
    const plan = await planRole(run, { freeInputs: S_INPUTS - 1, openFeeAmount: options.openFeeAmount });
    const batch = unspent.slice(0, S_INPUTS - plan.feeNotes.length);
    return { drop, batch, remaining: unspent.length - batch.length, creator: {
      address: run.ctx.profile.address, nkRoot: run.ctx.profile.nkRoot,
    } };
  });
  if (sponsored !== null) {
    if ("result" in sponsored && sponsored.result !== undefined) return sponsored.result;
    const { drop, batch, remaining, creator } = sponsored;
    const submission = await submitSponsoredTemplate(rt, {
      contract: drop.address,
      reservedInputSlots: batch.map((_, slot) => slot),
      reservedOutputSlots: [0],
      snapshotQuery: {
        outputs: batch.map((note) => ({ outputIndex: BigInt(note.leafIndex), outputCommitment: note.outputCommitment })),
        nullifiers: batch.map((note) => bytes32Hex(note.nullifier)),
      },
      primary: (context) => {
        if (context.status.latestBlockTimestamp < drop.configuration.claimEndTimestamp) throw new TokensError("drop-open", "The claim window is still open; reclaim after it closes.");
        if (context.snapshot.outputs === null || context.snapshot.nullifiers.statuses.some((status) => status.spent)) {
          throw new TokensError("drop-exhausted", "One of these inventory notes was claimed before the reclaim.");
        }
        const spec = dropReclaimSpec({
          drop,
          pcashChainId: rt.wallet.network.chainId,
          snapshot: context.roots,
          contractOpening: { accountIndex: Number(context.contractAccount.account.index), accountSiblings: context.contractAccount.accountSiblings },
          inventory: batch.map((note, position) => ({ index: note.index, leafIndex: note.leafIndex, siblings: context.outputPaths[position]!.siblings })),
          creator: { ...creator, receiveKey: context.selfReceiveKey() },
          role: { kind: "transfer" },
          validUntilTimestamp: context.status.latestBlockTimestamp + TOKENS_VALIDITY_WINDOW_SECONDS,
          assetDefinition: definition,
        });
        return sponsoredTemplatePrimary(spec, { circuitUrl: TOKENS_CIRCUITS.dropReclaim, label: "drop reclaim function" }, [0]);
      },
      prover: rt.prover,
      openFeeAmount: options.openFeeAmount,
      notBeforeTimestamp: drop.configuration.claimEndTimestamp,
    }, options);
    return { ...submission, reclaimed: batch.length, remaining };
  }
  return withWallet(rt, "reclaim-drop", options, async (run) => {
    const { ctx } = run;
    const drop = recordDrop(record, ctx.profile.nkRoot);
    const inventory = await recordInventory(ctx.node, record, drop);
    const resumed = await resumeTemplateAction(run, inventory.map((note) => note.nullifier));
    if (resumed !== null) {
      const submitted = await awaitIncluded(run, resumed.submission);
      const inFlight = new Set(resumed.nullifiers);
      const reclaimed = inventory.filter((note) => inFlight.has(note.nullifier));
      const remaining = (await unspentDropInventory(ctx.node, inventory)).filter((note) => !inFlight.has(note.nullifier));
      return { ...submitted, reclaimed: reclaimed.length, remaining: remaining.length };
    }
    const status = await ctx.node.status();
    if (status.latestBlockTimestamp < drop.configuration.claimEndTimestamp) {
      throw new TokensError("drop-open", "The claim window is still open; reclaim after it closes.");
    }
    notify(run.onProgress, "preparing", "Finding unclaimed inventory…");
    const unspent = await unspentDropInventory(ctx.node, inventory);
    if (unspent.length === 0) throw new TokensError("nothing-to-reclaim", "Every inventory note has been claimed.");
    const plan = await planRole(run, { freeInputs: S_INPUTS - 1, ...(options.openFeeAmount === undefined ? {} : { openFeeAmount: options.openFeeAmount }) });
    const batch = unspent.slice(0, S_INPUTS - plan.feeNotes.length);
    const witness = await readTemplateWitness(ctx.node, {
      contract: drop.address,
      notes: batch.map((note) => ({ leafIndex: note.leafIndex, outputCommitment: note.outputCommitment })),
      nullifiers: [],
    });
    if (witness === null) throw new Error("a funded inventory note is missing from the output tree");
    const recipient = await walletRecipient(ctx, BigInt(witness.snapshot.accountStateRoot));
    const action = buildDropReclaim({
      drop,
      pcashChainId: ctx.network.chainId,
      snapshot: witness.snapshot,
      contractOpening: witness.contractOpening,
      inventory: batch.map((note, position) => ({ index: note.index, leafIndex: note.leafIndex, siblings: witness.notes[position]!.siblings })),
      creator: { address: recipient.address, nkRoot: ctx.profile.nkRoot, receiveKey: recipient.receiveKey },
      role: templateRole(run, plan),
      validUntilTimestamp: status.latestBlockTimestamp + TOKENS_VALIDITY_WINDOW_SECONDS,
      assetDefinition: definition,
      ...walletSender(ctx),
    });
    const submitted = await awaitIncluded(run, await proveAndSubmit(run, action, { ownedSlots: [0] }));
    return { ...submitted, reclaimed: batch.length, remaining: unspent.length - batch.length };
  });
}

/** A catalog drop, rebuilt from its terms. `id` is its contract address. */
export interface AvailableDrop extends VerifiedDropPublication {
  id: string;
  assetId: bigint;
  publication: DropPublication;
}

/**
 * Every drop the node's catalog lists for this chain, newest first. Records
 * that do not rebuild are skipped; a drop listed twice keeps its newest record.
 */
export async function availableDrops<Prepared, Output>(rt: TokensRuntime<Prepared, Output>): Promise<AvailableDrop[]> {
  return availableDropsFromNode(rt.node);
}

/** Read verified drop publications before the visitor connects a wallet. */
export async function availableDropsFromNode(node: PcashNodeClient): Promise<AvailableDrop[]> {
  let publications: DropPublication[];
  try {
    publications = await fetchDropPublications(node);
  } catch (cause) {
    throw new TokensError("catalog-unavailable", "This node does not list drops.", { cause });
  }
  const chainId = BigInt((await node.status()).pcashChainId);
  const found = new Map<string, AvailableDrop>();
  for (const publication of publications) {
    let verified: VerifiedDropPublication;
    try {
      verified = verifyDropPublication(publication, { chainId });
    } catch {
      continue;
    }
    const id = addressHex(verified.drop.address);
    if (!found.has(id)) found.set(id, { ...verified, id, assetId: verified.drop.configuration.assetId, publication });
  }
  return [...found.values()];
}

export type DropEligibilityStatus =
  | "eligible"
  | "claimed"
  | "ineligible"
  | "not-started"
  | "no-account"
  | "ended"
  | "exhausted";

export interface DropEligibilityResult {
  status: DropEligibilityStatus;
  /** One sentence a page can show as is. */
  message: string;
}

function eligibilityResult(drop: AvailableDrop, status: DropEligibilityStatus): DropEligibilityResult {
  const symbol = drop.definition.metadata.symbol;
  const messages: Record<DropEligibilityStatus, string> = {
    eligible: `This account can claim ${symbol} from this drop.`,
    claimed: "This account has already claimed this drop.",
    ineligible: `Only accounts created by block ${drop.drop.configuration.cutoffBlockNumber} can claim, and this one was created later.`,
    "not-started": `Claims open once block ${drop.drop.configuration.cutoffBlockNumber} is on chain.`,
    "no-account": "This address has no PCASH account yet, so it cannot claim.",
    ended: "The claim window for this drop has closed.",
    exhausted: "Every token in this drop has been claimed.",
  };
  return { status, message: messages[status] };
}

function dropRefusal(drop: AvailableDrop, status: Exclude<DropEligibilityStatus, "eligible">): TokensError {
  const codes = {
    claimed: "drop-claimed",
    ineligible: "drop-ineligible",
    "not-started": "drop-not-started",
    "no-account": "drop-no-account",
    ended: "drop-ended",
    exhausted: "drop-exhausted",
  } as const;
  return new TokensError(codes[status], eligibilityResult(drop, status).message);
}

/**
 * Whether an account can claim a drop. With no `address`, checks this wallet,
 * including whether it has already claimed.
 */
export async function dropEligibility<Prepared, Output>(
  rt: TokensRuntime<Prepared, Output>,
  drop: AvailableDrop,
  address?: string,
): Promise<DropEligibilityResult> {
  if (address !== undefined) return dropEligibilityFromNode(rt.node, drop, address);
  const status = await rt.node.status();
  if (status.latestBlockTimestamp >= drop.drop.configuration.claimEndTimestamp) return eligibilityResult(drop, "ended");
  const nkRoot = await walletNkRoot(rt);
  const { statuses } = await rt.node.getCurrentNullifierStatuses([bytes32Hex(dropClaimMarker(drop.drop, { address: rt.wallet.address, nkRoot }))]);
  if (statuses[0]!.spent) return eligibilityResult(drop, "claimed");
  return dropEligibilityFromNode(rt.node, drop, rt.wallet.address);
}

/** Check public eligibility for an address without loading wallet secrets. */
export async function dropEligibilityFromNode(node: PcashNodeClient, drop: AvailableDrop, address: string): Promise<DropEligibilityResult> {
  const status = await node.status();
  if (status.latestBlockTimestamp >= drop.drop.configuration.claimEndTimestamp) return eligibilityResult(drop, "ended");
  const eligibility = await checkDropEligibility(node, drop.drop, BigInt(address));
  const mapped: Record<typeof eligibility.status, DropEligibilityStatus> = {
    eligible: "eligible",
    ineligible: "ineligible",
    notStarted: "not-started",
    noAccount: "no-account",
  };
  if (mapped[eligibility.status] !== "eligible") return eligibilityResult(drop, mapped[eligibility.status]);
  if ((await unspentDropInventory(node, await dropInventory(node, drop.drop, drop.funding))).length === 0) return eligibilityResult(drop, "exhausted");
  return eligibilityResult(drop, "eligible");
}

const CLAIM_REFUSALS = {
  claimed: "claimed",
  ineligible: "ineligible",
  notStarted: "not-started",
  noAccount: "no-account",
  exhausted: "exhausted",
} as const;

/**
 * Claim a drop into this wallet. The claimed note opens under this wallet's
 * own owner-change secret, so only this account can receive it. A claim this
 * wallet already journaled is resubmitted byte for byte.
 */
export async function claimDrop<Prepared, Output>(rt: TokensRuntime<Prepared, Output>, drop: AvailableDrop, options: {
  openFeeAmount?: bigint;
} & TokensActionCallbacks = {}): Promise<TokenClaimResult> {
  const sponsored = await withWallet(rt, "claim-drop-retry", options, async (run) => {
    if (!usesSponsorship(run, options.openFeeAmount)) return null;
    const claimant = { address: run.ctx.profile.address, nkRoot: run.ctx.profile.nkRoot };
    const marker = dropClaimMarker(drop.drop, claimant);
    const resumed = await resumeTemplateAction(run, [marker]);
    if (resumed !== null) return { resumed: await awaitIncluded(run, resumed.submission) };
    return { claimant, marker, resumed: null };
  });
  if (sponsored !== null) {
    let submission = sponsored.resumed;
    if (sponsored.resumed === null) {
      const { claimant, marker } = sponsored;
      const inventory = await dropInventory(rt.node, drop.drop, drop.funding);
      const exclude = new Set<number>();
      for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
        const state = await readDropClaim(rt.node, { drop: drop.drop, inventory, claimant, exclude });
        if (state.status !== "claimable") throw dropRefusal(drop, CLAIM_REFUSALS[state.status]);
        try {
          submission = await submitSponsoredTemplate(rt, {
            contract: drop.drop.address,
            reservedInputSlots: [0, 1],
            reservedOutputSlots: [0],
            snapshotQuery: {
              accounts: [addressHex(claimant.address)],
              outputs: [{ outputIndex: BigInt(state.inventory.leafIndex), outputCommitment: state.inventory.outputCommitment }],
              nullifiers: [bytes32Hex(marker), bytes32Hex(state.inventory.nullifier)],
            },
            primary: async (context) => {
              if (context.status.latestBlockTimestamp >= drop.drop.configuration.claimEndTimestamp) throw dropRefusal(drop, "ended");
              if (context.snapshot.nullifiers.statuses[0]?.spent) throw dropRefusal(drop, "claimed");
              if (context.snapshot.outputs === null || context.snapshot.nullifiers.statuses[1]?.spent) throw dropRefusal(drop, "exhausted");
              const account = context.snapshot.accounts[1];
              if (account?.status !== "present") throw dropRefusal(drop, "no-account");
              const eligibility = await readDropEligibility(rt.node, drop.drop, {
                hash: BigInt(context.roots.recentPcashBlockHash),
                number: context.contractAccount.boundary.header.number,
              });
              if (eligibility === null) throw dropRefusal(drop, "not-started");
              if (account.account.index >= eligibility.cutoffAccountCount) throw dropRefusal(drop, "ineligible");
              const spec = dropClaimSpec({
                drop: drop.drop,
                pcashChainId: rt.wallet.network.chainId,
                snapshot: context.roots,
                contractOpening: { accountIndex: Number(context.contractAccount.account.index), accountSiblings: context.contractAccount.accountSiblings },
                inventory: { index: state.inventory.index, leafIndex: state.inventory.leafIndex, siblings: context.outputPaths[0]!.siblings },
                claimant: { ...claimant, receiveKey: context.selfReceiveKey(), account: claimantAccount(account) },
                eligibility,
                role: { kind: "transfer" },
                validUntilTimestamp: drop.drop.configuration.claimEndTimestamp,
                assetDefinition: drop.definition,
              });
              return sponsoredTemplatePrimary(spec, { circuitUrl: TOKENS_CIRCUITS.dropClaim, label: "drop claim function" }, [0]);
            },
            prover: rt.prover,
            openFeeAmount: options.openFeeAmount,
            validUntilTimestamp: drop.drop.configuration.claimEndTimestamp,
            validUntilMode: "ceiling",
          }, options);
          break;
        } catch (error) {
          const { statuses } = await rt.node.getCurrentNullifierStatuses([bytes32Hex(marker), bytes32Hex(state.inventory.nullifier)]);
          if (statuses[0]!.spent) throw dropRefusal(drop, "claimed");
          if (!statuses[1]!.spent) throw error;
          exclude.add(state.inventory.leafIndex);
        }
      }
      if (submission === null) throw dropRefusal(drop, "exhausted");
    }
    await rt.wallet.importAssetDefinition(drop.definition);
    return { ...submission!, assetId: drop.assetId, definition: drop.definition,
      amount: drop.drop.configuration.claimAmount, recipient: rt.wallet.address };
  }
  const submission = await withWallet(rt, "claim-drop", options, async (run) => {
    const { ctx } = run;
    const marker = dropClaimMarker(drop.drop, ctx.profile);
    const resumed = await resumeTemplateAction(run, [marker]);
    if (resumed !== null) return awaitIncluded(run, resumed.submission);
    const status = await ctx.node.status();
    const claimEnd = drop.drop.configuration.claimEndTimestamp;
    if (status.latestBlockTimestamp >= claimEnd) throw dropRefusal(drop, "ended");
    notify(run.onProgress, "preparing", "Checking eligibility…");
    const plan = await planRole(run, { freeInputs: S_INPUTS - 2, ...(options.openFeeAmount === undefined ? {} : { openFeeAmount: options.openFeeAmount }) });
    const inventory = await dropInventory(ctx.node, drop.drop, drop.funding);
    const exclude = new Set<number>();
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
      const state = await readDropClaim(ctx.node, {
        drop: drop.drop,
        inventory,
        claimant: { address: ctx.profile.address, nkRoot: ctx.profile.nkRoot },
        exclude,
      });
      if (state.status !== "claimable") throw dropRefusal(drop, CLAIM_REFUSALS[state.status]);
      const latest = (await ctx.node.status()).latestBlockTimestamp;
      const action = buildDropClaim({
        drop: drop.drop,
        pcashChainId: ctx.network.chainId,
        snapshot: state.witness.snapshot,
        contractOpening: state.witness.contractOpening,
        inventory: { index: state.inventory.index, leafIndex: state.inventory.leafIndex, siblings: state.witness.notes[0]!.siblings },
        claimant: { address: ctx.profile.address, nkRoot: ctx.profile.nkRoot, receiveKey: registeredSelfReceiveKey(state.claimantAccount, await ctx.store.load()), account: state.claimant },
        eligibility: state.eligibility,
        role: templateRole(run, plan),
        validUntilTimestamp: latest + TOKENS_VALIDITY_WINDOW_SECONDS < claimEnd ? latest + TOKENS_VALIDITY_WINDOW_SECONDS : claimEnd,
        assetDefinition: drop.definition,
        ...walletSender(ctx),
      });
      try {
        return await awaitIncluded(run, await proveAndSubmit(run, action, { ownedSlots: [0] }));
      } catch (error) {
        const { statuses } = await ctx.node.getCurrentNullifierStatuses([bytes32Hex(marker), bytes32Hex(state.inventory.nullifier)]);
        if (statuses[0]!.spent) throw dropRefusal(drop, "claimed");
        // Another claimant took this note first: try another.
        if (!statuses[1]!.spent) throw error;
        exclude.add(state.inventory.leafIndex);
      }
    }
    throw dropRefusal(drop, "exhausted");
  });
  await rt.wallet.importAssetDefinition(drop.definition);
  return {
    ...submission,
    assetId: drop.assetId,
    definition: drop.definition,
    amount: drop.drop.configuration.claimAmount,
    recipient: rt.wallet.address,
  };
}
