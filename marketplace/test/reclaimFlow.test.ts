import { restoredSellerPublication } from "./recoveredPublication.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Noir } from "@noir-lang/noir_js";
import { bytesToHex, hexToBytes, keccak256, numberToHex } from "viem";
import { decodeContractBody, WIRE_PROOF_BYTES } from "@pcash/sdk/protocol";
import { createSelectedRelayQuote } from "@pcash/sdk/eip712";
import { inspectPrivateRelayValue } from "@pcash/sdk/relay";
import {
  authorizationCommitment,
  authorizePcashRequestWithPrivateKey,
  addressHex,
  BLOCK_HEADER_DOMAIN,
  DEFAULT_NETWORK_CONFIG,
  MERKLE_DEPTH,
  ACCOUNT_KIND_CONTRACT,
  BLOCK_HEADER_KEY_STATE_ROOT,
  STATE_KEY_ACCOUNT_STATE_ROOT,
  SparseMerkleTree,
  TypedCommitmentTree,
  decodeTransaction,
  fieldToHex,
  fullOutputCommitment,
  nullifierKeyCommitment,
  noteBodyCommitment,
  ownerCommitment,
  PRIVATE_VALUE_PROFILES,
  privateValuePublicInputs,
  privateKeyPcashActionSigner,
  accountStateCommitment,
  receiveKeyHash,
  serializeEcdsaSignature,
  stateTree,
  privateValueCommitment,
  ruleStatement,
  transferActionCommitment,
  type PrivateValue,
  type PcashNodeClient,
  type StatusResult,
} from "@pcash/sdk/browser";
import { decryptEnvelope, decodePayload, generateMlKemKeyPair } from "@pcash/sdk/protocol";
import {
  derivePcashProfileFromSignature,
  profileDerivationSigningRequest,
  type PcashProfile,
} from "@pcash/sdk/wallet";
import {
  CLAIM_APPLICATION_VK_HASH,
  RECLAIM_APPLICATION_VK_HASH,
} from "../src/commitments.mts";
import { createOffer } from "../src/offer.mts";
import { publicationFromOffer } from "../src/client/publication.ts";
import { isStaleTransactionAnchorError } from "../src/client/mempoolSubmission.ts";
import { anchoredPrivateValueTransaction } from "./anchoredTransaction.ts";
import { selectedRelayTransactionExpiry } from "../src/client/selectedRelayExpiry.ts";
import {
  deriveMarketplaceReclaimDummyEntropy,
  reclaimMarketplaceOffer,
  readMarketplaceReclaimFinality,
  readReclaimStateSnapshot,
  resumeMarketplaceReclaim,
} from "../src/client/reclaimFlow.ts";

const hash = `0x${"11".repeat(32)}`;
const ANCHOR = 0x5151n;
const LATEST_TIMESTAMP = 10_000n;
const NODE_STATUS = {
  pcashChainId: Number(DEFAULT_NETWORK_CONFIG.pcashChainId),
  l1ChainId: DEFAULT_NETWORK_CONFIG.l1ChainId,
  inboxAddress: addressHex(DEFAULT_NETWORK_CONFIG.inboxAddress),
  acceptedTransactionTypes: [0, 1, 2, 3],
  acceptedBatchVersions: [1],
  latestBlockTimestamp: LATEST_TIMESTAMP,
} as const;

test("selected reclaim expiry honors a stricter advertised relayer lifetime", () => {
  const provider = { recipient: 0x123n, requestQuote: async () => { throw new Error("no quote needed"); },
    maxQuoteLifetimeSeconds: 600n };
  assert.equal(selectedRelayTransactionExpiry(LATEST_TIMESTAMP, (1n << 64n) - 1n, provider, "reclaim"), LATEST_TIMESTAMP + 600n);
  assert.equal(selectedRelayTransactionExpiry(LATEST_TIMESTAMP, (1n << 64n) - 1n,
    { ...provider, maxQuoteLifetimeSeconds: 10_000n }, "reclaim"), LATEST_TIMESTAMP + 3600n);
  assert.throws(() => selectedRelayTransactionExpiry(LATEST_TIMESTAMP, LATEST_TIMESTAMP,
    provider, "reclaim"), /selected reclaim transaction expires/);
});

function sellerActor(byte: number): {
  profile: PcashProfile;
  signer: ReturnType<typeof privateKeyPcashActionSigner>;
} {
  const privateKey = new Uint8Array(32).fill(byte);
  const signer = privateKeyPcashActionSigner(privateKey);
  const request = profileDerivationSigningRequest(DEFAULT_NETWORK_CONFIG, signer.address);
  const authorization = authorizePcashRequestWithPrivateKey(privateKey, request);
  return {
    signer,
    profile: derivePcashProfileFromSignature(
      serializeEcdsaSignature(authorization),
      DEFAULT_NETWORK_CONFIG,
      signer.address,
    ),
  };
}

test("reclaim dummy entropy is stable, private, and bound to seller and offer identity", () => {
  const seller = sellerActor(7).profile;
  const input = { seller, chainId: 1346589512n, offerId: 0x1234n, contractAddress: 0xabcdn };
  const entropy = deriveMarketplaceReclaimDummyEntropy(input);
  assert.equal(deriveMarketplaceReclaimDummyEntropy(input), entropy);
  assert.ok(entropy > 0n);
  const otherSeller = sellerActor(8).profile;
  assert.notEqual(deriveMarketplaceReclaimDummyEntropy({ ...input, seller: otherSeller }), entropy);
  assert.notEqual(deriveMarketplaceReclaimDummyEntropy({ ...input, offerId: input.offerId + 1n }), entropy);
  assert.notEqual(
    deriveMarketplaceReclaimDummyEntropy({ ...input, contractAddress: input.contractAddress + 1n }),
    entropy,
  );
});

function snapshotNode(liveHead = 100n): PcashNodeClient {
  const boundary = {
    header: { number: 100n, stateRoot: 0x50n },
    blockHash: 0x10n,
  };
  const fixture = {
    getBlockHeader: async () => ({
      recentPcashBlockHash: 0x10n,
      boundary,
    }),
    getOutputPath: async () => ({
      leafIndex: 3n,
      root: "0x30",
      count: 4n,
      siblings: Array(40).fill("0x0"),
      boundary,
    }),
    getAccountProof: async () => ({
      status: "present",
      account: { index: 7n },
      accountStateRoot: 0x40n,
      accountSiblings: Array(40).fill(0n),
      accountCount: 8n,
      stateRootHeaderSiblings: Array(4).fill(0n),
      accountStateRootStateSiblings: Array(4).fill(0n),
      boundary,
    }),
  };
  return {
    getWitnessSnapshot: async (request: { accounts: string[]; outputs: { outputIndex: number }[]; l1Logs?: unknown[] }) => {
      assert.equal(request.accounts.length, 1);
      assert.equal(request.outputs[0]!.outputIndex, 3);
      const output = await fixture.getOutputPath();
      return {
        blockHeader: await fixture.getBlockHeader(),
        accounts: [await fixture.getAccountProof()],
        outputs: { ...output, boundary, paths: [{ outputIndex: 3n, siblings: output.siblings }] },
      };
    },
    status: async () => ({ latestBlock: liveHead }),
    getBlockHeader: async () => { throw new Error("independent latest read"); },
    getOutputPath: async () => { throw new Error("independent latest read"); },
    getAccountProof: async () => { throw new Error("independent latest read"); },
  } as unknown as PcashNodeClient;
}

test("reclaim grounding accepts note and account paths from one snapshot", async () => {
  const snapshot = await readReclaimStateSnapshot({
    node: snapshotNode(),
    escrowLeafIndex: 3,
    l2ContractAddress: 0x123n,
    escrowOutputCommitment: 0x99n,
    maxAttempts: 1,
  });
  assert.equal(snapshot.recentPcashBlockHash, 0x10n);
  assert.equal(snapshot.outputPath.root, "0x30");
  assert.equal(snapshot.accountProof.accountStateRoot, 0x40n);
});

test("reclaim grounding uses the atomic snapshot when the live head advances", async () => {
  await readReclaimStateSnapshot({
    node: snapshotNode(101n),
    escrowLeafIndex: 3,
    l2ContractAddress: 0x123n,
    escrowOutputCommitment: 0x99n,
    pollIntervalMs: 0,
    maxAttempts: 1,
  });
});

test("durable reclaim state distinguishes accepted from finalized", async () => {
  const node = {
    getReceipt: async () => [{
      transactionId: `0x${"e1".repeat(32)}`,
      outcome: "succeeded",
      failureDetail: null,
      l1Sender: "0x0000000000000000000000000000000000000000",
      issuanceOwnerCommitment: null,
      settledOpenFeeAmount: 0n,
      settledIssuanceAmount: 0n,
      contentHash: hash,
      kind: "privateValue",
      inclusion: { l1BlockNumber: 100n, l1BlockHash: hash },
      outputLeafStart: 42n,
    }],
    status: async () => ({ finalizedL1BlockNumber: 99n }),
  } as unknown as PcashNodeClient;
  assert.equal((await readMarketplaceReclaimFinality(node, hash)).phase, "accepted");
  (node.status as unknown as () => Promise<unknown>) = async () => ({ finalizedL1BlockNumber: 100n });
  assert.equal((await readMarketplaceReclaimFinality(node, hash)).phase, "finalized");
});

test("reclaim resume re-admits the exact checkpointed bytes to the mempool", async () => {
  const entry = anchoredPrivateValueTransaction(ANCHOR, 2n);
  const transactionHex = bytesToHex(entry);
  const contentHash = keccak256(transactionHex);
  const events: string[] = [];
  let receiptReads = 0;
  const node = {
    status: async () => NODE_STATUS,
    getBlockByHash: async () => ({ hash: numberToHex(ANCHOR, { size: 32 }), timestamp: LATEST_TIMESTAMP - 1n }),
    getReceipt: async () => {
      events.push("receipt");
      receiptReads += 1;
      if (receiptReads === 1) return [];
      return [{
        transactionId: `0x${"e1".repeat(32)}`,
        outcome: "succeeded",
        failureDetail: null,
        l1Sender: "0x0000000000000000000000000000000000000000",
        issuanceOwnerCommitment: null,
        settledOpenFeeAmount: 0n,
        settledIssuanceAmount: 0n,
        contentHash,
        kind: "privateValue",
        inclusion: { l1BlockNumber: 100n, l1BlockHash: hash },
        outputLeafStart: 42n,
      }];
    },
    getMempoolTransaction: async () => null,
  } as unknown as PcashNodeClient;

  const result = await resumeMarketplaceReclaim({
    node,
    contentHash,
    transactionHex,
    pollIntervalMs: 0,
    pollMaxAttempts: 1,
    submitTransaction: async (submitted) => {
      events.push("admit");
      assert.equal(bytesToHex(submitted), transactionHex);
      return { contentHash, receipt: null, queued: true };
    },
  });
  assert.equal(result.contentHash, contentHash);
  assert.deepEqual(events, ["receipt", "admit", "receipt"]);
});

test("reclaim resume refuses saved bytes whose anchor aged out of the recent-block window", async () => {
  const entry = anchoredPrivateValueTransaction(ANCHOR, 3n);
  const transactionHex = bytesToHex(entry);
  const contentHash = keccak256(transactionHex);
  const node = {
    status: async () => NODE_STATUS,
    getReceipt: async () => [],
    getBlockByHash: async () => ({ hash: numberToHex(ANCHOR, { size: 32 }), timestamp: LATEST_TIMESTAMP - 3_601n }),
    getMempoolTransaction: async () => { throw new Error("stale bytes must not be probed"); },
  } as unknown as PcashNodeClient;

  await assert.rejects(
    resumeMarketplaceReclaim({
      node,
      contentHash,
      transactionHex,
      submitTransaction: async () => { throw new Error("stale bytes must not be admitted"); },
    }),
    (error: unknown) => isStaleTransactionAnchorError(error) && error.contentHash === contentHash && error.reason === "expired",
  );
});

function transactionFromWitness(witnessed: Record<string, any>): PrivateValue {
  return {
    global: {
      openFeeAmount: BigInt(witnessed.open_fee_amount),
      issuanceOwnerCommitment: BigInt(witnessed.issuance_owner_commitment),
      notBeforeTimestamp: BigInt(witnessed.not_before_timestamp),
      validUntilTimestamp: BigInt(witnessed.valid_until_timestamp),
      carrierContextHash: BigInt(witnessed.carrier_context_hash),
      assetBurnAmount: BigInt(witnessed.asset_burn_amount),
      deliveryCommitment: BigInt(witnessed.delivery_commitment),
      accountCreationCommitment: 0n,
    },
    inputs: witnessed.input_slot_classes.map((slotClass: string, index: number) => ({
      slotClass: Number(BigInt(slotClass)),
      inputCommitment: BigInt(witnessed.input_commitments[index]),
      nullifier: BigInt(witnessed.nullifiers[index]),
    })) as PrivateValue["inputs"],
    outputs: witnessed.output_slot_classes.map((slotClass: string, index: number) => ({
      slotClass: Number(BigInt(slotClass)),
      outputBodyCommitment: BigInt(witnessed.output_body_commitments[index]),
    })) as PrivateValue["outputs"],
  };
}

for (const privateRelayFeeAmount of [0n, 1n]) for (const mockProof of [false, true]) {
test(`${mockProof ? "rotated payout reclaim with mock proof" : "browser reclaim proves"} ${privateRelayFeeAmount === 0n ? "open" : "selected"} escrow release and checkpoints exact bytes`, async () => {
  const chainId = DEFAULT_NETWORK_CONFIG.pcashChainId;
  const actor = sellerActor(7);
  const seller = actor.profile;
  const registeredKey = generateMlKemKeyPair(new Uint8Array(64).fill(63));
  const deadlineT = 4_000_000_000n;
  const amount = 100n;
  const offer = createOffer({
    network: { ...DEFAULT_NETWORK_CONFIG, pcashChainId: chainId },
    terms: {
      router: 0xaan,
      seller: seller.address,
      assetId: 0n,
      amount: amount,
      ethPriceWei: 2n,
      deadlineT,
    },
    sellerWallet: seller,
    l2ContractNkRoot: 0xc0ffeen,
    claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
    reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
  });
  const leafIndex = 3;
  const noteSecret = 0xbeefn;
  const noteTree = new SparseMerkleTree(MERKLE_DEPTH);
  noteTree.setLeaf(leafIndex, fullOutputCommitment(
    { owner: offer.l2ContractAddress, noteSecret, assetId: 0n, amount },
    leafIndex,
  ));
  const noteProof = noteTree.proof(leafIndex);
  const accountIndex = 2;
  const accountStateTree = new SparseMerkleTree(MERKLE_DEPTH);
  accountStateTree.setLeaf(accountIndex, accountStateCommitment(
    offer.l2ContractAddress,
    nullifierKeyCommitment(offer.l2ContractNkRoot),
    offer.functionSetCommitment,
    ACCOUNT_KIND_CONTRACT,
    1n,
    receiveKeyHash(decodeContractBody(offer.l2ContractBody).mlKemPublicKey!),
  ));
  const accountProof = accountStateTree.proof(accountIndex);
  const boundaryState = {
    outputRoot: noteTree.root,
    outputCount: BigInt(leafIndex + 1),
    issuedSoFar: 0n,
    lagQ: 0n,
    accountStateRoot: accountStateTree.root,
    accountCount: BigInt(accountIndex + 1),
    nullifierRoot: 0n,
    nullifierCount: 0n,
  };
  const committedStateTree = stateTree(boundaryState);
  const stateAccountProof = committedStateTree.proof(STATE_KEY_ACCOUNT_STATE_ROOT);
  const stateRoot = committedStateTree.root;
  const headerTree = new TypedCommitmentTree(BLOCK_HEADER_DOMAIN);
  headerTree.setLeaf(BLOCK_HEADER_KEY_STATE_ROOT, stateRoot);
  const headerStateProof = headerTree.proof(BLOCK_HEADER_KEY_STATE_ROOT);
  const recentPcashBlockHash = headerTree.root;
  const publication = publicationFromOffer(offer);
  publication.escrow = {
    leafIndex,
    noteSecret: fieldToHex(noteSecret),
    amount: fieldToHex(amount),
  };
  const boundary = {
    header: { number: 100n, stateRoot },
    state: boundaryState,
    blockHash: recentPcashBlockHash,
  };
  let acceptedContentHash = "";
  const node = {
    async getWitnessSnapshot(this: PcashNodeClient, request: { accounts: string[] }) {
      const output = (await this.getOutputPath(leafIndex, 0n))!;
      return {
        blockHeader: await this.getBlockHeader("latest"),
        accounts: [await this.getAccountProof(request.accounts[0]!)],
        outputs: { ...output, paths: [{ outputIndex: BigInt(leafIndex), siblings: output.siblings }] },
      };
    },
    status: async () => ({ ...NODE_STATUS,
      latestBlockTimestamp: privateRelayFeeAmount === 0n ? LATEST_TIMESTAMP : deadlineT + 1n }),
    getBlockHeader: async () => ({
      recentPcashBlockHash,
      boundary,
    }),
    getOutputPath: async () => ({
      leafIndex: BigInt(leafIndex),
      root: fieldToHex(noteProof.root),
      count: BigInt(leafIndex + 1),
      siblings: noteProof.siblings.map(fieldToHex),
      boundary,
    }),
    getAccountProof: async (address: string) =>
      BigInt(address) === seller.address
        ? { status: "notFound", address, authenticated: false }
        : {
            status: "present",
            account: { index: BigInt(accountIndex) },
            accountStateRoot: accountProof.root,
            accountSiblings: accountProof.siblings,
            accountCount: BigInt(accountIndex + 1),
            stateRootHeaderSiblings: headerStateProof.siblings.map(fieldToHex),
            accountStateRootStateSiblings: stateAccountProof.siblings.map(fieldToHex),
            boundary,
          },
    getReceipt: async (query: { contentHash: string }) => query.contentHash === acceptedContentHash && acceptedContentHash !== "" ? [{
      transactionId: `0x${"e1".repeat(32)}`,
      outcome: "succeeded",
      failureDetail: null,
      l1Sender: "0x0000000000000000000000000000000000000000",
      issuanceOwnerCommitment: null,
      settledOpenFeeAmount: 0n,
      settledIssuanceAmount: 0n,
      contentHash: acceptedContentHash,
      kind: "privateValue",
      inclusion: { l1BlockNumber: 101n, l1BlockHash: hash },
      outputLeafStart: 42n,
    }] : [],
  } as unknown as PcashNodeClient;
  const events: string[] = [];
  let checkpointed = false;
  const openFeeAmount = privateRelayFeeAmount === 0n ? 10n : 0n;
  const netAmount = amount - openFeeAmount - privateRelayFeeAmount;
  const relaySigner = privateKeyPcashActionSigner(new Uint8Array(32).fill(19));
  let selectedQuote: Awaited<ReturnType<typeof createSelectedRelayQuote>> | undefined;
  let expectedRelayOwnerCommitment = 0n;
  const selectedRelay = privateRelayFeeAmount === 0n ? undefined : {
    privateFeeAmount: privateRelayFeeAmount,
    provider: {
      recipient: relaySigner.address,
      maxQuoteLifetimeSeconds: 600n,
      requestQuote: async (request: Parameters<import("@pcash/sdk/eip712").SelectedRelayQuoteProvider["requestQuote"]>[0]) => {
        selectedQuote = await createSelectedRelayQuote({ ...request,
          network: DEFAULT_NETWORK_CONFIG, nkRoot: 19n, receiveKey: seller.mlKemPublicKey!, signer: relaySigner });
        return selectedQuote;
      },
    },
  };

  const result = await reclaimMarketplaceOffer({
    node,
    offer: await restoredSellerPublication(offer, publication, seller),
    sellerProfile: seller,
    sellerReceiveKey: async (root) => { assert.equal(root, accountProof.root); return registeredKey.publicKey; },
    sellerSigner: {
      address: actor.signer.address,
      signTypedData: async (request) => {
        events.push("authorize");
        assert.equal(request.kind, "marketplace-reclaim");
        assert.equal(request.typedData.primaryType, "PcashMarketplaceReclaim");
        assert.equal((request.typedData.message as Record<string, string>).recipient, addressHex(seller.address));
        assert.equal((request.typedData.message as Record<string, string>).payoutAmount, netAmount.toString());
        assert.equal((request.typedData.message as Record<string, string>).openFeeAmount, openFeeAmount.toString());
        assert.equal((request.typedData.message as Record<string, string>).relayFeeAmount, privateRelayFeeAmount.toString());
        return actor.signer.signTypedData(request);
      },
    },
    readL1Timestamp: async () => deadlineT + 1n,
    openFeeAmount,
    ...(selectedRelay === undefined ? {} : { selectedRelay }),
    prover: {
      proveUserAccountUpdate: async () => { throw new Error("account-update prover must not run"); },
      proveAssetAction: async () => { throw new Error("native reclaim does not prove an asset action"); },
      proveTransfer: async (args) => {
        events.push("prove reclaim circuit");
        assert.equal(args.authorizationCircuitUrl, "/prover/contracts/escrow/reclaim.json");
        assert.equal(args.authorizationLabel, "reclaim circuit");
        assert.equal(args.expectedPublicInputs.length, PRIVATE_VALUE_PROFILES.S.publicInputs);
        assert.equal(
          (args.authorizationWitnessMap.private_value as Record<string, unknown>).open_fee_amount,
          fieldToHex(openFeeAmount),
        );
        assert.equal(
          BigInt((args.authorizationWitnessMap.private_value as Record<string, unknown>).issuance_owner_commitment as string) === 0n,
          privateRelayFeeAmount === 0n,
        );
        assert.equal(
          (args.authorizationWitnessMap.private_value as Record<string, any>).output_body_commitments[0],
          fieldToHex(noteBodyCommitment(
            ownerCommitment(seller.address, BigInt(args.authorizationWitnessMap.payout_note_secret as string)),
            0n,
            netAmount,
          )),
        );
        assert.equal(args.authorizationWitnessMap.relay_fee_amount, fieldToHex(privateRelayFeeAmount));
        if (privateRelayFeeAmount !== 0n) {
          expectedRelayOwnerCommitment = BigInt(args.authorizationWitnessMap.relay_fee_owner_commitment as string);
          assert.equal(BigInt((args.authorizationWitnessMap.private_value as Record<string, any>).output_slot_classes[1]), 1n);
          assert((args.authorizationWitnessMap.private_value as Record<string, any>).output_slot_classes.slice(2).every((value: string) => BigInt(value) === 0n));
        }
        assert.equal(args.authorizationWitnessMap.recent_pcash_block_hash, fieldToHex(recentPcashBlockHash));
        assert.equal(args.authorizationWitnessMap.pcash_chain_id, fieldToHex(chainId));
        assert.equal(args.authorizationWitnessMap.fee_paid, false);
        assert.equal(args.expectedPublicInputs[PRIVATE_VALUE_PROFILES.S.offsets.openFeeAmount], openFeeAmount);
        assert.equal(args.expectedPublicInputs[PRIVATE_VALUE_PROFILES.S.offsets.issuanceOwner] === 0n, privateRelayFeeAmount === 0n);
        if (mockProof) return { proof: new Uint8Array(WIRE_PROOF_BYTES), publicInputs: args.expectedPublicInputs.map(fieldToHex) };
        const circuitBundle = process.env.PCASH_CIRCUIT_BUNDLE?.trim();
        if (!circuitBundle) throw new Error("PCASH_CIRCUIT_BUNDLE is required for marketplace circuit tests");
        const artifact = JSON.parse(readFileSync(
          join(circuitBundle, "prover-assets", "contracts", "escrow", "reclaim.json"),
          "utf8",
        )) as ConstructorParameters<typeof Noir>[0];
        const mutated = (
          mutate: (map: Record<string, any>) => void,
        ): Record<string, unknown> => {
          const map = structuredClone(args.authorizationWitnessMap) as Record<string, any>;
          mutate(map);
          return map;
        };
        const substitutedSecret = BigInt(args.authorizationWitnessMap.payout_note_secret as string) + 1n;
        const changedOpening = mutated((map) => {
          map.payout_note_secret = fieldToHex(substitutedSecret);
          map.private_value.output_body_commitments[0] = fieldToHex(noteBodyCommitment(
            ownerCommitment(seller.address, substitutedSecret),
            0n,
            netAmount,
          ));
        });
        // The seller signed the payout opening, which commits the payout owner.
        await assert.rejects(
          new Noir(artifact).execute(changedOpening as Parameters<Noir["execute"]>[0]),
          /signature must be valid/,
        );
        for (const changedDelivery of [
          mutated((map) => { map.output_data_hashes[0] = fieldToHex(BigInt(map.output_data_hashes[0]) + 1n); }),
          mutated((map) => { map.arena_hash = fieldToHex(BigInt(map.arena_hash) + 1n); }),
        ]) {
          await assert.rejects(
            new Noir(artifact).execute(changedDelivery as Parameters<Noir["execute"]>[0]),
            /output data hashes and arena hash must open the delivery commitment/,
          );
        }
        await assert.rejects(new Noir(artifact).execute({
          ...(args.authorizationWitnessMap as Record<string, unknown>),
          recipient: fieldToHex(seller.address + 1n),
        } as unknown as Parameters<Noir["execute"]>[0]));
        const { returnValue } = await new Noir(artifact).execute(
          args.authorizationWitnessMap as unknown as Parameters<Noir["execute"]>[0],
        );
        // The kernel requires exactly this statement: the escrow account under its committed reclaim configuration.
        assert.deepEqual((returnValue as string[]).map(BigInt), [...ruleStatement(
          authorizationCommitment(
            offer.l2ContractAddress,
            offer.reclaimConfigurationCommitment,
          ),
          transferActionCommitment(chainId, privateValueCommitment(transactionFromWitness(
            args.authorizationWitnessMap.private_value as Record<string, any>,
          ))),
          recentPcashBlockHash,
        )]);
        return { proof: new Uint8Array(WIRE_PROOF_BYTES), publicInputs: args.expectedPublicInputs.map(fieldToHex) };
      },
    },
    onPrepared: (contentHash, transactionHex) => {
      events.push("checkpoint");
      assert.equal(keccak256(transactionHex), contentHash);
      checkpointed = true;
    },
    submitTransaction: async (entry: Uint8Array) => {
      events.push("admit");
      assert.equal(checkpointed, true);
      const decoded = decodeTransaction(entry);
      if (decoded.kind !== 0) throw new Error("reclaim must use the privateValue transaction type");
      assert.equal(privateValuePublicInputs(decoded).length, PRIVATE_VALUE_PROFILES.S.publicInputs);
      assert.equal(decryptEnvelope(seller.mlKemSecretKey, decoded.outputData[0]!), null);
      const payout = decryptEnvelope(registeredKey.secretKey, decoded.outputData[0]!);
      assert.ok(payout);
      assert.equal(decodePayload(payout, { chainId }).amount, netAmount);
      if (selectedQuote !== undefined) {
        const payment = inspectPrivateRelayValue({ transactionBytes: entry,
          status: await node.status() as StatusResult,
          recipient: {
            address: relaySigner.address,
            nkRoot: 19n, mlKemSecretKey: seller.mlKemSecretKey!,
          },
        });
        assert.deepEqual(payment.nativeOutputSlots, [1]);
        assert.equal(payment.nativeAmount, privateRelayFeeAmount);
        assert.equal(payment.issuanceOwnerCommitment, BigInt(selectedQuote.issuanceOwnerCommitment));
        assert.notEqual(expectedRelayOwnerCommitment, payment.issuanceOwnerCommitment);
      }
      acceptedContentHash = keccak256(entry);
      return { contentHash: acceptedContentHash, receipt: null, queued: true };
    },
    pollIntervalMs: 0,
    pollMaxAttempts: 1,
  });

  assert.equal(result.contentHash, acceptedContentHash);
  assert.equal(keccak256(result.transactionHex), result.contentHash);
  assert.deepEqual(events, ["authorize", "prove reclaim circuit", "checkpoint", "admit"]);
});
}
