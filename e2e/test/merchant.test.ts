import { readFileSync } from "node:fs";
import type { Wallet, WalletNativeActivityEntry } from "@pcash/sdk/wallet";
import { describe, expect, it } from "vitest";
import { invoiceStatus, type Invoice } from "../src/scenarios/merchant.ts";

const guide = readFileSync(new URL("../../docs/guides/merchant-payments.md", import.meta.url), "utf8");
const scenario = readFileSync(new URL("../src/scenarios/merchant.ts", import.meta.url), "utf8");

it("the merchant payments guide quotes the merchant scenario verbatim", () => {
  const blocks = [...guide.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((match) => match[1]!);
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) expect(scenario).toContain(block);
});

describe("an invoice's status", () => {
  const invoice: Invoice = { id: "INV-1", merchant: `0x${"11".repeat(20)}`, receiveCode: "code", amount: 100n };
  const note = (amount: bigint, memo: string) => ({ amount, memo: new TextEncoder().encode(memo), sender: null });
  const entry = (blockNumber: bigint, ...messages: ReturnType<typeof note>[]): WalletNativeActivityEntry => ({
    transactionId: `0x${blockNumber.toString(16).padStart(64, "0")}`, direction: "received",
    amount: messages.reduce((total, message) => total + message.amount, 0n),
    blockNumber, blockHash: "0x", timestamp: 0n, payout: null, commitments: [], messages,
  });
  const merchant = (finalized: bigint, entries: WalletNativeActivityEntry[]) => ({
    sync: async () => undefined,
    snapshot: async () => ({ finalizedThrough: { pcashNumber: finalized, pcashHash: "0x" } }),
    nativeActivity: async () => ({ state: "ready", entries, pcashNumber: 0n, pcashHash: "0x" }),
  }) as unknown as Wallet;

  it("counts only the notes that quote the invoice, not the rest of their transaction", async () => {
    expect(await invoiceStatus(merchant(9n, [entry(5n, note(1n, "INV-1"), note(99n, "INV-2"))]), invoice)).toBe("underpaid");
  });

  it("is final once finalized notes cover it, whatever arrives later", async () => {
    expect(await invoiceStatus(merchant(4n, [entry(5n, note(100n, "INV-1"))]), invoice)).toBe("paid");
    expect(await invoiceStatus(merchant(5n, [entry(5n, note(100n, "INV-1")), entry(6n, note(1n, "INV-1"))]), invoice)).toBe("final");
    expect(await invoiceStatus(merchant(5n, [entry(5n, note(60n, "INV-1")), entry(6n, note(40n, "INV-1"))]), invoice)).toBe("paid");
    expect(await invoiceStatus(merchant(5n, []), invoice)).toBe("unpaid");
  });
});
