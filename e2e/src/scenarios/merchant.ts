import assert from "node:assert/strict";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { memoSchema } from "@pcash/sdk/delivery";
import { inspectPaymentDisclosure, type PaymentDisclosure, type Wallet } from "@pcash/sdk/wallet";
import { createWalletProvers } from "@pcash/sdk/wallet/node";
import { openNodeWallet } from "@pcash/wallet";
import type { ScenarioFixture } from "../fixture/scenarioFixture.ts";
import { eventually } from "../framework/eventually.ts";
import { setupUserWallets } from "./setup.ts";

// docs/guides/merchant-payments.md quotes the functions before
// runMerchantScenario verbatim, and e2e/test/merchant.test.ts holds the two
// equal.

/** What a merchant gives a customer: where to pay, how much, and the reference to quote. */
export interface Invoice {
  id: string;
  /** The merchant's address, lowercase 0x-hex. */
  merchant: string;
  receiveCode: string;
  amount: bigint;
}

export async function createInvoice(merchant: Wallet, id: string, amount: bigint): Promise<Invoice> {
  const { address, extendedCode } = await merchant.receiveCode();
  return { id, merchant: address, receiveCode: extendedCode, amount };
}

export async function payInvoice(customer: Wallet, invoice: Invoice, { amount = invoice.amount, installment = false } = {}) {
  return customer.send({
    to: invoice.receiveCode,
    amount,
    data: { recipients: [{ to: invoice.receiveCode, records: [memoSchema.encode(invoice.id)] }] },
    newAction: installment,
  });
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export async function invoiceStatus(merchant: Wallet, invoice: Invoice): Promise<"unpaid" | "underpaid" | "paid" | "final"> {
  await merchant.sync();
  const { finalizedThrough } = await merchant.snapshot();
  const activity = await merchant.nativeActivity({ recoverHistory: true });
  if (activity.state !== "ready") throw new Error(`activity is unavailable: ${activity.reason}`);
  let received = 0n;
  let final = 0n;
  for (const entry of activity.entries) {
    for (const message of entry.messages ?? []) {
      if (text(message.memo) !== invoice.id) continue;
      received += message.amount;
      if (finalizedThrough !== null && entry.blockNumber <= finalizedThrough.pcashNumber) final += message.amount;
    }
  }
  if (final >= invoice.amount) return "final";
  if (received >= invoice.amount) return "paid";
  return received === 0n ? "unpaid" : "underpaid";
}

export async function invoiceReceipts(customer: Wallet, invoice: Invoice): Promise<PaymentDisclosure[]> {
  await customer.sync();
  const activity = await customer.nativeActivity({ recoverHistory: true });
  if (activity.state !== "ready") throw new Error(`activity is unavailable: ${activity.reason}`);
  return activity.entries.flatMap((entry) => entry.sent ?? [])
    .filter((output) => output.recipientAddress === BigInt(invoice.merchant) && text(output.memo) === invoice.id)
    .flatMap((output) => output.disclosure === undefined ? [] : [output.disclosure]);
}

export async function verifiedAmount(node: PcashNodeClient, invoice: Invoice, receipts: readonly PaymentDisclosure[]): Promise<bigint> {
  const counted = new Set<string>();
  let total = 0n;
  for (const receipt of receipts) {
    const key = `${receipt.contentHash.toLowerCase()}:${receipt.slot}`;
    if (counted.has(key)) continue;
    counted.add(key);
    const payment = await inspectPaymentDisclosure(node, receipt);
    if (payment.status === "landed" && payment.finalized && payment.recipient === invoice.merchant
      && payment.assetId === 0n && payment.memo === invoice.id) total += payment.amount;
  }
  return total;
}

/**
 * A merchant invoice, end to end: the customer pays it in two equal
 * installments with the invoice ID as the memo; the merchant's wallet sees it
 * underpaid, then final, and a later payment under the same ID leaves it
 * final; a wallet restored from the merchant's keys alone reaches the same
 * status; and the customer's receipts let a party with only a node confirm
 * the amount, while a receipt with another payment's key opens nothing.
 */
export async function runMerchantScenario(fixture: ScenarioFixture): Promise<void> {
  const balances = await setupUserWallets(fixture, { actors: ["M", "C"], accounts: ["M", "C"], funded: ["C"] });
  const { M, C } = fixture.actors;
  if (M === undefined || C === undefined) throw new Error("merchant actors are missing");
  await M.close();
  const node = fixture.nodeA.client;
  const openMerchant = (name: string) => openNodeWallet({
    dataDir: fixture.artifacts.path(name), node, profile: M.wallet, signer: M.signer, provers: createWalletProvers("native"),
  });
  const customer = await C.client();

  const merchant = await openMerchant("merchant");
  let invoice: Invoice;
  let payments: string[];
  try {
    const part = balances.C! / 8n;
    invoice = await createInvoice(merchant, "INV-1001", 2n * part);
    assert.equal(invoice.merchant, M.address);
    assert.equal(await invoiceStatus(merchant, invoice), "unpaid");

    const first = await payInvoice(customer, invoice, { amount: part });
    await fixture.waitForAcceptedAcrossNodes(first.contentHash, "merchant-first-payment");
    assert.equal(await invoiceStatus(merchant, invoice), "underpaid");

    const second = await payInvoice(customer, invoice, { amount: part, installment: true });
    assert.notEqual(second.contentHash, first.contentHash, "an installment is a new payment");
    await fixture.waitForAcceptedAcrossNodes(second.contentHash, "merchant-second-payment");
    await eventually("the invoice is final", () => invoiceStatus(merchant, invoice), (status) => status === "final");
    assert.equal((await customer.paymentFate(second.contentHash)).state, "confirmed");

    // Anyone who knows the ID can pay toward it; that never takes a final invoice back.
    const extra = await payInvoice(customer, invoice, { amount: 1n, installment: true });
    await fixture.waitForAcceptedAcrossNodes(extra.contentHash, "merchant-extra-payment");
    assert.equal(await invoiceStatus(merchant, invoice), "final");
    payments = [first.contentHash, second.contentHash, extra.contentHash];
  } finally { await merchant.close(); }

  // The merchant's database is gone: its keys alone recover the invoice's payments and their memos.
  const restored = await openMerchant("merchant-restored");
  try {
    assert.equal(await invoiceStatus(restored, invoice), "final");
  } finally { await restored.close(); }

  const receipts = await invoiceReceipts(customer, invoice);
  assert.deepEqual(receipts.map((receipt) => receipt.contentHash).sort(), payments.map((hash) => hash.toLowerCase()).sort());
  const paid = invoice.amount + 1n;
  await eventually("the receipts verify", () => verifiedAmount(node, invoice, receipts), (amount) => amount === paid);
  assert.equal(await verifiedAmount(node, invoice, [...receipts, ...receipts]), paid, "a repeated receipt counts once");
  const swapped = { ...receipts[0]!, disclosureKey: receipts[1]!.disclosureKey };
  assert.equal((await inspectPaymentDisclosure(node, swapped)).status, "invalid", "another payment's key opens nothing");
  const shown = await inspectPaymentDisclosure(node, receipts[0]!);
  assert.ok(shown.status === "landed" && shown.sender === undefined, "a receipt shows no sender the customer did not include");
  fixture.artifacts.record("merchant-complete", { invoice: invoice.id, payments });
}
