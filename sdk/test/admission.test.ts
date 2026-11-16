// Entry identity and mempool admission shared by every submitter.

import { describe, expect, it } from "vitest";
import { buildDirectReferenceUserAccountCreation, buildReferenceUserAccountCreation } from "../src/builders/index.ts";
import {
  admitTransaction,
  assertMempoolAdmissible,
  assertProtocolFeeCovered,
  isAdmissionRefusal,
  isProtocolFeeTooLowRefusal,
  PcashNodeRpcError,
  ProtocolFeeTooLowError,
  type StatusResult,
  type SubmitRawTransactionResult,
} from "../src/clients/index.ts";
import { PCASH_CHAIN_ID, PRIVATE_VALUE_PROFILES, type PrivateValueShape } from "../src/constants/index.ts";
import {
  ACCOUNT_WEIGHT,
  MAX_WAIVED_BASE_FEE,
  deliveryCommitment,
  encodePrivateValueTransaction,
  encodeUserAccountCreation,
  randomArena,
  sizeClassFiller,
  transactionIdentity,
  WIRE_PROOF_BYTES,
  type AccountCreationAttachment,
} from "../src/protocol/index.ts";
import { keccak256 } from "../src/utils/keccak.ts";
import { toHex } from "../src/utils/hex.ts";
import { TEST_DEFAULT_RULE_SECRETS } from "@pcash/test-support/protocol-fixtures";
import { deriveTestWallet, testAuthorizationResolver } from "./testWallet.ts";

const wallet = deriveTestWallet();
const creation = { chainId: PCASH_CHAIN_ID, wallet, defaultRuleSecrets: TEST_DEFAULT_RULE_SECRETS,
  recentPcashBlockHash: 0x1234n, validUntilTimestamp: 987654n };
const directCreation = encodeUserAccountCreation(PCASH_CHAIN_ID, buildDirectReferenceUserAccountCreation(creation).body);
const signedCreation = encodeUserAccountCreation(PCASH_CHAIN_ID, buildReferenceUserAccountCreation({
  ...creation, authorizationResolver: testAuthorizationResolver(wallet),
}).body);

function status(acceptedTransactionTypes: number[] = [0, 1], baseFee = 0n): StatusResult {
  return { pcashChainId: Number(PCASH_CHAIN_ID), acceptedTransactionTypes, baseFee } as unknown as StatusResult;
}

/** A structurally valid private-value entry declaring `nativeBurnAmount`; admission never checks its proof. */
function privateValueEntry(nativeBurnAmount: bigint, shape: PrivateValueShape = 0, accountCreation?: AccountCreationAttachment): Uint8Array {
  const profile = shape === 0 ? PRIVATE_VALUE_PROFILES.S : PRIVATE_VALUE_PROFILES.L;
  const outputData = Array.from({ length: profile.outputs }, () => sizeClassFiller());
  const arena = randomArena(profile.shapeId);
  const publicInputs: bigint[] = Array.from({ length: profile.publicInputs }, () => 0n);
  publicInputs[profile.offsets.chainId] = PCASH_CHAIN_ID;
  publicInputs[1] = 9n;
  for (let i = 0; i < profile.inputs; i++) publicInputs[profile.offsets.nullifiers + i] = BigInt(100 + i);
  publicInputs[profile.offsets.deliveryCommitment] = deliveryCommitment(outputData, arena);
  publicInputs[profile.offsets.nativeBurnAmount] = nativeBurnAmount;
  publicInputs[profile.offsets.validUntil] = 1_000n;
  return encodePrivateValueTransaction({
    shape, publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData, arena,
    ...(accountCreation === undefined ? {} : { accountCreation }),
  });
}

function admission(contentHash: string): SubmitRawTransactionResult {
  return {
    contentHash,
    statementId: `0x${"01".repeat(32)}`,
    stableId: `0x${"02".repeat(32)}`,
    status: "ready",
    headCheckedBlock: 1n,
    headCheckedBlockHash: `0x${"03".repeat(32)}`,
  };
}

describe("transactionIdentity", () => {
  it("names exact bytes by their keccak content hash", () => {
    expect(transactionIdentity(signedCreation)).toEqual({
      contentHash: toHex(keccak256(signedCreation)),
      transactionHex: toHex(signedCreation),
    });
  });
});

describe("assertMempoolAdmissible", () => {
  it("admits an accepted transaction type", () => {
    expect(() => assertMempoolAdmissible(status(), signedCreation)).not.toThrow();
  });

  it("refuses a transaction type the node does not accept", () => {
    expect(() => assertMempoolAdmissible(status([0]), signedCreation)).toThrow(/0x01 is not accepted/);
  });

  it("refuses a direct account creation, which only its owner can publish", () => {
    expect(() => assertMempoolAdmissible(status(), directCreation)).toThrow(/dedicated owner L1/);
  });

  it("refuses a burn below the next block's base fee times the transaction's units above the waiver", () => {
    // S spends 4 nullifiers: at a base fee of B it must burn at least 4B.
    const B = MAX_WAIVED_BASE_FEE + 1n;
    expect(() => assertProtocolFeeCovered(status([0], B), privateValueEntry(4n * B))).not.toThrow();
    expect(() => assertProtocolFeeCovered(status([0], B), privateValueEntry(4n * B - 1n))).toThrow(ProtocolFeeTooLowError);
    // L spends 32.
    expect(() => assertProtocolFeeCovered(status([0], B), privateValueEntry(32n * B, 1))).not.toThrow();
    expect(() => assertProtocolFeeCovered(status([0], B), privateValueEntry(32n * B - 1n, 1))).toThrow(`protocol fee is now ${32n * B}`);
    // A zero or waived fee accepts a zero burn.
    expect(() => assertProtocolFeeCovered(status([0], 0n), privateValueEntry(0n))).not.toThrow();
    expect(() => assertProtocolFeeCovered(status([0], MAX_WAIVED_BASE_FEE), privateValueEntry(0n, 1))).not.toThrow();
  });

  it("leaves an attached account out of the units, since only the node knows whether it inserts", () => {
    const B = MAX_WAIVED_BASE_FEE + 1n;
    const attached = privateValueEntry(4n * B, 0, { kind: "user", transactionBytes: signedCreation });
    expect(() => assertProtocolFeeCovered(status([0, 1], B), attached)).not.toThrow();
    expect(() => assertProtocolFeeCovered(status([0, 1], B), privateValueEntry(4n * B - 1n, 0, { kind: "user", transactionBytes: signedCreation })))
      .toThrow(ProtocolFeeTooLowError);
  });

  it("admits a standalone creation only while the base fee is zero, which the waiver does not change", () => {
    expect(() => assertProtocolFeeCovered(status([0, 1], 0n), signedCreation)).not.toThrow();
    let refusal: unknown;
    try { assertProtocolFeeCovered(status([0, 1], 1n), signedCreation); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(ProtocolFeeTooLowError);
    expect((refusal as ProtocolFeeTooLowError).requiredFee).toBe(ACCOUNT_WEIGHT);
    expect((refusal as ProtocolFeeTooLowError).nativeBurnAmount).toBe(0n);
  });
});

describe("admitTransaction", () => {
  it("submits the exact hex and returns the node's admission", async () => {
    const submitted: string[] = [];
    const { contentHash, transactionHex } = transactionIdentity(signedCreation);
    const node = {
      submitRawTransaction: async (hex: string) => {
        submitted.push(hex);
        return admission(contentHash.toUpperCase().replace("0X", "0x"));
      },
    };
    await expect(admitTransaction(node, signedCreation)).resolves.toMatchObject({ status: "ready" });
    expect(submitted).toEqual([transactionHex]);
  });

  it("rejects an admission of different content", async () => {
    const node = { submitRawTransaction: async () => admission(`0x${"ff".repeat(32)}`) };
    await expect(admitTransaction(node, signedCreation)).rejects.toThrow(/node admitted content 0xff/);
  });

  it("resubmits while the node's admission queue is full", async () => {
    const { contentHash } = transactionIdentity(signedCreation);
    let calls = 0;
    const node = {
      submitRawTransaction: async () => {
        calls += 1;
        if (calls < 3) throw busy();
        return admission(contentHash);
      },
    };
    await expect(admitTransaction(node, signedCreation)).resolves.toMatchObject({ contentHash });
    expect(calls).toBe(3);
  });

  it("stops resubmitting once the node stays busy past the retry window, and never retries other refusals", async () => {
    let calls = 0;
    const alwaysBusy = { submitRawTransaction: async (): Promise<SubmitRawTransactionResult> => { calls += 1; throw busy(); } };
    await expect(admitTransaction(alwaysBusy, signedCreation, 0)).rejects.toThrow(/admission queue is full/);
    expect(calls).toBe(1);

    for (const refusal of [
      new PcashNodeRpcError({ code: -32011, message: "invalid transaction: proof rejected" }, { method: "pcash_submitRawTransaction", url: "http://node" }),
      new PcashNodeRpcError({ code: -32017, message: "transaction is ineligible at the current state: NullifierAlreadySpent" }, { method: "pcash_submitRawTransaction", url: "http://node" }),
      new PcashNodeRpcError({ code: -32013, message: "verification unavailable: verifier timed out" }, { method: "pcash_submitRawTransaction", url: "http://node" }),
    ]) {
      calls = 0;
      const refusing = { submitRawTransaction: async (): Promise<SubmitRawTransactionResult> => { calls += 1; throw refusal; } };
      await expect(admitTransaction(refusing, signedCreation)).rejects.toBe(refusal);
      expect(calls).toBe(1);
    }
  });
});

describe("isAdmissionRefusal", () => {
  const nodeError = (code: number) => new PcashNodeRpcError({ code, message: "refused" }, { method: "pcash_submitRawTransaction", url: "http://node" });

  it("names the node's pre-insert refusals", () => {
    for (const code of [-32602, -32010, -32011, -32012, -32015, -32016, -32017]) expect(isAdmissionRefusal(nodeError(code))).toBe(true);
  });

  it("leaves failures that may follow an insert, and non-node errors, in doubt", () => {
    for (const code of [-32013, -32014, -32603, -32000]) expect(isAdmissionRefusal(nodeError(code))).toBe(false);
    expect(isAdmissionRefusal(new Error("connection reset"))).toBe(false);
  });
});

describe("isProtocolFeeTooLowRefusal", () => {
  const refusal = (code: number, message: string) =>
    new PcashNodeRpcError({ code, message }, { method: "pcash_submitRawTransaction", url: "http://node" });

  it("names the node's state refusal for a burn below the protocol fee", () => {
    const fee = refusal(-32017, "transaction is ineligible at the current state: ProtocolFeeTooLow");
    expect(isProtocolFeeTooLowRefusal(fee)).toBe(true);
    expect(isAdmissionRefusal(fee)).toBe(true);
  });

  it("does not match other state refusals, other codes, or other errors", () => {
    expect(isProtocolFeeTooLowRefusal(refusal(-32017, "transaction is ineligible at the current state: NullifierAlreadySpent"))).toBe(false);
    expect(isProtocolFeeTooLowRefusal(refusal(-32011, "invalid transaction: ProtocolFeeTooLow"))).toBe(false);
    expect(isProtocolFeeTooLowRefusal(new Error("ProtocolFeeTooLow"))).toBe(false);
  });
});

function busy(): PcashNodeRpcError {
  return new PcashNodeRpcError(
    { code: -32016, message: "node is busy: mempool admission queue is full" },
    { method: "pcash_submitRawTransaction", url: "http://node" },
  );
}
