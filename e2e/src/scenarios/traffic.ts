import type { ScenarioActor } from "../actors/actor.ts";
import { l1Rpc } from "../backends/rpc.ts";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { sleep } from "../deps.ts";
import { logger } from "../framework/logger.ts";
import { runFixtureAssetFlow } from "./assets.ts";
import {
  fixtureMarketplaceContext,
  openMarketplaceSession,
  runPaidMarketplaceTrade,
  type MarketplaceSession,
} from "./marketplace.ts";
import { setupUserWallets } from "./setup.ts";

/** Lanes run concurrently, one per worker, each worker with payers of its own. */
const WORKERS = 3;
const LANES = [
  "relayed-payment",
  "self-published-payment",
  "batched-payments",
  "asset-lifecycle",
  "marketplace-trade",
] as const;
type Lane = typeof LANES[number];

const SUMMARY_INTERVAL_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 3;
/** Catalog records never expire and a node holds a bounded number, so a live network gets few trades. */
const LIVE_TRADE_INTERVAL_MS = 10 * 60_000;
const TRADE_AMOUNT = 1_000n;

/**
 * Long-running mixed activity to watch in Explorer: payments relayed from the
 * public mempool, self-published payments that keep earning issuance, several
 * payments in one carrier, complete asset lifecycles, and paid marketplace
 * trades. Workers run lanes concurrently, and the harness gathers what they
 * submit within a batch window into shared carriers, so each L1 block carries
 * several actions. It runs until `--duration` elapses or the run is
 * interrupted; a failed round is recorded and the worker moves on.
 */
export async function runTrafficScenario(fixture: ScenarioFixture): Promise<void> {
  if (!fixture.backend.anvil && fixture.durationMs === undefined) {
    throw new Error("traffic on a real L1 spends real gas and requires an explicit --duration");
  }
  const log = (message: string) => logger.context("traffic").info(message);
  const crews = Array.from({ length: WORKERS }, (_, index) => ["A", "B", "C"].map((letter) => `${letter}${index + 1}`));
  const payerNames = crews.flat();
  const marketNames = fixture.marketplace ? ["S", "M"] : [];
  await setupUserWallets(fixture, {
    actors: [...payerNames, ...marketNames],
    accounts: [...payerNames, ...marketNames.filter((name) => name === "M")],
    funded: [...payerNames, ...marketNames.filter((name) => name === "S")],
  });
  const workers = crews.map((names) => names.map((name) => fixture.actors[name]!));
  let market: { session: MarketplaceSession; seller: ScenarioActor; buyer: ScenarioActor } | undefined;
  if (fixture.marketplace) {
    const seller = fixture.actors.S!;
    const buyer = fixture.actors.M!;
    log("opening the marketplace session");
    const session = await openMarketplaceSession(await fixtureMarketplaceContext(fixture, {
      seller, buyer, label: "traffic-marketplace", openFeeAmount: fixture.config.assets.actionFee,
    }));
    market = { session, seller, buyer };
  }
  const lanes = LANES.filter((lane) => lane !== "marketplace-trade" || market !== undefined);
  const harnessBalance = () => l1Rpc<string>(fixture.backend.rpcUrl, "eth_getBalance", [fixture.harness.address, "latest"]).then(BigInt);
  const initialHarnessBalance = await harnessBalance();
  const accepted = Object.fromEntries(lanes.map((lane) => [lane, 0])) as Record<Lane, number>;
  const failed = Object.fromEntries(lanes.map((lane) => [lane, 0])) as Record<Lane, number>;
  const startedAt = Date.now();
  const deadline = fixture.durationMs === undefined ? undefined : startedAt + fixture.durationMs;
  let fatal: unknown;
  let trading = false;
  let lastTradeAt = 0;
  let rounds = 0;
  const done = () => fatal !== undefined || fixture.stopRequested || (deadline !== undefined && Date.now() >= deadline);

  // Earn issuance for an actor whose balance cannot cover the next action.
  const ensureFunds = async (actor: ScenarioActor, minimum: bigint): Promise<bigint> => {
    let balance = await actor.balance();
    if (balance >= minimum) return balance;
    const earned = await (await actor.client()).send({
      to: actor.address, amount: 0n, openFeeAmount: 0n, submission: fixture.harness.l1Batched(),
    });
    await fixture.waitForAcceptedAcrossNodes(earned.contentHash, `traffic-earn-${actor.name}`);
    balance = await actor.balance();
    if (balance < minimum) throw new Error(`${actor.name} holds ${balance}, below the ${minimum} this round needs`);
    return balance;
  };

  const lanesByName: Record<Lane, (payers: readonly ScenarioActor[], round: number) => Promise<string | undefined>> = {
    "relayed-payment": async (payers, round) => {
      const [sender, recipient] = pair(payers, round);
      const amount = (await ensureFunds(sender, 100n)) / 4n;
      // The wallet default: the node's suggested fee on the open route, paid with issuance to the relayer.
      const sent = await (await sender.client()).send({ to: recipient.address, amount });
      await fixture.waitForAcceptedAcrossNodes(sent.contentHash, `traffic-${round}-relayed`);
      return `${sender.name}->${recipient.name} ${amount} ${sent.contentHash}`;
    },
    "self-published-payment": async (payers, round) => {
      const [sender, recipient] = pair(payers, round);
      const amount = (await ensureFunds(sender, 100n)) / 8n;
      // No open fee: the action names the sender's own commitment, which collects its issuance.
      const sent = await (await sender.client()).send({
        to: recipient.address, amount, openFeeAmount: 0n, submission: fixture.harness.l1(sender.wallet),
      });
      await fixture.waitForAcceptedAcrossNodes(sent.contentHash, `traffic-${round}-self-published`);
      return `${sender.name}->${recipient.name} ${amount} ${sent.contentHash}`;
    },
    "batched-payments": async (payers, round) => {
      const queued = fixture.harness.mempool({ relay: false });
      const contentHashes = await Promise.all(payers.map(async (sender, index) => {
        const recipient = payers[(index + 1) % payers.length]!;
        const amount = (await ensureFunds(sender, 100n)) / 10n;
        return (await (await sender.client()).send({ to: recipient.address, amount, openFeeAmount: 1n, submission: queued })).contentHash;
      }));
      await Promise.all(contentHashes.map((contentHash) => fixture.waitForPeerCopy(contentHash)));
      const relay = await fixture.harness.relayExact(contentHashes);
      await Promise.all(contentHashes.map((contentHash, index) => fixture.waitForAcceptedAcrossNodes(contentHash, `traffic-${round}-batched-${index}`)));
      return `${contentHashes.length} payments in ${relay.txHash}`;
    },
    "asset-lifecycle": async (payers, round) => {
      const [creator, holder, recipient] = rotate(payers, round);
      await ensureFunds(creator, 100n);
      const result = await runFixtureAssetFlow(fixture, { creator, holder, recipient }, `traffic-assets-${round}`);
      return `${creator.name} created ${result.assetId} for ${holder.name} and ${recipient.name}`;
    },
    "marketplace-trade": async () => {
      // One seller and buyer serve every worker, one trade at a time.
      const tooSoon = fixture.mode === "live" && lastTradeAt !== 0 && Date.now() - lastTradeAt < LIVE_TRADE_INTERVAL_MS;
      if (trading || tooSoon) return undefined;
      trading = true;
      try {
        const { session, seller, buyer } = market!;
        await ensureFunds(seller, 4n * TRADE_AMOUNT);
        await fixture.fundL1Gas(buyer.address, 1, fixture.config.marketplace.ethPriceWei);
        const trade = await runPaidMarketplaceTrade(session, TRADE_AMOUNT);
        lastTradeAt = Date.now();
        return `${seller.name} sold ${TRADE_AMOUNT} to ${buyer.name}: payment ${trade.paymentTxHash}, claim ${trade.claimContentHash}`;
      } finally {
        trading = false;
      }
    },
  };

  const work = async (payers: readonly ScenarioActor[], worker: number) => {
    let consecutiveFailures = 0;
    // Stagger the workers so they start on different lanes.
    for (let round = worker; !done(); round += 1) {
      const lane = lanes[round % lanes.length]!;
      try {
        const detail = await lanesByName[lane](payers, round);
        if (detail === undefined) continue;
        accepted[lane] += 1;
        consecutiveFailures = 0;
        fixture.artifacts.record("traffic-round", { worker, round, lane, detail });
        log(`w${worker + 1} ${lane}: ${detail}`);
      } catch (error) {
        failed[lane] += 1;
        consecutiveFailures += 1;
        const message = describe(error);
        fixture.artifacts.record("traffic-round-failed", { worker, round, lane, error: message });
        log(`w${worker + 1} ${lane} failed: ${message}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) fatal ??= error;
      } finally {
        rounds += 1;
      }
    }
  };

  const summarize = async () => {
    const elapsedMinutes = Math.max(1, Date.now() - startedAt) / 60_000;
    const total = Object.values(accepted).reduce((sum, count) => sum + count, 0);
    const actors = [...workers.flat(), ...(market === undefined ? [] : [market.seller])];
    const balances = Object.fromEntries(await Promise.all(actors.map(async (actor) => [actor.name, await actor.balance()] as const)));
    const summary = {
      rounds,
      accepted,
      failed,
      ratePerMinute: Number((total / elapsedMinutes).toFixed(2)),
      inFlightL1: (await fixture.harness.journal.read()).length,
      balances,
      harnessSpentWei: initialHarnessBalance - await harnessBalance(),
    };
    fixture.artifacts.record("traffic-summary", summary);
    log(`summary ${JSON.stringify(summary, (_, value) => typeof value === "bigint" ? value.toString() : value)}`);
  };

  const report = async () => {
    while (!done()) {
      const next = Date.now() + SUMMARY_INTERVAL_MS;
      while (!done() && Date.now() < next) await sleep(500);
      if (!done()) await summarize().catch((error: unknown) => log(`summary failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  };

  log(`${workers.length} workers running ${lanes.join(", ")}`);
  try {
    await Promise.all([...workers.map(work), report()]);
    await summarize();
  } finally {
    await market?.session.close();
  }
  if (fatal !== undefined) throw fatal;
  fixture.artifacts.record("traffic-complete", { accepted, failed, elapsedMs: Date.now() - startedAt });
}

/** An error's message followed by each of its causes'. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const messages: string[] = [];
  for (let cause: unknown = error; cause instanceof Error && messages.length < 6; cause = cause.cause) {
    messages.push(cause.message);
  }
  return messages.join(": ");
}

function pair(actors: readonly ScenarioActor[], round: number): [ScenarioActor, ScenarioActor] {
  const index = round % actors.length;
  return [actors[index]!, actors[(index + 1) % actors.length]!];
}

function rotate(actors: readonly ScenarioActor[], round: number): [ScenarioActor, ScenarioActor, ScenarioActor] {
  const index = round % actors.length;
  return [actors[index]!, actors[(index + 1) % actors.length]!, actors[(index + 2) % actors.length]!];
}
