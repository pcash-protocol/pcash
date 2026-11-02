import { describe, expect, it } from "vitest";
import { buildNativeTransfer } from "../src/builders/nativeTransfer.ts";
import { buildUserAccountCreation } from "../src/builders/userAccountCreation.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { buildContractBody, functionSelector } from "../src/protocol/contract.ts";
import {
  accountCreationAttachmentCommitment, accountCreationAttachmentSize, decodeTransaction,
  encodeAccountCreationAttachment, encodePrivateValueTransaction, encodeUserAccountCreation,
  privateValuePublicInputs, privateValueTransactionSize, WIRE_PROOF_BYTES,
} from "../src/protocol/codec.ts";
import { privateValueProfileFixture } from "./privateValueProfileFixtures.ts";

const contract = (nkRoot = 51n) => buildContractBody({
  nullifierKey: { publishesNkRoot: true, nkRoot },
  functions: [{ selector: functionSelector(0), applicationVkHash: 71n, configurationCommitment: 81n }],
});

describe("account creation attachments", () => {
  it.each([0, 1] as const)("binds a contract attachment in profile %i before readable approval", (shape) => {
    const { params } = privateValueProfileFixture({ shape, scenario: "minimal" });
    const accountCreation = { kind: "contract" as const, body: contract().body };
    const build = buildNativeTransfer({ ...params, accountCreation });
    const expected = accountCreationAttachmentCommitment(accountCreation, params.chainId);
    expect(build.transaction.global.accountCreationCommitment).toBe(expected);
    expect(build.publicInputs[PRIVATE_VALUE_PROFILES[shape === 0 ? "S" : "L"].offsets.accountCreationCommitment]).toBe(expected);
    expect((build.authorizationRequest!.typedData.message as Record<string, string>).accountCreationCommitment).toBe(expected.toString());
    const bytes = build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES));
    const decoded = decodeTransaction(bytes);
    if (decoded.kind !== 0) throw new Error("private value required");
    expect(decoded.accountCreation).toEqual(accountCreation);
    expect(privateValuePublicInputs(decoded)).toEqual(build.publicInputs);
    expect(bytes.length).toBe(privateValueTransactionSize(shape, accountCreation));
  });

  it("reconstructs a different statement when an attachment is stripped or substituted", () => {
    const { params } = privateValueProfileFixture({ shape: 0, scenario: "minimal" });
    const accountCreation = { kind: "contract" as const, body: contract().body };
    const build = buildNativeTransfer({ ...params, accountCreation });
    const proof = new Uint8Array(WIRE_PROOF_BYTES);
    for (const replacement of [undefined, { kind: "contract" as const, body: contract(52n).body }]) {
      const bytes = encodePrivateValueTransaction({ ...build, proof, ...(replacement === undefined ? {} : { accountCreation: replacement }) });
      const decoded = decodeTransaction(bytes);
      if (decoded.kind !== 0) throw new Error("private value required");
      const statement = privateValuePublicInputs(decoded);
      expect(statement.slice(0, -1)).toEqual(build.publicInputs.slice(0, -1));
      expect(statement.at(-1)).not.toBe(build.publicInputs.at(-1));
    }
  });

  it("accepts signed user bytes and rejects direct mode or another chain", () => {
    const { params, wallet } = privateValueProfileFixture({ shape: 0, scenario: "minimal" });
    const creation = buildUserAccountCreation({
      chainId: params.chainId, wallet, authorizationResolver: params.authorizationResolver!,
      unsafeOpaqueRuleSetCommitment: 55n, recentPcashBlockHash: params.recentPcashBlockHash, validUntilTimestamp: params.validUntilTimestamp,
    });
    const transactionBytes = encodeUserAccountCreation(params.chainId, creation.body);
    const attachment = { kind: "user" as const, transactionBytes };
    expect(encodeAccountCreationAttachment(attachment, params.chainId)).toEqual(new Uint8Array([1, ...creation.body]));
    expect(accountCreationAttachmentSize(attachment)).toBe(1 + creation.body.length);
    const direct = creation.body.slice(0, -65); direct[0] = 0;
    expect(() => encodeAccountCreationAttachment({ kind: "user", transactionBytes: encodeUserAccountCreation(params.chainId, direct) }, params.chainId)).toThrow(/signed/);
    expect(() => encodeAccountCreationAttachment(attachment, BigInt(params.chainId) + 1n)).toThrow(/chain/);
    const build = buildNativeTransfer({ ...params, accountCreation: attachment });
    const decoded = decodeTransaction(build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)));
    if (decoded.kind !== 0) throw new Error("private value required");
    expect(privateValuePublicInputs(decoded)).toEqual(build.publicInputs);
    expect(decoded.accountCreation).toEqual(attachment);
  });

  it("rejects unknown tags, truncated attachments, and trailing account bytes", () => {
    const { build } = privateValueProfileFixture({ shape: 0, scenario: "minimal" });
    const bytes = build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES));
    for (const tag of [1, 2, 3, 255]) {
      const malformed = bytes.slice(); malformed[malformed.length - 1] = tag;
      expect(() => decodeTransaction(malformed)).toThrow();
    }
    expect(() => decodeTransaction(bytes.slice(0, -1))).toThrow(/unexpected end/);
    expect(() => encodeAccountCreationAttachment({ kind: "contract", body: new Uint8Array([...contract().body, 0]) }, build.pcashChainId)).toThrow(/trailing/);
    expect(accountCreationAttachmentCommitment(undefined, build.pcashChainId)).toBe(0n);
    expect(accountCreationAttachmentSize()).toBe(1);
  });
});
