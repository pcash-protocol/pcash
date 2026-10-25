import { describe, expect, it, vi } from "vitest";
import type { MempoolItemResult } from "@pcash/sdk/clients";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { issuancePayoutOpening, encodePrivateValueTransaction, deliveryCommitment, randomArena, WIRE_PROOF_BYTES, sizeClassFiller, type PrivateValueOutputData } from "@pcash/sdk/protocol";
import { toHex } from "@pcash/sdk/utils";
import { controlsIssuance, discoverControlledCommitments } from "./relayFees.ts";

const PCASH = 10n ** 18n;
const CHAIN_ID = 1_346_589_512;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const offer = (route: MempoolItemResult["issuanceRoute"], commitment = 0n, openFeeAmount = PCASH, kind = "privateValue") =>
  ({ contentHash: word(commitment + openFeeAmount), kind, openFeeAmount, issuanceRoute: route, issuanceOwnerCommitment: word(commitment) }) as MempoolItemResult;
const open = offer("open");
const mine = offer("designated", 0xabcdn);
const theirs = offer("designated", 0x1234n);
describe("relay issuance destinations", () => {
  it("controls every open route and a designated route only for a controlled commitment", () => {
    expect(controlsIssuance(open, new Set())).toBe(true);
    expect(controlsIssuance(mine, new Set([0xabcdn]))).toBe(true);
    expect(controlsIssuance(theirs, new Set([0xabcdn]))).toBe(false);
    expect(controlsIssuance(offer("none", 0n, 0n, "userAccountCreation"), new Set())).toBe(false);
  });
});

describe("discovering designated commitments this wallet controls", () => {
  const profile = { address: 11n, nkRoot: 22n };
  function designatedEntry(shape: "S" | "L", commitment: bigint, nullifiers: readonly bigint[]): string {
    const layout = PRIVATE_VALUE_PROFILES[shape];
    const outputData = Array.from({ length: layout.outputs }, () => sizeClassFiller()) as unknown as PrivateValueOutputData;
    const arena = randomArena(layout.shapeId);
    const publicInputs = [BigInt(CHAIN_ID), 9n, ...nullifiers, ...Array.from({ length: layout.outputs }, (_, index) => BigInt(2_000 + index)),
      deliveryCommitment(outputData, arena), 0n, commitment, 0n, 12n, 0n, 0n];
    return toHex(encodePrivateValueTransaction({ shape: layout.shapeId, publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData, arena }));
  }

  it("reads each designated entry's own shape, so a large action's thirty-two nullifiers are recognized", async () => {
    const small = Array.from({ length: PRIVATE_VALUE_PROFILES.S.inputs }, (_, index) => BigInt(100 + index));
    const large = Array.from({ length: PRIVATE_VALUE_PROFILES.L.inputs }, (_, index) => BigInt(500 + index));
    const ownSmall = issuancePayoutOpening(profile.address, profile.nkRoot, CHAIN_ID, small, PRIVATE_VALUE_PROFILES.S.shapeId).ownerCommitment;
    const ownLarge = issuancePayoutOpening(profile.address, profile.nkRoot, CHAIN_ID, large, PRIVATE_VALUE_PROFILES.L.shapeId).ownerCommitment;
    const items = [
      { ...offer("designated", ownSmall, 0n), rawTransaction: designatedEntry("S", ownSmall, small) },
      { ...offer("designated", ownLarge), rawTransaction: null },
      { ...offer("designated", 0x1234n), rawTransaction: designatedEntry("S", 0x1234n, small) },
      { ...open, rawTransaction: null },
    ];
    const node = { getMempoolTransaction: vi.fn(async (contentHash: string) => contentHash === items[1]!.contentHash ? { ...items[1]!, rawTransaction: designatedEntry("L", ownLarge, large) } : null) };
    expect(await discoverControlledCommitments(node, items, profile, CHAIN_ID)).toEqual([word(ownSmall), word(ownLarge)].sort());
    expect(node.getMempoolTransaction).toHaveBeenCalledTimes(1);
    expect(await discoverControlledCommitments(node, items, undefined, CHAIN_ID)).toEqual([]);
  });
});
