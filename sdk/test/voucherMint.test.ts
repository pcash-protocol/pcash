// A mint under the voucher fixture's mint rule, which names no account: any
// account may submit it. The full stack is proved in
// recursiveComposition.proving.test.ts.

import { describe, expect, it } from "vitest";
import { fieldToHex } from "../src/crypto/field.ts";
import { computeCircuitVkHash, VK_LEN } from "../src/protocol/account.ts";
import { mintContext } from "../src/protocol/asset.ts";
import { mintActionCommitment, ruleStatement } from "../src/protocol/statement.ts";
import { voucherMintFixture, voucherMintWitness } from "@pcash/test-support/voucher-mint-fixtures";

const vkOf = (seed: number) => {
  const key = Array.from({ length: VK_LEN }, (_, i) => fieldToHex(BigInt(i + seed)));
  return { vkFields: key, vkHash: fieldToHex(computeCircuitVkHash(key)) };
};
const voucherVk = vkOf(1);
const authorizationVk = vkOf(2);
const VOUCHER_VK_HASH = BigInt(voucherVk.vkHash);

describe("voucher mint", () => {
  const fixture = voucherMintFixture({ voucherVkHash: VOUCHER_VK_HASH });

  it("folds the voucher rule's statement for the minting account", () => {
    const { build, claimant, configuration } = fixture;
    const action = mintActionCommitment(build.pcashChainId, build.privateValueCommitment, build.assetId);
    const statement = ruleStatement(
      mintContext({
        assetId: build.assetId,
        configurationCommitment: build.mintRule!.configurationCommitment,
        accountAddress: claimant.address,
        validUntilTimestamp: build.transaction.global.validUntilTimestamp,
      }),
      action,
      build.recentPcashBlockHash,
      build.eventOpening.eventEntry,
    );
    expect(build.mintStatement).toEqual(statement);
    expect(build.mintRule!.configurationCommitment).not.toBe(0n);
    expect(configuration.amount).toBe(100n);
    const witness = build.buildMintKernelWitnessMap(authorizationVk, voucherVk);
    expect(witness.mint_statement).toEqual(statement.map(fieldToHex));
    expect((witness.mint_rule_vk as { hash: string }).hash).toBe(voucherVk.vkHash);
    expect(witness.definition).toEqual(build.mintDefinition);
    expect(fixture.prepared.authorizationCircuit).toBe("account_rule_mint_ecdsa");
  });

  it("lets any account mint the same voucher's asset", () => {
    const other = voucherMintFixture({ voucherVkHash: VOUCHER_VK_HASH, claimantKey: 9 });
    expect(other.claimant.address).not.toBe(fixture.claimant.address);
    expect(other.build.assetId).toBe(fixture.build.assetId);
    // The same voucher keys the same marker whoever submits it.
    expect(other.build.transaction.inputs[0]!.nullifier).toBe(fixture.build.transaction.inputs[0]!.nullifier);
    expect(other.build.mintStatement![0]).not.toBe(fixture.build.mintStatement![0]);
    expect(other.mintRule.witnessMap.account_address).toBe(fieldToHex(other.claimant.address));
  });

  it("folds only the asset's mint rule", () => {
    expect(() => fixture.build.buildMintKernelWitnessMap(authorizationVk, authorizationVk))
      .toThrow(/mint rule VK does not match the asset's rule for this profile/);
  });

  it("refuses a voucher the mint's marker is not keyed by", () => {
    expect(() => voucherMintWitness({
      mint: fixture.build, configuration: fixture.configuration, voucherSecret: fixture.voucherSecret + 1n,
      voucherIndex: 5, voucherSiblings: [],
    })).toThrow(/voucher's one marker/);
    expect(() => voucherMintWitness({
      mint: fixture.build, configuration: { ...fixture.configuration, amount: 99n }, voucherSecret: fixture.voucherSecret,
      voucherIndex: 5, voucherSiblings: [],
    })).toThrow(/does not open the asset's mint rule/);
  });
});
