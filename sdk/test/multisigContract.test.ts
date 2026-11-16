import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Noir, type CompiledCircuit, type InputMap } from "@noir-lang/noir_js";
import { describe, expect, it } from "vitest";
import { field32 } from "../src/utils/bytes.ts";
import { signMultisigApproval } from "../src/builders/authorizationRules.ts";
import type { WitnessMap } from "../src/protocol/witness.ts";
import { addressFromPublicKeyXY, signDigest } from "../src/eip712/eip712.ts";
import { fullOutputCommitment, noteBodyCommitment, nullifierKeyCommitment, ownerCommitment } from "../src/protocol/notes.ts";
import { MERKLE_DEPTH } from "../src/constants/params.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { verifyContract } from "../src/protocol/contract.ts";
import {
  buildMultisigContractAuthorization,
  buildMultisigContractCall,
  buildPrivateMultisigContract,
  MULTISIG_2_OF_3_THRESHOLD,
  type PrivateMultisigContract,
} from "../src/builders/multisigRule.ts";
import { deriveTestWallet } from "./testWallet.ts";
import { toField } from "../src/crypto/field.ts";
import { syntheticRecentBlockOpenings } from "@pcash/test-support/protocol-fixtures";
import { proverAssetsDir } from "./circuitBundle.ts";
import { sizeClassFiller } from "../src/protocol/envelope.ts";

const PROVER_ASSETS = proverAssetsDir();
const chainId = 0x1ff6n;
const configurationSalt = 0x5a17n;

const signerKey = (value: number): Uint8Array => {
  const key = new Uint8Array(32);
  key[31] = value;
  return key;
};
const signers = [signerKey(0xa1), signerKey(0xb2), signerKey(0xc3)].map((privKey) =>
  deriveTestWallet({ privKey }),
);
const signerPubkeys = signers.map(({ pubX, pubY }) => ({ pubX, pubY }));

function compiledCircuit(name: string): CompiledCircuit {
  return JSON.parse(readFileSync(join(PROVER_ASSETS, `${name}.json`), "utf8")) as CompiledCircuit;
}

/** Execute the rule and return the statement it computes. */
async function executeMultisig(witnessMap: WitnessMap): Promise<bigint[]> {
  const noir = new Noir(compiledCircuit("account_rule_multisig"));
  const { returnValue } = await noir.execute(witnessMap as InputMap);
  return (returnValue as string[]).map(BigInt);
}

function buildVault(applicationVkHash = 0x1234n): PrivateMultisigContract {
  return buildPrivateMultisigContract({
    nkRoot: 0x987654321n,
    signers: signerPubkeys,
    applicationVkHash,
    configurationSalt,
  });
}

function buildCall(
  vault: PrivateMultisigContract,
  input: { amount: bigint; noteSecret: bigint; leafIndex: number },
  paymentAmount: bigint,
) {
  const noteTree = new SparseMerkleTree(MERKLE_DEPTH);
  noteTree.setLeaf(
    input.leafIndex,
    fullOutputCommitment(
      { owner: vault.build.address, noteSecret: input.noteSecret, assetId: 0n, amount: input.amount },
      input.leafIndex,
    ),
  );
  const noteOpening = noteTree.proof(input.leafIndex);
  const accountIndex = 7;
  const accountStateTree = new SparseMerkleTree(MERKLE_DEPTH);
  accountStateTree.setLeaf(accountIndex, vault.build.accountStateCommitment);
  const accountOpening = accountStateTree.proof(accountIndex);
  const recentBlock = syntheticRecentBlockOpenings({
    outputRoot: noteOpening.root,
    outputCount: input.leafIndex + 1,
    issuedSoFar: 0n,
    lagQ: 100n * 10n ** 18n * 2n ** 64n,
    accountStateRoot: accountOpening.root,
    accountCount: accountIndex + 1,
  });
  return buildMultisigContractCall({
    multisigContract: vault,
    chainId,
    recipientAddress: 0x1234567890123456789012345678901234567890n,
    paymentAmount,
    inputs: [
      {
        amount: input.amount,
        noteSecret: input.noteSecret,
        outputIndex: input.leafIndex,
        siblings: noteOpening.siblings,
      },
    ],
    outputRoot: noteOpening.root,
    ...recentBlock,
    openFeeAmount: 10n,
    issuanceOwnerCommitment: 0n,
    dummyInputEntropy: 42n + BigInt(input.leafIndex),
    validUntilTimestamp: 9_999_999n,
    accountIndex,
    accountStateRoot: accountOpening.root,
    accountSiblings: accountOpening.siblings,
    outputData: [sizeClassFiller(), sizeClassFiller()],

  });
}

function approvalsFor(
  signerIndexes: readonly number[],
  call: ReturnType<typeof buildCall>,
  actionCommitment = call.ruleStatement[1],
) {
  return signerIndexes.map((index) => ({
    pubX: signers[index]!.pubX,
    pubY: signers[index]!.pubY,
    signature: signMultisigApproval(
      signers[index]!.privKey,
      actionCommitment,
      call.address,
    ),
  }));
}

describe("private multisig contract", () => {
  it("commits an immutable 2-of-3 function without publishing nkRoot", () => {
    const vault = buildVault();
    expect(vault.contract.nullifierKey.publishesNkRoot).toBe(false);
    expect(verifyContract(vault.contract).nullifierKeyCommitment).toBe(vault.build.nullifierKeyCommitment);
    expect(vault.contract.functions).toHaveLength(1);
    expect(vault.contract.functions[0]!.configurationCommitment).toBe(
      vault.function.configurationCommitment,
    );
    expect(vault.signerAddresses).toEqual([...vault.signerAddresses].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    ));
    expect(MULTISIG_2_OF_3_THRESHOLD).toBe(2n);
  });

  it("spends partially with 2-of-3 and returns reusable change to the contract", async () => {
    const vault = buildVault();
    const first = buildCall(
      vault,
      { amount: 1_000n, noteSecret: 0xabcden, leafIndex: 3 },
      600n,
    );
    const firstAuthorization = buildMultisigContractAuthorization({
      multisigContract: vault,
      call: first,
      approvals: approvalsFor([0, 1], first),
    });
    // The rule computes the statement the transfer kernel expects.
    expect(await executeMultisig(firstAuthorization.witnessMap)).toEqual([...first.ruleStatement]);

    expect(first.scenario.changeAmount).toBe(390n);
    expect(first.scenario.body1).toBe(
      noteBodyCommitment(
        ownerCommitment(
          vault.build.address,
          first.outputNoteSecrets[1]!,
        ),
        0n,
        390n,
      ),
    );

    // Treat the first spend's change as a later included note and spend it with
    // the other valid signer pair. This exercises a reusable vault, not a one-shot escrow.
    const second = buildCall(
      vault,
      { amount: 390n, noteSecret: first.outputNoteSecrets[1]!, leafIndex: 9 },
      350n,
    );
    const secondAuthorization = buildMultisigContractAuthorization({
      multisigContract: vault,
      call: second,
      approvals: approvalsFor([1, 2], second),
    });
    expect(await executeMultisig(secondAuthorization.witnessMap)).toEqual([...second.ruleStatement]);
    expect(second.scenario.changeAmount).toBe(30n);
  });

  it("rejects one approval and duplicate approvers before proving", () => {
    const vault = buildVault();
    const call = buildCall(
      vault,
      { amount: 1_000n, noteSecret: 0xabcden, leafIndex: 3 },
      600n,
    );
    expect(() =>
      buildMultisigContractAuthorization({
        multisigContract: vault,
        call,
        approvals: approvalsFor([0], call),
      }),
    ).toThrow(/exactly two approvals/);
    expect(() =>
      buildMultisigContractAuthorization({
        multisigContract: vault,
        call,
        approvals: approvalsFor([0, 0], call),
      }),
    ).toThrow(/distinct signers/);
  });

  it("a second approval over the wrong transaction does not satisfy the circuit", async () => {
    const vault = buildVault();
    const call = buildCall(
      vault,
      { amount: 1_000n, noteSecret: 0xabcden, leafIndex: 3 },
      600n,
    );
    const authorization = buildMultisigContractAuthorization({
      multisigContract: vault,
      call,
      approvals: [
        approvalsFor([0], call)[0]!,
        {
          pubX: signers[1]!.pubX,
          pubY: signers[1]!.pubY,
          signature: signDigest(signers[1]!.privKey, field32(0xdeadn)).compact,
        },
      ],
    });
    await expect(executeMultisig(authorization.witnessMap)).rejects.toThrow();
  });

  it("rejects malformed signer groups", () => {
    expect(() =>
      buildPrivateMultisigContract({
        nkRoot: 1n,
        signers: signerPubkeys.slice(0, 2),
        applicationVkHash: 1n,
        configurationSalt,
      }),
    ).toThrow(/exactly three signers/);
    expect(() =>
      buildPrivateMultisigContract({
        nkRoot: 1n,
        signers: [signerPubkeys[0]!, signerPubkeys[0]!, signerPubkeys[2]!],
        applicationVkHash: 1n,
        configurationSalt,
      }),
    ).toThrow(/distinct/);
    expect(() =>
      buildPrivateMultisigContract({
        nkRoot: 1n,
        signers: [
          { pubX: new Uint8Array(32), pubY: new Uint8Array(32) },
          signerPubkeys[1]!,
          signerPubkeys[2]!,
        ],
        applicationVkHash: 1n,
        configurationSalt,
      }),
    ).toThrow(/valid secp256k1 point/);
    expect(() =>
      buildPrivateMultisigContract({
        nkRoot: 1n,
        signers: [{ pubX: new Uint8Array(31), pubY: new Uint8Array(32) }, signerPubkeys[1]!, signerPubkeys[2]!],
        applicationVkHash: 1n,
        configurationSalt,
      }),
    ).toThrow(/32 bytes each/);
  });

  it("accepts a zero nkRoot", () => {
    const vault = buildPrivateMultisigContract({ nkRoot: 0n, signers: signerPubkeys, applicationVkHash: 1n, configurationSalt });
    expect(vault.build.nullifierKeyCommitment).toBe(nullifierKeyCommitment(0n));
    expect(verifyContract(vault.contract).nullifierKeyCommitment).toBe(vault.build.nullifierKeyCommitment);
  });

  it("rejects an approval whose public key is not on the curve", () => {
    const vault = buildVault();
    const call = buildCall(vault, { amount: 1_000n, noteSecret: 0xabcden, leafIndex: 3 }, 600n);
    const [first, second] = approvalsFor([0, 1], call);
    expect(() =>
      buildMultisigContractAuthorization({
        multisigContract: vault,
        call,
        approvals: [first!, { ...second!, pubY: new Uint8Array(32).fill(1) }],
      }),
    ).toThrow(/valid secp256k1 point/);
  });

  it("rejects a call built for a different contract", () => {
    const vault = buildVault();
    const otherVault = buildVault(0x5678n);
    expect(otherVault.build.address).not.toBe(vault.build.address);
    const call = buildCall(otherVault, { amount: 1_000n, noteSecret: 0xabcden, leafIndex: 3 }, 600n);
    expect(() =>
      buildMultisigContractAuthorization({
        multisigContract: vault,
        call,
        approvals: approvalsFor([0, 1], call),
      }),
    ).toThrow(/does not belong to the supplied contract/);
  });

  it("rejects a call whose function configuration differs from the contract's", () => {
    const vault = buildVault();
    const call = buildCall(vault, { amount: 1_000n, noteSecret: 0xabcden, leafIndex: 3 }, 600n);
    const tampered = {
      ...call,
      function: { ...call.function, configurationCommitment: toField(call.function.configurationCommitment) + 1n },
    };
    expect(() =>
      buildMultisigContractAuthorization({
        multisigContract: vault,
        call: tampered,
        approvals: approvalsFor([0, 1], call),
      }),
    ).toThrow(/call configuration does not match the supplied contract/);
  });

  it("rejects a contract whose private salt no longer opens its function configuration", () => {
    const vault = buildVault();
    const call = buildCall(vault, { amount: 1_000n, noteSecret: 0xabcden, leafIndex: 3 }, 600n);
    expect(() =>
      buildMultisigContractAuthorization({
        multisigContract: { ...vault, configurationSalt: vault.configurationSalt + 1n },
        call,
        approvals: approvalsFor([0, 1], call),
      }),
    ).toThrow(/application configuration does not match the contract function/);
  });

  it("address derivation uses the public signer coordinates", () => {
    const vault = buildVault();
    const addresses = vault.signers.map((signer) => {
      const xy = new Uint8Array(64);
      xy.set(signer.pubX, 0);
      xy.set(signer.pubY, 32);
      return addressFromPublicKeyXY(xy);
    });
    expect(addresses).toEqual(vault.signerAddresses);
  });
});
