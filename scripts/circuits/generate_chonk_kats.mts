import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Barretenberg, BackendType } from "@aztec-foundation/bb.js";

import { sharedAssetClaimFixture } from "../../sdk/test/sharedAssetClaimFixtures.ts";
import { assetProfileFixture } from "../../sdk/test/assetProfileFixtures.ts";
import { encodePrivateValueTransaction } from "../../sdk/src/protocol/codec.ts";
import { privateValueProfileFixture } from "../../sdk/test/privateValueProfileFixtures.ts";
import { buildNativeTransfer } from "../../sdk/src/builders/nativeTransfer.ts";
import { prepareUserAccountUpdate } from "../../sdk/src/builders/accountUpdate.ts";
import { prepareSponsoredContractCreation } from "../../sdk/src/builders/contractCreation.ts";
import { DEFAULT_NETWORK_CONFIG } from "../../sdk/src/protocol/network.ts";
import { authorizePcashRequestWithPrivateKey } from "../../sdk/src/eip712/authorization.ts";
import { field32 } from "../../sdk/src/utils/bytes.ts";
import { receiveKeyHash } from "../../sdk/src/protocol/account.ts";
import { buildContractBody, functionSelector } from "../../sdk/src/protocol/contract.ts";
import { ACCOUNT_KIND_USER } from "../../sdk/src/constants/params.ts";
import { defaultUserAccountRuleSet } from "../../sdk/src/rules/referenceRules.ts";
import {
  prepareEventApplication,
  proveAssetCreationChonk,
  proveSponsoredContractCreationChonk,
  proveSponsoredTransferChonk,
  proveTransferTransactionChonk,
  proveUserAccountUpdateChonk,
} from "../../sdk/src/prover/stacks.ts";
import type { NativeChonkResult } from "../../sdk/src/prover/chonk.ts";
import { createChonkCircuitResolver } from "../../sdk/src/node/chonkMaterial.ts";
import {
  nativeChonkBackend,
  proverReleaseConfig,
} from "../../sdk/src/node/nativeProver.ts";
import { feePaymentFixture, TEST_DEFAULT_RULE_SECRETS, transferFixture } from "../../test-support/src/protocolFixtures.ts";
import { deriveTestWallet } from "../../sdk/test/testWallet.ts";
import { Config } from "../../sdk/src/bcfg/index.ts";
import { Logger } from "../../sdk/src/blgr/index.ts";

const config = new Config("pcash");
config.load({ argv: true, env: true });
function option(name: string): string {
  const value = config.str(name);
  if (!value) throw new Error(`--${name} is required`);
  return resolve(value);
}

const artifactDirectory = option("artifacts");
const verificationKeyDirectory = option("vks");
const outputDirectory = option("out");
const runtimeOnly = config.bool("runtime-only", false);
const katJobs = Number(config.str("kat-jobs", "1"));
if (!Number.isSafeInteger(katJobs) || katJobs < 1 || katJobs > 4) {
  throw new Error("PCASH_KAT_JOBS must be an integer from 1 to 4");
}
const resolveCircuit = createChonkCircuitResolver({ artifactDirectory, verificationKeyDirectory });

function publicInputBytes(values: readonly bigint[]): Uint8Array {
  const out = new Uint8Array(values.length * 32);
  values.forEach((value, index) => out.set(field32(value), index * 32));
  return out;
}

/**
 * ChonkVerify's verdict on a posted proof. A proof that does not decompress
 * throws: a negative known answer must reach the verifier itself.
 */
async function verifyCompressed(result: NativeChonkResult, proof: Uint8Array, publicInputs: readonly bigint[]): Promise<boolean> {
  const release = proverReleaseConfig();
  process.env.CRS_PATH ??= release.crs;
  const api = await Barretenberg.new({
    backend: BackendType.NativeUnixSocket,
    bbPath: release.bb,
    threads: 1,
  });
  try {
    const decompressed = await api.chonkDecompressProof({ compressedProof: Uint8Array.from([...publicInputBytes(publicInputs), ...proof]) });
    return (await api.chonkVerify({
      proof: decompressed.proof,
      vk: result.hidingVerificationKey,
    })).valid;
  } finally {
    await api.destroy();
  }
}

const logger = new Logger("info");
await logger.open();
const log = logger.context("chonk-kat");
const started = performance.now();
let completed = 0;
const elapsed = (since: number): string => `${((performance.now() - since) / 1_000).toFixed(1)}s`;

async function emit(name: string, publicInputs: readonly bigint[], prove: () => Promise<NativeChonkResult>): Promise<NativeChonkResult> {
  const started = performance.now();
  log.info(`${name}: generating proof`);
  const result = await prove();
  log.info(`${name}: proof generated in ${elapsed(started)}; checking valid and corrupted proofs`);
  if (!(await verifyCompressed(result, result.proof, publicInputs))) throw new Error(`${name} positive KAT failed verification`);
  // The node prepends the public inputs it reconstructs to the posted proof;
  // the same proof under a changed first input must fail.
  const changedInputs = [publicInputs[0]! ^ 1n, ...publicInputs.slice(1)];
  if (await verifyCompressed(result, result.proof, changedInputs)) throw new Error(`${name} changed public input verified`);
  // The proof ends with the Shplonk Q and KZG W commitments. Flip the low bit
  // of the last scalar before them, a small-IPA evaluation: it still
  // decompresses, so the negative reaches ChonkVerify. A flipped commitment
  // coordinate can instead fail decompression.
  const rejected = Uint8Array.from(result.proof);
  rejected[rejected.length - 65]! ^= 1;
  const rejectedVerdict = await verifyCompressed(result, rejected, publicInputs).catch((error: unknown) => {
    throw new Error(`${name} negative KAT did not reach ChonkVerify`, { cause: error });
  });
  if (rejectedVerdict) throw new Error(`${name} negative KAT verified`);
  const dir = join(outputDirectory, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proof"), result.proof);
  writeFileSync(join(dir, "proof.rejected"), rejected);
  writeFileSync(join(dir, "public_inputs"), publicInputBytes(publicInputs));
  completed += 1;
  log.info(`${name}: passed in ${elapsed(started)} (${completed} completed)`);
  return result;
}

const wallet = deriveTestWallet();
const chainId = 0x1ff6n;
const transfer = buildNativeTransfer(transferFixture({
  chainId,
  wallet,
  recipientAddress: 0x1234567890123456789012345678901234567890n,
  inputAmount: 1_250_500n,
  paymentAmount: 1_000_000n,
  openFeeAmount: 500n,
  issuanceOwnerCommitment: 0n,
  dummyInputEntropy: 42n,
  validUntilTimestamp: 9_999_999n,
  noteSecret: 0xdeadbeefcafe01n,
}));
const large = privateValueProfileFixture({ shape: 1, scenario: "minimal" }).build;

// A user-account update that pays its fee from the account's own note.
const accountWallet = deriveTestWallet({ mlKem: "deterministic" });
const rules = defaultUserAccountRuleSet({
  wallet: accountWallet,
  network: DEFAULT_NETWORK_CONFIG,
  secrets: TEST_DEFAULT_RULE_SECRETS,
});
const updateFixture = feePaymentFixture({
  wallet: accountWallet,
  inputAmount: 1_000n,
  noteSecret: 0xbeefn,
  accountIndex: 7,
  accountRuleSetCommitment: rules.accountRuleSetCommitment,
  receiveKeyHash: receiveKeyHash(accountWallet.mlKemPublicKey),
});
const accountParams = {
  network: DEFAULT_NETWORK_CONFIG,
  current: {
    address: accountWallet.address,
    accountIndex: 7n,
    accountRevision: 1n,
    ruleSetCommitment: rules.accountRuleSetCommitment,
    receiveKey: { status: "available" as const, mlKemPublicKey: accountWallet.mlKemPublicKey },
  },
  nkRoot: accountWallet.nkRoot,
  proposed: {
    ruleSetCommitment: rules.accountRuleSetCommitment,
    receiveKey: { operation: "keep" as const },
  },
  recentPcashBlockHash: updateFixture.recentPcashBlockHash,
  validUntilTimestamp: 1_000_000n,
  snapshot: updateFixture.snapshot,
  fee: {
    openFeeAmount: 100n,
    inputs: updateFixture.inputs,
    receiveKey: accountWallet.mlKemPublicKey,
    dummyInputEntropy: 42n,
  },
  rule: {
    applicationVkHash: rules.accountAdminRule.applicationVkHash,
    configurationCommitment: rules.accountAdminRule.configurationCommitment,
    commitmentBlinder: rules.accountAdminRule.commitmentBlinder,
    entryIndex: rules.accountAdminRule.entryIndex,
    siblings: rules.accountAdminRule.siblings,
  },
  readableEcdsa: { signerAddress: accountWallet.address },
};
const accountUpdate = prepareUserAccountUpdate(accountParams);
const accountUpdateAuthorization = accountUpdate.authorizeReadableEcdsa!(
  authorizePcashRequestWithPrivateKey(accountWallet.privKey, accountUpdate.authorizationRequest!),
);
// A contract-account creation whose fee the same user account sponsors.
const contract = buildContractBody({
  nullifierKey: { publishesNkRoot: true, nkRoot: 0x5151n },
  functions: [{ selector: functionSelector(0), applicationVkHash: 0x1234n, configurationCommitment: 0x5678n }],
});
const sponsorFixture = feePaymentFixture({
  wallet: accountWallet,
  inputAmount: 2_000n,
  noteSecret: 0xcafen,
  accountIndex: 7,
  accountRuleSetCommitment: rules.accountRuleSetCommitment,
  receiveKeyHash: receiveKeyHash(accountWallet.mlKemPublicKey),
});
const creationParams = {
  network: DEFAULT_NETWORK_CONFIG,
  contract: { body: contract.body, address: contract.address },
  sponsor: {
    address: accountWallet.address,
    nkRoot: accountWallet.nkRoot,
    accountIndex: sponsorFixture.accountIndex,
    accountSiblings: sponsorFixture.accountSiblings,
    accountRuleSetCommitment: rules.accountRuleSetCommitment,
    accountKind: ACCOUNT_KIND_USER,
    accountRevision: 1n,
    receiveKeyHash: receiveKeyHash(accountWallet.mlKemPublicKey),
    rule: {
      configurationCommitment: rules.contractFeeSponsorshipRule.configurationCommitment,
      commitmentBlinder: rules.contractFeeSponsorshipRule.commitmentBlinder,
      entryIndex: rules.contractFeeSponsorshipRule.entryIndex,
      siblings: rules.contractFeeSponsorshipRule.siblings,
    },
  },
  sponsorWallet: accountWallet,
  sponsorReceiveKey: accountWallet.mlKemPublicKey,
  snapshot: { ...sponsorFixture.snapshot, recentPcashBlockHash: sponsorFixture.recentPcashBlockHash },
  fee: {
    openFeeAmount: 250n,
    validUntilTimestamp: 1_000_000n,
    inputs: sponsorFixture.inputs,
    dummyInputEntropy: 43n,
  },
};
const creation = prepareSponsoredContractCreation(creationParams);
const creationAuthorization = creation.authorizeReadableEcdsa(
  authorizePcashRequestWithPrivateKey(accountWallet.privKey, creation.authorizationRequest),
);
const runtimeCases = [
  () => emit("private_value", transfer.publicInputs, () => proveTransferTransactionChonk({
    build: transfer,
    authorizationPackage: "account_rule_payment_ecdsa",
    authorizationWitnessMap: transfer.accountRuleWitnessMap!,
    resolve: resolveCircuit,
    backend: nativeChonkBackend(1),
  })),
  () => emit("private_value_large", large.publicInputs, () => proveTransferTransactionChonk({
    build: large,
    authorizationPackage: large.authorizationCircuit,
    authorizationWitnessMap: large.accountRuleWitnessMap!,
    resolve: resolveCircuit,
    backend: nativeChonkBackend(1),
  })),
  () => emit("user_account_update", accountUpdate.publicInputs, () => proveUserAccountUpdateChonk({
    build: accountUpdate,
    authorizationPackage: "account_rule_admin_ecdsa",
    authorizationWitnessMap: accountUpdateAuthorization.witnessMap,
    resolve: resolveCircuit,
    backend: nativeChonkBackend(1),
  })),
  () => emit("contract_creation", creation.publicInputs, () => proveSponsoredContractCreationChonk({
    build: creation,
    authorizationPackage: "account_rule_contract_fee_sponsorship_ecdsa",
    authorizationWitnessMap: creationAuthorization.witnessMap,
    resolve: resolveCircuit,
    backend: nativeChonkBackend(1),
  })),
];
for (let index = 0; index < runtimeCases.length; index += katJobs) {
  await Promise.all(runtimeCases.slice(index, index + katJobs).map(prove => prove()));
}

// These families use the same hiding-kernel keys and only supply integration tests.
if (!runtimeOnly) {
  const eventFixture = privateValueProfileFixture({ shape: 0, scenario: "minimal" });
  const preparedEvent = await prepareEventApplication({ packageName: "event_fixture", event: 91n, resolve: resolveCircuit });
  const eventBuild = buildNativeTransfer({ ...eventFixture.params, preparedEvent });
  await emit("real_event", eventBuild.publicInputs, () => proveTransferTransactionChonk({
    build: eventBuild, authorizationPackage: eventBuild.authorizationCircuit!, authorizationWitnessMap: eventBuild.accountRuleWitnessMap!,
    eventApplication: { preparedEvent, witnessMap: {
      action_commitment: eventBuild.ruleStatement[1].toString(), recent_pcash_block_hash: eventBuild.recentPcashBlockHash.toString(), event: "91",
    } },
    resolve: resolveCircuit, backend: nativeChonkBackend(1),
  }));
  const claimApplication = "account_rule_shared_asset_claim";
  const claimVk = await resolveCircuit(claimApplication, "app");
  for (const shape of [0, 1] as const) {
    const claim = sharedAssetClaimFixture({ shape, claimVkHash: BigInt(claimVk.vkHash) });
    const name = shape === 0 ? "shared_claim_s" : "shared_claim_l";
    const result = await emit(name, claim.build.publicInputs, () => proveTransferTransactionChonk({ build: claim.build, authorizationPackage: claimApplication,
      authorizationWitnessMap: claim.claimWitnessMap, resolve: resolveCircuit, backend: nativeChonkBackend(1) }));
    writeFileSync(join(outputDirectory, name, "tx_bytes"), encodePrivateValueTransaction({
      shape, publicInputs: claim.build.publicInputs, proof: result.proof, outputData: claim.build.outputData, arena: claim.build.arena }));
  }
  const sponsorApplication = "account_rule_large_contract_fee_sponsorship_ecdsa";
  const sponsorVk = await resolveCircuit(sponsorApplication, "app");
  const sponsoredClaim = sharedAssetClaimFixture({ shape: 1, feePaid: true,
    claimVkHash: BigInt(claimVk.vkHash), sponsorVkHash: BigInt(sponsorVk.vkHash) });
  await emit("large_sponsored_transfer", sponsoredClaim.build.publicInputs, () => proveSponsoredTransferChonk({ build: sponsoredClaim.build,
    primary: { packageName: claimApplication, witnessMap: sponsoredClaim.claimWitnessMap },
    feePayer: { packageName: sponsorApplication, witnessMap: sponsoredClaim.signed!.witnessMap },
    buildKernelWitnessMap: sponsoredClaim.kernelWitnessMap, resolve: resolveCircuit, backend: nativeChonkBackend(1) }));
  const assetCreationApplication = "account_rule_large_asset_creation_ecdsa";
  const assetCreationVk = await resolveCircuit(assetCreationApplication, "app");
  const assetCreation = assetProfileFixture({ shape: 1, authorizationVkHash: BigInt(assetCreationVk.vkHash) });
  await emit("large_asset_creation", assetCreation.build.publicInputs, () => proveAssetCreationChonk({ build: assetCreation.build,
    authorization: { packageName: assetCreationApplication, witnessMap: assetCreation.signed.witnessMap },
    resolve: resolveCircuit, backend: nativeChonkBackend(1) }));
}

log.info(`generated ${completed} known answers in ${elapsed(started)}: ${outputDirectory}`);
