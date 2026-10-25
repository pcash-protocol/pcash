import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";

import {
  assertContractFunctionPresentationAbi,
  assertContractPresentationProfile,
  assertSourceVerificationManifest,
  canonicalJson,
  configurationProfileCommitment,
  PCASH_APPLICATION_RETURN_FIELDS,
  sourceBundleDigest,
  validatePcashNoirAbi,
} from "../../sdk/src/source-verification/index.ts";
import { PCASH_CHAIN_ID } from "../../sdk/src/constants/networkProfile.ts";
import { REFERENCE_CONFIGURATION_DOMAIN } from "../../sdk/src/constants/referenceRuleConstants.ts";
import { fieldToHex } from "../../sdk/src/crypto/field.ts";
import {
  claimConfigurationCommitment as flowClaimConfigurationCommitment,
  CLAIM_APPLICATION_VK_HASH,
  RECLAIM_APPLICATION_VK_HASH,
  reclaimConfigurationCommitment as flowReclaimConfigurationCommitment,
} from "../../marketplace/src/commitments.mts";
import {
  MARKETPLACE_CLAIM_SOURCE_PROFILE,
  MARKETPLACE_ESCROW_PRESENTATION,
  MARKETPLACE_RECLAIM_SOURCE_PROFILE,
  marketplaceSourceConfigurationOpenings,
} from "../../marketplace/src/sourceVerification.ts";
import {
  attachConfigurationOpenings,
  assertMatchingCrsDigests,
  buildPortableToolchainIdentity,
  buildSubmissionEnvelope,
  collectNargoSourceClosure,
  formatContractVerificationReport,
  main as sourceVerificationMain,
  PRODUCER_PLATFORMS,
  reproduceContract,
  SOURCE_VERIFICATION_REPRODUCER,
  sourceVerificationManifestWithConfigurationOpenings,
  sourceVerificationPublicationWithConfigurationOpenings,
  validateNodeContractSourceBundleStructure,
  validatePortableToolchainIdentity,
} from "./index.mts";

test("source reproducer exposes an explicit absolute runtime path", () => {
  assert.equal(isAbsolute(SOURCE_VERIFICATION_REPRODUCER), true);
  assert.match(SOURCE_VERIFICATION_REPRODUCER, /scripts\/source-verification\/index\.mts$/);
});

function abiWithNames(names: readonly string[]) {
  return {
    parameters: [
      ...names.map((name) => ({ name, visibility: "private", type: { kind: "field" } })),
      { name: "private_input", visibility: "private", type: { kind: "field" } },
    ] as { name: string; visibility: string; type: { kind: string } }[],
    return_type: {
      abi_type: { kind: "array", length: 4, type: { kind: "field" } },
      visibility: "databus",
    },
    error_types: {},
    abi_version: 1,
  };
}

test("source bundle digest uses the canonical path-sorted metadata index", () => {
  const files = [
    { path: "z.nr", length: 1, sha256: "b".repeat(64), attachment: "ignored/z.nr" },
    { path: "a.nr", length: 2, sha256: "a".repeat(64), attachment: "ignored/a.nr" },
  ];
  const canonicalIndex = canonicalJson([
    { path: "a.nr", length: 2, sha256: "a".repeat(64) },
    { path: "z.nr", length: 1, sha256: "b".repeat(64) },
  ]);
  const expected = createHash("sha256").update(`pcash.source-bundle\0${canonicalIndex}`).digest("hex");
  assert.equal(sourceBundleDigest(files), expected);
  assert.equal(sourceBundleDigest([...files].reverse()), expected);
  assert.throws(
    () => sourceBundleDigest([{ path: "bad path.nr", length: 1, sha256: "a".repeat(64) }]),
    /normalized relative POSIX path/,
  );
});

test("the PCASH proving ABI takes private inputs and returns the four-Field rule statement", () => {
  assert.equal(PCASH_APPLICATION_RETURN_FIELDS, 4);
  // No input name or position is canonical: an application names its own witnesses.
  assert.doesNotThrow(() => validatePcashNoirAbi(abiWithNames([])));
  assert.doesNotThrow(() => validatePcashNoirAbi(abiWithNames(["recent_pcash_block_hash", "address"])));
  const nonField = abiWithNames(["fee_paid"]);
  nonField.parameters[0]!.type = { kind: "boolean" };
  assert.doesNotThrow(() => validatePcashNoirAbi(nonField));
  const extraPublic = abiWithNames(["a"]);
  extraPublic.parameters.push({ name: "second", visibility: "public", type: { kind: "field" } });
  assert.throws(() => validatePcashNoirAbi(extraPublic), /must be private/);
  assert.throws(
    () => validatePcashNoirAbi({ ...abiWithNames(["a"]), return_type: { kind: "field" } }),
    /four-Field databus/,
  );
  const fiveFields = abiWithNames(["a"]);
  fiveFields.return_type.abi_type.length = 5;
  assert.throws(() => validatePcashNoirAbi(fiveFields), /four-Field databus/);
  const { error_types: _errorTypes, ...missingErrorTypes } = abiWithNames(["a"]);
  assert.throws(() => validatePcashNoirAbi(missingErrorTypes), /error_types/);
});

const marketplacePresentationBindings = [
  {
    applicationVkHash: fieldToHex(CLAIM_APPLICATION_VK_HASH),
    configurationProfile: MARKETPLACE_CLAIM_SOURCE_PROFILE,
  },
  {
    applicationVkHash: fieldToHex(RECLAIM_APPLICATION_VK_HASH),
    configurationProfile: MARKETPLACE_RECLAIM_SOURCE_PROFILE,
  },
];

function exactAbi(names: readonly string[]) {
  return {
    parameters: names.map((name) => ({ name, visibility: "private", type: { kind: "field" } })),
    return_type: {
      abi_type: { kind: "array", length: 4, type: { kind: "field" } },
      visibility: "databus",
    },
    error_types: {},
    abi_version: 1,
  };
}

test("contract presentation is bound to the ordered implementation and configuration shape", () => {
  assert.doesNotThrow(() => assertContractPresentationProfile(
    MARKETPLACE_ESCROW_PRESENTATION,
    marketplacePresentationBindings,
  ));

  const wrongSelector = structuredClone(MARKETPLACE_ESCROW_PRESENTATION);
  wrongSelector.functions[0].selector = 1;
  assert.throws(
    () => assertContractPresentationProfile(wrongSelector, marketplacePresentationBindings),
    /strictly increasing|selector does not match/,
  );

  const wrongVk = structuredClone(MARKETPLACE_ESCROW_PRESENTATION);
  wrongVk.functions[0].applicationVkHash = fieldToHex(1n);
  assert.throws(
    () => assertContractPresentationProfile(wrongVk, marketplacePresentationBindings),
    /applicationVkHash does not match/,
  );

  const wrongConfigurationName = structuredClone(MARKETPLACE_ESCROW_PRESENTATION);
  wrongConfigurationName.functions[0].configurationFields[1].name = "otherRouter";
  assert.throws(
    () => assertContractPresentationProfile(wrongConfigurationName, marketplacePresentationBindings),
    /name does not match the configuration profile/,
  );

  const duplicateOverviewOrder = structuredClone(MARKETPLACE_ESCROW_PRESENTATION);
  duplicateOverviewOrder.functions[0].configurationFields[1].overviewOrder = 0;
  assert.throws(
    () => assertContractPresentationProfile(duplicateOverviewOrder, marketplacePresentationBindings),
    /duplicate overviewOrder/,
  );
});

test("one source implementation supports repeated VK functions with distinct configuration bindings", () => {
  const applicationVkHash = fieldToHex(123n);
  const profiles = [0, 1].map((selector) => ({
    id: `repeated-vk-${selector}`,
    implementationLabel: "Repeated.execute",
    selector,
    scheme: "poseidon-explicit-domain-positional-v1" as const,
    domain: fieldToHex(REFERENCE_CONFIGURATION_DOMAIN),
    fields: [{ name: selector === 0 ? "firstValue" : "secondValue", type: "field" as const }],
  }));
  const presentation = {
    schemaVersion: 1 as const,
    publisherLabel: "Repeated publisher",
    contractName: "Repeated VK contract",
    contractDescription: "Uses one implementation in two distinct function slots.",
    functions: profiles.map((profile, index) => ({
      selector: profile.selector,
      applicationVkHash,
      name: `execute_${index}`,
      summary: `Executes function slot ${index}.`,
      configurationFields: [{
        position: 0,
        name: profile.fields[0]!.name,
        label: `Value ${index}`,
        description: `Configuration value for slot ${index}.`,
        displayFormat: "field" as const,
        overviewOrder: index,
      }],
      proofGroups: [{
        title: `Execution ${index}`,
        description: `Proves execution inputs for slot ${index}.`,
        items: [{ abiParameter: "private_input", description: "Private execution input." }],
      }],
    })),
  };
  const manifest = {
    schemaVersion: 1,
    bundleFormat: "pcash-contract-source-bundle-v1",
    proofProfile: {
      id: "pcash-chonk-application-v1",
      returnFields: 4,
      returnVisibility: "databus",
    },
    presentation,
    implementations: [{ applicationVkHash }],
    configurationBindings: profiles.map((configurationProfile) => ({
      applicationVkHash,
      configurationProfile,
    })),
    configurationOpenings: [],
  };
  assert.doesNotThrow(() => assertSourceVerificationManifest(manifest));
  const address = "0x0000000000000000000000000000000000000001";
  const openings = profiles.map((profile, index) => {
    const value = BigInt(index + 7);
    return {
      address,
      selector: profile.selector,
      applicationVkHash,
      configurationCommitment: fieldToHex(configurationProfileCommitment(profile, {
        [profile.fields[0]!.name]: value,
      })),
      domain: profile.domain,
      values: [fieldToHex(value)],
    };
  });
  const withOpenings = sourceVerificationManifestWithConfigurationOpenings(
    manifest as Parameters<typeof sourceVerificationManifestWithConfigurationOpenings>[0],
    openings,
  );
  assert.equal(withOpenings.implementations.length, 1);
  assert.equal(withOpenings.configurationBindings.length, 2);
  assert.deepEqual(withOpenings.configurationOpenings.map((opening) => opening.selector), [0, 1]);
});

test("Marketplace proof presentation covers every ABI parameter exactly once", () => {
  const claim = exactAbi([
    "recent_pcash_block_hash",
    "event_entry",
    "address",
    "pcash_chain_id",
    "fee_paid",
    "configuration",
    "claim_key",
    "private_value",
    "escrow_note",
    "escrow_output_index",
    "payout_owner_commitment",
    "relay_fee_amount",
    "relay_fee_owner_commitment",
  ]);
  const reclaim = exactAbi([
    "recent_pcash_block_hash",
    "event_entry",
    "pcash_chain_id",
    "fee_paid",
    "configuration",
    "signature",
    "pubkey",
    "escrow_contract",
    "recipient",
    "issuance_recipient",
    "issuance_note_secret",
    "payout_opening_blinder",
    "private_value",
    "output_data_hashes",
    "arena_hash",
    "escrow_note",
    "escrow_output_index",
    "payout_note_secret",
    "relay_fee_amount",
    "relay_fee_owner_commitment",
  ]);
  assert.doesNotThrow(() => assertContractFunctionPresentationAbi(MARKETPLACE_ESCROW_PRESENTATION.functions[0], claim));
  assert.doesNotThrow(() => assertContractFunctionPresentationAbi(MARKETPLACE_ESCROW_PRESENTATION.functions[1], reclaim));

  const omitted = structuredClone(MARKETPLACE_ESCROW_PRESENTATION.functions[0]);
  omitted.proofGroups[0].items.pop();
  assert.throws(() => assertContractFunctionPresentationAbi(omitted, claim), /omits ABI parameter/);

  const unknown = structuredClone(MARKETPLACE_ESCROW_PRESENTATION.functions[0]);
  unknown.proofGroups[0].items[0].abiParameter = "authorization_account_id";
  assert.throws(() => assertContractFunctionPresentationAbi(unknown, claim), /unknown ABI parameter/);

  const duplicate = structuredClone(MARKETPLACE_ESCROW_PRESENTATION.functions[0]);
  duplicate.proofGroups[0].items[0].abiParameter = "claim_key";
  assert.throws(() => assertContractFunctionPresentationAbi(duplicate, claim), /more than once/);
});

test("Marketplace proof presentation covers the compiled release ABI", {
  skip: !process.env.PCASH_CIRCUIT_BUNDLE,
}, () => {
  for (const fn of MARKETPLACE_ESCROW_PRESENTATION.functions) {
    const artifact = JSON.parse(readFileSync(join(
      process.env.PCASH_CIRCUIT_BUNDLE!,
      "prover-assets/contracts/escrow",
      `${fn.name}.json`,
    ), "utf8"));
    assertContractFunctionPresentationAbi(fn, artifact.abi);
  }
});

const terms = {
  address: 0xabcdn,
  router: 0x11n,
  claimSeller: 0x22n,
  reclaimAuthority: 0x33n,
  claimConfigurationSalt: 0x66n,
  reclaimConfigurationSalt: 0x77n,
  offerId: 0x44n,
  assetId: 0n,
  amount: 50n,
  ethPriceWei: 60n,
  deadlineT: 70n,
  pcashChainId: PCASH_CHAIN_ID,
  l1ChainId: 11155111n,
  inboxAddress: 0x55n,
};

function attachmentInput(overrides: Record<string, unknown> = {}) {
  const offerTerms = {
    router: terms.router,
    seller: terms.claimSeller,
    id: terms.offerId,
    assetId: terms.assetId,
    amount: terms.amount,
    ethPriceWei: terms.ethPriceWei,
    deadlineT: terms.deadlineT,
  };
  const network = {
    pcashChainId: terms.pcashChainId,
    l1ChainId: terms.l1ChainId,
    inboxAddress: terms.inboxAddress,
  };
  return {
    address: terms.address,
    reclaimAuthority: terms.reclaimAuthority,
    claimConfigurationSalt: terms.claimConfigurationSalt,
    reclaimConfigurationSalt: terms.reclaimConfigurationSalt,
    terms: offerTerms,
    network,
    ...overrides,
  };
}

test("marketplace attachment separates claim seller and reclaim authority", () => {
  const openings = marketplaceSourceConfigurationOpenings(attachmentInput());
  assert.equal(
    openings[0]!.configurationCommitment,
    fieldToHex(11349487394926345929610384531113950851163267018959254352885956081956906354815n),
  );
  assert.equal(
    openings[1]!.configurationCommitment,
    fieldToHex(0x15d8fb23af07359b7010c85d502a584a212c2bfe193567ae11b6bb2dad4279fdn),
  );
  assert.equal(openings[0]!.address, "0x000000000000000000000000000000000000abcd");
  assert.equal(openings[0]!.domain, fieldToHex(REFERENCE_CONFIGURATION_DOMAIN));
  assert.equal(openings[1]!.domain, fieldToHex(REFERENCE_CONFIGURATION_DOMAIN));
  assert.deepEqual(MARKETPLACE_CLAIM_SOURCE_PROFILE.fields.map((field) => field.name), [
    "configurationSalt", "router", "seller", "offerId", "assetId", "amount", "ethPriceWei", "deadlineT",
  ]);
  assert.deepEqual(MARKETPLACE_RECLAIM_SOURCE_PROFILE.fields.map((field) => field.name), [
    "configurationSalt", "seller", "offerId", "deadlineT", "domainSeparatorHigh", "domainSeparatorLow",
  ]);
  assert.equal(openings[0]!.values.length, 8);
  assert.equal(openings[1]!.values.length, 6);
  assert.equal(openings[0]!.values[0], fieldToHex(terms.claimConfigurationSalt));
  assert.equal(openings[0]!.values[2], fieldToHex(terms.claimSeller));
  assert.equal(openings[1]!.values[0], fieldToHex(terms.reclaimConfigurationSalt));
  assert.equal(openings[1]!.values[1], fieldToHex(terms.reclaimAuthority));
  assert.equal(openings[1]!.values[2], fieldToHex(terms.offerId));
  assert.equal("labels" in openings[0]!, false);
  assert.throws(() => marketplaceSourceConfigurationOpenings(attachmentInput({ address: 1n << 160n })), /fit uint160/);

});

test("Marketplace source closure preserves virtual paths and local path dependencies", () => {
  const root = new URL("../..", import.meta.url).pathname;
  const claim = collectNargoSourceClosure(root, "marketplace/l2-contracts/escrow/claim");
  assert(claim.includes("marketplace/l2-contracts/escrow/claim/Nargo.toml"));
  assert(claim.includes("marketplace/l2-contracts/escrow/claim/src/main.nr"));
  assert(claim.includes("circuits/protocol/lib/src/authorization/account.nr"));
  assert(claim.includes("circuits/rules/lib/Nargo.toml"));
  assert(claim.includes("marketplace/l2-contracts/escrow/common/src/lib.nr"));
  assert(claim.includes("circuits/signature/src/eip712.nr"));
  assert(claim.includes("circuits/vendor/keccak256/src/lib.nr"));
  assert(!claim.some((path) => path.includes("/target/") || path.includes("/fixtures/")));
});

test("generic attachment is atomic, additive, and idempotent by address and selector", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pcash-source-attach-test-"));
  const path = join(directory, "pcash-contract-source.json");
  const priorOpening = {
    address: "0x0000000000000000000000000000000000000001",
    selector: 0,
    applicationVkHash: fieldToHex(CLAIM_APPLICATION_VK_HASH),
    configurationCommitment: fieldToHex(9n),
    domain: fieldToHex(7n),
    values: [fieldToHex(8n)],
  };
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    bundleFormat: "pcash-contract-source-bundle-v1",
    generatedAt: "2026-08-08T00:00:00.000Z",
    serviceName: "test",
    proofProfile: {
      id: "pcash-chonk-application-v1",
      returnFields: 4,
      returnVisibility: "databus",
    },
    presentation: MARKETPLACE_ESCROW_PRESENTATION,
    implementations: [
      {
        id: "marketplace-escrow-claim",
        applicationVkHash: fieldToHex(CLAIM_APPLICATION_VK_HASH),
      },
      {
        id: "marketplace-escrow-reclaim",
        applicationVkHash: fieldToHex(RECLAIM_APPLICATION_VK_HASH),
      },
    ],
    configurationBindings: marketplacePresentationBindings,
    configurationOpenings: [priorOpening],
  }));
  chmodSync(path, 0o664);
  const openings = marketplaceSourceConfigurationOpenings(attachmentInput());
  const openingsPath = join(directory, "openings.json");
  writeFileSync(openingsPath, JSON.stringify(openings));
  await sourceVerificationMain([
    "attach-configurations",
    "--bundle",
    path,
    "--openings",
    openingsPath,
  ]);
  attachConfigurationOpenings(path, openings);
  const updated = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(statSync(path).mode & 0o777, 0o664);
  assert.equal(updated.configurationOpenings.length, 3);
  assert.deepEqual(updated.configurationOpenings[0], priorOpening);
  const beforeFailure = readFileSync(path, "utf8");
  const invalid = [{ ...openings[0], configurationCommitment: fieldToHex(1n) }];
  assert.throws(() => attachConfigurationOpenings(path, invalid), /does not match the supplied values/);
  assert.equal(readFileSync(path, "utf8"), beforeFailure);
});

test("source publication can add validated openings without mutating its bundle", () => {
  const directory = mkdtempSync(join(tmpdir(), "pcash-source-publication-test-"));
  const path = join(directory, "pcash-contract-source.json");
  const attachmentNames = [
    "claim.nr", "claim-artifact.json", "claim-abi.json", "claim-vk",
    "reclaim.nr", "reclaim-artifact.json", "reclaim-abi.json", "reclaim-vk",
  ];
  for (const name of attachmentNames) writeFileSync(join(directory, name), name);
  const implementation = (
    id: string,
    applicationVkHash: string,
    prefix: string,
  ) => ({
    id,
    applicationVkHash,
    sourceFiles: [{ attachment: `${prefix}.nr` }],
    compilerArtifact: { attachment: `${prefix}-artifact.json` },
    noirProvingAbi: { attachment: `${prefix}-abi.json` },
    verificationKey: { attachment: `${prefix}-vk` },
  });
  const manifest = {
    schemaVersion: 1,
    bundleFormat: "pcash-contract-source-bundle-v1",
    generatedAt: "2026-08-25T00:00:00.000Z",
    serviceName: "test",
    proofProfile: {
      id: "pcash-chonk-application-v1",
      returnFields: 4,
      returnVisibility: "databus",
    },
    presentation: MARKETPLACE_ESCROW_PRESENTATION,
    implementations: [
      implementation(
        "claim",
        fieldToHex(CLAIM_APPLICATION_VK_HASH),
        "claim",
      ),
      implementation(
        "reclaim",
        fieldToHex(RECLAIM_APPLICATION_VK_HASH),
        "reclaim",
      ),
    ],
    configurationBindings: marketplacePresentationBindings,
    configurationOpenings: [],
  };
  const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(path, encoded);
  const openings = marketplaceSourceConfigurationOpenings(attachmentInput());

  const publication = sourceVerificationPublicationWithConfigurationOpenings(path, openings);
  assert.equal(publication.manifest.configurationOpenings.length, 2);
  assert.equal(Object.keys(publication.attachments).length, attachmentNames.length);
  assert.equal(readFileSync(path, "utf8"), encoded);

  const replaced = sourceVerificationPublicationWithConfigurationOpenings(path, openings);
  assert.deepEqual(replaced.manifest.configurationOpenings, publication.manifest.configurationOpenings);
  assert.equal(readFileSync(path, "utf8"), encoded);
});

test("generic configuration attachment has no Marketplace-shaped requirement", () => {
  const directory = mkdtempSync(join(tmpdir(), "pcash-source-generic-test-"));
  const path = join(directory, "pcash-contract-source.json");
  const profile = {
    id: "example-vault-v1",
    implementationLabel: "ExampleVault.release",
    selector: 7,
    scheme: "poseidon-explicit-domain-positional-v1" as const,
    domain: fieldToHex(0x123n),
    fields: [
      { name: "configurationSalt", type: "field" as const },
      { name: "limit", type: "uint64" as const, bits: 64 },
    ],
  };
  const applicationVkHash = fieldToHex(0x456n);
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    bundleFormat: "pcash-contract-source-bundle-v1",
    generatedAt: "2026-08-08T00:00:00.000Z",
    serviceName: "test",
    proofProfile: {
      id: "pcash-chonk-application-v1",
      returnFields: 4,
      returnVisibility: "databus",
    },
    presentation: {
      schemaVersion: 1,
      publisherLabel: "Example publisher",
      contractName: "ExampleVault",
      contractDescription: "Releases a configured amount from an example vault.",
      functions: [{
        selector: profile.selector,
        applicationVkHash,
        name: "release",
        summary: "Releases the configured vault amount.",
        configurationFields: profile.fields.map((field, position) => ({
          position,
          name: field.name,
          label: field.name,
          description: `Describes ${field.name}.`,
          displayFormat: field.name === "limit" ? "uint" : "hex",
          overviewOrder: field.name === "limit" ? 0 : null,
        })),
        proofGroups: [{
          title: "Vault authorization",
          description: "Proves the private vault authorization inputs.",
          items: [{ abiParameter: "authorization", description: "Private vault authorization." }],
        }],
      }],
    },
    implementations: [{ id: "example-vault-release", applicationVkHash }],
    configurationBindings: [{ applicationVkHash, configurationProfile: profile }],
    configurationOpenings: [],
  }));
  const values = { configurationSalt: 5n, limit: 100n };
  const opening = {
    address: "0x0000000000000000000000000000000000000002",
    selector: profile.selector,
    applicationVkHash,
    configurationCommitment: fieldToHex(configurationProfileCommitment(profile, values)),
    domain: profile.domain,
    values: [fieldToHex(values.configurationSalt), fieldToHex(values.limit)],
  };
  const updated = attachConfigurationOpenings(path, [opening]);
  assert.deepEqual(updated.configurationOpenings, [opening]);
});

const releaseManifestBytes = new Uint8Array(
  readFileSync(new URL("../../assets/prover-toolchain.json", import.meta.url)),
);
const releaseManifest = JSON.parse(Buffer.from(releaseManifestBytes).toString("utf8"));
const testG1Sha256 = "1".repeat(64);
const testG2Sha256 = releaseManifest.crs.bn254G2.sha256 as string;

test("portable toolchain identity binds producer archives without binding the verifier platform", () => {
  const darwinProducer = buildPortableToolchainIdentity(releaseManifestBytes, "darwin-arm64", {
    bn254G1Sha256: testG1Sha256,
    bn254G2Sha256: testG2Sha256,
  });
  const linuxProducer = buildPortableToolchainIdentity(releaseManifestBytes, "linux-x64", {
    bn254G1Sha256: testG1Sha256,
    bn254G2Sha256: testG2Sha256,
  });
  assert.notEqual(darwinProducer.nargo.archiveSha256, linuxProducer.nargo.archiveSha256);
  assert.notEqual(darwinProducer.barretenberg.archiveSha256, linuxProducer.barretenberg.archiveSha256);
  assert.equal(
    darwinProducer.releaseManifestSha256,
    createHash("sha256").update(releaseManifestBytes).digest("hex"),
  );
  assert.deepEqual(Object.keys(darwinProducer), [
    "releaseManifestSha256",
    "producerPlatform",
    "nargo",
    "barretenberg",
    "crs",
  ]);
  assert.deepEqual(Object.keys(darwinProducer.nargo), ["version", "noircCommit", "archiveSha256"]);
  assert.deepEqual(Object.keys(darwinProducer.barretenberg), ["version", "verifierTarget", "archiveSha256"]);
  assert.deepEqual(Object.keys(darwinProducer.crs), ["bn254G1Sha256", "bn254G2Sha256"]);
  assert.deepEqual(validatePortableToolchainIdentity(darwinProducer, releaseManifestBytes), darwinProducer);
  assert.deepEqual(validatePortableToolchainIdentity(linuxProducer, releaseManifestBytes), linuxProducer);
  assert.deepEqual(PRODUCER_PLATFORMS, ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
});

test("portable toolchain identity rejects altered release metadata and the old binary digest shape", () => {
  const identity = buildPortableToolchainIdentity(releaseManifestBytes, "darwin-arm64", {
    bn254G1Sha256: testG1Sha256,
    bn254G2Sha256: testG2Sha256,
  });
  assert.throws(
    () => validatePortableToolchainIdentity({ ...identity, releaseManifestSha256: "2".repeat(64) }, releaseManifestBytes),
    /releaseManifestSha256 mismatch/,
  );
  assert.throws(
    () => validatePortableToolchainIdentity({
      ...identity,
      nargo: { ...identity.nargo, archiveSha256: "2".repeat(64) },
    }, releaseManifestBytes),
    /nargo\.archiveSha256 mismatch/,
  );
  assert.throws(
    () => validatePortableToolchainIdentity({
      ...identity,
      nargo: { version: identity.nargo.version, noircCommit: identity.nargo.noircCommit, sha256: identity.nargo.archiveSha256 },
    }, releaseManifestBytes),
    /nargo\.archiveSha256 must be a string/,
  );
  assert.throws(
    () => buildPortableToolchainIdentity(releaseManifestBytes, "darwin-arm64", {
      bn254G1Sha256: testG1Sha256,
      bn254G2Sha256: "2".repeat(64),
    }),
    /BN254 G2 CRS mismatch/,
  );
  assert.throws(
    () => assertMatchingCrsDigests(identity.crs, { ...identity.crs, bn254G1Sha256: "2".repeat(64) }),
    /BN254 G1 CRS mismatch/,
  );
  assert.throws(
    () => assertMatchingCrsDigests(identity.crs, { ...identity.crs, bn254G2Sha256: "2".repeat(64) }),
    /BN254 G2 CRS mismatch/,
  );
});

function nodeExport(
  functionHashes: readonly string[],
  summaryHashes: readonly string[],
  entryHashes: readonly string[],
  verificationStatus = "verified",
  viewAddress = "0x0000000000000000000000000000000000000001",
  contractAddress = viewAddress,
) {
  const summary = (applicationVkHash: string) => ({
    verificationStatus: "verified",
    verificationAuthority: "node_operator",
    verificationMethod: "node_registry",
    applicationVkHash,
    implementationLabel: `implementation-${applicationVkHash.slice(-4)}`,
    packageRoot: `package-${applicationVkHash.slice(-4)}`,
    packageName: `rule_${applicationVkHash.slice(-4)}`,
    sourceBundleDigest: `0x${"2".repeat(64)}`,
    compilerArtifactSha256: `0x${"3".repeat(64)}`,
    decodedAcirSha256: `0x${"4".repeat(64)}`,
    noirProvingAbiSha256: `0x${"5".repeat(64)}`,
    verificationKeySha256: `0x${"6".repeat(64)}`,
    verificationKeyFieldCount: "0x73",
    toolchain: buildPortableToolchainIdentity(releaseManifestBytes, "darwin-arm64", {
      bn254G1Sha256: testG1Sha256,
      bn254G2Sha256: testG2Sha256,
    }),
  });
  return {
    contract: {
      address: viewAddress,
      verificationStatus,
      presentation: {
        verificationAuthority: "node_operator",
        verificationMethod: "node_registry",
        profile: {
          schemaVersion: "0x1",
          publisherLabel: "Test publisher",
          contractName: "TestContract",
          contractDescription: "Test contract presentation.",
          functions: functionHashes.map((applicationVkHash, selector) => ({
            selector: `0x${selector.toString(16)}`,
            applicationVkHash,
            name: `function_${selector}`,
            summary: `Executes test function ${selector}.`,
            configurationFields: [],
            proofGroups: [{
              title: `Authorization ${selector}`,
              description: `Proves the private inputs for function ${selector}.`,
              items: [{ abiParameter: "private_input", description: "Private test input." }],
            }],
          })),
        },
      },
      contract: {
        address: contractAddress,
        functions: functionHashes.map((applicationVkHash, selector) => ({
          selector: `0x${selector.toString(16)}`,
          applicationVkHash,
        })),
      },
      implementations: summaryHashes.map(summary),
    },
    implementations: entryHashes.map((applicationVkHash) => ({
      source: { implementation: summary(applicationVkHash) },
      files: [],
    })),
  };
}

const applicationVkOne = fieldToHex(1n);
const applicationVkTwo = fieldToHex(2n);
const applicationVkThree = fieldToHex(3n);

test("node export coverage is an exact set across functions, summaries, and bundle entries", () => {
  assert.doesNotThrow(() => validateNodeContractSourceBundleStructure(nodeExport(
    [applicationVkOne, applicationVkTwo],
    [applicationVkTwo, applicationVkOne],
    [applicationVkOne, applicationVkTwo],
  )));
  assert.doesNotThrow(() => validateNodeContractSourceBundleStructure(nodeExport(
    [applicationVkOne, applicationVkOne],
    [applicationVkOne],
    [applicationVkOne],
  )));
});

test("node export coverage rejects unverified, empty, missing, extra, and duplicate implementations", () => {
  const cases: Array<{ name: string; value: unknown; pattern: RegExp }> = [
    {
      name: "unverified",
      value: nodeExport([applicationVkOne], [applicationVkOne], [applicationVkOne], "not_verified"),
      pattern: /verification status mismatch/,
    },
    {
      name: "empty function set",
      value: nodeExport([], [], []),
      pattern: /function set is empty/,
    },
    {
      name: "missing summary",
      value: nodeExport([applicationVkOne, applicationVkTwo], [applicationVkOne], [applicationVkOne, applicationVkTwo]),
      pattern: /contract\.implementations application VK hash set mismatch/,
    },
    {
      name: "extra summary",
      value: nodeExport([applicationVkOne], [applicationVkOne, applicationVkThree], [applicationVkOne]),
      pattern: /contract\.implementations application VK hash set mismatch/,
    },
    {
      name: "duplicate summary",
      value: nodeExport([applicationVkOne], [applicationVkOne, applicationVkOne], [applicationVkOne]),
      pattern: /contract\.implementations contains duplicate/,
    },
    {
      name: "missing bundle entry",
      value: nodeExport([applicationVkOne, applicationVkTwo], [applicationVkOne, applicationVkTwo], [applicationVkOne]),
      pattern: /implementations application VK hash set mismatch/,
    },
    {
      name: "extra bundle entry",
      value: nodeExport([applicationVkOne], [applicationVkOne], [applicationVkOne, applicationVkThree]),
      pattern: /implementations application VK hash set mismatch/,
    },
    {
      name: "duplicate bundle entry",
      value: nodeExport([applicationVkOne], [applicationVkOne], [applicationVkOne, applicationVkOne]),
      pattern: /implementations contains duplicate/,
    },
  ];
  for (const { name, value, pattern } of cases) {
    assert.throws(() => validateNodeContractSourceBundleStructure(value), pattern, name);
  }
});

test("node export coverage binds the contract address and matching implementation evidence", () => {
  assert.throws(
    () => validateNodeContractSourceBundleStructure(nodeExport(
      [applicationVkOne],
      [applicationVkOne],
      [applicationVkOne],
      "verified",
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000002",
    )),
    /contract address mismatch/,
  );
  const altered = nodeExport([applicationVkOne], [applicationVkOne], [applicationVkOne]);
  altered.implementations[0]!.source.implementation.decodedAcirSha256 = `0x${"7".repeat(64)}`;
  assert.throws(
    () => validateNodeContractSourceBundleStructure(altered),
    /contract and bundle implementation summary .* mismatch/,
  );
  assert.throws(
    () => validateNodeContractSourceBundleStructure(nodeExport(
      [`0x${"f".repeat(64)}`],
      [`0x${"f".repeat(64)}`],
      [`0x${"f".repeat(64)}`],
    )),
    /canonical BN254 field/,
  );
});

test("node export presentation is bound to the authenticated ordered function shape", () => {
  const wrongVk = nodeExport(
    [applicationVkOne, applicationVkTwo],
    [applicationVkOne, applicationVkTwo],
    [applicationVkOne, applicationVkTwo],
  );
  wrongVk.contract.presentation.profile.functions[0]!.applicationVkHash = applicationVkTwo;
  assert.throws(
    () => validateNodeContractSourceBundleStructure(wrongVk),
    /applicationVkHash does not match its implementation/,
  );

  const wrongSelector = nodeExport([applicationVkOne], [applicationVkOne], [applicationVkOne]);
  wrongSelector.contract.presentation.profile.functions[0]!.selector = "0x1";
  assert.throws(
    () => validateNodeContractSourceBundleStructure(wrongSelector),
    /selector does not match its implementation/,
  );
});

test("reproducer recognizes an empty node export and rejects it before toolchain lookup", () => {
  const directory = mkdtempSync(join(tmpdir(), "pcash-source-node-export-test-"));
  const path = join(directory, "contract-source-bundle.json");
  writeFileSync(path, JSON.stringify(nodeExport([], [], [])));
  assert.throws(() => reproduceContract(path), /function set is empty/);
});

function writeSubmissionFixtureBundle(directory: string, attachment: string): string {
  const manifestPath = join(directory, "pcash-contract-source.json");
  for (const bundled of ["attachments/main.nr", "attachments/a.json", "attachments/abi.json", "attachments/vk.field"]) {
    mkdirSync(dirname(join(directory, bundled)), { recursive: true });
    writeFileSync(join(directory, bundled), `${bundled}\n`);
  }
  const configurationProfile = {
    id: "test-implementation-v1",
    implementationLabel: "Test.implementation",
    selector: 0,
    scheme: "poseidon-explicit-domain-positional-v1",
    domain: fieldToHex(1n),
    fields: [{ name: "configurationSalt", type: "field" }],
  } as const;
  const manifest = {
    schemaVersion: 1,
    bundleFormat: "pcash-contract-source-bundle-v1",
    generatedAt: "2026-08-25T00:00:00.000Z",
    serviceName: "Test Operator",
    proofProfile: {
      id: "pcash-chonk-application-v1",
      returnFields: 4,
      returnVisibility: "databus",
    },
    presentation: {
      schemaVersion: 1,
      publisherLabel: "Test publisher",
      contractName: "TestContract",
      contractDescription: "Test contract source presentation.",
      functions: [{
        selector: 0,
        applicationVkHash: `0x${"11".repeat(32)}`,
        name: "execute",
        summary: "Executes the test contract.",
        configurationFields: [{
          position: 0,
          name: "configurationSalt",
          label: "Configuration salt",
          description: "Makes the test configuration commitment unique.",
          displayFormat: "hex",
          overviewOrder: null,
        }],
        proofGroups: [{
          title: "Execution",
          description: "Proves the test execution inputs.",
          items: [{ abiParameter: "input", description: "Private test input." }],
        }],
      }],
    },
    implementations: [{
      id: "impl-a",
      implementationLabel: "impl-a",
      applicationVkHash: `0x${"11".repeat(32)}`,
      packageRoot: "packages/a",
      packageName: "a",
      sourceBundleDigest: `0x${"22".repeat(32)}`,
      sourceFiles: [{ path: "src/main.nr", length: 13, sha256: `0x${"33".repeat(32)}`, attachment }],
      compilerArtifact: { attachment: "attachments/a.json", sha256: `0x${"44".repeat(32)}`, decodedAcirSha256: `0x${"55".repeat(32)}` },
      noirProvingAbi: { attachment: "attachments/abi.json", sha256: `0x${"66".repeat(32)}` },
      verificationKey: { attachment: "attachments/vk.field", sha256: `0x${"77".repeat(32)}`, fieldCount: 1 },
    }],
    configurationBindings: [{
      applicationVkHash: `0x${"11".repeat(32)}`,
      configurationProfile,
    }],
    configurationOpenings: [],
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

test("submission envelope binds a bundle directory to the canonical contract address", () => {
  const directory = mkdtempSync(join(tmpdir(), "pcash-source-envelope-test-"));
  try {
    writeSubmissionFixtureBundle(directory, "attachments/main.nr");
    const address = `0x${"ab".repeat(20)}`;
    const envelope = buildSubmissionEnvelope(directory, `${address.toUpperCase()},${address}`);
    assert.deepEqual(envelope.contractAddresses, [address, address]);
    assert.deepEqual(Object.keys(envelope.publication.attachments), [
      "attachments/a.json",
      "attachments/abi.json",
      "attachments/main.nr",
      "attachments/vk.field",
    ]);
    assert.equal(
      Buffer.from(envelope.publication.attachments["attachments/main.nr"]!, "base64").toString("utf8"),
      "attachments/main.nr\n",
    );
    const implementations = envelope.publication.manifest.implementations as Array<{ id: string }>;
    assert.equal(implementations.length, 1);
    assert.equal(implementations[0]!.id, "impl-a");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("submission envelope rejects traversal and absolute attachment paths", () => {
  for (const attachment of ["../secret.nr", "/etc/passwd", "a/../../escape.nr"]) {
    const directory = mkdtempSync(join(tmpdir(), "pcash-source-envelope-bad-"));
    try {
      writeSubmissionFixtureBundle(directory, attachment);
      assert.throws(
        () => buildSubmissionEnvelope(directory, `0x${"ab".repeat(20)}`),
        /portable relative path|escapes/,
        attachment,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("submission envelope rejects malformed contract addresses", () => {
  const directory = mkdtempSync(join(tmpdir(), "pcash-source-envelope-addr-"));
  try {
    writeSubmissionFixtureBundle(directory, "attachments/main.nr");
    assert.throws(() => buildSubmissionEnvelope(directory, "0x1234"), /canonical 20-byte address/);
    assert.throws(() => buildSubmissionEnvelope(directory, `0x${"gh".repeat(20)}`), /canonical 20-byte address/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verification report renders verdict, per-function registry presence, and service footer", () => {
  const summary = {
    address: `0x${"ab".repeat(20)}`,
    verified: false,
    functions: [
      { selector: 0x01, name: undefined, applicationVkHash: `0x${"11".repeat(32)}`, inRegistry: false },
      { selector: 0x2a, name: "claim", applicationVkHash: `0x${"22".repeat(32)}`, inRegistry: true },
    ],
  };
  const info = {
    status: "ready",
    sourceSubmissionStatus: "ready",
    configurationOpeningSubmissionStatus: "disabled",
  };
  assert.equal(
    formatContractVerificationReport(summary, info),
    [
      `0x${"ab".repeat(20)}: NOT VERIFIED`,
      "0x01 vk 0x1111111111111111111111111111111111111111111111111111111111111111 MISSING",
      "0x2a claim vk 0x2222222222222222222222222222222222222222222222222222222222222222 present",
      "service: status=ready sourceSubmissions=ready configurationOpeningSubmissions=disabled",
    ].join("\n"),
  );
});
