import { randomBytes } from "node:crypto";
import {
  SlotClass,
  buildAssetAction,
  createStandardFungibleAsset,
  fullOutputCommitment,
  openedAssetActionOutput,
  ownerChangeAssetActionOutput,
  prepareAssetAction,
  createReleaseChonkCircuitResolver,
  nativeChonkBackend,
  proveAssetCreationChonk,
  proveTransferTransactionChonk,
  requestPcashAuthorization,
  bytes32Hex,
  randomFieldEntropy,
  sizeClassFiller,
  submitPreparedAssetAction,
  toField,
  openNodeWallet,
  walletAction,
  type AssetActionBuild,
  type AssetActionInput,
  type AssetActionOutput,
  type CreatedStandardFungibleAsset,
  type NetworkConfigLike,
  type PcashNodeClient,
  type PreparedAssetAction,
} from "../deps.ts";
import type { DurableSubmissionAdapter } from "@pcash/sdk/wallet";
import { coherentAssetSnapshot, listSpendableNotes, type SpendableNote } from "../actors/sdk.ts";
import type { ScenarioWalletActor } from "./types.ts";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { setupUserWallets } from "./setup.ts";

export interface AssetAcceptedAction {
  label: string;
  contentHash: string;
}

export interface AssetScenarioContext {
  network: NetworkConfigLike & { pcashChainId: bigint };
  node: PcashNodeClient;
  proofDirectory: string;
  /** Creates the asset, holds the majority, and spends it. */
  creator: ScenarioWalletActor;
  /** Receives an allocation directly from the creation. */
  holder: ScenarioWalletActor;
  /** Receives an allocation through an ordinary asset transfer. */
  recipient: ScenarioWalletActor;
  initialSupply: bigint;
  /** Positive native fee on the funded transfer; the open route pays it and issuance to the batch poster. */
  openFeeAmount: bigint;
  burnAmount: bigint;
  /** Return a fresh latest-head deadline immediately before each action is built. */
  nextValidUntilTimestamp(): Promise<bigint>;
  submitAndWait(entry: Uint8Array, label: string): Promise<AssetAcceptedAction>;
  /** Submit an action that consensus must refuse, returning the observed reason. */
  submitExpectingRejection(entry: Uint8Array, label: string): Promise<string>;
  /** Exact-batch adapters may return only after finality has reconciled the reservation. */
  expectUnfinalizedReservation?: boolean;
}

export interface AssetScenarioResult {
  assetId: string;
  metadata: { name: string; symbol: string; decimals: number };
  initialSupply: string;
  creation: AssetAcceptedAction & {
    creatorAmounts: string[];
    holderAmount: string;
  };
  fundedTransfer: AssetAcceptedAction & {
    paymentAmount: string;
    changeAmount: string;
    openFeeAmount: string;
    nativeChangeAmount: string;
  };
  mergeBurn: AssetAcceptedAction & {
    mergedInputAmounts: string[];
    nativeInputAmount: string;
    burnAmount: string;
    outputAmount: string;
    openFeeAmount: string;
    nativeChangeAmount: string;
  };
  balances: {
    creator: string;
    holder: string;
    recipient: string;
    circulating: string;
  };
  controls: {
    creationMarker: string;
    reshapedRecreationRejected: string;
  };
}

const DUMMY_INPUT: AssetActionInput = { kind: "dummy" };

function dummyOutput(): AssetActionOutput {
  return { kind: "dummy", dummySecret: randomFieldEntropy(), amount: 0n, outputData: sizeClassFiller() };
}

/** Pad the real outputs to the five the relation always carries. */
function outputSlots(real: readonly AssetActionOutput[]): readonly [
  AssetActionOutput,
  AssetActionOutput,
  AssetActionOutput,
  AssetActionOutput,
  AssetActionOutput,
] {
  if (real.length > 5) throw new Error("an asset action carries at most five outputs");
  const slots = [...real];
  while (slots.length < 5) slots.push(dummyOutput());
  return slots as unknown as readonly [
    AssetActionOutput,
    AssetActionOutput,
    AssetActionOutput,
    AssetActionOutput,
    AssetActionOutput,
  ];
}

/** Pad the real inputs to the four slots every asset action declares. */
function inputSlots(real: readonly AssetActionInput[]): readonly [
  AssetActionInput,
  AssetActionInput,
  AssetActionInput,
  AssetActionInput,
] {
  if (real.length > 4) throw new Error("an asset action carries at most four inputs");
  const slots = [...real];
  while (slots.length < 4) slots.push(DUMMY_INPUT);
  return slots as unknown as readonly [
    AssetActionInput,
    AssetActionInput,
    AssetActionInput,
    AssetActionInput,
  ];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assets: ${message}`);
}

/**
 * The marker the fixed-supply relation publishes. Every reshaped creation of
 * one asset derives the same marker, so the spent-nullifier set admits at most
 * one of them. Read from the build rather than recomputed from the secret, so
 * the two creation shapes are genuinely compared through the builder.
 */
function creationMarker(build: AssetActionBuild): bigint {
  const marker = build.transaction.inputs.find((input) => input.slotClass === SlotClass.ASSET_CREATION);
  if (marker === undefined) throw new Error("assets: a creation build carries no marker slot");
  return toField(marker.nullifier, "creation marker");
}

function outputCommitmentOf(actor: ScenarioWalletActor, note: SpendableNote): bigint {
  return fullOutputCommitment(
    {
      owner: actor.wallet.address,
      noteSecret: note.noteSecret,
      assetId: note.assetId,
      amount: note.amount,
    },
    note.leafIndex,
  );
}

function assetInput(note: SpendableNote, siblings: bigint[]): AssetActionInput {
  return {
    kind: note.assetId === 0n ? "native" : "asset",
    amount: note.amount,
    noteSecret: note.noteSecret,
    leafIndex: Number(note.leafIndex),
    siblings,
  } as AssetActionInput;
}

function assetOutputTo(params: {
  actor: ScenarioWalletActor;
  chainId: bigint;
  assetId: bigint;
  outputIndex: number;
  amount: bigint;
  kind: "asset" | "native";
}): { output: AssetActionOutput; noteSecret: bigint } {
  const noteSecret = randomFieldEntropy();
  const receiveKey = params.actor.wallet.mlKemPublicKey;
  assert(receiveKey !== undefined, `${params.actor.name} has no published receive key`);
  return {
    noteSecret,
    output: openedAssetActionOutput({
      kind: params.kind,
      pcashChainId: params.chainId,
      assetId: params.kind === "native" ? 0n : params.assetId,
      outputIndex: params.outputIndex,
      recipientAddress: params.actor.wallet.address,
      recipientMlKemPublicKey: receiveKey,
      authenticatedRecipient: true,
      noteSecret,
      amount: params.amount,
    }),
  };
}

/**
 * Change back to the acting account. The readable rules open it under the
 * secret the builder derives from `nkRoot` and the transaction's nullifiers, so
 * the opening is read back from the build rather than chosen here.
 */
function ownerChangeOutput(params: {
  actor: ScenarioWalletActor;
  chainId: bigint;
  assetId: bigint;
  amount: bigint;
  kind: "asset" | "native";
}): AssetActionOutput {
  const receiveKey = params.actor.wallet.mlKemPublicKey;
  assert(receiveKey !== undefined, `${params.actor.name} has no published receive key`);
  return ownerChangeAssetActionOutput({
    kind: params.kind,
    pcashChainId: params.chainId,
    assetId: params.kind === "native" ? 0n : params.assetId,
    amount: params.amount,
    receiveKey,
  });
}

/**
 * Encode the proved kernel, re-validate the exact bytes against the build, and
 * keep the durable reservation the wallet client journals.
 */
function encodeAssetEntry(params: {
  build: AssetActionBuild;
  proof: Uint8Array;
  ownedOutputs: readonly { outputIndex: number; assetId: bigint; amount: bigint; owner: bigint; noteSecret: bigint }[];
}): PreparedAssetAction {
  const entry = params.build.encodeTransaction(params.proof);
  return prepareAssetAction({
    build: params.build,
    transactionBytes: entry,
    ownedOutputs: params.ownedOutputs,
  });
}

/**
 * Prove owner rule → owner-input batch → standard parent → common kernel.
 *
 * A transfer verifies one owner batch before the common kernel.
 */
async function proveOwnedAction(params: {
  build: AssetActionBuild;
  actor: ScenarioWalletActor;
  network: NetworkConfigLike;
}): Promise<Uint8Array> {
  const prepared = params.build.prepareOwnerAuthorization({
    wallet: params.actor.wallet,
    network: params.network,
  });
  const authorization = await requestPcashAuthorization(params.actor.signer, prepared.request);
  const witness = prepared.authorize(authorization).witnessMap;
  const resolve = createReleaseChonkCircuitResolver();
  if (params.build.operation === "assetCreation") {
    return (await proveAssetCreationChonk({build:params.build,authorization:{packageName:prepared.authorizationCircuit,witnessMap:witness},resolve,backend:nativeChonkBackend()})).proof;
  }
  return (await proveTransferTransactionChonk({build:params.build,authorizationPackage:prepared.authorizationCircuit,authorizationWitnessMap:witness,resolve,backend:nativeChonkBackend()})).proof;
}

/**
 * Submit through the wallet client's durable path: journal the reservation and
 * owned outputs, submit the exact bytes, then reconcile. The consensus route is
 * unchanged; what this covers is the production machinery a wallet depends on.
 */
async function submitThroughWalletJournal(
  ctx: AssetScenarioContext,
  actor: ScenarioWalletActor,
  prepared: PreparedAssetAction,
  label: string,
): Promise<AssetAcceptedAction> {
  const submission: DurableSubmissionAdapter<undefined, AssetAcceptedAction> = {
    mode: "mempool" as const,
    preflight: async (): Promise<undefined> => undefined,
    submit: async (context: { transactionBytes: Uint8Array }) => {
      const accepted = await ctx.submitAndWait(context.transactionBytes, label);
      return { accepted: true, queued: false, output: accepted };
    },
  };
  const wallet = await openNodeWallet({
    dataDir: actor.walletDatabasePath,
    node: ctx.node,
    profile: actor.wallet,
    signer: actor.signer,
  });
  try {
    return await wallet.execute(walletAction("asset:submit", async ({ node, store }) => {
      const status = await node.status();
      const data = await store.load();
      if (data === null) throw new Error(`${label}: wallet has not been synchronized`);
      const outcome = await submitPreparedAssetAction({
        node,
        store,
        data,
        status,
        preparedAction: prepared,
        submission,
        preparedSubmission: undefined,
      });
      assert(outcome.accepted, `${label}: the durable submission never reached canonical acceptance`);
    // A reservation is released only by a FINALIZED receipt or deadline expiry,
    // and this journey follows latest and never waits for finality. So after
    // canonical acceptance the row must still be here, holding the exact bytes:
    // retention across a possible reorg is the property, not prompt cleanup.
      const reloaded = await store.load();
      assert(reloaded !== null, `${label}: the wallet database disappeared after submission`);
      if (ctx.expectUnfinalizedReservation !== false) {
        const journaled = (reloaded.pendingAssetActions ?? []).find(
          (action) => action.contentHash.toLowerCase() === outcome.contentHash.toLowerCase(),
        );
        assert(journaled !== undefined, `${label}: the wallet journal lost the reservation at acceptance`);
        assert(
          journaled.transactionHex.toLowerCase() === outcome.transactionHex.toLowerCase(),
          `${label}: the journaled reservation does not hold the submitted bytes`,
        );
        assert(
          reloaded.notes.some(
            (note) => note.pending && note.pendingContentHash?.toLowerCase() === outcome.contentHash.toLowerCase(),
          ),
          `${label}: the wallet journal persisted no owned output for the action`,
        );
      }
      return { label, contentHash: outcome.contentHash };
    }));
  } finally {
    await wallet.close();
  }
}

async function assetBalance(
  ctx: AssetScenarioContext,
  actor: ScenarioWalletActor,
  assetId: bigint,
): Promise<bigint> {
  const notes = await listSpendableNotes(ctx.node, actor.wallet, ctx.network.pcashChainId, assetId);
  return notes.reduce((total, note) => total + note.amount, 0n);
}

async function spendableAssetNotes(
  ctx: AssetScenarioContext,
  actor: ScenarioWalletActor,
  assetId: bigint,
): Promise<SpendableNote[]> {
  const notes = await listSpendableNotes(ctx.node, actor.wallet, ctx.network.pcashChainId, assetId);
  return notes.sort((left, right) => (left.amount > right.amount ? -1 : left.amount < right.amount ? 1 : 0));
}

function creationSplit(initialSupply: bigint): { first: bigint; second: bigint; holder: bigint } {
  const first = initialSupply / 2n;
  const second = initialSupply / 4n;
  const holder = initialSupply - first - second;
  if (first <= 0n || second <= 0n || holder <= 0n) {
    throw new Error(`initial supply ${initialSupply} is too small to allocate three creation outputs`);
  }
  return { first, second, holder };
}

/**
 * Exercise the standard fungible asset relations against the selected network:
 * one-shot asset creation through the asset-creation kernel, an owner-authorized
 * transfer that funds a positive native fee, a merge that folds two asset
 * inputs and one native input into a single owner batch while burning, and the
 * consensus refusal of a second creation of the same asset.
 */
export async function runAssetScenarioFlow(
  ctx: AssetScenarioContext,
): Promise<AssetScenarioResult> {
  const chainId = ctx.network.pcashChainId;
  const { creator, holder, recipient } = ctx;
  const created: CreatedStandardFungibleAsset = createStandardFungibleAsset({
    metadata: {
      name: "E2E Scenario Token",
      symbol: "LJT",
      decimals: 6,
      contentDigest: randomBytes(32),
    },
    initialSupply: ctx.initialSupply,
  });
  const assetId = toField(created.descriptor.assetId, "assetId");
  const split = creationSplit(ctx.initialSupply);

  // --- one-shot asset creation -------------------------------------------
  const creationSnapshot = await coherentAssetSnapshot({
    node: ctx.node,
    wallet: creator.wallet,
    network: ctx.network,
    notes: [],
    defaultRuleSecrets: creator.wallet.defaultUserRuleSecrets,
    selectedDefaultRule: "asset-creation",
  });
  const creationOutputs = [
    assetOutputTo({ actor: creator, chainId, assetId, outputIndex: 0, amount: split.first, kind: "asset" }),
    assetOutputTo({ actor: creator, chainId, assetId, outputIndex: 1, amount: split.second, kind: "asset" }),
    assetOutputTo({ actor: holder, chainId, assetId, outputIndex: 2, amount: split.holder, kind: "asset" }),
  ];
  const creationBuild = buildAssetAction({
    pcashChainId: chainId,
    snapshot: creationSnapshot.snapshot,
    owner: creationSnapshot.owner,
    assetDescriptor: created.descriptor,
    assetSecret: created.assetSecret,
    inputs: inputSlots([{ kind: "creation-marker" }]),
    outputs: outputSlots(creationOutputs.map((entry) => entry.output)),
    openFeeAmount: 0n,
    issuanceOwnerCommitment: 0n,
    validUntilTimestamp: await ctx.nextValidUntilTimestamp(),
  });
  const creationPrepared = encodeAssetEntry({
    build: creationBuild,
    proof: await proveOwnedAction({build:creationBuild,actor:creator,network:ctx.network}),
    ownedOutputs: [
      { outputIndex: 0, assetId, amount: split.first, owner: creator.wallet.address, noteSecret: creationOutputs[0]!.noteSecret },
      { outputIndex: 1, assetId, amount: split.second, owner: creator.wallet.address, noteSecret: creationOutputs[1]!.noteSecret },
    ],
  });
  const creation = await ctx.submitAndWait(creationPrepared.transactionBytes, "asset:create");

  // Asset creation is one-shot because it spends this marker. Prove the current
  // nullifier set really took it, so the refusal below has a known cause.
  const marker = creationMarker(creationBuild);
  const markerStatus = await ctx.node.getCurrentNullifierStatuses([bytes32Hex(marker)]);
  assert(
    markerStatus.statuses[0]?.spent === true,
    "creation did not spend the creation marker",
  );

  assert(
    await assetBalance(ctx, creator, assetId) === split.first + split.second,
    "creator did not recover both creation allocations",
  );
  assert(
    await assetBalance(ctx, holder, assetId) === split.holder,
    "holder did not recover its creation allocation",
  );

  // --- transfer with change and an ordinary native fee note ---
  const creatorAssetNotes = await spendableAssetNotes(ctx, creator, assetId);
  const spentAssetNote = creatorAssetNotes[0];
  assert(spentAssetNote !== undefined, "creator has no spendable asset note");
  const paymentAmount = spentAssetNote.amount / 4n;
  const changeAmount = spentAssetNote.amount - paymentAmount;
  const nativeFunding = (await spendableAssetNotes(ctx, creator, 0n))[0];
  assert(nativeFunding !== undefined && nativeFunding.amount > ctx.openFeeAmount, "no native note can cover the fee");
  const nativeChangeAmount = nativeFunding.amount - ctx.openFeeAmount;
  assert(paymentAmount > 0n, "asset payment must be positive");

  const transferSnapshot = await coherentAssetSnapshot({
    node:ctx.node,wallet:creator.wallet,network:ctx.network,
    notes:[spentAssetNote,nativeFunding].map(note=>({leafIndex:note.leafIndex,commitment:outputCommitmentOf(creator,note)})),
    defaultRuleSecrets:creator.wallet.defaultUserRuleSecrets,selectedDefaultRule:"asset-payment",
  });
  const transferPayment = assetOutputTo({ actor: recipient, chainId, assetId, outputIndex: 0, amount: paymentAmount, kind: "asset" });
  const transferBuild = buildAssetAction({
    pcashChainId: chainId,
    snapshot: transferSnapshot.snapshot,
    assetId,
    owner: transferSnapshot.owner,
    inputs: [
      assetInput(spentAssetNote, transferSnapshot.noteSiblings[0]!),
      assetInput(nativeFunding, transferSnapshot.noteSiblings[1]!),
      { kind: "dummy" },
      { kind: "dummy" },
    ],
    outputs: [
      transferPayment.output,
      ownerChangeOutput({ actor: creator, chainId, assetId, amount: changeAmount, kind: "asset" }),
      ownerChangeOutput({actor:creator,chainId,assetId:0n,amount:nativeChangeAmount,kind:"native"}),
      dummyOutput(),
      dummyOutput(),
    ],
    openFeeAmount: ctx.openFeeAmount,
    issuanceOwnerCommitment: 0n,
    validUntilTimestamp: await ctx.nextValidUntilTimestamp(),
  });
  const transferPrepared = encodeAssetEntry({
    build: transferBuild,
    proof: await proveOwnedAction({
      build: transferBuild,
      actor: creator,
      network: ctx.network,
    }),
    ownedOutputs: [
      { outputIndex: 1, assetId, amount: changeAmount, owner: creator.wallet.address, noteSecret: transferBuild.outputNoteSecrets[1]! },
      { outputIndex: 2, assetId:0n, amount:nativeChangeAmount, owner: creator.wallet.address, noteSecret:transferBuild.outputNoteSecrets[2]! },
    ],
  });
  const fundedTransfer = await submitThroughWalletJournal(
    ctx,
    creator,
    transferPrepared,
    "asset:funded-transfer",
  );

  assert(
    await assetBalance(ctx, recipient, assetId) === paymentAmount,
    "recipient did not recover the transferred asset note",
  );

  // --- merge two notes and burn part of the merged input ------------------
  // The realistic maximum-complexity single-owner action: two asset inputs and
  // one native input folded into ONE owner batch, burning part of the asset
  // input while the native side funds a positive fee and returns change. The
  // masks, descriptors, and both conservation sums only interact here.
  const mergeNotes = (await spendableAssetNotes(ctx, creator, assetId)).slice(0, 2);
  assert(mergeNotes.length === 2, "creator does not hold two asset notes to merge");
  const mergeNativeNote = (await spendableAssetNotes(ctx, creator, 0n))[0];
  assert(mergeNativeNote !== undefined, "creator has no native note to fund the merge fee");
  assert(
    mergeNativeNote.amount > ctx.openFeeAmount,
    `native note ${mergeNativeNote.amount} cannot fund fee ${ctx.openFeeAmount} and leave change`,
  );
  const mergedInput = mergeNotes.reduce((total, note) => total + note.amount, 0n);
  assert(mergedInput > ctx.burnAmount, `merged input ${mergedInput} cannot cover burn ${ctx.burnAmount}`);
  const mergeOutputAmount = mergedInput - ctx.burnAmount;
  const mergeNativeChange = mergeNativeNote.amount - ctx.openFeeAmount;
  const mergeInputNotes = [...mergeNotes, mergeNativeNote];
  const mergeSnapshot = await coherentAssetSnapshot({
    node: ctx.node,
    wallet: creator.wallet,
    network: ctx.network,
    notes: mergeInputNotes.map((note) => ({
      leafIndex: note.leafIndex,
      commitment: outputCommitmentOf(creator, note),
    })),
    defaultRuleSecrets: creator.wallet.defaultUserRuleSecrets,
    selectedDefaultRule: "asset-burn",
  });
  const mergeOutputs = [
    ownerChangeOutput({ actor: creator, chainId, assetId, amount: mergeOutputAmount, kind: "asset" }),
    ownerChangeOutput({ actor: creator, chainId, assetId, amount: mergeNativeChange, kind: "native" }),
  ];
  const mergeBuild = buildAssetAction({
    pcashChainId: chainId,
    snapshot: mergeSnapshot.snapshot,
    assetId,
    owner: mergeSnapshot.owner,
    inputs: inputSlots(mergeInputNotes.map((note, index) => assetInput(note, mergeSnapshot.noteSiblings[index]!))),
    outputs: outputSlots(mergeOutputs),
    assetBurnAmount: ctx.burnAmount,
    openFeeAmount: ctx.openFeeAmount,
    issuanceOwnerCommitment: 0n,
    validUntilTimestamp: await ctx.nextValidUntilTimestamp(),
  });
  const mergePrepared = encodeAssetEntry({
    build: mergeBuild,
    proof: await proveOwnedAction({
      build: mergeBuild,
      actor: creator,
      network: ctx.network,
    }),
    ownedOutputs: [
      { outputIndex: 0, assetId, amount: mergeOutputAmount, owner: creator.wallet.address, noteSecret: mergeBuild.outputNoteSecrets[0]! },
      { outputIndex: 1, assetId: 0n, amount: mergeNativeChange, owner: creator.wallet.address, noteSecret: mergeBuild.outputNoteSecrets[1]! },
    ],
  });
  const mergeBurn = await ctx.submitAndWait(mergePrepared.transactionBytes, "asset:merge-burn");

  const creatorBalance = await assetBalance(ctx, creator, assetId);
  const holderBalance = await assetBalance(ctx, holder, assetId);
  const recipientBalance = await assetBalance(ctx, recipient, assetId);
  assert(creatorBalance === mergeOutputAmount, "creator balance does not match the merged output");
  assert(
    creatorBalance + holderBalance + recipientBalance === ctx.initialSupply - ctx.burnAmount,
    "circulating supply does not equal the initial supply minus the burn",
  );

  // --- a reshaped second creation of the same asset must be refused -------
  const recreateSnapshot = await coherentAssetSnapshot({
    node: ctx.node,
    wallet: creator.wallet,
    network: ctx.network,
    notes: [],
    defaultRuleSecrets: creator.wallet.defaultUserRuleSecrets,
    selectedDefaultRule: "asset-creation",
  });
  const recreateOutput = assetOutputTo({
    actor: creator,
    chainId,
    assetId,
    outputIndex: 0,
    amount: ctx.initialSupply,
    kind: "asset",
  });
  const recreateBuild = buildAssetAction({
    pcashChainId: chainId,
    snapshot: recreateSnapshot.snapshot,
    owner: recreateSnapshot.owner,
    assetDescriptor: created.descriptor,
    assetSecret: created.assetSecret,
    inputs: inputSlots([{ kind: "creation-marker" }]),
    outputs: outputSlots([recreateOutput.output]),
    openFeeAmount: 0n,
    issuanceOwnerCommitment: 0n,
    validUntilTimestamp: await ctx.nextValidUntilTimestamp(),
  });
  const recreatePrepared = encodeAssetEntry({
    build: recreateBuild,
    proof: await proveOwnedAction({build:recreateBuild,actor:creator,network:ctx.network}),
    ownedOutputs: [
      { outputIndex: 0, assetId, amount: ctx.initialSupply, owner: creator.wallet.address, noteSecret: recreateOutput.noteSecret },
    ],
  });
  assert(
    creationMarker(recreateBuild) === marker,
    "a reshaped creation of one asset must derive the same marker",
  );
  const reshapedRecreationRejected = await ctx.submitExpectingRejection(
    recreatePrepared.transactionBytes,
    "asset:recreate-rejected",
  );
  // The refusal must be the spent creation marker. Any other rejection — a
  // malformed entry, an unusable proof, an unreachable node — would leave this
  // control green while proving nothing about one-shot creation.
  assert(
    /nullifier/i.test(reshapedRecreationRejected),
    "a reshaped re-creation must be refused on the already-spent creation marker, got: "
      + reshapedRecreationRejected,
  );
  assert(
    await assetBalance(ctx, creator, assetId) === mergeOutputAmount,
    "a refused re-creation changed the creator balance",
  );

  return {
    assetId: `0x${assetId.toString(16)}`,
    metadata: {
      name: created.metadata.name,
      symbol: created.metadata.symbol,
      decimals: created.metadata.decimals,
    },
    initialSupply: ctx.initialSupply.toString(),
    creation: {
      ...creation,
      creatorAmounts: [split.first.toString(), split.second.toString()],
      holderAmount: split.holder.toString(),
    },
    fundedTransfer: {
      ...fundedTransfer,
      paymentAmount: paymentAmount.toString(),
      changeAmount: changeAmount.toString(),
      openFeeAmount: ctx.openFeeAmount.toString(),
      nativeChangeAmount: nativeChangeAmount.toString(),
    },
    mergeBurn: {
      ...mergeBurn,
      mergedInputAmounts: mergeNotes.map((note) => note.amount.toString()),
      nativeInputAmount: mergeNativeNote.amount.toString(),
      burnAmount: ctx.burnAmount.toString(),
      outputAmount: mergeOutputAmount.toString(),
      openFeeAmount: ctx.openFeeAmount.toString(),
      nativeChangeAmount: mergeNativeChange.toString(),
    },
    balances: {
      creator: creatorBalance.toString(),
      holder: holderBalance.toString(),
      recipient: recipientBalance.toString(),
      circulating: (creatorBalance + holderBalance + recipientBalance).toString(),
    },
    controls: {
      creationMarker: bytes32Hex(marker),
      reshapedRecreationRejected,
    },
  };
}

/** Run the asset lifecycle between three of a fixture's actors, relaying every action. */
export function runFixtureAssetFlow(
  fixture: ScenarioFixture,
  actors: { creator: ScenarioWalletActor; holder: ScenarioWalletActor; recipient: ScenarioWalletActor },
  label = "assets",
): Promise<AssetScenarioResult> {
  const initialSupply = fixture.config.assets.initialSupply;
  return runAssetScenarioFlow({
    network: fixture.network,
    node: fixture.nodeA.client,
    proofDirectory: fixture.artifacts.path("proofs", label),
    ...actors,
    initialSupply,
    openFeeAmount: fixture.config.assets.actionFee,
    burnAmount: initialSupply / 100n,
    nextValidUntilTimestamp: async () => (await fixture.nodeA.client.status()).latestBlockTimestamp + 1_800n,
    async submitAndWait(entry, submissionLabel) {
      const accepted = await fixture.submitAndWait(entry, submissionLabel);
      return { label: submissionLabel, contentHash: accepted.contentHash };
    },
    submitExpectingRejection: (entry, submissionLabel) => fixture.submitExpectingRejection(entry, submissionLabel),
  });
}

/** Private creation, a native-fee transfer, merge, burn, and re-creation refusal. */
export async function runAssetsScenario(fixture: ScenarioFixture): Promise<void> {
  await setupUserWallets(fixture, { actors: ["S", "M", "R"], accounts: [], funded: ["S"] });
  const { S, M, R } = fixture.actors;
  const result = await runFixtureAssetFlow(fixture, { creator: S!, holder: M!, recipient: R! });
  fixture.artifacts.record("assets-complete", { result });
}
