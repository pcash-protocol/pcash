import { describe, expect, it } from "vitest";
import { poseidon } from "../src/crypto/poseidon2.ts";
import {
  ACCOUNT_RULE_ENTRY_DOMAIN,
  ACCOUNT_STATE_COMMITMENT_DOMAIN,
} from "../src/constants/domainTags.ts";
import {
  CHONK_VK_LEN,
  VK_LEN,
  accountRuleEntryCommitment,
  buildAccountRuleSet,
  computeChonkVkHash,
  computeCircuitVkHash,
  accountStateCommitment,
  accountUpdateCommitment,
} from "../src/protocol/account.ts";
import { BN254_SCALAR_MODULUS } from "../src/crypto/field.ts";

// Mirrors circuits/protocol/lib/src/authorization/account.nr.
describe("account: address account leaf", () => {
  it("matches the unified formula and commits every account field", () => {
    const digest = 0x4567n;
    const leaf = accountStateCommitment(0xabcn, 0xdefn, 0x123n, 0n, 7n, digest);
    expect(leaf).toBe(poseidon([
      ACCOUNT_STATE_COMMITMENT_DOMAIN,
      0xabcn,
      0xdefn,
      0x123n,
      0n,
      7n,
      digest,
    ]));
    expect(leaf).not.toBe(accountStateCommitment(0xabcn, 0xdefn, 0x124n, 0n, 7n, digest));
    expect(leaf).not.toBe(accountStateCommitment(0xabdn, 0xdefn, 0x123n, 0n, 7n, digest));
    expect(leaf).not.toBe(accountStateCommitment(0xabcn, 0xdf0n, 0x123n, 0n, 7n, digest));
    // accountKind is committed: smart contract (1) differs from user (0).
    expect(accountStateCommitment(0xabcn, 0xdefn, 0x123n, 1n, 7n, digest)).not.toBe(leaf);
    expect(accountStateCommitment(0xabcn, 0xdefn, 0x123n, 0n, 8n, digest)).not.toBe(leaf);
    expect(accountStateCommitment(0xabcn, 0xdefn, 0x123n, 0n, 7n, digest + 1n)).not.toBe(leaf);
    expect(accountStateCommitment(0xabcn, 0xdefn, 0x123n, 0n, 7n, 0n)).not.toBe(leaf);
  });

  it("commits revision zero and a zero nullifier-key commitment like any other value", () => {
    expect(accountStateCommitment(0xabcn, 0n, 0x123n, 0n, 0n, 0n)).toBe(poseidon([
      ACCOUNT_STATE_COMMITMENT_DOMAIN, 0xabcn, 0n, 0x123n, 0n, 0n, 0n,
    ]));
  });

  it("rejects noncanonical unified account preimages", () => {
    expect(() => accountStateCommitment(0xabcn, 0xdefn, 0x123n, 0n, 1n << 32n, 0n)).toThrow(
      /accountRevision must be a u32/,
    );
    // The receive-key operand is a field element; a full-width digest at or above p is not one.
    expect(() => accountStateCommitment(0xabcn, 0xdefn, 0x123n, 0n, 7n, BN254_SCALAR_MODULUS)).toThrow(
      /receiveKeyHash must be a BN254 scalar field element/,
    );
  });
});

describe("account: update commitment", () => {
  it("is network-neutral and binds every operand", () => {
    const params = { currentAccountStateCommitment: 4n, newAccountStateCommitment: 5n };
    const update = accountUpdateCommitment(params);
    expect(accountUpdateCommitment({ ...params, currentAccountStateCommitment: 6n })).not.toBe(update);
    expect(accountUpdateCommitment({ ...params, newAccountStateCommitment: 6n })).not.toBe(update);

  });
});

describe("account: shared account rule entries", () => {
  it("matches the neutral commitment formula", () => {
    const expected = poseidon([
      ACCOUNT_RULE_ENTRY_DOMAIN,
      0x111n,
      0x222n,
      0x333n,
    ]);
    expect(
      accountRuleEntryCommitment(
        0x111n,
        0x222n,
        0x333n,
      ),
    ).toBe(expected);
    expect(accountRuleEntryCommitment(0x112n, 0x222n, 0x333n)).not.toBe(expected);
    expect(accountRuleEntryCommitment(0x111n, 0x223n, 0x333n)).not.toBe(expected);
    expect(
      accountRuleEntryCommitment(
        0x111n,
        0x222n,
        0x334n,
      ),
    ).not.toBe(expected);
  });

  it("builds indexed account rule membership openings", () => {
    const entry = accountRuleEntryCommitment(
      0x111n,
      0x222n,
      0x333n,
    );
    const set = buildAccountRuleSet([
      { accountRuleEntryCommitment: entry, entryIndex: 7 },
    ]);
    const opening = set.membership(7);
    expect(opening.accountRuleSetCommitment).toBe(set.accountRuleSetCommitment);
    expect(opening.entryIndex).toBe(7);
    expect(opening.siblings).toHaveLength(8);
    expect(() => set.membership(8)).toThrow(/account rule entry/);
  });
});

describe("account: Mega VK hash", () => {
  // Known answers from bb.js poseidon2Hash over the fields 1..n.
  it("matches Barretenberg's Poseidon2 hash over the 151 Mega VK fields", () => {
    expect(VK_LEN).toBe(151);
    const vk = Array.from({ length: VK_LEN }, (_, i) => BigInt(i + 1));
    expect(computeCircuitVkHash(vk)).toBe(0x2e7276f329da6603514aafc1bf0457298edcbdb8c3be2191bbd2f35d74326b0en);
  });

  it("matches Barretenberg's Poseidon2 hash over the 119 MegaZK VK fields", () => {
    expect(CHONK_VK_LEN).toBe(119);
    const vk = Array.from({ length: CHONK_VK_LEN }, (_, i) => BigInt(i + 1));
    expect(computeChonkVkHash(vk)).toBe(0x02d324f7faea1fafd2932a0591833f65208e105fc6a2d95ea46b71b523ce6017n);
  });

  it("rejects a VK of the wrong length", () => {
    expect(() => computeCircuitVkHash([1n, 2n, 3n])).toThrow();
    expect(() => computeChonkVkHash(Array.from({ length: VK_LEN }, () => 1n))).toThrow();
  });
});
