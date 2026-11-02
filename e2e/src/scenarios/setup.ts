import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { logger } from "../framework/logger.ts";
import { assertSystemPayoutRecovered } from "./payouts.ts";

/** Confirm that the current controller state can pay a qualifying action. */
export async function ensureIssuanceActive(fixture: ScenarioFixture): Promise<void> {
  const status = await fixture.nodeA.client.status();
  const quote = await fixture.nodeA.client.getIssuanceQuote(status.latestBlockTimestamp);
  if (quote === null) throw new Error("issuance quote is unavailable");
  if (!quote.rewardPossible || quote.exhausted) {
    throw new Error("this scenario requires positive issuance");
  }
}

/**
 * Register accounts on L1, then let every funded actor earn a native note by
 * publishing one ordinary payment of zero PCASH to itself, with an explicit
 * zero fee and no note inputs: the action names the actor's own commitment,
 * which collects the issuance. There is no faucet, even on a live network.
 * Actors set up together, so each step lands in as few carriers as the batch
 * window gathers.
 */
export async function setupUserWallets(
  fixture: ScenarioFixture,
  options: {
    actors: readonly string[];
    accounts: readonly string[];
    funded: readonly string[];
  },
): Promise<Record<string, bigint>> {
  const started = Date.now();
  const log = (message: string) => logger.context("setup").info(`${message} (${Math.round((Date.now() - started) / 1_000)}s)`);
  const pendingActors = options.actors.filter((name) => fixture.actors[name] === undefined);
  if (pendingActors.length > 0) {
    log(`opening ${pendingActors.length} wallets: ${pendingActors.join(" ")}`);
    await fixture.createActors(options.actors);
  }
  const accounts = [...new Set([...options.accounts, ...options.funded])];
  const unregistered = (await Promise.all(accounts.map(async (name) => {
    const actor = fixture.actors[name];
    if (actor === undefined) throw new Error(`setup actor ${name} was not requested`);
    return (await fixture.nodeA.client.getAccountProof(actor.address)).status === "present" ? [] : [actor];
  }))).flat();
  if (unregistered.length > 0) {
    log(`registering ${unregistered.length} accounts on L1`);
    await Promise.all(unregistered.map(async (actor) => {
      const action = await (await actor.client()).updateAccount({ submission: fixture.harness.l1Batched() });
      await fixture.waitForAcceptedAcrossNodes(action.contentHash, `setup-account-${actor.name}`);
      log(`${actor.name} account accepted`);
    }));
  }
  if (options.funded.length > 0) await ensureIssuanceActive(fixture);
  const funded = options.funded.map((name) => fixture.actors[name]!);
  const unfunded = (await Promise.all(funded.map(async (actor) => await actor.balance() === 0n ? [actor] : []))).flat();
  if (unfunded.length > 0) {
    log(`earning issuance for ${unfunded.length} actors`);
    await Promise.all(unfunded.map(async (actor) => {
      const action = await (await actor.client()).send({
        to: actor.address, amount: 0n, openFeeAmount: 0n, submission: fixture.harness.l1Batched(),
      });
      await fixture.waitForAcceptedAcrossNodes(action.contentHash, `setup-earn-${actor.name}`);
      const { receipt } = await assertSystemPayoutRecovered({
        node: fixture.nodeA.client,
        chainId: fixture.network.pcashChainId,
        contentHash: action.contentHash,
        label: `setup-earn-${actor.name}`,
        sourceKind: "designatedIssuance",
        recipient: actor.wallet,
      });
      if (receipt.settledIssuanceAmount === 0n) throw new Error(`${actor.name}'s self-published action earned no issuance`);
      log(`${actor.name} earned ${receipt.settledIssuanceAmount}`);
    }));
  }
  const balances = Object.fromEntries(await Promise.all(funded.map(async (actor) => {
    const balance = await actor.balance();
    if (balance === 0n) throw new Error(`${actor.name} did not restore its self-published issuance note`);
    return [actor.name, balance] as const;
  })));
  if (pendingActors.length > 0 || unregistered.length > 0 || unfunded.length > 0) log("setup complete");
  fixture.artifacts.record("scenario-setup-complete", { actors: options.actors, accounts, balances });
  return balances;
}
