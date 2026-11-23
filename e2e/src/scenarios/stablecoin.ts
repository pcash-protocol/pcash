import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createPublicClient, createWalletClient, defineChain, http, toHex, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { offerKey, publicationContractAddress, type OfferPublication } from "@pcash/marketplace/client";
import { reclaimNotBefore } from "@pcash/marketplace";
import { LOCAL_PAYMENT_ROUTER_CONFIG, setupPaymentRouter } from "@pcash/marketplace/tooling/paymentRouterSetup";
import { memoSchema } from "@pcash/sdk/delivery";
import { decodeDepositCode, depositReplayId, depositSalt, recognizeMintRule, recognizeTransferRule } from "@pcash/sdk/rules";
import {
  DenyListAdmin,
  ERC20_ABI,
  EthereumWriter,
  RESERVE_VAULT_ABI,
  StablecoinIssuer,
  memoryIssuerStateStore,
  redemptionMemo,
  stablecoinDefinition,
} from "@pcash/stablecoin";
import {
  addressHex,
  assetDefinitionDescriptor,
  awaitAcceptedReceipt,
  bytes32Hex,
  createWalletProvers,
  deferSubmission,
  derivePcashProfileFromPrivateKey,
  encodeAssetDefinition,
  encodeBatch,
  fromHex,
  isRestrictedAssetId,
  mintMarker,
  openMemoryNodeWallet,
  openNodeWallet,
  posterPayoutOpening,
  randomFieldEntropy,
  transactionIdentity,
  viemL1LogReader,
  type AssetDefinition,
  type Wallet,
  type WalletDeposit,
} from "../deps.ts";
import type { ScenarioActor } from "../actors/actor.ts";
import { withAnvilMiningPaused } from "../backends/anvil.ts";
import { eventually } from "../framework/eventually.ts";
import { l1Rpc } from "../backends/rpc.ts";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { marketplaceController } from "./marketplaceClient.ts";
import { setupUserWallets } from "./setup.ts";

const DELTA = 3600n;
const USDC = (whole: bigint) => whole * 1_000_000n;
const ETH_PRICE_WEI = 10n ** 15n;
/** The wallet's ordinary deadline window, which bounds any proof it builds. */
const WALLET_WINDOW = 1800n;
/** How often the issuer's heartbeat timer reads the deny list's age. */
const HEARTBEAT_CHECK_MS = 500;

/**
 * The stablecoin acceptance run: a deposit-mint asset under a sender deny
 * list, its reserve vault on Ethereum, an issuer that credits, administers the
 * vault and the list and redeems, three holders whose wallets mint their own
 * deposits, and the Marketplace, all on a local chain with real proofs.
 */
export async function runStablecoinScenario(fixture: ScenarioFixture): Promise<void> {
  const { backend } = fixture;
  assert.ok(fixture.mode === "local" && backend.anvil, "the stablecoin scenario deploys its contracts to a local chain");
  const names = ["Issuer", "Alice", "Bob", "Carol"] as const;
  await setupUserWallets(fixture, { actors: [...names], accounts: [...names], funded: [...names] });
  const actor = (name: (typeof names)[number]): ScenarioActor => fixture.actors[name]!;
  // Each wallet reopens below with an Ethereum log reader, which the restricted asset and deposits need.
  await Promise.all(names.map((name) => actor(name).close()));

  const node = fixture.nodeA.client;
  const rpcUrl = backend.rpcUrl;
  const chain = defineChain({
    id: Number(fixture.network.l1ChainId), name: "local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  const l1Wallet = (key: Hex) => createWalletClient({ chain, account: privateKeyToAccount(key), transport: http(rpcUrl) });
  const confirm = async (hash: Hex | Promise<Hex>): Promise<void> => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: await hash });
    assert.equal(receipt.status, "success");
  };
  // One issuer key sends the vault's and the deny list's transactions through one writer, which the list's heartbeat timer shares with vault writes.
  const issuerKey = generatePrivateKey();
  const issuerEth = new EthereumWriter({ publicClient, walletClient: l1Wallet(issuerKey) as WalletClient });
  // Alice funds her deposits from an Ethereum account other than her own.
  const aliceBankKey = generatePrivateKey();
  const aliceBank = privateKeyToAccount(aliceBankKey).address;
  await Promise.all([
    fixture.fundL1Gas(issuerEth.address, 64),
    fixture.fundL1Gas(aliceBank, 16),
    fixture.fundL1Gas(actor("Alice").address, 16, ETH_PRICE_WEI),
    fixture.fundL1Gas(actor("Bob").address, 8),
    fixture.fundL1Gas(actor("Carol").address, 8, 2n * ETH_PRICE_WEI),
  ]);
  const log = (message: string, details: Record<string, unknown> = {}) => fixture.artifacts.record("stablecoin-progress", { message, ...details });

  // --- 1. The issuer deploys its contracts and defines pUSD ---
  const deploy = (contract: string, key: Hex, args: readonly string[] = []): Address => {
    const output = execFileSync("forge", ["create", "--root", join(fixture.repoRoot, "stablecoin/l1-contracts"), contract,
      "--rpc-url", rpcUrl, "--private-key", key, "--broadcast", "--json",
      ...(args.length === 0 ? [] : ["--constructor-args", ...args])], { encoding: "utf8" });
    const deployment = JSON.parse(output.slice(output.indexOf("{"))) as { deployedTo: Address };
    assert.match(deployment.deployedTo, /^0x[0-9a-fA-F]{40}$/);
    return deployment.deployedTo;
  };
  const denyListContract = deploy("src/DenyList.sol:DenyList", issuerKey);
  const usdc = deploy("src/testing/MockUSDC.sol:MockUSDC", issuerKey);
  const vault = deploy("src/ReserveVault.sol:ReserveVault", issuerKey, [usdc, issuerEth.address, USDC(10_000n).toString()]);
  const admin = await DenyListAdmin.create({
    publicClient, writer: issuerEth, contract: denyListContract,
    salt: `0x${randomBytes(32).toString("hex")}`, delta: DELTA, maxDelta: 2n * DELTA,
  });
  const settle = () => fixture.waitForNodesAtL1Head();
  /** The Ethereum timestamp of the block that holds a deny-list change, and so its publication. */
  const publishedAt = async (hash: Promise<Hex>): Promise<bigint> => {
    const receipt = await publicClient.getTransactionReceipt({ hash: await hash });
    return (await publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp;
  };
  const definition: AssetDefinition = stablecoinDefinition({
    metadata: { name: "Pilot USD", symbol: "pUSD", decimals: 6, contentDigest: createHash("sha256").update("pUSD terms").digest() },
    vault,
    denyList: admin.configuration,
  });
  const descriptor = assetDefinitionDescriptor(definition);
  const assetId = descriptor.assetId;
  assert.ok(isRestrictedAssetId(assetId), "a stablecoin with a deny list is in the restricted class");
  assert.equal(recognizeMintRule(definition.mintRule).kind, "deposit-mint");
  assert.equal(recognizeTransferRule(definition.transferRule!).kind, "sender-deny-list");
  await settle();
  log("pUSD defined", { assetId: `0x${assetId.toString(16)}`, denyListContract, vault });

  const l1Logs = viemL1LogReader(publicClient);
  const walletOptions = (scenarioActor: ScenarioActor) => ({
    node, profile: scenarioActor.wallet, signer: scenarioActor.signer,
    provers: createWalletProvers("native"), submission: fixture.harness.mempool(), l1Logs,
    ...fixture.harness.walletSettleWait(),
  });
  const open = async (scenarioActor: ScenarioActor): Promise<Wallet> => {
    const wallet = await openNodeWallet({ dataDir: scenarioActor.walletDatabasePath, ...walletOptions(scenarioActor) });
    await wallet.sync();
    return wallet;
  };
  /** The actor's wallet restored from its key alone, with no local state. */
  const restore = async (scenarioActor: ScenarioActor): Promise<Wallet> => {
    const wallet = await openMemoryNodeWallet(walletOptions(scenarioActor));
    await wallet.sync();
    return wallet;
  };
  const [issuerWallet, alice, bob, carol] = await Promise.all(names.map((name) => open(actor(name))));
  const wallets = [issuerWallet!, alice!, bob!, carol!];
  let heartbeat: { stop(): Promise<void> } | undefined;
  try {
    await issuerWallet!.importAssetDefinition(definition);
    const balance = async (wallet: Wallet): Promise<bigint> => {
      await wallet.sync();
      const asset = (await wallet.assets()).find((candidate) => candidate.assetId === assetId);
      if (asset === undefined) return 0n;
      assert.ok(asset.definition?.transferRule !== undefined, "a holder keeps pUSD's verified definition with its transfer rule");
      return asset.private;
    };
    // A send reads the deny list as of the wallet's last sync, as a wallet's background sync keeps it.
    const pay = async (wallet: Wallet, to: ScenarioActor, amount: bigint) => {
      await wallet.sync();
      return wallet.sendAsset({ assetId, outputs: [{ to: to.address, amount }] });
    };
    const refused = async (action: Promise<unknown>, reason: RegExp, label: string): Promise<void> => {
      const error = await action.then(() => undefined, (caught: unknown) => caught);
      assert.ok(error instanceof Error, `${label}: the action succeeded`);
      assert.match(error.message, reason, `${label}: ${error.message}`);
    };
    const inbox = { kind: "inbox" as const, address: addressHex(fixture.network.inboxAddress) };

    // Each proof held back below keeps its native fee note reserved, so Bob and Carol get a second one.
    for (const name of ["Bob", "Carol"] as const) {
      await alice!.sync();
      await alice!.send({ to: actor(name).address, amount: 10n ** 19n });
    }

    // --- 2. The issuer opens the vault to its customers ---
    const issuerStore = memoryIssuerStateStore();
    const issuer = new StablecoinIssuer({
      wallet: issuerWallet!, node, definition,
      ethereum: { publicClient, writer: issuerEth }, store: issuerStore,
    });
    assert.equal(issuer.vault.toLowerCase(), vault.toLowerCase());
    const depositReverts = async (depositor: Address, amount: bigint, reason: RegExp, label: string): Promise<void> => {
      await refused(publicClient.simulateContract({
        account: depositor, address: vault, abi: RESERVE_VAULT_ABI, functionName: "deposit", args: [amount, bytes32Hex(1n), bytes32Hex(1n)],
      }), reason, label);
    };
    await depositReverts(aliceBank, USDC(1n), /NotAllowed/, "the vault refuses a depositor the issuer has not allowed");
    await issuer.allow(aliceBank, true);
    await issuer.allow(actor("Bob").address as Address, true);
    await issuer.setDepositCap(USDC(2_000n));
    await depositReverts(aliceBank, USDC(2_001n), /AmountAboveCap/, "the vault refuses a deposit above the cap");
    await issuer.setDepositsPaused(true);
    await depositReverts(aliceBank, USDC(1n), /DepositsPaused/, "the vault refuses deposits while paused");
    await issuer.setDepositsPaused(false);
    log("vault policy set");

    // --- 3. Deposits mint in seconds, from the recipient's wallet ---
    const fund = async (key: Hex, amount: bigint): Promise<void> => {
      const eth = l1Wallet(key);
      await confirm(eth.writeContract({ address: usdc, abi: ERC20_ABI, functionName: "mint", args: [eth.account.address, amount] }));
      await confirm(eth.writeContract({ address: usdc, abi: ERC20_ABI, functionName: "approve", args: [vault, amount] }));
    };
    /** A depositor's vault deposit to the holder whose wallet issued `depositCode`; sent, not awaited. */
    const sendDeposit = (key: Hex, depositCode: string, amount: bigint): Promise<Hex> => {
      const code = decodeDepositCode(depositCode, { pcashChainId: fixture.network.pcashChainId, vault: BigInt(vault) });
      return l1Wallet(key).writeContract({
        address: vault, abi: RESERVE_VAULT_ABI, functionName: "deposit", args: [amount, bytes32Hex(code.recipientCommitment), bytes32Hex(code.nonce)],
      });
    };
    /** Neither topic nor data of any log in the transaction holds the recipient's address. */
    const assertRecipientHidden = async (hash: Hex, recipient: string, label: string): Promise<void> => {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      const deposits = receipt.logs.filter((entry) => entry.address.toLowerCase() === vault.toLowerCase());
      assert.equal(deposits.length, 1, `${label}: one vault log`);
      assert.equal(deposits[0]!.topics.length, 2, `${label}: the vault log indexes only the depositor`);
      const needle = recipient.slice(2).toLowerCase();
      for (const entry of receipt.logs) {
        assert.ok(![...entry.topics, entry.data].some((word) => word.toLowerCase().includes(needle)), `${label}: a log names the recipient`);
      }
    };
    /** This wallet's deposit from `hash`, once PCASH has derived its Ethereum block. */
    const depositOf = async (wallet: Wallet, hash: Hex): Promise<WalletDeposit> => {
      await settle();
      const found = (await wallet.listDeposits({ asset: definition })).find((deposit) => deposit.transactionHash.toLowerCase() === hash.toLowerCase());
      assert.ok(found !== undefined, `the wallet finds deposit ${hash}`);
      return found;
    };

    await fund(aliceBankKey, USDC(1_000n));
    const aliceDeposit = await sendDeposit(aliceBankKey, alice!.createDepositCode({ asset: definition }), USDC(1_000n));
    await confirm(aliceDeposit);
    const mintStarted = performance.now();
    const aliceFound = await depositOf(alice!, aliceDeposit);
    assert.equal(aliceFound.minted, false);
    assert.equal(aliceFound.depositor, BigInt(aliceBank));
    assert.equal(aliceFound.amount, USDC(1_000n));
    const aliceMint = await alice!.mintDeposit({ asset: definition, deposit: aliceFound });
    assert.equal(aliceMint.accepted, true);
    const mintMs = performance.now() - mintStarted;
    await assertRecipientHidden(aliceDeposit, actor("Alice").address, "Alice's deposit");
    assert.equal(await balance(alice!), USDC(1_000n));
    assert.equal((await depositOf(alice!, aliceDeposit)).minted, true);
    await refused(alice!.mintDeposit({ asset: definition, deposit: aliceFound }), /already minted/, "the wallet refuses a minted deposit");
    // A deposit's code names its asset: another asset with pUSD's vault and deny list holds none of Alice's deposits.
    const copycat = stablecoinDefinition({
      metadata: { name: "Pilot USD", symbol: "pUSD", decimals: 6, contentDigest: createHash("sha256").update("copycat terms").digest() },
      vault, denyList: admin.configuration,
    });
    assert.notEqual(assetDefinitionDescriptor(copycat).assetId, assetId);
    assert.deepEqual(await alice!.listDeposits({ asset: copycat }), [], "a deposit opens only for the asset its code names");
    log("deposit minted by its recipient", { mintMs: Math.round(mintMs) });

    // --- 4. A wallet restored from its key finds and mints an unminted deposit, once ---
    await fund(actor("Bob").privateKey, USDC(500n));
    const bobDeposit = await sendDeposit(actor("Bob").privateKey, bob!.createDepositCode({ asset: definition }), USDC(500n));
    await confirm(bobDeposit);
    // A proof of the deposit's mint, built by one restored wallet and held back. A wallet journals one pending mint per deposit.
    const heldBy = await restore(actor("Bob"));
    let held: Uint8Array;
    try {
      const prepared = await heldBy.mintDeposit({
        asset: definition, deposit: await depositOf(heldBy, bobDeposit), submission: deferSubmission(fixture.harness.mempool()),
      });
      assert.equal(prepared.accepted, false);
      held = fromHex(prepared.transactionHex);
    } finally {
      await heldBy.close();
    }
    assert.equal((await node.checkRawTransaction(held, inbox)).outcome, "succeeded", "the held proof is valid while the deposit is unminted");
    const restoredBob = await restore(actor("Bob"));
    try {
      const unminted = await depositOf(restoredBob, bobDeposit);
      assert.equal(unminted.minted, false);
      const minted = await restoredBob.mintDeposit({ asset: definition, deposit: unminted });
      assert.equal(minted.accepted, true);
      const marker = bytes32Hex(mintMarker(assetId, depositReplayId(unminted.position.l1BlockNumber, unminted.position.blockLogIndex,
        depositSalt(actor("Bob").wallet.nkRoot, fixture.network.pcashChainId, BigInt(vault), unminted.nonce))));
      assert.ok((await node.getReceipt({ nullifier: marker })).some((receipt) => receipt.contentHash.toLowerCase() === minted.contentHash.toLowerCase()),
        "the mint spends the deposit's marker");
      assert.equal((await node.checkRawTransaction(held, inbox)).outcome, "nullifierAlreadySpent",
        "a second proof of a minted deposit spends a marker already spent");
      await refused(restoredBob.mintDeposit({ asset: definition, deposit: unminted }), /already minted/, "the restored wallet refuses a minted deposit");
    } finally {
      await restoredBob.close();
    }
    assert.equal(await balance(bob!), USDC(500n), "Bob's own wallet holds what his restored wallet minted");
    assert.equal((await depositOf(bob!, bobDeposit)).minted, true);
    log("restored wallet minted once");

    // --- 5. Holders pay each other ---
    const sendStarted = performance.now();
    await pay(alice!, actor("Carol"), USDC(100n));
    const restrictedSendMs = performance.now() - sendStarted;
    await pay(bob!, actor("Carol"), USDC(50n));
    // Bob holds two notes, so the proof he holds back below leaves one to try the freeze with.
    await pay(alice!, actor("Bob"), USDC(30n));
    assert.equal(await balance(carol!), USDC(150n));
    assert.equal(await balance(alice!), USDC(870n));
    assert.equal(await balance(bob!), USDC(480n));
    log("holders paid each other", { restrictedSendMs: Math.round(restrictedSendMs) });

    // --- 6. A freeze stops the frozen sender within the proof lifetime the publication bounds ---
    const deferred = async (wallet: Wallet, to: ScenarioActor, amount: bigint): Promise<{ bytes: Uint8Array; expiresBy: bigint }> => {
      await wallet.sync();
      const prepared = await wallet.sendAsset({ assetId, outputs: [{ to: to.address, amount }], submission: deferSubmission(fixture.harness.mempool()) });
      assert.equal(prepared.accepted, false);
      return { bytes: fromHex(prepared.transactionHex), expiresBy: (await node.status()).latestBlockTimestamp + WALLET_WINDOW };
    };
    const heldBob = await deferred(bob!, actor("Carol"), USDC(10n));
    const frozenAt = await publishedAt(admin.freeze([actor("Bob").address as Address]));
    await settle();
    await refused(pay(bob!, actor("Carol"), USDC(10n)), /frozen/, "a frozen holder cannot send");
    await refused(bob!.sync().then(() => bob!.burnAsset({ assetId, amount: USDC(1n) })), /frozen/, "a frozen holder cannot burn");
    await pay(carol!, actor("Alice"), USDC(20n));
    assert.equal((await node.checkRawTransaction(heldBob.bytes, inbox)).outcome, "succeeded", "a proof built before the freeze lasts until its deadline");
    await advanceTo(fixture, heldBob.expiresBy + 1n);
    assert.equal((await node.checkRawTransaction(heldBob.bytes, inbox)).outcome, "expired", "and fails once its lifetime has passed");
    // Once the newest publication no longer authorizes a full wallet window, transfers wait for the next heartbeat.
    await advanceTo(fixture, frozenAt + DELTA - WALLET_WINDOW + 60n);
    await refused(pay(carol!, actor("Alice"), USDC(1n)), /next publication|heartbeat/, "a stale publication holds every transfer");
    log("freeze enforced");

    // --- 7. The issuer's heartbeat keeps transfers flowing with no manual publication ---
    heartbeat = admin.startHeartbeat({
      checkEveryMs: HEARTBEAT_CHECK_MS,
      onError: (error) => fixture.artifacts.record("stablecoin-heartbeat-failed", { error: error instanceof Error ? error.message : String(error) }),
    });
    const payAfterHeartbeat = (label: string) => eventually(label, () => pay(carol!, actor("Alice"), USDC(1n)), () => true,
      { timeoutMs: 60_000, intervalMs: 1_000 });
    await payAfterHeartbeat("a heartbeat to let Carol pay again");
    // Each jump leaves the latest publication too old for a full wallet window.
    for (let round = 1; round <= 2; round += 1) {
      await advanceTo(fixture, await chainNow(fixture) + WALLET_WINDOW + 60n);
      await payAfterHeartbeat(`a heartbeat to keep transfers flowing (round ${round})`);
    }
    log("heartbeats kept transfers flowing");

    // --- 8. A pause stops every sender; a list change during it does not restart them ---
    const heldCarol = await deferred(carol!, actor("Alice"), USDC(5n));
    await admin.pause();
    await settle();
    await refused(pay(carol!, actor("Alice"), USDC(5n)), /paused/, "a pause stops Carol");
    await refused(pay(alice!, actor("Carol"), USDC(5n)), /paused/, "a pause stops Alice");
    await admin.freeze([privateKeyToAccount(generatePrivateKey()).address]);
    await settle();
    await refused(pay(alice!, actor("Carol"), USDC(5n)), /paused/, "a list change during a pause keeps it paused");
    assert.equal((await node.checkRawTransaction(heldCarol.bytes, inbox)).outcome, "succeeded", "a proof built before the pause lasts until its deadline");
    await advanceTo(fixture, heldCarol.expiresBy + 1n);
    assert.equal((await node.checkRawTransaction(heldCarol.bytes, inbox)).outcome, "expired", "and fails once its lifetime has passed");
    await admin.unpause();
    await settle();
    await pay(alice!, actor("Carol"), USDC(5n));
    log("pause enforced and lifted");

    // --- 9. The issuer credits replacement units to a victim, minted privately like a deposit ---
    const carolBefore = await balance(carol!);
    const carolCode = carol!.createDepositCode({ asset: definition });
    const credit = await issuer.credit({ depositCode: carolCode, amount: USDC(10n) });
    await assertRecipientHidden(credit, actor("Carol").address, "the issuer's credit");
    const credited = await depositOf(carol!, credit);
    assert.equal(credited.depositor, BigInt(issuerEth.address), "a credit is a deposit from the issuer");
    await refused(issuer.credit({ depositCode: carolCode, amount: USDC(10n) }), /AlreadyCredited/, "the vault credits a deposit code once");
    await settle();
    assert.equal((await carol!.listDeposits({ asset: definition })).length, 1, "the holder lists one credit");
    assert.equal((await carol!.mintDeposit({ asset: definition, deposit: credited })).accepted, true);
    assert.equal(await balance(carol!), carolBefore + USDC(10n));
    log("credit minted");

    // --- 10. A holder redeems: sends to the issuer, who burns and pays out USDC ---
    const payout = privateKeyToAccount(generatePrivateKey()).address;
    await alice!.sync();
    await alice!.sendAsset({
      assetId, outputs: [{ to: actor("Issuer").address, amount: USDC(200n) }],
      data: { recipients: [{ to: actor("Issuer").address, records: [memoSchema.encode(redemptionMemo(payout))] }] },
    });
    // The issuer burns, waits for the burn to be final, pays, and reports the redemption once the payout is final.
    const paid = await eventually("redemption burned and paid", async () => {
      await issuer.processRedemptions();
      return (await issuerStore.load()).redemptions;
    }, (redemptions) => redemptions.length === 1 && redemptions[0]!.paid, { timeoutMs: 180_000 });
    assert.equal(paid[0]!.payout.toLowerCase(), payout.toLowerCase());
    assert.equal(await publicClient.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [payout] }), USDC(200n));
    assert.equal(await balance(issuerWallet!), 0n, "the issuer burned what it redeemed");
    assert.deepEqual(await issuer.processRedemptions(), [], "a redemption pays out once");
    log("redemption paid");

    // --- 11. pUSD on the Marketplace: listed, bought, frozen in escrow, and reclaimed ---
    const router = await setupPaymentRouter({
      rpcUrl, l1ChainId: fixture.network.l1ChainId, cacheRoot: fixture.artifacts.path("stablecoin-market"),
      routerConfig: LOCAL_PAYMENT_ROUTER_CONFIG, privateKey: actor("Alice").privateKey,
    });
    const market = (wallet: Wallet, scenarioActor: ScenarioActor) => marketplaceController({
      node, wallet, l1RpcUrl: rpcUrl, l1PrivateKey: scenarioActor.privateKey, router: router.address,
    });
    const aliceMarket = market(alice!, actor("Alice"));
    const carolMarket = market(carol!, actor("Carol"));
    const openFee = fixture.config.assets.actionFee;
    const list = async (amount: bigint, purchaseMinutes: bigint): Promise<OfferPublication> => {
      await alice!.sync();
      const published = await aliceMarket.createAndPublish({
        assetId, assetDefinition: encodeAssetDefinition(definition), amount, ethPriceWei: ETH_PRICE_WEI, purchaseMinutes, fundingOpenFeeAmount: openFee,
      }, { relay: async (contentHash) => { await fixture.harness.relayExact([contentHash]); } });
      assert.ok(published.catalogPublished, `the ${amount} pUSD listing was published`);
      return published.publication;
    };
    const catalogEntry = async (publication: OfferPublication) => {
      const listed = (await carolMarket.refresh()).catalogOffers.find((candidate) => offerKey(candidate) === offerKey(publication));
      assert.ok(listed !== undefined, "the catalog lists the pUSD offer");
      const verification = await carolMarket.verify(listed);
      assert.ok(verification.safeToPay, `the pUSD listing verifies: ${verification.checks.join("; ")}`);
      return listed;
    };
    const sold = await list(USDC(100n), 60n);
    const carolBeforeBuy = await balance(carol!);
    const bought = await carolMarket.buy(await catalogEntry(sold));
    const claim = await awaitAcceptedReceipt(node, bought.claimContentHash);
    assert.equal(claim.inclusion.l1TransactionHash.toLowerCase(), bought.paymentHash.toLowerCase(), "the claim rides Carol's payment");
    assert.equal(await balance(carol!), carolBeforeBuy + USDC(100n));
    log("pUSD listing bought");

    const unsold = await list(USDC(50n), 10n);
    const unsoldEntry = await catalogEntry(unsold);
    const escrow = publicationContractAddress(unsold) as Address;
    await admin.freeze([escrow]);
    await settle();
    const carolEth = await publicClient.getBalance({ address: actor("Carol").address as Address });
    await refused(carolMarket.buy(unsoldEntry), /frozen/, "a frozen escrow cannot be bought from");
    assert.equal(await publicClient.getBalance({ address: actor("Carol").address as Address }), carolEth, "the refused buy paid nothing");
    await advanceTo(fixture, reclaimNotBefore(BigInt(unsold.terms.deadlineT)));
    // Alice's wallet sponsors the reclaim's fee and is not listed; the rule names the escrow.
    fixture.harness.startAutoRelay();
    try {
      await refused(aliceMarket.reclaim(unsold, openFee), /frozen/, "a frozen escrow cannot be reclaimed through an unlisted sponsor");
      await admin.unfreeze([escrow]);
      await settle();
      const aliceBefore = await balance(alice!);
      await aliceMarket.reclaim(unsold, openFee);
      assert.equal(await balance(alice!), aliceBefore + USDC(50n));
    } finally {
      await fixture.harness.stopAutoRelay();
    }
    log("frozen escrow held, then reclaimed");

    // --- 12. A reorganization that drops a deposit drops its mint ---
    // Nothing else may write to Ethereum while mining is paused.
    await heartbeat.stop();
    heartbeat = undefined;
    const reorgAmount = USDC(25n);
    await fund(aliceBankKey, reorgAmount);
    const aliceBeforeReorg = await balance(alice!);
    const restoredAlice = await restore(actor("Alice"));
    const poster = derivePcashProfileFromPrivateKey(fromHex(fixture.harness.privateKey), fixture.network);
    try {
      await withAnvilMiningPaused(rpcUrl, async () => {
        await settle();
        const parent = await publicClient.getBlock();
        const snapshot = await backend.snapshot!();
        const orphanedDeposit = await sendDeposit(aliceBankKey, alice!.createDepositCode({ asset: definition }), reorgAmount);
        await backend.mine!(1);
        await confirm(orphanedDeposit);
        const found = await depositOf(restoredAlice, orphanedDeposit);
        // Built against the deposit's block, then posted by hand in the next one.
        const prepared = await restoredAlice.mintDeposit({ asset: definition, deposit: found, submission: deferSubmission(fixture.harness.mempool()) });
        const entry = fromHex(prepared.transactionHex);
        const { contentHash } = transactionIdentity(entry);
        const opening = posterPayoutOpening(poster.address, poster.nkRoot, randomFieldEntropy());
        const sent = await fixture.harness.submitter.sendCall({ to: inbox.address, data: toHex(encodeBatch([entry], opening.ownerCommitment, opening.context)) });
        await backend.mine!(1);
        const carrier = await sent.settle();
        await fixture.waitForAcceptedAcrossNodes(contentHash, "stablecoin-reorg-mint");
        await eventually("Alice's wallet to sync the mint", () => balance(alice!), (value) => value === aliceBeforeReorg + reorgAmount, { timeoutMs: 60_000 });

        await backend.revert!(snapshot);
        for (const hash of [orphanedDeposit, carrier.txHash]) await l1Rpc(rpcUrl, "anvil_dropTransaction", [hash]);
        await backend.setNextTimestamp!(parent.timestamp + 2n);
        await backend.mine!(3);
        const replacement = await publicClient.getBlock();
        await eventually("the node to derive the replacement blocks", () => node.status(),
          (status) => status.latestL1BlockHash.toLowerCase() === replacement.hash.toLowerCase(), { timeoutMs: 120_000 });
        assert.deepEqual(await node.getReceipt({ contentHash }), [], "the mint of a dropped deposit is not canonical");
        await eventually("Alice's wallet to drop the orphaned mint", () => balance(alice!), (value) => value === aliceBeforeReorg, { timeoutMs: 60_000 });
        assert.ok(!(await alice!.listDeposits({ asset: definition })).some((deposit) => deposit.transactionHash.toLowerCase() === orphanedDeposit.toLowerCase()),
          "a dropped deposit is not listed");
        assert.equal((await node.checkRawTransaction(entry, inbox)).outcome, "recentPcashBlockNotInWindow", "the orphaned mint's anchor is gone");
      });
    } finally {
      await restoredAlice.close();
    }
    log("a reorganization dropped the deposit and its mint");

    fixture.artifacts.record("stablecoin-complete", {
      assetId: `0x${assetId.toString(16)}`, denyListContract, vault, usdc, router: router.address,
      mintMs: Math.round(mintMs), restrictedSendMs: Math.round(restrictedSendMs),
    });
  } finally {
    await heartbeat?.stop();
    await Promise.allSettled(wallets.map((wallet) => wallet.close()));
  }
}

async function chainNow(fixture: ScenarioFixture): Promise<bigint> {
  return BigInt((await l1Rpc<{ timestamp: string }>(fixture.backend.rpcUrl, "eth_getBlockByNumber", ["latest", false])).timestamp);
}

/** Cross a deadline without deriving every block in between. */
async function advanceTo(fixture: ScenarioFixture, target: bigint): Promise<void> {
  if (!fixture.backend.mine || !fixture.backend.setNextTimestamp) throw new Error("the backend cannot advance its clock");
  if (target > await chainNow(fixture)) {
    await fixture.backend.setNextTimestamp(target);
    await fixture.backend.mine();
  }
  await fixture.waitForNodesAtL1Head();
}
