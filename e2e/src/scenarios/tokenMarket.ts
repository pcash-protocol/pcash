import { createHash } from "node:crypto";
import {
  offerKey,
  publicationAssetDefinition,
  type OfferPublication,
} from "@pcash/marketplace/client";
import { reclaimNotBefore } from "@pcash/marketplace";
import { LOCAL_PAYMENT_ROUTER_CONFIG, setupPaymentRouter } from "@pcash/marketplace/tooling/paymentRouterSetup";
import { awaitAcceptedReceipt } from "@pcash/sdk/clients";
import { encodeAssetDefinition } from "@pcash/sdk/protocol";
import { createWalletProvers } from "@pcash/sdk/wallet/node";
import { openMemoryNodeWallet } from "@pcash/wallet";
import type { DurableSubmissionAdapter, Wallet } from "@pcash/sdk/wallet";
import { withAnvilMiningPaused } from "../backends/anvil.ts";
import { l1Rpc } from "../backends/rpc.ts";
import type { ScenarioActor } from "../actors/actor.ts";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { marketplaceController } from "./marketplaceClient.ts";
import { setupUserWallets } from "./setup.ts";

const ETH_PRICE_WEI = 10n ** 15n;

/**
 * Token listings through the Marketplace controller against a real node and
 * PaymentRouter: the seller lists a token it created, the buyer's one
 * Ethereum transaction pays ETH and carries the claim, and the verified token
 * reaches the buyer's wallet with no PCASH spent; an unsold listing returns to
 * the seller after its deadline, with the seller's PCASH paying the reclaim's
 * open fee.
 */
export async function runTokenMarketScenario(fixture: ScenarioFixture): Promise<void> {
  // Alice (S) creates FOO and lists it; Bob (R) holds no PCASH and buys one listing.
  await setupUserWallets(fixture, { actors: ["S", "R"], accounts: ["S", "R"], funded: ["S"] });
  const { S: aliceActor, R: bobActor } = fixture.actors;
  if (!aliceActor || !bobActor) throw new Error("token market actors are missing");
  // Both send their own Ethereum transactions; Bob's buy also pays the listing price.
  await Promise.all([fixture.fundL1Gas(aliceActor.address, 16), fixture.fundL1Gas(bobActor.address, 8, ETH_PRICE_WEI)]);
  const node = fixture.nodeA.client;
  const l1RpcUrl = fixture.backend.rpcUrl;
  const openFee = fixture.config.assets.actionFee;
  const log = (message: string) => fixture.artifacts.record("token-market-progress", { message });

  // The harness key posts each batch naming the actor as poster, so the actor's own Ethereum reserve covers no gas.
  const selfPublished = (label: string, poster: ScenarioActor): DurableSubmissionAdapter => ({
    mode: "l1",
    preflightL1Budget: async () => ({ address: fixture.harness.address, maximumCostWei: 0n }),
    preflight: async () => undefined,
    async submit({ transactionBytes: entry }) {
      const accepted = await fixture.publishOnL1(entry, label, poster.wallet);
      return { accepted: true, queued: false, output: accepted };
    },
  });
  // The Marketplace brings its own mempool transport, so these wallets configure none.
  const open = async (actor: ScenarioActor): Promise<Wallet> => {
    const wallet = await openMemoryNodeWallet({
      node,
      profile: actor.wallet,
      signer: actor.signer,
      provers: createWalletProvers("native"),
      settlePollIntervalMs: 1_000,
      settlePollMaxAttempts: 180,
    });
    await wallet.sync();
    return wallet;
  };
  const router = await setupPaymentRouter({
    rpcUrl: l1RpcUrl,
    l1ChainId: fixture.network.l1ChainId,
    cacheRoot: fixture.artifacts.path("token-market"),
    routerConfig: LOCAL_PAYMENT_ROUTER_CONFIG,
    privateKey: aliceActor.privateKey,
  });
  const controller = (wallet: Wallet, actor: ScenarioActor) => marketplaceController({
    node, wallet, l1RpcUrl, l1PrivateKey: actor.privateKey, router: router.address,
  });
  const holding = async (wallet: Wallet, assetId: bigint): Promise<bigint> => {
    await wallet.sync();
    const asset = (await wallet.assets()).find((candidate) => candidate.assetId === assetId);
    if (asset?.definition?.metadata.symbol !== "FOO" || asset.definition.metadata.decimals !== 6) {
      throw new Error(`${wallet.address} does not hold the verified FOO definition`);
    }
    return asset.private;
  };
  const pcash = async (wallet: Wallet): Promise<bigint> => {
    await wallet.sync();
    return (await wallet.balances({ assetId: 0n }))[0]?.private ?? 0n;
  };

  const alice = await open(aliceActor);
  const bob = await open(bobActor);
  try {
    const supply = 1_000_000_000n;
    const created = await alice.createAsset({
      metadata: { name: "Foo", symbol: "FOO", decimals: 6, contentDigest: createHash("sha256").update("FOO token terms").digest() },
      initialSupply: supply,
      submission: selfPublished("token-market-create", aliceActor),
    });
    if (!created.accepted) throw new Error("FOO creation was not accepted");
    const assetId = created.assetId;
    if (await holding(alice, assetId) !== supply) throw new Error("Alice does not hold the FOO supply");
    log("FOO created");

    // Both listings are funded from Alice's FOO and PCASH over the relayed route.
    const aliceMarket = controller(alice, aliceActor);
    const list = async (amount: bigint, purchaseMinutes: bigint): Promise<OfferPublication> => {
      await alice.sync();
      const published = await aliceMarket.createAndPublish({
        assetId,
        assetDefinition: encodeAssetDefinition(created.definition),
        amount,
        ethPriceWei: ETH_PRICE_WEI,
        purchaseMinutes,
        creationOpenFeeAmount: openFee,
        fundingOpenFeeAmount: openFee,
      }, { relay: async (contentHash) => { await fixture.harness.relayExact([contentHash]); } });
      if (!published.catalogPublished) throw new Error(`the ${amount} FOO listing was not published`);
      return published.publication;
    };
    const sold = await list(400_000n, 60n);
    log("sold listing published");

    // Bob finds the listing in the catalog with its verified definition; one buy pays ETH and carries the claim.
    const bobMarket = controller(bob, bobActor);
    const listed = (await bobMarket.refresh()).catalogOffers.find((candidate) => offerKey(candidate) === offerKey(sold));
    if (listed === undefined) throw new Error("the catalog does not list Alice's FOO");
    if (publicationAssetDefinition(listed)?.metadata.symbol !== "FOO") throw new Error("the catalog listing does not verify as FOO");
    const verification = await bobMarket.verify(listed);
    if (!verification.safeToPay) throw new Error(`the FOO listing is not safe to pay: ${verification.checks.join("; ")}`);
    if (await pcash(bob) !== 0n) throw new Error("Bob must hold no PCASH to show the claim needs none");
    const bought = await bobMarket.buy(listed);
    const claim = await awaitAcceptedReceipt(node, bought.claimContentHash);
    if (claim.inclusion.l1TransactionHash.toLowerCase() !== bought.paymentHash.toLowerCase()) {
      throw new Error("the FOO claim was not carried by Bob's payment");
    }
    if (await holding(bob, assetId) !== 400_000n) throw new Error("Bob does not hold the bought FOO");
    log("Bob bought FOO");

    // The unsold listing: refused at its deadline, then reclaimed after it with Alice's PCASH paying the fee.
    const unsold = await list(250_000n, 10n);
    log("unsold listing published");
    // Interval mining would otherwise move L1 past T before the reclaim reads it.
    await withAnvilMiningPaused(fixture.backend.rpcUrl, async () => {
      await advanceTo(fixture, BigInt(unsold.terms.deadlineT));
      try {
        await aliceMarket.reclaim(unsold, openFee);
        throw new Error("a reclaim at the deadline was accepted");
      } catch (error) {
        if (!(error instanceof Error) || !/reclaim opens at L1 timestamp/.test(error.message)) throw error;
      }
    });
    await advanceTo(fixture, reclaimNotBefore(BigInt(unsold.terms.deadlineT)));
    const pcashBefore = await pcash(alice);
    // The reclaim goes to the mempool, where a relayer picks it up.
    fixture.harness.startAutoRelay();
    const reclaimContentHash = await aliceMarket.reclaim(unsold, openFee).finally(() => fixture.harness.stopAutoRelay());
    if (await holding(alice, assetId) !== supply - 400_000n) throw new Error("Alice's FOO after the reclaim is wrong");
    const pcashAfter = await pcash(alice);
    if (pcashBefore - pcashAfter !== openFee) throw new Error(`Alice's reclaim cost ${pcashBefore - pcashAfter} PCASH, expected ${openFee}`);
    log("Alice reclaimed the unsold listing");

    fixture.artifacts.record("token-market-complete", {
      assetId: `0x${assetId.toString(16)}`,
      router: router.address,
      sold: { offer: offerKey(sold), paymentHash: bought.paymentHash, claimContentHash: bought.claimContentHash },
      unsold: { offer: offerKey(unsold), reclaimContentHash },
    });
  } finally {
    await Promise.allSettled([alice.close(), bob.close()]);
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
