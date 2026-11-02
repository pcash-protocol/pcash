import { describe, expect, it } from "vitest";
import {
  assertTransactionTypeAccepted,
  selectBatchVersion,
  selectPrivateValueTransactionType,
  transactionTypeOf,
} from "../src/protocol/capabilities.ts";
import { VERSION } from "../src/protocol/codec.ts";

describe("wire capabilities", () => {
  it("checks transaction admission independently from batch encoding", () => {
    const status = { acceptedTransactionTypes: [0, 1, 2], acceptedBatchVersions: [VERSION] };
    expect(() => assertTransactionTypeAccepted(status, 0)).not.toThrow();
    expect(() => assertTransactionTypeAccepted(status, 3)).toThrow(/transaction type 0x03/);
    expect(() => assertTransactionTypeAccepted(status, 2)).not.toThrow();
    expect(selectBatchVersion(status)).toBe(VERSION);
  });

  it("reads the immutable type from the transaction bytes", () => {
    expect(transactionTypeOf(Uint8Array.of(0, 1, 2))).toBe(0);
    expect(transactionTypeOf(Uint8Array.of(3, 1, 2))).toBe(3);
    expect(() => transactionTypeOf(new Uint8Array())).toThrow(/empty/);
    expect(() => transactionTypeOf(Uint8Array.of(4))).toThrow(/unknown transaction type 0x04/);
  });

  it("fails when no supported batch version is accepted", () => {
    expect(() => selectBatchVersion({ acceptedBatchVersions: [] })).toThrow(/batch version/);
  });

  it("requires the head to admit the privateValue relation", () => {
    expect(selectPrivateValueTransactionType({ acceptedTransactionTypes: [0, 1, 2, 3] })).toBe(0);
    expect(() => selectPrivateValueTransactionType({ acceptedTransactionTypes: [1, 2, 3] }))
      .toThrow(/transaction type 0x00 is not accepted/);
  });
});
