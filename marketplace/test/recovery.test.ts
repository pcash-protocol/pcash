import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex, type Hex } from "viem";
import { addressHex, DEFAULT_NETWORK_CONFIG, fieldToHex, fullOutputCommitment, type PcashNodeClient, type StatusResult } from "@pcash/sdk/browser";
import { assetDefinitionAssetId, encodeAssetDefinition, planArena, encodeRecords, sentEnvelopesSchema, sentOpeningsSchema, assetDefinitionSchema, type DataRecord } from "@pcash/sdk/protocol";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { derivePcashProfileFromPrivateKey, type WalletExecutionContext } from "@pcash/sdk/wallet";
import { createOffer, deriveOfferSecrets } from "../src/offer.mts";
import { CLAIM_APPLICATION_VK_HASH, RECLAIM_APPLICATION_VK_HASH, paymentCarrierContextHash, toBytes32 } from "../src/commitments.mts";
import { offerKey, publicationFromOffer, publicationIdentity, publicationTerms, type OfferPublication } from "../src/client/publication.ts";
import { recoverSellerOffers, sellerRecord } from "../src/client/sellerRecovery.ts";
import { purchaseCommitment } from "../src/client/buy.ts";
import { encodePaymentRecovery, recoverPaymentPublication, savedPaymentIdentity, scanPayerPayments, scannedPaymentIdentity, type ScannedPayment } from "../src/client/paymentRecovery.ts";
import { testToken } from "./tokenFixtures.ts";
import { BUY_COMMITMENT, escrowSpenderResult, anchoredPrivateValueTransaction } from "./anchoredTransaction.ts";

const seller = derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(7), DEFAULT_NETWORK_CONFIG);
const buyer = derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(8), DEFAULT_NETWORK_CONFIG);
const router = addressHex(11n);
const blockHash = `0x${"11".repeat(32)}` as Hex;
const hash = `0x${"22".repeat(32)}` as Hex;
const status = { pcashChainId: Number(DEFAULT_NETWORK_CONFIG.pcashChainId), l1ChainId: DEFAULT_NETWORK_CONFIG.l1ChainId, inboxAddress: addressHex(DEFAULT_NETWORK_CONFIG.inboxAddress) } as unknown as StatusResult;

function listing(token = false) {
  const asset = testToken();
  const offer = createOffer({ network: DEFAULT_NETWORK_CONFIG, sellerWallet: seller, l2ContractNkRoot: 123n,
    terms: { router: BigInt(router), seller: seller.address, assetId: token ? asset.assetId : 0n, amount: 500n, ethPriceWei: 900n, deadlineT: 4_000_000_000n },
    claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH, reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH });
  const publication: OfferPublication = { ...publicationFromOffer(offer, token ? asset.bytes : undefined), escrow: { leafIndex: 7, noteSecret: fieldToHex(1234n), amount: fieldToHex(500n) } };
  const transaction = bytesToHex(anchoredPrivateValueTransaction(1n, 1n, 0n, 0n, 0n,
    { kind: "contract", body: offer.l2ContractBody }));
  // As the wallet stores the escrow output: its funding transaction's sender records repeat on each sent output.
  const record = sellerRecord(offer);
  const sent = { recipientAddress: addressHex(offer.l2ContractAddress), assetId: fieldToHex(offer.terms.assetId), amount: "500",
    noteSecret: fieldToHex(1234n), leafIndex: "7", slot: 0, transactionId: hash,
    ...(token ? { assetDefinition: bytesToHex(asset.bytes) } : {}),
    senderRecords: [{ schema: record.schema, data: bytesToHex(record.data) }],
    blockNumber: "1", blockHash, blockTimestamp: "1", senderIncluded: false };
  const contract = { status: "contract", transaction };
  return { offer, publication, sent, contract, asset };
}

test("seller secret derivation matches frozen vectors and separates wallet, chain, and contract", () => {
  const profile = { applicationSeed: new Uint8Array(32).fill(7), nkRoot: 8n };
  const expected = { id: 14099688841454148670676260423403428343704176257409885177971191171786969834670n,
    claimConfigurationSalt: 2409984773089700363641010499247867670977590341482395032670995093519474867946n,
    reclaimConfigurationSalt: 12451749450457260852414250219146004232913594711090280862026097913043751780051n };
  assert.deepEqual(deriveOfferSecrets(profile, 9n, 10n), expected);
  for (const secrets of [deriveOfferSecrets({ ...profile, applicationSeed: new Uint8Array(32).fill(6) }, 9n, 10n),
    deriveOfferSecrets({ ...profile, nkRoot: 7n }, 9n, 10n), deriveOfferSecrets(profile, 8n, 10n), deriveOfferSecrets(profile, 9n, 11n)]) {
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) assert.notEqual(secrets[key], expected[key]);
  }
});

for (const token of [false, true]) test(`seller restores the identical ${token ? "token" : "native"} publication from atomic funding`, async () => {
  const fixture = listing(token);
  let missing = true;
  let rows: typeof fixture.sent[] = [];
  const context = { store: { load: async () => ({ sentOutputs: rows }) }, node: {
    getContract: async () => missing ? { status: "notFound" } : fixture.contract,
  } } as unknown as WalletExecutionContext;
  assert.equal((await recoverSellerOffers(context, seller, DEFAULT_NETWORK_CONFIG)).offers.length, 0);
  rows = [fixture.sent]; // Funding arrives after the initial sync.
  for (const absent of [true, false, false]) {
    missing = absent;
    const recovered = await recoverSellerOffers(context, seller, DEFAULT_NETWORK_CONFIG);
    if (absent) {
      assert.equal(recovered.offers.length, 0);
      assert.match(recovered.errors[0]!, /funded contract is unavailable/);
      continue;
    }
    assert.deepEqual(recovered.errors, []);
    assert.equal(publicationIdentity(recovered.offers[0]!.publication), publicationIdentity(fixture.publication));
  }
  assert.equal((await recoverSellerOffers(context, buyer, DEFAULT_NETWORK_CONFIG)).offers.length, 0);
  rows = [{ ...fixture.sent, recipientAddress: addressHex(99n) }];
  const mismatched = await recoverSellerOffers(context, seller, DEFAULT_NETWORK_CONFIG);
  assert.equal(mismatched.offers.length, 0);
  assert.match(mismatched.errors[0]!, /funded contract/);
  // The transaction's record repeats on each output it sent; only the escrow output is the contract's.
  rows = [{ ...fixture.sent, recipientAddress: addressHex(99n), slot: 1 }, fixture.sent];
  const escrowAmong = await recoverSellerOffers(context, seller, DEFAULT_NETWORK_CONFIG);
  assert.deepEqual(escrowAmong.errors, []);
  assert.equal(escrowAmong.offers.length, 1);
  rows = [];
  assert.equal((await recoverSellerOffers(context, seller, DEFAULT_NETWORK_CONFIG)).offers.length, 0);
});

test("the seller record fits the seller's S sender region beside either escrow and the largest token definition", () => {
  const { offer, asset } = listing(true);
  const shape = PRIVATE_VALUE_PROFILES.S.shapeId;
  // nkRoot (32) ‖ price ‖ deadline ‖ router (20) ‖ seller (20), with uvarint integers:
  // 900 wei takes 2 bytes and a deadline of 4e9 (below 2^32) takes 5.
  const listed = sellerRecord(offer);
  assert.equal(listed.data.length, 32 + 2 + 5 + 20 + 20);
  // A uint128 price takes at most ⌈128 / 7⌉ = 19 bytes and a uint64 deadline ⌈64 / 7⌉ = 10.
  const largest = sellerRecord({ ...offer, terms: { ...offer.terms, ethPriceWei: (1n << 128n) - 1n, deadlineT: (1n << 64n) - 1n } });
  assert.equal(largest.data.length, 32 + 19 + 10 + 20 + 20);
  const definition = { ...asset.definition, metadata: { ...asset.definition.metadata, name: "N".repeat(64), symbol: "S".repeat(12) } };
  assert.equal(encodeAssetDefinition(definition).length, 161);
  // A native escrow is the contract's envelope; a token escrow is an opening sent out of band, with its definition.
  const native = (record: DataRecord) => [
    sentEnvelopesSchema.encode([{ slot: 0, sharedSecret: new Uint8Array(32), recipientAddress: offer.l2ContractAddress }]),
    record,
  ];
  const token = (record: DataRecord) => [
    sentOpeningsSchema.encode([{ slot: 0, recipientAddress: offer.l2ContractAddress, assetId: assetDefinitionAssetId(definition), amount: (1n << 128n) - 1n, noteSecret: 123n }]),
    assetDefinitionSchema.encode(definition),
    record,
  ];
  const senders = [native(listed), token(listed), native(largest), token(largest)];
  // Headers: a sent-entry record 2 bytes, the seller record 5 (four-byte ID and one-byte length), the definition 3.
  // The sent envelope is 55 bytes with its header, the opening 103 and the definition 164.
  assert.deepEqual(senders.map((sender) => encodeRecords(sender).length), [55 + 84, 103 + 164 + 84, 55 + 106, 103 + 164 + 106]);
  // Three cells carry 160 bytes, six 352 and seven 417. The native region needs a fourth only when price and deadline
  // together take more than 28 bytes: with the price at most 19, only a deadline of 2^63 or more. The token region
  // needs a seventh when they take more than 8.
  assert.deepEqual(senders.map((sender) => planArena({ shape, sender: encodeRecords(sender).length, regions: [] }).senderCells), [3, 6, 4, 7]);
});

function buyerRecoveryFixture(token: boolean) {
  const fixture = listing(token);
  const log: ScannedPayment = { transactionHash: hash, blockNumber: 11n, blockHash, args: {
    offerId: toBytes32(BigInt(fixture.publication.terms.id)), seller: addressHex(seller.address), amount: 900n,
    claimKeyCommitment: purchaseCommitment(fixture.publication, buyer), recoveryData: encodePaymentRecovery(fixture.publication),
  } };
  const expected = fullOutputCommitment({ owner: fixture.offer.l2ContractAddress, assetId: fixture.offer.terms.assetId, amount: 500n, noteSecret: 1234n }, 7n);
  const node = { getContract: async () => fixture.contract, getOutputPath: async (index: bigint, commitment: bigint) => {
    assert.equal(index, 7n); assert.equal(commitment, expected); return {};
  } } as unknown as PcashNodeClient;
  const input: Parameters<typeof recoverPaymentPublication>[0] = { node, profile: buyer, status, router, log,
    client: { getBlock: async () => ({ hash: blockHash, timestamp: 123n }) } as unknown as Parameters<typeof recoverPaymentPublication>[0]["client"] };
  return { ...fixture, input, log };
}

for (const token of [false, true]) test(`buyer restores ${token ? "token" : "native"} claim publication from its Payment event without a catalog`, async () => {
  const { publication, input } = buyerRecoveryFixture(token);
  const result = await recoverPaymentPublication(input);
  assert.equal(publicationIdentity(result.publication), publicationIdentity(publication));
  assert.deepEqual([result.hash, result.blockNumber, result.blockHash, result.paidAt], [hash, 11n, blockHash, 123_000]);
  await assert.rejects(recoverPaymentPublication({ ...input, profile: seller }), /claim key/);
});

test("payer fallback covers every block once with bounded pages and optional listing topics", async () => {
  const requests: Record<string, any>[] = [];
  const client = { getLogs: async (request: Record<string, any>) => { requests.push(request); return []; } } as unknown as Parameters<typeof scanPayerPayments>[0];
  for await (const _ of scanPayerPayments(client, { router, payer: addressHex(buyer.address), deploymentBlock: 123n, head: 2345n, offerId: hash, seller: addressHex(seller.address) })) { /* no payments */ }
  assert.deepEqual(requests.map(request => [request.fromBlock, request.toBlock]), [[123n, 1122n], [1123n, 2122n], [2123n, 2345n]]);
  for (const request of requests) assert.deepEqual(request.args, { payer: addressHex(buyer.address), offerId: hash, seller: addressHex(seller.address) });
});


for (const token of [false, true]) test(`controller restores ${token ? "token" : "native"} funding, preserves journals, and handles a reorg without funding again`, async () => {
  const { MarketplaceController } = await import("../src/client/session.ts");
  const { marketplaceSellerState } = await import("../src/client/presentation.ts");
  const fixture = listing(token);
  const records = new Map<string, import("../src/client/offerPersistence.ts").StoredOffer>();
  const store: import("../src/client/offerPersistence.ts").MarketplaceStore = {
    list: async () => [...records.values()], get: async key => records.get(key) ?? null,
    put: async value => { records.set(value.key, value); }, remove: async key => { records.delete(key); },
    clear: async () => { records.clear(); },
    update: async (key, update) => { const next = update(records.get(key) ?? null); if (next === null) records.delete(key); else records.set(key, next); return next; },
  };
  let rows: typeof fixture.sent[] = [];
  let registered = true;
  let contractReads = 0;
  const node = { getTransactionByNullifier: async () => null, catalogInfo: async () => { throw new Error("catalog offline"); },
    getContract: async () => { contractReads++; return registered ? fixture.contract : { status: "notFound" }; },
  } as unknown as PcashNodeClient;
  const context = { node, profile: seller, status, spendable: () => true, store: { load: async () => ({ sentOutputs: rows }) } } as unknown as WalletExecutionContext;
  const wallet = {
    address: addressHex(seller.address), network: { chainId: fixture.offer.chainId },
    execute: async (action: (context: WalletExecutionContext) => unknown) => action(context),
    send: () => { throw new Error("must not fund again"); }, sendAsset: () => { throw new Error("must not fund again"); },
  };
  const controller = new MarketplaceController({ node, store, l1RpcUrls: ["unused"], identity: { wallet, l1Signer: { address: addressHex(seller.address) } } as never });
  assert.equal((await controller.refresh()).localOffers.length, 0);
  rows = [fixture.sent];
  const pending = controller.refresh();
  assert.equal(controller.refresh(), pending);
  const result = await pending;
  assert.equal(contractReads, 1);
  assert.match(result.catalogError!, /catalog offline/);
  assert.deepEqual(result.recoveryErrors, []);
  assert.equal(publicationIdentity(result.localOffers[0]!.pub), publicationIdentity(fixture.publication));
  assert.equal(marketplaceSellerState(result.localOffers[0]!, seller.address)?.phase, "funded");
  registered = true;
  const key = offerKey(fixture.publication);
  const reclaim = { phase: "failed" as const, publication: fixture.publication, error: "retry proof", updatedAt: 2 };
  await store.update(key, current => ({ ...current!, reclaim }));
  const restored = (await controller.refresh()).localOffers[0]!;
  assert.equal(restored.recovered, true);
  assert.deepEqual(restored.reclaim, reclaim);
  rows = [];
  const orphaned = (await controller.refresh()).localOffers[0]!;
  assert.equal(marketplaceSellerState(orphaned, seller.address)?.phase, "recovery-unavailable");
  await assert.rejects(controller.resumePublication(fixture.publication), /Recover the funded escrow/);
  rows = [fixture.sent];
  const rediscovered = (await controller.refresh()).localOffers[0]!;
  assert.equal(rediscovered.recoveryUnavailable, false);
  assert.deepEqual(rediscovered.reclaim, reclaim);
  assert.equal(records.size, 1);
});

const SPEND = `0x${"44".repeat(32)}`;
const spendReceipt = { transactionId: SPEND, contentHash: SPEND, outcome: "succeeded", failureDetail: null, l1Sender: addressHex(1n),
  issuanceOwnerCommitment: null, settledOpenFeeAmount: 0n, settledIssuanceAmount: 0n, kind: "privateValue", accountCreation: 0,
  inclusion: { l1BlockNumber: 100n, l1BlockHash: blockHash, l1TransactionIndex: 0n, l1TransactionHash: blockHash, batchItemIndex: 0n },
  outputLeafStart: 8n, outputsAdded: 1n, nullifiers: null, account: null };
/** A node whose escrow nullifier was spent by `SPEND`, a transaction that required `carrier` in a block at `timestamp`. */
const spentEscrowNode = (contract: unknown, carrier = 0n, timestamp = 1n) => ({ catalogInfo: async () => { throw new Error("catalog offline"); },
  getContract: async () => contract, getTransactionByNullifier: async () => escrowSpenderResult(SPEND, 100n, carrier, timestamp),
  getReceipt: async ({ contentHash }: { contentHash: string }) => contentHash === SPEND ? [spendReceipt] : [],
  status: async () => ({ finalizedL1BlockNumber: 100n }) }) as unknown as PcashNodeClient;

function memoryStore(...offers: import("../src/client/offerPersistence.ts").StoredOffer[]) {
  const records = new Map(offers.map(offer => [offer.key, offer]));
  const store: import("../src/client/offerPersistence.ts").MarketplaceStore = {
    list: async () => [...records.values()], get: async key => records.get(key) ?? null,
    put: async value => { records.set(value.key, value); }, remove: async key => { records.delete(key); },
    clear: async () => { records.clear(); },
    update: async (key, update) => { const next = update(records.get(key) ?? null); if (next === null) records.delete(key); else records.set(key, next); return next; },
  };
  return store;
}

for (const spender of ["reclaim", "claim", "unreadable"] as const) test(`a restored listing whose escrow ${spender === "reclaim" ? "a spend after T took is returned" : spender === "claim" ? "a claim at T took stays funded" : "spender cannot be read stays funded and reports it"}`, async () => {
  const { MarketplaceController } = await import("../src/client/session.ts");
  const { marketplaceSellerState } = await import("../src/client/presentation.ts");
  const fixture = listing();
  const reclaimed = spender === "reclaim";
  // A claim expires by T and the seller's reclaim starts after it.
  const deadline = fixture.offer.terms.deadlineT;
  const node = { ...spentEscrowNode(fixture.contract, 0n, reclaimed ? deadline + 1n : deadline),
    ...(spender === "unreadable" ? { getTransactionByNullifier: async () => { throw new Error("node unavailable"); } } : {}) } as unknown as PcashNodeClient;
  const context = { node, profile: seller, status, spendable: () => true,
    store: { load: async () => ({ sentOutputs: [fixture.sent] }) } } as unknown as WalletExecutionContext;
  const wallet = { address: addressHex(seller.address), network: { chainId: fixture.offer.chainId },
    execute: async (action: (context: WalletExecutionContext) => unknown) => action(context) };
  const controller = new MarketplaceController({ node, store: memoryStore(), l1RpcUrls: ["unused"], now: () => 7,
    identity: { wallet, l1Signer: { address: addressHex(seller.address) } } as never });
  const result = await controller.refresh();
  const restored = result.localOffers[0]!;
  assert.equal(marketplaceSellerState(restored, seller.address)?.phase, reclaimed ? "reclaimed" : "funded");
  assert.equal(restored.reclaim?.contentHash, reclaimed ? SPEND : undefined);
  assert.equal(result.recoveryErrors?.length ?? 0, spender === "unreadable" ? 1 : 0);
});

test("a wallet that bought its own listing restores the listing with no reclaim and the purchase complete", async () => {
  const { MarketplaceController } = await import("../src/client/session.ts");
  const { marketplaceBuyerState, marketplaceSellerState } = await import("../src/client/presentation.ts");
  const { marketplaceBuyerKey } = await import("../src/client/offerPersistence.ts");
  const fixture = listing();
  const { publication } = fixture;
  const buyerAddress = marketplaceBuyerKey(seller.address);
  const buy = { buyerAddress, publication, commitment: BUY_COMMITMENT, txHash: hash, blockNumber: "90", paidAt: 5 };
  const offer = { key: offerKey(publication), pub: publication, source: "created" as const, savedAt: 1, buys: { [buyerAddress]: buy } };
  const node = spentEscrowNode(fixture.contract, paymentCarrierContextHash(publicationTerms(publication), BigInt(BUY_COMMITMENT)));
  // The claim paid this wallet, so the wallet holds it among its own transactions.
  const context = { node, profile: seller, status, spendable: () => true,
    store: { load: async () => ({ sentOutputs: [fixture.sent], transactionRecords: [{ contentHash: SPEND }] }) } } as unknown as WalletExecutionContext;
  const wallet = { address: addressHex(seller.address), network: { chainId: fixture.offer.chainId },
    execute: async (action: (context: WalletExecutionContext) => unknown) => action(context) };
  const controller = new MarketplaceController({ node, store: memoryStore(offer), l1RpcUrls: ["unused"], now: () => 7,
    identity: { wallet, l1Signer: { address: addressHex(seller.address) } } as never });
  const result = await controller.refresh();
  assert.deepEqual(result.recoveryErrors, []);
  const restored = result.localOffers[0]!;
  assert.equal(restored.reclaim, undefined);
  assert.equal(marketplaceSellerState(restored, seller.address)?.phase, "funded");
  assert.equal(marketplaceBuyerState(restored, seller.address)?.phase, "claimed");
  assert.equal(restored.buys?.[buyerAddress]?.claimContentHash, SPEND);
});

test("a paid purchase reconciles as claimed from the escrow spender bound to its payment, whichever of its claims spent the escrow", async () => {
  const { MarketplaceController } = await import("../src/client/session.ts");
  const { marketplaceBuyerState } = await import("../src/client/presentation.ts");
  const { marketplaceBuyerKey } = await import("../src/client/offerPersistence.ts");
  const { publication } = listing();
  const buyerAddress = marketplaceBuyerKey(buyer.address);
  // The saved bytes are a newer claim, proved again after an older one was sent; the older one spent the escrow note.
  const buy = { buyerAddress, publication, commitment: BUY_COMMITMENT, txHash: hash, blockNumber: "90", paidAt: 5,
    claimContentHash: `0x${"56".repeat(32)}`, claimTransactionHex: "0x01", claimAnchorBlockNumber: "80", claimAnchorBlockHash: blockHash, claimNotAfter: "99" };
  const offer = { key: offerKey(publication), pub: publication, source: "catalog" as const, savedAt: 1, buys: { [buyerAddress]: buy } };
  const ours = paymentCarrierContextHash(publicationTerms(publication), BigInt(BUY_COMMITMENT));
  const controller = new MarketplaceController({ node: spentEscrowNode(undefined, ours), store: memoryStore(offer), l1RpcUrls: ["unused"], now: () => 7 });
  const reconciled = (await controller.refresh()).localOffers[0]!;
  assert.equal(marketplaceBuyerState(reconciled, buyer.address)?.phase, "claimed");
  assert.equal(reconciled.buys?.[buyerAddress]?.claimContentHash, SPEND);
  assert.equal(reconciled.buys?.[buyerAddress]?.claimTransactionHex, undefined);

  // The seller's reclaim requires no carrier, and another buyer's claim, on a branch that
  // replaced this payment, requires the router's context for that buyer's commitment.
  for (const carrier of [0n, paymentCarrierContextHash(publicationTerms(publication), 0xdddn)]) {
    const spent = (await new MarketplaceController({ node: spentEscrowNode(undefined, carrier), store: memoryStore(offer), l1RpcUrls: ["unused"], now: () => 7 }).refresh()).localOffers[0]!;
    assert.equal(marketplaceBuyerState(spent, buyer.address)?.phase, "paid");
    assert.equal(spent.buys?.[buyerAddress]?.claimedAt, undefined);
  }
  // An unpaid record's spender is no claim of this buyer's.
  const unpaid = { ...offer, buys: { [buyerAddress]: { buyerAddress, publication, commitment: BUY_COMMITMENT } } };
  const selected = (await new MarketplaceController({ node: spentEscrowNode(undefined, ours), store: memoryStore(unpaid), l1RpcUrls: ["unused"], now: () => 7 }).refresh()).localOffers[0]!;
  assert.equal(marketplaceBuyerState(selected, buyer.address)?.phase, "selected");
});

test("restore tells apart payments that share a transaction and an offer id", () => {
  const { publication, log } = buyerRecoveryFixture(false);
  const saved = savedPaymentIdentity(hash, publication);
  assert.equal(scannedPaymentIdentity(router, log), saved);
  // A contract wallet's batch can pay another publication with the same id at another price.
  assert.notEqual(scannedPaymentIdentity(router, { ...log, args: { ...log.args, amount: 901n } }), saved);
  assert.notEqual(scannedPaymentIdentity(router, { ...log, args: { ...log.args, seller: addressHex(12n) } }), saved);
  assert.notEqual(scannedPaymentIdentity(addressHex(12n), log), saved);
  assert.notEqual(scannedPaymentIdentity(router, { ...log, transactionHash: blockHash }), saved);
});

test("buyer rejects malformed recovery data, foreign definitions, changed openings, and inconsistent blocks", async () => {
  const { publication, input, log } = buyerRecoveryFixture(true);
  const withRecovery = (recoveryData: Hex) => ({ ...input, log: { ...log, args: { ...log.args, recoveryData } } });
  await assert.rejects(recoverPaymentPublication(withRecovery("0x01")));
  await assert.rejects(recoverPaymentPublication(withRecovery(encodePaymentRecovery({ ...publication, assetDefinition: bytesToHex(testToken(99n).bytes) }))),
    /does not derive the listed assetId/);
  await assert.rejects(recoverPaymentPublication(withRecovery(encodePaymentRecovery({ ...publication, escrow: { ...publication.escrow!, noteSecret: fieldToHex(99n) } }))),
    /another claim key/);
  await assert.rejects(recoverPaymentPublication({ ...input, node: { ...input.node, getOutputPath: async () => null } as unknown as PcashNodeClient }), /opening is unavailable/);
  await assert.rejects(recoverPaymentPublication({ ...input, client: { getBlock: async () => ({ hash: `0x${"33".repeat(32)}` }) } as unknown as typeof input.client }), /no longer canonical/);
});
