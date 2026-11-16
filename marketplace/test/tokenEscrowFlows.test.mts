import { assetDefinitionSchema } from "@pcash/sdk/protocol";
import { restoredSellerPublication, restoredBuyerPublication } from "./recoveredPublication.ts";
// Recovered native and token escrow claim and reclaim through the production flows,
// proved natively through the complete CHONK stacks against one coherent
// synthetic PCASH state.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex, hexToBytes, keccak256, numberToHex, type Hex } from "viem";
import {
  accountStateCommitment,
  addressHex,
  baseFee,
  nativeBurnAmount,
  privateValueUnits,
  quoteNetworkFee,
  BLOCK_HEADER_KEY_STATE_ROOT,
  blockHash,
  decodeContractBody,
  decodeTransaction,
  decodePayload,
  decryptEnvelope,
  DEFAULT_NETWORK_CONFIG,
  outputRecords,
  privateValueProfile,
  sectionPublicInput,
  transactionPublication,
  trialOpenEnvelope,
  TX_KIND_PRIVATE_VALUE,
  fieldToHex,
  fullOutputCommitment,
  generateMlKemKeyPair,
  issuancePayoutOpening,
  MERKLE_DEPTH,
  nullifierKeyCommitment,
  openBlockHeaderKey,
  openStateKey,
  privateKeyPcashActionSigner,
  receiveKeyHash,
  SparseMerkleTree,
  STATE_KEY_ACCOUNT_STATE_ROOT,
  stateRoot,
  WIRE_PROOF_BYTES,
  type AccountProofResult,
  type BlockHeaderCommitment,
  type PcashNodeClient,
  type StateCommitment,
  type StatusResult,
  type WitnessSnapshotQuery,
} from "@pcash/sdk/browser";
import type { AssetActionBuild } from "@pcash/sdk/builders";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import { createReleaseChonkCircuitResolver, nativeChonkBackend } from "@pcash/sdk/node";
import { proveTransferTransactionChonk, proveSponsoredTransferChonk } from "@pcash/sdk/prover";
import { derivePcashProfileFromPrivateKey, type PcashProfile } from "@pcash/sdk/wallet";
import { runSponsoredContractAssetActionClient } from "@pcash/sdk/wallet/actions";
import {
  CLAIM_APPLICATION_VK_HASH,
  RECLAIM_APPLICATION_VK_HASH,
  paymentCarrierContextHash,
} from "../src/commitments.mts";
import { createOffer } from "../src/offer.mts";
import { publicationFromOffer, type OfferPublication } from "../src/client/publication.ts";
import { CLAIM_BATCH_BYTES, purchaseCommitment } from "../src/client/buy.ts";
import { claimBatch, claimValidUntil, proveCarriedClaim, readClaimSnapshot, type MarketplaceProver } from "../src/client/claimFlow.ts";
import { publicationTerms } from "../src/client/publication.ts";
import { reclaimMarketplaceOffer, resumeMarketplaceReclaim, type MarketplaceFeeSponsor } from "../src/client/reclaimFlow.ts";
import { ProtocolFeeRaisedError } from "../src/client/mempoolSubmission.ts";
import { testToken } from "./tokenFixtures.ts";

const NETWORK = DEFAULT_NETWORK_CONFIG;
const CHAIN_ID = NETWORK.pcashChainId;
const GENESIS_HASH = `0x${"11".repeat(32)}`;
const SELLER_KEY = new Uint8Array(32).fill(7);
const BUYER_KEY = new Uint8Array(32).fill(8);
const seller = derivePcashProfileFromPrivateKey(SELLER_KEY, NETWORK);
const buyer = derivePcashProfileFromPrivateKey(BUYER_KEY, NETWORK);
const sellerSigner = privateKeyPcashActionSigner(SELLER_KEY);
const buyerSigner = privateKeyPcashActionSigner(BUYER_KEY);
const buyerReceiveKey = generateMlKemKeyPair(new Uint8Array(64).fill(61));
const sellerReceiveKey = generateMlKemKeyPair(new Uint8Array(64).fill(62));
const registeredKey = (profile: PcashProfile) => profile.address === buyer.address ? buyerReceiveKey : sellerReceiveKey;
const AMOUNT = 5_000_000n;
// Large enough to pay a burn above the waiver, about 10^9 per state unit.
const FEE_NOTE_AMOUNT = 10n ** 12n;
const OPEN_FEE = 300n;
const ESCROW_SECRET = 0x5eed_0001n;
const DEADLINE = 1_800_100_000n;
const ROUTER = 0x5fbdb2315678afecb367f032d93f642f64180aa3n;
const PAYMENT_SELLER = 0xd0d0n;
/** The Ethereum block the synthetic PCASH head was derived from. */
const L1_ORIGIN_BLOCK = 2n;
const L1_ORIGIN_HASH = `0x${"ca".repeat(32)}` as Hex;
/** The Ethereum head at the synthetic node's tip. */
const ETHEREUM_HEAD = { gasLimit: 60_000_000n, timestamp: 1_800_000_000n };

const hex = (value: bigint): string => fieldToHex(value);
let circuitResolver: ReturnType<typeof createReleaseChonkCircuitResolver> | undefined;
const resolve: ReturnType<typeof createReleaseChonkCircuitResolver> = (...args) => (circuitResolver ??= createReleaseChonkCircuitResolver())(...args);
let nativeBackend: ReturnType<typeof nativeChonkBackend> | undefined;
const backend = () => nativeBackend ??= nativeChonkBackend();
const packageOf = (circuitUrl: string): string => circuitUrl.replace(/^\/prover\//, "").replace(/\.json$/, "");

/** The production browser request, proved through the native CHONK stack. */
const nativeProver: MarketplaceProver = {
  proveTransfer: async (args) => {
    assert.ok(args.authorizationCircuitUrl);
    const result = await proveTransferTransactionChonk({
      build: { shape: 0, publicInputs: [...args.expectedPublicInputs], buildKernelWitnessMap: args.buildKernelWitnessMap },
      authorizationPackage: packageOf(args.authorizationCircuitUrl), authorizationWitnessMap: args.authorizationWitnessMap,
      resolve, backend: backend(),
    });
    return { proof: result.proof };
  },
  proveUserAccountUpdate: async () => { throw new Error("not an account update"); },
  proveAssetAction: async (args) => {
    const build = { shape: 0 as const, publicInputs: [...args.expectedPublicInputs] };
    const result = args.operation === "transfer"
      ? await proveTransferTransactionChonk({
        build: { ...build, buildKernelWitnessMap: args.buildKernelWitnessMap },
        authorizationPackage: packageOf(args.authorization.circuitUrl),
        authorizationWitnessMap: args.authorization.witnessMap,
        resolve, backend: backend(),
      })
      : args.operation === "sponsored-transfer"
        ? await proveSponsoredTransferChonk({
          build: build as unknown as AssetActionBuild,
          primary: { packageName: packageOf(args.primary.circuitUrl), witnessMap: args.primary.witnessMap },
          feePayer: { packageName: packageOf(args.feePayer.circuitUrl), witnessMap: args.feePayer.witnessMap },
          buildKernelWitnessMap: args.buildKernelWitnessMap,
          resolve, backend: backend(),
        })
        : (() => { throw new Error("not an issuance"); })();
    return { proof: result.proof };
  },
};

for (const token of [{ assetId: 0n, bytes: undefined, definition: undefined }, testToken()]) for (const mockProof of [false, true]) {
  const prover: MarketplaceProver = mockProof ? { ...nativeProver,
    proveTransfer: async () => ({ proof: new Uint8Array(WIRE_PROOF_BYTES) }),
    proveAssetAction: async () => ({ proof: new Uint8Array(WIRE_PROOF_BYTES) }),
  } : nativeProver;
  const assetName = token.assetId === 0n ? "native" : "token";
  const offer = createOffer({
    network: NETWORK,
    terms: { router: ROUTER, seller: PAYMENT_SELLER, assetId: token.assetId, amount: AMOUNT, ethPriceWei: 10n ** 16n, deadlineT: DEADLINE },
    sellerWallet: seller,
    l2ContractNkRoot: 0xc0ffeen,
    claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
    reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
  });
  const publication: OfferPublication = {
    ...publicationFromOffer(offer, token.bytes),
    escrow: { leafIndex: 0, noteSecret: hex(ESCROW_SECRET), amount: hex(AMOUNT) },
  };
  const escrowCommitment = fullOutputCommitment(
    { owner: offer.l2ContractAddress, noteSecret: ESCROW_SECRET, assetId: token.assetId, amount: AMOUNT }, 0,
  );
  function feeNote(profile: PcashProfile, leafIndex: number) {
    const noteSecret = 0xfee0n + BigInt(leafIndex);
    return {
      noteSecret,
      commitment: fullOutputCommitment({ owner: profile.address, noteSecret, assetId: 0n, amount: FEE_NOTE_AMOUNT }, leafIndex),
    };
  }
  const buyerFee = feeNote(buyer, 1);
  const sellerFee = feeNote(seller, 2);
  const outputs = new SparseMerkleTree(MERKLE_DEPTH);
  outputs.setLeaf(0, escrowCommitment);
  outputs.setLeaf(1, buyerFee.commitment);
  outputs.setLeaf(2, sellerFee.commitment);
  const userRules = (profile: PcashProfile) => defaultUserAccountRuleSet({
    wallet: profile, network: NETWORK, secrets: profile.defaultUserRuleSecrets,
  });
  const contractReceiveKeyHash = receiveKeyHash(decodeContractBody(offer.l2ContractBody).mlKemPublicKey!);
  const accounts = new SparseMerkleTree(MERKLE_DEPTH);
  accounts.setLeaf(0, accountStateCommitment(
    offer.l2ContractAddress, nullifierKeyCommitment(offer.l2ContractNkRoot), offer.functionSetCommitment, 1n, 1n, contractReceiveKeyHash,
  ));
  for (const [index, profile] of [[1, buyer], [2, seller]] as const) {
    accounts.setLeaf(index, accountStateCommitment(
      profile.address, profile.nullifierKeyCommitment, userRules(profile).accountRuleSetCommitment, 0n, 1n, receiveKeyHash(registeredKey(profile).publicKey),
    ));
  }
  const state: StateCommitment = {
    outputRoot: outputs.root, outputCount: 3, issuedSoFar: 0n, lagQ: -(8n * 86_400n << 128n),
    accountStateRoot: accounts.root, accountCount: 3, nullifierRoot: 0n, nullifierCount: 0n, feeExcess: 0n,
  };
  const header: BlockHeaderCommitment = {
    parentHash: 0n, number: 10n, timestamp: 1_800_000_000n, transactionResultsRoot: 0n,
    stateRoot: stateRoot(state), l1OriginRoot: 0n, historyRoot: 0n,
  };
  const recentPcashBlockHash = blockHash(header);
  const boundary = {
    state: { ...state, outputCount: 3n, accountCount: 3n },
    header,
    blockHash: recentPcashBlockHash,
  } as unknown as Extract<AccountProofResult, { status: "present" }>["boundary"];
  const stateRootHeaderSiblings = openBlockHeaderKey(header, BLOCK_HEADER_KEY_STATE_ROOT).siblings.map(BigInt);
  const accountStateRootStateSiblings = openStateKey(state, STATE_KEY_ACCOUNT_STATE_ROOT).siblings.map(BigInt);

  function accountProof(index: number, account: Record<string, unknown>): Extract<AccountProofResult, { status: "present" }> {
    return {
      status: "present",
      account: { index: BigInt(index), accountRevision: 1n, ...account } as never,
      accountStateRoot: accounts.root,
      accountSiblings: accounts.proof(index).siblings,
      accountCount: 3n,
      stateRootHeaderSiblings,
      accountStateRootStateSiblings,
      boundary,
    };
  }
  const userAccount = (index: number, profile: PcashProfile) => accountProof(index, {
    address: addressHex(profile.address),
    nullifierKeyCommitment: hex(profile.nullifierKeyCommitment),
    accountRuleSetCommitment: hex(userRules(profile).accountRuleSetCommitment),
    accountKind: 0,
    receiveKeyHash: hex(receiveKeyHash(registeredKey(profile).publicKey)),
    material: { status: "available", mlKem768PublicKey: bytesToHex(registeredKey(profile).publicKey) },
  });
  const accountByAddress = new Map<bigint, Extract<AccountProofResult, { status: "present" }>>([
    [offer.l2ContractAddress, accountProof(0, {
      address: addressHex(offer.l2ContractAddress), accountKind: 1,
      nullifierKeyCommitment: hex(nullifierKeyCommitment(offer.l2ContractNkRoot)),
      accountRuleSetCommitment: hex(offer.functionSetCommitment),
      receiveKeyHash: hex(contractReceiveKeyHash), material: { status: "notPresent" },
    })],
    [buyer.address, userAccount(1, buyer)],
    [seller.address, userAccount(2, seller)],
  ]);
  function statusAt(latestBlockTimestamp: bigint, feeExcess = 0n): StatusResult {
    return {
      pcashChainId: Number(CHAIN_ID), genesisHash: GENESIS_HASH, l1ChainId: NETWORK.l1ChainId,
      inboxAddress: addressHex(NETWORK.inboxAddress), acceptedTransactionTypes: [0, 1, 2, 3],
      latestBlock: 10n, latestBlockHash: hex(recentPcashBlockHash), latestBlockTimestamp,
      finalizedBlock: 10n, finalizedBlockTimestamp: latestBlockTimestamp,
      feeExcess, baseFee: baseFee(feeExcess),
    } as unknown as StatusResult;
  }

  function worldNode(latestBlockTimestamp: bigint, accepted: { contentHash: string }, feeExcess = 0n): PcashNodeClient {
    const status = statusAt(latestBlockTimestamp, feeExcess);
    return {
      status: async () => status,
      getAccountProof: async (address: string) => accountByAddress.get(BigInt(address)) ?? { status: "notFound", address, authenticated: false },
      getWitnessSnapshot: async (query: WitnessSnapshotQuery = {}) => ({
        status,
        blockHeader: { recentPcashBlockHash, boundary },
        block: { number: header.number, hash: hex(recentPcashBlockHash), l1Origin: { blockNumber: L1_ORIGIN_BLOCK, blockHash: L1_ORIGIN_HASH } },
        accounts: (query.accounts ?? []).map((address) => accountByAddress.get(BigInt(address))!),
        contracts: (query.contracts ?? []).map((address) => ({ status: "contract", accountProof: accountByAddress.get(BigInt(address))! })),
        outputs: query.outputs?.length ? {
          root: hex(outputs.root), count: 3n, boundary,
          paths: query.outputs.map((request) => ({
            outputIndex: BigInt(request.outputIndex),
            siblings: outputs.proof(Number(request.outputIndex)).siblings.map(hex),
          })),
        } : null,
        nullifiers: { statuses: (query.nullifiers ?? []).map((nullifier) => ({ nullifier, spent: false })), boundary },
        l1Logs: [],
      }),
      getReceipt: async () => accepted.contentHash === "" ? [] : [{
        contentHash: accepted.contentHash, outcome: "succeeded", failureDetail: null,
        l1Sender: "0x0000000000000000000000000000000000000000", issuanceOwnerCommitment: null,
        settledOpenFeeAmount: "0x0", settledIssuanceAmount: "0x0", transactionId: `0x${"e1".repeat(32)}`, kind: "privateValue",
        inclusion: { l1BlockNumber: "0x65", l1BlockHash: GENESIS_HASH }, outputLeafStart: "0x3",
      }],
      getMempoolTransaction: async () => null,
    } as unknown as PcashNodeClient;
  }

  /** A wallet's local chain synced through the world's block: its account set and output tree, none of its notes consumed. */
  const syncedChain = {
    synced: { pcashNumber: header.number, pcashHash: hex(recentPcashBlockHash) },
    requireAnchor: () => boundary,
    accountProof: (address: string) => accountByAddress.get(BigInt(address)),
    outputPaths: (requested: readonly { outputIndex: bigint | number }[]) => ({
      root: hex(outputs.root), count: 3n, boundary,
      paths: requested.map(({ outputIndex }) => ({ outputIndex: BigInt(outputIndex), siblings: outputs.proof(Number(outputIndex)).siblings })),
    }),
    consumption: (nullifiers: readonly string[]) => nullifiers.map(() => null),
  };

  /** A minimal in-memory wallet document store for the sponsoring account. */
  function sponsorFor(profile: PcashProfile, signer: typeof buyerSigner, fee: { noteSecret: bigint; commitment: bigint }, leafIndex: number, node: PcashNodeClient) {
    let data = {
      version: 1,
      address: hex(profile.address),
      network: { chainId: CHAIN_ID.toString(), genesisHash: GENESIS_HASH },
      receiveKeys: [{ receiveKeyHash: hex(receiveKeyHash(registeredKey(profile).publicKey)),
        mlKemPublicKey: bytesToHex(registeredKey(profile).publicKey), mlKemSecretKey: bytesToHex(registeredKey(profile).secretKey) }],
      notes: [{
        leafIndex: String(leafIndex), outputIndex: leafIndex, assetId: "0x0", amount: FEE_NOTE_AMOUNT.toString(),
        owner: hex(profile.address), noteSecret: hex(fee.noteSecret), commitment: hex(fee.commitment),
        spent: false, pending: false,
      }],
    } as Record<string, unknown>;
    type Store = Parameters<typeof runSponsoredContractAssetActionClient>[0]["store"];
    const store = {
      identity: { address: profile.address, network: { chainId: CHAIN_ID.toString(), genesisHash: GENESIS_HASH } },
      load: async () => structuredClone(data),
      readChain: async <T,>(read: (chain: never) => T | Promise<T>) => read(syncedChain as never),
      // Reservation leases stay store-owned across document saves, as in the wallet's stores.
      save: async (next: unknown) => {
        data = { ...structuredClone(next) as Record<string, unknown>, resourceReservations: data.resourceReservations };
        if (data.resourceReservations === undefined) delete data.resourceReservations;
      },
      transaction: async (operation: (current: unknown) => { data: unknown; value: unknown }) => {
        const commit = operation(structuredClone(data));
        data = structuredClone(commit.data) as Record<string, unknown>;
        return commit.value;
      },
    } as unknown as Store;
    const sponsor: MarketplaceFeeSponsor = {
      sponsorContractAction: ((intent: Parameters<MarketplaceFeeSponsor["sponsorContractAction"]>[0]) =>
        runSponsoredContractAssetActionClient({
          ...intent, node, store, wallet: profile, signer, chainId: CHAIN_ID,
          submission: intent.submission!, settlePollMaxAttempts: 1,
        })) as MarketplaceFeeSponsor["sponsorContractAction"],
    };
    return { sponsor, journal: () => data as { pendingAssetActions?: { contentHash: string; inputs: { spentCommitment: string | null }[]; ownedOutputs: unknown[] }[] } };
  }

  /** The payout note at slot 0 and the asset definition its recipient region delivers. */
  function payoutOf(transactionHex: Hex, profile: PcashProfile) {
    const decoded = decodeTransaction(hexToBytes(transactionHex));
    if (decoded.kind !== 0) throw new Error("expected a private-value entry");
    assert.equal(decryptEnvelope(profile.mlKemSecretKey, decoded.outputData[0]!), null);
    const opened = trialOpenEnvelope(registeredKey(profile).secretKey, decoded.outputData[0]!);
    if (opened === null) throw new Error("payout is not delivered to its recipient");
    const note = decodePayload(opened.plaintext, { chainId: CHAIN_ID });
    const { inputs, offsets } = privateValueProfile(decoded.shape);
    const nullifiers = Array.from({ length: inputs }, (_, index) => sectionPublicInput(decoded, offsets.nullifiers + index));
    const records = outputRecords(note, opened.sharedSecret, {
      arena: decoded.arena, shape: decoded.shape, context: { chainId: CHAIN_ID, transactionType: TX_KIND_PRIVATE_VALUE, nullifiers },
    });
    const definition = records?.find(record => record.schema === assetDefinitionSchema.id);
    return { ...note, assetDefinition: definition === undefined ? undefined : assetDefinitionSchema.decode(definition.data) };
  }

  async function claim(failDelivery = false) {
    const node = worldNode(1_800_000_000n, { contentHash: "" });
    const recovered = await restoredBuyerPublication(offer, publication, buyer);
    const snapshot = await readClaimSnapshot(node, recovered);
    const actionProver: MarketplaceProver = {
      ...prover,
      proveTransfer: async (...args) => { assert.equal(failDelivery, false, "missing delivery must fail before proving"); return prover.proveTransfer(...args); },
      proveAssetAction: async (...args) => { assert.equal(failDelivery, false, "missing delivery must fail before proving"); return prover.proveAssetAction(...args); },
    };
    let deliveryReads = 0;
    const proved = await proveCarriedClaim({
      node, offer: recovered, buyer, snapshot, prover: actionProver, ethereumHead: ETHEREUM_HEAD,
      buyerReceiveKey: async (root) => {
        deliveryReads++;
        assert.equal(root, accounts.root);
        if (failDelivery) throw new Error("no owned receive key at the final account root");
        return buyerReceiveKey.publicKey;
      },
    });
    assert.equal(deliveryReads, 1);
    assert.deepEqual(snapshot.anchor, { blockNumber: L1_ORIGIN_BLOCK, blockHash: L1_ORIGIN_HASH });
    assert.equal(snapshot.timestamp, header.timestamp);
    return { proved, recovered };
  }

  test(`${mockProof ? "mock proof: " : ""}a recovered ${assetName} claim requires the router's carrier context and pays the buyer the whole amount`, async () => {
    const { proved, recovered } = await claim();
    const decoded = decodeTransaction(hexToBytes(proved.transactionHex));
    if (decoded.kind !== TX_KIND_PRIVATE_VALUE) throw new Error("expected a private-value entry");
    const { offsets } = privateValueProfile(decoded.shape);
    assert.equal(sectionPublicInput(decoded, offsets.carrierContextHash),
      paymentCarrierContextHash(publicationTerms(recovered), BigInt(purchaseCommitment(recovered, buyer))));
    assert.equal(sectionPublicInput(decoded, offsets.openFeeAmount), 0n);
    assert.notEqual(sectionPublicInput(decoded, offsets.issuanceOwner), 0n);
    assert.equal(sectionPublicInput(decoded, offsets.validUntil), DEADLINE);
    assert.equal(sectionPublicInput(decoded, offsets.recentBlockHash), recentPcashBlockHash);
    const payout = payoutOf(proved.transactionHex, buyer);
    assert.equal(payout.assetId, token.assetId);
    assert.equal(payout.amount, AMOUNT);
    assert.equal(payout.owner, buyer.address);
    assert.deepEqual(payout.assetDefinition, token.definition);
    // The router carries it as a batch of exactly the size its gas is quoted for.
    assert.equal(hexToBytes(claimBatch({ acceptedBatchVersions: [1] }, buyer, proved.transactionHex)).length, CLAIM_BATCH_BYTES);
  });

  async function reclaim(sponsored: boolean, failDelivery = false) {
    const accepted = { contentHash: "" };
    const node = worldNode(DEADLINE + 100n, accepted);
    let deliveryKey = seller.mlKemPublicKey;
    let snapshotRead = false;
    let deliveryReads = 0;
    const readSnapshot = node.getWitnessSnapshot.bind(node);
    node.getWitnessSnapshot = async (query) => {
      assert.deepEqual(query?.accounts, token.assetId !== 0n && sponsored && query?.accounts?.length === 2
        ? [addressHex(offer.l2ContractAddress), addressHex(seller.address)] : [addressHex(offer.l2ContractAddress)]);
      const snapshot = await readSnapshot(query);
      deliveryKey = sellerReceiveKey.publicKey;
      snapshotRead = true;
      return snapshot;
    };
    const actionProver: MarketplaceProver = {
      ...prover,
      proveTransfer: async (...args) => { assert.equal(failDelivery, false, "missing delivery must fail before proving"); return prover.proveTransfer(...args); },
      proveAssetAction: async (...args) => { assert.equal(failDelivery, false, "missing delivery must fail before proving"); return prover.proveAssetAction(...args); },
    };
    const statements: string[] = [];
    const signer: typeof sellerSigner = {
      address: sellerSigner.address,
      signTypedData: async (request) => {
        statements.push(request.typedData.primaryType);
        if (request.typedData.primaryType === "PcashMarketplaceReclaim") {
          assert.equal((request.typedData.message as Record<string, string>).assetId, token.assetId.toString());
          assert.equal((request.typedData.message as Record<string, string>).payoutAmount, (AMOUNT - (token.assetId === 0n && sponsored ? OPEN_FEE : 0n)).toString());
        }
        return sellerSigner.signTypedData(request);
      },
    };
    const funding = sponsorFor(seller, signer, sellerFee, 2, node);
    const result = await reclaimMarketplaceOffer({
      node, offer: await restoredSellerPublication(offer, publication, seller), sellerProfile: seller, sellerReceiveKey: async (root) => {
        deliveryReads++;
        assert.equal(token.assetId !== 0n && sponsored, false, "sponsored reclaims resolve from their sponsor context");
        assert.equal(snapshotRead, true, "resolve self delivery after the reclaim snapshot");
        assert.equal(root, accounts.root);
        if (failDelivery) throw new Error("no owned receive key at the final account root");
        return deliveryKey;
      },
      sellerSigner: signer,
      readL1Timestamp: async () => DEADLINE + 1n,
      openFeeAmount: sponsored ? OPEN_FEE : 0n,
      publicationMode: "open",
      sponsor: funding.sponsor,
      prover: actionProver,
      submitTransaction: async (entry) => {
        accepted.contentHash = keccak256(entry);
        return { contentHash: accepted.contentHash, receipt: null, queued: true };
      },
      pollIntervalMs: 0,
      pollMaxAttempts: 1,
      groundingMaxAttempts: 1,
    });
    assert.equal(deliveryReads, token.assetId !== 0n && sponsored ? 0 : 1);
    return { result, statements, journal: funding.journal() };
  }

  if (mockProof) test(`mock proof: ${assetName} claim and reclaim refuse unavailable final-snapshot self delivery`, async () => {
    await assert.rejects(claim(true), /no owned receive key at the final account root/);
    await assert.rejects(reclaim(false, true), /no owned receive key at the final account root/);
  });

  test(`${mockProof ? "mock proof: " : ""}a recovered direct ${assetName} reclaim returns the whole escrow to the seller under its signed asset`, async () => {
    const { result, statements, journal } = await reclaim(false);
    const payout = payoutOf(result.transactionHex, seller);
    assert.equal(payout.assetId, token.assetId);
    assert.equal(payout.amount, AMOUNT);
    assert.deepEqual(payout.assetDefinition, token.definition);
    assert.deepEqual(statements, ["PcashMarketplaceReclaim"]);
    assert.equal(journal.pendingAssetActions, undefined);
  });

  test(`${mockProof ? "mock proof: " : ""}a recovered ${assetName} reclaim pays its open fee from the appropriate PCASH inputs`, async () => {
    const { result, statements, journal } = await reclaim(true);
    const payout = payoutOf(result.transactionHex, seller);
    assert.equal(payout.assetId, token.assetId);
    assert.equal(payout.amount, AMOUNT - (token.assetId === 0n ? OPEN_FEE : 0n));
    assert.deepEqual(payout.assetDefinition, token.definition);
    assert.deepEqual(statements, token.assetId === 0n ? ["PcashMarketplaceReclaim"] : ["PcashMarketplaceReclaim", "PcashContractInteraction"]);
    if (token.assetId === 0n) assert.equal(journal.pendingAssetActions, undefined);
    else assert.equal(journal.pendingAssetActions!.length, 1);
  });

  // An excess whose projected network fee is required; the sponsor's fee note covers it.
  const BURNING_EXCESS = 1_400_000n;
  const quotedBurn = quoteNetworkFee(BURNING_EXCESS, privateValueUnits(4, false));
  // The worst-case fee through the claim's 15-block purchase window at that excess, computed independently.
  const WINDOW_BURN = 38_000_000_000n;

  if (mockProof && token.assetId !== 0n) test("mock proof: a token claim at a positive fee burns it from the buyer's own PCASH as the sponsor", async () => {
    assert.ok(quotedBurn > 0n);
    const node = worldNode(1_800_000_000n, { contentHash: "" }, BURNING_EXCESS);
    const recovered = await restoredBuyerPublication(offer, publication, buyer);
    const snapshot = await readClaimSnapshot(node, recovered);
    // The node's tip moves three empty blocks past the snapshot; the fee bound
    // still starts from the snapshot's block, which the router call protects.
    const later = statusAt(1_800_000_036n, BURNING_EXCESS - 3n * 1_200n);
    node.status = async () => later;
    const statements: string[] = [];
    const signer: typeof buyerSigner = {
      address: buyerSigner.address,
      signTypedData: async (request) => { statements.push(request.typedData.primaryType); return buyerSigner.signTypedData(request); },
    };
    const funding = sponsorFor(buyer, signer, buyerFee, 1, node);
    const proved = await proveCarriedClaim({
      node, offer: recovered, buyer, snapshot, prover, sponsor: funding.sponsor, ethereumHead: ETHEREUM_HEAD,
      buyerReceiveKey: async () => { throw new Error("a sponsored claim resolves self delivery from its sponsor context"); },
    });
    const decoded = decodeTransaction(hexToBytes(proved.transactionHex));
    if (decoded.kind !== TX_KIND_PRIVATE_VALUE) throw new Error("expected a private-value entry");
    const { offsets } = privateValueProfile(decoded.shape);
    assert.equal(sectionPublicInput(decoded, offsets.carrierContextHash),
      paymentCarrierContextHash(publicationTerms(recovered), BigInt(purchaseCommitment(recovered, buyer))));
    assert.equal(sectionPublicInput(decoded, offsets.openFeeAmount), 0n);
    // Before payment the claim burns the fee's worst case through the purchase window.
    assert.equal(sectionPublicInput(decoded, offsets.nativeBurnAmount), WINDOW_BURN);
    // Self-published through the router: issuance is designated to the buyer.
    assert.notEqual(sectionPublicInput(decoded, offsets.issuanceOwner), 0n);
    // The claim expires with the purchase window, before the listing's deadline,
    // and the router call names the snapshot the wallet proved it against.
    assert.equal(claimValidUntil(proved.transactionHex), ETHEREUM_HEAD.timestamp + 180n);
    assert.deepEqual(proved.provedAgainst, { anchor: { blockNumber: L1_ORIGIN_BLOCK, blockHash: L1_ORIGIN_HASH }, timestamp: header.timestamp });
    const payout = payoutOf(proved.transactionHex, buyer);
    assert.equal(payout.assetId, token.assetId);
    assert.equal(payout.amount, AMOUNT);
    assert.deepEqual(statements, ["PcashContractInteractionWithBurn"]);
    // The wallet journals its fee note until the claim lands or expires.
    const pending = funding.journal().pendingAssetActions!;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.contentHash.toLowerCase(), proved.contentHash.toLowerCase());
    assert.deepEqual(pending[0]!.inputs.map((input) => input.spentCommitment === null ? null : BigInt(input.spentCommitment)),
      [null, buyerFee.commitment, null, null]);
    assert.equal(hexToBytes(claimBatch({ acceptedBatchVersions: [1] }, buyer, proved.transactionHex)).length, CLAIM_BATCH_BYTES);
  });

  if (mockProof && token.assetId !== 0n) test("mock proof: a self-published token reclaim that burns designates its issuance to the seller", async () => {
    assert.ok(quotedBurn > 0n);
    const accepted = { contentHash: "" };
    const node = worldNode(DEADLINE + 100n, accepted, BURNING_EXCESS);
    const messages = new Map<string, Record<string, string>>();
    const signer: typeof sellerSigner = {
      address: sellerSigner.address,
      signTypedData: async (request) => {
        messages.set(request.typedData.primaryType, request.typedData.message as Record<string, string>);
        return sellerSigner.signTypedData(request);
      },
    };
    const funding = sponsorFor(seller, signer, sellerFee, 2, node);
    const result = await reclaimMarketplaceOffer({
      node, offer: publication, sellerProfile: seller,
      sellerReceiveKey: async () => { throw new Error("a sponsored reclaim resolves self delivery from its sponsor context"); },
      sellerSigner: signer, readL1Timestamp: async () => DEADLINE + 1n, openFeeAmount: 0n, publicationMode: "self",
      sponsor: funding.sponsor, prover,
      submitTransaction: async (entry) => {
        accepted.contentHash = keccak256(entry);
        return { contentHash: accepted.contentHash, receipt: null, queued: false };
      },
      pollIntervalMs: 0, pollMaxAttempts: 1, groundingMaxAttempts: 1,
    });
    const published = transactionPublication(hexToBytes(result.transactionHex))!;
    assert.equal(published.nativeBurnAmount, quotedBurn);
    assert.equal(published.openFeeAmount, 0n);
    const sellerIssuance = issuancePayoutOpening(seller.address, seller.nkRoot, CHAIN_ID, published.nullifiers, published.shape);
    assert.equal(published.issuanceOwnerCommitment, sellerIssuance.ownerCommitment);
    const reclaimMessage = messages.get("PcashMarketplaceReclaimWithBurn")!;
    assert.equal(BigInt(reclaimMessage.issuanceRecipient!), seller.address);
    assert.equal(BigInt(reclaimMessage.issuanceOwnerCommitment!), sellerIssuance.ownerCommitment);
    assert.deepEqual([...messages.keys()], ["PcashMarketplaceReclaimWithBurn", "PcashContractInteractionWithBurn"]);
  });

  if (mockProof && token.assetId !== 0n) test("mock proof: a sponsored token reclaim whose burn the fee outgrew keeps its journaled bytes and fee note", async () => {
    const accepted = { contentHash: "" };
    const node = worldNode(DEADLINE + 100n, accepted, BURNING_EXCESS);
    const funding = sponsorFor(seller, sellerSigner, sellerFee, 2, node);
    const reclaimWith = () => reclaimMarketplaceOffer({
      node, offer: publication, sellerProfile: seller,
      sellerReceiveKey: async () => { throw new Error("a sponsored reclaim resolves self delivery from its sponsor context"); },
      sellerSigner, readL1Timestamp: async () => DEADLINE + 1n, openFeeAmount: 0n, publicationMode: "open",
      sponsor: funding.sponsor, prover,
      submitTransaction: async (entry) => ({ contentHash: keccak256(entry), receipt: null, queued: true }),
      pollIntervalMs: 0, pollMaxAttempts: 1, groundingMaxAttempts: 1,
    });
    // The fee alone selects the sponsored role: the seller's note pays the burn.
    await assert.rejects(reclaimWith(), /timed out waiting for the pcash receipt/);
    const journaled = funding.journal().pendingAssetActions!;
    assert.equal(journaled.length, 1);
    const saved = journaled[0]!.contentHash;
    const transactionHex = (funding.journal() as unknown as { pendingAssetActions: { transactionHex: Hex }[] }).pendingAssetActions[0]!.transactionHex;
    const decoded = decodeTransaction(hexToBytes(transactionHex));
    if (decoded.kind !== TX_KIND_PRIVATE_VALUE) throw new Error("expected a private-value entry");
    assert.equal(sectionPublicInput(decoded, privateValueProfile(decoded.shape).offsets.nativeBurnAmount), quotedBurn);

    // The fee rose past the saved burn: resuming refuses to re-admit, and the
    // journal keeps the escrow and fee note for the saved bytes.
    const raised = Object.assign(Object.create(node) as PcashNodeClient, {
      checkRawTransaction: async () => ({ outcome: "protocolFeeTooLow" }),
      getBlockByHash: async () => ({ hash: hex(recentPcashBlockHash), timestamp: DEADLINE + 100n }),
      getMempoolTransaction: async () => { throw new Error("raised-fee bytes must not be looked up for relay"); },
    });
    await assert.rejects(resumeMarketplaceReclaim({ node: raised, contentHash: saved, transactionHex, pollIntervalMs: 0, pollMaxAttempts: 1 }), ProtocolFeeRaisedError);
    assert.deepEqual(funding.journal().pendingAssetActions!.map((action) => action.contentHash), [saved]);
    // A replacement would need the journaled fee note and the same escrow; the
    // wallet refuses it before signing.
    await assert.rejects(reclaimWith(), /must burn \d+ native PCASH for the protocol fee/);
    assert.deepEqual(funding.journal().pendingAssetActions!.map((action) => action.contentHash), [saved]);

    // Once the fee falls the same bytes are sent again.
    let admitted: Uint8Array | undefined;
    accepted.contentHash = "";
    const fallen = Object.assign(Object.create(node) as PcashNodeClient, {
      checkRawTransaction: async () => ({ outcome: "succeeded" }),
      getBlockByHash: async () => ({ hash: hex(recentPcashBlockHash), timestamp: DEADLINE + 100n }),
    });
    await resumeMarketplaceReclaim({
      node: fallen, contentHash: saved, transactionHex, pollIntervalMs: 0, pollMaxAttempts: 1,
      submitTransaction: async (entry) => { admitted = entry; accepted.contentHash = saved; return { contentHash: saved, receipt: null, queued: true }; },
    });
    assert.equal(bytesToHex(admitted!), transactionHex);
    assert.equal(nativeBurnAmount({ networkFeeAmount: quotedBurn, voluntaryBurnAmount: 0n }), quotedBurn);
  });
}
