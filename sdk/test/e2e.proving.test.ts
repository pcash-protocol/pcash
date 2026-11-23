import { defaultUserAccountRuleSet } from "../src/rules/referenceRules.ts";
import { accountStateCommitment } from "../src/protocol/account.ts";
import { nullifierKeyCommitment } from "../src/protocol/notes.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { sizeClassFiller } from "../src/protocol/envelope.ts";
import { authorizePcashRequestWithPrivateKey } from "../src/eip712/index.ts";
import { TEST_DEFAULT_RULE_SECRETS } from "@pcash/test-support/protocol-fixtures";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { buildNativeTransfer } from "../src/builders/index.ts";
import { buildAssetAction, outOfBandAssetActionOutput } from "../src/builders/index.ts";
import { findAssetDescriptor } from "../src/protocol/asset.ts";
import {
  FIXED_SUPPLY_RULE_CIRCUIT,
  fixedSupplyMintRule,
  fixedSupplyMintWitness,
  fixedSupplySecretCommitment,
} from "../src/rules/fixedSupply.ts";
import {
  WIRE_PROOF_BYTES,
  decodeTransaction,
  encodePrivateValueTransaction,
  privateValuePublicInputs,
} from "../src/protocol/codec.ts";
import { bytesEqual } from "../src/utils/bytes.ts";
import {
  proveMintChonk,
  proveTransferTransactionChonk,
  type NativeChonkResult,
} from "../src/prover/index.ts";
import {
  createChonkCircuitResolver,
  isProverAvailable,
  nativeChonkBackend,
} from "../src/node/index.ts";
import { EMPTY_OUTPUT_ROOT, syntheticRecentBlockFixture, transferFixture } from "@pcash/test-support/protocol-fixtures";
import { deriveTestWallet } from "./testWallet.ts";

const proverAvailable = isProverAvailable();
if (process.env.PCASH_REQUIRE_PROVER === "1" && !proverAvailable) {
  throw new Error("PCASH_REQUIRE_PROVER=1 but the release-pinned proving stack is unavailable");
}
const suite = proverAvailable ? describe : describe.skip;
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const bundle = process.env.PCASH_CIRCUIT_BUNDLE?.trim();
const resolver = createChonkCircuitResolver({
  artifactDirectory: bundle === undefined ? join(root, "circuits", "target") : join(bundle, "prover-assets"),
  ...(bundle === undefined ? {} : { verificationKeyDirectory: join(bundle, "vks") }),
});

suite("SDK-built CHONK proofs", () => {
  const wallet = deriveTestWallet();
  const chainId = 0x1ff6n;
  let transfer: ReturnType<typeof buildNativeTransfer>;
  let transferProof: NativeChonkResult;
  let mintProof: NativeChonkResult;

  beforeAll(async () => {
    transfer = buildNativeTransfer(transferFixture({
      chainId,
      wallet,
      recipientAddress: 0x1234567890123456789012345678901234567890n,
      inputAmount: (1n << 128n) - 1n,
      paymentAmount: (1n << 128n) - 1_001n,
      openFeeAmount: 500n,
      issuanceOwnerCommitment: 0n,
      dummyInputEntropy: 42n,
      validUntilTimestamp: 9_999_999n,
      noteSecret: 0xdeadbeefcafe01n,
    }));
    transferProof = await proveTransferTransactionChonk({
      build: transfer,
      authorizationPackage: "account_rule_payment_ecdsa",
      authorizationWitnessMap: transfer.accountRuleWitnessMap!,
      resolve: resolver,
      backend: nativeChonkBackend(),
    });

    const secret = 0x123456n;
    const supply = 1_000_000n;
    const configuration = { supply, secretCommitment: fixedSupplySecretCommitment(secret) };
    const descriptor = findAssetDescriptor({ metadataCommitment: 0xa0a0n, mintRule: fixedSupplyMintRule(configuration) }, 0n);
    const rules = defaultUserAccountRuleSet({ wallet, secrets: TEST_DEFAULT_RULE_SECRETS });
    const accounts = new SparseMerkleTree(40);
    accounts.setLeaf(0, accountStateCommitment(wallet.address, nullifierKeyCommitment(wallet.nkRoot), rules.accountRuleSetCommitment, 0n, 1n, 0n));
    const recent = syntheticRecentBlockFixture({
      outputRoot: EMPTY_OUTPUT_ROOT,
      outputCount: 0,
      issuedSoFar: 0n,
      lagQ: 100n * 10n ** 18n * 2n ** 64n,
      accountStateRoot: accounts.root,
      accountCount: 1,
    });
    const mint = buildAssetAction({
      pcashChainId: chainId,
      snapshot: {
        recentPcashBlockHash: recent.recentPcashBlockHash,
        stateRoot: recent.stateRoot,
        stateRootHeaderSiblings: recent.stateRootHeaderSiblings,
        outputRoot: EMPTY_OUTPUT_ROOT,
        outputRootStateSiblings: recent.outputRootStateSiblings,
        accountStateRoot: accounts.root,
        accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
      },
      mint: { descriptor },
      owner: { address: wallet.address, nkRoot: wallet.nkRoot, accountIndex: 0, accountSiblings: accounts.proof(0).siblings, accountRuleSetCommitment: rules.accountRuleSetCommitment, accountKind: 0n, accountRevision: 1n, receiveKeyHash: 0n,
        rule: { configurationCommitment: rules.mintRule.configurationCommitment, commitmentBlinder: rules.mintRule.commitmentBlinder, entryIndex: rules.mintRule.entryIndex, siblings: rules.mintRule.siblings } },
      inputs: [{ kind: "mint-marker", replayId: secret }, { kind: "dummy" }, { kind: "dummy" }, { kind: "dummy" }],
      outputs: [
        outOfBandAssetActionOutput({
          kind: "asset",
          recipientAddress: 0x1234n, noteSecret: 0x1111n,
          amount: supply,
          outputData: sizeClassFiller(),
        }),
        { kind: "dummy", dummySecret: 0x2222n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x3333n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x4444n, amount: 0n, outputData: sizeClassFiller() },
        { kind: "dummy", dummySecret: 0x5555n, amount: 0n, outputData: sizeClassFiller() },
      ],
      openFeeAmount: 0n,
      issuanceOwnerCommitment: 0n,
      validUntilTimestamp: 999_999n,
      dummyInputSeed: 0x987654n,
    });
    const authorization = mint.prepareOwnerAuthorization({ wallet });
    const signed = authorization.authorize(authorizePcashRequestWithPrivateKey(wallet.privKey, authorization.request));
    mintProof = await proveMintChonk({
      authorization: { packageName: "account_rule_mint_ecdsa", witnessMap: signed.witnessMap },
      build: mint,
      mintRule: { packageName: FIXED_SUPPLY_RULE_CIRCUIT, witnessMap: fixedSupplyMintWitness({ mint, configuration, secret }) },
      resolve: resolver,
      backend: nativeChonkBackend(),
    });
  }, 600_000);

  it("uses the release-pinned compressed proof sizes", () => {
    expect(transferProof.proof).toHaveLength(WIRE_PROOF_BYTES);
    expect(mintProof.proof).toHaveLength(WIRE_PROOF_BYTES);
  });

  it("codec round-trips a real CHONK transfer proof", () => {
    const entry = encodePrivateValueTransaction({
      publicInputs: transfer.publicInputs,
      proof: transferProof.proof,
      outputData: transfer.outputData,
      arena: transfer.arena,
    });
    const decoded = decodeTransaction(entry);
    expect(decoded.kind).toBe(0);
    if (decoded.kind !== 0) throw new Error("unexpected entry kind");
    expect(privateValuePublicInputs(decoded)).toEqual(transfer.publicInputs);
    expect(bytesEqual(decoded.proof, transferProof.proof)).toBe(true);
  });

  it("loads hiding-kernel verification keys from the release when present", () => {
    if (bundle === undefined) return;
    expect(bytesEqual(
      transferProof.hidingVerificationKey,
      new Uint8Array(readFileSync(join(bundle, "vks", "private_value_hiding_kernel.chonk.vk"))),
    )).toBe(true);

  });
});
