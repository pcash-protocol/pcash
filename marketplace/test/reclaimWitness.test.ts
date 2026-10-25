import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex } from "viem";
import {
  arenaHash,
  authorizePcashRequestWithPrivateKey,
  DEFAULT_NETWORK_CONFIG,
  deliveryCommitment,
  fieldToHex,
  fullOutputCommitment,
  noteBodyCommitment,
  ownerCommitment,
  OUTPUT_DATA_BYTES,
  outputDataHash,
  poseidon,
  PRIVATE_VALUE_PROFILES,
  privateKeyPcashActionSigner,
  recoverAddress,
  referenceDomainSeparatorHalves,
  REFERENCE_CONFIGURATION_DOMAIN,
  serializeEcdsaSignature,
  SlotClass,
  payoutTransactionContext,
  pcashSigningHash,
  type DesignatedIssuanceOpening,
  type PrivateValue,
} from "@pcash/sdk/browser";
import {
  derivePcashProfileFromSignature,
  profileDerivationSigningRequest,
  type PcashProfile,
} from "@pcash/sdk/wallet";
import {
  buildReclaimWitnessMap,
  marketplaceReclaimPayoutOpeningCommitment,
  marketplaceReclaimTypedData,
  reclaimAuthorizationRequest,
  type MarketplaceReclaimMessage,
  type UnsignedReclaimWitnessParams,
} from "../src/client/reclaimWitness.ts";
import { reclaimConfigurationCommitment } from "../src/commitments.mts";

const RECENT_PCASH_BLOCK_HASH = 33n;
const CONFIGURATION_SALT = 0x44n;
const SELLER_KEY = new Uint8Array(32).fill(7);
const ESCROW_CONTRACT = 0x2222222222222222222222222222222222222222n;
const OFFER_ID = 0x66n;
const ESCROW_SECRET = 35n;
const PAYOUT_SECRET = 37n;
const PAYOUT_AMOUNT = 3n;
const PAYOUT_OPENING_BLINDER = 0x77n;
const NULLIFIERS = [17n, 18n, 19n, 20n];
const COMPENSATION_RECIPIENT = 0x3333333333333333333333333333333333333333n;
const COMPENSATION_SECRET = 0x88n;
const TRANSACTION_CONTEXT = payoutTransactionContext(DEFAULT_NETWORK_CONFIG.pcashChainId, NULLIFIERS);
const OUTPUT_DATA = Array.from({ length: 5 }, (_, slot) => new Uint8Array(OUTPUT_DATA_BYTES).fill(0x21 + slot));
const ARENA = new Uint8Array(PRIVATE_VALUE_PROFILES.S.arenaBytes).fill(0x42);

function designatedOpening(): DesignatedIssuanceOpening {
  return {
    recipientAddress: COMPENSATION_RECIPIENT,
    noteSecret: COMPENSATION_SECRET,
    transactionContext: TRANSACTION_CONTEXT,
  };
}

function designatedCommitment(): bigint {
  return ownerCommitment(COMPENSATION_RECIPIENT, COMPENSATION_SECRET);
}

function sellerProfile(privateKey: Uint8Array = SELLER_KEY): PcashProfile {
  const signer = privateKeyPcashActionSigner(privateKey);
  const request = profileDerivationSigningRequest(DEFAULT_NETWORK_CONFIG, signer.address);
  const authorization = authorizePcashRequestWithPrivateKey(privateKey, request);
  return derivePcashProfileFromSignature(
    serializeEcdsaSignature(authorization),
    DEFAULT_NETWORK_CONFIG,
    signer.address,
  );
}

function fixture(
  profile: PcashProfile,
  issuanceOwnerCommitment = 0n,
  designatedIssuanceOpening?: DesignatedIssuanceOpening,
): UnsignedReclaimWitnessParams {
  const escrowNote = { noteSecret: ESCROW_SECRET, assetId: 0n, amount: PAYOUT_AMOUNT, outputIndex: 0n };
  const transaction: PrivateValue = {
    global: {
      openFeeAmount: 0n, issuanceOwnerCommitment, notBeforeTimestamp: 8n, validUntilTimestamp: 9n, carrierContextHash: 0n, assetBurnAmount: 0n,
      deliveryCommitment: deliveryCommitment(OUTPUT_DATA, ARENA),
    },
    inputs: [
      {
        slotClass: SlotClass.NATIVE,
        inputCommitment: fullOutputCommitment(
          { owner: ESCROW_CONTRACT, ...escrowNote },
          escrowNote.outputIndex,
        ),
        nullifier: 17n,
      },
      { slotClass: SlotClass.DUMMY, inputCommitment: 0n, nullifier: 18n },
      { slotClass: SlotClass.DUMMY, inputCommitment: 0n, nullifier: 19n },
      { slotClass: SlotClass.DUMMY, inputCommitment: 0n, nullifier: 20n },
    ],
    outputs: [
      {
        slotClass: SlotClass.NATIVE,
        outputBodyCommitment: noteBodyCommitment(ownerCommitment(profile.address, PAYOUT_SECRET), 0n, PAYOUT_AMOUNT),
      },
      { slotClass: SlotClass.DUMMY, outputBodyCommitment: 23n },
      { slotClass: SlotClass.DUMMY, outputBodyCommitment: 25n },
      { slotClass: SlotClass.DUMMY, outputBodyCommitment: 27n },
      { slotClass: SlotClass.DUMMY, outputBodyCommitment: 29n },
    ],
  };
  return {
    recentPcashBlockHash: RECENT_PCASH_BLOCK_HASH,
    feePaid: false,
    network: DEFAULT_NETWORK_CONFIG,
    configurationSalt: CONFIGURATION_SALT,
    offerId: OFFER_ID,
    deadlineT: 8n,
    escrowContract: ESCROW_CONTRACT,
    recipient: profile.address,
    sellerProfile: profile,
    transaction,
    outputData: OUTPUT_DATA,
    arena: ARENA,
    escrowNote,
    payoutNoteSecret: PAYOUT_SECRET,
    payoutAmount: PAYOUT_AMOUNT,
    relayFeeAmount: 0n,
    relayFeeOwnerCommitment: 0n,
    payoutOpeningBlinder: PAYOUT_OPENING_BLINDER,
    ...(designatedIssuanceOpening === undefined ? {} : { designatedIssuanceOpening }),
  };
}

function authorization(profile: PcashProfile, params = fixture(profile), key = SELLER_KEY) {
  return authorizePcashRequestWithPrivateKey(key, reclaimAuthorizationRequest(params));
}

test("reclaim witness signs semantic Marketplace terms", () => {
  const profile = sellerProfile();
  const params = fixture(profile);
  const signed = authorization(profile, params);
  const request = reclaimAuthorizationRequest(params);
  const witness = buildReclaimWitnessMap({ ...params, authorization: signed }) as Record<string, any>;

  assert.equal(request.typedData.primaryType, "PcashMarketplaceReclaim");
  assert.deepEqual(request.typedData.message, {
    pcashChainId: DEFAULT_NETWORK_CONFIG.pcashChainId.toString(),
    escrowContract: `0x${ESCROW_CONTRACT.toString(16).padStart(40, "0")}`,
    offerId: fieldToHex(OFFER_ID),
    assetId: "0",
    recipient: `0x${profile.address.toString(16).padStart(40, "0")}`,
    payoutAmount: PAYOUT_AMOUNT.toString(),
    openFeeAmount: "0",
    issuanceRecipient: "0x0000000000000000000000000000000000000000",
    issuanceOwnerCommitment: "0",
    relayFeeAmount: "0",
    relayFeeOwnerCommitment: "0",
    transactionContext: TRANSACTION_CONTEXT.toString(),
    notBefore: "8",
    validUntil: "9",
    payoutOpeningCommitment: fieldToHex(marketplaceReclaimPayoutOpeningCommitment({
      blinder: PAYOUT_OPENING_BLINDER,
      recipient: profile.address,
      payoutNoteSecret: PAYOUT_SECRET,
      outputDataHash: outputDataHash(OUTPUT_DATA[0]!),
      arenaHash: arenaHash(ARENA),
    })),
  });
  assert.deepEqual(witness.output_data_hashes, OUTPUT_DATA.map((item) => fieldToHex(outputDataHash(item))));
  assert.equal(witness.arena_hash, fieldToHex(arenaHash(ARENA)));
  assert.equal(witness.private_value.delivery_commitment, fieldToHex(deliveryCommitment(OUTPUT_DATA, ARENA)));
  assert.equal(witness.recent_pcash_block_hash, fieldToHex(RECENT_PCASH_BLOCK_HASH));
  assert.equal(witness.pcash_chain_id, fieldToHex(DEFAULT_NETWORK_CONFIG.pcashChainId));
  assert.equal(witness.fee_paid, false);
  assert.equal(witness.escrow_contract, fieldToHex(ESCROW_CONTRACT));
  assert.equal(witness.recipient, fieldToHex(profile.address));
  assert.equal(witness.configuration.offer_id, fieldToHex(OFFER_ID));
  assert.equal(witness.issuance_recipient, fieldToHex(0n));
  assert.equal(witness.issuance_note_secret, fieldToHex(0n));
  assert.equal(witness.private_value.issuance_owner_commitment, fieldToHex(0n));
  assert.equal("seller_nk_root" in witness, false);
  assert.deepEqual(witness.signature.signature, Array.from(signed.compact));
  assert.deepEqual(witness.pubkey, { x: Array.from(profile.pubX), y: Array.from(profile.pubY) });
});

test("the payout opening commitment accepts a zero blinder", () => {
  const opening = { blinder: 0n, recipient: 0x1234n, payoutNoteSecret: PAYOUT_SECRET, outputDataHash: 5n, arenaHash: 6n };
  assert.notEqual(
    marketplaceReclaimPayoutOpeningCommitment(opening),
    marketplaceReclaimPayoutOpeningCommitment({ ...opening, blinder: 1n }),
  );
});

test("reclaim witness signs and opens a designated compensation route", () => {
  const profile = sellerProfile();
  const params = fixture(profile, designatedCommitment(), designatedOpening());
  const request = reclaimAuthorizationRequest(params);
  const witness = buildReclaimWitnessMap({ ...params, authorization: authorization(profile, params) }) as Record<string, any>;

  const message = request.typedData.message as Record<string, string>;
  assert.equal(message.issuanceRecipient, `0x${COMPENSATION_RECIPIENT.toString(16)}`);
  assert.equal(message.issuanceOwnerCommitment, designatedCommitment().toString());
  assert.equal(witness.issuance_recipient, fieldToHex(COMPENSATION_RECIPIENT));
  assert.equal(witness.issuance_note_secret, fieldToHex(COMPENSATION_SECRET));
  assert.equal(witness.private_value.issuance_owner_commitment, fieldToHex(designatedCommitment()));
  assert.notEqual(
    bytesToHex(request.digest),
    bytesToHex(reclaimAuthorizationRequest(fixture(profile)).digest),
  );
});

test("reclaim rejects a designated issuance route without its exact opening", () => {
  const profile = sellerProfile();
  assert.throws(
    () => reclaimAuthorizationRequest(fixture(profile, designatedCommitment())),
    /designated issuance requires its authenticated quote opening/,
  );
  assert.throws(
    () => reclaimAuthorizationRequest(fixture(profile, designatedCommitment(), {
      ...designatedOpening(),
      noteSecret: COMPENSATION_SECRET + 1n,
    })),
    /does not match issuanceOwnerCommitment/,
  );
  assert.throws(
    () => reclaimAuthorizationRequest(fixture(profile, 0n, designatedOpening())),
    /open issuance cannot contain a designated recipient opening/,
  );
});

test("an existing reclaim signature is invalid under a different L1 domain", () => {
  const profile = sellerProfile();
  const params = fixture(profile);
  const signed = authorization(profile, params);
  const semantic: MarketplaceReclaimMessage = {
    pcashChainId: DEFAULT_NETWORK_CONFIG.pcashChainId,
    escrowContract: ESCROW_CONTRACT,
    offerId: OFFER_ID,
    assetId: 0n,
    recipient: profile.address,
    payoutAmount: PAYOUT_AMOUNT,
    openFeeAmount: 0n,
    issuanceRecipient: 0n,
    issuanceOwnerCommitment: 0n,
    relayFeeAmount: 0n,
    relayFeeOwnerCommitment: 0n,
    transactionContext: TRANSACTION_CONTEXT,
    notBefore: 8n,
    validUntil: 9n,
    payoutOpeningCommitment: marketplaceReclaimPayoutOpeningCommitment({
      blinder: PAYOUT_OPENING_BLINDER,
      recipient: profile.address,
      payoutNoteSecret: PAYOUT_SECRET,
      outputDataHash: outputDataHash(OUTPUT_DATA[0]!),
      arenaHash: arenaHash(ARENA),
    }),
  };
  const alternateDigest = pcashSigningHash(marketplaceReclaimTypedData(
    { ...DEFAULT_NETWORK_CONFIG, l1ChainId: DEFAULT_NETWORK_CONFIG.l1ChainId + 1n },
    semantic,
  ));
  assert.notEqual(recoverAddress(alternateDigest, { compact: signed.compact, yParity: 0 }), profile.address);
  assert.notEqual(recoverAddress(alternateDigest, { compact: signed.compact, yParity: 1 }), profile.address);
});

test("reclaim configuration commits the seller and the signing domain separator", () => {
  const profile = sellerProfile();
  const params = fixture(profile);
  const witness = buildReclaimWitnessMap({ ...params, authorization: authorization(profile, params) }) as Record<string, any>;
  const separator = referenceDomainSeparatorHalves(DEFAULT_NETWORK_CONFIG);
  assert.deepEqual(witness.configuration, {
    configuration_salt: fieldToHex(CONFIGURATION_SALT),
    offer_id: fieldToHex(OFFER_ID),
    deadline_t: fieldToHex(8n),
    domain_separator_high: fieldToHex(separator.high),
    domain_separator_low: fieldToHex(separator.low),
  });
  assert.equal(
    reclaimConfigurationCommitment(CONFIGURATION_SALT, DEFAULT_NETWORK_CONFIG, profile.address, OFFER_ID, 8n),
    poseidon([REFERENCE_CONFIGURATION_DOMAIN, CONFIGURATION_SALT, profile.address, OFFER_ID, 8n, separator.high, separator.low]),
  );
  assert.notEqual(
    reclaimConfigurationCommitment(
      CONFIGURATION_SALT,
      { ...DEFAULT_NETWORK_CONFIG, l1ChainId: DEFAULT_NETWORK_CONFIG.l1ChainId + 1n },
      profile.address,
      OFFER_ID,
      8n,
    ),
    reclaimConfigurationCommitment(CONFIGURATION_SALT, DEFAULT_NETWORK_CONFIG, profile.address, OFFER_ID, 8n),
  );
});

test("reclaim witness rejects a signature under another signing domain", () => {
  const profile = sellerProfile();
  const params = fixture(profile);
  assert.throws(
    () => buildReclaimWitnessMap({
      ...params,
      network: { ...DEFAULT_NETWORK_CONFIG, l1ChainId: DEFAULT_NETWORK_CONFIG.l1ChainId + 1n },
      authorization: authorization(profile, params),
    }),
    /expected/,
  );
});

test("reclaim rejects a substituted recipient after signing", () => {
  const profile = sellerProfile();
  const params = fixture(profile);
  assert.throws(
    () => buildReclaimWitnessMap({
      ...params,
      recipient: profile.address + 1n,
      authorization: authorization(profile, params),
    }),
    /expected/,
  );
});

test("reclaim rejects substituted payout data or arena after signing", () => {
  const profile = sellerProfile();
  const params = fixture(profile);
  const signed = authorization(profile, params);
  const otherData = [new Uint8Array(OUTPUT_DATA_BYTES).fill(0x7f), ...OUTPUT_DATA.slice(1)];
  for (const changed of [{ outputData: otherData }, { arena: new Uint8Array(PRIVATE_VALUE_PROFILES.S.arenaBytes).fill(0x43) }]) {
    assert.throws(() => buildReclaimWitnessMap({ ...params, ...changed, authorization: signed }), /expected/);
  }
});

test("reclaim witness rejects authorization from another account", () => {
  const profile = sellerProfile();
  const params = fixture(profile);
  const otherKey = new Uint8Array(32).fill(8);
  const otherProfile = sellerProfile(otherKey);
  const otherParams = { ...params, sellerProfile: otherProfile };
  const otherAuthorization = authorization(otherProfile, otherParams, otherKey);
  assert.throws(
    () => buildReclaimWitnessMap({ ...params, authorization: otherAuthorization }),
    /expected/,
  );
});
