import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  contractCreationPublicInputs,
  decodeTransactionForChain,
  userAccountUpdatePublicInputs,
} from "../src/protocol/codec.ts";
import { fromHex, toHex } from "../src/utils/hex.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";

const { offsets, publicInputs: SECTION_WORDS } = PRIVATE_VALUE_PROFILES.S;

interface AccountSectionVector {
  name: string;
  kind: number;
  transactionFile: string;
  sectionOffset: number;
  transactionBytes: number;
  wireWords: string[];
  statementWords: string[];
}

const directory = new URL("../../vectors/account_sections/", import.meta.url);
const vectors: { chainId: number; vectors: AccountSectionVector[] } = JSON.parse(
  readFileSync(new URL("vectors.json", directory), "utf8"),
);

describe("frozen cross-language account-section vectors", () => {
  for (const vector of vectors.vectors) {
    it(vector.name, () => {
      // These exact bytes and expected words are shared with the Rust test;
      // no encoder or statement builder generates the expected side at runtime.
      const bytes = new Uint8Array(readFileSync(new URL(vector.transactionFile, directory)));
      expect(bytes).toHaveLength(vector.transactionBytes);
      const decoded = decodeTransactionForChain(bytes, vectors.chainId);
      expect(decoded.kind).toBe(vector.kind);
      if (decoded.kind !== 2 && decoded.kind !== 3) throw new Error("account section required");
      if (decoded.kind === 2 && decoded.funding.mode !== "sponsored") throw new Error("sponsored section required");
      const section = decoded.kind === 3 ? decoded.section
        : decoded.funding.mode === "sponsored" ? decoded.funding.section : undefined;
      if (!section) throw new Error("missing section");
      expect(section.serializedPublicInputs).toHaveLength(15);
      expect(section.serializedPublicInputs.map(toHex)).toEqual(vector.wireWords);
      expect(bytes.slice(vector.sectionOffset, vector.sectionOffset + 15 * 32)).toEqual(
        fromHex(vector.wireWords.map((word) => word.slice(2)).join("")),
      );
      const statement = decoded.kind === 3
        ? userAccountUpdatePublicInputs(decoded)
        : contractCreationPublicInputs(decoded, BigInt(vector.statementWords[SECTION_WORDS]!));
      expect(statement).toEqual(vector.statementWords.map(BigInt));
      expect(statement).toHaveLength(SECTION_WORDS + 1);
      expect(statement.filter((word) => word === 0n)).toEqual([0n]);
      expect(statement.slice(offsets.openFeeAmount, offsets.notBefore + 1)).toEqual([
        BigInt(vector.wireWords[10]!), 0n, BigInt(vector.wireWords[11]!),
      ]);
      expect(section.arena).toHaveLength(PRIVATE_VALUE_PROFILES.S.arenaBytes);
    });
  }
});
