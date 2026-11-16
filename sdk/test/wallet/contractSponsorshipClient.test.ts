import {
  generateMlKemKeyPair, decryptEnvelope, decodePayload, issuancePayoutOpening, noteNk, nullifier,
  privateValueUnits, quoteNetworkFee,
} from "@pcash/sdk/protocol";
import { storedReceiveKeyPair } from "../../src/wallet/receiveKeyring.ts";
import { testStatus } from "./statusFixture.ts";
import { describe, expect, it } from "vitest";
import { fieldToHex } from "@pcash/sdk/crypto";
import { receiveKeyHash } from "@pcash/sdk/protocol";
import { createSelectedRelayQuote, privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import { WalletConflictError } from "../../src/wallet/store.ts";
import { addressHex, toHex } from "@pcash/sdk/utils";
import { derivePcashProfileFromPrivateKey } from "../../src/wallet/externalIdentity.ts";
import {
  accountStateCommitment,
  buildContractBody,
  computeCircuitVkHash,
  VK_LEN,
  decodeContractBody,
  assetSecretCommitment,
  fullOutputCommitment,
  functionSelector,
  noteBodyCommitment,
  ownerCommitment,
  WIRE_PROOF_BYTES,
  SlotClass,
  standardFungibleAssetId,
} from "@pcash/sdk/protocol";
import { contractFunctionAuthorization, openedAssetActionOutput } from "@pcash/sdk/builders";
import { SparseMerkleTree } from "@pcash/sdk/crypto";
import type { AssetActionProofRequest } from "@pcash/sdk/browser-prover/requests";
import type { PcashNodeClient, StatusResult, WitnessSnapshotQuery } from "@pcash/sdk/clients";
import type { WalletFileData } from "../../src/wallet/noteStore.ts";
import { MERKLE_DEPTH } from "@pcash/sdk/constants";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import { createWalletRuntime } from "../../src/wallet/actions/walletRuntime.ts";
import {
  runSponsoredContractAssetActionClient,
  type SponsoredContractAssetActionIntent,
} from "../../src/wallet/actions/contractSponsorshipClient.ts";
import { syntheticRecentBlockFixture } from "./builderTestHelpers.ts";
import { anchoredChain, syncStoreTo } from "./chainFixture.ts";

const CHAIN_ID = 1_346_589_512n;
const GENESIS_HASH = `0x${"11".repeat(32)}`;
const PRIVATE_KEY = Uint8Array.from(
  Buffer.from("2233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011", "hex"),
);
const NETWORK = {
  pcashChainId: CHAIN_ID,
  l1ChainId: 11_155_111n,
  inboxAddress: `0x${"66".repeat(20)}`,
};
const wallet = derivePcashProfileFromPrivateKey(PRIVATE_KEY, NETWORK);
const signer = privateKeyPcashActionSigner(PRIVATE_KEY);
const rules = defaultUserAccountRuleSet({
  wallet,
  network: NETWORK,
  secrets: wallet.defaultUserRuleSecrets,
});
const recipient = derivePcashProfileFromPrivateKey(new Uint8Array(32).fill(9), NETWORK);

const hex = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;
const addressOf = (value: bigint): string => `0x${value.toString(16).padStart(40, "0")}`;

const assetId = standardFungibleAssetId({
  metadataCommitment: 222n, initialSupply: 2_000n,
  assetSecretCommitment: assetSecretCommitment(333n),
});
const contract = buildContractBody({
  nullifierKey: { publishesNkRoot: true, nkRoot: 0x5151n },
  functions: [{ selector: functionSelector(0), applicationVkHash: 0x1234n, configurationCommitment: 0x5678n }],
});
const escrowSecret = 0x4444n;
const escrowAmount = 1_000n;
const escrowCommitment = fullOutputCommitment({ owner: contract.address, noteSecret: escrowSecret, assetId, amount: escrowAmount }, 0);
const feeSecret = 0x9911n;
// Large enough to pay a burn above the waiver, about 10^9 per state unit.
const feeAmount = 50_000_000_000n;
const openFeeAmount = 250n;
const feeCommitment = fullOutputCommitment({ owner: wallet.address, noteSecret: feeSecret, assetId: 0n, amount: feeAmount }, 1);
const noteTree = new SparseMerkleTree(MERKLE_DEPTH);
noteTree.setLeaf(0, escrowCommitment);
noteTree.setLeaf(1, feeCommitment);
const accountTree = new SparseMerkleTree(MERKLE_DEPTH);
accountTree.setLeaf(0, contract.accountStateCommitment);
accountTree.setLeaf(1, accountStateCommitment(
  wallet.address, wallet.nullifierKeyCommitment, rules.accountRuleSetCommitment, 0n, 1n, receiveKeyHash(wallet.mlKemPublicKey),
));
const recentBlock = syntheticRecentBlockFixture({
  outputRoot: noteTree.root,
  outputCount: 2,
  accountStateRoot: accountTree.root,
  accountCount: 2,
  blockNumber: 10n,
  timestamp: 1_800_000_000n,
});
const boundary = recentBlock.boundary;
const status: StatusResult = testStatus({
  latestBlock: 10n,
  latestBlockHash: hex(boundary.blockHash),
  latestBlockTimestamp: 1_800_000_000n,
  pcashChainId: Number(CHAIN_ID),
  genesisHash: GENESIS_HASH,
  acceptedTransactionTypes: [0, 2],
  l1ChainId: NETWORK.l1ChainId,
  inboxAddress: NETWORK.inboxAddress,
});
const fakeVk = (seed: number) => {
  const vkFields = Array.from({ length: VK_LEN }, (_, index) => `0x${BigInt(index + seed).toString(16)}`);
  return { vkFields, vkHash: hex(computeCircuitVkHash(vkFields)) };
};

/** The wallet's local chain, synced through the same block the node serves. */
const localChain = (receiveKey = wallet.mlKemPublicKey) => anchoredChain({
  outputs: [{ leaf: escrowCommitment }, { leaf: feeCommitment, mark: true }],
  accounts: [
    { address: addressOf(contract.address), nullifierKeyCommitment: contract.nullifierKeyCommitment,
      accountRuleSetCommitment: contract.functionSetCommitment, accountKind: 1 },
    { address: addressOf(wallet.address), nullifierKeyCommitment: wallet.nullifierKeyCommitment,
      accountRuleSetCommitment: rules.accountRuleSetCommitment, receiveKey },
  ],
  blockNumber: 10n,
  timestamp: 1_800_000_000n,
});

function walletData(): WalletFileData {
  return {
    address: addressHex(wallet.address),
    network: { chainId: CHAIN_ID.toString(), genesisHash: GENESIS_HASH },
    receiveKeys: [storedReceiveKeyPair({ publicKey: wallet.mlKemPublicKey, secretKey: wallet.mlKemSecretKey })],
    notes: [{
      leafIndex: "1",
      outputIndex: 1,
      assetId: "0x0",
      amount: feeAmount.toString(),
      owner: addressHex(wallet.address),
      noteSecret: hex(feeSecret),
      commitment: hex(feeCommitment),
      spent: false,
      pending: false,
    }],
  };
}

function walletStore(receiveKey = wallet.mlKemPublicKey) {
  return memoryWalletStateStore(walletData(), localChain(receiveKey).records);
}

/** The node's snapshot of the contract and the application's reads, recording each query. */
function node(receiveKey = wallet.mlKemPublicKey, queries: WitnessSnapshotQuery[] = [], nodeStatus: StatusResult = status): PcashNodeClient {
  const accountTree = new SparseMerkleTree(MERKLE_DEPTH);
  accountTree.setLeaf(0, contract.accountStateCommitment);
  accountTree.setLeaf(1, accountStateCommitment(
    wallet.address, wallet.nullifierKeyCommitment, rules.accountRuleSetCommitment, 0n, 1n, receiveKeyHash(receiveKey),
  ));
  const recentBlock = syntheticRecentBlockFixture({
    outputRoot: noteTree.root, outputCount: 2, accountStateRoot: accountTree.root,
    accountCount: 2, blockNumber: 10n, timestamp: 1_800_000_000n,
  });
  const boundary = recentBlock.boundary;
  const common = {
    accountStateRoot: accountTree.root,
    accountCount: 2n,
    stateRootHeaderSiblings: recentBlock.stateRootHeaderSiblings,
    accountStateRootStateSiblings: recentBlock.accountStateRootStateSiblings,
    boundary,
  };
  const accountProof = (address: string) => BigInt(address) === contract.address
    ? { ...common, status: "present" as const, accountSiblings: accountTree.proof(0).siblings, account: {
      address, index: 0n, accountRevision: 1n, accountKind: 1, receiveKeyHash: hex(0n),
    } }
    : { ...common, status: "present" as const, accountSiblings: accountTree.proof(1).siblings, account: {
      address, index: 1n, accountRevision: 1n,
      nullifierKeyCommitment: hex(wallet.nullifierKeyCommitment),
      accountRuleSetCommitment: hex(rules.accountRuleSetCommitment),
      accountKind: 0, receiveKeyHash: fieldToHex(receiveKeyHash(receiveKey)),
      material: { status: "available" as const, mlKem768PublicKey: toHex(receiveKey) },
    } };
  let retained: Record<string, unknown> | null = null;
  const client = {
    status: async () => nodeStatus,
    getWitnessSnapshot: async (query: WitnessSnapshotQuery = {}) => (queries.push(query), {
      status: nodeStatus,
      accounts: (query.accounts ?? []).map(accountProof),
      outputs: (query.outputs ?? []).length === 0 ? null : {
        root: noteTree.root,
        paths: query.outputs!.map((request) => ({
          leafIndex: BigInt(request.outputIndex), siblings: noteTree.proof(Number(request.outputIndex)).siblings,
        })),
        boundary,
      },
      nullifiers: {
        statuses: (query.nullifiers ?? []).map((nullifier) => ({ nullifier, spent: false })),
        boundary: (query.nullifiers ?? []).length === 0 ? null : boundary,
      },
      block: null,
      blockHeader: { recentPcashBlockHash: boundary.blockHash, boundary },
      contracts: [],
      l1Logs: [],
    }),
    getReceipt: async () => [],
    getMempoolTransaction: async () => retained,
  } as unknown as PcashNodeClient;
  return Object.assign(client, { retain: (value: Record<string, unknown>) => { retained = value; } });
}

function submission() {
  return {
    mode: "mempool" as const,
    preflight: async () => "prepared",
    submit: async ({  }: {  }) => ({ accepted: false, queued: true, output: "queued" }),
  };
}

interface Observed {
  witnessBuild?: import("@pcash/sdk/builders").AssetActionBuild;
  proof?: Extract<AssetActionProofRequest, { operation: "sponsored-transfer" }>;
  kernelWitness?: Record<string, unknown>;
}

function intent(observed: Observed, overrides: Partial<SponsoredContractAssetActionIntent> = {}): SponsoredContractAssetActionIntent {
  return {
    contract: contract.address,
    reservedInputSlots: [0],
    reservedOutputSlots: [0],
    snapshotQuery: { outputs: [{ outputIndex: 0, outputCommitment: escrowCommitment }] },
    primary: (context) => {
      expect(context.outputPaths).toHaveLength(1);
      expect(context.contractAccount.account.index).toBe(0n);
      return {
        authorization: contractFunctionAuthorization({
          contract: decodeContractBody(contract.body), selector: functionSelector(0), accountIndex: 0,
          accountSiblings: context.contractAccount.accountSiblings,
        }),
        assetId,
        inputs: [{ slot: 0, input: {
          kind: "asset", amount: escrowAmount, noteSecret: escrowSecret, leafIndex: 0,
          siblings: context.outputPaths[0]!.siblings.map(BigInt),
        } }],
        realizeOutputs: () => ({
          outputs: [{ slot: 0, output: openedAssetActionOutput({
            kind: "asset", pcashChainId: CHAIN_ID, assetId, outputIndex: 0, noteSecret: 0x777n, amount: escrowAmount,
            recipientAddress: recipient.address, recipientMlKemPublicKey: recipient.mlKemPublicKey, authenticatedRecipient: true,
          }) }],
          ownedOutputs: [],
        }),
        circuitUrl: "/prover/contracts/example/claim.json",
        label: "example function",
        witness: (build) => {
          observed.witnessBuild = build;
          return { private_value_commitment: hex(build.privateValueCommitment) };
        },
      };
    },
    prover: {
      proveAssetAction: async (args) => {
        if (args.operation !== "sponsored-transfer") throw new Error("expected a sponsored transfer");
        observed.proof = args;
        observed.kernelWitness = args.buildKernelWitnessMap(fakeVk(1), fakeVk(2));
        return { proof: new Uint8Array(WIRE_PROOF_BYTES), publicInputs: args.expectedPublicInputs.map((value) => hex(value)) };
      },
    },
    openFeeAmount,
    ...overrides,
  };
}

describe("sponsored contract asset action", () => {
  it("encrypts sponsorship change to the registered independent key", async () => {
    const rotated = generateMlKemKeyPair(new Uint8Array(64).fill(41));
    const store = walletStore(rotated.publicKey);
    await store.transaction(data => {
      data!.receiveKeys.push(storedReceiveKeyPair(rotated));
      return { data: data!, value: undefined };
    });
    const result = await runSponsoredContractAssetActionClient({
      ...intent({}), node: node(rotated.publicKey), store, wallet, signer, chainId: CHAIN_ID,
      submission: submission(), settlePollMaxAttempts: 1,
    });
    expect(decryptEnvelope(wallet.mlKemSecretKey, result.build.outputData[1]!)).toBeNull();
    const payload = decodePayload(decryptEnvelope(rotated.secretKey, result.build.outputData[1]!)!, { chainId: CHAIN_ID });
    expect(payload.amount).toBe(feeAmount - openFeeAmount);
  });

  it("funds the open fee from the sponsor's notes and journals only its own spend and change", async () => {
    const store = walletStore();
    const observed: Observed = {};
    const result = await runSponsoredContractAssetActionClient({
      ...intent(observed),
      node: node(), store, wallet, signer, chainId: CHAIN_ID, submission: submission(),
      settlePollMaxAttempts: 1,
    });

    const build = result.build;
    expect(build.transaction.inputs.map((input) => input.slotClass)).toEqual([
      SlotClass.ASSET, SlotClass.NATIVE, SlotClass.DUMMY, SlotClass.DUMMY,
    ]);
    expect(build.transaction.outputs.map((output) => output.slotClass)).toEqual([
      SlotClass.ASSET, SlotClass.NATIVE, SlotClass.DUMMY, SlotClass.DUMMY, SlotClass.DUMMY,
    ]);
    expect(build.transaction.global.openFeeAmount).toBe(openFeeAmount);
    expect(result.changeAmount).toBe(feeAmount - openFeeAmount);
    expect(BigInt(build.transaction.outputs[1]!.outputBodyCommitment)).toBe(noteBodyCommitment(
      ownerCommitment(wallet.address, BigInt(store.snapshot()!.pendingAssetActions![0]!.ownedOutputs[0]!.noteSecret)),
      0n, feeAmount - openFeeAmount,
    ));
    expect(observed.witnessBuild?.privateValueCommitment).toBe(build.privateValueCommitment);
    expect(observed.proof?.primary.circuitUrl).toBe("/prover/contracts/example/claim.json");
    expect(observed.proof?.feePayer.circuitUrl).toBe("/prover/account_rule_contract_fee_sponsorship_ecdsa.json");
    expect(observed.proof?.expectedPublicInputs).toEqual(build.publicInputs);
    expect(observed.kernelWitness?.primary_statement).toBeDefined();

    const pending = store.snapshot()!.pendingAssetActions!;
    expect(pending).toHaveLength(1);
    expect(BigInt(pending[0]!.owner!)).toBe(wallet.address);
    expect(BigInt(pending[0]!.assetId)).toBe(0n);
    expect(pending[0]!.inputs.map((input) => input.spentCommitment === null ? null : BigInt(input.spentCommitment)))
      .toEqual([null, feeCommitment, null, null]);
    expect(pending[0]!.ownedOutputs).toHaveLength(1);
    expect(pending[0]!.ownedOutputs[0]!.outputIndex).toBe(1);
  });

  it("names neither the sponsor nor its fee notes to the node", async () => {
    const queries: WitnessSnapshotQuery[] = [];
    const result = await runSponsoredContractAssetActionClient({
      ...intent({}), node: node(wallet.mlKemPublicKey, queries), store: walletStore(), wallet, signer, chainId: CHAIN_ID,
      submission: submission(), settlePollMaxAttempts: 1,
    });
    expect(result.build.transaction.inputs[1]!.slotClass).toBe(SlotClass.NATIVE);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.accounts).toEqual([addressOf(contract.address)]);
    expect(queries[0]!.outputs!.map((output) => BigInt(output.outputIndex))).toEqual([0n]);
  });

  it("synchronizes once when the local chain is not at the node's snapshot, then refuses", async () => {
    // The node's snapshot follows a receive-key rotation the local chain has not synced.
    const rotated = generateMlKemKeyPair(new Uint8Array(64).fill(42));
    const behindStore = async () => {
      const store = walletStore();
      await store.transaction(data => {
        data!.receiveKeys.push(storedReceiveKeyPair(rotated));
        return { data: data!, value: undefined };
      });
      return store;
    };
    let synchronized = 0;
    const store = await behindStore();
    const result = await runSponsoredContractAssetActionClient({
      ...intent({}), node: node(rotated.publicKey), store, wallet, signer, chainId: CHAIN_ID, submission: submission(),
      settlePollMaxAttempts: 1,
      // The follow loop holds the sync lease first; the action waits it out.
      synchronize: async () => {
        synchronized += 1;
        if (synchronized === 1) throw new WalletConflictError("reserved", ["wallet:sync"]);
        await syncStoreTo(store, localChain(rotated.publicKey).records);
      },
    });
    expect(synchronized).toBe(2);
    expect(result.build.transaction.inputs[1]!.slotClass).toBe(SlotClass.NATIVE);

    const stale = await behindStore();
    await expect(runSponsoredContractAssetActionClient({
      ...intent({}), node: node(rotated.publicKey), store: stale, wallet, signer, chainId: CHAIN_ID, submission: submission(),
      synchronize: async () => { synchronized += 1; },
    })).rejects.toThrow(/differs from the sponsored action's snapshot/);
    expect(synchronized).toBe(3);
    expect(stale.snapshot()!.pendingAssetActions ?? []).toHaveLength(0);
  });

  it("builds recipient outputs from final input nullifiers and journals a wallet-owned token payout", async () => {
    const store = walletStore();
    const observed: Observed = {};
    const base = intent(observed);
    let outputNullifiers: readonly bigint[] = [];
    let ownedNullifiers: readonly bigint[] = [];
    let realizations = 0;
    const result = await runSponsoredContractAssetActionClient({
      ...base,
      claimLinkRecipient: wallet.address,
      snapshotQuery: { ...base.snapshotQuery, accounts: [addressOf(wallet.address)], nullifiers: [hex(123n)] },
      primary: async (context) => {
        expect(context.snapshot.accounts).toHaveLength(2);
        expect(context.snapshot.nullifiers.statuses).toHaveLength(1);
        const side = await base.primary(context);
        return {
          ...side,
          realizeOutputs: (nullifiers: readonly bigint[]) => {
            realizations += 1;
            outputNullifiers = nullifiers;
            ownedNullifiers = nullifiers;
            return {
              outputs: [{ slot: 0, output: openedAssetActionOutput({
                kind: "asset", pcashChainId: CHAIN_ID, assetId, outputIndex: 0,
                noteSecret: nullifiers[0]!, amount: escrowAmount,
                recipientAddress: wallet.address, recipientMlKemPublicKey: wallet.mlKemPublicKey, authenticatedRecipient: true,
              }) }],
              ownedOutputs: [{ slot: 0, noteSecret: nullifiers[0]! }],
            };
          },
        };
      },
      node: node(), store, wallet, signer, chainId: CHAIN_ID, submission: submission(), settlePollMaxAttempts: 1,
    });
    const actual = result.build.transaction.inputs.map((input) => BigInt(input.nullifier));
    expect(realizations).toBe(1);
    expect(outputNullifiers).toEqual(actual);
    expect(ownedNullifiers).toEqual(actual);
    expect(store.snapshot()!.pendingAssetActions![0]!.ownedOutputs.map((entry) => [entry.outputIndex, BigInt(entry.assetId)]))
      .toEqual([[0, assetId], [1, 0n]]);
    expect(store.snapshot()!.pendingAssetActions![0]!.claimLinkRecipient).toBe(addressOf(wallet.address));
  });

  it("pays a selected relay from the last output slot and hands the designated opening to the contract's witness", async () => {
    const relaySigner = privateKeyPcashActionSigner(new Uint8Array(32).fill(63));
    const store = walletStore();
    const observed: Observed = {};
    let issuance: unknown;
    const base = intent(observed);
    const runtime = createWalletRuntime({ node: node(), store, wallet, signer, chainId: CHAIN_ID,
      submission: submission(), settlePollMaxAttempts: 1 });
    const result = await runtime.contractSponsorship({
      ...base,
      openFeeAmount: 0n,
      privateRelayFeeAmount: 40n,
      selectedRelayQuote: { recipient: relaySigner.address, requestQuote: async (request) =>
        createSelectedRelayQuote({ ...request, network: NETWORK, nkRoot: 123n, receiveKey: recipient.mlKemPublicKey, signer: relaySigner }) },
      primary: async (context) => {
        const primary = await base.primary(context);
        return { ...primary, witness: (build, opening) => { issuance = opening.designatedIssuanceOpening; return primary.witness(build, opening); } };
      },
    });
    const outputs = result.build.transaction.outputs.map((output) => output.slotClass);
    expect(outputs).toEqual([SlotClass.ASSET, SlotClass.NATIVE, SlotClass.DUMMY, SlotClass.DUMMY, SlotClass.NATIVE]);
    expect(result.build.transaction.global.openFeeAmount).toBe(0n);
    expect(result.build.transaction.global.issuanceOwnerCommitment).not.toBe(0n);
    expect((issuance as { recipientAddress: bigint }).recipientAddress).toBe(relaySigner.address);
    expect(result.changeAmount).toBe(feeAmount - 40n);
    expect(store.snapshot()!.pendingAssetActions![0]!.privateRelayRecipient).toBe(addressOf(relaySigner.address));
  });

  it("refuses zero-fee open and self-published actions, which belong on the contract's transfer role", async () => {
    const observed: Observed = {};
    const { openFeeAmount: _openFee, ...selfPublished } = intent(observed);
    for (const variant of [
      { intent: intent(observed, { openFeeAmount: 0n }), submission: submission() },
      { intent: selfPublished, submission: { ...submission(), mode: "l1" as const } },
    ]) {
      const store = walletStore();
      await expect(runSponsoredContractAssetActionClient({
        ...variant.intent, node: node(), store, wallet, signer, chainId: CHAIN_ID, submission: variant.submission,
      })).rejects.toThrow(/transfer role/);
      expect(store.snapshot()!.pendingAssetActions ?? []).toHaveLength(0);
    }
    // Self-publication pays its poster nothing.
    await expect(runSponsoredContractAssetActionClient({
      ...intent(observed), node: node(), store: walletStore(), wallet, signer, chainId: CHAIN_ID,
      submission: { ...submission(), mode: "l1" as const },
    })).rejects.toThrow(/self-publication has no PCASH network fee/);
    expect(observed.proof).toBeUndefined();
  });

  it("rejects a contract side outside its reserved slots before signing", async () => {
    const store = walletStore();
    const observed: Observed = {};
    await expect(runSponsoredContractAssetActionClient({
      ...intent(observed, { reservedOutputSlots: [2] }),
      node: node(), store, wallet, signer: { address: signer.address, signTypedData: async () => { throw new Error("must not sign"); } },
      chainId: CHAIN_ID, submission: submission(),
    })).rejects.toThrow(/did not reserve/);
    expect(observed.proof).toBeUndefined();
  });

  it("pays a self-published action's burn from the sponsor's notes, requires its carrier context, and designates issuance to the sponsor", async () => {
    const feeExcess = 1_313_000n;
    const burning = testStatus({ ...status, feeExcess });
    const burn = quoteNetworkFee(feeExcess, privateValueUnits(4, false));
    expect(burn).toBeGreaterThan(0n);
    const store = walletStore();
    const observed: Observed = {};
    const signed: string[] = [];
    let issuance: { recipientAddress: bigint } | undefined;
    const { openFeeAmount: _openFee, ...base } = intent(observed, { carrierContextHash: 0x7777n });
    const result = await runSponsoredContractAssetActionClient({
      ...base,
      primary: async (context) => {
        const primary = await base.primary(context);
        return { ...primary, witness: (build, opening) => {
          issuance = opening.designatedIssuanceOpening as { recipientAddress: bigint } | undefined;
          return primary.witness(build, opening);
        } };
      },
      node: node(wallet.mlKemPublicKey, [], burning), store, wallet, chainId: CHAIN_ID,
      signer: { address: signer.address, signTypedData: async (request) => {
        signed.push(request.typedData.primaryType);
        return signer.signTypedData(request);
      } },
      submission: { ...submission(), mode: "l1" as const }, settlePollMaxAttempts: 1,
    });
    const global = result.build.transaction.global;
    expect(global.openFeeAmount).toBe(0n);
    expect(BigInt(global.nativeBurnAmount)).toBe(burn);
    expect(BigInt(global.carrierContextHash)).toBe(0x7777n);
    const nullifiers = result.build.transaction.inputs.map((input) => BigInt(input.nullifier));
    expect(BigInt(global.issuanceOwnerCommitment))
      .toBe(issuancePayoutOpening(wallet.address, wallet.nkRoot, CHAIN_ID, nullifiers).ownerCommitment);
    expect(issuance?.recipientAddress).toBe(wallet.address);
    expect(result.changeAmount).toBe(feeAmount - burn);
    expect(signed).toEqual(["PcashContractInteractionWithBurn"]);
    expect(store.snapshot()!.pendingAssetActions![0]!.nativeBurnAmount).toBe(burn.toString());
  });

  it("authorizes the caller's network fee in place of its own quote", async () => {
    const feeExcess = 1_313_000n;
    const quoted = quoteNetworkFee(feeExcess, privateValueUnits(4, false));
    const networkFeeAmount = quoted * 3n;
    const store = walletStore();
    const { openFeeAmount: _openFee, ...base } = intent({}, { carrierContextHash: 0x7777n, networkFeeAmount });
    const result = await runSponsoredContractAssetActionClient({
      ...base,
      node: node(wallet.mlKemPublicKey, [], testStatus({ ...status, feeExcess })), store, wallet, chainId: CHAIN_ID, signer,
      submission: { ...submission(), mode: "l1" as const }, settlePollMaxAttempts: 1,
    });
    expect(BigInt(result.build.transaction.global.nativeBurnAmount)).toBe(networkFeeAmount);
    expect(result.changeAmount).toBe(feeAmount - networkFeeAmount);
  });

  it("refuses an action on contract inputs another journaled action spends, before signing or proving", async () => {
    const store = walletStore();
    const escrowNullifier = nullifier(escrowCommitment, noteNk(0x5151n), escrowSecret);
    await store.transaction((data) => {
      data!.pendingAssetActions = [{
        contentHash: hex(0xabcn), transactionHex: "0x00", assetId: hex(0n), owner: addressOf(wallet.address),
        notBeforeTimestamp: "0", validUntilTimestamp: "1800001800", openFeeAmount: "250", nativeBurnAmount: "0",
        issuanceOwnerCommitment: "0", inputs: [{ nullifier: hex(escrowNullifier), spentCommitment: null }], ownedOutputs: [],
      }];
      return { data: data!, value: undefined };
    });
    const observed: Observed = {};
    await expect(runSponsoredContractAssetActionClient({
      ...intent(observed), node: node(), store, wallet, chainId: CHAIN_ID, submission: submission(),
      signer: { address: signer.address, signTypedData: async () => { throw new Error("must not sign"); } },
    })).rejects.toThrow(/already journaled by another action: 0x0+abc, valid until 1800001800/);
    expect(observed.proof).toBeUndefined();
    expect(store.snapshot()!.pendingAssetActions).toHaveLength(1);
  });
});
