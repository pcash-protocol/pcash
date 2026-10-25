import { describe, expect, it } from "vitest";
import { prepareContractFeeSponsorshipAuthorization } from "../src/builders/sponsoredTransfer.ts";
import type { AssetActionBuild } from "../src/builders/assetAction.ts";
import type { AssetAccountAuthorization } from "../src/builders/assetOutputs.ts";
import { ACCOUNT_KIND_CONTRACT, ACCOUNT_KIND_USER } from "../src/constants/params.ts";
import { SlotClass, privateValueCommitment, type PrivateValue } from "../src/protocol/transaction.ts";
import { deriveTestWallet } from "./testWallet.ts";

const wallet = deriveTestWallet();
const contract = 0x2222222222222222222222222222222222222222n;
const transaction: PrivateValue = {
  global: {
    openFeeAmount: 5n,
    issuanceOwnerCommitment: 0n,
    notBeforeTimestamp: 0n,
    validUntilTimestamp: 100n,
    carrierContextHash: 0n,
    assetBurnAmount: 0n,
    deliveryCommitment: 0n,
  },
  inputs: [
    { slotClass: SlotClass.ASSET, inputCommitment: 1n, nullifier: 11n },
    { slotClass: SlotClass.NATIVE, inputCommitment: 2n, nullifier: 12n },
    { slotClass: SlotClass.DUMMY, inputCommitment: 0n, nullifier: 13n },
    { slotClass: SlotClass.DUMMY, inputCommitment: 0n, nullifier: 14n },
  ],
  outputs: [
    { slotClass: SlotClass.DUMMY, outputBodyCommitment: 20n },
    { slotClass: SlotClass.DUMMY, outputBodyCommitment: 21n },
    { slotClass: SlotClass.DUMMY, outputBodyCommitment: 22n },
    { slotClass: SlotClass.DUMMY, outputBodyCommitment: 23n },
    { slotClass: SlotClass.DUMMY, outputBodyCommitment: 24n },
  ],
};
const build = {
  shape: 0,
  recentPcashBlockHash: 2n,
  pcashChainId: 0x1ff6n,
  transaction,
  resolvedOutputs: [],
  privateValueCommitment: privateValueCommitment(transaction),
} as unknown as AssetActionBuild;

function primary(accountKind: bigint, address = contract): AssetAccountAuthorization {
  return {
    address,
    nkRoot: 1n,
    accountIndex: 0,
    accountSiblings: [],
    accountRuleSetCommitment: 1n,
    accountKind,
    accountRevision: 1n,
    receiveKeyHash: 0n,
    rule: { configurationCommitment: 1n, commitmentBlinder: 1n, entryIndex: 0, siblings: [] },
  };
}

describe("contract fee sponsorship routing", () => {
  it("creates the request only for the authenticated Contract Account target", () => {
    const prepared = prepareContractFeeSponsorshipAuthorization({
      build,
      primary: primary(ACCOUNT_KIND_CONTRACT),
      wallet,
      sponsoredContract: contract,
    });
    expect(prepared.request.typedData.primaryType).toBe("PcashContractInteraction");
    expect((prepared.request.typedData.message as { sponsoredContract: string }).sponsoredContract)
      .toBe(`0x${contract.toString(16).padStart(40, "0")}`);
  });

  it("accepts a target at address zero", () => {
    const prepared = prepareContractFeeSponsorshipAuthorization({
      build,
      primary: primary(ACCOUNT_KIND_CONTRACT, 0n),
      wallet,
      sponsoredContract: 0n,
    });
    expect((prepared.request.typedData.message as { sponsoredContract: string }).sponsoredContract)
      .toBe(`0x${"0".repeat(40)}`);
  });

  it("rejects a User Account primary before constructing a signing request", () => {
    expect(() => prepareContractFeeSponsorshipAuthorization({
      build,
      primary: primary(ACCOUNT_KIND_USER),
      wallet,
      sponsoredContract: contract,
    })).toThrow(/requires a Contract Account primary/);
  });

  it("rejects a target that differs from the authenticated primary before signing", () => {
    expect(() => prepareContractFeeSponsorshipAuthorization({
      build,
      primary: primary(ACCOUNT_KIND_CONTRACT),
      wallet,
      sponsoredContract: contract + 1n,
    })).toThrow(/does not match the authenticated primary account/);
  });
});
