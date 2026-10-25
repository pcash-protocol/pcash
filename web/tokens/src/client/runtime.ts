// Shared plumbing for the token flows: wallet-bound execution, creator record
// updates, and the two creator steps every template contract needs, publishing
// the contract and funding its notes.

import { walletAction, type DurableSubmissionAdapter, type Wallet } from "@pcash/sdk/wallet";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { awaitAcceptedReceipt, pollReceipt, type PcashNodeClient } from "@pcash/sdk/clients";
import type { FundingChunk } from "../witness.ts";
import type { AssetProver } from "@pcash/sdk/browser-prover/requests";
import { addressHex, sameHex, sleep } from "@pcash/sdk/utils";
import { notify, walletProgress, type TemplateRun, type TokensActionCallbacks, type TokensProgressCallback } from "./action.ts";
import { TokensError } from "./errors.ts";
import type { TokensRecord, TokensStore } from "./store.ts";

export interface TokensRuntime<Prepared = unknown, Output = unknown> {
  wallet: Wallet<Prepared, Output>;
  /** The wallet's node, for reads that need no wallet authority. */
  node: PcashNodeClient;
  prover: AssetProver;
  store: TokensStore;
  submission?: DurableSubmissionAdapter<Prepared, Output>;
  pollIntervalMs: number;
  pollMaxAttempts: number;
  now(): number;
}

/** Run `body` with this wallet's authority as one template run. */
export function withWallet<T, Prepared, Output>(
  rt: TokensRuntime<Prepared, Output>,
  name: string,
  { onProgress, onPrepared }: TokensActionCallbacks,
  body: (run: TemplateRun<Prepared, Output>) => Promise<T>,
): Promise<T> {
  return rt.wallet.execute(walletAction<T, Prepared, Output>(`tokens:${name}`, async (ctx) => {
    const submission = rt.submission ?? ctx.submission;
    if (submission === undefined) throw new TokensError("wallet-not-ready", "This wallet has no way to publish transactions.");
    return body({ ctx, prover: rt.prover, submission, pollIntervalMs: rt.pollIntervalMs,
      pollMaxAttempts: rt.pollMaxAttempts, ...(onProgress === undefined ? {} : { onProgress }),
      ...(onPrepared === undefined ? {} : { onPrepared }) });
  }));
}

/** The wallet's nullifier key root, which creator secrets derive from. */
export function walletNkRoot<Prepared, Output>(rt: TokensRuntime<Prepared, Output>): Promise<bigint> {
  return withWallet(rt, "profile", {}, async (run) => run.ctx.profile.nkRoot);
}

export async function requireRecord<R extends TokensRecord>(
  rt: TokensRuntime<unknown, unknown>,
  key: string,
  kind: R["kind"],
): Promise<R> {
  const record = await rt.store.get(key);
  if (record === null || record.kind !== kind) throw new TokensError("unknown-record", `No ${kind === "links" ? "link set" : "drop"} ${key} is stored.`);
  if (BigInt(record.chainId) !== rt.wallet.network.chainId || !sameHex(record.creator, rt.wallet.address)) {
    throw new TokensError("unknown-record", `${key} belongs to another wallet or chain.`);
  }
  return record as R;
}

/** This wallet's records of one kind on its chain, newest first. */
export async function ownRecords<R extends TokensRecord>(rt: TokensRuntime<unknown, unknown>, kind: R["kind"]): Promise<R[]> {
  return (await rt.store.list())
    .filter((record): record is R =>
      record.kind === kind
      && BigInt(record.chainId) === rt.wallet.network.chainId
      && sameHex(record.creator, rt.wallet.address))
    .sort((left, right) => right.createdAt - left.createdAt);
}

export async function patchRecord<R extends TokensRecord>(
  rt: TokensRuntime<unknown, unknown>,
  key: string,
  change: (record: R) => R,
): Promise<R> {
  const next = await rt.store.update(key, (current) => {
    if (current === null) throw new TokensError("unknown-record", `No record ${key} is stored.`);
    return { ...change(current as R), updatedAt: rt.now() };
  });
  return next as R;
}

/** The wallet's verified definition and spendable balance of an asset. */
export async function walletToken(rt: TokensRuntime<unknown, unknown>, assetId: bigint, need: bigint) {
  const asset = (await rt.wallet.assets()).find((candidate) => candidate.assetId === assetId);
  if (asset === undefined || asset.definition === null) {
    throw new TokensError("unknown-asset", "This wallet does not hold a verified definition for the token.");
  }
  if (asset.spendable < need) {
    throw new TokensError("insufficient-funds", `This needs ${need} base units of the token; the wallet can spend ${asset.spendable}.`);
  }
  return asset.definition;
}

/** Publish a template contract once; the wallet's journal resumes an interrupted creation. */
export async function ensureContract<Prepared, Output>(
  rt: TokensRuntime<Prepared, Output>,
  key: string,
  contract: { body: Uint8Array; address: bigint },
  openFeeAmount: bigint | undefined,
  onProgress: TokensProgressCallback | undefined,
): Promise<void> {
  if ((await rt.node.getAccountProof(addressHex(contract.address))).status === "present") return;
  notify(onProgress, "creating-contract", "Publishing the claim contract…");
  const created = await rt.wallet.sponsorContractCreation({
    contract,
    ...(openFeeAmount === undefined ? {} : { openFeeAmount }),
    ...(rt.submission === undefined ? {} : { submission: rt.submission }),
    ...walletProgress(onProgress, "creating-contract"),
  });
  if (!created.accepted) {
    await awaitAcceptedReceipt(rt.node, created.contentHash, { pollIntervalMs: rt.pollIntervalMs, pollMaxAttempts: rt.pollMaxAttempts });
  }
}

/**
 * Fund a contract's notes through one wallet bulk job of S chunks and return
 * its chunks in note order once every one is accepted. Each chunk is proved as
 * soon as the previous one's change is synced; nothing waits for finality. A
 * job the record lost is found again by its recipients, all of which are this
 * contract.
 */
export async function fundContractNotes<Prepared, Output>(
  rt: TokensRuntime<Prepared, Output>,
  key: string,
  params: {
    contract: bigint;
    assetId: bigint;
    notes: readonly { noteSecret: bigint; amount: bigint }[];
    jobId: string | undefined;
    recoveryTag: Uint8Array;
    openFeeAmount: bigint | undefined;
  },
  onProgress: TokensProgressCallback | undefined,
): Promise<FundingChunk[]> {
  const to = addressHex(params.contract);
  let jobId = params.jobId ?? (await rt.wallet.bulkJobs()).find((job) =>
    job.assetId === params.assetId
    && job.recipients.length === params.notes.length
    && job.recipients.every((recipient) => recipient.to === to))?.jobId;
  if (jobId === undefined) {
    const job = await rt.wallet.startBulkJob({
      kind: "payment",
      assetId: params.assetId,
      recipients: params.notes.map((note) => ({ to, amount: note.amount, noteSecret: note.noteSecret })),
      maxTransactions: params.notes.length,
      shape: PRIVATE_VALUE_PROFILES.S.shapeId,
      recovery: { appTag: params.recoveryTag },
      ...(params.openFeeAmount === undefined ? {} : { openFeeAmount: params.openFeeAmount }),
    });
    jobId = job.jobId;
  }
  if (params.jobId === undefined) await patchRecord(rt, key, (record) => ({ ...record, fundingJobId: jobId }));

  const accepted = new Set<string>();
  // Chunks this call submitted; one still landing is waited on, not sent again.
  const sent = new Set<string>();
  for (let round = 0; ; round++) {
    const job = (await rt.wallet.bulkJobs()).find((candidate) => candidate.jobId === jobId)!;
    // Resubmit the first saved chunk the chain has not accepted, byte for byte; otherwise prove the next one.
    let chunkIndex = job.chunks.length;
    let landing = false;
    for (const [index, chunk] of job.chunks.entries()) {
      const contentHash = chunk.contentHash.toLowerCase();
      if (chunk.outcome === "succeeded" || accepted.has(contentHash)) continue;
      if ((await pollReceipt(rt.node, contentHash))?.outcome === "succeeded") {
        accepted.add(contentHash);
        continue;
      }
      if (sent.has(contentHash)) {
        landing = true;
        continue;
      }
      chunkIndex = index;
      break;
    }
    const assigned = job.chunks.reduce((sum, chunk) => sum + chunk.recipientCount, 0);
    const allSubmitted = chunkIndex === job.chunks.length && assigned === params.notes.length;
    if (allSubmitted && !landing) {
      return job.chunks.map((chunk) => {
        const indexes = job.recovery?.originalIndexes.slice(chunk.firstRecipient, chunk.firstRecipient + chunk.recipientCount)
          ?? Array.from({ length: chunk.recipientCount }, (_, offset) => chunk.firstRecipient + offset);
        if (indexes.some((index, offset) => index !== indexes[0]! + offset)) throw new Error("token funding chunk indexes are not contiguous");
        return { contentHash: chunk.contentHash.toLowerCase(), firstIndex: indexes[0]!, count: chunk.recipientCount };
      });
    }
    if (round >= rt.pollMaxAttempts) {
      throw new TokensError("pending", "Funding is still in progress; resume it shortly.");
    }
    if (allSubmitted) {
      notify(onProgress, "confirming", "Waiting for the funding transaction to reach the chain…");
      await sleep(rt.pollIntervalMs);
      continue;
    }
    notify(onProgress, "funding", "Funding the contract's notes…");
    const step = await rt.wallet.runBulkJobStep({
      jobId,
      chunkIndex,
      ...(rt.submission === undefined ? {} : { submission: rt.submission }),
      ...walletProgress(onProgress, "funding"),
    });
    if (step.state === "needs-review" || step.state === "limit-reached") {
      throw new TokensError("funding-needs-review", "A funding transaction expired or conflicted; review the wallet's bulk job.");
    }
    if (step.state === "submitted") sent.add(step.result.contentHash.toLowerCase());
    // The next chunk spends this one's change, which the wallet sees after a scan.
    await rt.wallet.sync();
    if (step.state === "waiting-for-funding" || (step.state === "submitted" && !step.result.accepted)) {
      notify(onProgress, "confirming", "Waiting for the funding transaction to reach the chain…");
      await sleep(rt.pollIntervalMs);
    }
  }
}
