// Witness-map parity: the structured `noir_js` InputMaps the SDK
// builds must satisfy each committed browser circuit's constraints. `@noir-lang/noir_js`
// executes the ACIR against the map and THROWS on any failed assert — so a
// successful `noir.execute(map)` is the browser-side equivalent of `nargo execute`
// (both parse the witness through the same noirc_abi encoder). This pins the maps
// against the ABI: a wrong key, shape, or value fails execution.
// Application witness maps execute without the proving toolchain; complete
// folded-stack proving is covered by the release suites.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Noir, type CompiledCircuit, type InputMap } from "@noir-lang/noir_js";
import {
  buildNativeTransfer,
  type WitnessMap,
} from "../src/builders/index.ts";
import {
  buildMultisigRule,
  multisigApprovalTerms,
  signMultisigApproval,
} from "../src/builders/authorizationRules.ts";
import { assetCreationActionCommitment, transferActionCommitment } from "../src/protocol/statement.ts";
import { privateValueCommitment, SlotClass, type PrivateValue } from "../src/protocol/transaction.ts";
import { deriveTestWallet } from "./testWallet.ts";
import { transferFixture } from "@pcash/test-support/protocol-fixtures";
import { proverAssetsDir } from "./circuitBundle.ts";

const PROVER_ASSETS = proverAssetsDir();

function loadCircuit(name: string): CompiledCircuit {
  return JSON.parse(readFileSync(join(PROVER_ASSETS, `${name}.json`), "utf8")) as CompiledCircuit;
}

/** Execute the compiled circuit against the map and return its rule statement.
 * Throws on any failed constraint (that throw IS the parity failure — parity
 * with `nargo execute`). */
async function execute(name: string, map: WitnessMap): Promise<bigint[]> {
  const noir = new Noir(loadCircuit(name));
  const { returnValue } = await noir.execute(map as InputMap);
  return (returnValue as string[]).map(BigInt);
}

const chainId = 0x1ff6n;
const wallet = deriveTestWallet();
const multisigConfigurationSalt = 0x5a17n;

const multisigSignerKey = (b: number): Uint8Array => {
  const k = new Uint8Array(32);
  k[31] = b;
  return k;
};
const multisigSigners = [multisigSignerKey(0xa1), multisigSignerKey(0xb2), multisigSignerKey(0xc3)].map((privKey) =>
  deriveTestWallet({ privKey }),
);

/** Signers 0 and 2 approve `transaction` for `wallet`'s account; returns the rule's map. */
function multisigRuleFor(transaction: PrivateValue, recentPcashBlockHash: bigint, createdAssetId = 0n) {
  const terms = multisigApprovalTerms({
    transaction,
    createdAssetId,
    accountAddress: wallet.address,
    pcashChainId: chainId,
  });
  return buildMultisigRule({
    transaction,
    createdAssetId,
    accountAddress: wallet.address,
    recentPcashBlockHash,
    pcashChainId: chainId,
    configurationSalt: multisigConfigurationSalt,
    signers: multisigSigners.map((w) => ({ pubX: w.pubX, pubY: w.pubY })),
    threshold: 2n,
    approvals: [0, 2].map((i) => ({
      pubX: multisigSigners[i]!.pubX,
      pubY: multisigSigners[i]!.pubY,
      signature: signMultisigApproval(multisigSigners[i]!.privKey, terms.actionCommitment, terms.address),
    })),
  });
}

describe("witness-map parity via noir_js execution (toolchain-free)", () => {

  it("account_rule_payment_ecdsa map satisfies the application circuit", async () => {
    const build = buildNativeTransfer(transferFixture({
      chainId,
      wallet,
      recipientAddress: 0x1234567890123456789012345678901234567890n,
      inputAmount: (1n << 128n) - 1n,
      paymentAmount: (1n << 128n) - 1_001n,
      openFeeAmount: 500n,
      issuanceOwnerCommitment: 0n,
      dummyInputEntropy: 42n,
      validUntilTimestamp: 9999999n,
      noteSecret: 0xdeadbeefcafe01n,
    }));
    // The rule computes exactly the statement the transfer kernel expects.
    expect(await execute("account_rule_payment_ecdsa", build.accountRuleWitnessMap!)).toEqual([...build.ruleStatement]);
  });

  const multisigTransfer = () => buildNativeTransfer(transferFixture({
    chainId,
    wallet,
    recipientAddress: 0x1234567890123456789012345678901234567890n,
    inputAmount: 1250500n,
    paymentAmount: 1000000n,
    openFeeAmount: 500n,
    issuanceOwnerCommitment: 0n,
    dummyInputEntropy: 42n,
    validUntilTimestamp: 9999999n,
    noteSecret: 0xdeadbeefcafe01n,
  }));

  it("multisig map satisfies the multisig application circuit", async () => {
    const transfer = multisigTransfer();
    const accountRule = multisigRuleFor(transfer.transaction, transfer.recentPcashBlockHash);
    // Same action and block as the payment rule; only the configuration differs.
    const statement = await execute("account_rule_multisig", accountRule.witnessMap);
    expect(statement.slice(1)).toEqual(transfer.ruleStatement.slice(1));
  });

  it("multisig approves the asset-creation action of a private value with a creation marker", async () => {
    const transfer = multisigTransfer();
    const markerSlot = transfer.transaction.inputs.findIndex((input) => input.slotClass === SlotClass.DUMMY);
    expect(markerSlot).toBeGreaterThanOrEqual(0);
    const creation: PrivateValue = {
      ...transfer.transaction,
      inputs: transfer.transaction.inputs.map((input, index) =>
        index === markerSlot ? { slotClass: SlotClass.ASSET_CREATION, inputCommitment: 0n, nullifier: 0x15e5n } : input),
    };
    const createdAssetId = 0xa55e7n;
    const accountRule = multisigRuleFor(creation, transfer.recentPcashBlockHash, createdAssetId);
    const statement = await execute("account_rule_multisig", accountRule.witnessMap);
    const commitment = privateValueCommitment(creation);
    expect(statement[1]).toBe(assetCreationActionCommitment(chainId, commitment, createdAssetId));
    expect(statement[1]).not.toBe(transferActionCommitment(chainId, commitment));
    expect(accountRule.actionCommitment).toBe(statement[1]);
  });

});
