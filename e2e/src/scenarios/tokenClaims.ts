import { transactionIdentity } from "@pcash/sdk/protocol";
import { createHash } from "node:crypto";
import { FileRelayJournal, PrivateKeyRelaySubmitter } from "@pcash/sdk/node";
import { bytes32Hex } from "@pcash/sdk/utils";
import type { AssetProver } from "@pcash/sdk/browser-prover/requests";
import { createWalletProvers } from "@pcash/sdk/wallet/node";
import { openMemoryNodeWallet } from "@pcash/wallet";
import { createL1SubmissionAdapter, type DurableSubmissionAdapter, type SubmissionOutput, type SubmissionPrepared, type Wallet } from "@pcash/sdk/wallet";
import {
  buildClaimLinkSpend,
  buildDropClaim,
  claimantAccount,
  claimLinkContractOf,
  claimLinkNote,
  dropInventory,
  fundedLeaves,
  parseClaimLink,
  readDropEligibility,
  readTemplateWitness,
  templateProofRequest,
  type TransferTemplateAction,
  type DropInventoryNote,
} from "@pcash/tokens";
import { isTokensError, MemoryTokensStore, TokensApp, type AvailableDrop, type TokensErrorCode } from "@pcash/tokens/app";
import { nativeTokensProver } from "@pcash/tokens/tooling/nativeProver";
import { l1Rpc } from "../backends/rpc.ts";
import type { ScenarioActor } from "../actors/actor.ts";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { setupUserWallets } from "./setup.ts";

const CLAIM_PAGE = "https://pcash.example/claim";
const VALIDITY = 1_800n;

/**
 * The token application layer against a real node: bearer claim links and an
 * eligibility drop, created, claimed, refused, and reclaimed by in-process
 * wallets with native provers.
 */
export async function runTokenClaimsScenario(fixture: ScenarioFixture): Promise<void> {
  // Alice (S) creates FOO, Bob (R) claims, Dave (M) registers only after the drop's cutoff.
  await setupUserWallets(fixture, { actors: ["S", "R", "M"], accounts: ["S", "R"], funded: ["S"] });
  const { S: aliceActor, R: bobActor, M: daveActor } = fixture.actors;
  if (!aliceActor || !bobActor || !daveActor) throw new Error("token actors are missing");
  // Fast posts each actor's actions on Ethereum with its own key.
  await Promise.all([fixture.fundL1Gas(aliceActor.address, 24), fixture.fundL1Gas(bobActor.address, 8), fixture.fundL1Gas(daveActor.address, 8)]);
  const node = fixture.nodeA.client;
  const chainId = fixture.network.pcashChainId;
  const prover = nativeTokensProver();
  const log = (message: string) => fixture.artifacts.record("token-claims-progress", { message });

  // Fast: each actor posts its own actions on Ethereum with its own key.
  const fast = (actor: ScenarioActor, label: string): DurableSubmissionAdapter<SubmissionPrepared, SubmissionOutput> => {
    const submitter = new PrivateKeyRelaySubmitter({
      privateKey: actor.privateKey,
      rpcUrl: fixture.backend.rpcUrl,
      node,
      journal: new FileRelayJournal(fixture.artifacts.path(`token-claims-${label}.l1-journal.json`)),
    });
    const direct = createL1SubmissionAdapter({
      node, submitterFor: () => submitter, payoutRecipient: () => actor.wallet, daMode: "calldata",
    });
    return {
      ...direct,
      async submit(context) {
        const posted = await direct.submit(context);
        await fixture.waitForAcceptedAcrossNodes(transactionIdentity(context.transactionBytes).contentHash, `token-claims-${label}`);
        return { ...posted, accepted: true, queued: false };
      },
    };
  };
  // Relayed: exact bytes into the node's mempool, included by the fixture relayer.
  const relayed = (label: string): DurableSubmissionAdapter<undefined, unknown> => ({
    mode: "mempool",
    preflight: async () => undefined,
    async submit({ transactionBytes: entry }) {
      const accepted = await fixture.submitAndWait(entry, `token-claims-${label}`);
      return { accepted: true, queued: false, output: accepted };
    },
  });
  const open = async (actor: ScenarioActor): Promise<Wallet> => {
    const wallet = await openMemoryNodeWallet({
      node,
      profile: actor.wallet,
      signer: actor.signer,
      provers: createWalletProvers("native"),
      submission: fast(actor, actor.name) as DurableSubmissionAdapter,
      settlePollIntervalMs: 1_000,
      settlePollMaxAttempts: 180,
    });
    await wallet.sync();
    return wallet;
  };
  const app = (wallet: Wallet, store = new MemoryTokensStore(), submission?: DurableSubmissionAdapter) => new TokensApp({
    wallet, node, prover, store, pollIntervalMs: 1_000, pollMaxAttempts: 180,
    ...(submission === undefined ? {} : { submission }),
  });
  const refuses = async (label: string, run: Promise<unknown>, code: TokensErrorCode): Promise<void> => {
    try {
      await run;
    } catch (error) {
      if (isTokensError(error, code)) return;
      throw new Error(`${label}: expected ${code}`, { cause: error });
    }
    throw new Error(`${label}: expected ${code}, but it succeeded`);
  };
  const holding = async (wallet: Wallet, assetId: bigint): Promise<bigint> => {
    await wallet.sync();
    const asset = (await wallet.assets()).find((candidate) => candidate.assetId === assetId);
    if (asset?.definition?.metadata.symbol !== "FOO") throw new Error(`${wallet.address} does not hold the verified FOO definition`);
    return asset.private;
  };
  const proveEntry = async (action: TransferTemplateAction, proving: AssetProver = prover): Promise<Uint8Array> =>
    action.build.encodeTransaction((await proving.proveAssetAction(templateProofRequest(action))).proof);
  const latest = async () => (await node.status()).latestBlockTimestamp;

  let alice = await open(aliceActor);
  const bob = await open(bobActor);
  const aliceStore = new MemoryTokensStore();
  try {
    const supply = 1_000_000n;
    const created = await alice.createAsset({
      metadata: { name: "Foo", symbol: "FOO", decimals: 6, contentDigest: createHash("sha256").update("FOO token terms").digest() },
      initialSupply: supply,
    });
    if (!created.accepted) throw new Error("FOO creation was not accepted");
    const assetId = created.assetId;
    if (await holding(alice, assetId) !== supply) throw new Error("Alice does not hold the FOO supply");
    log("FOO created");

    // Links: two funded links; Bob claims one by self-publication.
    const set = await app(alice, aliceStore).createLinkSet({ assetId, amounts: [100n, 250n] });
    if (set.phase !== "ready") throw new Error("link set is not ready");
    const urls = await app(alice, aliceStore).linkSetUrls(set.key, CLAIM_PAGE);
    log("link set funded");
    const bobApp = app(bob);
    const inspected = await bobApp.inspectLink(urls[0]!);
    if (inspected.status !== "claimable" || inspected.amount !== 100n || inspected.assetId !== assetId
      || inspected.definition.metadata.symbol !== "FOO") throw new Error("Bob's link does not show 100 claimable FOO");
    const claimed = await bobApp.claimLink(urls[0]!);
    if (!claimed.accepted || claimed.role !== "transfer") throw new Error("Bob's self-published link claim was not an accepted transfer-role claim");
    if (await holding(bob, assetId) !== 100n) throw new Error("Bob does not hold the claimed FOO");
    log("Bob claimed a link");

    // The same link cannot be claimed again: the app refuses, and the node rejects a forced spend.
    if ((await bobApp.inspectLink(urls[0]!)).status !== "claimed") throw new Error("the claimed link is not reported claimed");
    await refuses("second link claim", bobApp.claimLink(urls[0]!), "link-claimed");
    const shared = parseClaimLink(urls[0]!);
    const linkContract = claimLinkContractOf(shared);
    const [leafIndex] = await fundedLeaves(node, [shared.funding]);
    if (leafIndex === null || leafIndex === undefined) throw new Error("the link's funding has no accepted receipt");
    const link = { ...shared, leafIndex };
    const linkNote = claimLinkNote(linkContract, link);
    const spentWitness = await readTemplateWitness(node, {
      contract: linkContract.address,
      notes: [{ leafIndex: linkNote.leafIndex, outputCommitment: linkNote.outputCommitment }],
      nullifiers: [linkNote.nullifier],
    });
    if (spentWitness === null || !spentWitness.spent[0]) throw new Error("the claimed link note is not spent");
    const forcedLink = buildClaimLinkSpend({
      contract: linkContract,
      pcashChainId: chainId,
      snapshot: spentWitness.snapshot,
      contractOpening: spentWitness.contractOpening,
      notes: [{ ...link, siblings: spentWitness.notes[0]!.siblings }],
      recipient: { address: bobActor.wallet.address, receiveKey: bobActor.wallet.mlKemPublicKey },
      role: { kind: "transfer" },
      validUntilTimestamp: await latest() + VALIDITY,
      assetDefinition: link.definition,
    });
    if (forcedLink.role !== "transfer") throw new Error("forced link spend is not in the transfer role");
    await fixture.submitExpectingRejection(await proveEntry(forcedLink), "token-claims-link-double-claim");
    log("second link claim refused");

    // Alice reloads, finds the set from its stored record, and claims the other link herself through the relay, paying its fee.
    await alice.close();
    alice = await open(aliceActor);
    const reloaded = app(alice, aliceStore, relayed("link-creator-claim") as DurableSubmissionAdapter);
    const [storedSet] = await reloaded.linkSets();
    if (storedSet?.key !== set.key || storedSet.phase !== "ready") throw new Error("the link set did not survive a reload");
    const before = await reloaded.linkSetStatus(set.key);
    if (JSON.stringify(before.claims?.map((claim) => claim.state)) !== JSON.stringify(["claimed", "unclaimed"])) {
      throw new Error("link set status after Bob's claim is wrong");
    }
    const creatorClaim = await reloaded.claimUnclaimedLinks(set.key, { openFeeAmount: fixture.config.assets.actionFee });
    if (!creatorClaim.accepted || creatorClaim.role !== "sponsored" || JSON.stringify(creatorClaim.claimed) !== "[1]" || creatorClaim.remaining !== 0) {
      throw new Error("Alice's sponsored claim did not take the unclaimed link");
    }
    if ((await reloaded.linkSetStatus(set.key)).claims?.some((claim) => claim.state !== "claimed")) throw new Error("a link is still unclaimed");
    if (await holding(alice, assetId) !== supply - 100n) throw new Error("Alice's FOO after claiming the other link is wrong");
    log("Alice claimed the other link");

    // Drop: cutoff at the latest block, two inventory notes.
    let aliceApp = app(alice, aliceStore);
    const status = await node.status();
    const claimEndTimestamp = status.latestBlockTimestamp + 900n;
    const drop = await aliceApp.createDrop({ assetId, claimAmount: 50n, count: 2, cutoffBlockNumber: status.latestBlock, claimEndTimestamp });
    if (drop.phase !== "ready") throw new Error("the drop is not ready");
    log("drop funded and published");

    // Dave registers only after the cutoff.
    const registration = await (await daveActor.client()).updateAccount({ submission: fixture.harness.l1(daveActor.wallet) });
    await fixture.waitForAcceptedAcrossNodes(registration.contentHash, "token-claims-late-account");
    const dave = await open(daveActor);
    try {
      const listed = (await bobApp.availableDrops()).find((candidate) => candidate.id === drop.contractAddress);
      if (listed === undefined || listed.assetId !== assetId || listed.definition.metadata.symbol !== "FOO") {
        throw new Error("the catalog does not list Alice's verified drop");
      }
      const eligibility = await bobApp.dropEligibility(listed);
      if (eligibility.status !== "eligible") throw new Error(`Bob is not eligible: ${eligibility.message}`);
      const dropClaim = await bobApp.claimDrop(listed);
      if (!dropClaim.accepted || dropClaim.amount !== 50n) throw new Error("Bob's drop claim was not accepted");
      if (await holding(bob, assetId) !== 150n) throw new Error("Bob does not hold the dropped FOO");
      log("Bob claimed the drop");

      // Bob's second claim: the app refuses, and the node rejects a forced claim of the other note.
      if ((await bobApp.dropEligibility(listed)).status !== "claimed") throw new Error("Bob's claim is not reported");
      await refuses("second drop claim", bobApp.claimDrop(listed), "drop-claimed");
      const inventory = await dropInventory(node, listed.drop, listed.funding);
      if (inventory.length !== listed.count) throw new Error("the drop's funding does not resolve to its inventory");
      const remaining = (await node.getCurrentNullifierStatuses(inventory.map((note) => bytes32Hex(note.nullifier))))
        .statuses.flatMap((result, index) => result.spent ? [] : [inventory[index]!]);
      if (remaining.length !== 1) throw new Error("the drop should have one unclaimed note");
      const forcedSecond = await forcedDropClaim(listed, remaining[0]!, bobActor);
      await fixture.submitExpectingRejection(await proveEntry(forcedSecond), "token-claims-drop-double-claim");
      log("Bob's second drop claim refused");

      // Application refusal is exercised here; the package proving test owns the cutoff constraint.
      const daveApp = app(dave);
      const daveEligibility = await daveApp.dropEligibility(listed);
      if (daveEligibility.status !== "ineligible") throw new Error(`Dave should be ineligible: ${daveEligibility.message}`);
      await refuses("late account claim", daveApp.claimDrop(listed), "drop-ineligible");
      log("Dave refused");

      // A half-finished distribution: one full S chunk pays four of six recipients (the token change takes the fifth slot), then every local wallet/application store is discarded.
      await refuses("early drop reclaim", aliceApp.reclaimDrop(drop.key), "drop-open");
      const distributionRecipients = Array.from({ length: 6 }, () => ({ to: bob.address, amount: 1n }));
      const distribution = await alice.startBulkJob({
        kind: "payment", assetId, recipients: distributionRecipients, openFeeAmount: 0n,
        maxTransactions: distributionRecipients.length, shape: 0, recovery: { appTag: Uint8Array.of(0) },
      });
      const firstDistribution = await alice.runBulkJobStep({ jobId: distribution.jobId });
      if (firstDistribution.state !== "submitted") throw new Error(`first distribution chunk was ${firstDistribution.state}`);
      await alice.sync();
      await alice.close();
      alice = await open(aliceActor);
      const recoveredStore = new MemoryTokensStore();
      aliceApp = app(alice, recoveredStore);
      const recoveredSet = (await aliceApp.linkSets()).find(candidate => candidate.key === set.key);
      if (recoveredSet?.phase !== "ready") throw new Error("the link set was not recovered after every local store was discarded");
      const recoveredUrls = await aliceApp.linkSetUrls(recoveredSet.key, CLAIM_PAGE);
      if (JSON.stringify(recoveredUrls) !== JSON.stringify(urls)) throw new Error("the recovered claim-link URLs changed");
      const recoveredDrop = (await aliceApp.drops()).find(candidate => candidate.key === drop.key);
      if (recoveredDrop === undefined) throw new Error("the funded drop was not recovered after every local store was discarded");
      const recoveredDistribution = (await alice.bulkRecoveries()).find(candidate =>
        candidate.appTag.length === 1 && candidate.appTag[0] === 0 && candidate.recipientCount === distributionRecipients.length);
      if (recoveredDistribution === undefined
        || JSON.stringify(recoveredDistribution.paidOriginalIndexes) !== JSON.stringify([0, 1, 2, 3])
        || recoveredDistribution.resumeAfterTimestamp === null) {
        throw new Error("the half-finished distribution recovery is incomplete");
      }
      const safeResumeTimestamp = recoveredDistribution.resumeAfterTimestamp + 1n;
      await advanceTo(fixture, safeResumeTimestamp > claimEndTimestamp ? safeResumeTimestamp : claimEndTimestamp + 1n);
      await alice.sync();
      const resumedDistribution = await alice.startBulkJob({
        kind: "payment", assetId, recipients: distributionRecipients, openFeeAmount: 0n,
        maxTransactions: distributionRecipients.length, shape: 0,
        recovery: { appTag: Uint8Array.of(0), resumeRecoveryJobId: recoveredDistribution.recoveryJobId },
      });
      if (resumedDistribution.recipients.length !== 2
        || JSON.stringify(resumedDistribution.recovery?.originalIndexes) !== JSON.stringify([4, 5])) {
        throw new Error("distribution recovery did not retain only the unpaid recipients");
      }
      for (;;) {
        const step = await alice.runBulkJobStep({ jobId: resumedDistribution.jobId });
        if (step.state === "complete") break;
        if (step.state !== "submitted" && step.state !== "waiting-for-confirmation" && step.state !== "chunk-complete") {
          throw new Error(`resumed distribution stopped at ${step.state}`);
        }
        await alice.sync();
      }
      if (await holding(bob, assetId) !== 156n) throw new Error("distribution recovery did not pay exactly the remaining recipients");
      log("browser-store loss recovered token links, drop inventory and distribution progress");

      // After the claim window, Alice reclaims the remaining recovered drop note without relying on the local publication record.
      const dropReclaim = await aliceApp.reclaimDrop(drop.key);
      if (!dropReclaim.accepted || dropReclaim.reclaimed !== 1 || dropReclaim.remaining !== 0) throw new Error("Alice did not reclaim the drop");
      if ((await aliceApp.dropStatus(drop.key)).remaining !== 0) throw new Error("the drop still has inventory");
      if (await holding(alice, assetId) !== supply - 156n) throw new Error("Alice's FOO after the drop reclaim is wrong");
      log("Alice reclaimed the drop");
    } finally {
      await dave.close();
    }
    fixture.artifacts.record("token-claims-complete", { assetId: `0x${assetId.toString(16)}`, linkSet: set.key, drop: drop.key });
  } finally {
    await Promise.allSettled([alice.close(), bob.close()]);
  }

  /** An unsponsored claim built from the node's openings, skipping the app's eligibility refusal. */
  async function forcedDropClaim(listed: AvailableDrop, note: DropInventoryNote, claimant: ScenarioActor): Promise<TransferTemplateAction> {
    const witness = await readTemplateWitness(node, {
      contract: listed.drop.address,
      notes: [{ leafIndex: note.leafIndex, outputCommitment: note.outputCommitment }],
      nullifiers: [],
      accounts: [claimant.wallet.address],
    });
    const account = witness?.accounts[0];
    if (witness === null || account === null || account === undefined) throw new Error("forced claim openings are missing");
    const eligibility = await readDropEligibility(node, listed.drop, {
      hash: witness.snapshot.recentPcashBlockHash,
      number: witness.recentBlockNumber,
    });
    if (eligibility === null) throw new Error("the cutoff block is not in history");
    const end = listed.drop.configuration.claimEndTimestamp;
    const until = await latest() + VALIDITY;
    const action = buildDropClaim({
      drop: listed.drop,
      pcashChainId: chainId,
      snapshot: witness.snapshot,
      contractOpening: witness.contractOpening,
      inventory: { index: note.index, leafIndex: note.leafIndex, siblings: witness.notes[0]!.siblings },
      claimant: {
        address: claimant.wallet.address,
        nkRoot: claimant.wallet.nkRoot,
        receiveKey: claimant.wallet.mlKemPublicKey,
        account: claimantAccount(account),
      },
      eligibility,
      role: { kind: "transfer" },
      validUntilTimestamp: until < end ? until : end,
      assetDefinition: listed.definition,
    });
    if (action.role !== "transfer") throw new Error("forced drop claim is not in the transfer role");
    return action;
  }
}

/** Cross an expiry boundary without deriving hundreds of empty blocks. */
async function advanceTo(fixture: ScenarioFixture, target: bigint): Promise<void> {
  if (!fixture.backend.mine || !fixture.backend.setNextTimestamp) throw new Error("the backend cannot advance its clock");
  const latest = BigInt((await l1Rpc<{ timestamp: string }>(fixture.backend.rpcUrl, "eth_getBlockByNumber", ["latest", false])).timestamp);
  if (target > latest) {
    await fixture.backend.setNextTimestamp(target);
    await fixture.backend.mine();
  }
  await fixture.waitForNodesAtL1Head();
}
