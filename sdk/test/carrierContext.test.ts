import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CARRIER_KIND_EVENT,
  CARRIER_KIND_INBOX,
  carrierContextHash,
  type CarrierKind,
} from "../src/protocol/carrierContext.ts";
import { CARRIER_CONTEXT_DOMAIN } from "../src/constants/domainTags.ts";
import { poseidon } from "../src/crypto/poseidon2.ts";
import { fromHex } from "../src/utils/hex.ts";

interface CarrierContextVector {
  name: string;
  kind: CarrierKind;
  address: `0x${string}`;
  context: string;
  inputCount: number;
  inputs: string[];
  hash: string;
}

const vectors: CarrierContextVector[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../vectors/protocol_vectors.json", import.meta.url)), "utf8"),
).carrierContexts;

const ADDRESS = "0x3333333333333333333333333333333333333333";

describe("carrier context hash", () => {
  it("numbers the carrier kinds", () => {
    expect([CARRIER_KIND_INBOX, CARRIER_KIND_EVENT]).toEqual([0, 1]);
  });

  it("covers an empty context, a short final chunk, one abi.encode word set, and more than eight chunks", () => {
    expect(vectors.map((vector) => [vector.kind, fromHex(vector.context).length, vector.inputCount])).toEqual([
      [0, 0, 12],
      [1, 0, 12],
      [1, 17, 12],
      [1, 128, 12],
      [1, 200, 17],
    ]);
  });

  it.each(vectors.map((vector) => [vector.name, vector] as const))("reproduces the frozen vector: %s", (_name, vector) => {
    const expected = BigInt(vector.hash);
    expect(poseidon(vector.inputs.map((input) => BigInt(input)))).toBe(expected);
    expect(BigInt(vector.inputs[0]!)).toBe(CARRIER_CONTEXT_DOMAIN);
    expect(carrierContextHash(vector.kind, vector.address, fromHex(vector.context))).toBe(expected);
  });

  it("keeps an Inbox sender apart from an event emitter at the same address", () => {
    const empty = new Uint8Array(0);
    expect(carrierContextHash(CARRIER_KIND_INBOX, ADDRESS, empty)).not.toBe(
      carrierContextHash(CARRIER_KIND_EVENT, ADDRESS, empty),
    );
  });

  it("separates contexts that differ only in length", () => {
    const sixteen = new Uint8Array(16).fill(7);
    const seventeen = Uint8Array.of(...sixteen, 0);
    expect(carrierContextHash(CARRIER_KIND_EVENT, ADDRESS, sixteen)).not.toBe(
      carrierContextHash(CARRIER_KIND_EVENT, ADDRESS, seventeen),
    );
  });

  it("rejects an address that is not 20 bytes", () => {
    expect(() => carrierContextHash(CARRIER_KIND_EVENT, "0x1234", new Uint8Array(0))).toThrow(/address/);
  });
});
