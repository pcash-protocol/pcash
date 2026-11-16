// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { marketplaceBuyerKey, type StoredOffer } from "@pcash/marketplace/app";

const mocks = vi.hoisted(() => ({
  readEscrowSpend: vi.fn(),
  wallet: { node: {}, snapshot: { syncedThrough: { pcashHash: "0x01" } } },
}));
vi.mock("../../lib/WalletProvider.tsx", () => ({ useWallet: () => mocks.wallet }));
vi.mock("@pcash/marketplace/app", async (original) => ({
  ...await original<object>(),
  publicationIdentity: (pub: { terms: { id: string } }) => pub.terms.id,
  readEscrowSpend: mocks.readEscrowSpend,
}));
import { usePurchaseClaims } from "./purchases.ts";

notifyManager.setScheduler((callback) => callback());
const A = 0xa1n;
const B = 0xb2n;
// After a reorg, both buyers hold a saved payment for one listing; the claim for A's payment spent the escrow.
const listing = {
  key: "l", source: "catalog", savedAt: 1, pub: { terms: { id: "l" } },
  buys: Object.fromEntries(([[A, "0xca"], [B, "0xcb"]] as const).map(([owner, commitment]) => [marketplaceBuyerKey(owner),
    { buyerAddress: marketplaceBuyerKey(owner), publication: { terms: { id: "l" } }, commitment, blockNumber: "5" }])),
} as unknown as StoredOffer;
let owner = A;
let claims: ReadonlyMap<string, string>;
function Probe() { claims = usePurchaseClaims(owner, [listing]); return null; }
let root: ReturnType<typeof createRoot>;
const client = new QueryClient();
const render = () => act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  root = createRoot(document.createElement("div"));
  client.clear();
  owner = A;
  mocks.readEscrowSpend.mockReset().mockImplementation(async (_node: unknown, _publication: unknown, commitment: string) =>
    ({ contentHash: "0xclaim", l1BlockNumber: 5n, ours: commitment === "0xca" }));
});
afterEach(async () => { await act(async () => root.unmount()); });

it("reads each buyer's own payment at the same head and never shows another buyer's answer", async () => {
  await render();
  expect(claims).toEqual(new Map([["l", "0xclaim"]]));
  owner = B;
  await render();
  expect(claims).toEqual(new Map());
  owner = A;
  await render();
  expect(claims).toEqual(new Map([["l", "0xclaim"]]));
  expect(mocks.readEscrowSpend.mock.calls.map(([, , commitment]) => commitment)).toEqual(["0xca", "0xcb"]);
});
