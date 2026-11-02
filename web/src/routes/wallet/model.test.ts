import { describe, expect, it } from "vitest";
import { buildExtendedCode } from "@pcash/sdk/delivery";
import {
  classifyUnregisteredAddress,
  DEFAULT_AUTHORIZATION_METHODS,
  describeRecipient,
  recipientFromScan,
  outcomeMessage,
  paymentActivityStatus,
  sendIntent,
  shortValue,
  withoutRetrySelection,
} from "./model.ts";

const NO_RECORDS = { memo: "", includeSender: false };

describe("Wallet route model", () => {
  it("judges an address without PCASH from its Ethereum code and transaction count", () => {
    expect(classifyUnregisteredAddress(undefined, 4)).toBe("regular");
    expect(classifyUnregisteredAddress("0x", 0)).toBe("never-used");
    expect(classifyUnregisteredAddress("0x6080604052", 9)).toBe("smart-contract");
    // An EIP-7702 delegation keeps the account signing as itself; any other code is a contract.
    expect(classifyUnregisteredAddress(`0xEF0100${"ab".repeat(20)}`, 1)).toBe("regular");
    expect(classifyUnregisteredAddress(`0xef0100${"ab".repeat(21)}`, 1)).toBe("smart-contract");
  });

  it("builds a funding-neutral payment intent", () => {
    expect(sendIntent({ to: " pcash:recipient ", amount: "12", fee: "3", speed: "slow", ...NO_RECORDS })).toEqual({
      to: "pcash:recipient",
      amount: 12_000_000_000_000_000_000n,
      openFeeAmount: 3_000_000_000_000_000_000n,
      newAction: true,
    });
    expect(sendIntent({ to: "pcash:recipient", amount: "12", fee: "", speed: "slow", ...NO_RECORDS })).toEqual({
      to: "pcash:recipient",
      amount: 12_000_000_000_000_000_000n,
      newAction: true,
    });
    expect(sendIntent({ to: "pcash:recipient", amount: "12", fee: "0", speed: "slow", ...NO_RECORDS }).openFeeAmount).toBe(0n);
  });

  it("publishes a fast payment from the sender's own Ethereum wallet with zero PCASH fee", () => {
    expect(sendIntent({ to: "pcash:recipient", amount: "12", fee: "3", speed: "fast", ...NO_RECORDS })).toEqual({
      to: "pcash:recipient",
      amount: 12_000_000_000_000_000_000n,
      publication: "self",
      newAction: true,
    });
  });

  it("drops only the exact-retry selection when a payment is no longer retained", () => {
    expect(withoutRetrySelection({
      to: "pcash:recipient",
      amount: 12n,
      openFeeAmount: 3n,
      retryContentHash: `0x${"11".repeat(32)}`,
    })).toEqual({ to: "pcash:recipient", amount: 12n, openFeeAmount: 3n, newAction: true });
    // A sponsored payment keeps its explicit zero fee; an unset fee stays unset
    // rather than becoming an explicit undefined the preflight would reject.
    expect(withoutRetrySelection({ to: "recipient", amount: 1n, openFeeAmount: 0n }).openFeeAmount).toBe(0n);
    expect(Object.hasOwn(withoutRetrySelection({ to: "recipient", amount: 1n }), "openFeeAmount")).toBe(false);
    // The memo and sender choice are part of the payment.
    expect(withoutRetrySelection({ to: "recipient", amount: 1n, memo: "lunch", includeSender: true, retryContentHash: `0x${"11".repeat(32)}` }))
      .toEqual({ to: "recipient", amount: 1n, memo: "lunch", includeSender: true, newAction: true });
  });

  it("carries a memo and the sender only on a payment that creates a recipient note", () => {
    const draft = { to: "recipient", amount: "1", fee: "0", speed: "slow" as const, memo: "  lunch \n", includeSender: true };
    expect(sendIntent(draft)).toEqual({ to: "recipient", amount: 10n ** 18n, openFeeAmount: 0n, memo: "lunch", includeSender: true, newAction: true });
    expect(sendIntent({ ...draft, speed: "fast" })).toEqual({ to: "recipient", amount: 10n ** 18n, memo: "lunch", includeSender: true, publication: "self", newAction: true });
    expect(sendIntent({ ...draft, memo: " ", includeSender: false })).toEqual({ to: "recipient", amount: 10n ** 18n, openFeeAmount: 0n, newAction: true });
    // A zero payment creates none: the default sender choice is dropped and a memo refused.
    expect(sendIntent({ ...draft, amount: "0", memo: "" })).toEqual({ to: "recipient", amount: 0n, openFeeAmount: 0n, newAction: true });
    expect(() => sendIntent({ ...draft, amount: "0" })).toThrow("A zero payment can't carry a message.");
  });

  it("rejects invalid transfer fields before preflight", () => {
    expect(() => sendIntent({ to: "", amount: "1", fee: "0", speed: "slow", ...NO_RECORDS })).toThrow(/recipient/);
    expect(sendIntent({ to: "recipient", amount: "0", fee: "0", speed: "slow", ...NO_RECORDS })).toEqual({ to: "recipient", amount: 0n, openFeeAmount: 0n, newAction: true });
    expect(() => sendIntent({ to: "recipient", amount: "-1", fee: "0", speed: "slow", ...NO_RECORDS })).toThrow("Amount must be a whole number");
    expect(() => sendIntent({ to: "recipient", amount: "1", fee: "-1", speed: "slow", ...NO_RECORDS })).toThrow("Relayer fee must be a whole number");
    expect(sendIntent({ to: "recipient", amount: "1,500", fee: "0", speed: "slow", ...NO_RECORDS }).amount).toBe(1_500_000_000_000_000_000_000n);
    expect(() => sendIntent({ to: "recipient", amount: "1.5", fee: "0", speed: "slow", ...NO_RECORDS })).toThrow("Amount must be a whole number");
    expect(() => sendIntent({ to: "recipient", amount: "1", fee: "0.5", speed: "slow", ...NO_RECORDS })).toThrow("Relayer fee must be a whole number");
  });

  it("describes transaction states without exposing finality or reconciliation", () => {
    expect(outcomeMessage({ contentHash: "0x1234567890abcdef12345678", accepted: true, queued: false, settled: false, recovered: false }))
      .toBe("Transaction 0x12345678…12345678 is confirmed.");
    expect(outcomeMessage({ contentHash: "0x1234", accepted: true, queued: false, settled: true, recovered: false }))
      .toBe("Transaction 0x1234 is confirmed.");
    expect(outcomeMessage({ contentHash: "0x1234", accepted: false, queued: true, settled: false, recovered: false }))
      .toBe("Transaction 0x1234 is pending.");
    expect(outcomeMessage({ contentHash: "0x1234", accepted: false, queued: false, settled: true, recovered: false }))
      .toBe("The status of transaction 0x1234 could not be confirmed.");
  });

  it("derives the activity state from canonical receipts before the local mempool", () => {
    expect(paymentActivityStatus(true, true)).toBe("confirmed");
    expect(paymentActivityStatus(true, false)).toBe("confirmed");
    expect(paymentActivityStatus(false, true)).toBe("pending");
    expect(paymentActivityStatus(false, false)).toBe("unknown");
  });

  it("lists the six authorization methods installed by default", () => {
    expect(DEFAULT_AUTHORIZATION_METHODS.map(({ entryIndex, title }) => [entryIndex, title])).toEqual([
      [0, "Private payments"],
      [1, "Asset payments"],
      [2, "Asset burns"],
      [3, "Batch transfers"],
      [4, "Account changes"],
      [5, "Contract fee sponsorship"],
    ]);
  });

  it("names every installed rule without an opaque-signing entry", () => {
    for (const { title, description } of DEFAULT_AUTHORIZATION_METHODS) {
      expect(`${title} ${description}`.toLowerCase()).not.toContain("commitment");
    }
  });

  it("formats identifiers compactly", () => {
    expect(shortValue("0x1234")).toBe("0x1234");
    expect(shortValue("0x1234567890abcdef", 6, 4)).toBe("0x1234…cdef");
  });
});

describe("recipient resolution", () => {
  it("passes a plain address through, normalized", () => {
    expect(describeRecipient("  0xAABBCCDDEEFF00112233445566778899AABBCCDD  "))
      .toEqual({ kind: "address", address: "0xaabbccddeeff00112233445566778899aabbccdd" });
  });

  it("refuses hex that is not a 20-byte address", () => {
    const resolved = describeRecipient("0x1234");
    expect(resolved.kind).toBe("invalid");
    expect(resolved.kind === "invalid" && resolved.message).toContain("40 hex characters");
  });

  it("refuses anything else, including a receive code", () => {
    const code = buildExtendedCode({ chainId: 7n, address: 0x6593d0d3aaaabbbbccccddddeeeeffffa27d542cn, mlKemPublicKey: new Uint8Array(1184) });
    expect(describeRecipient(code)).toEqual({ kind: "invalid", message: "Enter an Ethereum address or ENS name." });
  });
});

describe("scanned recipients", () => {
  const address = `0x${"ab".repeat(20)}`;
  it("reads addresses, profile links and ethereum: URIs", () => {
    expect(recipientFromScan(`  ${address}  `)).toBe(address);
    expect(recipientFromScan(`https://pcash.example/${address}`)).toBe(address);
    expect(recipientFromScan("https://pcash.example/alice.eth")).toBe("alice.eth");
    expect(recipientFromScan(`ethereum:${address}@1`)).toBe(address);
    expect(recipientFromScan(`ethereum:pay-${address}/transfer?value=1`)).toBe(address);
    expect(recipientFromScan("https://example.com/no-recipient")).toBe("https://example.com/no-recipient");
  });
});
