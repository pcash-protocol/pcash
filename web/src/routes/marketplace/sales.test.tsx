// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OfferPublication, StoredOffer } from "@pcash/marketplace/app";

const mocks = vi.hoisted(() => {
  const spent = vi.fn();
  const byNullifier = vi.fn();
  return { spent, byNullifier, wallet: {
    node: { areNullifiersSpent: spent, getTransactionByNullifier: byNullifier },
    snapshot: { syncedThrough: { pcashHash: "0x01" } },
    followedStatus: { status: { finalizedL1BlockNumber: 5n } },
  } };
});
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => mocks.wallet }));
vi.mock("@pcash/marketplace/app", async (original) => ({
  ...await original<object>(),
  publicationIdentity: (pub: { terms: { id: string } }) => pub.terms.id,
  escrowCommitments: (pub: { terms: { id: string } }) => ({ nullifier: `nullifier-${pub.terms.id}` }),
}));
import { saleCandidates, useListingSales, type ListingSale } from "./sales.ts";

notifyManager.setScheduler((callback) => callback());
const OWNER = 0x12n;
const offer = (id: string, fields: Partial<StoredOffer> = {}) => ({
  key: id, source: "created", savedAt: 1, pub: { reclaimAuthority: "0x12", terms: { id }, escrow: {} }, ...fields,
}) as unknown as StoredOffer;
let root: ReturnType<typeof createRoot>;
let sales: ReadonlyMap<string, ListingSale>;
const listings = [offer("open").pub, offer("sold").pub] as OfferPublication[];
function Probe() { sales = useListingSales(listings); return null; }
const client = new QueryClient();
const render = () => act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
/** A new wallet head, with the Ethereum block finalized as of it. */
const nextHead = async (hash: string, finalizedL1 = 5n) => {
  mocks.wallet.snapshot = { syncedThrough: { pcashHash: hash } };
  mocks.wallet.followedStatus = { status: { finalizedL1BlockNumber: finalizedL1 } };
  await render();
};
const claimIn = (l1BlockNumber: bigint) => ({ summary: { transactionId: "0xclaim", timestamp: 7n, inclusion: { l1BlockNumber } } });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  root = createRoot(document.createElement("div"));
  client.clear();
  mocks.spent.mockReset().mockImplementation(async (nullifiers: string[]) => nullifiers.map((nullifier) => nullifier === "nullifier-sold"));
  mocks.byNullifier.mockReset().mockResolvedValue(null);
  mocks.wallet.snapshot = { syncedThrough: { pcashHash: "0x01" } };
  mocks.wallet.followedStatus = { status: { finalizedL1BlockNumber: 5n } };
});
afterEach(async () => { await act(async () => root.unmount()); });

it("checks only the owner's funded, unreclaimed listings", () => {
  const offers = [
    offer("live"),
    offer("other", { pub: { reclaimAuthority: "0x34", terms: { id: "other" }, escrow: {} } } as Partial<StoredOffer>),
    offer("reclaimed", { reclaim: { contentHash: "0x1" } } as Partial<StoredOffer>),
    offer("unfunded", { publish: { phase: "funding-submitted" } } as Partial<StoredOffer>),
  ];
  expect(saleCandidates(OWNER, offers).map((pub) => pub.terms.id)).toEqual(["live"]);
});

it("stops counting a sale that a reorg removes before its claim is finalized", async () => {
  mocks.byNullifier.mockResolvedValue(claimIn(10n));
  await render();
  expect(mocks.spent).toHaveBeenCalledWith(["nullifier-open", "nullifier-sold"]);
  expect(sales).toEqual(new Map([["sold", { transactionId: "0xclaim", at: 7_000 }]]));
  // The claim's block is not finalized, and a reorg drops it: the escrow is live again.
  mocks.spent.mockImplementation(async (nullifiers: string[]) => nullifiers.map(() => false));
  mocks.byNullifier.mockResolvedValue(null);
  await nextHead("0x02");
  expect(mocks.spent).toHaveBeenLastCalledWith(["nullifier-open", "nullifier-sold"]);
  expect(sales).toEqual(new Map());
});

it("keeps spent escrows as sales when a claim lookup fails, and fills in the claim at a later head", async () => {
  mocks.spent.mockImplementation(async (nullifiers: string[]) => nullifiers.map(() => true));
  mocks.byNullifier.mockImplementation(async (nullifier: string) => {
    if (nullifier === "nullifier-sold") throw new Error("index unavailable");
    return claimIn(10n);
  });
  await render();
  expect(sales).toEqual(new Map([["open", { transactionId: "0xclaim", at: 7_000 }], ["sold", {}]]));
  mocks.byNullifier.mockResolvedValue(claimIn(10n));
  await nextHead("0x02");
  expect(sales).toEqual(new Map([["open", { transactionId: "0xclaim", at: 7_000 }], ["sold", { transactionId: "0xclaim", at: 7_000 }]]));
});

it("treats a sale as final once its claim's block is finalized, and reads its escrow no more", async () => {
  mocks.byNullifier.mockResolvedValue(claimIn(10n));
  await render();
  await nextHead("0x02", 10n);
  expect(sales).toEqual(new Map([["sold", { transactionId: "0xclaim", at: 7_000 }]]));
  const lookups = mocks.byNullifier.mock.calls.length;
  await nextHead("0x03", 10n);
  // One read per head for the escrows not finally sold.
  expect(mocks.spent).toHaveBeenLastCalledWith(["nullifier-open"]);
  expect(mocks.byNullifier).toHaveBeenCalledTimes(lookups);
  // A node answer that would undo it no longer counts.
  mocks.spent.mockImplementation(async (nullifiers: string[]) => nullifiers.map(() => false));
  await nextHead("0x04", 10n);
  expect(sales).toEqual(new Map([["sold", { transactionId: "0xclaim", at: 7_000 }]]));
});
