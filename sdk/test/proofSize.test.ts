// Pin the fixed per-entry parsing bound and the per-kind sizing maxima
// so they can't silently drift from node/crates/derive/src/params.rs.
// MAX_TX_BYTES is a fixed constant, deliberately NOT derived from the formats;
// the per-kind maxima are non-normative sizing guidance. The proof-size consts
// are measured compressed CHONK proofs and, with no length prefix on the wire,
// decide where each section's output data begins.
import { describe, expect, it } from "vitest";
import {
  WIRE_PROOF_BYTES,
  CONTRACT_FUNCTION_BYTES,
  CONTRACT_MAX_BODY_BYTES,
  CONTRACT_MAX_TX_BYTES,
  MAX_TX_BYTES,
  MAX_VALID_TX_BYTES,
  USER_ACCOUNT_UPDATE_MAX_TX_BYTES,
  USER_ACCOUNT_CREATION_MAX_TX_BYTES,
  PRIVATE_VALUE_MAX_TX_BYTES,
  PRIVATE_VALUE_PUBLIC_INPUTS,
  PRIVATE_VALUE_WIRE_PUBLIC_INPUTS,
  encodeContractAccountCreation,
  privateValueSectionBytes,
  privateValueTransactionSize,
} from "../src/protocol/codec.ts";
import { OUTPUT_DATA_BYTES } from "../src/constants/params.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { deliveryCommitment } from "../src/protocol/transfer.ts";
import {
  encodeContractBody,
  functionSelector,
  type ContractFunction,
} from "../src/protocol/contract.ts";

const entrySize = (wireWords: number, proofBytes: number, nOutputData: number, arenaBytes: number): number =>
  6 + wireWords * 32 + proofBytes + nOutputData * OUTPUT_DATA_BYTES + arenaBytes;

describe("txBytes sizing maxima and the fixed parsing bound", () => {
  it("uses the canonical statement sizes and the measured wire-proof sizes", () => {
    expect(PRIVATE_VALUE_PUBLIC_INPUTS).toBe(18);
    expect(PRIVATE_VALUE_WIRE_PUBLIC_INPUTS).toBe(16);
    expect(WIRE_PROOF_BYTES).toBe(22_432);
    expect(OUTPUT_DATA_BYTES).toBe(1213);
    // A 32-byte salt and eight 65-byte cells per output.
    expect(PRIVATE_VALUE_PROFILES.S.arenaBytes).toBe(32 + 40 * 65);
    expect(PRIVATE_VALUE_PROFILES.L.arenaBytes).toBe(32 + 256 * 65);
  });

  it("derives every per-kind sizing maximum from the release-pinned proof sizes", () => {
    expect(privateValueTransactionSize(0)).toBe(entrySize(16, WIRE_PROOF_BYTES, 5, 2632));
    expect(privateValueTransactionSize(0)).toBe(31_647);
    expect(privateValueTransactionSize(1)).toBe(entrySize(71, WIRE_PROOF_BYTES, 32, 16_672));
    expect(PRIVATE_VALUE_MAX_TX_BYTES).toBe(privateValueTransactionSize(1));
    expect(PRIVATE_VALUE_MAX_TX_BYTES).toBe(80_198);
    // Signed creation with a receive key: envelope, mode, two words, key mode and key, recent block, deadline, signature.
    expect(USER_ACCOUNT_CREATION_MAX_TX_BYTES).toBe(5 + 1 + 64 + 1 + 1184 + 32 + 8 + 65);
    expect(USER_ACCOUNT_CREATION_MAX_TX_BYTES).toBe(1360);
    expect(CONTRACT_FUNCTION_BYTES).toBe(65);
    expect(CONTRACT_MAX_BODY_BYTES).toBe(1 + 32 + 1 + 1184 + 1 + 255 * 65);
    expect(CONTRACT_MAX_BODY_BYTES).toBe(17_794);
    // Account sections omit the zero issuance word and use the shared proof body size.
    expect(privateValueSectionBytes(WIRE_PROOF_BYTES, { kind: "userAccountUpdate" })).toBe(15 * 32 + 22_432 + 5 * 1213 + 2632);
    // Sponsored creation, the larger funding mode, carries a full private-value section.
    expect(CONTRACT_MAX_TX_BYTES).toBe(5 + 1 + privateValueSectionBytes(WIRE_PROOF_BYTES, { kind: "userAccountUpdate" }) + 17_794);
    expect(CONTRACT_MAX_TX_BYTES).toBe(49_409);
    expect(USER_ACCOUNT_UPDATE_MAX_TX_BYTES).toBe(
      5 + 53 + 1184 + 32 + privateValueSectionBytes(WIRE_PROOF_BYTES, { kind: "userAccountUpdate" }),
    );
    expect(USER_ACCOUNT_UPDATE_MAX_TX_BYTES).toBe(32_883);
    // L is the widest compiled shape.
    expect(MAX_VALID_TX_BYTES).toBe(PRIVATE_VALUE_MAX_TX_BYTES);
  });

  it("pins MAX_TX_BYTES to the fixed 131,072 parsing bound, not the per-kind maxima", () => {
    expect(MAX_TX_BYTES).toBe(131_072);
    // The fixed bound sits above every real per-kind maximum; entries between the
    // two parse and are skipped per-entry rather than failing batch framing.
    expect(MAX_TX_BYTES).toBeGreaterThan(
      Math.max(
        PRIVATE_VALUE_MAX_TX_BYTES,
        USER_ACCOUNT_CREATION_MAX_TX_BYTES,
        CONTRACT_MAX_TX_BYTES,
      ),
    );
  });

  it("serializes the maximum contract body to exactly the derived cap", () => {
    const functions: ContractFunction[] = Array.from({ length: 255 }, (_, selector) => ({
      selector: functionSelector(selector),
      applicationVkHash: BigInt(selector + 1),
      configurationCommitment: BigInt(selector + 2),
    }));
    const body = encodeContractBody({
      nullifierKey: { publishesNkRoot: true, nkRoot: 3n },
      mlKemPublicKey: new Uint8Array(1184),
      functions,
    });
    expect(body).toHaveLength(CONTRACT_MAX_BODY_BYTES);
    const data = new Uint8Array(OUTPUT_DATA_BYTES).fill(0xcd);
    data[0] = 1;
    const outputData = [data, data, data, data, data] as const;
    const arena = new Uint8Array(PRIVATE_VALUE_PROFILES.S.arenaBytes).fill(0xab);
    const { offsets } = PRIVATE_VALUE_PROFILES.S;
    const publicInputs = Array.from({ length: PRIVATE_VALUE_PUBLIC_INPUTS }, (_, index) => BigInt(index + 1));
    publicInputs[offsets.chainId] = 0x50435348n;
    publicInputs[offsets.issuanceOwner] = 0n;
    publicInputs[offsets.deliveryCommitment] = deliveryCommitment(outputData, arena);
    expect(encodeContractAccountCreation(0x50435348n, body, {
      mode: "sponsored",
      section: { publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData, arena },
    })).toHaveLength(CONTRACT_MAX_TX_BYTES);
  });
});
