import { describe, expect, it } from "vitest";
import { encodePrivateValueTransaction, deliveryCommitment, randomArena, WIRE_PROOF_BYTES, sizeClassFiller,
  issuancePayoutOpening, posterPayoutOpening } from "@pcash/sdk/protocol";
import type { FeeEstimateResult } from "@pcash/sdk/clients";
import { addressHex } from "@pcash/sdk/utils";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import {
  controlsSystemPayout, FALLBACK_TRANSACTION_FEE_AMOUNT, PADDED_PRIVATE_VALUE_BYTE_SIZE,
  estimatedTransactionFee, pendingIssuanceBeneficiary, planPublication, publicationOf,
  resolvePublicationFunding,
} from "../../src/wallet/actions/publication.ts";
import { InsufficientNotesError } from "../../src/wallet/noteStore.ts";

const byteSize = PADDED_PRIVATE_VALUE_BYTE_SIZE;
function node(standard = 7n) {
  const calls: bigint[] = [];
  return {
    calls,
    async estimateFee(query: { byteSize?: bigint }): Promise<FeeEstimateResult> {
      calls.push(query.byteSize!);
      return { head: { blockNumber: 1n, blockHash: `0x${"11".repeat(32)}` },
        windowBlocks: 1n, byteSize, tiers: { low: standard / 2n, standard, fast: standard * 2n },
        basis: { includedSamples: 0n, included: null, pendingSamples: 0n, pending: null } };
    },
  };
}

describe("publication planning", () => {
  const recipient = 0x1234n;
  const provider = { recipient, requestQuote: async () => { throw new Error("planning must not request a quote"); } };

  it("estimates only the public open fee", async () => {
    const estimating = node();
    expect(await planPublication({ qualifying: true, byteSize, publication: "open", node: estimating }))
      .toEqual({ openFeeAmount: 7n, privateRelayFeeAmount: 0n, publication: "open",
        beneficiary: { kind: "publisher" }, privateRelayRecipient: null });
    expect(estimating.calls).toEqual([byteSize]);
  });

  it("self-publication has zero PCASH fee and its own issuance destination", async () => {
    const estimating = node();
    expect(await planPublication({ qualifying: true, byteSize, publication: "self", node: estimating }))
      .toEqual({ openFeeAmount: 0n, privateRelayFeeAmount: 0n, publication: "self",
        beneficiary: { kind: "self" }, privateRelayRecipient: null });
    expect(estimating.calls).toEqual([]);
    await expect(planPublication({ qualifying: true, byteSize, publication: "self", openFeeAmount: 1n, node: estimating }))
      .rejects.toThrow(/no PCASH network fee/);
  });

  it("selected publication funds an exact private fee without a public bounty", async () => {
    const estimating = node();
    expect(await planPublication({ qualifying: false, byteSize, publication: "selected",
      openFeeAmount: 0n, privateRelayFeeAmount: 8n, selectedRelayQuote: provider, node: estimating }))
      .toEqual({ openFeeAmount: 0n, privateRelayFeeAmount: 8n, publication: "selected",
        beneficiary: { kind: "none" }, privateRelayRecipient: addressHex(recipient) });
    expect(estimating.calls).toEqual([]);
    await expect(planPublication({ qualifying: false, byteSize, publication: "selected",
      openFeeAmount: 1n, privateRelayFeeAmount: 8n, selectedRelayQuote: provider, node: estimating }))
      .rejects.toThrow(/no public open fee/);
    await expect(planPublication({ qualifying: false, byteSize, publication: "selected",
      selectedRelayQuote: provider, node: estimating })).rejects.toThrow(/positive private relay fee/);
    await expect(planPublication({ qualifying: false, byteSize, publication: "open",
      selectedRelayQuote: provider, node: estimating })).rejects.toThrow(/selected publication/);
  });

  it("public account operations require a positive open fee", async () => {
    await expect(planPublication({ qualifying: false, byteSize, publication: "open",
      openFeeAmount: 0n, node: node() })).rejects.toThrow(/zero fee pays no publisher/);
    expect((await planPublication({ qualifying: false, byteSize, publication: "open",
      openFeeAmount: 2n, node: node() })).openFeeAmount).toBe(2n);
  });

  it("checks the public uint128 range and maps adapter modes", async () => {
    await expect(planPublication({ qualifying: true, byteSize, publication: "open",
      openFeeAmount: 1n << 128n, node: node() })).rejects.toThrow(/128-bit/);
    expect(publicationOf({ mode: "mempool" })).toBe("open");
    expect(publicationOf({ mode: "l1" })).toBe("self");
    expect(publicationOf({ mode: "mempool" }, 8n)).toBe("selected");
  });

  it("funds open and private fees together", async () => {
    const plan = await planPublication({ qualifying: true, byteSize, publication: "selected",
      privateRelayFeeAmount: 8n, selectedRelayQuote: provider, node: node() });
    expect(resolvePublicationFunding(plan, (amount) => amount)).toMatchObject({ funding: 8n });
    const insufficient = new InsufficientNotesError({ need: 8n, maximumTransfer: 0n, totalBalance: 0n, maxInputs: 4, outputCount: 1 });
    expect(() => resolvePublicationFunding(plan, () => { throw insufficient; })).toThrow(insufficient);
  });
});

it("suggests a padded public fee and retains seed-only system payout recovery", async () => {
  expect(await estimatedTransactionFee(byteSize, undefined)).toBe(FALLBACK_TRANSACTION_FEE_AMOUNT);
  const outputData = Array.from({ length: 5 }, () => sizeClassFiller());
  const arena = randomArena(PRIVATE_VALUE_PROFILES.S.shapeId);
  const { offsets } = PRIVATE_VALUE_PROFILES.S;
  const publicInputs = Array<bigint>(PRIVATE_VALUE_PROFILES.S.publicInputs).fill(0n);
  publicInputs[offsets.chainId] = 1n;
  publicInputs[offsets.validUntil] = 1n;
  publicInputs[offsets.deliveryCommitment] = deliveryCommitment(outputData, arena);
  expect(BigInt(encodePrivateValueTransaction({ publicInputs, proof: new Uint8Array(WIRE_PROOF_BYTES), outputData, arena }).length))
    .toBe(PADDED_PRIVATE_VALUE_BYTE_SIZE);

  const mine = { address: 0x77n, nkRoot: 0x123n };
  const poster = posterPayoutOpening(mine.address, mine.nkRoot, 12n);
  const issuance = issuancePayoutOpening(mine.address, mine.nkRoot, 8190n, [1n, 2n, 3n, 4n]);
  expect(controlsSystemPayout(mine, { source: { kind: "posterPayout", l1TransactionIndices: [0n] },
    ownerCommitment: poster.ownerCommitment, contexts: [poster.context] })).toBe(true);
  expect(controlsSystemPayout(mine, { source: { kind: "designatedIssuance", l1TransactionIndex: 0n, batchItemIndex: 1n },
    ownerCommitment: issuance.ownerCommitment, contexts: [issuance.context] })).toBe(true);
  expect(pendingIssuanceBeneficiary({ issuanceRecipient: addressHex(0x123n) }, { address: 0xabcn }))
    .toEqual({ kind: "recipient", address: addressHex(0x123n) });
});
