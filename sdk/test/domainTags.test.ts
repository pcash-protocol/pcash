import { describe, expect, it } from "vitest";
import {
  ACCOUNT_RULE_ENTRY_DOMAIN,
  CONTRACT_ADDRESS_DOMAIN,
  OUTPUT_COMMITMENT_DOMAIN,
  NULLIFIER_DOMAIN,
  NULLIFIER_KEY_COMMITMENT_DOMAIN,
  ACCOUNT_STATE_COMMITMENT_DOMAIN,
} from "../src/constants/domainTags.ts";
import { bytesToBigInt, utf8 } from "../src/utils/bytes.ts";
import { poseidon } from "../src/crypto/poseidon2.ts";

// poseidon(uint64(L), chunk_0, ..., chunk_(m-1)) over the L bytes of
// "pcash." || context, in 16-byte big-endian chunks.
const derive = (context: string): bigint => {
  const bytes = utf8(`pcash.${context}`);
  const chunks: bigint[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) chunks.push(bytesToBigInt(bytes.subarray(offset, offset + 16)));
  return poseidon([BigInt(bytes.length), ...chunks]);
};

describe("domain tags", () => {
  it("matches independently derived formula vectors", () => {
    expect(NULLIFIER_KEY_COMMITMENT_DOMAIN).toBe(derive("nullifier_key_commitment"));
    expect(OUTPUT_COMMITMENT_DOMAIN).toBe(derive("output_commitment"));
    expect(NULLIFIER_DOMAIN).toBe(derive("nullifier"));
    expect(ACCOUNT_STATE_COMMITMENT_DOMAIN).toBe(derive("account_state_commitment"));
    expect(ACCOUNT_RULE_ENTRY_DOMAIN).toBe(derive("account_rule_entry"));
    expect(CONTRACT_ADDRESS_DOMAIN).toBe(derive("contract_address"));
  });
});
