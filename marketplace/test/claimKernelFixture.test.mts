import assert from "node:assert/strict";
import test from "node:test";
import { numberToHex } from "viem";
import { createSelectedRelayQuote, privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import { inspectPrivateRelayValue } from "@pcash/sdk/relay";
import { payoutTransactionContext, WIRE_PROOF_BYTES, SlotClass } from "@pcash/sdk/protocol";
import type { StatusResult } from "@pcash/sdk/clients";
import {
  BLOCK_HEADER_DOMAIN,
  BLOCK_HEADER_KEY_STATE_ROOT,
  STATE_COMMITMENT_DOMAIN,
  STATE_KEY_ACCOUNT_STATE_ROOT,
  domainSeparatedRootFromIndex,
  fieldToHex,
  fullOutputCommitment,
  noteBodyCommitment,
  ownerCommitment,
  PRIVATE_VALUE_PROFILES,
} from "@pcash/sdk";
import { buildClaimWitnessMap } from "../src/client/claimWitness.ts";
import { claimKeyCommitment, paymentCarrierContextHash } from "../src/commitments.mts";
import { buildClaimKernelFixture, PAYMENT_FIXTURE_NETWORK } from "./claimKernelFixture.mts";

test("synthetic claim witness matches the kernel bindings", () => {
  const fixture = buildClaimKernelFixture();
  const { transfer, claim } = fixture;

  // The transaction requires the router's context for the note the claim witness spends.
  assert.equal(
    transfer.publicInputs[PRIVATE_VALUE_PROFILES.S.offsets.carrierContextHash],
    paymentCarrierContextHash(claim.offer, claimKeyCommitment(claim.claimKey, fullOutputCommitment({
      owner: claim.address,
      noteSecret: claim.escrowNote.noteSecret,
      assetId: claim.offer.assetId,
      amount: claim.offer.amount,
    }, Number(claim.escrowNote.outputIndex)))),
  );

  assert.equal(claim.recentPcashBlockHash, transfer.recentPcashBlockHash);
  assert.deepEqual(claim.transaction, transfer.transaction);
  assert.equal(transfer.publicInputs[1], fixture.recentPcashBlockHash);
  assert.equal(transfer.publicInputs.length, PRIVATE_VALUE_PROFILES.S.publicInputs);
  assert.equal(
    domainSeparatedRootFromIndex(STATE_COMMITMENT_DOMAIN,
      fixture.accountStateRoot,
      STATE_KEY_ACCOUNT_STATE_ROOT,
      fixture.accountStateRootStateSiblings,
    ),
    fixture.stateRoot,
  );
  assert.equal(
    domainSeparatedRootFromIndex(BLOCK_HEADER_DOMAIN,
      fixture.stateRoot,
      BLOCK_HEADER_KEY_STATE_ROOT,
      fixture.stateRootHeaderSiblings,
    ),
    fixture.recentPcashBlockHash,
  );
});

test("claim inputs carry the issuance route and no reward opening", () => {
  const { claim } = buildClaimKernelFixture();
  const witness = buildClaimWitnessMap(claim) as Record<string, any>;
  assert.equal("reward_note_secret" in witness, false);
  assert.deepEqual(Object.keys(witness.private_value).slice(0, 2), ["open_fee_amount", "issuance_owner_commitment"]);
  assert.equal(witness.private_value.issuance_owner_commitment, fieldToHex(0n));
});

test("selected claim builder pays one decryptable private fee in slot 1", async () => {
  const base = buildClaimKernelFixture();
  const relaySigner = privateKeyPcashActionSigner(new Uint8Array(32).fill(13));
  const receiveKey = base.offer.l2ContractWallet.mlKemPublicKey!;
  const receiveSecretKey = base.offer.l2ContractWallet.mlKemSecretKey!;
  const escrow = base.claim.escrowNote;
  const quoteBinding = claimKeyCommitment(base.claim.claimKey, fullOutputCommitment({
    owner: base.claim.address, noteSecret: escrow.noteSecret, assetId: 0n, amount: base.claim.offer.amount,
  }, Number(escrow.outputIndex)));
  const quote = await createSelectedRelayQuote({
    network: PAYMENT_FIXTURE_NETWORK, pcashChainId: PAYMENT_FIXTURE_NETWORK.pcashChainId,
    recipient: relaySigner.address, nkRoot: 42n, receiveKey, privateFeeAmount: 1n,
    transactionContext: payoutTransactionContext(PAYMENT_FIXTURE_NETWORK.pcashChainId,
      base.transfer.transaction.inputs.map((input) => BigInt(input.nullifier))),
    quoteBinding, maxTransactionBytes: 100_000n, validUntilTimestamp: 2_000n, signer: relaySigner,
  });
  const selected = buildClaimKernelFixture({
    recipientAddress: relaySigner.address, receiveKey, privateFeeAmount: 1n,
    issuanceOwnerCommitment: BigInt(quote.issuanceOwnerCommitment),
    issuanceNoteSecret: BigInt(quote.issuanceNoteSecret),
    transactionContext: BigInt(quote.transactionContext), validUntilTimestamp: 2_000n,
  });
  assert.equal(
    BigInt(selected.transfer.transaction.outputs[0]!.outputBodyCommitment),
    noteBodyCommitment(
      ownerCommitment(selected.claim.payoutOwner, selected.claim.payoutNoteSecret),
      0n,
      base.claim.offer.amount - selected.claim.relayFeeAmount,
    ),
  );
  assert.equal(selected.transfer.transaction.outputs[1]!.slotClass, SlotClass.NATIVE);
  assert(selected.transfer.transaction.outputs.slice(2).every((output) => output.slotClass === SlotClass.DUMMY));
  const entry = selected.transfer.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES));
  const status = { pcashChainId: Number(PAYMENT_FIXTURE_NETWORK.pcashChainId),
    l1ChainId: PAYMENT_FIXTURE_NETWORK.l1ChainId,
    inboxAddress: numberToHex(PAYMENT_FIXTURE_NETWORK.inboxAddress, { size: 20 }),
    latestBlockTimestamp: 1_000n } as StatusResult;
  const payment = inspectPrivateRelayValue({
    transactionBytes: entry, status, recipient: {
      address: relaySigner.address, nkRoot: 42n,
      mlKemSecretKey: receiveSecretKey,
    },
  });
  assert.deepEqual(payment.nativeOutputSlots, [1]);
  assert.equal(payment.nativeAmount, 1n);
  assert.equal(payment.issuanceOwnerCommitment, BigInt(quote.issuanceOwnerCommitment));
  assert.notEqual(selected.claim.relayFeeOwnerCommitment, BigInt(quote.issuanceOwnerCommitment));
});
