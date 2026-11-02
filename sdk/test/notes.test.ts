import { describe, expect, it } from "vitest";
import { poseidon } from "../src/crypto/poseidon2.ts";
import {
  IMPLICIT_NOTE_SECRET_SEED_DOMAIN,
  NOTE_BODY_COMMITMENT_DOMAIN,
  OUTPUT_COMMITMENT_DOMAIN,
  NOTE_NULLIFIER_KEY_DOMAIN,
  NULLIFIER_DOMAIN,
  NULLIFIER_KEY_COMMITMENT_DOMAIN,
  OWNER_COMMITMENT_DOMAIN,
  DUMMY_NULLIFIER_DOMAIN,
  TRANSACT_NOTE_SECRET_DOMAIN,
} from "../src/constants/domainTags.ts";
import {
  fullOutputCommitment,
  noteBodyCommitment,
  outputCommitment,
  noteNk,
  noteSecret,
  noteSecretSeed,
  nullifier,
  nullifierKeyCommitment,
  ownerCommitment,
  dummyNullifier,
} from "../src/protocol/notes.ts";

// Mirrors circuits/protocol/lib/src/ledger/note.nr: each formula asserts the module function
// equals poseidon([DOMAIN, ...operands]) computed directly, in spec order.
describe("notes: owners", () => {
  it("an owner commitment binds the uint160 address directly", () => {
    const owner = (1n << 160n) - 1n;
    expect(ownerCommitment(owner, 0x5n)).toBe(poseidon([OWNER_COMMITMENT_DOMAIN, owner, 0x5n]));
    expect(() => ownerCommitment(1n << 160n, 0x5n)).toThrow("owner must fit in 160 bits");
  });

  it("padding notes belong to address zero", () => {
    expect(ownerCommitment(0n, 0x7n)).toBe(poseidon([OWNER_COMMITMENT_DOMAIN, 0n, 0x7n]));
  });
});

describe("notes: address key hierarchy", () => {
  it("P and noteNk match their domain-separated formulas", () => {
    const nkRoot = 0x9999n;
    expect(nullifierKeyCommitment(nkRoot)).toBe(
      poseidon([NULLIFIER_KEY_COMMITMENT_DOMAIN, nkRoot]),
    );
    expect(noteNk(nkRoot)).toBe(poseidon([NOTE_NULLIFIER_KEY_DOMAIN, nkRoot]));
  });

  it("derives the hierarchy from a zero nkRoot like any other root", () => {
    expect(nullifierKeyCommitment(0n)).toBe(poseidon([NULLIFIER_KEY_COMMITMENT_DOMAIN, 0n]));
    expect(noteNk(0n)).toBe(poseidon([NOTE_NULLIFIER_KEY_DOMAIN, 0n]));
  });
});

describe("notes: commitment layers", () => {
  it("owner/body/note commitment layers match formula", () => {
    const owner = 0xabcn;
    const ns = 0xbeefn;
    const amount = 1000n;
    const oc = ownerCommitment(owner, ns);
    expect(oc).toBe(poseidon([OWNER_COMMITMENT_DOMAIN, owner, ns]));
    const body = noteBodyCommitment(oc, 0n, amount);
    expect(body).toBe(poseidon([NOTE_BODY_COMMITMENT_DOMAIN, oc, 0n, amount]));
    const nc = outputCommitment(body, 7n);
    expect(nc).toBe(poseidon([OUTPUT_COMMITMENT_DOMAIN, body, 7n]));

    const note = { owner, noteSecret: ns, assetId: 0n, amount };
    expect(fullOutputCommitment(note, 7n)).toBe(nc);
    // leaf index is a structural uniqueness source
    expect(fullOutputCommitment(note, 8n)).not.toBe(nc);
  });
});

describe("notes: nullifiers", () => {
  it("real and dummy nullifiers match formula and differ", () => {
    const nk = noteNk(0x9999n);
    const noteSecretValue = 0xbeefn;
    const real = nullifier(0x1234n, nk, noteSecretValue);
    expect(real).toBe(
      poseidon([NULLIFIER_DOMAIN, 0x1234n, nk, noteSecretValue]),
    );
    const dummy = dummyNullifier(0xaaaan, 0n);
    expect(dummy).toBe(poseidon([DUMMY_NULLIFIER_DOMAIN, 0xaaaan, 0n]));
    expect(real).not.toBe(dummy);
  });

  it("binds each note opening, including a zero noteSecret", () => {
    const nk = noteNk(0x9999n);
    expect(nullifier(0x1234n, nk, 0x111n)).not.toBe(
      nullifier(0x1234n, nk, 0x222n),
    );
    // A zero secret is one operand of a domain-separated hash, not a zero nullifier.
    const commitment = fullOutputCommitment({ owner: 0x123n, noteSecret: 0n, assetId: 0n, amount: 1n }, 0n);
    expect(commitment).toBe(outputCommitment(noteBodyCommitment(ownerCommitment(0x123n, 0n), 0n, 1n), 0n));
    const zeroSecretNullifier = nullifier(commitment, nk, 0n);
    expect(zeroSecretNullifier).toBe(poseidon([NULLIFIER_DOMAIN, commitment, nk, 0n]));
    expect(zeroSecretNullifier).not.toBe(0n);
  });
});

describe("notes: deterministic output note secrets", () => {
  it("seed + per-output secret match formula and are index-sensitive", () => {
    const nk = noteNk(0x9999n);
    const seed = noteSecretSeed(nk);
    expect(seed).toBe(poseidon([IMPLICIT_NOTE_SECRET_SEED_DOMAIN, nk]));
    const nullifiers = [0x1an, 0x2bn, 0x3cn, 0x4dn];
    const s0 = noteSecret(seed, nullifiers, 0n);
    const s1 = noteSecret(seed, nullifiers, 1n);
    expect(s0).toBe(
      poseidon([TRANSACT_NOTE_SECRET_DOMAIN, seed, 0n, 4n, 5n, 0x1an, 0x2bn, 0x3cn, 0x4dn, 0n, 0n]),
    );
    expect(s0).not.toBe(s1);
    // outputEntropy: 0 is the recoverable default; a fresh value differs.
    expect(noteSecret(seed, nullifiers, 0n, 0x5n)).not.toBe(s0);
    // The salt is the four published nullifiers: changing one changes the secret.
    expect(noteSecret(seed, [0x1an, 0x2bn, 0x3cn, 0x4en], 0n)).not.toBe(s0);
  });
});

// Golden vectors copied verbatim from circuits/protocol/lib/src/ledger/note.nr::test_golden_vectors.
// These pin the full commitment pipeline byte-for-byte across Noir <-> TS.
describe("notes: golden vectors (note.nr::test_golden_vectors)", () => {
  it("outputCommitment golden (owner=0xabc, secret=0xbeef, amount=1000, leaf=7)", () => {
    const oc = ownerCommitment(0xabcn, 0xbeefn);
    const body = noteBodyCommitment(oc, 0n, 1000n);
    expect(body).toBe(
      0x164a08339c97307e73f91488b75b97cdf0a64d56e2bc7358fe24a4fd7aee46d0n,
    );
    expect(outputCommitment(body, 7n)).toBe(
      0x1957bef470681eed3110232bed1596f9af88dd24991d58b8e27231c0ba4e53aan,
    );
  });
});
