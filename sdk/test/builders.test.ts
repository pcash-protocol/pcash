// Witness builders: the derived public inputs and the recovered
// account signer must be internally coherent (independent of the prover).

import { PCASH_CHAIN_ID } from "../src/constants/networkProfile.ts";
import { describe, expect, it } from "vitest";
import { fieldToHex } from "../src/crypto/field.ts";
import { deliveryCommitment } from "../src/protocol/transfer.ts";
import {
  buildUserAccountCreation,
  buildDirectReferenceUserAccountCreation,
  prepareUserAccountCreation,
  buildReferenceUserAccountCreation,
  buildNativeTransfer,
  defaultEcdsaRuleSet,
} from "../src/builders/index.ts";
import { deriveTestWallet, testAuthorizationResolver } from "./testWallet.ts";
import { privateValueCommitment } from "../src/protocol/transaction.ts";
import { authorizationCommitment, ruleStatement, transferActionCommitment } from "../src/protocol/statement.ts";
import {
  dummyNullifier,
  fullOutputCommitment,
  noteNk,
  nullifier,
  nullifierKeyCommitment,
} from "../src/protocol/notes.ts";
import { VK_LEN, computeCircuitVkHash, accountStateCommitment } from "../src/protocol/account.ts";
import { ecdsaRuleConfigurationCommitment } from "../src/rules/referenceRules.ts";
import { recoverAddress } from "../src/eip712/eip712.ts";
import { bytesEqual, bytesToBigInt } from "../src/utils/bytes.ts";
import { MERKLE_DEPTH } from "../src/constants/params.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { syntheticRecentBlockOpenings, TEST_DEFAULT_RULE_SECRETS, transferFixture } from "@pcash/test-support/protocol-fixtures";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { ENVELOPE_VERSION } from "../src/protocol/envelope.ts";
import { OUTPUT_DATA_BYTES } from "../src/constants/params.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";

const chainId = PCASH_CHAIN_ID;
const wallet = deriveTestWallet();
// The slot-0 note belongs to this address, and the default payment rule signs it.
const recipientAddress = 0x1234567890123456789012345678901234567890n;

function outputEnvelope(fill: number): Uint8Array {
  const output = new Uint8Array(OUTPUT_DATA_BYTES).fill(fill);
  output[0] = ENVELOPE_VERSION;
  return output;
}

describe("buildNativeTransfer coherence (default ECDSA rules)", () => {
  const fixture = transferFixture({
    chainId,
    wallet,
    recipientAddress,
    inputAmount: 1250500n,
    paymentAmount: 1000000n,
    openFeeAmount: 500n,
    issuanceOwnerCommitment: 0n,
    dummyInputEntropy: 42n,
    validUntilTimestamp: 9999999n,
    noteSecret: 0xdeadbeefcafe01n,
  });
  const build = buildNativeTransfer(fixture);

  it("emits the 18 public inputs with chainId and the recent block hash", () => {
    expect(build.publicInputs).toHaveLength(18);
    expect(build.publicInputs[0]).toBe(chainId);
    expect(build.publicInputs[1]).not.toBe(0n);
    // nullifiers 0..3 (index 2..5): first real, rest dummy, all distinct.
    const nulls = build.publicInputs.slice(2, 6);
    expect(new Set(nulls.map(String)).size).toBe(4);
    // Input 11 is the delivery commitment; 12–15 bind open fee, issuance, and the validity window.
    expect(build.publicInputs[11]).toBe(deliveryCommitment(build.outputData, build.arena));
    expect(build.transaction.global.deliveryCommitment).toBe(build.publicInputs[11]);
    expect(build.publicInputs[12]).toBe(500n); // openFeeAmount
    expect(build.publicInputs[13]).toBe(0n); // issuanceOwnerCommitment
    expect(build.publicInputs[14]).toBe(0n); // notBeforeTimestamp
    expect(build.publicInputs[15]).toBe(9999999n); // validUntilTimestamp
    expect(build.publicInputs[16]).toBe(0n); // carrierContextHash: any delivery
  });

  it("binds a requested carrier context into the statement, the commitment, and the kernel choices", () => {
    const carrierContextHash = 0x0bad5eedn;
    const bound = buildNativeTransfer({ ...fixture, carrierContextHash });
    const { offsets } = PRIVATE_VALUE_PROFILES.S;
    expect(bound.publicInputs[offsets.carrierContextHash]).toBe(carrierContextHash);
    expect(bound.publicInputs.at(-1)).toBe(bound.eventOpening.eventsCommitment);
    expect(bound.transaction.global.carrierContextHash).toBe(carrierContextHash);
    expect(bound.privateValueCommitment).toBe(privateValueCommitment(bound.transaction));
    expect(privateValueCommitment({ ...bound.transaction, global: { ...bound.transaction.global, carrierContextHash: 0n } }))
      .not.toBe(bound.privateValueCommitment);
    const vk = Array.from({ length: VK_LEN }, (_, i) => fieldToHex(BigInt(i + 1)));
    const map = bound.buildKernelWitnessMap({ vkFields: vk, vkHash: fieldToHex(computeCircuitVkHash(vk)) });
    expect((map.choices as { carrier_context_hash: string }).carrier_context_hash).toBe(fieldToHex(carrierContextHash));
    // The readable payment message does not sign it.
    expect(bound.authorizationRequest!.typedData.message).toEqual(build.authorizationRequest!.typedData.message);
  });

  it("requests only semantic payment fields", () => {
    const message = build.authorizationRequest!.typedData.message as Record<string, unknown>;
    expect(Object.keys(message)).toEqual([
      "pcashChainId",
      "recipient",
      "amount",
      "openFeeAmount",
      "issuanceRecipient",
      "issuanceOwnerCommitment",
      "relayFeeAmount",
      "relayFeeOwnerCommitment",
      "transactionContext",
      "notBefore",
      "validUntil",
    ]);
  });

  it("rejects a note root that does not open from the selected block state", () => {
    const params = transferFixture({
      chainId,
      wallet,
      recipientAddress,
      inputAmount: 10n,
      paymentAmount: 9n,
      openFeeAmount: 1n,
      issuanceOwnerCommitment: 0n,
      notBeforeTimestamp: 0n,
      validUntilTimestamp: 100n,
      noteSecret: 0x44n,
    });
    const badSiblings = [...params.outputRootStateSiblings];
    badSiblings[0] = BigInt(badSiblings[0]!) + 1n;
    expect(() => buildNativeTransfer({ ...params, outputRootStateSiblings: badSiblings }))
      .toThrow(/outputRoot does not open under stateRoot/);
  });

  it("expects the rule statement the payment rule computes", () => {
    expect(build.privateValueCommitment).toBe(privateValueCommitment(build.transaction));
    expect(build.configurationCommitment).toBe(ecdsaRuleConfigurationCommitment(
      DEFAULT_NETWORK_CONFIG,
      nullifierKeyCommitment(wallet.nkRoot),
    ));
    expect(build.address).toBe(wallet.address);
    expect(build.ruleStatement).toEqual(ruleStatement(
      authorizationCommitment(wallet.address, build.configurationCommitment),
      transferActionCommitment(chainId, build.privateValueCommitment),
      build.recentPcashBlockHash,
    ));
    // The rule takes the chain and block it binds, never the statement itself.
    expect(build.accountRuleWitnessMap?.pcash_chain_id).toBe(fieldToHex(chainId));
    expect(build.accountRuleWitnessMap?.recent_pcash_block_hash).toBe(fieldToHex(build.recentPcashBlockHash));
    expect(build.accountRuleWitnessMap).not.toHaveProperty("action_commitment");
    expect(build.accountRuleWitnessMap).not.toHaveProperty("private_value_commitment");
  });

  it("kernel witness map embeds the exact Mega VK", () => {
    const vk = Array.from({ length: VK_LEN }, (_, i) => `0x${BigInt(i + 1).toString(16).padStart(64, "0")}`);
    const map = build.buildKernelWitnessMap({
      vkFields: vk,
      vkHash: fieldToHex(computeCircuitVkHash(vk)),
    });
    expect(map.account_kind).toBeDefined();
    expect(map.output_owner_commitments).toBeInstanceOf(Array);
    expect((map.choices as { delivery_commitment: string }).delivery_commitment).toBe(fieldToHex(build.transaction.global.deliveryCommitment));
    expect(map.choices).not.toHaveProperty("output_data_hashes");
    expect(map).not.toHaveProperty("nullifier3");
    expect(map.owner_inputs).toBeInstanceOf(Array);
    expect((map.authorization_vk as { key: string[] }).key).toHaveLength(VK_LEN);
  });

  it("rejects an over-spend (inputAmount < payment + fee)", () => {
    expect(() =>
      buildNativeTransfer(transferFixture({
        chainId,
        wallet,
          recipientAddress,
        inputAmount: 100n,
        paymentAmount: 100n,
        openFeeAmount: 1n,
        issuanceOwnerCommitment: 0n,
        dummyInputEntropy: 1n,
        validUntilTimestamp: 10n,
        noteSecret: 0x1n,
      })),
    ).toThrow();
  });

  it("supports the full depth-40 index range and rejects 2^40", () => {
    const maxIndex = 2 ** MERKLE_DEPTH - 1;
    const params = {
      chainId,
      wallet,
      recipientAddress,
      inputAmount: 100n,
      paymentAmount: 99n,
      openFeeAmount: 1n,
      issuanceOwnerCommitment: 0n,
      dummyInputEntropy: 2n,
      validUntilTimestamp: 10n,
      noteSecret: 0x1n,
      outputIndex: maxIndex,
      accountIndex: maxIndex,
    };
    const atBoundary = buildNativeTransfer(transferFixture(params));
    expect(atBoundary.buildKernelWitnessMap).toBeTypeOf("function");
    expect(() => transferFixture({ ...params, outputIndex: 2 ** MERKLE_DEPTH }))
      .toThrow(/out of range/);
  });

  it("spends a zero-secret input and accepts an explicit zero dummyInputEntropy", () => {
    const params = {
      chainId,
      wallet,
      recipientAddress,
      inputAmount: 100n,
      paymentAmount: 99n,
      openFeeAmount: 1n,
      issuanceOwnerCommitment: 0n,
      dummyInputEntropy: 0n,
      validUntilTimestamp: 10n,
      noteSecret: 0n,
    };
    const result = buildNativeTransfer(transferFixture(params));
    const spent = fullOutputCommitment({ owner: wallet.address, noteSecret: 0n, assetId: 0n, amount: 100n }, 0);
    expect(result.transaction.inputs[0]!.inputCommitment).toBe(spent);
    expect(result.publicInputs[2]).toBe(nullifier(spent, noteNk(wallet.nkRoot), 0n));
    expect(result.publicInputs.slice(3, 6)).toEqual([1, 2, 3].map((slot) => dummyNullifier(0n, slot)));
  });

  it("spends from an account at revision zero", () => {
    expect(() => buildNativeTransfer(transferFixture({
      chainId,
      wallet,
      recipientAddress,
      inputAmount: 100n,
      paymentAmount: 99n,
      openFeeAmount: 1n,
      issuanceOwnerCommitment: 0n,
      validUntilTimestamp: 10n,
      noteSecret: 0x1n,
      accountRevision: 0n,
    }))).not.toThrow();
  });

  it("draws a fresh dummy input seed for every action", () => {
    const params = {
      chainId,
      wallet,
      recipientAddress,
      inputAmount: 100n,
      paymentAmount: 99n,
      openFeeAmount: 1n,
      issuanceOwnerCommitment: 0n,
      validUntilTimestamp: 10n,
      noteSecret: 0x1n,
    };
    const first = buildNativeTransfer(transferFixture(params));
    const second = buildNativeTransfer(transferFixture(params));
    // Only the real input's nullifier is shared; every dummy nullifier differs.
    expect(second.publicInputs[2]).toBe(first.publicInputs[2]);
    const firstDummies = first.publicInputs.slice(3, 6);
    const secondDummies = second.publicInputs.slice(3, 6);
    for (const value of secondDummies) expect(firstDummies).not.toContain(value);
    expect(first.buildKernelWitnessMap).toBeTypeOf("function");
  });

  it("preserves the authorized action when state roots are refreshed with its output secrets", () => {
    const outputIndex = 7;
    const accountIndex = 9;
    const noteSecret = 0x1234n;
    const inputAmount = 100n;
    const params = transferFixture({
      chainId,
      wallet,
      recipientAddress,
      inputAmount,
      paymentAmount: 99n,
      openFeeAmount: 1n,
      issuanceOwnerCommitment: 0n,
      dummyInputEntropy: 0x55n,
      validUntilTimestamp: 10n,
      noteSecret,
      outputIndex,
      accountIndex,
    });
    const initial = buildNativeTransfer(params);

    const noteTree = new SparseMerkleTree(MERKLE_DEPTH);
    noteTree.setLeaf(
      outputIndex,
      fullOutputCommitment(
        { owner: wallet.address, noteSecret, assetId: 0n, amount: inputAmount },
        outputIndex,
      ),
    );
    noteTree.setLeaf(100, 0x123n);
    const noteOpening = noteTree.proof(outputIndex);

    const ruleSetCommitment = defaultEcdsaRuleSet({
      wallet,
      secrets: TEST_DEFAULT_RULE_SECRETS,
    }).ruleSetCommitment;
    const accountStateTree = new SparseMerkleTree(MERKLE_DEPTH);
    accountStateTree.setLeaf(
      accountIndex,
      accountStateCommitment(
        wallet.address,
        nullifierKeyCommitment(wallet.nkRoot),
        ruleSetCommitment,
        0n,
        1n,
        0n,
      ),
    );
    accountStateTree.setLeaf(101, 0x456n);
    const accountOpening = accountStateTree.proof(accountIndex);
    const recentBlock = syntheticRecentBlockOpenings({
      outputRoot: noteOpening.root,
      outputCount: 101,
      issuedSoFar: 0n,
      lagQ: 100n * 10n ** 18n * 2n ** 64n,
      accountStateRoot: accountOpening.root,
      accountCount: 102,
    });

    const refreshed = buildNativeTransfer({
      ...params,
      ...recentBlock,
      outputRoot: noteOpening.root,
      inputs: [{
        ...params.inputs[0]!,
        siblings: noteOpening.siblings,
      }],
      accountStateRoot: accountOpening.root,
      accountSiblings: accountOpening.siblings,
      outputNoteSecrets: initial.outputNoteSecrets,
      outputData: initial.outputData,
      arena: initial.arena,
    });

    expect(refreshed.privateValueCommitment).toBe(initial.privateValueCommitment);
    expect(refreshed.outputNoteSecrets).toEqual(initial.outputNoteSecrets);
    expect(refreshed.recentPcashBlockHash).not.toBe(initial.recentPcashBlockHash);
    expect(bytesEqual(refreshed.outputData[0]!, initial.outputData[0]!)).toBe(true);
    expect(bytesEqual(refreshed.outputData[1]!, initial.outputData[1]!)).toBe(true);
    expect(bytesEqual(refreshed.outputData[2]!, initial.outputData[2]!)).toBe(true);
  });

  it("returns five fixed-size envelope slots and rejects an empty override", () => {
    const explicit = outputEnvelope(0xaa);
    const params = transferFixture({
      chainId,
      wallet,
      recipientAddress,
      inputAmount: 100n,
      paymentAmount: 99n,
      openFeeAmount: 1n,
      issuanceOwnerCommitment: 0n,
      dummyInputEntropy: 0x66n,
      validUntilTimestamp: 100n,
      noteSecret: 0x77n,
    });
    const result = buildNativeTransfer({
      ...params,
      outputData: [explicit, undefined],
    });

    expect(result.outputData).toHaveLength(5);
    expect(bytesEqual(result.outputData[0]!, explicit)).toBe(true);
    for (const output of result.outputData) expect(output).toHaveLength(OUTPUT_DATA_BYTES);
    expect(() => buildNativeTransfer({
      ...params,
      outputData: [new Uint8Array(0)],
    })).toThrow(/outputData\[0\] must have exactly 1213 bytes/);
  });

  it("gives a per-output override precedence over the slot tuple", () => {
    const slot0 = outputEnvelope(0x10);
    const tupleSlot1 = outputEnvelope(0x20);
    const perOutputSlot1 = outputEnvelope(0x30);
    const params = transferFixture({
      chainId,
      wallet,
      recipientAddress,
      inputAmount: 100n,
      paymentAmount: 50n,
      secondOutput: {
        address: wallet.address,
        amount: 49n,
        outputData: perOutputSlot1,
      },
      openFeeAmount: 1n,
      issuanceOwnerCommitment: 0n,
      dummyInputEntropy: 0x67n,
      validUntilTimestamp: 100n,
      noteSecret: 0x78n,
    });
    const result = buildNativeTransfer({
      ...params,
      outputData: [slot0, tupleSlot1],
    });

    expect(bytesEqual(result.outputData[0]!, slot0)).toBe(true);
    expect(bytesEqual(result.outputData[1]!, perOutputSlot1)).toBe(true);
  });

  it("routes a second output to the signer through the batch rule as owner change", () => {
    // The payment rule has one change slot, so a caller-supplied self output
    // goes to the batch rule, which proves it as owner change and never declares it.
    const result = buildNativeTransfer(transferFixture({
      chainId,
      wallet,
      recipientAddress,
      inputAmount: 100n,
      paymentAmount: 50n,
      secondOutput: { address: wallet.address, amount: 20n },
      openFeeAmount: 1n,
      issuanceOwnerCommitment: 0n,
      dummyInputEntropy: 0x67n,
      validUntilTimestamp: 100n,
      noteSecret: 0x78n,
      outputData: [undefined, undefined, new Uint8Array(OUTPUT_DATA_BYTES).fill(9)],
    }));
    expect(result.authorizationCircuit).toBe("account_rule_batch_transfer_ecdsa");
    const map = result.accountRuleWitnessMap!;
    expect(map.owner_change_amounts).toEqual([0n, 20n, 29n, 0n, 0n].map(fieldToHex));
    expect((map.outputs as { recipient: string }[]).map((output) => BigInt(output.recipient)))
      .toEqual([recipientAddress, 0n, 0n, 0n, 0n]);
  });
});

describe("buildUserAccountCreation", () => {
  it("builds direct reference creation with the same fields and rule checks but no signature", () => {
    const common = { chainId, wallet, defaultRuleSecrets: TEST_DEFAULT_RULE_SECRETS,
      recentPcashBlockHash: 0x1234n, validUntilTimestamp: 987654n };
    const direct = buildDirectReferenceUserAccountCreation(common);
    const signed = buildReferenceUserAccountCreation({ ...common, authorizationResolver: testAuthorizationResolver(wallet) });
    expect(direct.body[0]).toBe(0);
    expect(signed.body[0]).toBe(1);
    expect(direct.body.slice(1)).toEqual(signed.body.slice(1, -65));
    expect(direct).not.toHaveProperty("signingHash");
    expect(direct).not.toHaveProperty("r");
    expect(buildDirectReferenceUserAccountCreation({ ...common, wallet: { ...wallet, nkRoot: 0n } }).nullifierKeyCommitment)
      .toBe(nullifierKeyCommitment(0n));
    expect(() => buildDirectReferenceUserAccountCreation({ ...common, ruleSetCommitment: 123n })).toThrow(/opaque-rule-set override/);
    expect(() => buildDirectReferenceUserAccountCreation({ ...common, mlKemPublicKey: new Uint8Array(10) })).toThrow(/1184/);
  });

  it("keeps signed creation bound to its account fields and Ethereum domain", () => {
    const common = { chainId, wallet, defaultRuleSecrets: TEST_DEFAULT_RULE_SECRETS,
      network: DEFAULT_NETWORK_CONFIG, recentPcashBlockHash: 0x1234n, validUntilTimestamp: 987654n };
    const prepared = prepareUserAccountCreation(common);
    const authorization = testAuthorizationResolver(wallet)(prepared.authorizationRequest);
    expect(buildUserAccountCreation({ ...common, authorization }).body[0]).toBe(1);
    for (const change of [
      { recentPcashBlockHash: 0x1235n },
      { validUntilTimestamp: 987655n },
      { wallet: { ...wallet, nkRoot: wallet.nkRoot + 1n } },
      { unsafeOpaqueRuleSetCommitment: 123n },
      { mlKemPublicKey: new Uint8Array(1184).fill(7) },
      { network: { ...DEFAULT_NETWORK_CONFIG, l1ChainId: BigInt(DEFAULT_NETWORK_CONFIG.l1ChainId) + 1n } },
      { network: { ...DEFAULT_NETWORK_CONFIG, inboxAddress: BigInt(DEFAULT_NETWORK_CONFIG.inboxAddress) + 1n } },
    ]) expect(() => buildUserAccountCreation({ ...common, ...change, authorization })).toThrow();
  });

  it("cannot create the intended account without that account's authorization", () => {
    const other = deriveTestWallet({ privKey: new Uint8Array(32).fill(0x42) });
    const common = { chainId, defaultRuleSecrets: TEST_DEFAULT_RULE_SECRETS,
      recentPcashBlockHash: 0x1234n, validUntilTimestamp: 987654n };
    const otherPrepared = prepareUserAccountCreation({ ...common, wallet: other });
    const otherAuthorization = testAuthorizationResolver(other)(otherPrepared.authorizationRequest);
    // Over the intended account's message, another key's signature recovers to an unrelated
    // address, where the node would create a different account; the builder refuses it.
    expect(() => buildUserAccountCreation({ ...common, wallet, authorization: otherAuthorization }))
      .toThrow(/signature recovers/);
    expect(() => testAuthorizationResolver(other)(prepareUserAccountCreation({ ...common, wallet }).authorizationRequest))
      .toThrow(/signature recovers/);
  });

  it("lays out the body without an address and recovers the signer to the account address", () => {
    const rec = buildUserAccountCreation({
      chainId,
      wallet,
      defaultRuleSecrets: TEST_DEFAULT_RULE_SECRETS,
      recentPcashBlockHash: 0x1234n,
      validUntilTimestamp: 987654n,
      authorizationResolver: testAuthorizationResolver(wallet),
    });
    // mode(1) P(32) ruleSetCommitment(32) receiveKeyMode(1)
    // recentBlockHash(32) validUntil(8) r(32) s(32) yParity(1)
    expect(rec.body.length).toBe(1 + 32 + 32 + 1 + 32 + 8 + 32 + 32 + 1);
    expect(bytesToBigInt(rec.body.slice(1, 33))).toBe(nullifierKeyCommitment(wallet.nkRoot));
    expect(rec.body[65]).toBe(0); // receive key absent
    expect(bytesToBigInt(rec.body.slice(66, 98))).toBe(0x1234n);
    expect(bytesToBigInt(rec.body.slice(98, 106))).toBe(987654n);
    expect(bytesToBigInt(rec.body.slice(106, 138))).toBe(rec.r);
    expect(bytesToBigInt(rec.body.slice(138, 170))).toBe(rec.s);
    expect(rec.body[170]).toBe(rec.yParity);
    // The node creates the account at the recovered signer.
    expect(recoverAddress(rec.signingHash, { r: rec.r, s: rec.s, yParity: rec.yParity })).toBe(
      wallet.address,
    );
  });

  it("includes the ML-KEM receive key and grows the body by 1184 bytes", () => {
    const mlKem = Uint8Array.from({ length: 1184 }, (_, i) => i & 0xff);
    const rec = buildUserAccountCreation({
      chainId,
      wallet,
      mlKemPublicKey: mlKem,
      defaultRuleSecrets: TEST_DEFAULT_RULE_SECRETS,
      recentPcashBlockHash: 0x5678n,
      validUntilTimestamp: 123456n,
      authorizationResolver: testAuthorizationResolver(wallet),
    });
    expect(rec.body.length).toBe(1 + 32 + 32 + 1 + 1184 + 32 + 8 + 32 + 32 + 1);
    expect(rec.body[65]).toBe(1); // receive key present, then exactly 1,184 key bytes
    expect(bytesEqual(rec.body.slice(66, 66 + 1184), mlKem)).toBe(true);
    expect(bytesToBigInt(rec.body.slice(66 + 1184, 98 + 1184))).toBe(0x5678n);
  });

  it("creates an account whose nkRoot is zero, committing its published root", () => {
    const zeroRoot = buildUserAccountCreation({
      chainId,
      wallet: { ...wallet, nkRoot: 0n },
      defaultRuleSecrets: TEST_DEFAULT_RULE_SECRETS,
      recentPcashBlockHash: 0x1234n,
      validUntilTimestamp: 987654n,
      authorizationResolver: testAuthorizationResolver(wallet),
    });
    expect(bytesToBigInt(zeroRoot.body.slice(1, 33))).toBe(nullifierKeyCommitment(0n));
  });

  it("keeps opaque roots low-level and requires an irreversible reference-wallet override", () => {
    const opaqueRoot = 0x123456n;
    const common = {
      chainId,
      wallet,
      recentPcashBlockHash: 0x5678n,
      validUntilTimestamp: 123456n,
      authorizationResolver: testAuthorizationResolver(wallet),
    };
    expect(() => buildReferenceUserAccountCreation({
      ...common,
      ruleSetCommitment: opaqueRoot,
    })).toThrow(
      /requires the irreversible opaque-rule-set override/,
    );
    expect(bytesToBigInt(buildUserAccountCreation({
      ...common,
      unsafeOpaqueRuleSetCommitment: opaqueRoot,
    }).body.slice(33, 65))).toBe(opaqueRoot);
    expect(bytesToBigInt(buildReferenceUserAccountCreation({
      ...common,
      ruleSetCommitment: opaqueRoot,
      irreversibleOpaqueRuleOverride: { acknowledgeOpaqueRuleSet: true },
    }).body.slice(33, 65))).toBe(opaqueRoot);
  });
});
