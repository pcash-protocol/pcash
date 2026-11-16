import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { toHex } from "viem";
import { addressHex, encodeBatch, transactionIdentity, posterPayoutOpening, derivePcashProfileFromPrivateKey, fromHex, randomFieldEntropy } from "../deps.ts";
import { buildLatestUserTransfer, listSpendableNotes, proveDefaultTransfer } from "../actors/sdk.ts";
import { l1Rpc } from "../backends/rpc.ts";
import { eventually } from "../framework/eventually.ts";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { setupUserWallets } from "./setup.ts";

/**
 * An L-profile calldata payment is orphaned and reincluded: only the
 * unfinalized suffix is replaced, and notes and issuance state rewind together.
 * The recipient's durable wallet follows the orphaning and the reinclusion
 * from its local checkpoints, without a rescan.
 */
export async function runReorgScenario(fixture: ScenarioFixture): Promise<void> {
  const { backend } = fixture;
  if (!backend.snapshot || !backend.revert || !backend.mine || !backend.setNextTimestamp) throw new Error("reorg scenario requires local L1 controls");
  const shape = PRIVATE_VALUE_PROFILES.L.shapeId;
  await setupUserWallets(fixture, {actors:["S","R"],accounts:["S"],funded:["S"]});
  const { S, R } = fixture.actors;
  if (!S || !R) throw new Error("reorg actors are missing");
  // Opened before the payment exists, so only incremental synchronization can find it.
  await R.balance();
  const build = await buildLatestUserTransfer({shape,node:fixture.nodeA.client,network:fixture.network,wallet:S.wallet,recipientAddress:R.wallet.address,recipientReceiveKey:R.wallet.mlKemPublicKey!,amountDivisor:8n,openFeeAmount:1n,defaultRuleSecrets:S.wallet.defaultUserRuleSecrets,signer:S.signer});
  const entry = await proveDefaultTransfer(build, "reorg payment");
  const contentHash = transactionIdentity(entry).contentHash;
  const poster = derivePcashProfileFromPrivateKey(fromHex(fixture.harness.privateKey), fixture.network);
  const opening = posterPayoutOpening(poster.address, poster.nkRoot, randomFieldEntropy());
  const batch = encodeBatch([entry], opening.ownerCommitment, opening.context);
  // The open-route payment pays its fee and issuance to this batch's poster commitment.
  const posterPaid = async () => (await fixture.nodeA.client.getPayouts({limit:1000})).records
    .some(record=>record.ownerCommitment === opening.ownerCommitment && record.source.kind === "posterPayout");
  const sumNotes = async () => (await listSpendableNotes(fixture.nodeA.client,S.wallet,fixture.network.pcashChainId)).reduce((sum,note)=>sum+note.amount,0n);
  const beforeBalance = await sumNotes();
  const miningInterval = await l1Rpc<number>(backend.rpcUrl,"anvil_getIntervalMining",[]);
  await l1Rpc(backend.rpcUrl,"evm_setAutomine",[false]);
  await l1Rpc(backend.rpcUrl,"evm_setIntervalMining",[0]);
  try {
    await fixture.waitForNodesAtL1Head();
    const before = await fixture.nodeA.client.getIssuanceQuote((await fixture.nodeA.client.status()).latestBlockTimestamp);
    const parent = await l1Rpc<{timestamp:string}>(backend.rpcUrl,"eth_getBlockByNumber",["latest",false]);
    const snapshot = await backend.snapshot();
    // Post the exact batch through the harness journal, then mine it by hand;
    // settling at the receipt releases the entry before the snapshot rewinds it.
    const mine = backend.mine.bind(backend);
    const post = async () => {
      const sent = await fixture.harness.submitter.sendCall({ to: addressHex(fixture.network.inboxAddress), data: toHex(batch) });
      await mine(1);
      return sent.settle();
    };
    const firstReceipt = await post();
    const firstL1Hash = firstReceipt.txHash;
    const first = await fixture.waitForAcceptedAcrossNodes(contentHash,"reorg-first-inclusion");
    if (!await posterPaid()) throw new Error("first inclusion paid its poster nothing");
    const receivedBefore = await eventually("the recipient wallet to sync the first inclusion",()=>R.balance(),balance=>balance>0n,{timeoutMs:60_000,intervalMs:250});
    await backend.revert(snapshot);
    await l1Rpc(backend.rpcUrl,"anvil_dropTransaction",[firstL1Hash]);
    await backend.setNextTimestamp(BigInt(parent.timestamp)+2n);
    // The follower detects the changed parent when the replacement chain advances.
    await backend.mine(2);
    const replacement = await l1Rpc<{hash:string}>(backend.rpcUrl,"eth_getBlockByNumber",["latest",false]);
    await eventually("both nodes to derive the replacement suffix",()=>Promise.all([fixture.nodeA.client.status(),fixture.nodeB.client.status()]),statuses=>statuses.every(status=>status.latestL1BlockHash.toLowerCase()===replacement.hash.toLowerCase()),{timeoutMs:120_000,intervalMs:250});
    const reverted = await fixture.nodeA.client.getIssuanceQuote((await fixture.nodeA.client.status()).latestBlockTimestamp);
    if (reverted?.issuedSoFar !== before?.issuedSoFar) throw new Error("reorg did not restore gross issuance");
    if ((await fixture.nodeA.client.getReceipt({contentHash})).length !== 0) throw new Error("orphaned inclusion is still canonical");
    if (await posterPaid()) throw new Error("orphaned poster payout survived rollback");
    if (await sumNotes() !== beforeBalance) throw new Error("fresh seed restoration did not recover the parent inventory");
    await eventually("the recipient wallet to rewind the orphaned note",()=>R.balance(),balance=>balance===0n,{timeoutMs:60_000,intervalMs:250});
    await post();
    const replayed = await fixture.waitForAcceptedAcrossNodes(contentHash,"reorg-reincluded-proof");
    if (replayed.nodeA.transactionId === first.nodeA.transactionId) throw new Error("replacement inclusion reused an orphaned transaction identity");
    if (!await posterPaid()) throw new Error("replacement inclusion paid its poster nothing");
    const received = await listSpendableNotes(fixture.nodeA.client,R.wallet,fixture.network.pcashChainId);
    if (received.length === 0) throw new Error("recipient did not recover the replacement note");
    await eventually("the recipient wallet to sync the reinclusion",()=>R.balance(),balance=>balance===receivedBefore,{timeoutMs:60_000,intervalMs:250});
    fixture.artifacts.record("reorg-complete",{shape,carrier:"calldata",gasUsed:firstReceipt.gasUsed,contentHash,orphaned:first.nodeA.transactionId,replayed:replayed.nodeA.transactionId,restoredParentBalance:beforeBalance});
  } finally {
    await l1Rpc(backend.rpcUrl,"evm_setAutomine",[true]);
    await l1Rpc(backend.rpcUrl,"evm_setIntervalMining",[miningInterval]);
  }
  const r = await R.client();
  const registration = await r.updateAccount({ submission: fixture.harness.l1(R.wallet) });
  await fixture.waitForAcceptedAcrossNodes(registration.contentHash,"reorg-recipient-register");
  const balance = await R.balance();
  const spent = await r.send({ to: S.address, amount: balance / 2n, openFeeAmount: 1n });
  await fixture.waitForAcceptedAcrossNodes(spent.contentHash,"reorg-restored-recipient-spend");
}
