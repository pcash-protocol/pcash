import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex } from "viem";
import {
  DEFAULT_NETWORK_CONFIG,
  fieldToHex,
  fullOutputCommitment,
  OutputOpeningMismatchError,
  randomFieldEntropy,
  type ReceiptResult,
  type PcashNodeClient,
} from "@pcash/sdk/browser";
import { applicationSchemaId, encodeAssetDefinition } from "@pcash/sdk/protocol";
import { derivePcashProfileFromPrivateKey, type Wallet } from "@pcash/sdk/wallet";
import {
  claimConfigurationCommitment,
  CLAIM_APPLICATION_VK_HASH,
  RECLAIM_APPLICATION_VK_HASH,
  type OfferTerms,
} from "../src/commitments.mts";
import { createOffer } from "../src/offer.mts";
import {
  parsePublication,
  publicationAssetDefinition,
  publicationEscrowNote,
  publicationFromOffer,
  serializePublication,
  type OfferPublication,
} from "../src/client/publication.ts";
import { escrowPayoutAmount } from "../src/client/networkFee.ts";
import { escrowCommitments } from "../src/client/offerAvailability.ts";
import { purchaseEscrowOutputCommitment } from "../src/client/buy.ts";
import {
  deriveTokenEscrowNoteSecret,
  preflightTokenEscrowFunding,
  recoverTokenEscrow,
  runTokenEscrowFundingFlow,
} from "../src/client/tokenEscrowFunding.ts";
import { marketplacePublicationSourceConfigurationOpenings } from "../src/sourceVerification.ts";
import { deriveVerifiedL2ContractMaterial } from "../src/client/verifiedContractMaterial.ts";
import { testToken } from "./tokenFixtures.ts";

const NETWORK = { ...DEFAULT_NETWORK_CONFIG, pcashChainId: 1346589512n };
const seller = derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(7), NETWORK);
const token = testToken();

function terms(overrides: Partial<OfferTerms> = {}): OfferTerms {
  return {
    router: 0xaan,
    seller: 0xbbn,
    id: 0x0ffe1n,
    assetId: token.assetId,
    amount: 5_000_000n,
    ethPriceWei: 50_000_000_000_000_000n,
    deadlineT: 4_000_000_000n,
    ...overrides,
  };
}

function tokenPublication(overrides: Partial<OfferTerms> = {}, definition: Uint8Array | null = token.bytes): OfferPublication {
  const offer = createOffer({
    network: NETWORK, terms: terms(overrides), sellerWallet: seller, l2ContractNkRoot: randomFieldEntropy(),
    claimApplicationVkHash: CLAIM_APPLICATION_VK_HASH,
    reclaimApplicationVkHash: RECLAIM_APPLICATION_VK_HASH,
  });
  return publicationFromOffer(offer, definition ?? undefined);
}

test("a token listing carries its verified definition through the portable encoding", () => {
  const publication = tokenPublication();
  assert.equal(publication.terms.assetId, fieldToHex(token.assetId));
  assert.equal(publication.assetDefinition, bytesToHex(token.bytes));
  const parsed = parsePublication(serializePublication(publication));
  const definition = publicationAssetDefinition(parsed);
  assert.equal(definition?.metadata.name, "Test Token");
  assert.equal(definition?.metadata.symbol, "TT");
  assert.equal(definition?.metadata.decimals, 6);
  assert.equal(definition?.initialSupply, 1_000_000_000n);
});

test("a native listing carries no definition", () => {
  const publication = tokenPublication({ assetId: 0n }, null);
  assert.equal(publication.assetDefinition, undefined);
  assert.equal(publicationAssetDefinition(parsePublication(serializePublication(publication))), null);
  assert.throws(() => tokenPublication({ assetId: 0n }), /native PCASH listings carry no asset definition/);
});

test("untrusted listings cannot misstate the token they escrow", () => {
  const publication = tokenPublication();
  const other = testToken(2n);
  const reject = (changed: unknown, pattern: RegExp) =>
    assert.throws(() => parsePublication(JSON.stringify(changed)), pattern);
  reject({ ...publication, assetDefinition: undefined }, /missing its asset definition/);
  reject({ ...publication, assetDefinition: bytesToHex(other.bytes) }, /does not derive the listed assetId/);
  reject({ ...publication, assetDefinition: `${bytesToHex(token.bytes)}00` }, /trailing bytes/);
  reject({ ...publication, assetDefinition: "0xzz" }, /canonical byte-aligned hex/);
  reject({ ...publication, terms: { ...publication.terms, assetId: fieldToHex(0n) } }, /carry no asset definition/);
  const renamed = { ...token.definition, metadata: { ...token.definition.metadata, name: "Other Token" } };
  reject({ ...publication, assetDefinition: bytesToHex(encodeAssetDefinition(renamed)) }, /does not derive the listed assetId/);
  reject({ ...publication, assetDefinition: bytesToHex(Uint8Array.from([2, ...token.bytes.slice(1)])) }, /unknown asset definition version/);
});

test("the claim configuration and escrow commitments bind the escrowed asset", () => {
  const native = terms({ assetId: 0n });
  assert.notEqual(claimConfigurationCommitment(1n, terms()), claimConfigurationCommitment(1n, native));
  const publication: OfferPublication = { ...tokenPublication(), escrow: { leafIndex: 4, noteSecret: fieldToHex(9n), amount: fieldToHex(5_000_000n) } };
  const note = publicationEscrowNote(publication, deriveVerifiedL2ContractMaterial(publication));
  assert.equal(note.assetId, token.assetId);
  const expected = fullOutputCommitment(note, 4);
  assert.equal(escrowCommitments(publication, publication.escrow!).leaf, expected);
  assert.equal(purchaseEscrowOutputCommitment(publication), expected);
  assert.notEqual(purchaseEscrowOutputCommitment({ ...publication, terms: { ...publication.terms, assetId: fieldToHex(0n) } }), expected);
});

test("source openings disclose the escrowed asset", () => {
  const openings = marketplacePublicationSourceConfigurationOpenings(tokenPublication(), NETWORK);
  assert.equal(BigInt(openings[0]!.values[4]!), token.assetId);
  assert.equal(BigInt(openings[0]!.values[5]!), 5_000_000n);
});

test("a native escrow funds the network fee and a token escrow pays out in full", () => {
  assert.equal(escrowPayoutAmount(0n, 100n, 10n), 90n);
  assert.throws(() => escrowPayoutAmount(0n, 100n, 100n), /must be less than transfer amount/);
  assert.equal(escrowPayoutAmount(token.assetId, 100n, 10n), 100n);
  assert.equal(escrowPayoutAmount(token.assetId, 100n, 1_000n), 100n);
  assert.throws(() => escrowPayoutAmount(token.assetId, 100n, -1n), /nonnegative/);
});

test("the token escrow secret is recomputed from the seller and offer, and differs per offer", () => {
  const input = { seller, chainId: NETWORK.pcashChainId, offerId: 0x1234n, contractAddress: 0xabcdn };
  const secret = deriveTokenEscrowNoteSecret(input);
  assert.equal(deriveTokenEscrowNoteSecret(input), secret);
  assert.notEqual(deriveTokenEscrowNoteSecret({ ...input, offerId: 0x1235n }), secret);
  assert.notEqual(deriveTokenEscrowNoteSecret({ ...input, contractAddress: 0xabcen }), secret);
  const other = derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(8), NETWORK);
  assert.notEqual(deriveTokenEscrowNoteSecret({ ...input, seller: other }), secret);
});

test("token escrow recovery opens the funded note at the receipt's first output leaf", async () => {
  const note = { owner: 0x77n, assetId: token.assetId, amount: 5_000_000n, noteSecret: 0x99n };
  const receipt = { contentHash: "0x01", outputLeafStart: 40n } as ReceiptResult;
  const node = (fundedLeaf: bigint | null) => ({
    getOutputPath: async (index: bigint | number, commitment: bigint) => {
      if (BigInt(index) >= 45n) return null;
      if (BigInt(index) !== fundedLeaf || commitment !== fullOutputCommitment(note, fundedLeaf)) {
        throw new OutputOpeningMismatchError("output path mismatch");
      }
      return {} as never;
    },
  });
  assert.deepEqual(await recoverTokenEscrow(node(40n), receipt, note), {
    leafIndex: 40, noteSecret: fieldToHex(0x99n), amount: fieldToHex(5_000_000n),
  });
  await assert.rejects(recoverTokenEscrow(node(41n), receipt, note), /did not create the 5000000 token escrow/);
  await assert.rejects(recoverTokenEscrow(node(40n), receipt, { ...note, assetId: 0n }), /did not create/);
  await assert.rejects(recoverTokenEscrow(node(40n), { ...receipt, outputLeafStart: 45n }, note), /did not create/);
});

test("token escrow funding is one wallet asset send opening output slot 0 to the contract", async () => {
  const intents: Record<string, unknown>[] = [];
  const events: string[] = [];
  const node = { status: async () => ({ latestBlockTimestamp: 1_000n }) } as unknown as PcashNodeClient;
  const wallet = {
    sendAsset: async (intent: Record<string, unknown>) => {
      intents.push(intent);
      await (intent.beforeJournal as () => Promise<void>)();
      await (intent.onPrepared as (contentHash: string, transactionHex: string) => Promise<void>)(`0x${"12".repeat(32)}`, "0x34");
      return { contentHash: `0x${"12".repeat(32)}`, queued: true, submission: intents.length === 3 ? { l1Hash: "0x56" } : null };
    },
  } as unknown as Wallet;
  const params = {
    wallet, node, assetId: token.assetId, to: "contract-code", amount: 5n, noteSecret: 0x99n, data: { self: [{ schema: applicationSchemaId("com.example.record009"), data: Uint8Array.of(1, 2) }] }, openFeeAmount: 3n,
    validUntilTimestamp: 1_300n,
    beforeSubmit: () => { events.push("before journal"); },
    onPreparedContentHash: () => { events.push("prepared"); },
  };
  assert.deepEqual(await runTokenEscrowFundingFlow(params), { contentHash: `0x${"12".repeat(32)}`, queued: true });
  assert.deepEqual(events, ["before journal", "prepared"]);
  assert.equal(intents[0]!.assetId, token.assetId);
  assert.deepEqual(intents[0]!.outputs, [{ to: "contract-code", amount: 5n, noteSecret: 0x99n }]);
  assert.deepEqual(intents[0]!.data, params.data);
  assert.equal(intents[0]!.openFeeAmount, 3n);
  assert.equal(intents[0]!.validUntilTimestamp, 1_300n);
  assert.equal((intents[0]!.submission as { mode: string }).mode, "mempool");

  // A later offer deadline is capped at the wallet's normal window.
  await runTokenEscrowFundingFlow({ ...params, validUntilTimestamp: 1_000_000n });
  assert.equal(intents[1]!.validUntilTimestamp, 1_000n + 1_800n);

  // Without a fee the wallet's configured transport publishes it; an Ethereum broadcast is not queued.
  assert.equal((await runTokenEscrowFundingFlow({ ...params, openFeeAmount: 0n })).queued, false);
  assert.equal(intents[2]!.submission, undefined);
});

test("token escrow preflight requires the spendable token and PCASH notes for the fees", async () => {
  const preflights: Record<string, unknown>[] = [];
  const wallet = (spendable: bigint) => ({
    assets: async () => [{ assetId: token.assetId, definition: token.definition, private: spendable, spendable, created: false }],
    preflightSend: async (intent: Record<string, unknown>) => { preflights.push(intent); return { inputCount: 1, inputTotal: 10n }; },
  } as unknown as Wallet);
  const params = { assetId: token.assetId, amount: 5n, openFeeAmount: 6n, validUntilTimestamp: 1_300n };
  await assert.rejects(preflightTokenEscrowFunding({ ...params, wallet: wallet(4n) }), /needs 5 of this token, but this wallet can spend 4/);
  await assert.rejects(preflightTokenEscrowFunding({ ...params, assetId: 7n, wallet: wallet(5n) }), /can spend 0/);
  assert.equal(preflights.length, 0);
  await preflightTokenEscrowFunding({ ...params, wallet: wallet(5n) });
  assert.deepEqual(preflights, [{ amount: 0n, openFeeAmount: 6n, validUntilMode: "ceiling", validUntilTimestamp: 1_300n }]);
});
