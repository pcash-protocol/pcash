import { describe, expect, it } from "vitest";
import {
  describeEffect,
  etherscanTransactionUrl,
  failureOperands,
  formatBytes,
  formatKind,
  describeFailure,
  outcomeLabel,
  isFinalized,
  parseSearchTarget,
  relativeTime,
  shortHex,
} from "./format.ts";

const HASH = `0x${"ab".repeat(32)}`;

describe("parseSearchTarget", () => {
  it("resolves by shape where it can", () => {
    expect(parseSearchTarget("42")).toEqual({ kind: "block", number: 42n });
    expect(parseSearchTarget(`0x${"11".repeat(20)}`).kind).toBe("address");
    expect(parseSearchTarget("alice.eth")).toEqual({ kind: "name", name: "alice.eth" });
  });

  it("leaves a 32-byte hash for the search page to resolve", () => {
    // The same hash can name a transaction id, a content hash, a block hash,
    // or an L1 transaction hash. Shape alone cannot pick one.
    expect(parseSearchTarget(HASH)).toEqual({ kind: "hash", hash: HASH });
  });

  it("rejects a bare handle", () => {
    expect(() => parseSearchTarget("bob")).toThrow(/block number/);
    expect(() => parseSearchTarget("0x1234")).toThrow(/block number/);
  });
});

describe("describeEffect", () => {
  it("reports the note-set change for a payment", () => {
    expect(describeEffect({
      kind: "privateValue",
      outcome: "succeeded",
      nullifiers: [HASH, HASH],
      outputsAdded: 2n,
      account: null,
    })).toBe("2 in → 2 out");
  });

  it("reports the account address for an account write", () => {
    expect(describeEffect({
      kind: "userAccountCreation",
      outcome: "succeeded",
      nullifiers: null,
      outputsAdded: 0n,
      account: { address: "0xabc" },
    })).toBe("0xabc");
  });

  it("says nothing happened when the transaction failed", () => {
    expect(describeEffect({
      kind: "privateValue",
      outcome: "nullifierAlreadySpent",
      nullifiers: [HASH],
      outputsAdded: 0n,
      account: null,
    })).toContain("failed");
  });
});

describe("failureOperands", () => {
  it("names the exact nullifier and links the transaction that spent it first", () => {
    const operands = failureOperands({
      type: "nullifierAlreadySpent",
      inputSlot: 1n,
      nullifier: HASH,
      spendingTransactionId: `0x${"cd".repeat(32)}`,
    });
    expect(operands.map((operand) => operand.label)).toEqual(["Nullifier", "Operand", "First spent in"]);
    expect(operands[1]?.value).toBe("input 2 of 4");
    expect(operands[2]?.link).toEqual({ kind: "transaction", value: `0x${"cd".repeat(32)}` });
  });

  it("numbers user-facing inputs from one across failure reasons", () => {
    expect(failureOperands({ type: "zeroNullifier", inputSlot: 0n })).toEqual([{ label: "Operand", value: "input 1" }]);
    expect(failureOperands({ type: "duplicateInputNullifier", nullifier: HASH, firstInputSlot: 0n, duplicateInputSlot: 3n }).slice(1)).toEqual([
      { label: "First input", value: "1" },
      { label: "Duplicate input", value: "4" },
    ]);
  });

  it("names the required and delivering carrier contexts of a mismatch", () => {
    const delivered = `0x${"ef".repeat(32)}`;
    expect(failureOperands({ type: "carrierContextMismatch", required: HASH, carrier: delivered })).toEqual([
      { label: "Required carrier context", value: HASH },
      { label: "Delivering carrier context", value: delivered },
    ]);
    expect(describeFailure("carrierContextMismatch"))
      .toBe("This transaction required a different carrier than the one that delivered it.");
  });

  it("falls back to the detail's own fields for a shape it does not name", () => {
    const operands = failureOperands({
      type: "selectorsNotStrictlyIncreasing", previousFunctionIndex: 1n,
      previousSelector: 5n, functionIndex: 2n, selector: 4n,
    });
    expect(operands).toEqual([
      { label: "Previous Function Index", value: "1" },
      { label: "Previous Selector", value: "5" },
      { label: "Function Index", value: "2" },
      { label: "Selector", value: "4" },
    ]);
  });
});

describe("formatting", () => {
  it("names kinds and outcomes in reader vocabulary", () => {
    expect(formatKind("privateValue")).toBe("Private payment");
    expect(outcomeLabel("succeeded")).toBe("Succeeded");
    expect(outcomeLabel("nullifierAlreadySpent")).toBe("Failed");
    expect(describeFailure("recentPcashBlockNotInWindow"))
      .toBe("This transaction referenced a PCASH block that was too old by the time it was included.");
  });

  it("shortens a hash without losing either end", () => {
    expect(shortHex(HASH)).toBe(`${HASH.slice(0, 10)}…${HASH.slice(-8)}`);
    expect(shortHex("0xabc")).toBe("0xabc");
  });

  it("scales age and size", () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(BigInt(now / 1000 - 5), now)).toBe("5s");
    expect(relativeTime(BigInt(now / 1000 - 3600), now)).toBe("1h");
    expect(formatBytes(512n)).toBe("512 B");
    expect(formatBytes(2048n)).toBe("2.0 KB");
  });
});

describe("finality", () => {
  it("treats an unknown finalized height as not final", () => {
    expect(isFinalized(5n, null)).toBe(false);
    expect(isFinalized(5n, 5n)).toBe(true);
    expect(isFinalized(6n, 5n)).toBe(false);
  });
});

describe("etherscanTransactionUrl", () => {
  it("links the known L1 chains and nothing else", () => {
    expect(etherscanTransactionUrl(1, HASH)).toBe(`https://etherscan.io/tx/${HASH}`);
    expect(etherscanTransactionUrl(11155111, HASH)).toContain("sepolia");
    expect(etherscanTransactionUrl(31337, HASH)).toBeUndefined();
  });
});

it("labels the node contract transaction kind", () => { expect(formatKind("contractAccount")).toBe("Contract creation"); });

it("explains an incompatible creation attachment", () => {
  expect(describeFailure("accountCreationMismatch")).toContain("does not match");
});
