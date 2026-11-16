import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_WEIGHT, baseFee, MAX_WAIVED_BASE_FEE, NO_BURN, quoteNetworkFee } from "@pcash/sdk/protocol";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { planRole, templateNetworkFee, templateRole, usesSponsorship, type TemplateRun } from "../src/client/action.ts";
import { isTokensError } from "../src/client/errors.ts";

// An excess whose base fee is past the waiver, so a fee is required.
const POSITIVE_EXCESS = 1_400_000n;
const S_INPUTS = BigInt(PRIVATE_VALUE_PROFILES.S.inputs);

function run(feeExcess: bigint, mode: "mempool" | "l1" = "mempool", notes: unknown[] = []): TemplateRun {
  return {
    ctx: {
      status: { feeExcess },
      profile: { address: 0x1234n, nkRoot: 5n },
      signer: {},
      spendable: () => true,
      store: { load: async () => ({ notes }) },
    },
    submission: { mode },
  } as unknown as TemplateRun;
}

test("the quote is positive at the test excess and zero at genesis and while the fee is waived", () => {
  assert.ok(baseFee(POSITIVE_EXCESS) > MAX_WAIVED_BASE_FEE);
  assert.equal(templateNetworkFee({ feeExcess: 0n }), 0n);
  assert.ok(baseFee(44_800n) > 0n);
  assert.equal(templateNetworkFee({ feeExcess: 44_800n }, true), 0n);
});

test("a template action's network fee counts the account its claim creates", () => {
  const status = { feeExcess: POSITIVE_EXCESS };
  assert.equal(templateNetworkFee(status), quoteNetworkFee(POSITIVE_EXCESS, S_INPUTS));
  assert.equal(templateNetworkFee(status, true), quoteNetworkFee(POSITIVE_EXCESS, S_INPUTS + ACCOUNT_WEIGHT));
  assert.ok(templateNetworkFee(status, true) > templateNetworkFee(status));
});

test("a token template sponsors a positive network fee even with no open fee and when self-published", () => {
  assert.equal(usesSponsorship(run(0n), undefined, 0n), false);
  assert.equal(usesSponsorship(run(0n), 0n, 7n), true);
  assert.equal(usesSponsorship(run(0n, "l1"), undefined, 7n), true);
  assert.equal(usesSponsorship(run(0n), 3n, 0n), true);
  assert.throws(() => usesSponsorship(run(0n, "l1"), 3n, 0n), /pays no open fee/);
});

test("a native template burns the quoted network fee from the contract's notes", async () => {
  const plan = await planRole(run(POSITIVE_EXCESS), { freeInputs: 3, native: true, createsAccount: true, openFeeAmount: 2n });
  assert.deepEqual(plan.burn, { networkFeeAmount: quoteNetworkFee(POSITIVE_EXCESS, S_INPUTS + ACCOUNT_WEIGHT), voluntaryBurnAmount: 0n });
  assert.deepEqual(plan.feeNotes, []);
  assert.deepEqual(templateRole(run(POSITIVE_EXCESS), plan), { kind: "transfer", openFeeAmount: 2n, burn: plan.burn });
  const selfPublished = await planRole(run(POSITIVE_EXCESS, "l1"), { freeInputs: 3, native: true });
  assert.deepEqual(templateRole(run(POSITIVE_EXCESS, "l1"), selfPublished), {
    kind: "transfer",
    issuance: { kind: "self", recipient: { address: 0x1234n, nkRoot: 5n } },
    burn: selfPublished.burn,
  });
});

test("a zero network fee plans no burn", async () => {
  const plan = await planRole(run(0n), { freeInputs: 3, native: true });
  assert.deepEqual(plan.burn, NO_BURN);
  assert.deepEqual(templateRole(run(0n), plan), { kind: "transfer" });
});

test("a token template leaves its sponsor input slots for the network fee and burns nothing itself", async () => {
  const fee = templateNetworkFee({ feeExcess: POSITIVE_EXCESS });
  const note = { commitment: "0x01", leafIndex: "7", noteSecret: "9", amount: (fee + 10n).toString(), assetId: "0", spent: false };
  const plan = await planRole(run(POSITIVE_EXCESS, "mempool", [note]), { freeInputs: 3 });
  assert.deepEqual(plan.burn, NO_BURN);
  assert.equal(plan.feeNotes.length, 1);
  assert.equal(plan.feeNotes[0]!.amount, fee + 10n);
});

test("a token template without PCASH for a positive network fee says to wait for it to return to zero", async () => {
  await assert.rejects(
    planRole(run(POSITIVE_EXCESS), { freeInputs: 3 }),
    (error: unknown) => isTokensError(error, "network-fee-needs-pcash"),
  );
  await assert.rejects(
    planRole(run(POSITIVE_EXCESS), { freeInputs: 3, openFeeAmount: 2n }),
    (error: unknown) => isTokensError(error, "insufficient-fee-notes"),
  );
});
