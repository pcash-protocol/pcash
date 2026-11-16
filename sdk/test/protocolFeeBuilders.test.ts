// Every builder declares its native burn as the public word after the open fee,
// binds it into the private-value commitment, and funds it from native inputs.

import { describe, expect, it } from "vitest";
import { buildNativeTransfer, buildSponsoredTransferWitness } from "../src/builders/index.ts";
import { PCASH_CHAIN_ID } from "../src/constants/networkProfile.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { fieldToHex } from "../src/crypto/field.ts";
import { computeCircuitVkHash, VK_LEN } from "../src/protocol/account.ts";
import { decodeTransaction, privateValuePublicInputs, transactionPublication, WIRE_PROOF_BYTES } from "../src/protocol/codec.ts";
import type { NativeBurn } from "../src/protocol/fee.ts";
import { privateValueCommitment } from "../src/protocol/transaction.ts";
import { transferFixture } from "@pcash/test-support/protocol-fixtures";
import { assetProfileFixture } from "./assetProfileFixtures.ts";
import { sharedAssetClaimFixture } from "./sharedAssetClaimFixtures.ts";
import { deriveTestWallet } from "./testWallet.ts";

const { offsets } = PRIVATE_VALUE_PROFILES.S;
const BURN: NativeBurn = { networkFeeAmount: 200n, voluntaryBurnAmount: 50n };
const vk = Array.from({ length: VK_LEN }, (_, i) => fieldToHex(BigInt(i + 1)));
const authorizationVk = { vkFields: vk, vkHash: fieldToHex(computeCircuitVkHash(vk)) };

describe("native transfer burn", () => {
  const wallet = deriveTestWallet();
  const fixture = transferFixture({
    chainId: PCASH_CHAIN_ID,
    wallet,
    recipientAddress: 0x1234567890123456789012345678901234567890n,
    inputAmount: 1_250_500n,
    paymentAmount: 1_000_000n,
    openFeeAmount: 500n,
    issuanceOwnerCommitment: 0n,
    dummyInputEntropy: 42n,
    validUntilTimestamp: 9_999_999n,
    noteSecret: 0xdeadbeefcafe01n,
  });

  it("burns zero by default", () => {
    const build = buildNativeTransfer(fixture);
    expect(build.burn).toEqual({ networkFeeAmount: 0n, voluntaryBurnAmount: 0n });
    expect(build.transaction.global.nativeBurnAmount).toBe(0n);
    expect(build.publicInputs[offsets.nativeBurnAmount]).toBe(0n);
    expect(build.scenario.changeAmount).toBe(1_250_500n - 1_000_000n - 500n);
  });

  it("declares the total burn after the open fee and funds it before change", () => {
    const build = buildNativeTransfer({ ...fixture, burn: BURN });
    expect(build.burn).toEqual(BURN);
    expect(build.transaction.global.nativeBurnAmount).toBe(250n);
    expect(build.publicInputs[offsets.openFeeAmount]).toBe(500n);
    expect(build.publicInputs[offsets.nativeBurnAmount]).toBe(250n);
    expect(build.scenario.changeAmount).toBe(1_250_500n - 1_000_000n - 500n - 250n);
    expect(build.privateValueCommitment).toBe(privateValueCommitment(build.transaction));
    expect(build.privateValueCommitment).not.toBe(buildNativeTransfer(fixture).privateValueCommitment);
    const choices = build.buildKernelWitnessMap(authorizationVk).choices as Record<string, string>;
    expect(choices.native_burn_amount).toBe(fieldToHex(250n));

    const entry = build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES));
    expect(transactionPublication(entry)).toMatchObject({ openFeeAmount: 500n, nativeBurnAmount: 250n });
    const decoded = decodeTransaction(entry);
    if (decoded.kind !== 0) throw new Error("kind");
    expect(privateValuePublicInputs(decoded)).toEqual(build.publicInputs);
  });

  it("signs today's payment message for a zero burn and its WithBurn variant for a positive one", () => {
    const plain = buildNativeTransfer(fixture).authorizationRequest!.typedData;
    const burned = buildNativeTransfer({ ...fixture, burn: BURN }).authorizationRequest!.typedData;
    expect(plain.primaryType).toBe("PcashPayment");
    expect(plain.message).not.toHaveProperty("networkFeeAmount");
    expect(burned.primaryType).toBe("PcashPaymentWithBurn");
    const message = burned.message as Record<string, bigint | string>;
    expect(BigInt(message.networkFeeAmount!)).toBe(200n);
    expect(BigInt(message.voluntaryBurnAmount!)).toBe(50n);
  });

  it("spends the whole remainder on the burn and refuses a burn the inputs cannot fund", () => {
    const exact = buildNativeTransfer({ ...fixture, burn: { networkFeeAmount: 250_000n, voluntaryBurnAmount: 0n } });
    expect(exact.scenario.changeAmount).toBe(0n);
    expect(() => buildNativeTransfer({ ...fixture, burn: { networkFeeAmount: 250_000n, voluntaryBurnAmount: 1n } }))
      .toThrow(/sum\(inputs\) < .*nativeBurnAmount/);
  });

  it("refuses a burn outside the 128-bit amount range", () => {
    expect(() => buildNativeTransfer({ ...fixture, burn: { networkFeeAmount: 1n << 128n, voluntaryBurnAmount: 0n } }))
      .toThrow();
  });
});

describe("asset action burn", () => {
  it("balances native inputs against native outputs, the open fee, and the burn", () => {
    const { build } = assetProfileFixture({ shape: 0, burn: { networkFeeAmount: 6n, voluntaryBurnAmount: 1n } });
    expect(build.burn).toEqual({ networkFeeAmount: 6n, voluntaryBurnAmount: 1n });
    expect(build.transaction.global.openFeeAmount).toBe(3n);
    expect(build.transaction.global.nativeBurnAmount).toBe(7n);
    expect(build.publicInputs[offsets.nativeBurnAmount]).toBe(7n);
    expect(build.privateValueCommitment).toBe(privateValueCommitment(build.transaction));
  });

  it("carries the burn into the profile L statement", () => {
    const { build } = assetProfileFixture({ shape: 1, burn: { networkFeeAmount: 10n, voluntaryBurnAmount: 0n } });
    expect(build.transaction.global.openFeeAmount).toBe(0n);
    expect(build.publicInputs[PRIVATE_VALUE_PROFILES.L.offsets.nativeBurnAmount]).toBe(10n);
  });

  it("refuses native inputs that do not cover the burn", () => {
    expect(() => assetProfileFixture({ shape: 0, openFeeAmount: 10n, burn: { networkFeeAmount: 1n, voluntaryBurnAmount: 0n } }))
      .toThrow(/native inputs must equal native outputs plus openFeeAmount and nativeBurnAmount/);
  });
});

describe("sponsored transfer burn", () => {
  const burn: NativeBurn = { networkFeeAmount: 3n, voluntaryBurnAmount: 0n };

  it("lets the fee payer fund the open fee, the burn, and change", () => {
    const fixture = sharedAssetClaimFixture({ shape: 0, feePaid: true, claimVkHash: 1n, burn });
    expect(fixture.build.transaction.global.nativeBurnAmount).toBe(3n);
    expect(fixture.build.burn).toEqual(burn);
    const witness = buildSponsoredTransferWitness({
      build: fixture.build, snapshot: fixture.snapshot, pcashChainId: fixture.build.pcashChainId,
      assetId: fixture.configuration.assetId, primary: fixture.primary, feePayer: fixture.feePayer,
      primaryVk: authorizationVk, feeVk: authorizationVk,
    });
    expect((witness.witnessMap.native_change as { amount: string }).amount).toBe(fieldToHex(15n - 5n - 3n));
  });

  it("refuses a statement whose burn the fee payer's change does not account for", () => {
    const fixture = sharedAssetClaimFixture({ shape: 0, feePaid: true, claimVkHash: 1n, burn });
    const build = {
      ...fixture.build,
      transaction: { ...fixture.build.transaction, global: { ...fixture.build.transaction.global, nativeBurnAmount: 0n } },
    };
    expect(() => buildSponsoredTransferWitness({
      build, snapshot: fixture.snapshot, pcashChainId: build.pcashChainId,
      assetId: fixture.configuration.assetId, primary: fixture.primary, feePayer: fixture.feePayer,
      primaryVk: authorizationVk, feeVk: authorizationVk,
    })).toThrow(/native inputs total 15 but the fee is 5, the burn 0, and change 7/);
  });
});
