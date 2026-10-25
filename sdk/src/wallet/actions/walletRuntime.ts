import { transactionDataHash } from "@pcash/sdk/delivery";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { batchEntryCarrying } from "@pcash/sdk/relay";
import type { SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
import { runAssetCreationClient, type AssetCreationIntent, type AssetCreationProver } from "./assetCreationClient.ts";
import type { AssetActionProver } from "./assetActionClient.ts";
import { runAssetTransferClient, type AssetTransferIntent } from "./assetTransferClient.ts";
import { runBulkJobStep, startBulkJob } from "./bulkJobClient.ts";
import {
  buildAuthorizedReferenceUserAccountCreation,
  buildDirectReferenceUserAccountCreation,
  defaultEcdsaRuleSet,
} from "@pcash/sdk/builders";
import { transactionIdentity, networkConfigFromStatus, RECENT_PCASH_BLOCK_WINDOW_SECONDS } from "@pcash/sdk/protocol";
import { assertMempoolAdmissible, type PcashNodeClient, type StatusResult } from "@pcash/sdk/clients";
import type { PcashActionSigner } from "@pcash/sdk/eip712";
import {
  encodeUserAccountCreation,
  decodeTransactionForChain,
  TX_KIND_USER_ACCOUNT_CREATION,
  generateMlKemKeyPair,
  type MlKemKeyPair,
  type WalletProfile,
} from "@pcash/sdk/protocol";
import { addressHex, bytes32Hex, fromHex } from "@pcash/sdk/utils";
import {
  InsufficientNotesError,
  addPendingUserAccountCreation,
  addPendingNoteFundedTransfer,
  markPendingNoteFundedTransferL1Submitted,
  markPendingUserAccountCreationBroadcastRequested,
  markPendingUserAccountCreationPrepared,
  markPendingUserAccountCreationSubmitted,
  pendingUserAccountCreation,
  removePendingUserAccountCreation,
  removePendingNoteFundedTransfer,
  type PendingUserAccountCreation,
} from "../noteStore.ts";
import type { WalletStateStore } from "../store.ts";
import { emptyWalletState } from "../store.ts";
import {
  receiveKeyHashHex,
  retainReceiveKeyPairForRescan,
} from "../receiveKeyring.ts";
import {
  FULL_RESCAN_RESOURCE,
  accountResource,
  withWalletReservation,
} from "../reservations.ts";
import type { PcashProfile } from "../externalIdentity.ts";
import {
  isPcashProfile,
  isSpendableWallet,
  missingSpendableCapability,
} from "../walletCapabilities.ts";
import { buildExtendedCode, requireReceiveKeys } from "../wallet.ts";
import {
  preflightNoteFundedTransferClient,
  prepareNoteFundedTransfer,
  selectNoteTransferFunding,
  selectedPendingNoteFundedTransfer,
  runNoteFundedTransferClient,
  type NoteFundedProver,
  type NoteFundedTransferIntent,
  type PreparedNoteFundedTransfer,
} from "./noteFundedClient.ts";
import {
  durableSubmissionCallbacks,
  DurablePreBroadcastError,
  type DurableSubmissionAdapter,
  type DurableSubmissionCallbacks,
  type DurableSubmissionResult,
} from "./durableSubmission.ts";
import {
  runSponsoredContractCreationClient,
  type SponsoredContractCreationIntent,
  type SponsoredContractCreationProver,
} from "./contractCreationClient.ts";
import {
  runSponsoredContractAssetActionClient,
  type SponsoredContractAssetActionIntent,
} from "./contractSponsorshipClient.ts";
import {
  runUserAccountUpdateClient,
  type UserAccountReceiveKeyClientUpdate,
  type UserAccountUpdateProver,
} from "./userAccountUpdateClient.ts";
import { syncWallet, type SyncWalletResult } from "./syncWallet.ts";
import { isWalletSyncConflict } from "./syncConflictRetry.ts";
import { throwIfWalletActionCanceled } from "./cancellation.ts";
import { localAccount } from "./localChain.ts";
import { assertWalletStoreMatches } from "./walletSession.ts";
import { loadSelfReceiveKey } from "./selfDelivery.ts";
import {
  actionPublication,
  paddedPrivateValueByteSize,
  pendingIssuanceBeneficiary,
  planPublication,
  MAX_MINE_ACTIONS,
  resolvePublicationFunding,
  publicationOf,
  type PublicationPlan,
} from "./publication.ts";
import {
  type WalletTransferPreflight,
} from "./transferReview.ts";
export {
  WalletReviewStaleError,
  type WalletTransferPreflight,
} from "./transferReview.ts";
export interface WalletRuntimeProvers {
  assetCreation: AssetCreationProver;
  /** Asset payments, burns, batch transfers, and bulk chunks under the rule each selects. */
  assetAction: AssetActionProver;
  privateValue: NoteFundedProver;
  userAccountUpdate: UserAccountUpdateProver;
  sponsoredContractCreation: SponsoredContractCreationProver;
}

export interface WalletBulkJobStepIntent<Prepared = unknown, Output = unknown> extends DurableSubmissionCallbacks {
  jobId: string;
  /** Allocate this new chunk beside an unresolved one; absent resumes the first unresolved chunk. */
  chunkIndex?: number;
  submission?: DurableSubmissionAdapter<Prepared, Output>;
  privateRelayFeeAmount?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
}

interface WalletContractCreationIntent<Prepared = unknown, Output = unknown>
  extends SponsoredContractCreationIntent {
  submission?: DurableSubmissionAdapter<Prepared, Output>;
}

interface WalletContractSponsorshipIntent<Prepared = unknown, Output = unknown>
  extends SponsoredContractAssetActionIntent {
  submission?: DurableSubmissionAdapter<Prepared, Output>;
}

interface WalletRuntimeParams<Prepared = unknown, Output = unknown> {
  node: PcashNodeClient;
  chainId: bigint;
  wallet: PcashProfile | WalletProfile;
  /** Absent on watch-only accounts. */
  signer?: PcashActionSigner;
  store: WalletStateStore;
  provers?: Partial<WalletRuntimeProvers>;
  submission?: DurableSubmissionAdapter<Prepared, Output>;
  userAccountCreationSubmission?: DurableSubmissionAdapter<Prepared, Output>;
  settlePollIntervalMs?: number;
  settlePollMaxAttempts?: number;
}

interface WalletAccountActivationIntent extends DurableSubmissionCallbacks {
  /** Prepare registration and zero-value mining for one direct L1 batch. */
  mine?: boolean;
  authorizationMode?: "direct" | "signed";
  receiveKey?: UserAccountReceiveKeyClientUpdate;
  ruleSetCommitment?: bigint;
  validUntilTimestamp?: bigint;
  /** Approved native fee an update pays from the wallet's own notes; creation carries no fee. */
  openFeeAmount?: bigint;
  privateRelayFeeAmount?: bigint;
  issuanceOwnerCommitment?: bigint;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
}

interface WalletAccountIntent<Prepared = unknown, Output = unknown>
  extends WalletAccountActivationIntent {
  /** Publication of an update to an existing account. */
  submission?: DurableSubmissionAdapter<Prepared, Output>;
  /**
   * Publication of a new USER account. Its authority is its own Ethereum
   * address, so it defaults to the wallet's L1 creation path; an update's
   * `submission` does not redirect it.
   */
  userAccountCreationSubmission?: DurableSubmissionAdapter<Prepared, Output>;
}

export class WalletCapabilityError extends Error {
  readonly capability: "signer" | "prover" | "submission" | "profile";

  constructor(capability: WalletCapabilityError["capability"], action: string) {
    super(`${action} requires the wallet ${capability} capability`);
    this.name = "WalletCapabilityError";
    this.capability = capability;
  }
}

function requireSpendable(params: WalletRuntimeParams, action: string): {
  signer: PcashActionSigner;
  wallet: PcashProfile;
} {
  const authority = { profile: params.wallet, signer: params.signer };
  if (!isSpendableWallet(authority)) {
    throw new WalletCapabilityError(missingSpendableCapability(authority)!, action);
  }
  return { signer: authority.signer, wallet: authority.profile };
}

function requirePcashProfile(params: WalletRuntimeParams, action: string): PcashProfile {
  if (!isPcashProfile(params.wallet)) throw new WalletCapabilityError("profile", action);
  return params.wallet;
}

export function createWalletRuntime<Prepared = unknown, Output = unknown>(
  params: WalletRuntimeParams<Prepared, Output>,
) {
  const settleInterval = params.settlePollIntervalMs ?? 2000;
  const settleAttempts = params.settlePollMaxAttempts ?? 150;
  // Settling reads the local chain state, so each attempt synchronizes first.
  const synchronize = () => syncWallet({
    node: params.node,
    wallet: requireReceiveKeys(params.wallet),
    chainId: params.chainId,
    store: params.store,
  });
  const retainReceiveKey = async (pair: MlKemKeyPair): Promise<void> => {
    await withWalletReservation(params.store, [FULL_RESCAN_RESOURCE], async () => {
      await params.store.transaction((current) => {
        const data = current ?? emptyWalletState({
          address: params.wallet.address,
          network: params.store.identity.network,
        });
        retainReceiveKeyPairForRescan(data, pair);
        return { data, value: undefined };
      });
    });
  };

  const activationAddress = addressHex(params.wallet.address);

  const readActivation = async (): Promise<PendingUserAccountCreation | null> =>
    pendingUserAccountCreation(await params.store.load(), activationAddress);

  /**
   * A crash between an Ethereum broadcast and saving its hash leaves the hash
   * only in the transport journal. Copy it to the Ethereum-published
   * transfers that journal carries. Runs once when the wallet opens.
   */
  const recordJournaledL1Hashes = async (): Promise<void> => {
    const data = await params.store.load();
    const outbox = new Set((data?.mempoolOutbox ?? []).map((entry) => entry.contentHash.toLowerCase()));
    const unhashed = (data?.pendingNoteFundedTransfers ?? [])
      .filter((transfer) => transfer.l1TxHash === undefined && !outbox.has(transfer.contentHash.toLowerCase()));
    if (unhashed.length === 0) return;
    const submission = params.userAccountCreationSubmission ?? params.submission;
    const entries = (await (await submission?.l1Recovery?.())?.show())?.entries ?? [];
    const carried = unhashed.flatMap((transfer) => {
      const hash = batchEntryCarrying(entries, transfer.contentHash)?.transactionHash;
      return hash === null || hash === undefined ? [] : [[transfer.contentHash, hash] as const];
    });
    if (carried.length === 0) return;
    await params.store.transaction((current) => {
      const data = current ?? emptyWalletState({ address: params.wallet.address, network: params.store.identity.network });
      for (const [contentHash, hash] of carried) markPendingNoteFundedTransferL1Submitted(data, contentHash, hash);
      return { data, value: undefined };
    });
  };

  const reconcileAccountActivation = async (): Promise<PendingUserAccountCreation | null> => {
    const pending = await readActivation();
    if (pending === null) return null;
    const [status, account] = await Promise.all([
      params.node.status(),
      params.store.readChain((chain) => chain?.account(activationAddress) ?? null),
    ]);
    if (account === null) {
      const submission = params.userAccountCreationSubmission ?? params.submission;
      const recovery = await submission?.l1Recovery?.();
      const entry = batchEntryCarrying((await recovery?.show())?.entries ?? [], pending.contentHash);
      if (entry !== undefined) {
        if (pending.state === "l1-submitted" && pending.l1TxHash === entry.transactionHash
          || pending.state === "broadcast-requested" && entry.transactionHash === null) return pending;
        return params.store.transaction((stored) => {
          const data = stored ?? emptyWalletState({ address: params.wallet.address, network: params.store.identity.network });
          const current = pendingUserAccountCreation(data, activationAddress);
          if (current?.contentHash === pending.contentHash) {
            if (entry.transactionHash !== null) markPendingUserAccountCreationSubmitted(data, activationAddress, entry.transactionHash);
            else if (current.state === "prepared") markPendingUserAccountCreationBroadcastRequested(data, activationAddress);
          }
          return { data, value: current };
        });
      }
      // A PCASH deadline does not expire an Ethereum transaction. Keep the
      // activation until its transport journal has been resolved as well.
      if (status.latestBlockTimestamp <= BigInt(pending.validUntilTimestamp)
        || (pending.state !== "prepared" && recovery === undefined)) return pending;
    }
    await params.store.transaction((current) => {
      const data = current ?? emptyWalletState({
        address: params.wallet.address,
        network: params.store.identity.network,
      });
      removePendingUserAccountCreation(data, activationAddress);
      return { data, value: undefined };
    });
    return null;
  };

  const prepareActivationMining = async (pending: PendingUserAccountCreation, mine: boolean): Promise<PendingUserAccountCreation> => {
    if (!mine || pending.miningTransactionHex !== undefined || pending.state !== "prepared") return pending;
    const { signer, wallet: profile } = requireSpendable(params, "setup mining");
    const prover = params.provers?.privateValue;
    if (prover === undefined) throw new WalletCapabilityError("prover", "setup mining");
    const submission = params.userAccountCreationSubmission ?? params.submission;
    if (submission === undefined || submission.mode !== "l1") throw new WalletCapabilityError("submission", "setup mining");
    const { preparedAction } = await prepareNoteFundedTransfer({
      ...params, wallet: profile, signer, prover, submission,
      kind: "mine", to: activationAddress, amount: 0n, openFeeAmount: 0n,
      validUntilTimestamp: BigInt(pending.validUntilTimestamp),
    }, [], PRIVATE_VALUE_PROFILES.S.shapeId);
    const miningTransactionHex = preparedAction.pending.transactionHex;
    return params.store.transaction((data) => {
      // Another tab can prepare, submit, or clear this activation while proving.
      const current = pendingUserAccountCreation(data, pending.address);
      if (data === null || current === null || current.contentHash !== pending.contentHash) {
        throw new Error("Account activation changed while preparing setup mining.");
      }
      if (current.miningTransactionHex !== undefined) return { data, value: current };
      if (current.state !== "prepared") {
        throw new Error("Account activation was submitted while preparing setup mining.");
      }
      addPendingNoteFundedTransfer(data, preparedAction.pending);
      current.miningTransactionHex = miningTransactionHex;
      return { data, value: current };
    });
  };

  const assertReceiveKeyChangeAllowed = (receiveKey?: UserAccountReceiveKeyClientUpdate) => {
    if (isPcashProfile(params.wallet) && params.wallet.recoveryContract === "seed-derived"
      && receiveKey !== undefined && receiveKey.operation !== "keep") {
      throw new Error("seed wallets use one recoverable receive key; changing it is not supported");
    }
  };

  const prepareAccountActivation = async (
    intent: WalletAccountActivationIntent = {},
  ): Promise<PendingUserAccountCreation> => {
    assertReceiveKeyChangeAllowed(intent.receiveKey);
    const authorizationMode = intent.authorizationMode ?? "signed";
    const profile = requirePcashProfile(params, "account activation");
    const signer = authorizationMode === "signed" ? requireSpendable(params, "account activation").signer : undefined;
    const status = await params.node.status();
    // The creation is signed and published under this status's network, so it
    // must be the network the wallet opened on.
    assertWalletStoreMatches(params.store, params.wallet, params.chainId, status);
    if (await localAccount(params.store, activationAddress) !== null) {
      throw new Error(`user account ${activationAddress} already exists`);
    }
    // The activation names the head as its recent block, so it is unusable
    // once that block leaves the window, whatever its declared deadline.
    if (
      intent.validUntilTimestamp !== undefined
      && intent.validUntilTimestamp > status.latestBlockTimestamp + RECENT_PCASH_BLOCK_WINDOW_SECONDS
    ) {
      throw new Error("account activation deadline is beyond its recent PCASH block's window");
    }
    if (intent.ruleSetCommitment !== undefined) {
      throw new Error("account activation does not accept an opaque custom rule-set commitment");
    }
    let creationReceiveKey = params.wallet.mlKemPublicKey;
    if (intent.receiveKey?.operation === "clear") {
      creationReceiveKey = undefined;
    } else if (intent.receiveKey?.operation === "replace") {
      if (intent.receiveKey.keyPair === undefined) {
        throw new Error("a new REPLACE requires a complete owned ML-KEM keypair");
      }
      creationReceiveKey = intent.receiveKey.keyPair.publicKey;
    }
    const network = networkConfigFromStatus(status);
    const ruleSetCommitment = defaultEcdsaRuleSet({
      wallet: profile,
      network,
      secrets: profile.defaultUserRuleSecrets,
    }).ruleSetCommitment;
    const expectedReceiveKeyHash = creationReceiveKey === undefined
      ? `0x${"00".repeat(32)}`
      : receiveKeyHashHex({ publicKey: creationReceiveKey });
    const existing = await reconcileAccountActivation();
    if (existing !== null) {
      const decoded = decodeTransactionForChain(fromHex(existing.transactionHex), params.chainId);
      if (
        decoded.kind !== TX_KIND_USER_ACCOUNT_CREATION || decoded.authorization.kind !== authorizationMode
        || BigInt(existing.ruleSetCommitment) !== ruleSetCommitment
        || existing.receiveKeyHash.toLowerCase() !== expectedReceiveKeyHash.toLowerCase()
        || (
          intent.validUntilTimestamp !== undefined
          && BigInt(existing.validUntilTimestamp) !== intent.validUntilTimestamp
        )
      ) {
        throw new Error("a different exact account activation is already pending");
      }
      return prepareActivationMining(existing, intent.mine === true);
    }
    if (intent.receiveKey?.operation === "replace") {
      await retainReceiveKey(intent.receiveKey.keyPair!);
    }
    const validUntilTimestamp = intent.validUntilTimestamp
      ?? status.latestBlockTimestamp + 1_800n;
    const creation = {
      chainId: params.chainId,
      network,
      wallet: profile,
      defaultRuleSecrets: profile.defaultUserRuleSecrets,
      ...(creationReceiveKey === undefined ? {} : { mlKemPublicKey: creationReceiveKey }),
      recentPcashBlockHash: BigInt(status.latestBlockHash),
      validUntilTimestamp,
    };
    const built = authorizationMode === "direct"
      ? buildDirectReferenceUserAccountCreation(creation)
      : await buildAuthorizedReferenceUserAccountCreation(creation, signer!);
    const entry = encodeUserAccountCreation(params.chainId, built.body);
    const pending: PendingUserAccountCreation = {
      ...transactionIdentity(entry),
      address: activationAddress,
      pcashChainId: status.pcashChainId.toString(),
      pcashGenesisHash: status.genesisHash.toLowerCase(),
      l1ChainId: status.l1ChainId.toString(),
      inboxAddress: status.inboxAddress.toLowerCase(),
      genesisL1Block: status.genesisL1Block.toString(),
      genesisL1BlockHash: status.genesisL1BlockHash.toLowerCase(),
      ruleSetCommitment: ruleSetCommitment.toString(),
      receiveKeyHash: expectedReceiveKeyHash,
      recentPcashBlockNumber: status.latestBlock.toString(),
      recentPcashBlockHash: status.latestBlockHash.toLowerCase(),
      validUntilTimestamp: validUntilTimestamp.toString(),
      state: "prepared",
      l1TxHash: null,
      preparedAtUnixMs: String((intent.nowUnixMilliseconds ?? Date.now)()),
    };
    await intent.beforeJournal?.(pending.contentHash, pending.transactionHex);
    await params.store.transaction((current) => {
      const data = current ?? emptyWalletState({
        address: params.wallet.address,
        network: params.store.identity.network,
      });
      addPendingUserAccountCreation(data, pending);
      return { data, value: undefined };
    });
    await intent.onPrepared?.(pending.contentHash, pending.transactionHex);
    return prepareActivationMining(pending, intent.mine === true);
  };

  const assertActivationContext = async (
    pending: PendingUserAccountCreation,
    status: StatusResult,
  ): Promise<void> => {
    if (
      BigInt(pending.pcashChainId) !== BigInt(status.pcashChainId)
      || pending.pcashGenesisHash.toLowerCase() !== status.genesisHash.toLowerCase()
      || BigInt(pending.l1ChainId) !== status.l1ChainId
      || pending.inboxAddress.toLowerCase() !== status.inboxAddress.toLowerCase()
      || BigInt(pending.genesisL1Block) !== status.genesisL1Block
      || pending.genesisL1BlockHash.toLowerCase() !== status.genesisL1BlockHash.toLowerCase()
    ) {
      throw new Error("prepared account activation belongs to a different PCASH or Ethereum network");
    }
    if (status.latestBlockTimestamp > BigInt(pending.validUntilTimestamp)) {
      throw new Error("prepared account activation authorization has expired");
    }
    const recent = await params.node.getBlock(BigInt(pending.recentPcashBlockNumber));
    if (recent === null || recent.hash.toLowerCase() !== pending.recentPcashBlockHash.toLowerCase()) {
      throw new Error("prepared account activation recent PCASH block is no longer canonical");
    }
  };

  const submitPreparedAccountActivation = async (
    submissionOverride?: DurableSubmissionAdapter<Prepared, Output>,
    onSubmitted?: (pending: PendingUserAccountCreation) => void,
  ) => {
    const submission = submissionOverride ?? params.userAccountCreationSubmission ?? params.submission;
    if (submission === undefined) throw new WalletCapabilityError("submission", "account activation");
    return withWalletReservation(
      params.store,
      [accountResource(activationAddress, 0n)],
      async (reservation) => {
        let data = await params.store.load();
        let pending = pendingUserAccountCreation(data, activationAddress);
        if (pending === null) throw new Error("Prepare account activation before submitting it to Ethereum.");
        if (pending.state === "l1-submitted") throw new Error("Account activation was already submitted to Ethereum.");
        if (pending.state === "broadcast-requested") {
          throw new Error("The previous Ethereum submission result is ambiguous; reconcile it before retrying.");
        }
        const entry = fromHex(pending.transactionHex, "user account creation transaction");
        // A direct creation creates the account of whichever Ethereum account sends it.
        if (submission.mode === "l1" && submission.l1Sender?.toLowerCase() !== activationAddress.toLowerCase()) {
          const creation = decodeTransactionForChain(entry, params.chainId);
          if (creation.kind === TX_KIND_USER_ACCOUNT_CREATION && creation.authorization.kind === "direct") {
            throw new Error(`direct account activation must be sent on Ethereum by ${activationAddress}`);
          }
        }
        const status = await params.node.status();
        await assertActivationContext(pending, status);
        const prepared = await submission.preflight({
          transactionBytes: entry,
          ...(pending.miningTransactionHex === undefined ? {} : { additionalTransactions: [fromHex(pending.miningTransactionHex)] }),
          status,
          retry: true,
        });

        data = await params.store.load();
        pending = pendingUserAccountCreation(data, activationAddress);
        if (data === null || pending === null) {
          throw new Error("Prepared account activation disappeared before submission.");
        }
        if (pending.state !== "prepared") {
          throw new Error("Prepared account activation changed before submission.");
        }
        if (submission.mode === "l1") {
          markPendingUserAccountCreationBroadcastRequested(data, activationAddress);
          await reservation.save(data);
        } else {
          await reservation.assertActive();
        }

        let submitted = false;
        const recordSubmission = async (hash: string) => {
          const data = (await params.store.load())!;
          markPendingUserAccountCreationSubmitted(data, activationAddress, hash);
          await reservation.save(data);
          submitted = true;
          onSubmitted?.(pendingUserAccountCreation(data, activationAddress)!);
        };
        try {
          const result = await submission.submit({
            transactionBytes: entry,
            status,
            retry: true,
            prepared,
            onL1Submitted: recordSubmission,
          });
          if (submission.mode === "l1") {
            if (result.l1Hash === undefined) throw new Error("direct account activation returned no Ethereum transaction hash");
            if (!submitted) await recordSubmission(result.l1Hash);
          } else if (result.accepted) {
            data = (await params.store.load())!;
            removePendingUserAccountCreation(data, activationAddress);
            await reservation.save(data);
          }
          return { ...result, contentHash: pending.contentHash };
        } catch (cause) {
          if (submission.mode === "l1" && submission.isDefinitePreBroadcastError?.(cause) === true) {
            data = await params.store.load() ?? emptyWalletState({
              address: params.wallet.address,
              network: params.store.identity.network,
            });
            const current = pendingUserAccountCreation(data, activationAddress);
            if (current?.state === "broadcast-requested") {
              markPendingUserAccountCreationPrepared(data, activationAddress);
              await reservation.save(data);
            }
          }
          throw cause;
        }
      },
    );
  };

  /**
   * The fee and destination of a transfer, fixed before funding is selected. A
   * journaled payment replays its exact bytes, so its fee is reused.
   */
  const transferPublication = async (
    intent: Omit<NoteFundedTransferIntent, "to"> & { to?: string; expectedReview?: WalletTransferPreflight },
    submission: Pick<DurableSubmissionAdapter, "mode">,
  ): Promise<PublicationPlan> => {
    const openFeeAmount = intent.openFeeAmount ?? intent.expectedReview?.openFeeAmount;
    if (intent.to !== undefined) {
      const data = await params.store.load();
      const pending = data === null ? null : selectedPendingNoteFundedTransfer(data, {
        ...intent,
        to: intent.to,
        ...(openFeeAmount === undefined ? {} : { openFeeAmount }),
      });
      if (pending !== null) {
        return {
          openFeeAmount: BigInt(pending.openFeeAmount),
          privateRelayFeeAmount: BigInt(pending.privateRelayFeeAmount),
          publication: publicationOf(submission, BigInt(pending.privateRelayFeeAmount)),
          beneficiary: pendingIssuanceBeneficiary(pending, params.wallet),
          privateRelayRecipient: pending.privateRelayRecipient,
        };
      }
    }
    const shape = intent.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId;
    const publication = publicationOf(submission, intent.privateRelayFeeAmount ?? intent.expectedReview?.privateRelayFeeAmount);
    const plan = (planned: typeof shape) => planPublication({
      qualifying: true,
      byteSize: paddedPrivateValueByteSize(planned),
      openFeeAmount,
      privateRelayFeeAmount: intent.privateRelayFeeAmount,
      publication,
      selectedRelayQuote: intent.selectedRelayQuote,
      node: params.node,
    });
    let planned = await plan(shape);
    const data = await params.store.load() ?? emptyWalletState({ address: params.wallet.address, network: params.store.identity.network });
    try {
      let resolved = resolvePublicationFunding(planned,
        fee => selectNoteTransferFunding(data, { ...intent, openFeeAmount: fee, privateRelayFeeAmount: 0n }));
      if (openFeeAmount === undefined && intent.shape === undefined && resolved.funding.shape !== shape && resolved.plan.openFeeAmount !== 0n) {
        planned = await plan(resolved.funding.shape);
        resolved = resolvePublicationFunding(planned,
          fee => selectNoteTransferFunding(data, { ...intent, openFeeAmount: fee, privateRelayFeeAmount: 0n }));
      }
      return resolved.plan;
    } catch (error) {
      // Funding preflight presents the full insufficiency report.
      if (!(error instanceof InsufficientNotesError)) throw error;
      return planned;
    }
  };

  const clearAccountActivation = async (): Promise<void> => {
    await params.store.transaction((current) => {
      const data = current ?? emptyWalletState({
        address: params.wallet.address,
        network: params.store.identity.network,
      });
      removePendingUserAccountCreation(data, activationAddress);
      return { data, value: undefined };
    });
  };

  const resetAccountActivationSubmission = async (): Promise<void> => {
    await params.store.transaction((current) => {
      const data = current ?? emptyWalletState({
        address: params.wallet.address,
        network: params.store.identity.network,
      });
      markPendingUserAccountCreationPrepared(data, activationAddress);
      return { data, value: undefined };
    });
  };

  return {
    accountActivation: reconcileAccountActivation,
    recordJournaledL1Hashes,
    prepareAccountActivation,
    submitAccountActivation: (onSubmitted?: (pending: PendingUserAccountCreation) => void) => submitPreparedAccountActivation(undefined, onSubmitted),
    clearAccountActivation,
    resetAccountActivationSubmission,
    async code() {
      await synchronize();
      const mlKemPublicKey = await loadSelfReceiveKey(params.store, params.wallet.address);
      return {
        address: addressHex(params.wallet.address),
        chainId: params.chainId.toString(),
        extendedCode: buildExtendedCode({ address: params.wallet.address, chainId: params.chainId, mlKemPublicKey }),
      };
    },

    async scan(options: {
      rescan?: boolean;
      anchorAtCurrentBoundary?: boolean;
      target?: { pcashNumber: bigint; pcashHash: string };
      status?: StatusResult;
      onProgress?: Parameters<typeof syncWallet>[0]["onProgress"];
      onNodeTip?: Parameters<typeof syncWallet>[0]["onNodeTip"];
    } = {}): Promise<SyncWalletResult> {
      return syncWallet({
        node: params.node,
        wallet: requireReceiveKeys(params.wallet),
        chainId: params.chainId,
        store: params.store,
        ...(options.rescan === true ? { rescan: true } : {}),
        ...(options.anchorAtCurrentBoundary === true ? { anchorAtCurrentBoundary: true } : {}),
        ...(options.target === undefined ? {} : { target: options.target }),
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        ...(options.onNodeTip === undefined ? {} : { onNodeTip: options.onNodeTip }),
      });
    },

    async createReceiveKey(options: { rescan?: boolean } = {}): Promise<{ receiveKeyHash: string }> {
      if (isPcashProfile(params.wallet) && params.wallet.recoveryContract === "seed-derived") {
        throw new Error("seed wallets use one recoverable receive key; rotation is not supported");
      }
      const pair = generateMlKemKeyPair();
      return this.importReceiveKey(pair, options);
    },

    async importReceiveKey(
      pair: MlKemKeyPair,
      options: { rescan?: boolean } = {},
    ): Promise<{ receiveKeyHash: string }> {
      if (isPcashProfile(params.wallet) && params.wallet.recoveryContract === "seed-derived") {
        throw new Error("seed wallets do not import receive keys");
      }
      await retainReceiveKey(pair);
      if (options.rescan !== false) {
        await syncWallet({
          node: params.node,
          wallet: requireReceiveKeys(params.wallet),
          chainId: params.chainId,
          store: params.store,
          rescan: true,
        });
      }
      return { receiveKeyHash: receiveKeyHashHex(pair) };
    },

    async preflightTransfer(intent: Omit<NoteFundedTransferIntent, "to"> & {
      to?: string;
      status?: StatusResult;
      submission?: Pick<DurableSubmissionAdapter, "mode">;
    }): Promise<WalletTransferPreflight> {
      intent = { ...intent, ...(intent.data === undefined ? {} : { data: structuredClone(intent.data) }) };
      const wallet = requirePcashProfile(params, "transfer preflight");
      const status = intent.status ?? await params.node.status();
      // A preflight without a transport reviews the default relayed publication.
      const plan = await transferPublication(intent, intent.submission ?? params.submission ?? { mode: "mempool" });
      const { submission: _submission, ...funding } = intent;
      const notes = await preflightNoteFundedTransferClient({
        node: params.node, store: params.store, wallet, chainId: params.chainId,
        ...funding, openFeeAmount: plan.openFeeAmount, privateRelayFeeAmount: plan.privateRelayFeeAmount, status,
      });
      return {
        openFeeAmount: plan.openFeeAmount,
        privateRelayFeeAmount: plan.privateRelayFeeAmount,
        privateRelayRecipient: plan.privateRelayRecipient,
        beneficiary: plan.beneficiary,
        publication: plan.publication,
        inputCount: notes.inputCount,
        inputTotal: notes.inputTotal,
        retry: notes.retry,
        dataHash: transactionDataHash(intent.data),
      };
    },

    async transfer(intent: NoteFundedTransferIntent & {
      status?: StatusResult;
      submission?: DurableSubmissionAdapter<Prepared, Output>;
      expectedReview?: WalletTransferPreflight;
    } & DurableSubmissionCallbacks) {
      intent = { ...intent, ...(intent.data === undefined ? {} : { data: structuredClone(intent.data) }) };
      const spend = requireSpendable(params, "transfer");
      const status = intent.status ?? await params.node.status();
      const submission = intent.submission ?? params.submission;
      if (submission === undefined) throw new WalletCapabilityError("submission", "transfer");
      const plan = await transferPublication(intent, submission);
      if (params.provers?.privateValue === undefined) throw new WalletCapabilityError("prover", "transfer");
      const result = await runNoteFundedTransferClient({
        node: params.node,
        store: params.store,
        wallet: spend.wallet,
        signer: spend.signer,
        chainId: params.chainId,
        kind: intent.kind ?? "payment",
        to: intent.to,
        amount: intent.amount,
        ...(intent.data === undefined ? {} : { data: intent.data }),
        ...(intent.shape === undefined ? {} : { shape: intent.shape }),
        ...(intent.notBeforeTimestamp === undefined ? {} : { notBeforeTimestamp: intent.notBeforeTimestamp }),
        ...(intent.noteSelector === undefined ? {} : { noteSelector: intent.noteSelector }),
        ...(intent.selectedRelayQuote === undefined ? {} : { selectedRelayQuote: intent.selectedRelayQuote }),
        ...(intent.issuanceOwnerCommitment === undefined ? {} : { issuanceOwnerCommitment: intent.issuanceOwnerCommitment }),
        openFeeAmount: plan.openFeeAmount,
        privateRelayFeeAmount: plan.privateRelayFeeAmount,
        validUntilMode: intent.validUntilMode ?? "exact",
        ...(intent.validUntilTimestamp === undefined
          ? {}
          : { validUntilTimestamp: intent.validUntilTimestamp }),
        ...(intent.retryContentHash === undefined ? {} : { retryContentHash: intent.retryContentHash }),
        ...(intent.newAction === undefined ? {} : { newAction: intent.newAction }),
        ...(intent.signal === undefined ? {} : { signal: intent.signal }),
        ...durableSubmissionCallbacks(intent),
        status,
        ...(intent.expectedReview === undefined ? {} : { expectedReview: intent.expectedReview }),
        prover: params.provers.privateValue,
        submission,
        settlePollIntervalMs: settleInterval,
        settlePollMaxAttempts: settleAttempts, synchronize,
      });
      return { ...result, publicationDetails: actionPublication(result, plan.beneficiary) };
    },

    /** Prove independent mines in memory and publish their exact bytes in one L1 batch. */
    async mineBatch(intent: {
      count: number;
      /** For relay-only publication, the selected pending transactions. */
      relayEntries?: readonly Uint8Array[];
      submission?: DurableSubmissionAdapter<Prepared, Output>;
      signal?: AbortSignal;
    } & DurableSubmissionCallbacks): Promise<{ ownedContentHashes: string[]; submission: DurableSubmissionResult<Output> }> {
      if (!Number.isInteger(intent.count) || intent.count < 0 || intent.count > MAX_MINE_ACTIONS) throw new Error(`mine count must be between 0 and ${MAX_MINE_ACTIONS}`);
      const submission = intent.submission ?? params.submission;
      if (submission?.mode !== "l1") throw new Error("Mining and relaying require self-publication on L1.");
      const actions: Array<PreparedNoteFundedTransfer & { anchor: { blockHash: bigint; timestamp: bigint } }> = [];
      if (intent.count > 0) {
        const spend = requireSpendable(params, "mine");
        const prover = params.provers?.privateValue;
        if (prover === undefined) throw new WalletCapabilityError("prover", "mine");
        for (let index = 0; index < intent.count; index += 1) {
          throwIfWalletActionCanceled(intent.signal);
          const { preparedAction, anchor } = await prepareNoteFundedTransfer({
            ...params, wallet: spend.wallet, signer: spend.signer, prover, submission,
            kind: "mine", to: activationAddress, amount: 0n, openFeeAmount: 0n,
            ...(intent.signal === undefined ? {} : { signal: intent.signal }),
            onProgress: (phase) => intent.onProgress?.(phase, `Proving ${index + 1} of ${intent.count}`),
          }, [], PRIVATE_VALUE_PROFILES.S.shapeId);
          actions.push({ ...preparedAction, anchor });
        }
      }
      const entries = actions.length > 0 ? actions.map(action => action.transactionBytes) : [...(intent.relayEntries ?? [])];
      if (entries.length === 0) throw new Error("No transactions available to relay.");
      throwIfWalletActionCanceled(intent.signal);
      const status = await params.node.status();
      // The batch is quoted and sent under this status's network.
      assertWalletStoreMatches(params.store, params.wallet, params.chainId, status);
      // Relay entries are node mempool bytes; a direct account creation among
      // them would register at this wallet's L1 sender.
      if (actions.length === 0) for (const entry of entries) assertMempoolAdmissible(status, entry);
      intent.onProgress?.("preparing", "Preparing the Ethereum transaction…");
      const prepared = await submission.preflight({ transactionBytes: entries[0]!, status,
        additionalTransactions: entries.slice(1), retry: false });
      for (const action of actions) await intent.beforeJournal?.(action.pending.contentHash, action.pending.transactionHex);
      throwIfWalletActionCanceled(intent.signal);
      await params.store.transaction(current => {
        const data = current ?? emptyWalletState({ address: params.wallet.address, network: params.store.identity.network });
        for (const action of actions) addPendingNoteFundedTransfer(data, action.pending);
        return { data, value: undefined };
      });
      const recordMinesSubmitted = async (hash: string) => {
        if (actions.length === 0) return;
        await params.store.transaction(current => {
          const data = current ?? emptyWalletState({ address: params.wallet.address, network: params.store.identity.network });
          for (const action of actions) markPendingNoteFundedTransferL1Submitted(data, action.pending.contentHash, hash);
          return { data, value: undefined };
        });
      };
      let result: DurableSubmissionResult<Output>;
      let submissionStarted = false;
      try {
        for (const action of actions) await intent.onPrepared?.(action.pending.contentHash, action.pending.transactionHex);
        if (actions.length > 0) {
          const current = await params.node.status();
          const wallTime = BigInt(Math.floor((intent.nowUnixMilliseconds ?? Date.now)() / 1000));
          const inclusionTime = current.latestBlockTimestamp > wallTime ? current.latestBlockTimestamp : wallTime;
          for (const action of actions) {
            const anchor = await params.node.getBlockByHash(bytes32Hex(action.anchor.blockHash));
            if (anchor === null || inclusionTime + 60n > action.anchor.timestamp + RECENT_PCASH_BLOCK_WINDOW_SECONDS
              || inclusionTime + 60n > BigInt(action.pending.validUntilTimestamp)) {
              throw new DurablePreBroadcastError(new Error("Mining proofs expired while preparing. Please try again."));
            }
          }
        }
        throwIfWalletActionCanceled(intent.signal);
        intent.onProgress?.("submitting", "Confirm the Ethereum transaction…");
        submissionStarted = true;
        result = await submission.submit({ transactionBytes: entries[0]!, status, prepared, retry: false,
          onL1Submitted: recordMinesSubmitted });
      } catch (error) {
        // Ambiguous broadcasts remain recoverable through the exact L1 journal.
        if (!submissionStarted || error instanceof DurablePreBroadcastError || submission.isDefinitePreBroadcastError?.(error)) {
          await params.store.transaction(current => {
            const data = current ?? emptyWalletState({ address: params.wallet.address, network: params.store.identity.network });
            for (const action of actions) removePendingNoteFundedTransfer(data, action.pending.contentHash);
            return { data, value: undefined };
          });
        }
        throw error;
      }
      if (result.l1Hash !== undefined) await recordMinesSubmitted(result.l1Hash);
      intent.onProgress?.("confirming", "Checking PCASH results…");
      try { await synchronize(); }
      catch (error) { if (!isWalletSyncConflict(error)) throw error; }
      return { ownedContentHashes: actions.map(action => action.pending.contentHash), submission: result };
    },

    async assetCreation(intent: AssetCreationIntent & { submission?: DurableSubmissionAdapter<Prepared, Output> }) {
      const spend = requireSpendable(params, "asset creation");
      if (params.provers?.assetCreation === undefined) throw new WalletCapabilityError("prover", "asset creation");
      const submission = intent.submission ?? params.submission;
      if (submission === undefined) throw new WalletCapabilityError("submission", "asset creation");
      return runAssetCreationClient({
        ...intent, node: params.node, store: params.store, wallet: spend.wallet, signer: spend.signer,
        chainId: params.chainId, prover: params.provers.assetCreation, submission,
        settlePollIntervalMs: settleInterval, settlePollMaxAttempts: settleAttempts, synchronize,
      });
    },

    async assetTransfer(intent: AssetTransferIntent & { submission?: DurableSubmissionAdapter<Prepared, Output> }) {
      const spend = requireSpendable(params, "asset transfer");
      if (params.provers?.assetAction === undefined) throw new WalletCapabilityError("prover", "asset transfer");
      const submission = intent.submission ?? params.submission;
      if (submission === undefined) throw new WalletCapabilityError("submission", "asset transfer");
      return runAssetTransferClient({
        ...intent, node: params.node, store: params.store, wallet: spend.wallet, signer: spend.signer,
        chainId: params.chainId, prover: params.provers.assetAction, submission,
        settlePollIntervalMs: settleInterval, settlePollMaxAttempts: settleAttempts, synchronize,
      });
    },

    async startBulkJob(intent: Omit<Parameters<typeof startBulkJob>[0], "node" | "store" | "wallet" | "chainId">) {
      const wallet = requirePcashProfile(params, "bulk job");
      return startBulkJob({ ...intent, node: params.node, store: params.store, wallet, chainId: params.chainId });
    },

    async runBulkJobStep(intent: WalletBulkJobStepIntent<Prepared, Output>) {
      const spend = requireSpendable(params, "bulk job");
      if (params.provers?.assetAction === undefined) throw new WalletCapabilityError("prover", "bulk job");
      const submission = intent.submission ?? params.submission;
      if (submission === undefined) throw new WalletCapabilityError("submission", "bulk job");
      return runBulkJobStep({
        jobId: intent.jobId,
        ...(intent.chunkIndex === undefined ? {} : { chunkIndex: intent.chunkIndex }),
        ...(intent.privateRelayFeeAmount === undefined ? {} : { privateRelayFeeAmount: intent.privateRelayFeeAmount }),
        ...(intent.selectedRelayQuote === undefined ? {} : { selectedRelayQuote: intent.selectedRelayQuote }),
        node: params.node, store: params.store, wallet: spend.wallet, signer: spend.signer,
        chainId: params.chainId, prover: params.provers.assetAction, submission,
        callbacks: durableSubmissionCallbacks(intent),
      });
    },

    async contractCreation(intent: WalletContractCreationIntent<Prepared, Output>) {
      const spend = requireSpendable(params, "contract creation");
      if (params.provers?.sponsoredContractCreation === undefined) {
        throw new WalletCapabilityError("prover", "contract creation");
      }
      const submission = intent.submission ?? params.submission;
      if (submission === undefined) throw new WalletCapabilityError("submission", "contract creation");
      return runSponsoredContractCreationClient({
        node: params.node,
        store: params.store,
        wallet: spend.wallet,
        signer: spend.signer,
        chainId: params.chainId,
        contract: intent.contract,
        ...(intent.openFeeAmount === undefined ? {} : { openFeeAmount: intent.openFeeAmount }),
        ...(intent.privateRelayFeeAmount === undefined ? {} : { privateRelayFeeAmount: intent.privateRelayFeeAmount }),
        ...(intent.issuanceOwnerCommitment === undefined ? {} : { issuanceOwnerCommitment: intent.issuanceOwnerCommitment }),
        ...(intent.selectedRelayQuote === undefined ? {} : { selectedRelayQuote: intent.selectedRelayQuote }),
        ...(intent.noteSelector === undefined ? {} : { noteSelector: intent.noteSelector }),
        ...(intent.validUntilTimestamp === undefined ? {} : { validUntilTimestamp: intent.validUntilTimestamp }),
        ...(intent.validUntilMode === undefined ? {} : { validUntilMode: intent.validUntilMode }),
        submission,
        settlePollIntervalMs: settleInterval,
        settlePollMaxAttempts: settleAttempts, synchronize,
        prover: params.provers.sponsoredContractCreation,
        ...durableSubmissionCallbacks(intent),
      });
    },

    async contractSponsorship(intent: WalletContractSponsorshipIntent<Prepared, Output>) {
      const spend = requireSpendable(params, "contract sponsorship");
      const submission = intent.submission ?? params.submission;
      if (submission === undefined) throw new WalletCapabilityError("submission", "contract sponsorship");
      return runSponsoredContractAssetActionClient({
        ...intent,
        node: params.node,
        store: params.store,
        wallet: spend.wallet,
        signer: spend.signer,
        chainId: params.chainId,
        submission,
        settlePollIntervalMs: settleInterval,
        settlePollMaxAttempts: settleAttempts,
        synchronize,
        ...durableSubmissionCallbacks(intent),
      });
    },

    async account(intent: WalletAccountIntent<Prepared, Output> = {}) {
      assertReceiveKeyChangeAllowed(intent.receiveKey);
      const spend = requireSpendable(params, "account");
      const current = await localAccount(params.store, addressHex(params.wallet.address));
      if (current !== null) {
        if (params.provers?.userAccountUpdate === undefined) throw new WalletCapabilityError("prover", "account");
        const submission = intent.submission ?? params.submission;
        if (submission === undefined) throw new WalletCapabilityError("submission", "account");
        return runUserAccountUpdateClient({
          node: params.node,
          store: params.store,
          address: spend.wallet.address,
          wallet: spend.wallet,
          signer: spend.signer,
          chainId: params.chainId,
          receiveKey: intent.receiveKey ?? { operation: "keep" },
          ...(intent.ruleSetCommitment === undefined
            ? {}
            : { ruleSetCommitment: intent.ruleSetCommitment }),
          ...(intent.validUntilTimestamp === undefined
            ? {}
            : { validUntilTimestamp: intent.validUntilTimestamp }),
          ...(intent.openFeeAmount === undefined ? {} : { openFeeAmount: intent.openFeeAmount }),
          ...(intent.privateRelayFeeAmount === undefined ? {} : { privateRelayFeeAmount: intent.privateRelayFeeAmount }),
          ...(intent.issuanceOwnerCommitment === undefined ? {} : { issuanceOwnerCommitment: intent.issuanceOwnerCommitment }),
          ...(intent.selectedRelayQuote === undefined ? {} : { selectedRelayQuote: intent.selectedRelayQuote }),
          submission,
          settlePollIntervalMs: settleInterval,
          settlePollMaxAttempts: settleAttempts, synchronize,
          prover: params.provers.userAccountUpdate,
          ...durableSubmissionCallbacks(intent),
        });
      }
      intent.onProgress?.("preparing", "preparing the user account submission…");
      await prepareAccountActivation(intent);
      intent.onProgress?.("submitting", "submitting the user account…");
      return submitPreparedAccountActivation(
        intent.userAccountCreationSubmission ?? params.userAccountCreationSubmission ?? intent.submission,
      );
    },
  };
}
