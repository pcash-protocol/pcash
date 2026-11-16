import { buildContractBody, functionSelector } from "@pcash/sdk/protocol";
import {
  claimConfigurationCommitment,
  claimKeyCommitment,
  paymentCarrierContextHash,
  reclaimConfigurationCommitment,
} from "../src/commitments.mts";
import {
  BLOCK_HEADER_DOMAIN,
  MERKLE_DEPTH,
  ACCOUNT_KIND_CONTRACT,
  BLOCK_HEADER_KEY_STATE_ROOT,
  STATE_KEY_OUTPUT_ROOT,
  STATE_KEY_OUTPUT_COUNT,
  STATE_KEY_LAG_HIGH128,
  STATE_KEY_ACCOUNT_STATE_ROOT,
  STATE_KEY_ACCOUNT_COUNT,
  STATE_COMMITMENT_DOMAIN,
  TypedCommitmentTree,
  field32,
  fullOutputCommitment,
  ownerCommitment,
  nullifierKeyCommitment,
  receiveKeyHash,
  accountStateCommitment,
  singleLeafProof,
  OUTPUT_DATA_BYTES,
} from "@pcash/sdk/browser";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import { decodeContractBody } from "@pcash/sdk/protocol";
import {
  buildContractFunctionCall,
  type ContractFunctionCallBuild,
} from "@pcash/sdk/builders";
import {
  CLAIM_FUNCTION_SELECTOR,
  CLAIM_APPLICATION_VK_HASH,
  RECLAIM_APPLICATION_VK_HASH,
} from "../src/commitments.mts";
import {
  type ClaimWitnessParams,
  type OfferWitness,
} from "../src/client/claimWitness.ts";
import { createOffer, type Offer } from "../src/offer.mts";

export const PAYMENT_FIXTURE_NETWORK = {
  pcashChainId: 0x50435348n,
  l1ChainId: 11155111n,
  inboxAddress: 0x5043534800000000000000000000000000000000n,
};

const SELLER_PRIVATE_KEY =
  0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80n;
const L2_CONTRACT_NK_ROOT = 0xc0ffeen;
const ESCROW_NOTE_SECRET = 0x99n;
const ESCROW_LEAF_INDEX = 0;
const ACCOUNT_INDEX = 0;
const CLAIM_KEY = 0x1234567890abcdefn;
const RECIPIENT_ADDRESS = 0xabcdn;
const PCASH_AMOUNT = 250_000_000_000_000_000n;
const DUMMY_ENTROPY = 0x7n;
const ROUTER = 0x5fbdb2315678afecb367f032d93f642f64180aa3n;
const SELLER = 0xd0d0n;
const OFFER_ID = 0x0ffe100000000001n;
const ETH_PRICE_WEI = 1_000_000_000_000_000_000n;
const DEADLINE_T = 2_000_000_000n;

export interface ClaimKernelFixture {
  offer: Offer;
  transfer: ContractFunctionCallBuild;
  claim: ClaimWitnessParams;
  outputRoot: bigint;
  accountStateRoot: bigint;
  stateRoot: bigint;
  stateRootHeaderSiblings: bigint[];
  accountStateRootStateSiblings: bigint[];
  recentPcashBlockHash: bigint;
}

export interface SelectedClaimFixtureTerms {
  recipientAddress: bigint;
  receiveKey: Uint8Array;
  privateFeeAmount: bigint;
  issuanceOwnerCommitment: bigint;
  issuanceNoteSecret: bigint;
  transactionContext: bigint;
  validUntilTimestamp: bigint;
}

/**
 * Build a deterministic smart-contract claim that requires the router's carrier context for
 * its payment. The note, account, state, and block-header openings are mutually coherent, and
 * the claim transfer is copied field-for-field from the production transfer builder.
 */
export function buildClaimKernelFixture(selected?: SelectedClaimFixtureTerms): ClaimKernelFixture {
  const terms = {
    router: ROUTER,
    seller: SELLER,
    id: OFFER_ID,
    assetId: 0n,
    amount: PCASH_AMOUNT,
    ethPriceWei: ETH_PRICE_WEI,
    deadlineT: DEADLINE_T,
  };
  const sellerWallet = derivePcashProfileFromPrivateKey(
    field32(SELLER_PRIVATE_KEY),
    PAYMENT_FIXTURE_NETWORK,
  );
  const offer = createOffer({
    network: PAYMENT_FIXTURE_NETWORK,
    terms,
    sellerWallet,
    l2ContractNkRoot: L2_CONTRACT_NK_ROOT,
    claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
    reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
  });

  // Fixed salts make the escrow address, and with it the fixture, deterministic.
  offer.terms = terms;
  offer.claimConfigurationSalt = 0x13n;
  offer.reclaimConfigurationSalt = 0x14n;
  offer.claimConfigurationCommitment = claimConfigurationCommitment(offer.claimConfigurationSalt, terms);
  offer.reclaimConfigurationCommitment = reclaimConfigurationCommitment(offer.reclaimConfigurationSalt, PAYMENT_FIXTURE_NETWORK, sellerWallet.address, terms.id, terms.deadlineT);
  const fixtureContract = buildContractBody({
    nullifierKey: { publishesNkRoot: true, nkRoot: L2_CONTRACT_NK_ROOT }, mlKemPublicKey: offer.l2ContractWallet.mlKemPublicKey,
    functions: [
      { selector: functionSelector(0), applicationVkHash: offer.claimApplicationVkHash, configurationCommitment: offer.claimConfigurationCommitment },
      { selector: functionSelector(1), applicationVkHash: offer.reclaimApplicationVkHash, configurationCommitment: offer.reclaimConfigurationCommitment },
    ],
  });
  offer.l2ContractBody = fixtureContract.body;
  offer.l2ContractAddress = fixtureContract.address;
  offer.functionSetCommitment = fixtureContract.functionSetCommitment;
  offer.l2ContractWallet = { ...offer.l2ContractWallet, address: offer.l2ContractAddress };
  offer.claimFunctionSiblings = fixtureContract.functionSet.membership(functionSelector(0)).siblings.map(BigInt);
  offer.reclaimFunctionSiblings = fixtureContract.functionSet.membership(functionSelector(1)).siblings.map(BigInt);

  const escrowCommitment = fullOutputCommitment(
    {
      owner: offer.l2ContractAddress,
      noteSecret: ESCROW_NOTE_SECRET,
      assetId: 0n,
      amount: terms.amount,
    },
    ESCROW_LEAF_INDEX,
  );
  const noteOpening = singleLeafProof(MERKLE_DEPTH, ESCROW_LEAF_INDEX, escrowCommitment);
  const accountOpening = singleLeafProof(
    MERKLE_DEPTH,
    ACCOUNT_INDEX,
    accountStateCommitment(
      offer.l2ContractAddress,
      nullifierKeyCommitment(offer.l2ContractNkRoot),
      offer.functionSetCommitment,
      ACCOUNT_KIND_CONTRACT,
      1n,
      receiveKeyHash(decodeContractBody(offer.l2ContractBody).mlKemPublicKey!),
    ),
  );
  const stateTree = new TypedCommitmentTree(STATE_COMMITMENT_DOMAIN);
  stateTree.setLeaf(STATE_KEY_OUTPUT_ROOT, noteOpening.root);
  stateTree.setLeaf(STATE_KEY_OUTPUT_COUNT, 1n);
  stateTree.setLeaf(STATE_KEY_LAG_HIGH128, 100000000000000000000n << 64n);
  stateTree.setLeaf(STATE_KEY_ACCOUNT_STATE_ROOT, accountOpening.root);
  stateTree.setLeaf(STATE_KEY_ACCOUNT_COUNT, 1n);
  const stateRoot = stateTree.root;
  const outputRootStateOpening = stateTree.proof(STATE_KEY_OUTPUT_ROOT);
  const accountStateRootStateOpening = stateTree.proof(STATE_KEY_ACCOUNT_STATE_ROOT);
  const headerTree = new TypedCommitmentTree(BLOCK_HEADER_DOMAIN);
  headerTree.setLeaf(BLOCK_HEADER_KEY_STATE_ROOT, stateRoot);
  const recentPcashBlockHash = headerTree.root;
  const stateRootHeaderOpening = headerTree.proof(BLOCK_HEADER_KEY_STATE_ROOT);

  const transfer = buildContractFunctionCall({
    chainId: PAYMENT_FIXTURE_NETWORK.pcashChainId,
    contract: decodeContractBody(offer.l2ContractBody),
    selector: CLAIM_FUNCTION_SELECTOR,
    recipientAddress: RECIPIENT_ADDRESS,
    paymentAmount: terms.amount - (selected?.privateFeeAmount ?? 0n),
    inputs: [{
      amount: terms.amount,
      noteSecret: ESCROW_NOTE_SECRET,
      outputIndex: ESCROW_LEAF_INDEX,
      siblings: noteOpening.siblings,
    }],
    outputRoot: noteOpening.root,
    outputRootStateSiblings: outputRootStateOpening.siblings,
    openFeeAmount: 0n,
    issuanceOwnerCommitment: selected?.issuanceOwnerCommitment ?? 0n,
    ...(selected === undefined ? {} : { designatedIssuanceOpening: {
      recipientAddress: selected.recipientAddress,
      noteSecret: selected.issuanceNoteSecret,
      transactionContext: selected.transactionContext,
    } }),
    ...(selected === undefined ? {} : { secondOutput: {
      address: selected.recipientAddress,
      amount: selected.privateFeeAmount,
      receiveKey: selected.receiveKey,
    } }),
    dummyInputEntropy: DUMMY_ENTROPY,
    validUntilTimestamp: selected?.validUntilTimestamp ?? terms.deadlineT,
    carrierContextHash: paymentCarrierContextHash(terms, claimKeyCommitment(CLAIM_KEY, escrowCommitment)),
    recentPcashBlockHash,
    stateRoot,
    stateRootHeaderSiblings: stateRootHeaderOpening.siblings,
    accountStateRootStateSiblings: accountStateRootStateOpening.siblings,
    accountIndex: ACCOUNT_INDEX,
    accountStateRoot: accountOpening.root,
    accountSiblings: accountOpening.siblings,
    outputEntropies: [1n, 2n, 3n],
    outputData: [
      new Uint8Array(OUTPUT_DATA_BYTES).fill(1),
      selected === undefined ? new Uint8Array(OUTPUT_DATA_BYTES).fill(1) : undefined,
      new Uint8Array(OUTPUT_DATA_BYTES).fill(1),
      new Uint8Array(OUTPUT_DATA_BYTES).fill(1),
      new Uint8Array(OUTPUT_DATA_BYTES).fill(1),
    ],
  });

  const offerWitness: OfferWitness = {
    router: terms.router,
    seller: terms.seller,
    id: terms.id,
    assetId: terms.assetId,
    amount: terms.amount,
    ethPriceWei: terms.ethPriceWei,
    deadlineT: terms.deadlineT,
  };
  const claim: ClaimWitnessParams = {
    recentPcashBlockHash: transfer.recentPcashBlockHash,
    address: transfer.address,
    pcashChainId: PAYMENT_FIXTURE_NETWORK.pcashChainId,
    feePaid: false,
    configurationSalt: offer.claimConfigurationSalt,
    offer: offerWitness,
    claimKey: CLAIM_KEY,
    transaction: transfer.transaction,
    escrowNote: {
      noteSecret: ESCROW_NOTE_SECRET,
      outputIndex: BigInt(ESCROW_LEAF_INDEX),
    },
    payoutOwner: RECIPIENT_ADDRESS,
    payoutNoteSecret: transfer.outputNoteSecrets[0],
    relayFeeAmount: selected?.privateFeeAmount ?? 0n,
    relayFeeOwnerCommitment: selected === undefined ? 0n
      : ownerCommitment(selected.recipientAddress, transfer.outputNoteSecrets[1]!),
  };

  return {
    offer,
    transfer,
    claim,
    outputRoot: noteOpening.root,
    accountStateRoot: accountOpening.root,
    stateRoot,
    stateRootHeaderSiblings: stateRootHeaderOpening.siblings,
    accountStateRootStateSiblings: accountStateRootStateOpening.siblings,
    recentPcashBlockHash,
  };
}
