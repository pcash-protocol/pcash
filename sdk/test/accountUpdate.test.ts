import { describe, expect, it } from "vitest";
import { authorizePcashRequestWithPrivateKey } from "../src/eip712/authorization.ts";
import { bytesEqual, bytesToBigInt } from "../src/utils/bytes.ts";
import {
  sectionWireInputs,
  RECEIVE_KEY_OPERATION_CLEAR,
  RECEIVE_KEY_OPERATION_KEEP,
  RECEIVE_KEY_OPERATION_REPLACE,
  TX_KIND_CONTRACT_ACCOUNT_CREATION,
  TX_KIND_PRIVATE_VALUE,
  TX_KIND_USER_ACCOUNT_UPDATE,
  WIRE_PROOF_BYTES,
  USER_ACCOUNT_UPDATE_PUBLIC_INPUTS,
  decodeTransaction,
  userAccountUpdatePublicInputs,
} from "../src/protocol/codec.ts";
import { OUTPUT_DATA_BYTES } from "../src/constants/params.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { BN254_SCALAR_MODULUS, fieldToHex } from "../src/crypto/field.ts";
import {
  buildAccountRuleSet,
  computeCircuitVkHash,
  VK_LEN,
  accountRuleEntryCommitment,
} from "../src/protocol/account.ts";
import { accountUpdateActionCommitment } from "../src/protocol/statement.ts";
import { privateValueCommitment, SlotClass } from "../src/protocol/transaction.ts";
import {
  prepareUserAccountUpdate,
  proveAndEncodeUserAccountUpdate,
  type BuildUserAccountUpdateParams,
} from "../src/builders/accountUpdate.ts";
import { ecdsaRuleConfigurationCommitment } from "../src/rules/referenceRules.ts";
import { nullifierKeyCommitment } from "../src/protocol/notes.ts";
import { openSenderRecords, type ArenaTransactionType } from "../src/protocol/arena.ts";
import { decodePayload, decryptEnvelope } from "../src/protocol/envelope.ts";
import { feePaymentFixture } from "@pcash/test-support/protocol-fixtures";
import { deriveTestWallet } from "./testWallet.ts";

const wallet = deriveTestWallet({ mlKem: "deterministic" });
const commitmentBlinder = 0xc0ffeen;
const vkFields = Array.from({ length: VK_LEN }, (_, index) => BigInt(index + 1));
const applicationVkHash = computeCircuitVkHash(vkFields);
const configurationCommitment = ecdsaRuleConfigurationCommitment(
  DEFAULT_NETWORK_CONFIG,
  nullifierKeyCommitment(wallet.nkRoot),
);
const entryIndex = 3;
const entry = accountRuleEntryCommitment(
  applicationVkHash,
  configurationCommitment,
  commitmentBlinder,
);
const currentRules = buildAccountRuleSet([
  { entryIndex, accountRuleEntryCommitment: entry },
]);
const opening = currentRules.membership(entryIndex);
const fixture = feePaymentFixture({
  wallet,
  inputAmount: 1_000n,
  noteSecret: 0xbeefn,
  accountRuleSetCommitment: currentRules.accountRuleSetCommitment,
});

function params(): BuildUserAccountUpdateParams {
  return {
    network: DEFAULT_NETWORK_CONFIG,
    current: {
      address: wallet.address,
      accountRevision: 1n,
      ruleSetCommitment: currentRules.accountRuleSetCommitment,
      receiveKey: { status: "available" as const, mlKemPublicKey: wallet.mlKemPublicKey! },
    },
    nkRoot: wallet.nkRoot,
    proposed: {
      ruleSetCommitment: 0x123456n,
      receiveKey: { operation: "clear" as const },
    },
    recentPcashBlockHash: fixture.recentPcashBlockHash,
    validUntilTimestamp: 1_000_000n,
    snapshot: fixture.snapshot,
    fee: {
      openFeeAmount: 100n,
      inputs: fixture.inputs,
      receiveKey: wallet.mlKemPublicKey!,
      dummyInputEntropy: 42n,

    },
    rule: {
      applicationVkHash,
      configurationCommitment,
      commitmentBlinder,
      entryIndex,
      siblings: opening.siblings,
    },
    readableEcdsa: { signerAddress: wallet.address },
  };
}

const applicationVk = {
  vkFields: vkFields.map(fieldToHex),
  vkHash: fieldToHex(applicationVkHash),
};

describe("user account update builder", () => {
  it("builds the readable application and exact type-0x03 entry", () => {
    const build = prepareUserAccountUpdate(params());
    expect(build.authorizationRequest?.kind).toBe("account-update");
    // The change envelope and funding blinder are fresh per build, so the
    // signature is taken over this exact build rather than a re-preparation.
    const authorization = authorizePcashRequestWithPrivateKey(
      wallet.privKey,
      build.authorizationRequest!,
    );
    const readable = build.authorizeReadableEcdsa!(authorization);
    expect(build.publicInputs).toHaveLength(USER_ACCOUNT_UPDATE_PUBLIC_INPUTS);
    expect(build.publicInputs[0]).toBe(DEFAULT_NETWORK_CONFIG.pcashChainId);
    expect(build.publicInputs[1]).toBe(fixture.recentPcashBlockHash);
    expect(build.publicInputs[11]).toBe(build.payment.transaction.global.deliveryCommitment);
    expect(build.publicInputs[12]).toBe(100n);
    expect(build.publicInputs[13]).toBe(0n);
    expect(build.publicInputs[14]).toBe(0n);
    expect(build.publicInputs[15]).toBe(1_000_000n);
    expect(build.publicInputs[16]).toBe(0n);
    expect(build.publicInputs[18]).toBe(build.accountUpdateCommitment);
    expect(build.payment.publicInputs).toHaveLength(18);
    expect(build.actionCommitment).toBe(accountUpdateActionCommitment(
      DEFAULT_NETWORK_CONFIG.pcashChainId,
      build.payment.privateValueCommitment,
      build.accountUpdateCommitment,
    ));
    // The account's note funds the fee and the remainder returns as change.
    expect(build.payment.transaction.inputs[0]!.slotClass).toBe(SlotClass.NATIVE);
    expect(build.payment.transaction.inputs[1]!.slotClass).toBe(SlotClass.DUMMY);
    expect(build.payment.change?.amount).toBe(900n);
    expect(build.payment.transaction.outputs[0]!.slotClass).toBe(SlotClass.NATIVE);
    // The rule derives the account from its signer and computes its statement.
    expect(readable.witnessMap.pcash_chain_id).toBe(fieldToHex(DEFAULT_NETWORK_CONFIG.pcashChainId));
    expect(readable.witnessMap.recent_pcash_block_hash).toBe(fieldToHex(fixture.recentPcashBlockHash));
    expect(readable.witnessMap).not.toHaveProperty("account");
    expect(readable.witnessMap.private_value).toBeDefined();
    const kernel = build.buildKernelWitnessMap(applicationVk);
    expect((kernel.authorization_vk as { key: string[] }).key).toHaveLength(VK_LEN);
    expect(kernel.account_rule_witness).toBeDefined();
    expect(kernel.native_inputs).toHaveLength(4);
    expect(kernel.nk_root).toBe(fieldToHex(wallet.nkRoot));

    const proof = new Uint8Array(WIRE_PROOF_BYTES).fill(0xa5);
    const encoded = build.encodeTransaction(proof);
    const decoded = decodeTransaction(encoded);
    expect(decoded.kind).toBe(TX_KIND_USER_ACCOUNT_UPDATE);
    if (decoded.kind !== TX_KIND_USER_ACCOUNT_UPDATE) throw new Error("wrong entry kind");
    expect(bytesEqual(decoded.proposedAccountFields, build.proposedAccountFields)).toBe(true);
    expect(bytesToBigInt(decoded.accountUpdateCommitment)).toBe(build.accountUpdateCommitment);
    expect(decoded.section.serializedPublicInputs).toHaveLength(15);
    expect(bytesEqual(decoded.section.proof, proof)).toBe(true);
    expect(userAccountUpdatePublicInputs(decoded)).toEqual(build.publicInputs);
    expect(bytesToBigInt(decoded.proposedAccountFields.slice(20, 52))).toBe(0x123456n);
    expect(decoded.proposedAccountFields[52]).toBe(RECEIVE_KEY_OPERATION_CLEAR);
    expect(decoded.receiveKey).toEqual({ operation: "clear" });
    expect(encoded).toHaveLength(
      5 + 20 + 32 + 1 + 32 + sectionWireInputs({ kind: "userAccountUpdate" }) * 32 + WIRE_PROOF_BYTES + 5 * OUTPUT_DATA_BYTES
        + PRIVATE_VALUE_PROFILES.S.arenaBytes,
    );
  });

  it("binds a requested carrier context into the fee section without signing it", () => {
    const carrierContextHash = 0x0bad5eedn;
    const base = prepareUserAccountUpdate(params());
    const build = prepareUserAccountUpdate({ ...params(), carrierContextHash });
    const { offsets } = PRIVATE_VALUE_PROFILES.S;
    expect(build.publicInputs[offsets.carrierContextHash]).toBe(carrierContextHash);
    expect(build.payment.transaction.global.carrierContextHash).toBe(carrierContextHash);
    expect(build.payment.privateValueCommitment).toBe(privateValueCommitment(build.payment.transaction));
    expect((build.buildKernelWitnessMap(applicationVk).choices as { carrier_context_hash: string }).carrier_context_hash)
      .toBe(fieldToHex(carrierContextHash));
    expect(build.authorizationRequest!.typedData.message).toEqual(base.authorizationRequest!.typedData.message);
    const decoded = decodeTransaction(build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)));
    if (decoded.kind !== TX_KIND_USER_ACCOUNT_UPDATE) throw new Error("wrong entry kind");
    expect(userAccountUpdatePublicInputs(decoded)).toEqual(build.publicInputs);
  });

  it("builds a zero-fee update with an all-dummy section", () => {
    const zeroFee = params();
    delete zeroFee.fee;
    const build = prepareUserAccountUpdate(zeroFee);
    expect(build.publicInputs[PRIVATE_VALUE_PROFILES.S.offsets.openFeeAmount]).toBe(0n);
    expect(build.payment.change).toBeNull();
    expect(build.payment.transaction.inputs.every((input) => input.slotClass === SlotClass.DUMMY)).toBe(true);
    expect(build.payment.transaction.outputs.every((output) => output.slotClass === SlotClass.DUMMY)).toBe(true);
  });

  it("updates an account at revision zero and rejects one at the last u32 revision", () => {
    const base = params();
    expect(() => prepareUserAccountUpdate({ ...base, current: { ...base.current, accountRevision: 0n } })).not.toThrow();
    expect(() => prepareUserAccountUpdate({ ...base, current: { ...base.current, accountRevision: (1n << 32n) - 1n } }))
      .toThrow(/cannot be incremented/);
  });

  it("pays a private relay output to address zero", () => {
    const base = params();
    const build = prepareUserAccountUpdate({
      ...base,
      fee: { ...base.fee!, privateRelayPayment: { recipientAddress: 0n, receiveKey: wallet.mlKemPublicKey!, amount: 1n } },
    });
    expect(build.payment.relayPayment?.recipientAddress).toBe(0n);
  });

  it("draws fresh dummy input and output secrets for every fee section", () => {
    const fresh = () => {
      const next = params();
      const { dummyInputEntropy: _seed, ...fee } = next.fee!;
      return prepareUserAccountUpdate({ ...next, fee }).payment;
    };
    const first = fresh();
    const second = fresh();
    expect(second.dummyInputSeed).not.toBe(first.dummyInputSeed);
    // Slot 0 spends the fixture note; the three dummy nullifiers all change.
    expect(second.transaction.inputs[0]!.nullifier).toBe(first.transaction.inputs[0]!.nullifier);
    for (const slot of [1, 2, 3]) {
      expect(second.transaction.inputs[slot]!.nullifier).not.toBe(first.transaction.inputs[slot]!.nullifier);
    }
    for (const slot of [1, 2, 3, 4]) {
      expect(second.outputDummySecrets[slot]).not.toBe(first.outputDummySecrets[slot]);
    }
  });

  it("writes the account's sender region in the fee section, bound to the account-update type", () => {
    const outgoingKey = new Uint8Array(32).fill(0x0e);
    const read = (build: ReturnType<typeof prepareUserAccountUpdate>, transactionType: ArenaTransactionType) => openSenderRecords({
      arena: build.payment.arena,
      shape: PRIVATE_VALUE_PROFILES.S.shapeId,
      context: {
        chainId: DEFAULT_NETWORK_CONFIG.pcashChainId,
        transactionType,
        nullifiers: build.payment.transaction.inputs.map((input) => input.nullifier),
      },
      outgoingKey,
    });
    const build = prepareUserAccountUpdate({ ...params(), sender: { outgoingKey } });
    // The change returns to the account, so nothing is recorded as paid.
    expect(read(build, TX_KIND_USER_ACCOUNT_UPDATE)).toEqual({ records: [], sentEnvelopes: [], sentOpenings: [] });
    expect(read(build, TX_KIND_PRIVATE_VALUE)).toBeNull();
    expect(read(build, TX_KIND_CONTRACT_ACCOUNT_CREATION)).toBeNull();
    expect(decodePayload(decryptEnvelope(wallet.mlKemSecretKey!, build.payment.outputData[0]!)!, {
      chainId: DEFAULT_NETWORK_CONFIG.pcashChainId,
    }).amount).toBe(900n);
    expect(read(prepareUserAccountUpdate(params()), TX_KIND_USER_ACCOUNT_UPDATE)).toBeNull();
    const zeroFee = { ...params(), sender: { outgoingKey } };
    delete zeroFee.fee;
    expect(read(prepareUserAccountUpdate(zeroFee), TX_KIND_USER_ACCOUNT_UPDATE)).toEqual({ records: [], sentEnvelopes: [], sentOpenings: [] });
  });

  it("rebuilds the fee section only from the prior arena and output data together", () => {
    const prior = prepareUserAccountUpdate(params());
    const reuse = (fee: Partial<NonNullable<BuildUserAccountUpdateParams["fee"]>>) => {
      const next = params();
      next.fee = { ...next.fee!, ...fee };
      return prepareUserAccountUpdate(next);
    };
    expect(() => reuse({ arena: prior.payment.arena })).toThrow(/a supplied arena requires the prior build's output data/);
    const rebuilt = reuse({
      arena: prior.payment.arena,
      outputData: prior.payment.outputData,
      dummyOutputEntropy: prior.payment.outputDummySecrets,
    });
    expect(rebuilt.payment.transaction.global.deliveryCommitment).toBe(prior.payment.transaction.global.deliveryCommitment);
    expect(rebuilt.payment.privateValueCommitment).toBe(prior.payment.privateValueCommitment);
  });

  it("rejects a fee the selected notes cannot cover", () => {
    const short = params();
    short.fee = { ...short.fee!, openFeeAmount: 1_001n };
    expect(() => prepareUserAccountUpdate(short)).toThrow(/native inputs total 1000/);
  });

  it("rejects a selected rule that does not open the current root", () => {
    const bad = params();
    const siblings = [...bad.rule.siblings];
    siblings[0] = BigInt(siblings[0]!) + 1n;
    bad.rule = { ...bad.rule, siblings };
    expect(() => prepareUserAccountUpdate(bad)).toThrow(
      /does not open under currentRuleSetCommitment/,
    );
  });

  it("requires the readable administration signer to be the account", () => {
    const delegated = params();
    delegated.readableEcdsa = { signerAddress: wallet.address + 1n };
    expect(() => prepareUserAccountUpdate(delegated)).toThrow(/signer must be the account itself/);
  });

  it("encodes keep, clear, and replace as explicit receive-key operations", () => {
    const unavailable = params();
    unavailable.current.receiveKey = {
      status: "unavailable",
      receiveKeyHash: 7n,
    };
    unavailable.proposed.receiveKey = { operation: "keep" };
    const keptUnavailable = prepareUserAccountUpdate(unavailable);
    expect(keptUnavailable.proposedAccountFields[52]).toBe(RECEIVE_KEY_OPERATION_KEEP);
    expect(keptUnavailable.proposedAccountFields).toHaveLength(53);

    const keep = params();
    keep.proposed.receiveKey = { operation: "keep" };
    const kept = prepareUserAccountUpdate(keep);
    expect(kept.proposedAccountFields[52]).toBe(RECEIVE_KEY_OPERATION_KEEP);
    expect(kept.proposedAccountFields).toHaveLength(53);

    const replacement = new Uint8Array(1184).fill(9);
    const replace = params();
    replace.proposed.receiveKey = { operation: "replace", mlKemPublicKey: replacement };
    const replaced = prepareUserAccountUpdate(replace);
    expect(replaced.proposedAccountFields[52]).toBe(RECEIVE_KEY_OPERATION_REPLACE);
    expect(replaced.proposedAccountFields).toHaveLength(53 + 1184);
    expect(bytesEqual(replaced.proposedAccountFields.slice(53), replacement)).toBe(true);
  });

  it("requires KEEP when the receive-key state would not change", () => {
    const absentClear = params();
    absentClear.current.receiveKey = { status: "absent" };
    absentClear.proposed.receiveKey = { operation: "clear" };
    expect(() => prepareUserAccountUpdate(absentClear)).toThrow(
      /CLEAR is noncanonical.*use KEEP/,
    );

    const identicalReplace = params();
    identicalReplace.proposed.receiveKey = {
      operation: "replace",
      mlKemPublicKey: wallet.mlKemPublicKey!,
    };
    expect(() => prepareUserAccountUpdate(identicalReplace)).toThrow(
      /REPLACE is noncanonical.*use KEEP/,
    );

    const absentKeep = params();
    absentKeep.current.receiveKey = { status: "absent" };
    absentKeep.proposed.receiveKey = { operation: "keep" };
    expect(prepareUserAccountUpdate(absentKeep).proposedAccountFields[52]).toBe(
      RECEIVE_KEY_OPERATION_KEEP,
    );
  });

  it("takes the committed receive-key digest as a canonical field value", () => {
    const clear = params();
    clear.current.receiveKey = { status: "unavailable", receiveKeyHash: 1n };
    clear.proposed.receiveKey = { operation: "clear" };
    expect(prepareUserAccountUpdate(clear).proposedAccountFields[52]).toBe(RECEIVE_KEY_OPERATION_CLEAR);

    const fullWidth = params();
    fullWidth.current.receiveKey = { status: "unavailable", receiveKeyHash: BN254_SCALAR_MODULUS + 1n };
    fullWidth.proposed.receiveKey = { operation: "clear" };
    expect(() => prepareUserAccountUpdate(fullWidth)).toThrow(/BN254 scalar field element/);
  });

  it("rejects an application VK that is not the installed implementation", () => {
    const build = prepareUserAccountUpdate(params());
    const changedFields = applicationVk.vkFields.map((value, index) =>
      index === 0 ? fieldToHex(BigInt(value) + 1n) : value);
    expect(() => build.buildKernelWitnessMap({
      ...applicationVk,
      vkFields: changedFields,
      vkHash: fieldToHex(computeCircuitVkHash(changedFields)),
    })).toThrow(/does not match the installed rule/);
  });

  it("passes both application and kernel witness paths to the prover callback", async () => {
    const build = prepareUserAccountUpdate(params());
    const proof = new Uint8Array(WIRE_PROOF_BYTES).fill(7);
    const encoded = await proveAndEncodeUserAccountUpdate(
      build,
      applicationVk,
      async ({ witnessMap, expectedPublicInputs }) => {
        expect((witnessMap.authorization_vk as { key: string[] }).key).toHaveLength(VK_LEN);
        expect(expectedPublicInputs).toEqual(build.publicInputs);
        return proof;
      },
    );
    const decoded = decodeTransaction(encoded);
    if (decoded.kind !== TX_KIND_USER_ACCOUNT_UPDATE) throw new Error("wrong entry kind");
    expect(decoded.section.proof).toEqual(proof);
  });
});
