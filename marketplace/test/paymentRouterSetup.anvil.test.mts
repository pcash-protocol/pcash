import { createServer } from "node:http";
import { buildUnfundedContractCreation } from "@pcash/sdk/builders";
import { decodeContractBody, receiveKeyHash } from "@pcash/sdk/protocol";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { bytesToHex, createPublicClient, encodeFunctionData, getAddress, hexToBytes, http, keccak256, parseAbi, parseAbiItem, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addressHex, DEFAULT_NETWORK_CONFIG, fieldToHex, generateMlKemKeyPair, type PcashNodeClient } from "@pcash/sdk/browser";
import { CARRIER_KIND_EVENT, carrierContextHash, decodeBatch } from "@pcash/sdk/protocol";
import { derivePcashProfileFromPrivateKey, type PcashProfile } from "@pcash/sdk/wallet";
import {
  MIN_CLAIM_WINDOW_SECONDS,
  CLAIM_APPLICATION_VK_HASH,
  RECLAIM_APPLICATION_VK_HASH,
  paymentCarrierContext,
  paymentCarrierContextHash,
} from "../src/commitments.mts";
import { BUY_COMMITMENT, escrowSpenderResult } from "./anchoredTransaction.ts";
import { createOffer } from "../src/offer.mts";
import { buildBuyCall, buildRetryCall, purchaseCommitment, recoverPayResult, sendRouterCall, type RouterCall } from "../src/client/buy.ts";
import { claimBatch, claimNotAfter } from "../src/client/claimFlow.ts";
import { purchaseCutoff } from "../src/client/offerAvailability.ts";
import type { MarketplaceStore, StoredOffer } from "../src/client/offerPersistence.ts";
import { marketplaceBuyerState } from "../src/client/presentation.ts";
import { offerKey, publicationFromOffer, publicationIdentity, publicationTerms } from "../src/client/publication.ts";
import { MarketplaceController, resolveCheckpointedPayment } from "../src/client/session.ts";
import { privateKeyL1Signer } from "../src/client/l1Signer.ts";
import { assertPaymentRouterDeployment, quotePaymentRouterFee } from "../src/client/paymentRouter.ts";
import {
  LOCAL_PAYMENT_ROUTER_CONFIG,
  LOCAL_PAYMENT_ROUTER_KEY,
  localPaymentRouterCacheRoot,
  setupPaymentRouter,
} from "../src/tooling/paymentRouterSetup.mts";

test("local router state resolves relative development roots against the checkout", () => {
  assert.equal(localPaymentRouterCacheRoot("/checkout"), "/checkout/.cache/pcash/dev/anvil/marketplace");
  assert.equal(localPaymentRouterCacheRoot("/checkout", "custom-dev"), "/checkout/custom-dev/marketplace");
  assert.equal(localPaymentRouterCacheRoot("/checkout", "/custom-dev"), "/custom-dev/marketplace");
});

/** Starts Anvil, or returns undefined after skipping the test. */
async function startAnvil(t: TestContext): Promise<string | undefined> {
  try {
    execFileSync("anvil", ["--version"], { stdio: "ignore" });
    execFileSync("forge", ["--version"], { stdio: "ignore" });
  } catch (error) {
    if (process.env.PCASH_REQUIRE_L1_ARTIFACTS === "1") throw error;
    t.skip("Anvil and Forge are required");
    return undefined;
  }
  const anvil = spawn("anvil", ["--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (anvil.exitCode === null && anvil.signalCode === null) {
      const exited = once(anvil, "exit");
      anvil.kill("SIGTERM");
      await exited;
    }
  });
  const rpcUrl = await new Promise<string>((resolve, reject) => {
    let output = "";
    anvil.once("error", reject);
    anvil.once("exit", (code) => reject(new Error(`Anvil exited before readiness: ${code}`)));
    anvil.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/Listening on (127\.0\.0\.1:\d+)/);
      if (match) resolve(`http://${match[1]}`);
    });
  });
  return rpcUrl;
}

test("router setup deploys, shares with seed, reuses, and recovers after Anvil reset", { timeout: 120_000 }, async (t) => {
  const rpcUrl = await startAnvil(t);
  if (rpcUrl === undefined) return;
  const directory = await mkdtemp(join(tmpdir(), "pcash-router-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = createPublicClient({ transport: http(rpcUrl) });
  const account = privateKeyToAccount(LOCAL_PAYMENT_ROUTER_KEY);
  const options = {
    rpcUrl,
    l1ChainId: 31337n,
    cacheRoot: localPaymentRouterCacheRoot("/checkout", directory),
    routerConfig: LOCAL_PAYMENT_ROUTER_CONFIG,
    privateKey: LOCAL_PAYMENT_ROUTER_KEY,
  };
  const deployed = await setupPaymentRouter(options);
  assert.equal(deployed.source, "deployed");
  assert.equal(deployed.routerConfig.feeRecipient, getAddress(LOCAL_PAYMENT_ROUTER_CONFIG.feeRecipient));
  assert.equal(deployed.routerConfig.feeBps, 500);
  const routerAbi = parseAbi(["function guardian() view returns (address)"]);
  assert.equal(await client.readContract({ address: deployed.address, abi: routerAbi, functionName: "guardian" }), account.address);
  assert.equal(await client.getTransactionCount({ address: account.address }), 1);

  // A separate seed caller can use its own signing account without deploying again.
  const reused = await setupPaymentRouter({ ...options, privateKey: `0x${"11".repeat(32)}` });
  assert.equal(reused.source, "cache");
  assert.equal(reused.address, deployed.address);
  assert.equal(await client.getTransactionCount({ address: account.address }), 1);
  const explicit = await setupPaymentRouter({ ...options, explicitAddress: deployed.address, privateKey: undefined });
  assert.equal(explicit.source, "explicit");
  await assert.rejects(setupPaymentRouter({ ...options, explicitAddress: account.address }), /PaymentRouter/);
  assert.equal(await client.getTransactionCount({ address: account.address }), 1);

  const changed = await setupPaymentRouter({ ...options, routerConfig: { ...LOCAL_PAYMENT_ROUTER_CONFIG, feeBps: 250 } });
  assert.equal(changed.source, "deployed");
  assert.notEqual(changed.address, deployed.address);

  const response = await fetch(rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_reset", params: [] }),
  });
  assert.equal((await response.json() as { error?: unknown }).error, undefined);
  const reset = await setupPaymentRouter(options);
  assert.equal(reset.source, "deployed");
  assert.equal(await client.getTransactionCount({ address: account.address }), 1);

  await assert.rejects(setupPaymentRouter({
    ...options, cacheRoot: join(directory, "isolated"), privateKey: undefined,
  }), /configure PCASH_PAYMENT_ROUTER_ADDRESS/);
});

test("a pause before or during a payment attempt leaves a retryable purchase", { timeout: 120_000 }, async (t) => {
  const rpcUrl = await startAnvil(t);
  if (rpcUrl === undefined) return;
  const directory = await mkdtemp(join(tmpdir(), "pcash-router-pause-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const l1ChainId = 31337n;
  const pcashChainId = 1_346_589_512;
  const router = await setupPaymentRouter({
    rpcUrl,
    l1ChainId,
    cacheRoot: localPaymentRouterCacheRoot("/checkout", directory),
    routerConfig: LOCAL_PAYMENT_ROUTER_CONFIG,
    privateKey: LOCAL_PAYMENT_ROUTER_KEY,
  });
  const client = createPublicClient({ transport: http(rpcUrl) });
  const routerAbi = parseAbi([
    "function pause()",
    "function unpause()",
    "function buy(bytes32 offerId, address seller, bytes32 claimKeyCommitment, uint256 anchorBlockNumber, bytes32 anchorBlockHash, uint64 notAfter, bytes recoveryData, bytes batch) payable",
    "function retry(bytes32 offerId, address seller, uint256 amount, bytes batch)",
  ]);
  const guardian = privateKeyL1Signer(LOCAL_PAYMENT_ROUTER_KEY, rpcUrl);
  const guardianCall = async (functionName: "pause" | "unpause") => {
    const hash = await guardian.sendTransaction({
      chainId: l1ChainId,
      to: router.address,
      data: encodeFunctionData({ abi: routerAbi, functionName }),
    });
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
  };

  // Anvil account 1.
  const buyer = privateKeyL1Signer("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", rpcUrl);
  const seller = "0x00000000000000000000000000000000005e11e7";
  const genesis = await client.getBlock({ blockNumber: 0n });
  const node = {
    status: async () => ({ pcashChainId, l1ChainId, genesisL1Block: 0n, genesisL1BlockHash: genesis.hash, latestL1BlockNumber: await client.getBlockNumber({ cacheTime: 0 }) }),
    getAccountProof: async () => ({ status: "absent" }),
  } as unknown as PcashNodeClient;
  // The anchor precedes the guardian's transactions, so the payment sees it as historical.
  const latest = await client.getBlock({ blockTag: "latest" });
  const anchor = { blockNumber: latest.number, blockHash: latest.hash };
  const commitment = `0x${"c0".repeat(32)}` as Hex;
  const value = 10n ** 15n;
  const offerId = `0x${"01".padStart(64, "0")}` as Hex;
  const call: RouterCall = {
    functionName: "buy",
    to: router.address,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: "buy",
      args: [offerId, seller, commitment, anchor.blockNumber, anchor.blockHash, latest.timestamp + 3_600n, "0x", "0x01"],
    }),
    value,
    anchor,
  };
  let events: string[] = [];
  let pauseAtCheckpoint = false;
  const callbacks = {
    onBroadcastRequested: async () => {
      events.push("broadcast-requested");
      if (pauseAtCheckpoint) await guardianCall("pause");
    },
    onSent: () => { events.push("sent"); },
  };

  // Already paused: the preflight estimate rejects before the broadcast checkpoint.
  await guardianCall("pause");
  await assert.rejects(sendRouterCall(node, [rpcUrl], buyer, call, callbacks), /Error: EnforcedPause\(\)/);
  assert.deepEqual(events, []);
  assert.equal(await client.getTransactionCount({ address: buyer.address }), 0);
  await guardianCall("unpause");

  // Paused after the preflight: the prepared transaction is still sent and reverts,
  // a definite outcome with a checkpointed hash.
  pauseAtCheckpoint = true;
  await assert.rejects(
    sendRouterCall(node, [rpcUrl], buyer, call, callbacks),
    (error: Error) => error.name === "PaymentTransactionRevertedError",
  );
  assert.deepEqual(events, ["broadcast-requested", "sent"]);
  assert.equal(await client.getTransactionCount({ address: buyer.address }), 1);
  pauseAtCheckpoint = false;
  await guardianCall("unpause");

  events = [];
  const paid = await sendRouterCall(node, [rpcUrl], buyer, call, callbacks);
  assert.deepEqual(events, ["broadcast-requested", "sent"]);
  assert.equal((await client.getTransactionReceipt({ hash: paid.hash })).status, "success");
  assert.equal(await client.getBalance({ address: seller }), quotePaymentRouterFee(value, router.routerConfig).sellerNetWei);

  // A pause stops new purchases only: retry carries a fresh batch for the recorded payment.
  await guardianCall("pause");
  const retried = await sendRouterCall(node, [rpcUrl], buyer, {
    functionName: "retry",
    to: router.address,
    data: encodeFunctionData({ abi: routerAbi, functionName: "retry", args: [offerId, seller, value, "0x02"] }),
    value: 0n,
  });
  assert.equal((await client.getTransactionReceipt({ hash: retried.hash })).status, "success");
});

/**
 * A PCASH node stand-in that derives the router's real `PcashBatch` logs: PCASH block N is Ethereum block N, indexed
 * at once, and the escrow nullifier is spent by the first carried claim that `succeeds`.
 */
const PCASH_BATCH_EVENT = parseAbiItem("event PcashBatch(bytes context, bytes batch)");
function derivedRouterEvents(client: ReturnType<typeof createPublicClient>, router: Hex, succeeds: (contentHash: Hex) => boolean) {
  const carriers = async (logs: Awaited<ReturnType<typeof client.getLogs<typeof PCASH_BATCH_EVENT>>>) => logs.map((log) => ({
    log, context: log.args.context!, items: decodeBatch(hexToBytes(log.args.batch!)).items.map((item) => keccak256(item)),
  }));
  return {
    status: async () => {
      const head = await client.getBlockNumber({ cacheTime: 0 });
      return { latestBlock: head, latestBlockHash: `0x${head.toString(16)}`, index: { status: "ready", cursor: { blockNumber: head, blockHash: "0x00" } } };
    },
    getBlock: async (number: bigint) => ({ number, hash: `0x${number.toString(16)}` }),
    carriersIn: async (hash: Hex) => {
      const receipt = await client.getTransactionReceipt({ hash });
      return carriers(await client.getLogs({ address: router, event: PCASH_BATCH_EVENT, blockHash: receipt.blockHash }));
    },
    getTransactionByNullifier: async () => {
      for (const { log, items } of await carriers(await client.getLogs({ address: router, event: PCASH_BATCH_EVENT, fromBlock: 0n }))) {
        const contentHash = items.find(succeeds);
        if (contentHash === undefined) continue;
        const block = await client.getBlock({ blockNumber: log.blockNumber });
        // A claim this carrier executed required the carrier's own context.
        return escrowSpenderResult(contentHash, log.blockNumber, carrierContextHash(CARRIER_KIND_EVENT, router, hexToBytes(log.args.context!)), block.timestamp);
      }
      return null;
    },
  };
}

test("after buying closes, a buyer recovers an existing payment but cannot make a new one", { timeout: 120_000 }, async (t) => {
  const rpcUrl = await startAnvil(t);
  if (rpcUrl === undefined) return;
  const directory = await mkdtemp(join(tmpdir(), "pcash-router-closed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const l1ChainId = 31337n;
  const pcashChainId = 1_346_589_512;
  const router = await setupPaymentRouter({
    rpcUrl,
    l1ChainId,
    cacheRoot: localPaymentRouterCacheRoot("/checkout", directory),
    routerConfig: LOCAL_PAYMENT_ROUTER_CONFIG,
    privateKey: LOCAL_PAYMENT_ROUTER_KEY,
  });
  const client = createPublicClient({ transport: http(rpcUrl) });
  const genesis = await client.getBlock({ blockNumber: 0n });
  const node = {
    status: async () => ({ pcashChainId, l1ChainId, genesisL1Block: 0n, genesisL1BlockHash: genesis.hash, latestL1BlockNumber: await client.getBlockNumber({ cacheTime: 0 }) }),
    getAccountProof: async () => ({ status: "absent" }),
  } as unknown as PcashNodeClient;
  const network = { ...DEFAULT_NETWORK_CONFIG, pcashChainId: BigInt(pcashChainId), l1ChainId };
  // Anvil account 1.
  const buyer = privateKeyL1Signer("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", rpcUrl);
  const profile = derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(9), network);
  const latest = await client.getBlock({ blockTag: "latest" });
  const offer = createOffer({
    network,
    terms: {
      router: BigInt(router.address),
      seller: 0x5e11e7n,
      assetId: 0n,
      amount: 100n,
      ethPriceWei: 10n ** 15n,
      deadlineT: latest.timestamp + MIN_CLAIM_WINDOW_SECONDS + 3_600n,
    },
    sellerWallet: derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(7), network),
    l2ContractNkRoot: 0x51n,
    claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
    reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
  });
  const publication = { ...publicationFromOffer(offer), escrow: { leafIndex: 0, noteSecret: fieldToHex(0x123n), amount: fieldToHex(100n) } };
  const buyerAddress = `0x${profile.address.toString(16).padStart(40, "0")}`;
  // This browser holds only an unsent selection, as after restoring the wallet elsewhere.
  let stored: StoredOffer = {
    key: offerKey(publication),
    pub: publication,
    source: "catalog",
    savedAt: 1,
    buys: { [buyerAddress]: { buyerAddress, publication, commitment: purchaseCommitment(publication, profile) } },
  };
  const store: MarketplaceStore = {
    list: async () => [structuredClone(stored)],
    get: async (key) => key === stored.key ? structuredClone(stored) : null,
    put: async (next) => { stored = structuredClone(next); },
    remove: async () => { throw new Error("unused"); },
    clear: async () => { throw new Error("unused"); },
    update: async (_key, operation) => {
      const next = operation(structuredClone(stored));
      if (next === null) throw new Error("unused");
      stored = structuredClone(next);
      return structuredClone(next);
    },
  };
  const receiveKey = generateMlKemKeyPair(new Uint8Array(64).fill(26));
  const receiveHash = fieldToHex(receiveKeyHash(receiveKey.publicKey));
  const identity = {
    wallet: {
      address: buyerAddress,
      network: { chainId: BigInt(pcashChainId), genesisHash: `0x${"00".repeat(32)}` },
      execute: async (operation: (context: unknown) => unknown) => operation({
        node, profile, signer: { address: profile.address }, network, status: await node.status(), spendable: () => true,
        store: {
          load: async () => ({ sentOutputs: [], receiveKeys: [{ receiveKeyHash: receiveHash,
            mlKemPublicKey: bytesToHex(receiveKey.publicKey), mlKemSecretKey: bytesToHex(receiveKey.secretKey) }] }),
          readChain: async (read: (chain: unknown) => unknown) => read({ accountResult: () => ({ receiveKeyHash: receiveHash,
            material: { status: "available", mlKem768PublicKey: bytesToHex(receiveKey.publicKey) } }) }),
        },
      }),
    },
    l1Signer: buyer,
  } as never;
  const controller = new MarketplaceController({
    node,
    store,
    l1RpcUrls: [rpcUrl],
    configuredRouter: { address: router.address },
    identity,
    now: () => Number(purchaseCutoff(offer.terms.deadlineT)) * 1_000,
  });

  await assert.rejects(controller.buy(publication), /Buying has closed for this listing/);
  assert.equal(await client.getTransactionCount({ address: buyer.address }), 0);

  const anchorBlock = await client.getBlock({ blockTag: "latest" });
  // The router reads the anchor through BLOCKHASH, so it must precede the payment's block.
  await client.request({ method: "evm_mine" } as never);
  const call = buildBuyCall(publication, profile, {
    anchor: { blockNumber: anchorBlock.number, blockHash: anchorBlock.hash },
    notAfter: anchorBlock.timestamp + 3_600n,
    batch: "0x01",
  });
  const paid = await sendRouterCall(node, [rpcUrl], buyer, call, {});
  // The claim then needs a PCASH node this stub lacks; the payment is recovered first.
  await assert.rejects(controller.buy(publication), (error: Error) => !/Buying has closed/.test(error.message));
  assert.equal(stored.buys?.[buyerAddress]?.txHash, paid.hash);
  assert.equal(stored.buys?.[buyerAddress]?.blockNumber, paid.blockNumber.toString());
  assert.equal(await client.getTransactionCount({ address: buyer.address }), 1);

  const verified = await assertPaymentRouterDeployment(client, router.address);
  assert.equal(verified.deploymentBlock.toString(), router.deployment!.deploymentBlock);
  // Fallback discovery starts at the contract's deployment block. Known hashes need no scans.
  let rejectLogScans = false;
  const logRanges: { fromBlock: Hex; toBlock: Hex }[] = [];
  let logRequests = 0;
  const receiptOnly = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    if (rpc.method === "eth_getLogs") logRanges.push(rpc.params[0]);
    if (rpc.method === "eth_getLogs" && rejectLogScans) {
      logRequests++;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "getLogs forbidden" } }));
    } else {
      const upstream = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
      response.setHeader("content-type", "application/json"); response.end(await upstream.text());
    }
  });
  await new Promise<void>(resolve => receiptOnly.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => receiptOnly.close(error => error ? reject(error) : resolve())));
  const address = receiptOnly.address();
  if (address === null || typeof address === "string") throw new Error("missing proxy address");
  const fallback = await recoverPayResult(node, [`http://127.0.0.1:${address.port}`], profile, publication, { payer: buyer.address });
  assert.equal(fallback?.hash, paid.hash);
  assert.equal(BigInt(logRanges[0]!.fromBlock), verified.deploymentBlock);
  rejectLogScans = true;
  const recovered = await recoverPayResult(node, [`http://127.0.0.1:${address.port}`], profile, publication, {
    payer: buyer.address, hash: paid.hash,
  });
  assert.equal(recovered?.hash, paid.hash);
  const replaced = await resolveCheckpointedPayment({
    buy: { buyerAddress, publication, commitment: BUY_COMMITMENT, txHash: `0x${"ee".repeat(32)}` },
    awaitPending: async () => ({ hash: paid.hash, blockNumber: paid.blockNumber, blockHash: paid.blockHash, replacementReason: "replaced" }),
    recoverCanonical: (minimumObservedBlock, hash) => recoverPayResult(node, [`http://127.0.0.1:${address.port}`], profile, publication, {
      payer: buyer.address, minimumObservedBlock, hash,
    }),
    headPastAttempt: async () => undefined,
  });
  assert.equal(replaced.payment?.hash, paid.hash);
  assert.equal(logRequests, 0);

  // No marketplace records and no catalog: find the purchase from its payer and calldata.
  Object.assign(node, {
    status: async () => ({ pcashChainId, l1ChainId, inboxAddress: addressHex(network.inboxAddress), genesisL1Block: 0n, genesisL1BlockHash: genesis.hash }),
    getContract: async () => ({ status: "contract", transaction: bytesToHex(buildUnfundedContractCreation({
      pcashChainId: network.pcashChainId, contract: decodeContractBody(offer.l2ContractBody), recentPcashBlockHash: 1n, validUntilTimestamp: 1n,
    }).transactionBytes) }),
    getOutputPath: async () => ({}),
    getTransactionByNullifier: async () => null,
    catalogInfo: async () => { throw new Error("catalog unavailable"); },
  });
  const records = new Map<string, StoredOffer>();
  const emptyStore: MarketplaceStore = {
    list: async () => [...records.values()], get: async key => records.get(key) ?? null,
    put: async value => { records.set(value.key, value); }, remove: async key => { records.delete(key); }, clear: async () => { records.clear(); },
    update: async (key, operation) => { const value = operation(records.get(key) ?? null); if (value === null) records.delete(key); else records.set(key, value); return value; },
  };
  const restoredController = new MarketplaceController({ node, store: emptyStore, identity, l1RpcUrls: [rpcUrl],
    configuredRouter: { address: router.address } });
  const refreshed = await restoredController.refresh();
  assert.deepEqual(refreshed.recoveryErrors, []);
  assert.match(refreshed.catalogError!, /catalog unavailable/);
  assert.equal(refreshed.localOffers.length, 1);
  assert.equal(publicationIdentity(refreshed.localOffers[0]!.pub), publicationIdentity(publication));
  const quote = await restoredController.quotePurchases([publication]);
  assert.equal(quote.paymentWei, 0n);
  assert.equal(quote.estimatedGasWei, 0n);

  // Storage lost after the escrow was spent: this payment's claim reconciles as finished; another payment's claim leaves no purchase.
  const claim = `0x${"44".repeat(32)}`;
  const status = await node.status();
  const spentBy = (commitment: bigint) => Object.assign(node, {
    status: async () => ({ ...status, finalizedL1BlockNumber: 1_000_000n }),
    getTransactionByNullifier: async () => escrowSpenderResult(claim, 1n, paymentCarrierContextHash(publicationTerms(publication), commitment)),
  });
  spentBy(0xdddn);
  records.clear();
  const taken = await restoredController.refresh();
  assert.deepEqual(taken.recoveryErrors, []);
  assert.equal(taken.localOffers.length, 0);
  spentBy(BigInt(purchaseCommitment(publication, profile)));
  const claimed = await restoredController.refresh();
  assert.deepEqual(claimed.recoveryErrors, []);
  assert.equal(marketplaceBuyerState(claimed.localOffers[0]!, profile.address)?.phase, "claimed");
});

test("a restored wallet with no saved purchase finishes it with retry() while the router is paused, in the last 24 hours before T", { timeout: 120_000 }, async (t) => {
  const rpcUrl = await startAnvil(t);
  if (rpcUrl === undefined) return;
  const directory = await mkdtemp(join(tmpdir(), "pcash-router-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const l1ChainId = 31337n;
  const pcashChainId = 1_346_589_512;
  const router = await setupPaymentRouter({
    rpcUrl,
    l1ChainId,
    cacheRoot: localPaymentRouterCacheRoot("/checkout", directory),
    routerConfig: LOCAL_PAYMENT_ROUTER_CONFIG,
    privateKey: LOCAL_PAYMENT_ROUTER_KEY,
  });
  const client = createPublicClient({ transport: http(rpcUrl) });
  const genesis = await client.getBlock({ blockNumber: 0n });
  const network = { ...DEFAULT_NETWORK_CONFIG, pcashChainId: BigInt(pcashChainId), l1ChainId };
  // Anvil account 1.
  const buyer = privateKeyL1Signer("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", rpcUrl);
  const profile = derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(9), network);
  const latest = await client.getBlock({ blockTag: "latest" });
  const deadlineT = latest.timestamp + MIN_CLAIM_WINDOW_SECONDS + 3_600n;
  const offer = createOffer({
    network,
    terms: { router: BigInt(router.address), seller: 0x5e11e7n, assetId: 0n, amount: 100n, ethPriceWei: 10n ** 15n, deadlineT },
    sellerWallet: derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(7), network),
    l2ContractNkRoot: 0x51n,
    claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
    reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
  });
  const publication = { ...publicationFromOffer(offer), escrow: { leafIndex: 0, noteSecret: fieldToHex(0x123n), amount: fieldToHex(100n) } };

  // The first claim fails on PCASH; the payment it rode in is final.
  const failedClaim = bytesToHex(new Uint8Array(48).fill(0xee));
  const retriedClaim = bytesToHex(new Uint8Array(48).fill(0x77));
  await client.request({ method: "evm_mine" } as never);
  const paid = await sendRouterCall({
    status: async () => ({ pcashChainId, l1ChainId, genesisL1Block: 0n, genesisL1BlockHash: genesis.hash, latestL1BlockNumber: await client.getBlockNumber({ cacheTime: 0 }) }),
  } as unknown as PcashNodeClient, [rpcUrl], buyer, buildBuyCall(publication, profile, {
    anchor: { blockNumber: latest.number, blockHash: latest.hash },
    notAfter: claimNotAfter(latest.timestamp, deadlineT),
    batch: claimBatch({ acceptedBatchVersions: [1] }, profile, failedClaim),
  }));

  // The guardian pauses buying, and the clock enters the last 24 hours before T.
  const guardian = privateKeyL1Signer(LOCAL_PAYMENT_ROUTER_KEY, rpcUrl);
  const pause = await guardian.sendTransaction({ chainId: l1ChainId, to: router.address, data: encodeFunctionData({ abi: parseAbi(["function pause()"]), functionName: "pause" }) });
  assert.equal((await client.waitForTransactionReceipt({ hash: pause })).status, "success");
  await client.request({ method: "evm_increaseTime", params: [Number(deadlineT - (await client.getBlock({ blockTag: "latest" })).timestamp - 3_600n)] } as never);
  await client.request({ method: "evm_mine" } as never);

  const receiveKey = generateMlKemKeyPair(new Uint8Array(64).fill(26));
  const receiveHash = fieldToHex(receiveKeyHash(receiveKey.publicKey));
  const derived = derivedRouterEvents(client, router.address, (contentHash) => contentHash === keccak256(retriedClaim));
  const dryRuns: { carrier: unknown }[] = [];
  const node = {
    status: async () => ({
      pcashChainId, l1ChainId, inboxAddress: addressHex(network.inboxAddress), genesisL1Block: 0n, genesisL1BlockHash: genesis.hash,
      latestL1BlockNumber: await client.getBlockNumber({ cacheTime: 0 }), acceptedTransactionTypes: [0, 1, 2, 3], acceptedBatchVersions: [1],
      finalizedL1BlockNumber: 0n, ...await derived.status(),
    }),
    getBlock: derived.getBlock,
    getTransactionByNullifier: derived.getTransactionByNullifier,
    getContract: async () => ({ status: "contract", transaction: bytesToHex(buildUnfundedContractCreation({
      pcashChainId: network.pcashChainId, contract: decodeContractBody(offer.l2ContractBody), recentPcashBlockHash: 1n, validUntilTimestamp: 1n,
    }).transactionBytes) }),
    getOutputPath: async () => ({}),
    catalogInfo: async () => { throw new Error("catalog unavailable"); },
    // The head snapshot the retry is proved against: the current Ethereum block, as the node derived it.
    getWitnessSnapshot: async () => {
      const head = await client.getBlock({ blockTag: "latest" });
      // Ethereum moves on, so the snapshot's block becomes one the router can read with BLOCKHASH.
      await client.request({ method: "evm_mine" } as never);
      return {
        block: { number: 1n, hash: "0x01", l1Origin: { blockNumber: head.number, blockHash: head.hash } },
        contracts: [{ status: "contract", accountProof: { accountStateRoot: 1n, boundary: { header: { timestamp: head.timestamp } } } }],
        outputs: { paths: [{ outputIndex: 0n, siblings: [] }] },
        nullifiers: { statuses: [{ nullifier: "0x01", spent: false }] },
      };
    },
    checkRawTransaction: async (_transaction: Uint8Array, carrier: unknown) => { dryRuns.push({ carrier }); return { outcome: "succeeded" }; },
  } as unknown as PcashNodeClient;
  const records = new Map<string, StoredOffer>();
  const store: MarketplaceStore = {
    list: async () => [...records.values()], get: async key => records.get(key) ?? null,
    put: async value => { records.set(value.key, value); }, remove: async key => { records.delete(key); }, clear: async () => { records.clear(); },
    update: async (key, operation) => { const value = operation(records.get(key) ?? null); if (value === null) records.delete(key); else records.set(key, value); return value; },
  };
  const buyerAddress = `0x${profile.address.toString(16).padStart(40, "0")}`;
  const identity = {
    wallet: {
      address: buyerAddress,
      network: { chainId: BigInt(pcashChainId), genesisHash: `0x${"00".repeat(32)}` },
      execute: async (operation: (context: unknown) => unknown) => operation({
        node, profile, signer: { address: profile.address }, network, status: await node.status(), spendable: () => true,
        store: {
          load: async () => ({ sentOutputs: [], receiveKeys: [{ receiveKeyHash: receiveHash,
            mlKemPublicKey: bytesToHex(receiveKey.publicKey), mlKemSecretKey: bytesToHex(receiveKey.secretKey) }] }),
          readChain: async (read: (chain: unknown) => unknown) => read({ accountResult: () => ({ receiveKeyHash: receiveHash,
            material: { status: "available", mlKem768PublicKey: bytesToHex(receiveKey.publicKey) } }) }),
        },
      }),
    },
    l1Signer: buyer,
  } as never;
  const controller = new MarketplaceController({ node, store, identity, l1RpcUrls: [rpcUrl], configuredRouter: { address: router.address },
    now: () => Number(deadlineT - 3_600n) * 1_000 });
  t.mock.method(controller as unknown as { proveClaim: () => Promise<unknown> }, "proveClaim", async () => ({ contentHash: keccak256(retriedClaim), transactionHex: retriedClaim }));

  // No marketplace records and no catalog: refresh finds the purchase from its payer and calldata.
  const refreshed = await controller.refresh();
  assert.deepEqual(refreshed.recoveryErrors, []);
  assert.equal(marketplaceBuyerState(refreshed.localOffers[0]!, profile.address)?.phase, "paid");
  const result = await controller.buy(refreshed.localOffers[0]!.buys![buyerAddress]!.publication);

  assert.equal(result.paymentHash, paid.hash);
  assert.equal(result.claimContentHash, keccak256(retriedClaim));
  const commitment = purchaseCommitment(publication, profile);
  const context = paymentCarrierContext(publicationTerms(publication), BigInt(commitment));
  assert.deepEqual(dryRuns.map(({ carrier }) => carrier), [{ kind: "event", address: addressHex(BigInt(router.address)), context: hexToBytes(context) }]);
  // Exactly one Ethereum transaction after the pause besides it: the buyer's retry, carrying the fresh claim in the router's context.
  const retry = (await client.getBlock({ blockTag: "latest", includeTransactions: true })).transactions.at(-1)!;
  assert.equal(retry.from.toLowerCase(), buyer.address.toLowerCase());
  const retryReceipt = await client.getTransactionReceipt({ hash: retry.hash });
  assert.equal(retryReceipt.status, "success");
  assert.ok((await client.getBlock({ blockNumber: retryReceipt.blockNumber })).timestamp > deadlineT - MIN_CLAIM_WINDOW_SECONDS);
  assert.equal(await client.readContract({ address: router.address, abi: parseAbi(["function paused() view returns (bool)"]), functionName: "paused" }), true);
  const [carried] = await derived.carriersIn(retry.hash);
  assert.equal(carried!.context, context);
  assert.deepEqual(carried!.items, [keccak256(retriedClaim)]);
  assert.equal(marketplaceBuyerState((await store.get(offerKey(publication)))!, profile.address)?.phase, "claim-accepted");
});
