import assert from "node:assert/strict";
import { buildExtendedCode } from "@pcash/sdk/delivery";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { listSpendableNotes } from "../actors/sdk.ts";
import { derivePcashProfileFromPrivateKey, fromHex } from "../deps.ts";
import { assertSystemPayoutRecovered, settledSystemPayout } from "./payouts.ts";
import { setupUserWallets } from "./setup.ts";

export interface CoreScenarioResult {
  initialEarnings: { S: bigint; M: bigint };
  balances: Record<string, bigint>;
  extendedCode: string;
  acceptedContentHashes: string[];
}

/**
 * Empty-native onboarding, fresh-seed restoration, a relayed carrier holding
 * two paid payments and a zero payment that each qualify once in one block,
 * a default-fee spend with the relayer's seed-only payout recovery, delivery
 * to an unregistered recipient, and a note-funded account update.
 */
export async function runCoreScenario(fixture: ScenarioFixture): Promise<CoreScenarioResult> {
  const initial = await setupUserWallets(fixture, {
    actors: ["S", "R", "M", "X", "O"], accounts: ["S", "R", "M"], funded: ["S", "M"],
  });
  const { S, R, M, X, O } = fixture.actors;
  if (!S || !R || !M || !X || !O) throw new Error("core actors are missing");
  const [s, r, m, x, o] = await Promise.all([S.client(), R.client(), M.client(), X.client(), O.client()]);
  const node = fixture.nodeA.client;
  const acceptedContentHashes: string[] = [];
  const accept = async (contentHash: string, label: string) => {
    const result = await fixture.waitForAcceptedAcrossNodes(contentHash, label);
    acceptedContentHashes.push(contentHash);
    return result;
  };
  // This scanner has only the seed-derived profile and canonical node data.
  const restored = await listSpendableNotes(node, S.wallet, fixture.network.pcashChainId);
  if (restored.reduce((sum, note) => sum + note.amount, 0n) !== initial.S) {
    throw new Error("fresh seed restoration disagrees with the earned native inventory");
  }
  const payS = initial.S! / 8n;
  const payM = initial.M! / 8n;
  const fee = 1n;
  if (payS < 100n || payM < 100n) throw new Error("earned notes are too small for the core scenario");
  // Every open-route action here pays the relayer's poster commitment.
  const relayer = derivePcashProfileFromPrivateKey(fromHex(fixture.harness.privateKey), fixture.network);
  const paidToRelayer = (contentHash: string, label: string) => assertSystemPayoutRecovered({
    node, chainId: fixture.network.pcashChainId, contentHash, label, sourceKind: "posterPayout", recipient: relayer,
  });

  // R holds no PCASH yet: its zero payment with an explicit zero fee spends no
  // notes and creates none. One carrier puts all three payments in one block.
  const queued = fixture.harness.mempool({ relay: false });
  const [first, second, zero] = await Promise.all([
    s.send({ to: R.address, amount: payS, openFeeAmount: fee, submission: queued }),
    m.send({ to: R.address, amount: payM, openFeeAmount: fee, submission: queued }),
    r.send({ to: S.address, amount: 0n, openFeeAmount: 0n, submission: queued }),
  ]);
  const carrier = [first.contentHash, second.contentHash, zero.contentHash];
  await Promise.all(carrier.map((contentHash) => fixture.waitForPeerCopy(contentHash)));
  await fixture.harness.relayExact(carrier);
  await accept(first.contentHash, "paid-transfer-S-R");
  await accept(second.contentHash, "paid-transfer-M-R");
  await accept(zero.contentHash, "zero-payment-R-S");
  const landings = await Promise.all(carrier.map(async (contentHash) => {
    const { receipt } = await settledSystemPayout(node, contentHash);
    const transaction = await node.getTransaction(receipt.transactionId);
    if (transaction === null) throw new Error(`${contentHash} is not indexed yet`);
    return { receipt, block: transaction.summary.block.blockNumber };
  }));
  const [paidLanding, , zeroLanding] = landings;
  if (landings.some((landing) => landing.block !== zeroLanding!.block)) {
    throw new Error("the carrier's payments did not land in one PCASH block");
  }
  if (zeroLanding!.receipt.settledOpenFeeAmount !== 0n || paidLanding!.receipt.settledOpenFeeAmount !== fee) {
    throw new Error("the block did not settle each payment's explicit fee");
  }
  const rewardEach = zeroLanding!.receipt.settledIssuanceAmount;
  if (rewardEach === 0n || landings.some((landing) => landing.receipt.settledIssuanceAmount !== rewardEach)) {
    throw new Error("the zero and positive payments did not share the block's issuance equally");
  }
  const economics = await node.getBlockEconomics({ fromBlock: zeroLanding!.block, limit: 1, bucket: 1 });
  const record = economics.records[0];
  // Other publishers can share a live block, so each of ours must count at least once.
  if (record === undefined || record.firstBlock !== zeroLanding!.block || record.qualifyingActions < 3n) {
    throw new Error("the block did not count every payment as a qualifying action");
  }
  if (record.rewardEach !== rewardEach) throw new Error("the block's reward per action does not match its receipts");
  const paid = await paidToRelayer(first.contentHash, "paid-transfer-S-R");
  if (paid.receipt.settledOpenFeeAmount !== fee || paid.receipt.settledIssuanceAmount === 0n) {
    throw new Error("relayed paid transfer did not settle its fee and issuance to the relayer");
  }

  await s.sync();
  // The wallet default: the node's suggested fee on the open route, paid with the issuance to whoever publishes it.
  const change = await s.send({ to: R.address, amount: payS / 2n });
  await accept(change.contentHash, "default-fee-change-spend-S-R");
  const defaultFee = await paidToRelayer(change.contentHash, "default-fee-change-spend-S-R");
  if (defaultFee.receipt.settledOpenFeeAmount === 0n || defaultFee.receipt.settledIssuanceAmount === 0n) {
    throw new Error("default-fee transfer did not pay its relayer a fee and issuance");
  }
  const [totalR, outsiderBalance] = await Promise.all([R.balance(), O.balance()]);
  const extendedCode = buildExtendedCode({ address: X.wallet.address, chainId: fixture.network.pcashChainId, mlKemPublicKey: X.wallet.mlKemPublicKey });
  // The zero payment created no note, so R holds exactly the three positive payments.
  if (totalR !== payS + payM + payS / 2n) throw new Error("recipient balance differs from delivered notes");
  if (outsiderBalance !== 0n || (await o.notes()).length !== 0) throw new Error("outsider restored another owner's notes");
  const multiAmount = totalR * 2n / 3n;
  if (multiAmount <= (payS > payM ? payS : payM)) throw new Error("multi-input transfer was not exercised");
  await accept((await r.send({ to: extendedCode, amount: multiAmount, openFeeAmount: fee })).contentHash, "paid-multi-input-R-X");
  if (await X.balance() !== multiAmount) throw new Error("unregistered recipient did not restore its note");
  if ((await node.getAccountProof(X.address)).status === "present") throw new Error("recipient was registered before receipt");
  await assert.rejects(
    x.send({ to: S.address, amount: multiAmount / 2n, openFeeAmount: fee }),
    /has no address account/,
  );
  await accept((await x.updateAccount({ submission: fixture.harness.l1(X.wallet) })).contentHash, "register-after-receipt-X");
  await accept((await x.send({ to: S.address, amount: multiAmount / 2n, openFeeAmount: fee })).contentHash, "spend-restored-note-X-S");
  await s.sync();
  const update = await s.updateAccount({ openFeeAmount: fee });
  await accept(update.contentHash, "note-funded-account-update");
  const updatePaid = await paidToRelayer(update.contentHash, "note-funded-account-update");
  if (updatePaid.receipt.settledOpenFeeAmount !== fee || updatePaid.receipt.settledIssuanceAmount !== 0n) {
    throw new Error("paid account update did not settle exactly its fee to the relayer, or created issuance");
  }
  const balances: Record<string, bigint> = {};
  for (const actor of [S, M, R, X, O]) balances[actor.name] = await actor.balance();
  const result = { initialEarnings: { S: initial.S!, M: initial.M! }, balances, extendedCode, acceptedContentHashes };
  fixture.artifacts.record("core-complete", result);
  return result;
}
