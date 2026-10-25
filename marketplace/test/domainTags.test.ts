import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { domainTag } from "@pcash/sdk/crypto";
import { CLAIM_KEY_COMMITMENT_DOMAIN } from "../src/commitments.mts";
import { RECLAIM_PAYOUT_OPENING_DOMAIN } from "../src/client/reclaimWitness.ts";

function circuitConstant(circuit: string, name: string): bigint {
  const source = readFileSync(new URL(`../l2-contracts/escrow/${circuit}/src/main.nr`, import.meta.url), "utf8");
  const match = source.match(new RegExp(`${name}: Field =\\s*(0x[0-9a-f]+);`));
  assert.ok(match, `${name} in the ${circuit} circuit`);
  return BigInt(match[1]!);
}

test("escrow domain tags follow the pcash derivation", () => {
  assert.equal(CLAIM_KEY_COMMITMENT_DOMAIN, domainTag("escrow_claim_key_commitment"));
  assert.equal(RECLAIM_PAYOUT_OPENING_DOMAIN, domainTag("escrow_reclaim_payout_opening"));
});

test("the escrow circuits carry the TypeScript domain tags", () => {
  assert.equal(circuitConstant("claim", "CLAIM_KEY_COMMITMENT_DOMAIN"), CLAIM_KEY_COMMITMENT_DOMAIN);
  assert.equal(circuitConstant("reclaim", "RECLAIM_PAYOUT_OPENING_DOMAIN"), RECLAIM_PAYOUT_OPENING_DOMAIN);
});
