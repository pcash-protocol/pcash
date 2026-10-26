import assert from "node:assert/strict";
import { formatDirectSendLink, memoSchema } from "@pcash/sdk/delivery";
import { FileRelayJournal, PrivateKeyRelaySubmitter } from "@pcash/sdk/node";
import { directSendOutputKey, transactionIdentity } from "@pcash/sdk/protocol";
import { fromHex } from "@pcash/sdk/utils";
import { createL1SubmissionAdapter, inspectDirectSend } from "@pcash/sdk/wallet";
import { createWalletProvers } from "@pcash/sdk/wallet/node";
import { openNodeWallet } from "@pcash/wallet";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { setupUserWallets } from "./setup.ts";

const RECEIVE_PAGE = "https://pcash.example/receive";
const MEMO = "Welcome to PCASH";

/**
 * A payment to an address with no PCASH account, with real proofs: the sender
 * pays a direct send with a memo the link's holder reads before setting up,
 * and a restore from its seed rebuilds the link; a recipient
 * wallet born after the payment imports the link, sets up with its own
 * Ethereum transaction, holds the full amount and spends it; and a restore
 * from the recipient's seed finds the payment from setup's encrypted record.
 */
export async function runDirectSendScenario(fixture: ScenarioFixture): Promise<void> {
  const balances = await setupUserWallets(fixture, { actors: ["S", "R"], accounts: ["S"], funded: ["S"] });
  const { S, R } = fixture.actors;
  if (S === undefined || R === undefined) throw new Error("direct-send actors are missing");
  const node = fixture.nodeA.client;
  const fee = 1n;
  const amount = balances.S! / 4n;
  const sender = await S.client();
  assert.equal((await node.getAccountProof(R.address)).status, "notFound");
  await assert.rejects(sender.send({ to: R.address, amount, openFeeAmount: fee }), /no published ML-KEM receive key/);
  const paid = await sender.send({ to: R.address, amount, openFeeAmount: fee, directSend: true,
    data: { recipients: [{ to: R.address, records: [memoSchema.encode(MEMO)] }] } });
  await fixture.waitForAcceptedAcrossNodes(paid.contentHash, "direct-send");
  await sender.sync();
  const sent = (await sender.directSends()).find((send) => send.opening.contentHash === paid.contentHash.toLowerCase());
  assert.ok(sent !== undefined, "the sender lists its direct send");
  assert.equal(sent.recipientSetUp, false);
  assert.equal(sent.opening.amount, amount);
  const link = formatDirectSendLink(sent.opening, RECEIVE_PAGE);
  const funding = await inspectDirectSend(node, sent.opening);
  assert.equal(funding.status === "landed" ? funding.memo : undefined, MEMO, "the link's holder reads the memo");

  // Clearing the sender's storage loses nothing: its sender regions rebuild the link.
  const restoredSender = await openNodeWallet({ dataDir: fixture.artifacts.path("direct-send-sender-restored"), node, profile: S.wallet, signer: S.signer, provers: createWalletProvers("native") });
  try {
    await restoredSender.sync();
    assert.deepEqual((await restoredSender.directSends()).map((send) => send.opening), [sent.opening]);
  } finally { await restoredSender.close(); }

  // The recipient posts its own setup on Ethereum.
  await R.close();
  await fixture.fundL1Gas(R.address, 4);
  const submitter = new PrivateKeyRelaySubmitter({ node, privateKey: R.privateKey, rpcUrl: fixture.backend.rpcUrl,
    journal: new FileRelayJournal(fixture.artifacts.path("direct-send-recipient-journal")) });
  const submission = createL1SubmissionAdapter({ node, submitterFor: () => submitter, payoutRecipient: () => R.wallet, daMode: "calldata", l1Sender: R.address });
  const openRecipient = (name: string) => openNodeWallet({ dataDir: fixture.artifacts.path(name), node, profile: R.wallet, signer: R.signer,
    provers: createWalletProvers("native"), submission, userAccountCreationSubmission: submission });
  let recipient = await openRecipient("direct-send-recipient");
  let setUp: { registration: string; mining: string };
  let spend: string;
  try {
    // Born after the payment, the wallet takes the funding output's path from the node.
    await recipient.sync({ anchorAtCurrentBoundary: true });
    await assert.rejects(recipient.importDirectSend(formatDirectSendLink({ ...sent.opening, amount: amount + 1n }, RECEIVE_PAGE)), /does not match/);
    const imported = await recipient.importDirectSend(link);
    assert.deepEqual(imported, { opening: sent.opening, state: "received", saved: false });
    assert.deepEqual(await recipient.importDirectSend(link), imported, "a second import changes nothing");

    const prepared = await recipient.prepareAccountActivation({ authorizationMode: "direct", mine: true });
    const activation = await recipient.submitAccountActivation();
    assert.equal(activation.accepted, true);
    setUp = { registration: prepared.contentHash, mining: transactionIdentity(fromHex(prepared.miningTransactionHex!)).contentHash };
    await fixture.waitForAcceptedAcrossNodes(setUp.registration, "direct-send-registration");
    await fixture.waitForAcceptedAcrossNodes(setUp.mining, "direct-send-setup-mining");
    await recipient.sync({ awaitFunds: true });
    assert.ok((await recipient.nativeFunds()).spendablePrivate > amount, "the full amount and the setup reward are spendable");
    await sender.sync();
    assert.equal((await sender.directSends()).find((send) => directSendOutputKey(send.opening) === directSendOutputKey(sent.opening))?.recipientSetUp, true);

    const payment = await recipient.send({ to: S.address, amount: amount / 2n, openFeeAmount: 0n });
    assert.equal(payment.accepted, true);
    spend = payment.contentHash;
    await recipient.sync();
    assert.equal((await recipient.receivedDirectSends())[0]?.state, "spent");
  } finally { await recipient.close(); }

  // A restore from the recipient's seed finds the payment from setup's record and never revives the spent note.
  recipient = await openRecipient("direct-send-recipient-restored");
  try {
    await recipient.sync();
    const [found] = await recipient.receivedDirectSends();
    assert.ok(found !== undefined, "the restore recovers the direct send");
    assert.deepEqual(found.opening, sent.opening);
    assert.equal(found.state, "spent");
    const history = await recipient.nativeActivity();
    assert.equal(history.state, "ready");
    if (history.state === "ready") {
      assert.ok(history.entries.some((entry) => entry.direction === "received" && entry.amount === amount
        && entry.messages?.some((message) => new TextDecoder().decode(message.memo) === MEMO) === true), "history shows the direct send and its memo");
      assert.ok(history.entries.some((entry) => entry.contentHash === spend.toLowerCase()), "history shows its spend");
    }
  } finally { await recipient.close(); }
  fixture.artifacts.record("direct-send-complete", { payment: paid.contentHash, ...setUp, spend });
}
