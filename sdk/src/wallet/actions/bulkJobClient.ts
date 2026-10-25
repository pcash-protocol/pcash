import { privateValueProfile, PRIVATE_VALUE_PROFILES, type PrivateValueShape } from "@pcash/sdk/constants";
import { buildAssetAction, openedAssetActionOutput, outOfBandAssetActionOutput, ownerChangeAssetActionOutput, type AssetActionInput, type AssetActionOutput } from "@pcash/sdk/builders";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { resolveRecipientAddress, resolveRecipientDelivery, parseExtendedCode, looksLikeExtendedCode } from "@pcash/sdk/delivery";
import { requestPcashAuthorization, type PcashActionSigner, type SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
import { networkConfigFromStatus, ownerCommitment } from "@pcash/sdk/protocol";
import { addressHex, fromHex, randomFieldEntropy, toHex } from "@pcash/sdk/utils";
import {
  BULK_RECOVERY_OBSERVATION_SECONDS,
  bulkRecoveryManifestDigest,
  bulkRecoveryRecord,
  createBulkJob,
  freshBulkJobRecovery,
  planNextBulkChunk,
  recoveredBulkGroups,
  type BulkJob,
  type RecoveredBulkGroup,
} from "../bulkJobs.ts";
import type { PcashProfile } from "../externalIdentity.ts";
import { knownAssetDefinition, spendableNotes } from "../noteStore.ts";
import { withWalletReservation } from "../reservations.ts";
import type { WalletStateStore } from "../store.ts";
import { collectAssetActionWitnesses, prepareAssetAction, submitPendingAssetAction, submitPreparedAssetAction, type AssetActionProver, type AssetActionSubmissionResult } from "./assetActionClient.ts";
import { loadAndReconcileNoteWallet } from "./noteFundedClient.ts";
import type { DurableSubmissionAdapter, DurableSubmissionCallbacks } from "./durableSubmission.ts";
import { fixPublication, ownIssuance, paddedPrivateValueByteSize, planPublication, publicationOf, publicationValidUntil, transactionNullifiers } from "./publication.ts";
import { assertWalletStoreMatches } from "./walletSession.ts";
import { localReceiveKeyLookup } from "./localChain.ts";
import { assertReceiveKeyOwned, registeredSelfReceiveKey } from "./selfDelivery.ts";

/**
 * Validate the entire approved recipient list before any proof or submission.
 * The per-transaction fee is fixed here as the job's approval: an absent fee
 * resolves once per shape through the default relayed publication.
 */
export interface BulkJobRecoveryIntent {
  appTag: Uint8Array;
  /** Explicitly selected storage-loss recovery. */
  resumeRecoveryJobId?: string;
  /** Exact local job whose terminal and unallocated positions this job replaces. */
  continueLocalJobId?: string;
}

function repairableLocalRecipients(job: BulkJob, canonicalPaid: ReadonlySet<number>) {
  if (job.recovery === undefined) throw new Error("local bulk continuation requires recovery metadata");
  const repairable: Array<{ recipient: BulkJob["recipients"][number]; originalIndex: number }> = [];
  for (const chunk of job.chunks) {
    const positions = Array.from({ length: chunk.recipientCount }, (_, offset) => chunk.firstRecipient + offset);
    const original = positions.map(index => job.recovery!.originalIndexes[index]!);
    if (chunk.outcome === "unresolved" && original.some(index => !canonicalPaid.has(index))) {
      throw new Error("local bulk continuation has an unresolved noncanonical chunk");
    }
    if (chunk.outcome === "succeeded" && original.some(index => !canonicalPaid.has(index))) {
      throw new Error("local bulk continuation lost a succeeded canonical chunk");
    }
    if (chunk.outcome !== "expired" && chunk.outcome !== "conflicted") continue;
    positions.forEach((position, offset) => {
      if (!canonicalPaid.has(original[offset]!)) repairable.push({ recipient: job.recipients[position]!, originalIndex: original[offset]! });
    });
  }
  const assigned = job.chunks.reduce((sum, chunk) => sum + chunk.recipientCount, 0);
  for (let position = assigned; position < job.recipients.length; position++) {
    const originalIndex = job.recovery.originalIndexes[position]!;
    if (!canonicalPaid.has(originalIndex)) repairable.push({ recipient: job.recipients[position]!, originalIndex });
  }
  return repairable;
}

export async function startBulkJob(params: Omit<Parameters<typeof createBulkJob>[0], "openFeeAmount" | "recovery"> & {
  openFeeAmount?: bigint;
  recovery?: BulkJobRecoveryIntent;
  node: PcashNodeClient;
  store: WalletStateStore;
  wallet: PcashProfile;
  chainId: bigint;
}): Promise<BulkJob> {
  const recovery = params.recovery === undefined ? undefined : {
    appTag: Uint8Array.from(params.recovery.appTag),
    ...(params.recovery.resumeRecoveryJobId === undefined ? {} : { resumeRecoveryJobId: params.recovery.resumeRecoveryJobId }),
    ...(params.recovery.continueLocalJobId === undefined ? {} : { continueLocalJobId: params.recovery.continueLocalJobId }),
  };
  if (recovery?.resumeRecoveryJobId !== undefined && recovery.continueLocalJobId !== undefined) {
    throw new Error("bulk recovery cannot resume chain state and continue local state together");
  }
  const status = await params.node.status();
  assertWalletStoreMatches(params.store, params.wallet, params.chainId, status);
  const approvedFee = async (shape: PrivateValueShape) => (await planPublication({
    qualifying: true,
    byteSize: paddedPrivateValueByteSize(shape),
    openFeeAmount: params.openFeeAmount,
    publication: "open",
    node: params.node,
  })).openFeeAmount;
  const { recovery: _recovery, ...jobParams } = params;
  const job = createBulkJob({ ...jobParams, openFeeAmount: {
    [PRIVATE_VALUE_PROFILES.S.shapeId]: await approvedFee(PRIVATE_VALUE_PROFILES.S.shapeId),
    [PRIVATE_VALUE_PROFILES.L.shapeId]: await approvedFee(PRIVATE_VALUE_PROFILES.L.shapeId),
  } });
  const data = await params.store.load();
  const selectedRecovery = recovery?.resumeRecoveryJobId === undefined
    ? undefined
    : recoveredBulkGroups(data?.sentOutputs ?? []).find(group => group.recoveryJobId === recovery.resumeRecoveryJobId!.toLowerCase());
  const localSource = recovery?.continueLocalJobId === undefined
    ? undefined
    : data?.bulkJobs?.find(candidate => candidate.jobId === recovery.continueLocalJobId);
  if (recovery?.continueLocalJobId !== undefined && localSource === undefined) throw new Error("unknown local bulk job to continue");
  const previouslyPaid = new Set(selectedRecovery?.paidOriginalIndexes ?? []);
  for (const [index, recipient] of job.recipients.entries()) {
    if (recipient.noteSecret !== undefined) {
      recipient.delivery = { address: resolveRecipientAddress(recipient.to, params.chainId).recipientAddress.toString() };
      continue;
    }
    if (previouslyPaid.has(index)) {
      recipient.delivery = { address: resolveRecipientAddress(recipient.to, params.chainId).recipientAddress.toString() };
      continue;
    }
    const delivery = await resolveRecipientDelivery(recipient.to, params.chainId, localReceiveKeyLookup(params.store));
    const key = delivery.recipientReceiveKey ?? parseExtendedCode(delivery.recipientExtendedCode!).mlKemPublicKey;
    if (delivery.recipientAddress === params.wallet.address) assertReceiveKeyOwned(data, key);
    recipient.delivery = { address: delivery.recipientAddress.toString(), receiveKey: toHex(key) };
  }
  const manifestDigest = recovery === undefined ? undefined
    : localSource?.recovery?.manifestDigest ?? bulkRecoveryManifestDigest({
      chainId: params.chainId, assetId: BigInt(job.assetId), recipients: job.recipients,
    });
  return params.store.transaction(data => {
    if (data === null) throw new Error("scan the wallet before starting a bulk job");
    let stored = job;
    if (recovery !== undefined) {
      const selectedId = recovery.resumeRecoveryJobId?.toLowerCase();
      const continueId = recovery.continueLocalJobId;
      if (continueId !== undefined) {
        const source = data.bulkJobs?.find(candidate => candidate.jobId === continueId);
        if (source?.recovery === undefined) throw new Error("unknown recoverable local bulk job to continue");
        if (source.kind !== "payment" || source.recovery.invalidated === true) throw new Error("local bulk job cannot be continued");
        if (source.recovery.supersededByJobId !== undefined) throw new Error("local bulk job was already continued");
        if (source.assetId !== stored.assetId || toHex(recovery.appTag) !== source.recovery.appTag) {
          throw new Error("local bulk continuation differs from its source job");
        }
        const canonical = recoveredBulkGroups(data.sentOutputs ?? []).find(group => group.recoveryJobId === source.recovery!.recoveryJobId);
        if (canonical !== undefined && (canonical.manifestDigest !== source.recovery.manifestDigest
          || canonical.assetId !== `0x${BigInt(source.assetId).toString(16)}`
          || canonical.originalRecipientCount !== source.recovery.originalRecipientCount
          || toHex(canonical.appTag) !== source.recovery.appTag)) {
          throw new Error("local bulk continuation recovery group differs from its source job");
        }
        const otherActive = (data.bulkJobs ?? []).some(candidate => candidate.jobId !== source.jobId
          && candidate.recovery?.recoveryJobId === source.recovery!.recoveryJobId
          && candidate.recovery.invalidated !== true && candidate.recovery.supersededByJobId === undefined);
        if (otherActive) throw new Error("another local bulk job already continues this recovery lineage");
        const repairable = repairableLocalRecipients(source, new Set(canonical?.paidOriginalIndexes ?? []));
        if (repairable.length === 0) throw new Error("local bulk job has no terminal or unallocated recipients to continue");
        if (repairable.length !== stored.recipients.length || repairable.some(({ recipient }, index) => {
          const requested = stored.recipients[index];
          return requested?.delivery === undefined || recipient.delivery === undefined
            || BigInt(requested.delivery.address) !== BigInt(recipient.delivery.address)
            || requested.amount !== recipient.amount || requested.noteSecret !== recipient.noteSecret;
        })) {
          throw new Error("local bulk continuation recipients differ from the source job's repairable positions");
        }
        stored.recovery = freshBulkJobRecovery({
          recoveryJobId: source.recovery.recoveryJobId, appTag: recovery.appTag,
          manifestDigest: source.recovery.manifestDigest, originalRecipientCount: source.recovery.originalRecipientCount,
          originalIndexes: repairable.map(item => item.originalIndex),
          baselineContentHashes: canonical?.chunks.map(chunk => chunk.contentHash) ?? [],
        });
        source.recovery.supersededByJobId = stored.jobId;
      } else if (selectedId === undefined) {
        stored.recovery = freshBulkJobRecovery({ appTag: recovery.appTag,
          manifestDigest: manifestDigest!, originalRecipientCount: stored.recipients.length });
      } else {
        const canonical = recoveredBulkGroups(data.sentOutputs ?? []).find(group => group.recoveryJobId === selectedId);
        const invalidated = (data.bulkJobs ?? []).find(candidate =>
          candidate.recovery?.recoveryJobId === selectedId && candidate.recovery.invalidated === true);
        const observation = data.bulkRecoveryObservations?.find(candidate => candidate.recoveryJobId === selectedId);
        const recovered: RecoveredBulkGroup | undefined = canonical ?? (invalidated?.recovery === undefined ? undefined : {
          recoveryJobId: selectedId,
          appTag: fromHex(invalidated.recovery.appTag),
          manifestDigest: invalidated.recovery.manifestDigest,
          assetId: `0x${BigInt(invalidated.assetId).toString(16)}`,
          originalRecipientCount: invalidated.recovery.originalRecipientCount,
          chunks: [], paidOriginalIndexes: [], fingerprint: observation?.fingerprint ?? "",
        });
        if (recovered === undefined) throw new Error("unknown recovered bulk job");
        const canonicalContentHashes = new Set(recovered.chunks.map(chunk => chunk.contentHash.toLowerCase()));
        const currentLocalProgress = (data.bulkJobs ?? []).some(candidate => {
          if (candidate.recovery?.recoveryJobId !== selectedId) return false;
          if (candidate.recovery.invalidated === true || candidate.recovery.supersededByJobId !== undefined) return false;
          const baseline = candidate.recovery.baselineContentHashes;
          return baseline === undefined || baseline.every(contentHash => canonicalContentHashes.has(contentHash.toLowerCase()));
        });
        if (currentLocalProgress) throw new Error("this recovered bulk job already has local progress");
        if (observation === undefined || observation.fingerprint !== recovered.fingerprint
          || BigInt(observation.observedThroughTimestamp) <= BigInt(observation.observedAtTimestamp) + BULK_RECOVERY_OBSERVATION_SECONDS) {
          throw new Error("recovered bulk job is still observing possible in-flight chunks");
        }
        if (recovered.manifestDigest !== manifestDigest || recovered.assetId !== `0x${BigInt(stored.assetId).toString(16)}`
          || recovered.originalRecipientCount !== stored.recipients.length
          || toHex(recovered.appTag) !== toHex(recovery.appTag)) {
          throw new Error("recovered bulk job does not match the approved recipient list");
        }
        for (const chunk of recovered.chunks) {
          for (const paid of chunk.recipients) {
            const recipient = stored.recipients[paid.originalIndex];
            if (recipient === undefined || addressHex(BigInt(recipient.delivery!.address)).toLowerCase() !== paid.recipientAddress
              || recipient.amount !== paid.amount
              || (recipient.noteSecret !== undefined && recipient.noteSecret.toLowerCase() !== paid.noteSecret)) {
              throw new Error("recovered bulk output differs from the approved recipient list");
            }
          }
        }
        const paid = new Set(recovered.paidOriginalIndexes);
        const unpaid = stored.recipients.flatMap((recipient, index) => paid.has(index) ? [] : [{ recipient, index }]);
        if (unpaid.length === 0) throw new Error("recovered bulk job already paid every recipient");
        if (unpaid.some(({ recipient }) => recipient.noteSecret === undefined && recipient.delivery?.receiveKey === undefined)) {
          throw new Error("recovered bulk job changed while recipient keys were resolved; retry");
        }
        stored = { ...stored, recipients: unpaid.map(item => item.recipient), recovery: freshBulkJobRecovery({
          recoveryJobId: recovered.recoveryJobId, appTag: recovery.appTag,
          manifestDigest: recovered.manifestDigest, originalRecipientCount: recovered.originalRecipientCount,
          originalIndexes: unpaid.map(item => item.index),
          baselineContentHashes: recovered.chunks.map(chunk => chunk.contentHash),
        }) };
      }
    }
    (data.bulkJobs ??= []).push(stored);
    return { data, value: structuredClone(stored) };
  });
}

/** `waiting-for-confirmation`: nothing is left to allocate, but a chunk is still unresolved. */
export type BulkJobStep =
  | { state: "complete" | "chunk-complete" | "waiting-for-confirmation" | "waiting-for-funding" | "limit-reached" | "needs-review"; jobId: string }
  | { state: "submitted"; jobId: string; chunkIndex: number; result: AssetActionSubmissionResult };

/** One serial proof/submission step. Call again after scanning a completed boundary.
 * An explicit new chunk index can allocate disjoint existing funding while another
 * chunk is unresolved; omitting it resumes the first unresolved exact transaction.
 */
export async function runBulkJobStep<Prepared, Output>(params: {
  jobId: string;
  chunkIndex?: number;
  node: PcashNodeClient;
  store: WalletStateStore;
  wallet: PcashProfile;
  signer: PcashActionSigner;
  chainId: bigint;
  prover: AssetActionProver;
  submission: DurableSubmissionAdapter<Prepared, Output>;
  privateRelayFeeAmount?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  callbacks?: DurableSubmissionCallbacks;
}): Promise<BulkJobStep> {
  return withWalletReservation(params.store, [`bulk-job:${params.jobId}`], async reservation => {
    const status = await params.node.status();
    const data = await loadAndReconcileNoteWallet(params.store, status, params.chainId, params.wallet);
    let job = data.bulkJobs?.find(job => job.jobId === params.jobId);
    if (job === undefined) throw new Error("unknown bulk job");
    if (job.recovery?.invalidated === true || job.recovery?.supersededByJobId !== undefined) {
      return { state: "needs-review", jobId: job.jobId };
    }
    // Re-read unresolved outcomes from the synced chain so reorgs cannot turn
    // an unfinalized inclusion into permission for fresh funding.
    const outcomes = await params.store.readChain(chain => job!.chunks
      .filter(chunk => chunk.outcome === "unresolved")
      .map(chunk => ({
        chunk,
        synced: chain !== null && chain.synced.pcashNumber >= status.finalizedBlock,
        consumed: chain?.consumption(chunk.action.inputs.map(input => input.nullifier)) ?? [],
      })));
    for (const { chunk, synced, consumed } of outcomes) {
      const ours = consumed.find(consumption => consumption?.contentHash === chunk.action.contentHash.toLowerCase()) ?? null;
      if (ours !== null && ours.pcashNumber <= status.finalizedBlock) {
        chunk.outcome = "succeeded";
        chunk.inclusion = { blockNumber: ours.pcashNumber.toString(), blockHash: ours.pcashHash };
      } else if (synced && status.finalizedBlockTimestamp > BigInt(chunk.action.validUntilTimestamp)) {
        chunk.outcome = "expired";
      } else if (!data.pendingAssetActions?.some(action => action.contentHash === chunk.action.contentHash)
        && consumed.some(consumption => consumption !== null)) {
        // A canonical competing spend may resolve the wallet reservation before
        // this job is resumed. Do not silently replace a failed chunk.
        return { state: "needs-review", jobId: job.jobId };
      }
    }
    await reservation.save(data);
    // save merges concurrent wallet work and refreshes the document objects.
    job = data.bulkJobs!.find(job => job.jobId === params.jobId)!;
    if (job.chunks.some(chunk => chunk.outcome === "expired" || chunk.outcome === "conflicted")) {
      return { state: "needs-review", jobId: job.jobId };
    }
    const unresolved = job.chunks.findIndex(chunk => chunk.outcome === "unresolved");
    const index = params.chunkIndex ?? (unresolved < 0 ? job.chunks.length : unresolved);
    if (!Number.isSafeInteger(index) || index < 0 || index > job.chunks.length) throw new Error("invalid bulk chunk index");
    const existing = job.chunks[index];
    if (existing !== undefined) {
      if (existing.outcome === "succeeded") return { state: "chunk-complete", jobId: job.jobId };
      const savedMode = existing.action.privateRelayRecipient !== undefined ? "selected"
        : BigInt(existing.action.issuanceOwnerCommitment) === 0n ? "open" : "self";
      if (publicationOf(params.submission, params.privateRelayFeeAmount ?? BigInt(existing.action.privateRelayFeeAmount ?? 0n)) !== savedMode) throw new Error("bulk chunk retry uses another publication mode");
      if (savedMode === "selected") {
        if (params.privateRelayFeeAmount !== BigInt(existing.action.privateRelayFeeAmount ?? 0n)
          || (params.selectedRelayQuote !== undefined
            && existing.action.privateRelayRecipient!.toLowerCase() !== addressHex(params.selectedRelayQuote.recipient).toLowerCase())) {
          throw new Error("selected bulk retry names another relayer");
        }
      }
      const result = await submitPendingAssetAction({ node: params.node, store: params.store, data, status,
        pending: existing.action, submission: params.submission,
        ...(params.callbacks === undefined ? {} : { callbacks: params.callbacks }) });
      return { state: "submitted", jobId: job.jobId, chunkIndex: index, result };
    }
    const recipientsAssigned = job.chunks.reduce((sum, chunk) => sum + chunk.recipientCount, 0);
    if (job.kind === "payment"
      ? recipientsAssigned === job.recipients.length
      : spendableNotes(data, BigInt(job.assetId)).length <= job.targetNotes) {
      return { state: unresolved < 0 ? "complete" : "waiting-for-confirmation", jobId: job.jobId };
    }
    if (job.chunks.length >= job.maxTransactions) return { state: "limit-reached", jobId: job.jobId };
    if (job.shape !== undefined && !params.prover.shapes.includes(job.shape)) {
      throw new Error(`bulk job ${job.jobId} uses ${privateValueProfile(job.shape).name} chunks, which this wallet's prover cannot prove`);
    }
    // A self-published chunk names this wallet's own commitment, which one more note pays.
    const publicationMode = publicationOf(params.submission, params.privateRelayFeeAmount);
    const selfPublished = publicationMode === "self";
    const selected = publicationMode === "selected";
    // The open fee is the job's approved amount for the chunk's shape; this
    // only checks the publication terms and fixes the private relay fee.
    const { privateRelayFeeAmount } = await planPublication({
      qualifying: true, byteSize: null, publication: publicationMode, openFeeAmount: 0n,
      privateRelayFeeAmount: params.privateRelayFeeAmount,
      selectedRelayQuote: params.selectedRelayQuote, node: params.node,
    });
    const assetId = BigInt(job.assetId);
    const assetDefinition = knownAssetDefinition(data, assetId);
    if (job.recovery !== undefined && assetId !== 0n && assetDefinition === undefined) {
      throw new Error("import the token definition before starting recoverable bulk funding");
    }
    const plan = planNextBulkChunk(data, job, {
      issuanceNote: selfPublished,
      ...(publicationMode === "open" ? {} : { fundingFeeAmount: privateRelayFeeAmount }),
      reservedOutputs: selected ? 1 : 0,
      shapes: params.prover.shapes,
    });
    if (plan === null) return { state: "waiting-for-funding", jobId: job.jobId };
    const openFeeAmount = publicationMode === "open" ? BigInt(job.openFeeAmounts[plan.shape]) : 0n;
    const profile = privateValueProfile(plan.shape);
    const recipients = job.recipients.slice(plan.firstRecipient, plan.firstRecipient + plan.recipientCount);
    const authorizationKind = plan.shape === PRIVATE_VALUE_PROFILES.S.shapeId && assetId !== 0n && recipients.length === 1
      ? "asset-payment" : "batch-transfer";
    params.callbacks?.onProgress?.("preparing", "reading one snapshot for the bulk chunk");
    const witnesses = await collectAssetActionWitnesses({ node: params.node, store: params.store, wallet: params.wallet,
      shape: plan.shape, authorizationKind, inputOpenings: plan.inputs.map(note => ({
        outputIndex: BigInt(note.leafIndex!), outputCommitment: BigInt(note.commitment!),
      })) });
    const inputs: AssetActionInput[] = plan.inputs.map((note, index) => ({
      kind: BigInt(note.assetId) === 0n ? "native" : "asset", amount: BigInt(note.amount), noteSecret: BigInt(note.noteSecret),
      leafIndex: Number(note.leafIndex!), siblings: witnesses.inputSiblings[index]!,
    }));
    while (inputs.length < profile.inputs) inputs.push({ kind: "dummy" });
    let selfKey: Uint8Array | undefined;
    const selfReceiveKey = () => selfKey ??= registeredSelfReceiveKey(witnesses.account, data);
    // An extended code's key was fixed at approval; a bare address's key is
    // read from this chunk's snapshot, and a recipient whose account there
    // commits no key, having cleared it since approval, is sealed to the
    // approved one.
    const recipientKey = async (recipient: typeof recipients[number]) => {
      const self = BigInt(recipient.delivery!.address) === params.wallet.address;
      if (!looksLikeExtendedCode(recipient.to)) {
        if (self) return selfReceiveKey();
        return await witnesses.receiveKeyOf(addressHex(BigInt(recipient.delivery!.address)))
          ?? fromHex(recipient.delivery!.receiveKey!);
      }
      const key = fromHex(recipient.delivery!.receiveKey!);
      if (self) assertReceiveKeyOwned(data, key);
      return key;
    };
    const recipientKeys: Array<Uint8Array | undefined> = [];
    for (const recipient of recipients) {
      recipientKeys.push(recipient.noteSecret === undefined ? await recipientKey(recipient) : undefined);
    }
    const outputs: AssetActionOutput[] = recipients.map((recipient, index) => recipient.noteSecret !== undefined
      ? outOfBandAssetActionOutput({
        kind: assetId === 0n ? "native" : "asset", recipientAddress: BigInt(recipient.delivery!.address),
        noteSecret: BigInt(recipient.noteSecret), amount: BigInt(recipient.amount),
      })
      : openedAssetActionOutput({
        kind: assetId === 0n ? "native" : "asset", pcashChainId: params.chainId, assetId, outputIndex: index,
        amount: BigInt(recipient.amount), recipientAddress: BigInt(recipient.delivery!.address),
        recipientMlKemPublicKey: recipientKeys[index]!, authenticatedRecipient: true,
        ...(assetDefinition === undefined ? {} : { assetDefinition }),
      }));
    for (const change of plan.change) outputs.push(ownerChangeAssetActionOutput({
      kind: change.assetId === 0n ? "native" : "asset", pcashChainId: params.chainId, assetId: change.assetId,
      amount: change.amount, receiveKey: selfReceiveKey(),
    }));
    // The sender region records every recipient's opening; a recoverable job
    // adds its chunk record beside them.
    const recoveryRecord = job.recovery === undefined ? undefined
      : bulkRecoveryRecord(job.recovery, plan.firstRecipient, plan.recipientCount);
    const dummyInputSeed = randomFieldEntropy();
    const validUntilTimestamp = publicationValidUntil({
      chainNow: witnesses.status.latestBlockTimestamp, defaultWindow: 1800n,
      selectedRelayQuote: params.selectedRelayQuote, action: "bulk payment",
    });
    const issuance = selected
      ? await fixPublication({
        selectedRelayQuote: params.selectedRelayQuote, publication: "selected", owner: params.wallet,
        requestedCommitment: 0n, node: params.node, status: witnesses.status,
        nullifiers: transactionNullifiers(params.wallet.nkRoot, plan.inputs, dummyInputSeed, profile.inputs),
        shape: plan.shape, openFeeAmount: 0n, privateRelayFeeAmount,
        validUntilTimestamp,
      })
      : selfPublished
        ? ownIssuance(params.wallet, params.chainId, transactionNullifiers(params.wallet.nkRoot, plan.inputs, dummyInputSeed, profile.inputs), plan.shape)
        : { issuanceOwnerCommitment: 0n };
    while (outputs.length < profile.outputs - (selected ? 1 : 0)) {
      outputs.push({ kind: "dummy", dummySecret: randomFieldEntropy(), amount: 0n });
    }
    let relayFeeOwnerCommitment = 0n;
    if (selected) {
      const fee = "privateRelayPayment" in issuance ? issuance.privateRelayPayment : undefined;
      if (fee === undefined) throw new Error("selected bulk quote omitted its private relay payment");
      const feeOutput = openedAssetActionOutput({
        kind: "native", pcashChainId: params.chainId, assetId: 0n,
        outputIndex: profile.outputs - 1, amount: fee.amount,
        recipientAddress: fee.recipientAddress, recipientMlKemPublicKey: fee.receiveKey,
        authenticatedRecipient: true,
      });
      if (feeOutput.kind !== "native" || feeOutput.destination.kind !== "opening") throw new Error("selected bulk fee has no owner opening");
      relayFeeOwnerCommitment = ownerCommitment(fee.recipientAddress, feeOutput.destination.noteSecret);
      outputs.push(feeOutput);
    }
    const issuanceOwnerCommitment = issuance.issuanceOwnerCommitment;
    const designatedIssuanceOpening = "designatedIssuanceOpening" in issuance ? issuance.designatedIssuanceOpening : undefined;
    const build = buildAssetAction({ shape: plan.shape, pcashChainId: params.chainId, snapshot: witnesses.snapshot,
      owner: witnesses.owner, assetId, inputs, outputs, openFeeAmount, issuanceOwnerCommitment,
      ...(designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening }), dummyInputSeed,
      ...(selected ? { privateRelayPayment: {
        amount: privateRelayFeeAmount, ownerCommitment: relayFeeOwnerCommitment,
      } } : {}),
      ...(assetDefinition === undefined ? {} : { assetDefinition }),
      sender: {
        outgoingKey: params.wallet.outgoingKey,
        ...(recoveryRecord === undefined ? {} : { records: [recoveryRecord] }),
      },
      validUntilTimestamp });
    const authorization = build.prepareOwnerAuthorization({ wallet: params.wallet,
      network: networkConfigFromStatus(witnesses.status) });
    const signed = authorization.authorize(await requestPcashAuthorization(params.signer, authorization.request));
    params.callbacks?.onProgress?.("proving", "proving the approved bulk chunk");
    const entry = await params.prover.proveAndEncode(build, { packageName: authorization.authorizationCircuit, witnessMap: signed.witnessMap });
    const preparedAction = prepareAssetAction({ build, transactionBytes: entry,
      ...(designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening }),
      ...(selected ? { privateRelayRecipient: params.selectedRelayQuote!.recipient } : {}),
      ...(selected ? { privateRelayFeeAmount } : {}),
      ownedOutputs: plan.change.map((change, offset) => ({ outputIndex: recipients.length + offset,
        assetId: change.assetId, amount: change.amount, owner: params.wallet.address,
        noteSecret: build.outputNoteSecrets[recipients.length + offset]! })) });
    const preparedSubmission = await params.submission.preflight({ transactionBytes: entry, status: witnesses.status, retry: false });
    job.chunks.push({ shape: plan.shape, firstRecipient: plan.firstRecipient, recipientCount: plan.recipientCount,
      action: preparedAction.pending, outcome: "unresolved" });
    // The job chunk and ordinary spend reservation commit in the same wallet
    // write, before submission. A crash cannot leave a sent chunk unrecorded.
    await reservation.assertActive();
    const result = await submitPreparedAssetAction({ node: params.node, store: params.store, data, status: witnesses.status,
      preparedAction, submission: params.submission, preparedSubmission, retainForRetry: true,
      ...(params.callbacks === undefined ? {} : { callbacks: params.callbacks }) });
    return { state: "submitted", jobId: job.jobId, chunkIndex: index, result };
  });
}
