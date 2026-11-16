import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeTransactionForChain,
  privateValuePublicInputs,
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
      if (decoded.kind !== 0 && decoded.kind !== 3) throw new Error("private-value section required");
      const section = decoded.kind === 0 ? decoded : decoded.section;
      expect(section.serializedPublicInputs).toHaveLength(vector.wireWords.length);
      expect(section.serializedPublicInputs.map(toHex)).toEqual(vector.wireWords);
      expect(bytes.slice(vector.sectionOffset, vector.sectionOffset + vector.wireWords.length * 32)).toEqual(
        fromHex(vector.wireWords.map((word) => word.slice(2)).join("")),
      );
      const statement = decoded.kind === 0 ? privateValuePublicInputs(decoded) : userAccountUpdatePublicInputs(decoded);
      expect(statement).toEqual(vector.statementWords.map(BigInt));
      expect(statement).toHaveLength(SECTION_WORDS + Number(decoded.kind === 3));
      expect(statement[offsets.issuanceOwner]).toBe(0n);
      expect(section.arena).toHaveLength(PRIVATE_VALUE_PROFILES.S.arenaBytes);
    });
  }
});
