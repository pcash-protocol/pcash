import { createHash } from "node:crypto";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { buildExtendedCode } from "@pcash/sdk/delivery";
import { formatAssetDefinition } from "@pcash/sdk/protocol";
import { openMemoryNodeWallet } from "@pcash/wallet";
import type { ScenarioActor } from "../actors/actor.ts";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { eventually } from "../framework/eventually.ts";
import { logger } from "../framework/logger.ts";
import { setupUserWallets } from "./setup.ts";

/**
 * A token end to end: creation with a content digest, an L airdrop whose
 * recipients recover the note and the verified definition from delivery alone,
 * a holder with no PCASH forwarding it by self-publication, a burn, and seed
 * restoration of the creator's change.
 */
export async function runTokenAirdropScenario(fixture: ScenarioFixture): Promise<void> {
  // Alice (S) creates FOO and airdrops it; Bob (R) forwards to Carol (M), who is not an airdrop recipient.
  const airdropped = ["R", "X", "O", "D", "B", "E"];
  await setupUserWallets(fixture, { actors: ["S", "M", ...airdropped], accounts: ["S", "R", "M"], funded: [] });
  const { S: alice, R: bob, M: carol } = fixture.actors;
  if (!alice || !bob || !carol) throw new Error("token actors are missing");
  const self = (actor: ScenarioActor) => fixture.harness.l1(actor.wallet);
  const accept = (contentHash: string, label: string) => fixture.waitForAcceptedAcrossNodes(contentHash, label);

  const supply = 1_000_000_000n;
  const contentDigest = createHash("sha256").update("FOO token terms").digest();
  const created = await (await alice.client()).createAsset({
    metadata: { name: "Foo", symbol: "FOO", decimals: 6, contentDigest },
    initialSupply: supply,
    submission: self(alice),
  });
  await accept(created.contentHash, "token-create");
  logger.context("token-airdrop").info("token created");
  const { assetId, definition } = created;
  const text = formatAssetDefinition(definition);
  if (definition.metadata.symbol !== "FOO" || definition.metadata.decimals !== 6 || definition.initialSupply !== supply
    || !Buffer.from(definition.metadata.contentDigest).equals(contentDigest)) throw new Error("created FOO definition differs from its request");
  /** The actor's FOO balance, after checking its wallet holds the verified definition. */
  const holding = async (actor: ScenarioActor): Promise<bigint> => {
    const wallet = await actor.client();
    await wallet.sync();
    const token = (await wallet.assets()).find(item => item.assetId === assetId);
    if (token === undefined || token.definition === null || formatAssetDefinition(token.definition) !== text) {
      throw new Error(`${actor.name} does not hold the verified FOO definition`);
    }
    return token.private;
  };
  if (await holding(alice) !== supply) throw new Error("Alice does not hold the created FOO supply");

  // Six recipients exceed the S output count, so one approved transaction must be an L chunk.
  const allocations = airdropped.map((_, index) => BigInt(index + 1) * 1_000_000n);
  const recipients = airdropped.map((name, index) => {
    const { wallet } = fixture.actors[name]!;
    return {
      to: buildExtendedCode({ address: wallet.address, chainId: fixture.network.pcashChainId, mlKemPublicKey: wallet.mlKemPublicKey }),
      amount: allocations[index]!,
    };
  });
  const aliceWallet = await alice.client();
  const { jobId } = await aliceWallet.startBulkJob({ kind: "payment", assetId, maxTransactions: 1, recipients });
  const step = await aliceWallet.runBulkJobStep({ jobId, submission: self(alice) });
  if (step.state !== "submitted") throw new Error(`the airdrop chunk was not submitted (${step.state})`);
  await accept(step.result.contentHash, "token-airdrop");
  // A job completes once its chunk is finalized.
  await eventually("the airdrop job to complete", async () => {
    await aliceWallet.sync();
    return (await aliceWallet.runBulkJobStep({ jobId, submission: self(alice) })).state;
  }, (state) => state === "complete", { timeoutMs: 3 * 60_000, intervalMs: 2_000 });
  logger.context("token-airdrop").info("airdrop finalized");
  const chunks = (await aliceWallet.bulkJobs()).find(job => job.jobId === jobId)?.chunks;
  if (chunks?.length !== 1 || chunks[0]!.shape !== PRIVATE_VALUE_PROFILES.L.shapeId || chunks[0]!.recipientCount !== airdropped.length) {
    throw new Error("the airdrop was not one L chunk");
  }
  for (const [index, name] of airdropped.entries()) {
    if (await holding(fixture.actors[name]!) !== allocations[index]) throw new Error(`${name} did not recover its FOO allocation`);
  }
  const change = supply - allocations.reduce((sum, amount) => sum + amount, 0n);
  if (await holding(alice) !== change) throw new Error("Alice's FOO change differs from the undistributed supply");

  // With a zero fee, a self-published action spends no native notes.
  if (await bob.balance() !== 0n) throw new Error("Bob holds PCASH before forwarding");
  const forwarded = allocations[0]! / 2n;
  const forward = await (await bob.client()).sendAsset({
    assetId, outputs: [{ to: carol.address, amount: forwarded }], openFeeAmount: 0n, submission: self(bob),
  });
  await accept(forward.contentHash, "token-forward");
  logger.context("token-airdrop").info("forward accepted; burning the received tokens");
  const burned = forwarded / 4n;
  const burn = await (await carol.client()).burnAsset({ assetId, amount: burned, openFeeAmount: 0n, submission: self(carol) });
  await accept(burn.contentHash, "token-burn");
  logger.context("token-airdrop").info("burn accepted; restoring the creator's wallet");
  if (await holding(bob) !== allocations[0]! - forwarded || await holding(carol) !== forwarded - burned) {
    throw new Error("FOO balances after the forward and burn are inconsistent");
  }

  // A new wallet from Alice's key alone restores her change and its definition from the node.
  const restored = await openMemoryNodeWallet({ node: fixture.nodeA.client, signer: alice.signer });
  try {
    await restored.sync();
    const token = (await restored.assets()).find(asset => asset.assetId === assetId);
    if (token?.private !== change || token.definition === null || formatAssetDefinition(token.definition) !== text) {
      throw new Error("seed restoration lost Alice's FOO change or its definition");
    }
  } finally { await restored.close(); }
  fixture.artifacts.record("token-airdrop-complete", { assetId, airdropContentHash: step.result.contentHash, allocations, forwarded, burned });
}
