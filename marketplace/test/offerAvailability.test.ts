import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex } from "viem";
import { generateMlKemKeyPair } from "@pcash/sdk/browser";
import { MIN_CLAIM_WINDOW_SECONDS } from "../src/commitments.mts";
import { PURCHASE_MARGIN_SECONDS, fetchOpenOffers, escrowCommitments } from "../src/client/offerAvailability.ts";
import type { OfferPublication } from "../src/client/publication.ts";
import { buildContractBody, functionSelector } from "@pcash/sdk/protocol";

const receiveKey = generateMlKemKeyPair();
const contract = buildContractBody({
  nullifierKey: { publishesNkRoot: true, nkRoot: 2n },
  mlKemPublicKey: receiveKey.publicKey,
  functions: [
    { selector: functionSelector(0), applicationVkHash: 1n, configurationCommitment: 1n },
    { selector: functionSelector(1), applicationVkHash: 1n, configurationCommitment: 1n },
  ],
});
const BODY_HEX = bytesToHex(contract.body);
// Tests run at 1000: an open listing's purchases close at 2000, a claim-only one's at 1000.
const OPEN = String(2_000n + MIN_CLAIM_WINDOW_SECONDS + PURCHASE_MARGIN_SECONDS);
const CLAIM_ONLY = String(1_000n + MIN_CLAIM_WINDOW_SECONDS + PURCHASE_MARGIN_SECONDS);
const offer = (id: number, deadline = OPEN) => ({
  chainId: "1",
  terms: { id: String(id), assetId: "0", deadlineT: deadline },
  l2Contract: { bodyHex: BODY_HEX, claimConfigurationSalt: "1", reclaimConfigurationSalt: "1" },
  escrow: { leafIndex: id, noteSecret: "3", amount: "10" },
}) as unknown as OfferPublication;

test("filters spent escrows, including fills in another wallet, without querying claim-only or unfunded offers", async () => {
  const filled = offer(1), open = offer(2), reclaimed = offer(3), expired = offer(4, CLAIM_ONLY);
  const unfunded = { ...offer(5), escrow: undefined };
  const result = await fetchOpenOffers({ areNullifiersSpent: async (nullifiers) => {
    assert.deepEqual(nullifiers, [filled, open, reclaimed].map(p => escrowCommitments(p, p.escrow!).nullifier));
    return [true, false, true];
  } }, [filled, open, reclaimed, expired, unfunded], 1000n);
  assert.deepEqual(result, [open]);
});

test("batches large books within node limits and preserves listing order", async () => {
  const offers = Array.from({ length: 257 }, (_, id) => offer(id));
  const sizes: number[] = [];
  assert.deepEqual(await fetchOpenOffers({ areNullifiersSpent: async (nullifiers) => {
    sizes.push(nullifiers.length);
    return nullifiers.map(() => false);
  } }, offers, 1000n), offers);
  assert.deepEqual(sizes, [256, 1]);
});

test("refreshes canonical status rather than remembering a fill across a reorg", async () => {
  const publication = offer(1);
  let spent = true;
  const node = { areNullifiersSpent: async () => [spent] };
  assert.deepEqual(await fetchOpenOffers(node, [publication], 1000n), []);
  spent = false;
  assert.deepEqual(await fetchOpenOffers(node, [publication], 1000n), [publication]);
});

test("propagates status failures rather than advertising unchecked orders", async () => {
  await assert.rejects(fetchOpenOffers({ areNullifiersSpent: async () => { throw new Error("offline"); } }, [offer(1)], 1000n), /offline/);
});

