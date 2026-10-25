import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { buildExtendedCode } from "@pcash/sdk/delivery";

export async function runIssuanceBoundaryScenario(fixture: ScenarioFixture): Promise<void> {
  if (!fixture.backend.setNextTimestamp || !fixture.backend.mine) throw new Error("issuance boundary scenario requires a controllable local L1 clock");
  await fixture.createActors(["S", "R"]);
  const { S, R } = fixture.actors;
  if (!S || !R) throw new Error("issuance actors are missing");
  const s = await S.client();
  // S publishes its own actions, which name S's own commitment for their issuance.
  const selfPublished = fixture.harness.l1(S.wallet);
  const accepted = async (action: { contentHash: string }, label: string) => fixture.waitForAcceptedAcrossNodes(action.contentHash, label);
  const createAsset = (name: string) => s.createAsset({
    metadata: { name, symbol: "PART", decimals: 0, contentDigest: new Uint8Array(32) },
    initialSupply: 1n,
    submission: selfPublished,
  });
  await accepted(await s.updateAccount({ submission: selfPublished }), "issuance-preparation-account");
  const initialStatus = await fixture.nodeA.client.status();
  const initial = await fixture.nodeA.client.getIssuanceQuote(initialStatus.latestBlockTimestamp);
  if (!initial || !initial.rewardPossible || initial.exhausted || initial.issuedSoFar !== 0n) throw new Error("empty genesis issuance state cannot issue to an action");
  if (initial.maxSingleActionReward === 0n || initial.maxSingleActionReward > initial.blockAllowance) throw new Error("initial quote limits are inconsistent");
  await accepted(await createAsset("Issuance action"), "issuance-action");
  const earned = await S.balance();
  if (earned === 0n) throw new Error("self-published qualifying action did not pay its publisher");
  const afterFirst = await fixture.nodeA.client.getIssuanceQuote((await fixture.nodeA.client.status()).latestBlockTimestamp);
  if (!afterFirst || afterFirst.issuedSoFar !== earned) throw new Error("gross issuance does not match the earned note");
  await fixture.backend.setNextTimestamp(initialStatus.latestBlockTimestamp + 366n * 86_400n);
  await fixture.backend.mine(1);
  await fixture.waitForNodesAtL1Head();
  const later = await fixture.nodeA.client.getIssuanceQuote((await fixture.nodeA.client.status()).latestBlockTimestamp);
  if (!later || !later.rewardPossible || later.exhausted) throw new Error("calendar time incorrectly ended issuance");
  await accepted(await createAsset("Later issuance"), "later-issuance-action");
  const after = await fixture.nodeA.client.getIssuanceQuote((await fixture.nodeA.client.status()).latestBlockTimestamp);
  if (!after || after.issuedSoFar <= afterFirst.issuedSoFar) throw new Error("later qualifying action did not issue value");
  const extendedCode = buildExtendedCode({ address: R.wallet.address, chainId: fixture.network.pcashChainId, mlKemPublicKey: R.wallet.mlKemPublicKey });
  await s.sync();
  await accepted(await s.send({ to: extendedCode, amount: earned / 2n, openFeeAmount: 0n, submission: selfPublished }), "issued-note-spend");
  if (await R.balance() !== earned / 2n) throw new Error("ordinary note spending stopped with issuance");
  fixture.artifacts.record("issuance-boundary-complete", { earned, initialBaseline: initial.baseline, laterOffer: later.internalOffer, issuedSoFar: after.issuedSoFar });
}
