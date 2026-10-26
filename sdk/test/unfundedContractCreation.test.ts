import { describe, expect, it } from "vitest";
import { buildUnfundedContractCreation } from "../src/builders/index.ts";
import { assertMempoolAdmissible, type StatusResult } from "../src/clients/index.ts";
import { BN254_SCALAR_MODULUS } from "../src/crypto/field.ts";
import {
  CONTRACT_MAX_BODY_BYTES,
  CONTRACT_MAX_TX_BYTES,
  MAX_TX_BYTES,
  TX_KIND_CONTRACT_ACCOUNT_CREATION,
  contractAccountCreationSize,
  decodeTransaction,
  decodeTransactionForChain,
  encodeContractAccountCreation,
  functionSelector,
  isUnpaidTransaction,
  transactionOpenFee,
  transactionPublication,
  type BuildContractParams,
} from "../src/protocol/index.ts";
import { concatBytes } from "../src/utils/bytes.ts";
import { toHex } from "../src/utils/hex.ts";

const contract: BuildContractParams = {
  nullifierKey: { publishesNkRoot: false, nullifierKeyCommitment: 0x11n },
  functions: [
    { selector: functionSelector(1), applicationVkHash: 0x22n, configurationCommitment: 0x33n },
    { selector: functionSelector(5), applicationVkHash: 0x44n, configurationCommitment: 0x55n },
  ],
};
const params = {
  pcashChainId: 0x50435348n,
  contract,
  recentPcashBlockHash: 0x66n,
  validUntilTimestamp: 0x0102030405060708n,
};
// type ‖ chain ID ‖ recentPcashBlockHash ‖ validUntilTimestamp ‖ body.
const FROZEN_TRANSACTION = "0x025043534800000000000000000000000000000000000000000000000000000000000000660102030405060708000000000000000000000000000000000000000000000000000000000000000011000201000000000000000000000000000000000000000000000000000000000000002200000000000000000000000000000000000000000000000000000000000000330500000000000000000000000000000000000000000000000000000000000000440000000000000000000000000000000000000000000000000000000000000055";
/** envelope(5) ‖ recentPcashBlockHash(32) ‖ validUntilTimestamp(8). */
const BODY_OFFSET = 45;

describe("unfunded contract creation", () => {
  it("matches frozen wire bytes, content address, and revision-one account leaf", () => {
    const build = buildUnfundedContractCreation(params);
    expect(toHex(build.transactionBytes)).toBe(FROZEN_TRANSACTION);
    expect(build.transactionBytes.length).toBe(210);
    expect(build.transactionBytes.length).toBe(contractAccountCreationSize(build.body.length));
    expect(build.address).toBe(0x00b4c38cdda10658734731fdde9d0bc225043b4cn);
    expect(build.accountStateCommitment).toBe(0x0cb5521888121b9fc096a3bf387ad4aaa8af754be8251468d05f4847c9c86860n);
    expect(contractAccountCreationSize(CONTRACT_MAX_BODY_BYTES)).toBe(5 + 40 + CONTRACT_MAX_BODY_BYTES);
    expect(contractAccountCreationSize(CONTRACT_MAX_BODY_BYTES)).toBe(CONTRACT_MAX_TX_BYTES);
  });

  it("uses the same account for different inclusion bounds", () => {
    const build = buildUnfundedContractCreation(params);
    const refreshed = buildUnfundedContractCreation({ ...params, recentPcashBlockHash: 0x77n, validUntilTimestamp: 1n });
    expect(refreshed.address).toBe(build.address);
    expect(refreshed.accountStateCommitment).toBe(build.accountStateCommitment);
    expect(refreshed.body).toEqual(build.body);
    expect(refreshed.transactionBytes).not.toEqual(build.transactionBytes);
  });

  it("decodes both nullifier disclosure profiles with and without a receive key", () => {
    for (const nullifierKey of [
      { publishesNkRoot: false, nullifierKeyCommitment: 0x11n } as const,
      { publishesNkRoot: true, nkRoot: 0x99n } as const,
    ]) for (const mlKemPublicKey of [undefined, new Uint8Array(1184).fill(7)]) {
      const build = buildUnfundedContractCreation({
        ...params,
        contract: { ...contract, nullifierKey, ...(mlKemPublicKey === undefined ? {} : { mlKemPublicKey }) },
      });
      const decoded = decodeTransaction(build.transactionBytes);
      expect(decoded.kind).toBe(TX_KIND_CONTRACT_ACCOUNT_CREATION);
      if (decoded.kind !== TX_KIND_CONTRACT_ACCOUNT_CREATION) throw new Error("type");
      expect(decoded.body).toEqual(build.body);
      expect(decoded.publishesNkRoot).toBe(nullifierKey.publishesNkRoot);
      expect(decoded.mlKemPublicKey).toEqual(mlKemPublicKey ?? null);
      expect(decoded.functions.map(({ selector }) => selector)).toEqual([1, 5]);
      expect(toHex(decoded.recentPcashBlockHash)).toBe(`0x${"00".repeat(31)}66`);
      expect(decoded.validUntilTimestamp).toBe(params.validUntilTimestamp);
      expect(decoded).not.toHaveProperty("section");
    }
  });

  it("has no fee, issuance destination, nullifiers, or private-value section", () => {
    const { transactionBytes: entry } = buildUnfundedContractCreation(params);
    expect(transactionPublication(entry)).toBeNull();
    expect(transactionPublication(decodeTransaction(entry))).toBeNull();
    expect(transactionOpenFee(entry)).toBe(0n);
    expect(isUnpaidTransaction(entry)).toBe(true);
    expect(() => assertMempoolAdmissible({ pcashChainId: Number(params.pcashChainId), acceptedTransactionTypes: [0, 1, 2, 3] } as StatusResult, entry)).not.toThrow();
    expect(() => assertMempoolAdmissible({ acceptedTransactionTypes: [0, 1, 3] } as StatusResult, entry)).toThrow(/0x02 is not accepted/);
    expect(() => decodeTransactionForChain(entry, params.pcashChainId + 1n)).toThrow(/wrong PCASH chain ID/);
  });

  it("rejects truncated bodies or bounds and consumes all bytes", () => {
    const { transactionBytes: entry } = buildUnfundedContractCreation(params);
    for (const cut of [1, 65, 100, entry.length - 6, entry.length - 30, entry.length - 40, entry.length - 45]) {
      expect(() => decodeTransaction(entry.slice(0, -cut))).toThrow(/unexpected end/);
    }
    for (const extra of [1, 65, 300]) {
      expect(() => decodeTransaction(concatBytes(entry, new Uint8Array(extra)))).toThrow(/trailing bytes/);
    }
    // body: publishesNkRoot(1) ‖ material(32) ‖ receive-key mode(1), then the function count.
    const missingFunctions = entry.slice();
    missingFunctions[BODY_OFFSET + 34] = 3;
    expect(() => decodeTransaction(missingFunctions)).toThrow(/unexpected end/);
  });

  it("rejects selector bytes outside their sets and preserves semantic-invalid words for consensus", () => {
    const { transactionBytes: entry } = buildUnfundedContractCreation(params);
    const nkRootFlag = entry.slice();
    nkRootFlag[BODY_OFFSET] = 9;
    expect(() => decodeTransaction(nkRootFlag)).toThrow(/publishesNkRoot must be 0 or 1/);
    const receiveKeyMode = entry.slice();
    receiveKeyMode[BODY_OFFSET + 33] = 8;
    expect(() => decodeTransaction(receiveKeyMode)).toThrow(/receive-key mode 8/);
    const raw = entry.slice();
    raw.fill(255, 5, 37);
    const decoded = decodeTransaction(raw);
    if (decoded.kind !== TX_KIND_CONTRACT_ACCOUNT_CREATION) throw new Error("type");
    expect(decoded.recentPcashBlockHash).toEqual(new Uint8Array(32).fill(255));
  });

  it("rejects unencodable caller inputs and invalid contract bodies", () => {
    const { body } = buildUnfundedContractCreation(params);
    const unfunded = (recentPcashBlockHash: bigint, validUntilTimestamp: bigint) =>
      ({ recentPcashBlockHash, validUntilTimestamp }) as const;
    expect(() => encodeContractAccountCreation(params.pcashChainId, body, unfunded(BN254_SCALAR_MODULUS, 0n))).toThrow(/recentPcashBlockHash/);
    expect(() => encodeContractAccountCreation(params.pcashChainId, body, unfunded(1n, 1n << 64n))).toThrow(/u64/);
    expect(() => encodeContractAccountCreation(1n << 32n, body, unfunded(1n, 0n))).toThrow(/pcashChainId/);
    expect(() => encodeContractAccountCreation(params.pcashChainId, new Uint8Array(MAX_TX_BYTES), unfunded(1n, 0n))).toThrow(/MAX_TX_BYTES/);
    expect(() => buildUnfundedContractCreation({ ...params, contract: { ...contract, functions: [] } })).toThrow(/at least one function/);
    expect(() => buildUnfundedContractCreation({ ...params, contract: { ...contract, functions: [...contract.functions].reverse() } })).toThrow(/strictly increasing/);
  });
});
