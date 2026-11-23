# Merchant payments

A merchant needs four things from a payment system: a way to ask for a specific payment, a way to see it arrive and know when it is final, a way to recover when something goes wrong, and receipts that it or its customers can show someone else. On PCASH all four come from what every wallet already does. A payment carries records encrypted to its recipient, a wallet finds its payments by scanning the chain, and every output has its own disclosure key. None of it needs an account rule, a contract or a server beyond a PCASH node.

The code on this page is quoted from [`e2e/src/scenarios/merchant.ts`](../../e2e/src/scenarios/merchant.ts), which runs every step against local Ethereum and PCASH nodes with real proofs: `just e2e merchant`. Both wallets are SDK wallets opened with `openNodeWallet` from `@pcash/wallet`; a browser wallet exposes the same methods. The steps use these imports:

```ts
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { memoSchema } from "@pcash/sdk/delivery";
import { inspectPaymentDisclosure, type PaymentDisclosure, type Wallet } from "@pcash/sdk/wallet";
```

## Ask for a payment

An invoice is the merchant's receive code, an amount and a reference. The receive code carries the merchant's address and receive key, which is everything a wallet needs to pay it.

```ts
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
```

The invoice reaches the customer however the merchant likes: a QR code, a link, a checkout page. The merchant keeps its invoices; everything else it needs is on chain.

## Pay it

The customer's wallet pays the amount with the invoice ID as a memo. The memo is a record encrypted to the recipient, so only the merchant reads it. Like every PCASH payment, this one hides the sender, the recipient, the amount and the memo from everyone else.

A send that matches a payment the wallet has not yet seen finalized, with the same recipient, amount and memo, resumes that payment instead of paying again, so a customer who retries never pays twice. A second installment of the same amount is a new payment, so the helper passes `newAction` for it.

```ts
export async function payInvoice(customer: Wallet, invoice: Invoice, { amount = invoice.amount, installment = false } = {}) {
  return customer.send({
    to: invoice.receiveCode,
    amount,
    data: { recipients: [{ to: invoice.receiveCode, records: [memoSchema.encode(invoice.id)] }] },
    newAction: installment,
  });
}
```

## Confirm it

The merchant's wallet finds the payment by scanning, as it finds every payment, and reads its memo. The merchant adds up every note that quotes the invoice ID, so a customer who underpays can pay the rest under the same reference. The invoice is final once its finalized notes cover the amount.

```ts
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
```

A payment is paid as soon as an Ethereum block includes it. It is final once Ethereum finalizes that block, 13 to 19 minutes later. Until then a reorganization of Ethereum can drop it, so the merchant decides which status releases the goods: paid for a coffee, final for a car.

The memo is whatever the payer wrote, so anyone who knows an invoice ID can pay toward it. That only ever adds to the invoice, and a later payment never takes a final invoice back.

## Recover from failures

- **A payment that hasn't landed.** The customer's wallet journals the payment's exact bytes and can publish them again while they are valid. `customer.paymentFate(contentHash)` reads that journal as of the wallet's last sync: `pending` while some authorization of the payment can still land or has landed without being final, `confirmed` once one is final, and `cleared` once none can land. A payment the wallet rebuilds spends the same notes, so the old bytes and the new ones can't both land. The journal is the wallet's own: a wallet restored from keys reports `cleared` for every payment, so after a restore the customer checks its activity, which scanning does recover, before paying again.
- **A lost merchant database.** A wallet restored from the merchant's keys finds every payment and its memo again by scanning. The scenario opens a second wallet from the merchant's keys with an empty database and gets the same invoice status.
- **A reorganization.** Before finality, a reorganization of Ethereum can drop the block that carried a payment, and the merchant's wallet rolls the payment back with it. A merchant that waits for final never sees this.

## Receipts

Each output's disclosure key opens that output's envelope and its records ([specification](../protocol-spec.md#b4-delivery)). Only the payer's and the recipient's keys derive it. A receipt is that key with the output's location: the paying transaction's content hash and the output's slot. Both sides hold it, including after a restore from their keys: the customer's wallet on each output it paid (`output.disclosure`), and the merchant's on each payment it received (`message.disclosure`). The customer's wallet reads its receipts from its own activity:

```ts
export async function invoiceReceipts(customer: Wallet, invoice: Invoice): Promise<PaymentDisclosure[]> {
  await customer.sync();
  const activity = await customer.nativeActivity({ recoverHistory: true });
  if (activity.state !== "ready") throw new Error(`activity is unavailable: ${activity.reason}`);
  return activity.entries.flatMap((entry) => entry.sent ?? [])
    .filter((output) => output.recipientAddress === BigInt(invoice.merchant) && text(output.memo) === invoice.id)
    .flatMap((output) => output.disclosure === undefined ? [] : [output.disclosure]);
}
```

Anyone with a receipt and a PCASH node can check it. `inspectPaymentDisclosure` opens the one output, checks what it opens against the output commitment on chain, and returns the recipient, asset, amount, memo and any claimed sender, with whether Ethereum has finalized the payment. An accountant confirming an invoice counts each finalized receipt once:

```ts
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
```

A receipt opens that one payment and nothing else of either wallet: not the payer's other payments, not either party's balance, and not when the merchant spends the money. A key from another payment opens nothing. It does name the paying transaction, so it ties the payment to what is public about that transaction, such as the Ethereum address that published it when the customer published directly rather than through a relayer.

A receipt proves the payment, not who presents it or who paid. Once shown, anyone who saw it can show it again. What ties a payment to a customer is the memo: the invoice ID the merchant gave that customer. A payer can also add its address to a payment as a claimed sender, but that address is whatever the payer wrote.

## Run it

`just e2e merchant` starts Anvil and a PCASH node, funds a customer by mining, and runs the steps above: the customer pays the invoice in two equal installments, the merchant sees it underpaid and then final, a further payment under the same ID leaves it final, a wallet restored from the merchant's keys reaches the same status, and the customer's receipts verify with no wallet while a receipt carrying another payment's key is refused.
