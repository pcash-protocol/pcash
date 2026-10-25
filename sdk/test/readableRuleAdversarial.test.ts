// Adversarial suite for the readable rules. Each case
// hand-mutates a builder-produced witness map and requires circuit execution
// to fail — `noir.execute` throws on any failed assert, so a resolving
// execution means the constraint is gone. Toolchain-free: executes the
// compiled rule circuits from prover-assets via noir_js, like witnessMaps.test.ts.
//
// Covered here: signature reuse across different payment terms, note-secret and
// envelope-hash substitution, displayed-field tampering, account substitution
// at the rule, and issuance-route substitution under a signature. Role-matrix and asset-spend cases live as Noir tests inside the rule circuits; the
// kernel-side cases live in kernelTamper.test.ts.

import { PCASH_CHAIN_ID } from "../src/constants/networkProfile.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Noir, type CompiledCircuit, type InputMap } from "@noir-lang/noir_js";
import { buildNativeTransfer, type WitnessMap } from "../src/builders/index.ts";
import { deriveTestWallet } from "./testWallet.ts";
import { transferFixture } from "@pcash/test-support/protocol-fixtures";
import { proverAssetsDir } from "./circuitBundle.ts";
import { generateMlKemKeyPair, sizeClassFiller } from "../src/protocol/envelope.ts";
import { authorizePcashRequestWithPrivateKey } from "../src/eip712/authorization.ts";
import { prepareUserAccountUpdate } from "../src/builders/accountUpdate.ts";
import { accountRuleEntryCommitment, buildAccountRuleSet } from "../src/protocol/account.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { nullifierKeyCommitment, ownerCommitment } from "../src/protocol/notes.ts";
import { payoutTransactionContext, type DesignatedIssuanceOpening } from "../src/protocol/payout.ts";
import { ecdsaRuleConfigurationCommitment } from "../src/rules/referenceRules.ts";
import { feePaymentFixture } from "@pcash/test-support/protocol-fixtures";
import { zeroPaymentFixture } from "./zeroPaymentFixtures.ts";
import { privateValueMap } from "../src/protocol/witness.ts";
import { SlotClass, type PrivateValue } from "../src/protocol/transaction.ts";
import { noteBodyCommitment, ownerChangeNoteSecret } from "../src/protocol/notes.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";

const PROVER_ASSETS = proverAssetsDir();
const chainId = PCASH_CHAIN_ID;
const wallet = deriveTestWallet();

const RECIPIENT_A = 0x1234567890123456789012345678901234567890n;
const RECIPIENT_B = 0x9999888877776666555544443333222211110000n;
const RECIPIENT_C = 0x4444555566667777888899990000aaaabbbbccccn;

function loadCircuit(name: string): CompiledCircuit {
  return JSON.parse(readFileSync(join(PROVER_ASSETS, `${name}.json`), "utf8")) as CompiledCircuit;
}

async function execute(name: string, map: WitnessMap): Promise<void> {
  await statementOf(name, map);
}

/** The rule statement a satisfied rule returns to the kernel. */
async function statementOf(name: string, map: WitnessMap): Promise<bigint[]> {
  const noir = new Noir(loadCircuit(name));
  const { returnValue } = await noir.execute(map as InputMap);
  return (returnValue as string[]).map(BigInt);
}

function mutated(base: WitnessMap, patch: (copy: Record<string, unknown>) => void): WitnessMap {
  const copy = structuredClone(base) as Record<string, unknown>;
  patch(copy);
  return copy as WitnessMap;
}

const hex = (value: bigint): string => `0x${value.toString(16)}`;
const bump = (value: unknown): string => hex(BigInt(value as string) + 1n);

function paymentTransfer(recipient: bigint, paymentAmount: bigint, noteSecret: bigint) {
  return buildNativeTransfer(transferFixture({
    chainId,
    wallet,
    recipientAddress: recipient,
    inputAmount: 1250500n,
    paymentAmount,
    openFeeAmount: 500n,
    issuanceOwnerCommitment: 0n,
    dummyInputEntropy: 42n,
    validUntilTimestamp: 9999999n,
    noteSecret,
  }));
}

describe("payment rule adversarial (account_rule_payment_ecdsa)", () => {
  const transferA = paymentTransfer(RECIPIENT_A, 1000000n, 0xdeadbeefcafe01n);
  const transferB = paymentTransfer(RECIPIENT_B, 900000n, 0xdeadbeefcafe02n);
  const mapA = transferA.accountRuleWitnessMap!;
  const mapB = transferB.accountRuleWitnessMap!;

  it("accepts both untampered maps with the statements the kernel expects", async () => {
    expect(await statementOf("account_rule_payment_ecdsa", mapA)).toEqual([...transferA.ruleStatement]);
    expect(await statementOf("account_rule_payment_ecdsa", mapB)).toEqual([...transferB.ruleStatement]);
  }, 120_000);

  it.each(["zero r", "zero s", "overflow r", "overflow s"])("rejects %s in the ECDSA witness", async (kind) => {
    const bad = mutated(mapA, map => {
      const signature = (map.signature as { signature: string[] }).signature;
      const start = kind.endsWith("r") ? 0 : 32;
      for (let i = start; i < start + 32; i++) signature[i] = kind.startsWith("zero") ? "0" : "255";
    });
    await expect(execute("account_rule_payment_ecdsa", bad)).rejects.toThrow();
  }, 120_000);

  it("rejects a substituted public key even with the original signature", async () => {
    const bad = mutated(mapA, map => { (map.pubkey as { x: string[] }).x.fill("0"); });
    await expect(execute("account_rule_payment_ecdsa", bad)).rejects.toThrow();
  }, 120_000);

  it("rejects a signature for different payment terms", async () => {
    await expect(
      execute("account_rule_payment_ecdsa", mutated(mapB, (map) => {
        map.signature = structuredClone(mapA.signature);
      })),
    ).rejects.toThrow();
  }, 120_000);

  it("rejects a substituted recipient note secret", async () => {
    await expect(
      execute("account_rule_payment_ecdsa", mutated(mapA, (map) => {
        map.recipient_note_secret = bump(map.recipient_note_secret);
      })),
    ).rejects.toThrow(/declared output must match its declaration|Cannot satisfy constraint/);
  }, 120_000);

  it("rejects a tampered displayed recipient", async () => {
    await expect(
      execute("account_rule_payment_ecdsa", mutated(mapA, (map) => {
        map.recipient = hex(RECIPIENT_B);
      })),
    ).rejects.toThrow(/declared output must match its declaration|Cannot satisfy constraint/);
  }, 120_000);

  it("rejects another account's nullifier key", async () => {
    // The rule derives its configuration and the owner-change secret from nk_root.
    await expect(
      execute("account_rule_payment_ecdsa", mutated(mapA, (map) => {
        map.nk_root = bump(map.nk_root);
      })),
    ).rejects.toThrow(/owner change must return to the owner under the derived secret|Cannot satisfy constraint/);
  }, 120_000);

});

describe("batch rule adversarial (account_rule_batch_transfer_ecdsa)", () => {
  function batchTransfer(secondAmount: bigint, noteSecret: bigint) {
    return buildNativeTransfer(transferFixture({
      chainId,
      wallet,
      recipientAddress: RECIPIENT_A,
      inputAmount: 1250500n,
      paymentAmount: 1000000n,
      secondOutput: {
        address: RECIPIENT_C,
        amount: secondAmount,
      },
      openFeeAmount: 500n,
      issuanceOwnerCommitment: 0n,
      dummyInputEntropy: 43n,
      validUntilTimestamp: 9999999n,
      noteSecret,
      outputData: [undefined, undefined, sizeClassFiller()],
    }));
  }

  const transferF = batchTransfer(100000n, 0xdeadbeefcafe03n);
  const transferG = batchTransfer(120000n, 0xdeadbeefcafe04n);
  const mapF = transferF.accountRuleWitnessMap!;
  const mapG = transferG.accountRuleWitnessMap!;

  it("routes a non-self second output through the batch rule and accepts it", async () => {
    expect(transferF.authorizationCircuit).toBe("account_rule_batch_transfer_ecdsa");
    await expect(execute("account_rule_batch_transfer_ecdsa", mapF)).resolves.toBeUndefined();
  }, 120_000);

  it("rejects a replayed signature after the transaction is rebuilt", async () => {
    await expect(
      execute("account_rule_batch_transfer_ecdsa", mutated(mapF, (map) => {
        map.signature = structuredClone(mapG.signature);
      })),
    ).rejects.toThrow();
  }, 120_000);

  it("returns another action for a delivery-commitment substitution, which the kernel rejects", async () => {
    // The rule computes its action from the opened private value, so a changed
    // delivery commitment yields a statement the transfer kernel's comparison refuses.
    const statement = await statementOf("account_rule_batch_transfer_ecdsa", mutated(mapF, (map) => {
      const tx = map.private_value as { delivery_commitment: string };
      tx.delivery_commitment = bump(tx.delivery_commitment);
    }));
    expect(statement[0]).toBe(transferF.ruleStatement[0]);
    expect(statement[1]).not.toBe(transferF.ruleStatement[1]);
  }, 120_000);

  it("rejects an owner-change slot that is not proved owner-owned", async () => {
    await expect(
      execute("account_rule_batch_transfer_ecdsa", mutated(mapF, (map) => {
        const outputs = map.outputs as Array<Record<string, string>>;
        outputs[1] = { recipient: "0x0", amount: "0x0", asset_id: "0x0" };
        const outputNoteSecrets = map.output_note_secrets as string[];
        outputNoteSecrets[1] = "0x0";
      })),
    ).rejects.toThrow(/owner change|Cannot satisfy constraint/);
  }, 120_000);

  // Owner change derives its own secret, so the owner-change slot's secret
  // witness is unread.
  it("ignores a witnessed secret for the owner-change slot", async () => {
    const statement = await statementOf("account_rule_batch_transfer_ecdsa", mutated(mapF, (map) => {
      const outputNoteSecrets = map.output_note_secrets as string[];
      outputNoteSecrets[2] = "0x1";
    }));
    expect(statement).toEqual(await statementOf("account_rule_batch_transfer_ecdsa", mapF));
  }, 120_000);

  it("rejects a substituted declared-output recipient", async () => {
    await expect(
      execute("account_rule_batch_transfer_ecdsa", mutated(mapF, (map) => {
        const outputs = map.outputs as Array<Record<string, string>>;
        outputs[0]!.recipient = bump(outputs[0]!.recipient!);
      })),
    ).rejects.toThrow(/declared output must match its declaration|Cannot satisfy constraint/);
  }, 120_000);

  it("rejects another account's nullifier key", async () => {
    await expect(
      execute("account_rule_batch_transfer_ecdsa", mutated(mapF, (map) => {
        map.nk_root = bump(map.nk_root);
      })),
    ).rejects.toThrow(/owner change must return to the owner under the derived secret|Cannot satisfy constraint/);
  }, 120_000);
});

describe("zero-value payment rule (account_rule_payment_ecdsa)", () => {
  const { build } = zeroPaymentFixture();
  const base = build.accountRuleWitnessMap!;
  // Change the opened private value, from which the rule computes its action,
  // so only the signature can reject a change to a signed field.
  const reopened = (change: (tx: PrivateValue) => PrivateValue) => mutated(base, (map) => {
    map.private_value = privateValueMap(change(build.transaction));
  });
  const global = (change: Partial<PrivateValue["global"]>) =>
    reopened((tx) => ({ ...tx, global: { ...tx.global, ...change } }));

  it("accepts a signed zero payment whose payment slot is padding", async () => {
    await expect(execute("account_rule_payment_ecdsa", base)).resolves.toBeUndefined();
  }, 120_000);

  it.each([
    ["recipient", () => mutated(base, (map) => { map.recipient = hex(RECIPIENT_B); })],
    ["fee", () => global({ openFeeAmount: 7n })],
    ["validity bound", () => global({ validUntilTimestamp: BigInt(build.transaction.global.validUntilTimestamp) + 1n })],
    ["not-before bound", () => global({ notBeforeTimestamp: 1n })],
    // Only the signed transaction context binds dummy nullifiers.
    ["transaction context", () => reopened((tx) => ({
      ...tx,
      inputs: tx.inputs.map((input, index) => index === 1 ? { ...input, nullifier: BigInt(input.nullifier) + 1n } : input),
    }))],
    ["issuance route", () => {
      const secret = 0x7777n;
      const changed = global({ issuanceOwnerCommitment: ownerCommitment(RECIPIENT_C, secret) });
      changed.issuance_recipient = hex(RECIPIENT_C);
      changed.issuance_note_secret = hex(secret);
      return changed;
    }],
  ])("rejects a changed signed %s under the original signature", async (_field, change) => {
    await expect(execute("account_rule_payment_ecdsa", change())).rejects.toThrow(/signature must be valid/);
  }, 120_000);

  it("rejects a positive payment proved under a zero-amount signature", async () => {
    // A hostile builder keeps the inputs and signature of a funded zero payment,
    // pays 1 to the signed recipient from the change, and reopens every note.
    const funded = zeroPaymentFixture({ inputAmounts: [100n] });
    const nullifiers = funded.build.transaction.inputs.map((input) => input.nullifier);
    const recipientSecret = 0x5001n;
    const outputs = funded.build.transaction.outputs.map((output, index) =>
      index === 0 ? {
        ...output,
        slotClass: SlotClass.NATIVE,
        outputBodyCommitment: noteBodyCommitment(ownerCommitment(funded.wallet.address, recipientSecret), 0n, 1n),
      } : index === 1 ? {
        ...output,
        outputBodyCommitment: noteBodyCommitment(
          ownerCommitment(funded.wallet.address, ownerChangeNoteSecret(funded.wallet.nkRoot, nullifiers, 1)), 0n, 99n),
      } : output);
    const tx = { ...funded.build.transaction, outputs };
    const hostile = mutated(funded.build.accountRuleWitnessMap!, (map) => {
      map.amount = "0x1";
      map.recipient_note_secret = hex(recipientSecret);
      map.native_change_amount = hex(99n);
      map.private_value = privateValueMap(tx);
    });
    await expect(execute("account_rule_payment_ecdsa", funded.build.accountRuleWitnessMap!)).resolves.toBeUndefined();
    await expect(execute("account_rule_payment_ecdsa", hostile)).rejects.toThrow(/signature must be valid/);
  }, 120_000);

  it("rejects a positive signed amount over the padded payment slot", async () => {
    await expect(execute("account_rule_payment_ecdsa", mutated(base, (map) => { map.amount = "0x1"; map.recipient_note_secret = "0x1"; })))
      .rejects.toThrow(/declared native output must use a native slot/);
  }, 120_000);
});

describe("zero-value large batch rule (account_rule_large_batch_transfer_ecdsa)", () => {
  const { build } = zeroPaymentFixture({ shape: PRIVATE_VALUE_PROFILES.L.shapeId, inputAmounts: [100n], openFeeAmount: 1n });
  const base = build.accountRuleWitnessMap!;

  it("accepts all-zero declarations with the padded payment slot and owner change", async () => {
    expect(build.authorizationCircuit).toBe("account_rule_large_batch_transfer_ecdsa");
    await expect(execute("account_rule_large_batch_transfer_ecdsa", base)).resolves.toBeUndefined();
  }, 120_000);

  it("rejects a recipient declaration for the padded payment slot", async () => {
    await expect(execute("account_rule_large_batch_transfer_ecdsa", mutated(base, (map) => {
      const outputs = map.outputs as Array<Record<string, string>>;
      outputs[0] = { recipient: hex(RECIPIENT_A), amount: "0x1", asset_id: "0x0" };
      (map.output_note_secrets as string[])[0] = "0x1";
    }))).rejects.toThrow(/declared native output must use a native slot/);
  }, 120_000);
});

/** Every leaf path at which two witness maps differ. */
function differingPaths(left: unknown, right: unknown, path = ""): string[] {
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return left === right ? [] : [path];
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].flatMap((key) => differingPaths(
    (left as Record<string, unknown>)[key],
    (right as Record<string, unknown>)[key],
    path === "" ? key : `${path}.${key}`,
  ));
}

/**
 * Compare an open bounty and poster issuance with designated issuance and no
 * public bounty. The designated build executes under its own signature; using
 * the open build's signature must fail on the changed approved terms.
 */
describe("issuance route binding under the signature", () => {
  const ATTACKER = RECIPIENT_C;
  const ATTACKER_SECRET = 0x7777n;
  const attackerCommitment = ownerCommitment(ATTACKER, ATTACKER_SECRET);
  const FILLER = sizeClassFiller();
  const ROUTE_WITNESS_PATHS = [
    "issuance_note_secret",
    "issuance_recipient",
    "private_value.issuance_owner_commitment",
  ];
  const withoutSignature = (paths: string[]) => paths.filter((path) => !path.startsWith("signature.")).sort();
  const designatedTo = (pcashChainId: bigint, nullifiers: readonly bigint[]): DesignatedIssuanceOpening => ({
    recipientAddress: ATTACKER,
    noteSecret: ATTACKER_SECRET,
    transactionContext: payoutTransactionContext(pcashChainId, nullifiers),
  });

  describe("payment rule (account_rule_payment_ecdsa)", () => {
    const payment = (opening?: DesignatedIssuanceOpening) => buildNativeTransfer(transferFixture({
      chainId,
      wallet,
      recipientAddress: RECIPIENT_A,
      inputAmount: 1250500n,
      paymentAmount: 1000000n,
      openFeeAmount: opening === undefined ? 500n : 0n,
      issuanceOwnerCommitment: opening === undefined ? 0n : attackerCommitment,
      ...(opening === undefined ? {} : { designatedIssuanceOpening: opening }),
      dummyInputEntropy: 44n,
      validUntilTimestamp: 9999999n,
      noteSecret: 0xdeadbeefcafe05n,
      outputData: [undefined, undefined, FILLER, FILLER, FILLER],
    }));
    const open = payment();
    const designated = payment(designatedTo(chainId, open.transaction.inputs.map((input) => BigInt(input.nullifier))));
    const openMap = open.accountRuleWitnessMap!;
    const designatedMap = designated.accountRuleWitnessMap!;

    it("builds the two routes over otherwise identical witnesses", async () => {
      expect(withoutSignature(differingPaths(openMap, designatedMap)))
        .toEqual(expect.arrayContaining([...ROUTE_WITNESS_PATHS, "private_value.open_fee_amount"]));
      await expect(execute("account_rule_payment_ecdsa", openMap)).resolves.toBeUndefined();
      await expect(execute("account_rule_payment_ecdsa", designatedMap)).resolves.toBeUndefined();
    }, 120_000);

    it("rejects a designated route carried under an open-route signature", async () => {
      await expect(execute("account_rule_payment_ecdsa", mutated(designatedMap, (map) => {
        map.signature = structuredClone(openMap.signature);
      }))).rejects.toThrow(/signature must be valid/);
    }, 120_000);
  });

  describe("account update rule (account_rule_admin_ecdsa)", () => {
    const commitmentBlinder = 0xc0ffeen;
    const entryIndex = 3;
    const configurationCommitment = ecdsaRuleConfigurationCommitment(DEFAULT_NETWORK_CONFIG, nullifierKeyCommitment(wallet.nkRoot));
    const applicationVkHash = 0x1234n;
    const rules = buildAccountRuleSet([
      { entryIndex, accountRuleEntryCommitment: accountRuleEntryCommitment(applicationVkHash, configurationCommitment, commitmentBlinder) },
    ]);
    const fixture = feePaymentFixture({
      wallet,
      inputAmount: 1_000n,
      noteSecret: 0xbeefn,
      accountIndex: 7,
      accountRuleSetCommitment: rules.accountRuleSetCommitment,
    });
    const update = (selected = false) => {
      const build = prepareUserAccountUpdate({
        network: DEFAULT_NETWORK_CONFIG,
        current: {
          address: wallet.address,
          accountRevision: 1n,
          ruleSetCommitment: rules.accountRuleSetCommitment,
          receiveKey: { status: "absent" },
        },
        nkRoot: wallet.nkRoot,
        proposed: { ruleSetCommitment: 0x123456n, receiveKey: { operation: "keep" } },
        recentPcashBlockHash: fixture.recentPcashBlockHash,
        validUntilTimestamp: 1_000_000n,
        snapshot: fixture.snapshot,
        fee: {
          openFeeAmount: selected ? 0n : 100n,
          issuanceOwnerCommitment: 0n,
          ...(selected ? { privateRelayPayment: {
            recipientAddress: ATTACKER, receiveKey: generateMlKemKeyPair(new Uint8Array(64).fill(7)).publicKey, amount: 100n,
          } } : {}),
          inputs: fixture.inputs,
          dummyInputEntropy: 45n,
          dummyOutputEntropy: [1n, 2n, 3n, 4n, 5n],
              outputData: [FILLER, undefined, FILLER, FILLER, FILLER],
        },
        rule: { applicationVkHash, configurationCommitment, commitmentBlinder, entryIndex, siblings: rules.membership(entryIndex).siblings },
        readableEcdsa: { signerAddress: wallet.address },
      });
      return { build, witnessMap: build.authorizeReadableEcdsa!(authorizePcashRequestWithPrivateKey(wallet.privKey!, build.authorizationRequest!)).witnessMap };
    };
    const open = update();
    const selected = update(true);

    it("binds the public and private fee modes under separate signatures", async () => {
      expect(differingPaths(open.witnessMap, selected.witnessMap)).toContain("relay_fee_amount");
      await expect(execute("account_rule_admin_ecdsa", open.witnessMap)).resolves.toBeUndefined();
      await expect(execute("account_rule_admin_ecdsa", selected.witnessMap)).resolves.toBeUndefined();
    }, 120_000);

    it("rejects a private relay fee carried under an open-fee signature", async () => {
      await expect(execute("account_rule_admin_ecdsa", mutated(selected.witnessMap, (map) => {
        map.signature = structuredClone(open.witnessMap.signature);
      }))).rejects.toThrow(/signature must be valid/);
    }, 120_000);
  });
});
