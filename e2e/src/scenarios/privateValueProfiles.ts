import { transactionIdentity } from "@pcash/sdk/protocol";
import type { RelaySubmissionResult } from "@pcash/sdk/relay";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { decodeTransaction, SlotClass } from "@pcash/sdk/protocol";
import { createWalletProvers } from "@pcash/sdk/wallet/node";
import { openNodeWallet } from "@pcash/wallet";
import { runBulkJobStep, startBulkJob, type AssetActionProver } from "@pcash/sdk/wallet/actions";
import { walletAction, type DurableSubmissionAdapter } from "@pcash/sdk/wallet";
import { buildExtendedCode } from "@pcash/sdk/delivery";
import { bytes32Hex, fromHex } from "@pcash/sdk/utils";
import { scanWallet } from "@pcash/sdk/wallet/scanning";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import type { HarnessSubmission } from "../fixture/harness.ts";
import { setupUserWallets } from "./setup.ts";
import { eventually } from "../framework/eventually.ts";

/** Native L distribution/consolidation, durable restart, actual blob DA, and L-to-S spending. */
export async function runPrivateValueProfilesScenario(fixture: ScenarioFixture): Promise<void> {
  const balances = await setupUserWallets(fixture, { actors: ["S", "R"], accounts: ["S"], funded: ["S"] });
  const sender = fixture.actors.S!;
  const recipient = fixture.actors.R!;
  // This scenario reopens both inventories itself to prove the bulk-job journal survives a restart.
  await Promise.all([sender.close(), recipient.close()]);
  const node = fixture.nodeA.client;
  const chainId = fixture.network.pcashChainId;
  const receiveCode = buildExtendedCode({ address: recipient.wallet.address, chainId, mlKemPublicKey: recipient.wallet.mlKemPublicKey });
  const publications: Record<string, unknown>[] = [];
  const proving: Record<string, unknown>[] = [];
  const nativeProver = createWalletProvers("native").assetAction;
  const prover: AssetActionProver = {
    shapes: nativeProver.shapes,
    async proveAndEncode(build, authorization) {
      const started = performance.now();
      const entry = await nativeProver.proveAndEncode(build, authorization);
      proving.push({ shape: build.shape, realInputs: build.transaction.inputs.filter(input => input.slotClass !== SlotClass.DUMMY).length,
        realOutputs: build.transaction.outputs.filter(output => output.slotClass !== SlotClass.DUMMY).length,
        proveAndEncodeMs: performance.now() - started, wireBytes: entry.length });
      return entry;
    },
  };
  // Each wallet publishes its own actions: they pay no open fee and name its own
  // commitment for their issuance. Automatic DA must choose blobs for L.
  const submissionFor = (publisher: typeof sender): HarnessSubmission => {
    const published = fixture.harness.l1(publisher.wallet, "auto");
    return {
      ...published,
      async submit(context) {
        const { transactionBytes: entry } = context;
        const { contentHash } = transactionIdentity(entry);
        const decoded = decodeTransaction(entry);
        if (decoded.kind !== 0) throw new Error("profile scenario only publishes private-value actions");
        const before = await node.status();
        const started = performance.now();
        const result = await published.submit(context);
        const output = (result.output as { relay: RelaySubmissionResult }).relay;
        const accepted = await fixture.waitForAcceptedAcrossNodes(contentHash, `profile-${decoded.shape}`);
        const delivery = await node.getInboxDeliveryBatch(output.txHash);
        if (delivery === null) throw new Error("profile publication has no derived L1 delivery");
        if (decoded.shape === PRIVATE_VALUE_PROFILES.L.shapeId && delivery.carrierType !== "blob") {
          throw new Error("automatic L publication did not select blobs");
        }
        const publishAndDeriveMs = performance.now() - started;
        const retained = await eventually("indexed profile history", () => node.getTransaction(accepted.nodeA.transactionId), result => result !== null, { timeoutMs: 10_000 });
        if (retained === null || retained.rawTransaction.toLowerCase() !== `0x${Buffer.from(entry).toString("hex")}`) {
          throw new Error("node history did not retain the exact admitted profile bytes");
        }
        publications.push({ shape: decoded.shape, carrier: delivery.carrierType, wireBytes: entry.length,
          retainedTransactionBytes: fromHex(retained.rawTransaction).length,
          carrierBytes: delivery.carrierLength, blobCount: delivery.blobVersionedHashes.length,
          outputLeavesAdded: (await node.status()).outputCount - before.outputCount,
          publishAndDeriveMs, l1Hash: output.txHash });
        return result;
      },
    };
  };
  const open = (actor: typeof sender) => openNodeWallet({ dataDir: actor.walletDatabasePath, node,
    profile: actor.wallet, signer: actor.signer, provers: createWalletProvers("native"), submission: submissionFor(actor) });
  const count = PRIVATE_VALUE_PROFILES.L.outputs;
  const available = balances.S!;
  const each = available / BigInt(count);
  if (each < 2n) throw new Error("profile fixture needs a positive distribution allocation");
  let sending = await open(sender);
  let jobId: string;
  try {
    await sending.sync();
    jobId = await sending.execute(walletAction("profile:approve-airdrop", async ({ store }) => {
      const job = await startBulkJob({ node, store, wallet: sender.wallet, chainId, kind: "payment",
        shape: PRIVATE_VALUE_PROFILES.L.shapeId, openFeeAmount: 0n, maxTransactions: 1,
        recipients: Array.from({ length: count }, (_, index) => ({ to: receiveCode,
          amount: index === count - 1 ? available - each * BigInt(count - 1) : each })) });
      return job.jobId;
    }));
  } finally { await sending.close(); }
  // Resume an approved job from disk, without retaining its in-memory manifest.
  sending = await open(sender);
  try {
    const result = await sending.execute(walletAction("profile:run-airdrop", ({ store }) => runBulkJobStep({
      jobId, node, store, wallet: sender.wallet, signer: sender.signer, chainId,
      prover, submission: submissionFor(sender),
    })));
    if (result.state !== "submitted" || !result.result.accepted) throw new Error("L airdrop was not accepted");
  } finally { await sending.close(); }
  // Fresh-seed recovery uses the node only, including the final L output slot.
  const restoreStarted = performance.now();
  const restored = (await scanWallet(node, recipient.wallet, chainId)).recovered.filter(note => note.assetId === 0n);
  const restoreMs = performance.now() - restoreStarted;
  const late = restored.find(note => note.outputIndex === count - 1);
  if (restored.length !== count || late === undefined || restored.reduce((sum, note) => sum + note.amount, 0n) !== available) {
    throw new Error("fresh recipient did not recover every L allocation");
  }
  if ((await node.getAccountProof(recipient.address)).status === "present") throw new Error("airdrop recipient was unexpectedly registered");
  let receiving = await open(recipient);
  try {
    const selfPublished = fixture.harness.l1(recipient.wallet);
    const registration = await receiving.updateAccount({ submission: selfPublished, userAccountCreationSubmission: selfPublished });
    await fixture.waitForAcceptedAcrossNodes(registration.contentHash, "profile-register-after-receipt");
    await receiving.sync();
    const spent = await receiving.send({ shape: PRIVATE_VALUE_PROFILES.S.shapeId, to: sender.address,
      amount: late.amount - 1n, noteSelector: bytes32Hex(late.outputCommitment) });
    if (!spent.accepted || decodeTransaction(fromHex(spent.transactionHex)).kind !== 0 || publications.at(-1)?.shape !== 0) {
      throw new Error("L-created late output was not spent through S");
    }
    await receiving.sync();
    await receiving.execute(walletAction("profile:consolidate", async ({ store }) => {
      const job = await startBulkJob({ node, store, wallet: recipient.wallet, chainId,
        kind: "consolidation", shape: PRIVATE_VALUE_PROFILES.L.shapeId, openFeeAmount: 0n, maxTransactions: 1 });
      const result = await runBulkJobStep({ jobId: job.jobId, node, store, wallet: recipient.wallet,
        signer: recipient.signer, chainId, prover, submission: submissionFor(recipient) });
      if (result.state !== "submitted" || !result.result.accepted) throw new Error("L consolidation was not accepted");
    }));
  } finally { await receiving.close(); }
  receiving = await open(recipient);
  try {
    await receiving.sync();
    const consolidated = await receiving.execute(walletAction("profile:inspect-restart", async ({ store }) => {
      const data = (await store.load())!;
      const jobs = data.bulkJobs!;
      if (jobs.length !== 1 || jobs[0]!.chunks.length !== 1 || jobs[0]!.chunks[0]!.shape !== 1
        || jobs[0]!.chunks[0]!.action.inputs.filter(input => input.spentCommitment !== null).length !== PRIVATE_VALUE_PROFILES.L.inputs) {
        throw new Error("restart did not retain the full-input L consolidation manifest");
      }
      const action = jobs[0]!.chunks[0]!.action;
      const output = action.ownedOutputs[0]!;
      const note = data.notes.find(note => BigInt(note.noteSecret) === BigInt(output.noteSecret) && note.leafIndex !== null);
      if (note?.commitment == null) throw new Error("consolidated owner change was not recovered after restart");
      return { amount: BigInt(output.amount), commitment: BigInt(note.commitment) };
    }));
    const spent = await receiving.send({ shape: PRIVATE_VALUE_PROFILES.S.shapeId, to: sender.address,
      amount: consolidated.amount - 1n,
      noteSelector: bytes32Hex(consolidated.commitment) });
    if (!spent.accepted || publications.at(-1)?.shape !== PRIVATE_VALUE_PROFILES.S.shapeId) {
      throw new Error("L consolidation output was not spendable through S after restart");
    }
  } finally { await receiving.close(); }
  fixture.artifacts.record("private-value-profiles-complete", { publications, proving, restoreMs, restoredOutputs: restored.length, lateSlot: late.outputIndex });
}
