import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { BlockPayoutsResult, SystemPayoutResult, MempoolItemResult, ReceiptResult, TransactionSummaryResult } from "@pcash/sdk/clients";
import { formatPcashAmount } from "../../../components/pcashAmount.ts";
import { shortHex } from "../format.ts";
import { addressPath } from "../paths.ts";
import { fixtureStatus, fixtureWorld } from "../fixtures/world.ts";
import { createFixtureReader } from "../fixtures/reader.ts";

const state = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../ExplorerProvider.tsx", async () => {
  const { fixtureStatus } = await import("../fixtures/world.ts");
  return { useReadyExplorer: () => ({ status: fixtureStatus, reader: {} }) };
});
vi.mock("../ui.tsx", async (importOriginal) => ({
  ...await importOriginal<typeof import("../ui.tsx")>(),
  useRead: () => ({ value: state.value, error: undefined, reload: () => undefined }),
}));
import { PersonalTransactionDetailsProvider } from "../../../components/PersonalTransactionDetails.tsx";
import { BlockPage } from "./BlockPage.tsx";
import { DashboardPage } from "./DashboardPage.tsx";
import { TransactionPage } from "./TransactionPage.tsx";
import { TransactionsPage } from "./TransactionsPage.tsx";

const PCASH = 10n ** 18n;
const hash = (byte: string) => `0x${byte.repeat(32)}`;
const POSTER = `0x${"7a".repeat(20)}`;

function summary(route: TransactionSummaryResult["issuanceRoute"], declared: string | null): TransactionSummaryResult {
  return {
    transactionId: hash("cd"), contentHash: hash("ab"), outcome: "succeeded", failureDetail: null, declaredOpenFeeAmount: route === "designated" ? 0n : 2n * PCASH,
    declaredIssuanceOwnerCommitment: declared, issuanceRoute: route, kind: "privateValue", fundingMode: null,
    block: { blockNumber: 7n, blockHash: hash("ef") }, pcashTransactionIndex: 0n, timestamp: 1_000n,
    inclusion: { l1BlockNumber: 1n, l1BlockHash: hash("01"), l1TransactionIndex: 0n, l1TransactionHash: hash("02"), batchItemIndex: 0n },
    l1Sender: POSTER, issuanceOwnerCommitment: declared, settledOpenFeeAmount: route === "designated" ? 0n : 2n * PCASH, settledIssuanceAmount: 5n * PCASH,
    byteSize: 1n, outputLeafStart: null, outputsAdded: 5n, nullifiers: [], account: null,
  };
}

function receipt(destination: string, openFeeAmount = 2n * PCASH): ReceiptResult {
  return { inclusion: summary("open", null).inclusion, contentHash: hash("ab"), transactionId: hash("cd"), outcome: "succeeded", failureDetail: null,
    l1Sender: POSTER, issuanceOwnerCommitment: destination, settledOpenFeeAmount: openFeeAmount, settledIssuanceAmount: 5n * PCASH,
    kind: "privateValue", fundingMode: null, outputLeafStart: null, outputsAdded: 5n, nullifiers: [], account: null };
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&lt;", "<").replace(/\s+/g, " ");
const rows = (html: string) => Object.fromEntries([...html.matchAll(/<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/g)].map(([, term, value]) => [term, text(value!).trim()]));

/** The block page's payout rows: six cells wide, header row dropped. */
const payoutRows = (html: string) => [...html.matchAll(/<tr>(.*?)<\/tr>/g)]
  .map(([, row]) => [...row!.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/g)].map(([, cell]) => text(cell!).trim()))
  .filter((cells) => cells.length === 6 && cells[0] !== "Destination");

const commitmentHex = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;

function renderAt(path: string) {
  return renderToStaticMarkup(<PersonalTransactionDetailsProvider value={{ payments: [] }}><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/tx/:transactionId" element={<TransactionPage />} />
    <Route path="/transactions" element={<TransactionsPage />} />
    <Route path="/explorer" element={<DashboardPage />} />
    <Route path="/block/:number" element={<BlockPage />} />
  </Routes></MemoryRouter></PersonalTransactionDetailsProvider>);
}

describe("explorer blockPayouts", () => {
  it("pays an open route to the resolved poster commitment, not to the Ethereum sender", () => {
    const canonical = { summary: { ...summary("open", hash("00")), ...receipt(hash("99")) }, rawTransaction: "0x" };
    state.value = { state: "posted", canonical };
    const html = renderAt(`/tx/${hash("cd")}`);
    expect(html).toContain("<h2>System payouts</h2>");
    expect(rows(html)).toMatchObject({ "Issuance route": "Open", "Declared open fee": "2 PCASH", "Open fee paid": "2 PCASH", "Issuance paid": "5 PCASH" });
    expect(rows(html)["Issuance to"]).toContain("0x99999999");
    // The Ethereum sender is inclusion data, never the party the blockPayouts paid.
    expect(rows(html)["Batch sent by"]).toContain(POSTER.slice(0, 10));
    expect(text(html)).toContain("not the Ethereum address that sent the batch");
    expect(html).not.toContain("Batch poster");
  });

  it("names a designated destination by its commitment and says a repost cannot redirect it", () => {
    const destination = hash("44");
    const canonical = { summary: summary("designated", destination), rawTransaction: "0x" };
    state.value = { state: "posted", canonical };
    const html = renderAt(`/tx/${hash("cd")}`);
    expect(rows(html)).toMatchObject({ "Issuance route": "Designated", "Issuance paid": "5 PCASH" });
    expect(rows(html)["Issuance to"]).toContain("0x44444444");
    expect(text(html)).toContain("reposting the same bytes cannot redirect issuance");
    expect(html).not.toContain("Batch poster");
  });

  it("links a contract creation to its contract, rounds fees up, and has one details section", () => {
    const contract = `0x${"c0".repeat(20)}`;
    const fee = 14n * PCASH / 10n;
    const created = { ...summary("open", hash("00")), kind: "contractAccount", fundingMode: "sponsored" as const, declaredOpenFeeAmount: fee, account: { address: contract, accountRevision: 0n } };
    state.value = { state: "posted", canonical: { summary: { ...created, ...receipt(hash("99"), fee), kind: created.kind, fundingMode: created.fundingMode, account: created.account }, rawTransaction: "0x" } };
    const html = renderAt(`/tx/${hash("cd")}`);
    expect(html).toMatch(new RegExp(`<header[^>]*>.*href="${addressPath(contract)}".*</header>`));
    expect(text(html)).toContain("Contract creation · Sponsored");
    expect(rows(html)).toMatchObject({ "Declared open fee": "2 PCASH", "Open fee paid": "2 PCASH", "Byte size": "1 B" });
    expect(html).not.toContain("More details");
  });

  it("labels an unfunded contract creation with its funding mode", () => {
    const contract = `0x${"c1".repeat(20)}`;
    const created = { ...summary("none", null), kind: "contractAccount", fundingMode: "unfunded" as const, declaredOpenFeeAmount: null, account: { address: contract, accountRevision: 0n } };
    state.value = { state: "posted", canonical: { summary: created, rawTransaction: "0x" } };
    const html = renderAt(`/tx/${hash("cd")}`);
    expect(text(html)).toContain("Contract creation · Unfunded");
    expect(rows(html)).toMatchObject({ "Declared open fee": "None" });
  });

  it("shows a pending entry's blockPayouts route in its one details list", () => {
    const item = { contentHash: hash("ab"), openFeeAmount: 0n, issuanceRoute: "open", byteSize: 10n, receivedAtUnixMs: 1_000n } as MempoolItemResult;
    state.value = { state: "pending", item };
    const html = renderAt(`/tx/${hash("ab")}`);
    expect(rows(html)).toEqual({ "Issuance route": "Open", "Byte size": "10 B" });
    expect(html).not.toContain("More details");
  });

  it("marks designated issuance with zero open fee in the transaction list", () => {
    state.value = { items: [summary("designated", hash("44")), { ...summary("open", hash("00")), transactionId: hash("ce") }], nextCursor: null, head: { blockNumber: 7n, blockHash: hash("ef") } };
    const html = text(renderAt("/transactions"));
    expect(html).toContain("0 PCASH designated");
    expect(html.match(/designated/g)).toHaveLength(1);
  });

});

/** The recorded chain, searched by the state each case needs. */
function recordedBlockPayouts(predicate: (entry: BlockPayoutsResult) => boolean): BlockPayoutsResult {
  const entry = [...fixtureWorld.blockPayouts.values()].find(predicate);
  if (entry === undefined) throw new Error("the recorded fixtures contain no block in this state");
  return entry;
}

describe("explorer block blockPayouts", () => {
  const reader = createFixtureReader();

  it("hides the payouts section for a block with no transactions", async () => {
    const empty = fixtureWorld.blocks.find((block) => block.transactionResults.length === 0);
    if (empty === undefined) throw new Error("the recorded fixtures contain no empty block");
    state.value = await reader.blockSnapshot(empty.number);
    expect(renderAt(`/block/${empty.number}`)).not.toContain("System payouts");
  });

  it("shows a designated payout and a poster aggregate with their own routes and sources", async () => {
    const kinds = (entry: BlockPayoutsResult) => new Set(entry.payouts.map((payout) => payout.source.kind));
    const recorded = recordedBlockPayouts((entry) => kinds(entry).size === 2);
    const snapshot = await reader.blockSnapshot(recorded.block.blockNumber);
    state.value = snapshot;
    const blockPayouts = snapshot.blockPayouts!;
    const designated = blockPayouts.payouts.find((payout) => payout.source.kind === "designatedIssuance")!;
    const poster = blockPayouts.payouts.find((payout) => payout.source.kind === "posterPayout")!;
    const source = designated.source as Extract<SystemPayoutResult["source"], { kind: "designatedIssuance" }>;
    const inclusion = snapshot.block!.transactionResults.find((result) =>
      result.inclusion.l1TransactionIndex === source.l1TransactionIndex
      && result.inclusion.batchItemIndex === source.batchItemIndex)!;

    const html = renderAt(`/block/${recorded.block.blockNumber}`);
    const body = text(html);
    expect(html).toContain("<h2>System payouts</h2>");
    // Fees and issuance stay apart: one moves existing value, the other creates supply.
    expect(body).toContain(`Open fees ${formatPcashAmount(blockPayouts.openFeesTotal)}`);
    expect(body).toContain(`Issuance ${formatPcashAmount(blockPayouts.issuanceTotal)}`);
    expect(body).toContain(`Payouts ${blockPayouts.payouts.length} Each is one native note.`);
    // A designated payout names its source transaction; a poster payout names its batches.
    expect(html).toContain(`/tx/${inclusion.transactionId}`);
    expect(html).toContain(`/batch/${inclusion.inclusion.l1TransactionHash}`);
    expect(body).toContain("Poster aggregate of 1 batch");

    const [first, second] = payoutRows(html);
    expect(first![0]).toContain(shortHex(commitmentHex(designated.ownerCommitment)));
    expect(first![1]).toBe("Designated");
    expect(first![3]).toBe("Issuance");
    expect(first![4]).toBe(formatPcashAmount(designated.amount));
    expect(first![5]).toBe(designated.outputIndex.toString());
    expect(second![0]).toContain(shortHex(commitmentHex(poster.ownerCommitment)));
    expect(second![1]).toBe("Open");
    expect(second![3]).toBe(poster.component === "openFee" ? "Open fee" : "Issuance");
    expect(second![4]).toBe(formatPcashAmount(poster.amount));
  });

  it("says nothing was paid for a block whose transactions created no payouts", async () => {
    const recorded = recordedBlockPayouts((entry) => entry.payouts.length === 0
      && fixtureWorld.blocks.some((block) => block.number === entry.block.blockNumber && block.transactionResults.length > 0));
    state.value = await reader.blockSnapshot(recorded.block.blockNumber);
    const body = text(renderAt(`/block/${recorded.block.blockNumber}`));
    expect(body).toContain("No system payout was created in this block.");
    expect(body).toContain("No transaction in this block paid an open fee.");
    expect(body).toContain("This block created no new supply.");
    expect(body).toContain("Payouts 0 No native note was created.");
    expect(body).not.toContain("Poster aggregate");
  });

  it("does not imply issuance created a note in a block that issued nothing", async () => {
    const recorded = recordedBlockPayouts((entry) => entry.issuanceTotal === 0n && entry.payouts.length > 0);
    const snapshot = await reader.blockSnapshot(recorded.block.blockNumber);
    state.value = snapshot;
    const payout = snapshot.blockPayouts!.payouts[0]!;
    const body = text(renderAt(`/block/${recorded.block.blockNumber}`));
    expect(body).toContain("Issuance 0 PCASH This block created no new supply.");
    expect(body).toContain(`Open fees ${formatPcashAmount(snapshot.blockPayouts!.openFeesTotal)}`);
    expect(body).toContain("Payouts 1 Each is one native note.");
    const [only] = payoutRows(renderAt(`/block/${recorded.block.blockNumber}`));
    expect(only![3]).toBe("Open fee");
    expect(only![4]).toBe(formatPcashAmount(payout.amount));
  });
});
