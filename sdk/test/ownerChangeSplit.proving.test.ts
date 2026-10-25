// A funded transfer whose asset change does not fit one note. The batch rule
// and the transfer kernel accept the one split the rule allows, the composed
// proof verifies, and the owner recovers every change note from its own spent
// notes, the outflows it approved, and the published statement: no delivery
// payload and no change-amount witness.
import { join } from "node:path";
import { Noir } from "@noir-lang/noir_js";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAssetAction } from "../src/builders/assetAction.ts";
import {
  outOfBandAssetActionOutput,
  ownerChangeAssetActionOutput,
  type AssetActionInput,
  type AssetActionOutput,
} from "../src/builders/assetOutputs.ts";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { fieldToHex } from "../src/crypto/field.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { authorizePcashRequestWithPrivateKey } from "../src/eip712/authorization.ts";
import { createChonkCircuitResolver } from "../src/node/chonkMaterial.ts";
import { isProverAvailable, nativeChonkBackend } from "../src/node/nativeProver.ts";
import { accountRuleEntryCommitment, accountStateCommitment, buildAccountRuleSet } from "../src/protocol/account.ts";
import { assetSecretCommitment, standardFungibleAssetId } from "../src/protocol/asset.ts";
import { sizeClassFiller } from "../src/protocol/envelope.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import {
  fullOutputCommitment,
  noteBodyCommitment,
  nullifierKeyCommitment,
  ownerChangeNoteSecret,
  ownerCommitment,
} from "../src/protocol/notes.ts";
import type { WitnessMap } from "../src/protocol/witness.ts";
import { proveTransferTransactionChonk, type ChonkCircuitMaterial } from "../src/prover/stacks.ts";
import { defaultUserAccountRuleSet } from "../src/rules/referenceRules.ts";
import { syntheticRecentBlockFixture, TEST_DEFAULT_RULE_SECRETS } from "@pcash/test-support/protocol-fixtures";
import { proverAssetsDir } from "./circuitBundle.ts";
import { noOpEventApplicationWitness } from "./noOpEventApplication.ts";
import { verifyGeneratedProof } from "./proofVerification.ts";
import { deriveTestWallet } from "./testWallet.ts";

const available = isProverAvailable();
if (process.env.PCASH_REQUIRE_PROVER === "1" && !available) {
  throw new Error("PCASH_REQUIRE_PROVER=1 but the release-pinned proving stack is unavailable");
}

const MAX_NOTE_AMOUNT = (1n << 128n) - 1n;
const profile = PRIVATE_VALUE_PROFILES.S;
const wallet = deriveTestWallet({ mlKem: "deterministic" });
const chainId = BigInt(DEFAULT_NETWORK_CONFIG.pcashChainId);
const RECIPIENT = 0x1234567890123456789012345678901234567890n;

// What the owner spends and what it approves.
const SPENT = { asset: [MAX_NOTE_AMOUNT, 1250n], native: [77n] };
const PAYMENT = 1000n;
const BURN = 10n;
const assetId = standardFungibleAssetId({
  metadataCommitment: 765n,
  initialSupply: MAX_NOTE_AMOUNT + 1250n,
  assetSecretCommitment: assetSecretCommitment(654n),
});

function fundedSplitFixture(authorizationVkHash: bigint) {
  const defaults = defaultUserAccountRuleSet({ wallet, secrets: TEST_DEFAULT_RULE_SECRETS });
  const rule = defaults.batchTransferRule;
  const rules = buildAccountRuleSet([{ entryIndex: rule.entryIndex, accountRuleEntryCommitment: accountRuleEntryCommitment(
    authorizationVkHash, rule.configurationCommitment, rule.commitmentBlinder,
  ) }]);
  const notes = [
    ...SPENT.asset.map((amount) => ({ kind: "asset" as const, assetId, amount })),
    ...SPENT.native.map((amount) => ({ kind: "native" as const, assetId: 0n, amount })),
  ].map((note, leaf) => ({ ...note, noteSecret: 0x601n + BigInt(leaf), leaf }));
  const outputTree = new SparseMerkleTree(40);
  for (const note of notes) {
    outputTree.setLeaf(note.leaf, fullOutputCommitment({
      owner: wallet.address, noteSecret: note.noteSecret, assetId: note.assetId, amount: note.amount,
    }, note.leaf));
  }
  const accounts = new SparseMerkleTree(40);
  accounts.setLeaf(0, accountStateCommitment(wallet.address, nullifierKeyCommitment(wallet.nkRoot), rules.accountRuleSetCommitment, 0n, 1n, 0n));
  const recent = syntheticRecentBlockFixture({ outputRoot: outputTree.root, outputCount: notes.length, issuedSoFar: 77n,
    lagQ: 100n, accountStateRoot: accounts.root, accountCount: 1 });
  const inputs: AssetActionInput[] = notes.map((note) => ({
    kind: note.kind, noteSecret: note.noteSecret, amount: note.amount, leafIndex: note.leaf, siblings: outputTree.proof(note.leaf).siblings,
  }));
  while (inputs.length < profile.inputs) inputs.push({ kind: "dummy" });
  const change = (kind: "asset" | "native", amount: bigint) => ownerChangeAssetActionOutput({
    kind, pcashChainId: chainId, assetId: kind === "asset" ? assetId : 0n, amount, receiveKey: wallet.mlKemPublicKey,
  });
  const outputs: AssetActionOutput[] = [
    outOfBandAssetActionOutput({ kind: "asset", recipientAddress: RECIPIENT, noteSecret: 0x5001n, amount: PAYMENT, outputData: sizeClassFiller() }),
    change("asset", MAX_NOTE_AMOUNT),
    change("asset", 240n),
    change("native", 77n),
    { kind: "dummy", dummySecret: 0x315n, amount: 0n, outputData: sizeClassFiller() },
  ];
  const build = buildAssetAction({
    pcashChainId: chainId, assetId, assetBurnAmount: BURN,
    snapshot: {
      recentPcashBlockHash: recent.recentPcashBlockHash, stateRoot: recent.stateRoot,
      stateRootHeaderSiblings: recent.stateRootHeaderSiblings, outputRoot: outputTree.root,
      outputRootStateSiblings: recent.outputRootStateSiblings, accountStateRoot: accounts.root,
      accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
    },
    owner: { address: wallet.address, nkRoot: wallet.nkRoot, accountIndex: 0, accountSiblings: accounts.proof(0).siblings,
      accountRuleSetCommitment: rules.accountRuleSetCommitment, accountKind: 0n, accountRevision: 1n, receiveKeyHash: 0n,
      rule: { configurationCommitment: rule.configurationCommitment, commitmentBlinder: rule.commitmentBlinder,
        entryIndex: rule.entryIndex, siblings: rules.membership(rule.entryIndex).siblings } },
    inputs, outputs, openFeeAmount: 0n, issuanceOwnerCommitment: 0n,
    validUntilTimestamp: 999_999n, dummyInputSeed: 345n,
  });
  const prepared = build.prepareOwnerAuthorization({ wallet });
  const signed = prepared.authorize(authorizePcashRequestWithPrivateKey(wallet.privKey, prepared.request));
  return { build, prepared, signed };
}

/** The one split the readable rules prove: full-size notes, then one remainder. */
function changePieces(total: bigint): bigint[] {
  const pieces: bigint[] = [];
  for (let remainder = total; remainder > 0n; remainder -= MAX_NOTE_AMOUNT) {
    pieces.push(remainder > MAX_NOTE_AMOUNT ? MAX_NOTE_AMOUNT : remainder);
  }
  return pieces;
}

/**
 * The owner's change notes of one namespace, found among the published output
 * bodies. `total` is what the owner spent in the namespace less what it
 * approved leaving it; the secrets come from its key and the published nullifiers.
 */
function recoverChange(params: {
  nullifiers: readonly bigint[];
  bodies: readonly bigint[];
  assetId: bigint;
  total: bigint;
}): { slot: number; amount: bigint }[] {
  const pieces = changePieces(params.total);
  const found: { slot: number; amount: bigint }[] = [];
  params.bodies.forEach((body, slot) => {
    const amount = pieces[found.length];
    if (amount === undefined) return;
    const owner = ownerCommitment(wallet.address, ownerChangeNoteSecret(wallet.nkRoot, params.nullifiers, slot));
    if (noteBodyCommitment(owner, params.assetId, amount) === body) found.push({ slot, amount });
  });
  return found;
}

const execute = (material: ChonkCircuitMaterial, witness: WitnessMap) =>
  new Noir(material.artifact as never).execute(witness as never);

describe("funded transfer with owner change larger than one note", () => {
  const resolve = createChonkCircuitResolver({
    artifactDirectory: proverAssetsDir(),
    verificationKeyDirectory: join(process.env.PCASH_CIRCUIT_BUNDLE!, "vks"),
  });
  let rule: ChonkCircuitMaterial;
  let kernel: ChonkCircuitMaterial;
  let fixture: ReturnType<typeof fundedSplitFixture>;
  beforeAll(async () => {
    rule = await resolve("account_rule_batch_transfer_ecdsa", "app");
    kernel = await resolve("private_value_transfer_kernel", "kernel");
    fixture = fundedSplitFixture(BigInt(rule.vkHash));
  }, 120_000);

  it("satisfies the signed batch rule and the transfer kernel's conservation", async () => {
    const { build, prepared, signed } = fixture;
    expect(prepared.authorizationCircuit).toBe("account_rule_batch_transfer_ecdsa");
    expect((signed.witnessMap.owner_change_amounts as string[]).map(BigInt)).toEqual([0n, MAX_NOTE_AMOUNT, 240n, 77n, 0n]);
    const kernelMap = { ...build.buildKernelWitnessMap(rule), ...await noOpEventApplicationWitness(resolve, build.buildKernelWitnessMap(rule)) };
    const ruleResult = await execute(rule, signed.witnessMap);
    expect((ruleResult.returnValue as string[]).map(BigInt)).toEqual((kernelMap.rule_statement as string[]).map(BigInt));
    const kernelResult = await execute(kernel, kernelMap);
    expect((kernelResult.returnValue as string[]).map(BigInt)).toEqual(build.publicInputs);
  }, 120_000);

  // The signature covers neither the change bodies nor their amounts, so a
  // prover can rebuild both. The rule is what refuses another split.
  it("rejects the same signature over the asset change split another way", async () => {
    const witness = structuredClone(fixture.signed.witnessMap);
    const nullifiers = fixture.build.publicInputs.slice(2, 2 + profile.inputs);
    const resplit = [[1, 240n], [2, MAX_NOTE_AMOUNT]] as const;
    const privateValue = witness.private_value as { output_body_commitments: string[] };
    for (const [slot, amount] of resplit) {
      const owner = ownerCommitment(wallet.address, ownerChangeNoteSecret(wallet.nkRoot, nullifiers, slot));
      privateValue.output_body_commitments[slot] = fieldToHex(noteBodyCommitment(owner, assetId, amount));
      (witness.owner_change_amounts as string[])[slot] = fieldToHex(amount);
    }
    await expect(execute(rule, witness)).rejects.toThrow(
      "owner change before the last must hold the largest note amount",
    );
  }, 120_000);

  (available ? it : it.skip)("composes into a proof that verifies", async () => {
    const { build, signed } = fixture;
    const proof = await proveTransferTransactionChonk({
      build,
      authorizationPackage: "account_rule_batch_transfer_ecdsa",
      authorizationWitnessMap: signed.witnessMap,
      resolve,
      backend: nativeChonkBackend(),
    });
    await verifyGeneratedProof(proof, build.publicInputs);
  }, 900_000);

  it("lets the owner recover its change without delivery", () => {
    // The published statement: chain, recent block, then nullifiers and output bodies.
    const { publicInputs } = fixture.build;
    const nullifiers = publicInputs.slice(2, 2 + profile.inputs);
    const bodies = publicInputs.slice(2 + profile.inputs, 2 + profile.inputs + profile.outputs);
    const sum = (amounts: readonly bigint[]) => amounts.reduce((total, amount) => total + amount, 0n);

    expect(recoverChange({ nullifiers, bodies, assetId, total: sum(SPENT.asset) - PAYMENT - BURN })).toEqual([
      { slot: 1, amount: MAX_NOTE_AMOUNT },
      { slot: 2, amount: 240n },
    ]);
    expect(recoverChange({ nullifiers, bodies, assetId: 0n, total: sum(SPENT.native) })).toEqual([
      { slot: 3, amount: 77n },
    ]);
  });
});
