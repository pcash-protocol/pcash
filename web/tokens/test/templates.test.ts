import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BN254_SCALAR_MODULUS, domainTag, poseidon } from "@pcash/sdk/crypto";
import {
  accountRuleEntryCommitment,
  decodeContractBody,
  encodeAssetDefinition,
  nullifierKeyCommitment,
  verifyContract,
  verifyContractManifest,
  type ContractManifest,
} from "@pcash/sdk/protocol";
import { REFERENCE_CONFIGURATION_DOMAIN } from "@pcash/sdk/constants";
import { toBase64Url } from "@pcash/sdk/utils";
import {
  CLAIM_LINK_FUNCTION_SELECTOR,
  DROP_CLAIM_FUNCTION_SELECTOR,
  DROP_RECLAIM_FUNCTION_SELECTOR,
  CLAIM_LINK_APPLICATION_VK_HASH,
  DROP_CLAIM_APPLICATION_VK_HASH,
  DROP_RECLAIM_APPLICATION_VK_HASH,
  TOKENS_CIRCUIT_PROFILES,
  TOKENS_CIRCUITS,
  TOKENS_DROP_CLAIM_REPLAY_DOMAIN,
  TOKENS_DROP_CONTRACT_DOMAIN,
  TOKENS_DROP_INVENTORY_DOMAIN,
  TOKENS_LINK_CONTRACT_DOMAIN,
  TOKENS_LINK_CONTRACT_SEED_DOMAIN,
  TOKENS_LINK_SET_DOMAIN,
  TOKENS_LINK_KEY_DOMAIN,
  TOKENS_LINK_NOTE_SECRET_DOMAIN,
  claimLinkContract,
  claimLinkContractOf,
  claimLinkSetSecret,
  claimLinkKey,
  claimLinkNoteSecret,
  decodeClaimLink,
  dropClaimReplayId,
  dropConfigurationCommitment,
  dropInventorySecret,
  dropTermsForCreator,
  eligibilityDrop,
  encodeClaimLink,
  formatClaimLinkUrl,
  parseClaimLink,
  planClaimLinks,
  type ClaimLink,
} from "../src/index.ts";
import { testToken } from "./wallets.ts";

function manifest(path: string): ContractManifest {
  return JSON.parse(readFileSync(new URL(`../l2-contracts/${path}/manifest.json`, import.meta.url), "utf8")) as ContractManifest;
}

test("template domain tags follow the pcash derivation", () => {
  assert.equal(TOKENS_LINK_SET_DOMAIN, domainTag("tokens_link_set"));
  assert.equal(TOKENS_LINK_CONTRACT_SEED_DOMAIN, domainTag("tokens_link_contract_seed"));
  assert.equal(TOKENS_LINK_CONTRACT_DOMAIN, domainTag("tokens_link_contract"));
  assert.equal(TOKENS_LINK_KEY_DOMAIN, domainTag("tokens_link_key"));
  assert.equal(TOKENS_LINK_NOTE_SECRET_DOMAIN, domainTag("tokens_link_note_secret"));
  assert.equal(TOKENS_DROP_CONTRACT_DOMAIN, domainTag("tokens_drop_contract"));
  assert.equal(TOKENS_DROP_INVENTORY_DOMAIN, domainTag("tokens_drop_inventory"));
  assert.equal(TOKENS_DROP_CLAIM_REPLAY_DOMAIN, domainTag("tokens_drop_claim_replay"));
});

test("the drop claim circuit carries the TypeScript replay domain", () => {
  const source = readFileSync(new URL("../l2-contracts/drop/claim/src/main.nr", import.meta.url), "utf8");
  const match = source.match(/DROP_CLAIM_REPLAY_DOMAIN: Field =\s*(0x[0-9a-f]+);/);
  assert.equal(BigInt(match![1]!), TOKENS_DROP_CLAIM_REPLAY_DOMAIN);
});

test("every template function circuit has a pinned browser profile", () => {
  for (const url of Object.values(TOKENS_CIRCUITS)) {
    const profile = TOKENS_CIRCUIT_PROFILES[url];
    assert.equal(profile.srsPoints, 2 ** 18);
    assert.match(profile.circuitSha256, /^[0-9a-f]{64}$/);
    assert.match(profile.vkSha256, /^[0-9a-f]{64}$/);
  }
});

test("a claim-link contract binds its manifest, configuration, and derived address", () => {
  const contract = claimLinkContract({ contractSeed: 0x5eedn, assetId: 0xa55e7n });
  const body = decodeContractBody(contract.body);
  assert.equal(verifyContract(body).address, contract.address);
  assert.equal(body.nullifierKey.publishesNkRoot && body.nullifierKey.nkRoot, contract.nkRoot);
  assert.equal(body.nullifierKey.publishesNkRoot, true);
  assert.equal(body.mlKemPublicKey, undefined);
  const verified = verifyContractManifest(body, manifest("claim-link"));
  assert.deepEqual(verified.functions.map((entry) => [entry.name, entry.selector]), [["claim", CLAIM_LINK_FUNCTION_SELECTOR]]);
  assert.equal(body.functions[0]!.applicationVkHash, CLAIM_LINK_APPLICATION_VK_HASH);
  assert.equal(
    contract.configurationCommitment,
    poseidon([REFERENCE_CONFIGURATION_DOMAIN, contract.configuration.configurationSalt, 0xa55e7n]),
  );
  assert.notEqual(claimLinkContract({ contractSeed: 0x5eedn, assetId: 0xa55e8n }).address, contract.address);
  assert.notEqual(claimLinkContract({ contractSeed: 0x5eeen, assetId: 0xa55e7n }).address, contract.address);
  assert.notEqual(claimLinkContract({ contractSeed: 0n, assetId: 0xa55e7n }).address, contract.address);
  assert.throws(() => claimLinkContract({ contractSeed: 0x5eedn, assetId: 0n }), /assetId must be nonzero/);
});

test("a creator regenerates every link of a batch from one secret", () => {
  const plan = planClaimLinks({ creatorSecret: 7n, assetId: 9n, amounts: [5n, 6n] });
  assert.deepEqual(plan.links.map((link) => link.linkKey), [claimLinkKey(7n, 0), claimLinkKey(7n, 1)]);
  assert.deepEqual(plan.links.map((link) => link.noteSecret), plan.links.map((link) => claimLinkNoteSecret(link.linkKey)));
  assert.notEqual(plan.links[0]!.linkKey, plan.links[1]!.linkKey);
  assert.equal(plan.contract.address, planClaimLinks({ creatorSecret: 7n, assetId: 9n, amounts: [] }).contract.address);
  // Zero is one more creator secret and link key.
  assert.deepEqual(planClaimLinks({ creatorSecret: 0n, assetId: 9n, amounts: [5n] }).links.map((link) => link.linkKey), [claimLinkKey(0n, 0)]);
  assert.equal(claimLinkNoteSecret(0n), poseidon([TOKENS_LINK_NOTE_SECRET_DOMAIN, 0n]));
});

test("a link set's secret re-derives from the creator's nullifier key root and its nonce", () => {
  assert.equal(claimLinkSetSecret(11n, 3n), claimLinkSetSecret(11n, 3n));
  assert.notEqual(claimLinkSetSecret(11n, 3n), claimLinkSetSecret(11n, 4n));
  // A zero nullifier key root is one more root.
  assert.equal(claimLinkSetSecret(0n, 3n), poseidon([TOKENS_LINK_SET_DOMAIN, 0n, 3n]));
  assert.notEqual(claimLinkSetSecret(11n, 3n), claimLinkSetSecret(12n, 3n));
  assert.equal(claimLinkSetSecret(11n, 0n), poseidon([TOKENS_LINK_SET_DOMAIN, 11n, 0n]));
});

const token = testToken(7n);
const link: ClaimLink = {
  contractSeed: 0x1234n,
  funding: { contentHash: `0x${"ff".repeat(32)}`, slot: 31 },
  amount: (1n << 128n) - 1n,
  linkKey: BN254_SCALAR_MODULUS - 1n,
  definition: token.definition,
};

test("claim links round-trip through their URL fragment", () => {
  const url = formatClaimLinkUrl(link, "https://pcash.example/claim#stale");
  assert.ok(url.startsWith("https://pcash.example/claim#"));
  assert.deepEqual(parseClaimLink(url), link);
  assert.deepEqual(parseClaimLink(url.slice(url.indexOf("#") + 1)), link);
  assert.equal(encodeClaimLink(link).length, 114 + encodeAssetDefinition(token.definition).length);
  assert.equal(claimLinkContractOf(link).address, claimLinkContract({ contractSeed: link.contractSeed, assetId: token.assetId }).address);
  const zero = { ...link, contractSeed: 0n, linkKey: 0n };
  assert.deepEqual(decodeClaimLink(encodeClaimLink(zero)), zero);
});

test("claim link decoding rejects malformed links", () => {
  const bytes = encodeClaimLink(link);
  assert.throws(() => decodeClaimLink(bytes.subarray(0, 114)), /truncated/);
  const version = bytes.slice();
  version[0] = 2;
  assert.throws(() => decodeClaimLink(version), /version/);
  const seed = bytes.slice();
  seed.fill(0xff, 1, 33);
  assert.throws(() => decodeClaimLink(seed), /contract seed is not a canonical field element/);
  const key = bytes.slice();
  key.fill(0xff, 82, 114);
  assert.throws(() => decodeClaimLink(key), /link key/);
  const amount = bytes.slice();
  amount.fill(0, 66, 82);
  assert.throws(() => decodeClaimLink(amount), /amount/);
  assert.throws(() => parseClaimLink(`#${toBase64Url(bytes)}!`));
  assert.throws(() => decodeClaimLink(Uint8Array.of(...bytes, 0)));
});

test("an eligibility drop binds both functions to one configuration", () => {
  const creator = { address: 0xc0ffeen, nkRoot: 0xabcn };
  const terms = dropTermsForCreator({
    dropSeed: 0xd509n,
    assetId: 0xa55e7n,
    claimAmount: 250n,
    cutoffBlockNumber: 7n,
    claimEndTimestamp: 5_000n,
    creator,
  });
  const drop = eligibilityDrop(terms);
  const body = decodeContractBody(drop.body);
  assert.equal(verifyContract(body).address, drop.address);
  const verified = verifyContractManifest(body, manifest("drop"));
  assert.deepEqual(verified.functions.map((entry) => [entry.name, entry.selector]), [
    ["claim", DROP_CLAIM_FUNCTION_SELECTOR],
    ["reclaim", DROP_RECLAIM_FUNCTION_SELECTOR],
  ]);
  assert.deepEqual(body.functions.map((entry) => entry.applicationVkHash), [
    DROP_CLAIM_APPLICATION_VK_HASH,
    DROP_RECLAIM_APPLICATION_VK_HASH,
  ]);
  assert.deepEqual(body.functions.map((entry) => entry.configurationCommitment), [
    drop.configurationCommitment,
    drop.configurationCommitment,
  ]);
  assert.equal(drop.configurationCommitment, poseidon([
    REFERENCE_CONFIGURATION_DOMAIN,
    drop.configuration.configurationSalt,
    0xa55e7n,
    250n,
    7n,
    5_000n,
    creator.address,
    nullifierKeyCommitment(creator.nkRoot),
  ]));
  assert.equal(drop.configurationCommitment, dropConfigurationCommitment(drop.configuration));
  assert.equal(drop.claimEntryCommitment, accountRuleEntryCommitment(DROP_CLAIM_APPLICATION_VK_HASH, drop.configurationCommitment, 0n));
  assert.equal(dropInventorySecret(drop, 3), poseidon([TOKENS_DROP_INVENTORY_DOMAIN, 0xd509n, 3n]));
  assert.equal(dropClaimReplayId(0xabcn, 0x5eedn), poseidon([TOKENS_DROP_CLAIM_REPLAY_DOMAIN, 0xabcn, 0x5eedn]));
  assert.equal(dropClaimReplayId(0n, 0n), poseidon([TOKENS_DROP_CLAIM_REPLAY_DOMAIN, 0n, 0n]));
});

test("drop terms reject values the claim circuit cannot open", () => {
  const terms = dropTermsForCreator({
    dropSeed: 1n,
    assetId: 2n,
    claimAmount: 3n,
    cutoffBlockNumber: 4n,
    claimEndTimestamp: 5n,
    creator: { address: 6n, nkRoot: 7n },
  });
  assert.throws(() => eligibilityDrop({ ...terms, claimAmount: 0n }), /claim amount/);
  assert.throws(() => eligibilityDrop({ ...terms, claimAmount: 1n << 128n }), /claim amount/);
  assert.throws(() => eligibilityDrop({ ...terms, cutoffBlockNumber: 1n << 40n }), /cutoff/);
  assert.throws(() => eligibilityDrop({ ...terms, claimEndTimestamp: 1n << 64n }), /claim end/);
  assert.throws(() => eligibilityDrop({ ...terms, assetId: 0n }), /assetId/);
  assert.throws(() => eligibilityDrop({ ...terms, creator: 1n << 160n }), /creator/);
});

test("drop terms accept a zero seed, creator, and creator key commitment", () => {
  const terms = dropTermsForCreator({
    dropSeed: 0n,
    assetId: 2n,
    claimAmount: 3n,
    cutoffBlockNumber: 4n,
    claimEndTimestamp: 5n,
    creator: { address: 0n, nkRoot: 7n },
  });
  const drop = eligibilityDrop({ ...terms, creatorNullifierKeyCommitment: 0n });
  assert.equal(drop.dropSeed, 0n);
  assert.equal(drop.configuration.creator, 0n);
  assert.equal(drop.configuration.creatorNullifierKeyCommitment, 0n);
});
