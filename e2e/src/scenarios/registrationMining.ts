import assert from "node:assert/strict";
import { FileRelayJournal, PrivateKeyRelaySubmitter } from "@pcash/sdk/node";
import { prepareTransactionForL1, submitPreparedTransactionToL1, type PreparedL1Transaction, type RelaySubmissionResult } from "@pcash/sdk/relay";
import { decodeBatch, decodeTransaction, transactionIdentity, posterPayoutOpening, privateValuePublicInputs } from "@pcash/sdk/protocol";
import { fromHex, randomFieldEntropy, toHex } from "@pcash/sdk/utils";
import { createWalletProvers } from "@pcash/sdk/wallet/node";
import { openNodeWallet } from "@pcash/wallet";
import { createL1SubmissionAdapter, type DurableSubmissionAdapter, type L1SubmissionAdapter } from "@pcash/sdk/wallet";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { l1Rpc } from "../backends/rpc.ts";
import { assertSystemPayoutRecovered } from "./payouts.ts";

/**
 * One new account, one batch, real proofs, durable reopen, recovered spendable
 * issuance. A direct authorization names the Ethereum sender, so each actor
 * publishes its own carriers here instead of the harness.
 */
export async function runRegistrationMiningScenario(fixture: ScenarioFixture): Promise<void> {
  await fixture.createActors(["S", "R", "N"]);
  const actor = fixture.actors.S!;
  const newcomer = fixture.actors.R!;
  // Both inventories are reopened below with this scenario's own transports.
  await Promise.all([actor.close(), newcomer.close()]);
  const node = fixture.nodeA.client;
  await fixture.fundL1Gas(actor.address, 2);
  await fixture.fundL1Gas(newcomer.address, 3);
  const submitter = new PrivateKeyRelaySubmitter({ node, privateKey: actor.privateKey as `0x${string}`,
    rpcUrl: fixture.backend.rpcUrl, journal: new FileRelayJournal(fixture.artifacts.path("setup-mining-journal")) });
  let published: Uint8Array[] = [];
  const direct = createL1SubmissionAdapter({
    node, submitterFor: () => submitter, payoutRecipient: () => actor.wallet, daMode: "calldata", l1Sender: actor.address,
  });
  const submission: L1SubmissionAdapter = {
    ...direct,
    async submit(context) {
      published = [...direct.describeBatch(context.prepared).transactions];
      return direct.submit(context);
    },
  };
  const open = () => openNodeWallet({ dataDir: actor.walletDatabasePath, node,
    profile: actor.wallet, signer: actor.signer, provers: createWalletProvers("native"),
    submission, userAccountCreationSubmission: submission });
  let wallet = await open();
  const prepared = await wallet.prepareAccountActivation({ authorizationMode: "direct", mine: true });
  const combined = decodeTransaction(fromHex(prepared.transactionHex));
  assert.equal(combined.kind, 0);
  if (combined.kind !== 0) throw new Error("setup must be a value transaction");
  assert.equal(combined.accountCreation?.kind, "user");
  const miningContentHash = prepared.contentHash;
  await wallet.close();
  wallet = await open();
  try {
    assert.deepEqual(await wallet.prepareAccountActivation({ authorizationMode: "direct", mine: true }), prepared);
    const result = await wallet.submitAccountActivation();
    assert.equal(result.accepted, true);
    assert.deepEqual(published.map(toHex), [prepared.transactionHex]);
    assert.equal(decodeTransaction(published[0]!).kind, 0);
    const registration = await fixture.waitForAcceptedAcrossNodes(prepared.contentHash, "batch-registration");
    const mining = await fixture.waitForAcceptedAcrossNodes(miningContentHash, "batch-mining");
    assert.equal(registration.nodeA.inclusion.l1TransactionIndex, mining.nodeA.inclusion.l1TransactionIndex);
    assert.equal(registration.nodeA.inclusion.l1BlockHash, mining.nodeA.inclusion.l1BlockHash);
    assert.equal(BigInt(mining.nodeA.inclusion.batchItemIndex), 0n);
    assert.equal((await node.getAccountProof(actor.address)).status, "present");
    const { receipt } = await assertSystemPayoutRecovered({ node, chainId: fixture.network.pcashChainId,
      contentHash: miningContentHash, label: "registration mining", sourceKind: "designatedIssuance", recipient: actor.wallet });
    assert.ok(receipt.settledIssuanceAmount > 0n);
    await wallet.sync({ awaitFunds: true });
    assert.equal((await wallet.nativeFunds()).total, receipt.settledIssuanceAmount);
    const payment = await wallet.send({ to: actor.address, amount: 1n, openFeeAmount: 0n });
    assert.equal(payment.accepted, true, "setup issuance is immediately spendable through ordinary historical authorization");
    fixture.artifacts.record("registration-mining-complete", { registration: prepared.contentHash, mining: miningContentHash,
      issuance: receipt.settledIssuanceAmount, payment: payment.contentHash });
  } finally { await wallet.close(); }

  // R mines before it has an account. An expired registration in the same
  // carrier must not invalidate the ordinary action that follows it.
  const newcomerSubmitter = new PrivateKeyRelaySubmitter({ node, privateKey: newcomer.privateKey as `0x${string}`,
    rpcUrl: fixture.backend.rpcUrl, journal: new FileRelayJournal(fixture.artifacts.path("unregistered-mining-journal")) });
  let expiredRegistration: Uint8Array | undefined;
  let replay: Uint8Array | undefined;
  let outcomes: RelaySubmissionResult["outcomes"];
  const newcomerSubmission: DurableSubmissionAdapter<PreparedL1Transaction, RelaySubmissionResult> = {
    mode: "l1",
    l1Sender: newcomer.address,
    async preflight({ transactionBytes: entry, status }) {
      const poster = posterPayoutOpening(newcomer.wallet.address, newcomer.wallet.nkRoot, randomFieldEntropy());
      const creation = decodeTransaction(entry).kind === 1;
      const prefix = creation ? entry : expiredRegistration ?? entry;
      const suffix = creation ? replay === undefined ? [] : [replay] : expiredRegistration === undefined ? [] : [entry];
      return prepareTransactionForL1(prefix, status, newcomerSubmitter, poster.ownerCommitment, poster.context, "calldata", { required: suffix });
    },
    async submit({ transactionBytes: entry, prepared }) {
      published = decodeBatch(fromHex(prepared.batch)).items;
      const output = await submitPreparedTransactionToL1(node, prepared, newcomerSubmitter);
      outcomes = output.outcomes;
      const index = published.findIndex((candidate) => toHex(candidate) === toHex(entry));
      return {  l1Hash: output.txHash, queued: !output.observed,
        accepted: output.outcomes?.some((outcome) => outcome.batchItemIndex === BigInt(index) && outcome.accepted) ?? false, output };
    },
  };
  const openNewcomer = () => openNodeWallet({ dataDir: newcomer.walletDatabasePath, node,
    profile: newcomer.wallet, signer: newcomer.signer, provers: createWalletProvers("native"),
    submission: newcomerSubmission, userAccountCreationSubmission: newcomerSubmission });
  let unregistered = await openNewcomer();
  try {
    const registration = await unregistered.prepareAccountActivation({ authorizationMode: "direct" });
    expiredRegistration = fromHex(registration.transactionHex);
    expiredRegistration.fill(0, expiredRegistration.length - 8); // Direct creation ends in its u64 deadline.
    const mined = await unregistered.send({ to: newcomer.address, amount: 0n, openFeeAmount: 0n });
    assert.equal(mined.accepted, true);
    assert.equal(outcomes?.[0]?.accepted, false, "expired registration fails independently");
    assert.equal(outcomes?.[0]?.outcome, "expired");
    assert.equal((await node.getAccountProof(newcomer.address)).status, "notFound");
    replay = published[1]!;
    const reward = await assertSystemPayoutRecovered({ node, chainId: fixture.network.pcashChainId,
      contentHash: mined.contentHash, label: "unregistered mining", sourceKind: "designatedIssuance", recipient: newcomer.wallet });
    assert.ok(reward.receipt.settledIssuanceAmount > 0n);
    await unregistered.close();
    unregistered = await openNewcomer();
    await unregistered.sync({ awaitFunds: true });
    assert.equal((await unregistered.nativeFunds()).total, reward.receipt.settledIssuanceAmount);
    await assert.rejects(unregistered.send({ to: newcomer.address, amount: 1n, openFeeAmount: 0n }), /has no address account/);

    // The original registration can now succeed while the already-consumed
    // mining proof fails. It must neither block registration nor earn again.
    const registered = await unregistered.submitAccountActivation();
    assert.equal(registered.accepted, true);
    assert.equal(outcomes?.[1]?.accepted, false, "replaying the mining nullifiers fails independently");
    assert.equal(outcomes?.[1]?.outcome, "nullifierAlreadySpent");
    await fixture.waitForAcceptedAcrossNodes(registration.contentHash, "later-registration");
    expiredRegistration = undefined;
    replay = undefined;
    await unregistered.sync({ awaitFunds: true });
    assert.equal((await unregistered.nativeFunds()).total, reward.receipt.settledIssuanceAmount, "replay earns nothing");
    const spent = await unregistered.send({ to: newcomer.address, amount: 1n, openFeeAmount: 0n });
    assert.equal(spent.accepted, true, "previously unregistered rewards spend through ordinary historical membership");
    fixture.artifacts.record("unregistered-mining-complete", { mining: mined.contentHash, registration: registration.contentHash,
      issuance: reward.receipt.settledIssuanceAmount, payment: spent.contentHash });
  } finally { await unregistered.close(); }

  const noEth = fixture.actors.N!;
  await noEth.close();
  assert.equal(BigInt(await l1Rpc<string>(fixture.backend.rpcUrl, "eth_getBalance", [noEth.address, "latest"])), 0n);
  const relay = fixture.harness.mempool();
  const openNoEth = () => openNodeWallet({ dataDir: noEth.walletDatabasePath, node,
    profile: noEth.wallet, signer: noEth.signer, provers: createWalletProvers("native"),
    submission: relay, userAccountCreationSubmission: relay });
  let pendingWallet = await openNoEth();
  const localExpiry = fixture.backend.setNextTimestamp && fixture.backend.mine ? (await node.status()).latestBlockTimestamp + 120n : undefined;
  let pending = await pendingWallet.prepareAccountActivation({ authorizationMode: "signed", mine: true, publication: "open",
    ...(localExpiry === undefined ? {} : { validUntilTimestamp: localExpiry }) });
  let attachment = decodeTransaction(fromHex(pending.transactionHex));
  assert.equal(attachment.kind, 0);
  if (attachment.kind !== 0) throw new Error("open setup must be a value transaction");
  assert.equal(attachment.accountCreation?.kind, "user");
  await pendingWallet.close();
  pendingWallet = await openNoEth();
  try {
    assert.deepEqual(await pendingWallet.prepareAccountActivation({ authorizationMode: "signed", mine: true, publication: "open" }), pending);
    if (localExpiry !== undefined && fixture.backend.setNextTimestamp && fixture.backend.mine) {
      await fixture.backend.setNextTimestamp(localExpiry + 1n);
      await fixture.backend.mine(3);
      await fixture.waitForNodesAtL1Head();
      assert.equal((await node.checkRawTransaction(fromHex(pending.transactionHex), { kind: "inbox", address: `0x${fixture.network.inboxAddress.toString(16).padStart(40, "0")}` })).outcome, "expired");
      const expired = pending;
      pending = await pendingWallet.prepareAccountActivation({ authorizationMode: "signed", mine: true, publication: "open" });
      assert.notEqual(pending.contentHash, expired.contentHash, "an expired attachment needs a fresh signature and proof");
      assert.notEqual(pending.recentPcashBlockHash, expired.recentPcashBlockHash);
      attachment = decodeTransaction(fromHex(pending.transactionHex));
      if (attachment.kind !== 0) throw new Error("renewed setup must be a value transaction");
      assert.equal(attachment.accountCreation?.kind, "user");
    }
    assert.equal((await pendingWallet.submitAccountActivation()).accepted, true);
    await fixture.waitForAcceptedAcrossNodes(pending.contentHash, "no-eth-attached-setup");
    const receipt = (await node.getReceipt({ contentHash: pending.contentHash })).find(item => item.outcome === "succeeded")!;
    assert.equal(receipt.kind, "privateValue");
    assert.ok(receipt.settledIssuanceAmount > 0n);
    assert.equal(privateValuePublicInputs(attachment)[13], 0n, "setup uses the open issuance route");
    assert.equal(receipt.accountCreation, 1);
    assert.equal((await node.getAccountProof(noEth.address)).status, "present");
    assert.equal(BigInt(await l1Rpc<string>(fixture.backend.rpcUrl, "eth_getBalance", [noEth.address, "latest"])), 0n);
    await pendingWallet.sync();
    assert.equal((await pendingWallet.nativeFunds()).total, 0n, "open setup pays the poster");
    fixture.artifacts.record("no-eth-attached-setup-complete", { contentHash: pending.contentHash, issuance: receipt.settledIssuanceAmount });
  } finally { await pendingWallet.close(); }

}
