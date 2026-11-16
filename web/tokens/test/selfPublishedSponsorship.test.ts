// A self-published token claim at a positive network fee, through claimLink
// and the wallet's real contract-sponsorship handler. Only the proof and the
// Ethereum submission are stubbed.

import assert from "node:assert/strict";
import test from "node:test";
import {
  baseFee,
  decodeTransaction,
  fullOutputCommitment,
  networkForChain,
  noteBodyCommitment,
  ownerCommitment,
  privateValueUnits,
  quoteNetworkFee,
  receiveKeyHash,
  sectionPublicInput,
  TX_KIND_PRIVATE_VALUE,
  WIRE_PROOF_BYTES,
} from "@pcash/sdk/protocol";
import { fieldToHex } from "@pcash/sdk/crypto";
import { privateValueProfile } from "@pcash/sdk/constants";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import { addressHex, bytes32Hex, toHex } from "@pcash/sdk/utils";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import { runSponsoredContractAssetActionClient, type SponsoredContractAssetActionIntent } from "@pcash/sdk/wallet/actions";
import type { StatusResult, WitnessSnapshotQuery } from "@pcash/sdk/clients";
import { claimLink } from "../src/client/links.ts";
import type { TokensRuntime } from "../src/client/runtime.ts";
import { formatClaimLinkUrl, planClaimLinks, type ClaimLink } from "../src/link.ts";
import { CHAIN_ID, SyntheticChain } from "./chain.ts";
import { testToken } from "./wallets.ts";

const NETWORK = networkForChain(CHAIN_ID);
const GENESIS_HASH = `0x${"11".repeat(32)}`;
const KEY = new Uint8Array(32).fill(41);
const profile = derivePcashProfileFromPrivateKey(KEY, NETWORK);
const signer = privateKeyPcashActionSigner(KEY);
// A required fee, about 10^9 per state unit, and a fee note that pays it.
const FEE_EXCESS = 1_400_000n;
const FEE_NOTE = 10n ** 12n;
const FEE_SECRET = 0xfee1n;

test("a self-published token link claim pays a positive network fee from the wallet's PCASH through its sponsorship", async () => {
  const { definition, assetId } = testToken(5n);
  const planned = planClaimLinks({ creatorSecret: 5n, assetId, amounts: [100n] });
  const link: ClaimLink = { contractSeed: planned.contract.contractSeed,
    funding: { contentHash: bytes32Hex(92n), slot: 0 }, amount: 100n, linkKey: planned.links[0]!.linkKey, definition };
  const chain = new SyntheticChain();
  chain.addContract(planned.contract);
  const rules = defaultUserAccountRuleSet({ wallet: profile, network: NETWORK, secrets: profile.defaultUserRuleSecrets });
  chain.addAccount({ address: profile.address, nullifierKeyCommitment: profile.nullifierKeyCommitment,
    accountRuleSetCommitment: rules.accountRuleSetCommitment, kind: 0n, receiveKey: profile.mlKemPublicKey });
  chain.appendBody(noteBodyCommitment(ownerCommitment(planned.contract.address, planned.links[0]!.noteSecret), assetId, 100n));
  const feeLeaf = chain.appendBody(noteBodyCommitment(ownerCommitment(profile.address, FEE_SECRET), 0n, FEE_NOTE));
  const head = chain.seal();

  const status = {
    pcashChainId: Number(CHAIN_ID), genesisHash: GENESIS_HASH, l1ChainId: NETWORK.l1ChainId,
    inboxAddress: addressHex(NETWORK.inboxAddress), acceptedTransactionTypes: [0, 1, 2, 3], acceptedBatchVersions: [1],
    latestBlock: head.header.number, latestBlockHash: fieldToHex(head.hash), latestBlockTimestamp: chain.timestamp,
    finalizedBlock: head.header.number, finalizedBlockTimestamp: chain.timestamp,
    feeExcess: FEE_EXCESS, baseFee: baseFee(FEE_EXCESS),
  } as unknown as StatusResult;
  const base = chain.node();
  const node = {
    ...base,
    status: async () => status,
    getWitnessSnapshot: async (query: WitnessSnapshotQuery) => ({ ...await base.getWitnessSnapshot(query), status }),
    // The link's funding and the claim itself are accepted.
    getReceipt: async () => [{ outcome: "succeeded", outputLeafStart: 0n, kind: "privateValue" }],
    getMempoolTransaction: async () => null,
  };

  const boundary = { state: head.state, header: head.header, blockHash: head.hash };
  const proofOf = (address: string) => (chain as unknown as { accountProof(address: bigint, block: unknown): unknown }).accountProof(BigInt(address), head);
  const syncedChain = {
    synced: { pcashNumber: head.header.number, pcashHash: fieldToHex(head.hash) },
    requireAnchor: () => boundary,
    accountProof: proofOf,
    outputPaths: (requested: readonly { outputIndex: bigint | number }[]) => ({
      root: fieldToHex(head.state.outputRoot), count: head.state.outputCount, boundary,
      paths: requested.map(({ outputIndex }) => ({ outputIndex: BigInt(outputIndex), siblings: chain.outputSiblings(Number(outputIndex)) })),
    }),
    consumption: (nullifiers: readonly string[]) => nullifiers.map(() => null),
  };
  let data: Record<string, unknown> = {
    version: 1,
    address: addressHex(profile.address),
    network: { chainId: CHAIN_ID.toString(), genesisHash: GENESIS_HASH },
    receiveKeys: [{ receiveKeyHash: bytes32Hex(receiveKeyHash(profile.mlKemPublicKey)),
      mlKemPublicKey: toHex(profile.mlKemPublicKey), mlKemSecretKey: toHex(profile.mlKemSecretKey) }],
    notes: [{
      leafIndex: String(feeLeaf), outputIndex: feeLeaf, assetId: "0x0", amount: FEE_NOTE.toString(),
      owner: addressHex(profile.address), noteSecret: bytes32Hex(FEE_SECRET),
      commitment: bytes32Hex(fullOutputCommitment({ owner: profile.address, noteSecret: FEE_SECRET, assetId: 0n, amount: FEE_NOTE }, feeLeaf)),
      spent: false, pending: false,
    }],
  };
  const store = {
    identity: { address: profile.address, network: { chainId: CHAIN_ID.toString(), genesisHash: GENESIS_HASH } },
    load: async () => structuredClone(data),
    readChain: async <T,>(read: (loaded: never) => T | Promise<T>) => read(syncedChain as never),
    save: async (next: unknown) => {
      data = { ...structuredClone(next) as Record<string, unknown>, resourceReservations: data.resourceReservations };
      if (data.resourceReservations === undefined) delete data.resourceReservations;
    },
    transaction: async (operation: (current: unknown) => { data: unknown; value: unknown }) => {
      const commit = operation(structuredClone(data));
      data = structuredClone(commit.data) as Record<string, unknown>;
      return commit.value;
    },
  };

  const posted: Uint8Array[] = [];
  const submission = {
    mode: "l1" as const,
    preflight: async () => "prepared",
    submit: async ({ transactionBytes }: { transactionBytes: Uint8Array }) => {
      posted.push(transactionBytes);
      return { accepted: false, queued: true, output: {} };
    },
  };
  const statements: string[] = [];
  const recordingSigner = {
    address: signer.address,
    signTypedData: async (request: Parameters<typeof signer.signTypedData>[0]) => {
      statements.push(request.typedData.primaryType);
      return signer.signTypedData(request);
    },
  };
  const ctx = { profile, node, network: { chainId: CHAIN_ID }, status, store, spendable: () => true, signer: recordingSigner };
  const rt = {
    node,
    submission,
    prover: { proveAssetAction: async () => ({ proof: new Uint8Array(WIRE_PROOF_BYTES) }) },
    pollIntervalMs: 0,
    pollMaxAttempts: 1,
    wallet: {
      address: addressHex(profile.address),
      network: { chainId: CHAIN_ID },
      execute: async (action: (context: unknown) => unknown) => action(ctx),
      importAssetDefinition: async () => undefined,
      sponsorContractAction: (intent: SponsoredContractAssetActionIntent & { submission?: typeof submission }) =>
        runSponsoredContractAssetActionClient({
          ...intent, node: node as never, store: store as never, wallet: profile, signer: recordingSigner, chainId: CHAIN_ID,
          submission: intent.submission!, settlePollMaxAttempts: 1,
        }),
    },
  } as unknown as TokensRuntime;

  const result = await claimLink(rt, formatClaimLinkUrl(link, "https://example.test/claim"));

  assert.equal(result.role, "sponsored");
  assert.equal(posted.length, 1);
  const decoded = decodeTransaction(posted[0]!);
  if (decoded.kind !== TX_KIND_PRIVATE_VALUE) throw new Error("expected a private-value transaction");
  const { offsets } = privateValueProfile(decoded.shape);
  const burn = quoteNetworkFee(FEE_EXCESS, privateValueUnits(4, false));
  assert.ok(burn > 0n);
  assert.equal(sectionPublicInput(decoded, offsets.openFeeAmount), 0n);
  assert.equal(sectionPublicInput(decoded, offsets.nativeBurnAmount), burn);
  // Self-publication designates the action's issuance to the wallet.
  assert.notEqual(sectionPublicInput(decoded, offsets.issuanceOwner), 0n);
  assert.deepEqual(statements, ["PcashContractInteractionWithBurn"]);
  const pending = (data.pendingAssetActions as { nativeBurnAmount: string; inputs: { spentCommitment: string | null }[] }[]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.nativeBurnAmount, burn.toString());
  assert.equal(pending[0]!.inputs.filter((input) => input.spentCommitment !== null).length, 1);
});
