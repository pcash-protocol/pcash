import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ReceiptResult, TransactionSummaryResult } from "@pcash/sdk/clients";
import type { StoredOffer } from "@pcash/marketplace/app";
import type { WalletPaymentActivity } from "../../lib/WalletProvider.tsx";
import type { TokenActivity } from "../../lib/tokenActivity.ts";

vi.mock("@pcash/marketplace/app", async (original) => ({
  ...await original<typeof import("@pcash/marketplace/app")>(),
  publicationIdentity: (publication: { terms: { id: string } }) => publication.terms.id,
  publicationContractAddress: () => `0x${"cc".repeat(20)}`,
}));
vi.mock("../../names/useEthereumName.ts", () => ({ useEthereumName: () => undefined }));
import { activityReceiptHashes, activityRows, shownState, type ActivitySources } from "./activityRows.tsx";

const PCASH = 10n ** 18n;
const OWNER = 0x12n;
const OWNER_HEX = `0x${"0".repeat(38)}12`;
const hash = (byte: string) => `0x${byte.repeat(32)}`;

function sources(overrides: Partial<ActivitySources>): ActivitySources {
  return { owner: OWNER, payments: [], canonical: [], historyCurrent: true, accountEvents: [], offers: [], sold: new Map(), purchased: new Map(), tokens: [], receipts: new Map(), pendingContentHashes: new Set(), ...overrides };
}
const text = (node: unknown) => renderToStaticMarkup(<MemoryRouter>{node as never}</MemoryRouter>).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
/** The text of each line of a row's note. */
const lines = (node: unknown) => (renderToStaticMarkup(<MemoryRouter>{node as never}</MemoryRouter>).match(/<span>.*?<\/span>/g) ?? []).map((line) => line.replace(/<[^>]+>/g, ""));
const receipt = (contentHash: string, transactionId: string, outcome: ReceiptResult["outcome"] = "succeeded") => ({ contentHash, transactionId, outcome } as ReceiptResult);
const publication = (id: string) => ({ reclaimAuthority: OWNER_HEX, terms: { id, assetId: "0", amount: (100n * PCASH).toString(), ethPriceWei: (10n ** 16n).toString(), deadlineT: "2000000000", seller: "1", router: "2" }, escrow: {} }) as unknown as StoredOffer["pub"];
const payment = (overrides: Partial<WalletPaymentActivity>): WalletPaymentActivity => ({
  kind: "payment", contentHash: hash("ab"), deliveryTarget: `0x${"34".repeat(20)}`, recipientAddress: `0x${"34".repeat(20)}`, includeSender: false, amount: 5n * PCASH,
  openFeeAmount: 0n, privateRelayFeeAmount: 0n, privateRelayRecipient: null, validUntilTimestamp: 2_000_000_000n, status: "finalized", ...overrides,
});

describe("activity rows", () => {
  it("names each canonical entry by what it was, and shows a local payment once", () => {
    const rows = activityRows(sources({
      payments: [payment({ receiptTxId: hash("0c") })],
      canonical: [
        { transactionId: hash("0c"), direction: "spent", amount: 5n * PCASH, blockNumber: 3n, blockHash: "0x03", timestamp: 300n, commitments: [], payout: null },
        { transactionId: null, direction: "received", amount: 7n * PCASH, blockNumber: 2n, blockHash: "0x02", timestamp: 200n, commitments: [], payout: { openFeeAmount: 2n * PCASH, issuanceAmount: 5n * PCASH } },
        { transactionId: hash("0d"), direction: "received", amount: 2n * PCASH, blockNumber: 1n, blockHash: "0x01", timestamp: 100n, commitments: [], payout: null },
      ],
    }));
    expect(rows.map((row) => [row.kind, text(row.title), row.href, row.at])).toEqual([
      ["sent", "Sent 5 PCASH to 0x343434…343434", `/tx/${hash("0c")}`, 300_000],
      ["mined", "Mined 7 PCASH", "/block/2", 200_000],
      ["received", "Received 2 PCASH", `/tx/${hash("0d")}`, 100_000],
    ]);
    expect(rows.every((row) => row.state.state === "complete")).toBe(true);
  });

  it("keeps a pending payment as one row before and after its canonical spend is synced", () => {
    const local = payment({ status: "pending" });
    expect(activityRows(sources({ payments: [local], canonical: [] }))).toHaveLength(1);
    // Synced before any receipt names the transaction id: the spend matches by content hash.
    const synced = activityRows(sources({ payments: [local], canonical: [
      { transactionId: hash("cd"), contentHash: hash("ab"), direction: "spent", amount: 5n * PCASH, blockNumber: 9n, blockHash: "0x09", timestamp: 900n, commitments: [], payout: null },
    ] }));
    expect(synced.map((row) => [row.id, row.at])).toEqual([[hash("ab"), 900_000]]);
  });

  it("shows only Pending, Failed and Expired, with a PCASH outcome's reason", () => {
    const rows = activityRows(sources({
      payments: (["pending", "unknown", "confirmed", "failed", "expired", "conflicted"] as const).map((status, index) => payment({ contentHash: hash(`0${index}`), status })),
      receipts: new Map([[hash("03"), receipt(hash("03"), hash("f3"), "expired")]]),
    }));
    const state = (index: number) => rows.find((row) => row.id === hash(`0${index}`))!.state;
    expect(state(0)).toEqual({ state: "pending", contentHash: hash("00") });
    // An unclear submission stays visible, as Pending with its recovery action.
    expect(state(1)).toEqual({ state: "pending", contentHash: hash("01") });
    expect(state(2)).toEqual({ state: "complete" });
    expect(state(3)).toEqual({ state: "failed", reason: "This transaction expired before it was included." });
    expect(state(4)).toEqual({ state: "expired" });
    expect(state(5)).toEqual({ state: "failed", reason: "Another transaction spent the same funds first." });
    expect(activityReceiptHashes(sources({ payments: [payment({ status: "failed" }), payment({ contentHash: hash("cd") })] }))).toEqual([hash("ab")]);
  });

  it("folds received issuance into a completed mining row and names unfinished mining plainly", () => {
    const mine = payment({ kind: "mine", amount: 0n, receiptTxId: hash("0c") });
    const canonical = [{ transactionId: hash("0c"), direction: "received" as const, amount: 5n * PCASH, blockNumber: 3n, blockHash: "0x03", timestamp: 300n, commitments: [], payout: { openFeeAmount: 0n, issuanceAmount: 5n * PCASH } }];
    const rows = activityRows(sources({ payments: [mine], canonical }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("mined");
    expect(rows[0]!.at).toBe(300_000);
    expect(text(rows[0]!.title)).toBe("Mined 5 PCASH");
    expect(text(activityRows(sources({ payments: [{ ...mine, status: "pending" }], canonical }))[0]!.title)).toBe("Mining");
    expect(text(activityRows(sources({ payments: [mine], canonical: undefined, historyCurrent: false }))[0]!.title)).toBe("Mined PCASH");
  });

  it("shows a payment's memo as plain quoted text under its title", () => {
    const [row] = activityRows(sources({ payments: [payment({ memo: "Lunch\u202E for\n two", includeSender: true })] }));
    expect(text(row!.note)).toBe("“Lunch for two”");
    expect(activityRows(sources({ payments: [payment({})] }))[0]).not.toHaveProperty("note");
    expect(activityRows(sources({ payments: [payment({ memo: "\u200B" })] }))[0]).not.toHaveProperty("note");
  });

  it("shows what senders wrote into received notes, with any claimed sender as an unverified raw address", () => {
    const sender = 0x5656565656565656565656565656565656565656n;
    const [row] = activityRows(sources({ canonical: [{
      transactionId: hash("0d"), direction: "received", amount: 9n * PCASH, blockNumber: 1n, blockHash: "0x01", timestamp: 100n, commitments: [], payout: null,
      messages: [
        { memo: new TextEncoder().encode("Thanks"), sender },
        { memo: new Uint8Array(0), sender: 0x78n },
        { memo: Uint8Array.of(0x68, 0x69, 0xff), sender: null },
        { memo: new Uint8Array(0), sender: null },
      ],
    }] }));
    expect(lines(row!.note)).toEqual([
      "“Thanks” from 0x565656…565656 (unverified)",
      "From 0x000000…000078 (unverified)",
      "“hi\uFFFD”",
    ]);
    expect(renderToStaticMarkup(<MemoryRouter>{row!.note}</MemoryRouter>)).toContain(`<code title="0x${"56".repeat(20)}">`);
    expect(text(row!.title)).toBe("Received 9 PCASH");
  });

  it("names what a spend paid from its sender region when no local payment shows it", () => {
    const output = (byte: string, amount: bigint, memo: string) => ({ recipientAddress: BigInt(`0x${byte.repeat(20)}`), amount, memo: new TextEncoder().encode(memo), senderIncluded: true });
    const spent = (transactionId: string, sent: ReturnType<typeof output>[]) => ({ transactionId, direction: "spent" as const, amount: 8n * PCASH, blockNumber: 2n, blockHash: "0x02", timestamp: 200n, commitments: [], payout: null, sent });
    const [single] = activityRows(sources({ canonical: [spent(hash("0e"), [output("34", 7n * PCASH, "Rent")])] }));
    expect([single!.kind, text(single!.title), text(single!.note)]).toEqual(["sent", "Sent 7 PCASH to 0x343434…343434", "“Rent”"]);
    const [several] = activityRows(sources({ canonical: [spent(hash("0f"), [output("34", 3n * PCASH, "Rent"), output("56", 4n * PCASH, ""), output("78", PCASH, "Tip")])] }));
    expect(text(several!.title)).toBe("Sent 8 PCASH");
    expect(lines(several!.note)).toEqual(["“Rent”", "“Tip”"]);
    // A local payment row shows its own spend once, with its own memo.
    const rows = activityRows(sources({ payments: [payment({ receiptTxId: hash("0e"), memo: "Rent" })], canonical: [spent(hash("0e"), [output("34", 5n * PCASH, "Rent")])] }));
    expect(rows.map((row) => [text(row.title), text(row.note)])).toEqual([["Sent 5 PCASH to 0x343434…343434", "“Rent”"]]);
  });

  it("shows what senders wrote into a transaction that also spent this wallet's notes", () => {
    const entry = { transactionId: hash("1c"), direction: "spent" as const, amount: PCASH, blockNumber: 2n, blockHash: "0x02", timestamp: 200n, commitments: [], payout: null,
      messages: [{ memo: new TextEncoder().encode("Swap"), sender: null }] };
    const [row] = activityRows(sources({ canonical: [entry] }));
    expect([text(row!.title), text(row!.note)]).toEqual(["Sent 1 PCASH", "“Swap”"]);
  });

  it("names what a payment paid even when issuance it earned offsets or outweighs the spend", () => {
    const sent = [{ recipientAddress: BigInt(`0x${"34".repeat(20)}`), amount: 10n * PCASH, memo: new TextEncoder().encode("Dinner"), senderIncluded: false }];
    const entry = (transactionId: string, direction: "received" | "spent", amount: bigint, issuanceAmount: bigint) => ({
      transactionId, direction, amount, blockNumber: 2n, blockHash: "0x02", timestamp: 200n, commitments: [], payout: { openFeeAmount: 0n, issuanceAmount }, sent,
    });
    const rows = activityRows(sources({ canonical: [entry(hash("1a"), "received", 10n * PCASH, 20n * PCASH), entry(hash("1b"), "spent", 0n, 10n * PCASH)] }));
    expect(rows.map((row) => [row.kind, text(row.title), text(row.note)])).toEqual([
      ["sent", "Sent 10 PCASH to 0x343434…343434", "“Dinner”"],
      ["sent", "Sent 10 PCASH to 0x343434…343434", "“Dinner”"],
    ]);
  });

  it("turns account events into setup rows", () => {
    const event = (kind: string, outcome: string, transactionId: string) => ({ kind, outcome, transactionId, timestamp: 50n }) as unknown as TransactionSummaryResult;
    const rows = activityRows(sources({ accountEvents: [event("userAccountCreation", "succeeded", hash("a1")), event("userAccountUpdate", "accountNotFound", hash("a2")), event("privateValue", "succeeded", hash("a3"))] }));
    expect(rows.map((row) => [row.kind, row.title, row.state])).toEqual([
      ["setup", "Set up account", { state: "complete" }],
      ["setup", "Updated account", { state: "failed", reason: "The account this transaction updates does not exist." }],
    ]);
  });

  it("gives a listing one row per transaction and reports a sale at the claim that took it", () => {
    const listed: StoredOffer = {
      key: "listed", pub: publication("1"), source: "created", savedAt: 1_000,
      publish: { phase: "funded", l2ContractContentHash: hash("c1"), fundingContentHash: hash("f1"), catalogPublishedAt: 2_000, catalogPublicationId: "1", updatedAt: 2_000 },
    };
    const pending: StoredOffer = { key: "pending", pub: publication("2"), source: "created", savedAt: 3_000, publish: { phase: "l2-contract-submitted", l2ContractContentHash: hash("c2"), updatedAt: 3_000 } };
    const draft: StoredOffer = { key: "draft", pub: publication("3"), source: "created", savedAt: 4_000, publish: { phase: "draft", updatedAt: 4_000 } };
    const reclaiming: StoredOffer = { key: "reclaiming", pub: publication("4"), source: "created", savedAt: 500, publish: { phase: "funded", updatedAt: 600 },
      reclaim: { phase: "prepared", publication: publication("4"), contentHash: hash("e4"), updatedAt: 5_000 } };
    const offers = [listed, pending, draft, reclaiming];
    const rows = activityRows(sources({
      offers, sold: new Map([["1", { transactionId: hash("5a"), at: 9_000 }]]),
      receipts: new Map([[hash("f1"), receipt(hash("f1"), hash("0f"))]]),
      canonical: [{ transactionId: hash("0f"), direction: "spent", amount: 100n * PCASH, blockNumber: 5n, blockHash: "0x05", timestamp: 7n, commitments: [], payout: null }],
    }));
    expect(rows.map((row) => [row.id, row.kind, text(row.title), row.state.state])).toEqual([
      ["reclaiming:reclaimed", "reclaimed", "Reclaimed listing", "pending"],
      ["pending:listed", "listed", "Listed 100 PCASH for 0.01 ETH", "pending"],
      ["listed:sold", "sold", "Sold 100 PCASH for 0.01 ETH", "complete"],
      ["listed:escrow", "escrow", "Funded escrow", "complete"],
      ["listed:listed", "listed", "Listed 100 PCASH for 0.01 ETH", "complete"],
    ]);
    expect(rows.find((row) => row.id === "listed:escrow")!.at).toBe(7_000);
    expect(rows.find((row) => row.id === "listed:sold")).toMatchObject({ at: 9_000, href: `/tx/${hash("5a")}` });
    expect(rows[0]!.href).toBe(`/marketplace?offer=0x${"cc".repeat(20)}`);
    // Until the node names the claim, a sale links to its listing and has no time.
    const unnamed = activityRows(sources({ offers, sold: new Map([["1", {}]]) })).find((row) => row.id === "listed:sold")!;
    expect(unnamed.at).toBeUndefined();
    expect(unnamed.href).toBe(`/marketplace?offer=0x${"cc".repeat(20)}`);
  });

  it("shows a listing's escrow funding once, as its escrow row, not also as a payment to the contract", () => {
    const offer: StoredOffer = { key: "funding", pub: publication("5"), source: "created", savedAt: 1_000,
      publish: { phase: "funding-submitted", l2ContractContentHash: hash("c5"), l2ContractAcceptedBlock: "4", fundingContentHash: hash("f5"), updatedAt: 2_000 } };
    const funding = payment({ contentHash: hash("f5"), status: "pending", recipientAddress: `0x${"cc".repeat(20)}` });
    const rows = activityRows(sources({ offers: [offer], payments: [funding, payment({ contentHash: hash("a5") })] }));
    expect(rows.map((row) => row.id).sort()).toEqual([hash("a5"), "funding:escrow", "funding:listed"].sort());
  });

  it("keeps a created listing whose funding never started pending until it is funded", () => {
    const unfunded: StoredOffer = { key: "unfunded", pub: publication("6"), source: "created", savedAt: 1_000,
      publish: { phase: "l2-contract-submitted", l2ContractContentHash: hash("c6"), l2ContractAcceptedBlock: "4", updatedAt: 2_000 } };
    const [row] = activityRows(sources({ offers: [unfunded] }));
    expect(row).toMatchObject({ id: "unfunded:listed", state: { state: "pending", detail: "Not funded yet" } });
    const funded = activityRows(sources({ offers: [{ ...unfunded, publish: { ...unfunded.publish!, phase: "funded", fundingContentHash: hash("f6") } }] }));
    expect(funded.find((listed) => listed.id === "unfunded:listed")!.state).toEqual({ state: "complete" });
    // A staged listing continued away from its form reports a rejection through its row.
    const staged: StoredOffer = { ...unfunded, publish: { phase: "l2-contract-submitted", l2ContractContentHash: hash("c6"), updatedAt: 2_000 } };
    const [rejected] = activityRows(sources({ offers: [staged], receipts: new Map([[hash("c6"), receipt(hash("c6"), hash("e6"), "expired")]]) }));
    expect(rejected!.state).toEqual({ state: "failed", reason: "This transaction expired before it was included." });
  });

  it("keeps a listing's funding pending until the funded listing is published for buyers", () => {
    const finalizing: StoredOffer = { key: "finalizing", pub: publication("7"), source: "created", savedAt: 1_000,
      publish: { phase: "finalizing", l2ContractContentHash: hash("c7"), l2ContractAcceptedBlock: "4", fundingContentHash: hash("f7"), fundingAcceptedBlock: "5", updatedAt: 2_000 } };
    const escrow = (offer: StoredOffer, extra: Partial<ActivitySources> = {}) => activityRows(sources({ offers: [offer], ...extra })).find((row) => row.id === `${offer.key}:escrow`)!.state;
    expect(escrow(finalizing)).toEqual({ state: "pending", detail: "Not published yet" });
    // The funding's receipt tells the same before a refresh records it.
    const submitted: StoredOffer = { ...finalizing, publish: { phase: "funding-submitted", l2ContractContentHash: hash("c7"), l2ContractAcceptedBlock: "4", fundingContentHash: hash("f7"), updatedAt: 2_000 } };
    expect(escrow(submitted, { receipts: new Map([[hash("f7"), receipt(hash("f7"), hash("e7"))]]) })).toEqual({ state: "pending", detail: "Not published yet" });
    expect(escrow({ ...finalizing, publish: { ...finalizing.publish!, catalogPublishedAt: 3_000, catalogPublicationId: "7" } })).toEqual({ state: "complete" });
    // A failed publication is the listing row's to report.
    const failed = activityRows(sources({ offers: [{ ...finalizing, publish: { ...finalizing.publish!, catalogError: "Catalog unavailable" } }] }));
    expect(failed.map((row) => [row.id, row.state.state])).toEqual([["finalizing:escrow", "complete"], ["finalizing:listed", "failed"]]);
  });

  it("reads a created listing as not funded from its creation's receipt, before a refresh records it", () => {
    const created: StoredOffer = { key: "created", pub: publication("8"), source: "created", savedAt: 1_000,
      publish: { phase: "l2-contract-submitted", l2ContractContentHash: hash("c8"), updatedAt: 2_000 } };
    const [row] = activityRows(sources({ offers: [created], receipts: new Map([[hash("c8"), receipt(hash("c8"), hash("e8"))]]) }));
    expect(row!.state).toEqual({ state: "pending", detail: "Not funded yet" });
  });

  it("shows a purchase once its Ethereum payment has a hash", () => {
    const buy = (record: Record<string, unknown>): StoredOffer => ({ key: `buy-${Object.keys(record).join("-")}`, pub: publication("9"), source: "catalog", savedAt: 10,
      buys: { [OWNER_HEX]: { buyerAddress: OWNER_HEX, publication: publication("9"), ...record } } } as unknown as StoredOffer);
    const rows = activityRows(sources({ offers: [
      buy({}), buy({ paymentBroadcastRequestedAt: 20 }),
      buy({ txHash: hash("b1") }), buy({ txHash: hash("b1"), blockNumber: "5", paidAt: 30 }), buy({ txHash: hash("b1"), claimContentHash: hash("b2"), paidAt: 40 }), buy({ txHash: hash("b1"), claimedAt: 50 }),
    ] }));
    // The payment carries the claim; until it lands, the row shows the payment.
    expect(rows.map((row) => [row.kind, row.state])).toEqual([
      ["bought", { state: "pending", contentHash: hash("b2"), detail: "Paid, claiming", whenAbsent: { state: "pending", detail: "Claim not posted" } }],
      ["bought", { state: "pending", detail: "Claim not posted" }],
      ["bought", { state: "pending", posted: true }],
      ["bought", { state: "complete" }],
    ]);
    expect(text(rows[3]!.title)).toBe("Bought 100 PCASH for 0.01 ETH");
  });

  it("completes a purchase once reconciliation records the claim that spent the escrow", () => {
    const offer = { key: "claims", pub: publication("9"), source: "catalog", savedAt: 10,
      buys: { [OWNER_HEX]: { buyerAddress: OWNER_HEX, publication: publication("9"), txHash: hash("b1"), blockNumber: "5",
        claimContentHash: hash("b2"), claimAcceptedBlock: "6" } } } as unknown as StoredOffer;
    expect(activityReceiptHashes(sources({ offers: [offer] }))).toEqual([hash("b2")]);
    expect(activityRows(sources({ offers: [offer] }))[0]!.state).toEqual({ state: "complete" });
  });

  it("completes a purchase whose earlier claim spent the escrow while its newer saved claim failed, before reconciliation", () => {
    const offer = { key: "claims", pub: publication("9"), source: "catalog", savedAt: 10,
      buys: { [OWNER_HEX]: { buyerAddress: OWNER_HEX, publication: publication("9"), txHash: hash("b1"), blockNumber: "5", claimContentHash: hash("b3") } } } as unknown as StoredOffer;
    const failed = new Map([[hash("b3"), receipt(hash("b3"), hash("e3"), "nullifierAlreadySpent")]]);
    // The identity the mocked publicationIdentity gives listing 9.
    const landed = new Map([["9", hash("b2")]]);
    for (const now of [1_999_999_999n, 2_000_000_000n]) {
      expect(activityRows(sources({ offers: [offer], receipts: failed, purchased: landed }), now)[0]!.state).toEqual({ state: "complete" });
    }
  });

  it("reads a prepared claim's receipt and place on its way to Ethereum", () => {
    const offer = { key: "claim", pub: publication("9"), source: "catalog", savedAt: 10,
      buys: { [OWNER_HEX]: { buyerAddress: OWNER_HEX, publication: publication("9"), txHash: hash("b1"), blockNumber: "5", claimContentHash: hash("b2") } } } as unknown as StoredOffer;
    expect(activityReceiptHashes(sources({ offers: [offer] }))).toEqual([hash("b2")]);
    const failed = new Map([[hash("b2"), receipt(hash("b2"), hash("e2"), "nullifierAlreadySpent")]]);
    // The listing is where the buyer finishes a claim that did not succeed, until T.
    const [rejected] = activityRows(sources({ offers: [offer], receipts: failed }), 1_999_999_999n);
    expect(rejected).toMatchObject({ state: { state: "pending", detail: "Needs claim" }, href: `/marketplace?offer=0x${"cc".repeat(20)}` });
    const [expired] = activityRows(sources({ offers: [offer], receipts: failed }), 2_000_000_000n);
    expect(expired!.state).toEqual({ state: "failed", reason: "This transaction tried to spend a note that had already been spent." });
    const [prepared] = activityRows(sources({ offers: [offer], receipts: new Map([[hash("b2"), null]]) }));
    expect(prepared!.href).toBe(`/marketplace?offer=0x${"cc".repeat(20)}`);
    const shown = (observed: Parameters<typeof shownState>[1]) => shownState(prepared!.state, observed);
    expect(shown(undefined)).toMatchObject({ state: "pending", detail: "Paid, claiming" });
    expect(shown("mempool")).toMatchObject({ state: "pending", detail: "Paid, claiming", posted: false });
    expect(shown("ethereum")).toMatchObject({ state: "pending", posted: true });
    expect(shown("ambiguous")).toMatchObject({ state: "pending", detail: "Paid, claiming" });
    expect(shown("absent")).toEqual({ state: "pending", detail: "Claim not posted" });
    expect(shown("confirmed")).toEqual({ state: "complete" });
  });

  it("follows a recorded token action to its receipt, or to expiry once the wallet lets it go", () => {
    const unit = { symbol: "HBR", decimals: 2 };
    const token = (kind: TokenActivity["kind"], byte: string, at: number): TokenActivity => ({ kind, contentHash: hash(byte), amount: 12_345n, unit, at, ...(kind === "token-sent" ? { to: `0x${"56".repeat(20)}` } : {}) });
    const rows = activityRows(sources({
      tokens: [token("token-created", "d1", 1), token("token-sent", "d2", 2), token("token-burned", "d3", 3), token("token-claimed", "d4", 4)],
      receipts: new Map([[hash("d1"), receipt(hash("d1"), hash("e1"))], [hash("d2"), receipt(hash("d2"), hash("e2"), "nullifierAlreadySpent")], [hash("d3"), null]]),
      pendingContentHashes: new Set([hash("d3")]),
    }));
    expect(rows.map((row) => [row.kind, text(row.title), row.state, row.href])).toEqual([
      ["token-claimed", "Claimed 123.45 HBR", { state: "pending", contentHash: hash("d4"), whenAbsent: { state: "expired" } }, `/tx/${hash("d4")}`],
      ["token-burned", "Burned 123.45 HBR", { state: "pending", contentHash: hash("d3") }, `/tx/${hash("d3")}`],
      ["token-sent", "Sent 123.45 HBR to 0x565656…565656", { state: "failed", reason: "This transaction tried to spend a note that had already been spent." }, `/tx/${hash("e2")}`],
      ["token-created", "Created 123.45 HBR", { state: "complete" }, `/tx/${hash("e1")}`],
    ]);
  });
});
