import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_NETWORK_CONFIG } from "@pcash/sdk/protocol";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import { MIN_CLAIM_WINDOW_SECONDS } from "../src/commitments.mts";
import { reconstructOfferFromPublication } from "../src/client/publication.ts";
import {
  DEFAULT_SEED_PAID_DEADLINE_LEAD_SECONDS,
  DEFAULT_SEED_UNPAID_DEADLINE_LEAD_SECONDS,
  prepareMarketplaceSeedOffers,
  type PrepareMarketplaceSeedOffersParams,
} from "../src/tooling/seedPreparation.mts";

const sellerWallet = derivePcashProfileFromPrivateKey(
  Uint8Array.from({ length: 32 }, (_, index) => index + 1),
  DEFAULT_NETWORK_CONFIG,
);

function params(): PrepareMarketplaceSeedOffersParams {
  return {
    network: DEFAULT_NETWORK_CONFIG,
    seller: {
      wallet: sellerWallet,
      paymentAddress: 0x111122223333444455556666777788889999aaaAn,
    },
    router: 0x9999888877776666555544443333222211110000n,
    latestL1Timestamp: 1_800_000_000n,
    paid: {
      entropy: {
        l2ContractNkRoot: 2n,
      },
      amounts: { pcashAmount: 1_000n, ethPriceWei: 20_000n },
    },
    unpaid: {
      entropy: {
        l2ContractNkRoot: 6n,
      },
      amounts: { pcashAmount: 2_000n, ethPriceWei: 30_000n },
    },
  };
}

describe("prepareMarketplaceSeedOffers", () => {
  it("deterministically prepares both contracts, publications, and source openings", () => {
    const first = prepareMarketplaceSeedOffers(params());
    const second = prepareMarketplaceSeedOffers(params());
    assert.deepEqual(second, first);

    assert.notEqual(first.paid.offer.l2ContractAddress, first.unpaid.offer.l2ContractAddress);
    assert.equal(
      first.paid.offer.terms.deadlineT,
      1_800_000_000n + DEFAULT_SEED_PAID_DEADLINE_LEAD_SECONDS,
    );
    assert.equal(
      first.unpaid.offer.terms.deadlineT,
      1_800_000_000n + DEFAULT_SEED_UNPAID_DEADLINE_LEAD_SECONDS,
    );
    assert.equal(first.sourceOpenings.length, 4);
    assert.equal(first.paid.sourceOpenings.length, 2);
    assert.equal(first.unpaid.sourceOpenings.length, 2);
    assert.equal(
      first.paid.sourceOpenings[0]!.address,
      `0x${first.paid.offer.l2ContractAddress.toString(16).padStart(40, "0")}`,
    );
    assert.equal(first.publications[0], first.paid.publication);
    assert.equal(first.publications[1], first.unpaid.publication);
    assert.equal(first.paid.publication.escrow, undefined);
    assert.equal(first.unpaid.publication.escrow, undefined);

    const reconstructed = reconstructOfferFromPublication(
      first.paid.publication,
      sellerWallet,
      DEFAULT_NETWORK_CONFIG,
    );
    assert.equal(reconstructed.l2ContractAddress, first.paid.offer.l2ContractAddress);
    assert.deepEqual(reconstructed.l2ContractBody, first.paid.offer.l2ContractBody);
  });

  it("prepares a contract under a zero published nkRoot like any other root", () => {
    const zeroRoot = params();
    zeroRoot.paid.entropy.l2ContractNkRoot = 0n;
    const prepared = prepareMarketplaceSeedOffers(zeroRoot);
    assert.equal(prepared.paid.offer.l2ContractNkRoot, 0n);
    assert.notEqual(prepared.paid.offer.l2ContractAddress, prepareMarketplaceSeedOffers(params()).paid.offer.l2ContractAddress);
  });

  it("rejects ambiguous entropy and unsafe seed parameters", () => {
    const duplicate = params();
    duplicate.unpaid.entropy.l2ContractNkRoot = duplicate.paid.entropy.l2ContractNkRoot;
    assert.throws(() => prepareMarketplaceSeedOffers(duplicate), /distinct l2ContractNkRoot/);

    const shortWindow = params();
    shortWindow.paid.deadlineLeadSeconds = MIN_CLAIM_WINDOW_SECONDS + 299n;
    assert.throws(() => prepareMarketplaceSeedOffers(shortWindow), /paid deadline lead/);

    const badRouter = params();
    badRouter.router = 1n << 160n;
    assert.throws(() => prepareMarketplaceSeedOffers(badRouter), /router must fit in 160 bits/);
  });
});
