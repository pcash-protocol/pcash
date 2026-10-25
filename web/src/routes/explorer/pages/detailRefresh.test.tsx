import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { fixtureStatus, fixtureWorld } from "../fixtures/world.ts";
import { createFixtureReader } from "../fixtures/reader.ts";
import { PersonalTransactionDetailsProvider, type PersonalTransactionDetailsValue } from "../../../components/PersonalTransactionDetails.tsx";

const state = vi.hoisted(() => ({
  value: undefined as unknown,
  error: undefined as string | undefined,
  personalDetails: { payments: [] } as PersonalTransactionDetailsValue,
}));
vi.mock("../ExplorerProvider.tsx", async () => {
  const { fixtureStatus } = await import("../fixtures/world.ts");
  return { useReadyExplorer: () => ({ status: fixtureStatus, reader: {} }) };
});
vi.mock("../ui.tsx", async (importOriginal) => ({
  ...await importOriginal<typeof import("../ui.tsx")>(),
  useRead: () => state,
}));
import { BlockPage } from "./BlockPage.tsx";
import { resolveTransaction, TransactionPage } from "./TransactionPage.tsx";

function render(path: string) {
  return renderToStaticMarkup(<PersonalTransactionDetailsProvider value={state.personalDetails}><MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/blocks/:number" element={<BlockPage />} />
    <Route path="/tx/:transactionId" element={<TransactionPage />} />
  </Routes></MemoryRouter></PersonalTransactionDetailsProvider>);
}

describe("polled Explorer detail refresh failures", () => {
  it("keeps a loaded block visible and removes the delayed notice on recovery", async () => {
    const block = fixtureWorld.blocks[0]!;
    state.value = await createFixtureReader().blockSnapshot(block.number);
    state.error = "RPC timeout";
    const html = render(`/blocks/${block.number}`);
    expect(html).toContain("Update delayed.");
    expect(html).toContain(`Block ${block.number}`);
    state.error = undefined;
    expect(render(`/blocks/${block.number}`)).not.toContain("Update delayed.");
  });

  it("keeps a posted transaction visible during a failed refresh", async () => {
    const id = fixtureWorld.transactions[0]!.summary.transactionId;
    const posted = await createFixtureReader().transaction(id);
    state.value = { state: "posted", canonical: posted };
    state.error = "RPC timeout";
    const html = render(`/tx/${id}`);
    expect(html).toContain("Update delayed.");
    expect(html).toContain("Transaction ID");
    state.error = undefined;
    expect(render(`/tx/${id}`)).not.toContain("Update delayed.");
  });

  it("shows exact browser-local payment details only for the matching signed-in wallet", async () => {
    const transaction = fixtureWorld.transactions.find(({ summary }) => summary.kind === "privateValue" && summary.outcome === "succeeded")!;
    const posted = await createFixtureReader().transaction(transaction.summary.transactionId);
    const recipientAddress = "0x1234567890abcdef1234567890abcdef12345678";
    state.value = { state: "posted", canonical: posted };
    state.error = undefined;
    state.personalDetails = {
      network: { chainId: BigInt(fixtureStatus.pcashChainId), genesisHash: fixtureStatus.genesisHash },
      payments: [{
        kind: "payment" as const, contentHash: transaction.summary.contentHash.toUpperCase(),
        recipientAddress,
        amount: 12_500_000_000_000_000_000n,
        openFeeAmount: 10_000_000_000_000_000n,
      }],
    };

    const html = render(`/tx/${transaction.summary.transactionId}`);
    expect(html).toContain("Your payment");
    expect(html).toContain("12.5");
    expect(html).toContain(recipientAddress);
    expect(html).toContain("not public transaction data");

    state.personalDetails = { payments: [] };
    const publicHtml = render(`/tx/${transaction.summary.transactionId}`);
    expect(publicHtml).toContain(">Arena</button>");
    expect(publicHtml).not.toContain("Your payment");
    expect(publicHtml).toContain("Participants and amounts stay private.");
  });

  it("shows mining and its received issuance only in owner details", async () => {
    const transaction = fixtureWorld.transactions.find(({ summary }) => summary.kind === "privateValue" && summary.outcome === "succeeded")!;
    state.value = { state: "posted", canonical: await createFixtureReader().transaction(transaction.summary.transactionId) };
    state.error = undefined;
    state.personalDetails = {
      network: { chainId: BigInt(fixtureStatus.pcashChainId), genesisHash: fixtureStatus.genesisHash },
      payments: [{ kind: "mine", contentHash: transaction.summary.contentHash, recipientAddress: "0x1234567890abcdef1234567890abcdef12345678", amount: 0n, openFeeAmount: 0n, minedAmount: 5n * 10n ** 18n }],
    };
    const html = render(`/tx/${transaction.summary.transactionId}`);
    expect(html).toContain("Your mining action");
    expect(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain("Mined 5 PCASH");
    expect(html).not.toContain("Accepted");
    expect(html).toContain("Relayer fee");
    expect(html).not.toContain("Your payment");
    state.personalDetails = { payments: [] };
    expect(render(`/tx/${transaction.summary.transactionId}`)).not.toContain("Your mining action");
  });

  it("does not treat a conflicting spend receipt as the original payment", async () => {
    const transaction = fixtureWorld.transactions.find(({ summary }) => summary.kind === "privateValue" && summary.outcome === "succeeded")!;
    state.value = { state: "posted", canonical: await createFixtureReader().transaction(transaction.summary.transactionId) };
    state.error = undefined;
    const conflictedPayment = {
      kind: "payment" as const, contentHash: `0x${"ff".repeat(32)}`,
      receiptTxId: transaction.summary.transactionId,
      recipientAddress: "0x1234567890abcdef1234567890abcdef12345678",
      amount: 12_500_000_000_000_000_000n,
      openFeeAmount: 10_000_000_000_000_000n,
    };
    state.personalDetails = {
      network: { chainId: BigInt(fixtureStatus.pcashChainId), genesisHash: fixtureStatus.genesisHash },
      payments: [conflictedPayment],
    };

    const html = render(`/tx/${transaction.summary.transactionId}`);
    expect(html).not.toContain("Your payment");
    expect(html).not.toContain(conflictedPayment.recipientAddress);
    expect(html).toContain("Participants and amounts stay private.");
    state.personalDetails = { payments: [] };
  });

  it("does not join private details from a different PCASH network", async () => {
    const transaction = fixtureWorld.transactions.find(({ summary }) => summary.kind === "privateValue" && summary.outcome === "succeeded")!;
    state.value = { state: "posted", canonical: await createFixtureReader().transaction(transaction.summary.transactionId) };
    state.error = undefined;
    state.personalDetails = {
      network: { chainId: BigInt(fixtureStatus.pcashChainId) + 1n, genesisHash: fixtureStatus.genesisHash },
      payments: [{
        kind: "payment" as const, contentHash: transaction.summary.contentHash,
        recipientAddress: "0x1234567890abcdef1234567890abcdef12345678",
        amount: 1n,
        openFeeAmount: 0n,
      }],
    };

    const html = render(`/tx/${transaction.summary.transactionId}`);
    expect(html).not.toContain("Your payment");
    expect(html).toContain("Participants and amounts stay private.");
    state.personalDetails = { payments: [] };
  });
});

describe("transaction links by content hash", () => {
  const transaction = fixtureWorld.transactions.find(({ summary }) => summary.kind === "privateValue" && summary.outcome === "succeeded")!;

  it("opens the one transaction that bytes included once became", async () => {
    const resolved = await resolveTransaction(createFixtureReader(), transaction.summary.contentHash, undefined);
    expect(resolved.state).toBe("posted");
    expect(resolved.state === "posted" && resolved.canonical.summary.transactionId).toBe(transaction.summary.transactionId);
  });

  it("lists the inclusions of bytes included more than once, and any later page", async () => {
    const reader = createFixtureReader();
    const page = await reader.submission(transaction.summary.contentHash);
    const included = page.items[0]!;
    const twice = { ...reader, submission: async () => ({ ...page, items: [included, { ...included, transactionId: `0x${"ee".repeat(32)}` }], nextCursor: null }) };
    expect((await resolveTransaction(twice, transaction.summary.contentHash, undefined)).state).toBe("inclusions");
    const laterPage = { ...reader, submission: async () => ({ ...page, items: [included], nextCursor: null }) };
    expect((await resolveTransaction(laterPage, transaction.summary.contentHash, { head: page.head, blockNumber: 1n, pcashTransactionIndex: 0n })).state).toBe("inclusions");
  });
});
