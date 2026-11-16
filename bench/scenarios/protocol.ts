import {
  MERKLE_DEPTH,
  SparseMerkleTree,
  assetCovenantSuccessorConfigurationCommitment,
  authorizePcashRequestWithPrivateKey,
  buildAssetAction,
  buildNativeTransfer,
  defaultUserAccountRuleSet,
  deriveWalletIdentity,
  assetSecretCommitment,
  fullOutputCommitment,
  generateMlKemKeyPair,
  nullifierKeyCommitment,
  openedAssetActionOutput,
  ownerChangeAssetActionOutput,
  outOfBandAssetActionOutput,
  accountStateCommitment,
  receiveKeyHash,
  sizeClassFiller,
  standardFungibleAssetId,
} from "@pcash/sdk/browser";
import { buildAssetCovenantRuleWitness } from "@pcash/sdk/fixtures";
import {
  CIRCUIT_URLS,
  type AssetActionProofRequest,
  type ChonkProofStep,
} from "@pcash/sdk/browser-prover";
import {
  buildContractBody,
  buildContractFunctionSet,
} from "@pcash/sdk/protocol";
import {
  syntheticRecentBlockFixture,
  transferFixture,
} from "@pcash/test-support/protocol-fixtures";
import {
  authorizationAccount,
  covenantMaxNativeOpenFeeAmount,
  hidingKernelWitness,
  nativeRuleSecrets,
  pcashChainId,
  selector,
  noOpEventApplicationStep,
  noOpEventApplicationWitness,
  NO_OP_EVENT_APPLICATION,
  type PerformanceScenario,
  type ScenarioContext,
} from "./common.ts";

const COVENANT = "account_rule_asset_covenant";

/**
 * One person's account and notes, plus a covenant-owned contract and its
 * successor. To every scenario except the covenant transfer those two are
 * ordinary accounts, so a source without the covenant circuit gets a
 * placeholder application VK hash for them.
 */
async function sharedState(context: ScenarioContext) {
  const covenantVkHash = context.available(COVENANT) ? BigInt((await context.vk(COVENANT)).hash) : 0n;
  const successorReceiveKey = generateMlKemKeyPair();
  const successorReceiveKeyHash = receiveKeyHash(successorReceiveKey.publicKey);

  const successorFunctions = [{
    selector,
    applicationVkHash: covenantVkHash,
    configurationCommitment: 0x303n,
  }];
  const successor = buildContractBody({
    nullifierKey: { publishesNkRoot: true, nkRoot: 0xb0b0b0n },
    mlKemPublicKey: successorReceiveKey.publicKey,
    functions: successorFunctions,
  });
  const covenantConfiguration = assetCovenantSuccessorConfigurationCommitment({
    maxNativeOpenFeeAmount: covenantMaxNativeOpenFeeAmount,
    successorAddress: successor.address,
    successorNullifierKeyCommitment: successor.nullifierKeyCommitment,
    successorRuleSetCommitment: successor.functionSetCommitment,
    successorAccountRevision: 1n,
    successorReceiveKeyHash,
  });
  const ownerNkRoot = 0xa0a0a0n;
  const ownerFunctions = [{
    selector,
    applicationVkHash: covenantVkHash,
    configurationCommitment: covenantConfiguration,
  }];
  const owner = buildContractBody({
    nullifierKey: { publishesNkRoot: true, nkRoot: ownerNkRoot },
    functions: ownerFunctions,
  });
  const ownerFunction = buildContractFunctionSet(ownerFunctions).membership(selector);

  const nativePrivateKey = Uint8Array.from([
    0, 17, 34, 51, 68, 85, 102, 119,
    136, 153, 170, 187, 204, 221, 238, 255,
    0, 17, 34, 51, 68, 85, 102, 119,
    136, 153, 170, 187, 204, 221, 238, 255,
  ]);
  const nativeIdentity = deriveWalletIdentity(nativePrivateKey);
  const nativeWallet = { ...nativeIdentity, nkRoot: 0x707070n };
  // The person's own receive key, so their change output is a complete opening
  // the readable rule can display and sign.
  const userReceiveKey = generateMlKemKeyPair();
  const nativeRules = defaultUserAccountRuleSet({
    wallet: nativeWallet,
    secrets: nativeRuleSecrets,
  });

  const assetSecret = 0x123456n;
  const totalSupply = 1_200n;
  const assetDescriptorFields = {
    metadataCommitment: 0x909090n,
    initialSupply: totalSupply,
    assetSecretCommitment: assetSecretCommitment(assetSecret),
  };
  const assetDescriptor = {
    assetId: standardFungibleAssetId(assetDescriptorFields),
    ...assetDescriptorFields,
  };
  const assetId = assetDescriptor.assetId;

  const outputTree = new SparseMerkleTree(MERKLE_DEPTH);
  const covenantAssetSecret = 0x501n;
  outputTree.setLeaf(0, fullOutputCommitment({
    owner: owner.address,
    noteSecret: covenantAssetSecret,
    assetId,
    amount: 300n,
  }, 0));
  // One asset note owned by a person rather than the contract, so the lab
  // measures someone moving an asset they hold, authorized by their own key.
  const userAssetSecret = 0x506n;
  outputTree.setLeaf(1, fullOutputCommitment({
    owner: nativeWallet.address,
    noteSecret: userAssetSecret,
    assetId,
    amount: 300n,
  }, 1));

  const accountStateTree = new SparseMerkleTree(MERKLE_DEPTH);
  accountStateTree.setLeaf(0, owner.accountStateCommitment);
  accountStateTree.setLeaf(1, successor.accountStateCommitment);
  accountStateTree.setLeaf(2, accountStateCommitment(
    nativeWallet.address,
    nullifierKeyCommitment(nativeWallet.nkRoot),
    nativeRules.accountRuleSetCommitment,
    0n,
    1n,
    0n,
  ));
  const recent = syntheticRecentBlockFixture({
    outputRoot: outputTree.root,
    outputCount: 2,
    issuedSoFar: 0n,
    lagQ: 0n,
    accountStateRoot: accountStateTree.root,
    accountCount: 3,
  });
  const snapshot = {
    recentPcashBlockHash: recent.recentPcashBlockHash,
    stateRoot: recent.stateRoot,
    stateRootHeaderSiblings: recent.stateRootHeaderSiblings,
    outputRoot: outputTree.root,
    outputRootStateSiblings: recent.outputRootStateSiblings,
    accountStateRoot: accountStateTree.root,
    accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
  };
  const nativeAccount = (rule: { configurationCommitment: bigint; commitmentBlinder: bigint; entryIndex: number; siblings: readonly bigint[] }) =>
    authorizationAccount({
      address: nativeWallet.address,
      nkRoot: nativeWallet.nkRoot,
      accountIndex: 2,
      accountSiblings: accountStateTree.proof(2).siblings,
      accountRuleSetCommitment: nativeRules.accountRuleSetCommitment,
      accountKind: 0n,
      configurationCommitment: rule.configurationCommitment,
      commitmentBlinder: rule.commitmentBlinder,
      entryIndex: rule.entryIndex,
      entrySiblings: rule.siblings,
    });
  return {
    successor,
    successorReceiveKey,
    successorWitness: {
      address: successor.address,
      nullifierKeyCommitment: successor.nullifierKeyCommitment,
      ruleSetCommitment: successor.functionSetCommitment,
      accountRevision: 1n,
      receiveKeyHash: successorReceiveKeyHash,
      accountIndex: 1,
      accountSiblings: accountStateTree.proof(1).siblings,
    },
    covenantOwnerAuthorization: authorizationAccount({
      address: owner.address,
      nkRoot: ownerNkRoot,
      accountIndex: 0,
      accountSiblings: accountStateTree.proof(0).siblings,
      accountRuleSetCommitment: owner.functionSetCommitment,
      accountKind: 1n,
      configurationCommitment: covenantConfiguration,
      entryIndex: selector,
      entrySiblings: ownerFunction.siblings,
    }),
    covenantAssetSecret,
    nativePrivateKey,
    nativeWallet,
    nativeRules,
    nativeAccount,
    userReceiveKey,
    userAssetSecret,
    assetDescriptor,
    assetId,
    assetSecret,
    totalSupply,
    outputTree,
    snapshot,
  };
}

async function kernelVks(context: ScenarioContext) {
  const [noOpEventApplication, transfer, hidingKernel] = await Promise.all([
    context.vk(NO_OP_EVENT_APPLICATION),
    context.vk("private_value_transfer_kernel"),
    context.vk("private_value_hiding_kernel"),
  ]);
  return { noOpEventApplication, transfer, hidingKernel };
}

export function protocolScenarios(): PerformanceScenario[] {
  let shared: ReturnType<typeof sharedState> | undefined;
  const state = (context: ScenarioContext) => shared ??= sharedState(context);
  return [
    {
      id: "notesNative",
      label: "Native note payment",
      description: "The payment and fee come entirely from private notes, through the transfer kernel.",
      circuits: ["account_rule_payment_ecdsa", NO_OP_EVENT_APPLICATION, "private_value_transfer_kernel", "private_value_hiding_kernel"],
      async prepare(context) {
        const { nativeWallet } = await state(context);
        const nativeTransfer = buildNativeTransfer(transferFixture({
          chainId: pcashChainId,
          wallet: nativeWallet,
          recipientAddress: 0x1111222233334444555566667777888899990000n,
          inputAmount: 1_000n,
          paymentAmount: 900n,
          openFeeAmount: 10n,
          issuanceOwnerCommitment: 0n,
          dummyInputEntropy: 0x404040n,
          validUntilTimestamp: 999_999n,
          noteSecret: 0x401n,
        }));
        return {
          privateValueCommitment: nativeTransfer.privateValueCommitment,
          run: (prover, onStatus) => prover.proveTransfer({
            authorizationWitnessMap: nativeTransfer.accountRuleWitnessMap!,
            buildKernelWitnessMap: nativeTransfer.buildKernelWitnessMap,
            expectedPublicInputs: nativeTransfer.publicInputs,
            authorizationCircuitUrl: `/prover/${nativeTransfer.authorizationCircuit}.json`,
            authorizationLabel: "installed payment authorization",
          }, onStatus),
        };
      },
    },
    {
      id: "asset-creation",
      label: "Registered asset creation",
      description: "A registered USER authorizes fixed-supply asset creation with zero native input and zero PCASH fee.",
      circuits: ["account_rule_asset_creation_ecdsa", NO_OP_EVENT_APPLICATION, "private_value_asset_creation_kernel", "private_value_hiding_kernel"],
      async prepare(context) {
        const s = await state(context);
        const build = buildAssetAction({
          pcashChainId,
          snapshot: s.snapshot,
          owner: s.nativeAccount(s.nativeRules.assetCreationRule),
          assetDescriptor: s.assetDescriptor,
          assetSecret: s.assetSecret,
          inputs: [
            { kind: "creation-marker" },
            { kind: "dummy" },
            { kind: "dummy" },
            { kind: "dummy" },
          ],
          outputs: [
            openedAssetActionOutput({
              kind: "asset",
              pcashChainId,
              assetId: s.assetId,
              outputIndex: 0,
              recipientAddress: s.successor.address,
              recipientMlKemPublicKey: s.successorReceiveKey.publicKey,
              authenticatedRecipient: true,
              noteSecret: 0x610n,
              amount: s.totalSupply,
            }),
            { kind: "dummy", dummySecret: 0x611n, amount: 0n, outputData: sizeClassFiller() },
            { kind: "dummy", dummySecret: 0x612n, amount: 0n, outputData: sizeClassFiller() },
            { kind: "dummy", dummySecret: 0x613n, amount: 0n, outputData: sizeClassFiller() },
            { kind: "dummy", dummySecret: 0x614n, amount: 0n, outputData: sizeClassFiller() },
          ],
          openFeeAmount: 0n,
          issuanceOwnerCommitment: 0n,
          validUntilTimestamp: 999_999n,
        });
        const prepared = build.prepareOwnerAuthorization({
          wallet: s.nativeWallet,
        });
        const witness = prepared.authorize(authorizePcashRequestWithPrivateKey(s.nativePrivateKey, prepared.request));
        const request: AssetActionProofRequest = {
          operation: "assetCreation",
          authorization: {
            circuitUrl: CIRCUIT_URLS.account_rule_asset_creation_ecdsa,
            witnessMap: witness.witnessMap,
            label: "installed asset-creation authorization",
          },
          buildKernelWitnessMap: build.buildAssetCreationKernelWitnessMap,
          expectedPublicInputs: build.publicInputs,
        };
        return {
          assetId: s.assetId,
          privateValueCommitment: build.privateValueCommitment,
          run: (prover, onStatus) => prover.proveAssetAction(request, onStatus),
        };
      },
    },
    {
      id: "ordinaryAssetTransfer",
      label: "Contract asset transfer",
      description: "One asset input, recipient plus change, authorized by a contract covenant that verifies no signature. Input and output counts do not change a circuit's size, so a four-input action costs the same.",
      circuits: [COVENANT, NO_OP_EVENT_APPLICATION, "private_value_transfer_kernel", "private_value_hiding_kernel"],
      async prepare(context) {
        const [s, kernels, covenantVk] = await Promise.all([state(context), kernelVks(context), context.vk(COVENANT)]);
        const outputSecrets = [0x621n, 0x622n] as const;
        const build = buildAssetAction({
          pcashChainId,
          snapshot: s.snapshot,
          assetId: s.assetId,
          owner: s.covenantOwnerAuthorization,
          inputs: [
            { kind: "asset", amount: 300n, noteSecret: s.covenantAssetSecret, leafIndex: 0, siblings: s.outputTree.proof(0).siblings },
            { kind: "dummy" },
            { kind: "dummy" },
            { kind: "dummy" },
          ],
          outputs: [
            outOfBandAssetActionOutput({ kind: "asset", recipientAddress: s.successor.address, noteSecret: outputSecrets[0], amount: 200n, outputData: sizeClassFiller() }),
            outOfBandAssetActionOutput({ kind: "asset", recipientAddress: s.successor.address, noteSecret: outputSecrets[1], amount: 100n, outputData: sizeClassFiller() }),
            { kind: "dummy", dummySecret: 0x623n, amount: 0n, outputData: sizeClassFiller() },
            { kind: "dummy", dummySecret: 0x624n, amount: 0n, outputData: sizeClassFiller() },
            { kind: "dummy", dummySecret: 0x625n, amount: 0n, outputData: sizeClassFiller() },
          ],
          openFeeAmount: 0n,
          issuanceOwnerCommitment: 0n,
          validUntilTimestamp: 999_999n,
        });
        const covenant = buildAssetCovenantRuleWitness({
          build,
          snapshot: s.snapshot,
          pcashChainId,
          maxNativeOpenFeeAmount: covenantMaxNativeOpenFeeAmount,
          successor: s.successorWitness,
          outputs: [
            { assetId: s.assetId, amount: 200n, noteSecret: outputSecrets[0] },
            { assetId: s.assetId, amount: 100n, noteSecret: outputSecrets[1] },
            null,
            null,
            null,
          ],
        });
        const kernelWitness = build.buildKernelWitnessMap({ vkFields: covenantVk.fields, vkHash: covenantVk.hash });
        const steps: ChonkProofStep[] = [
          { circuitUrl: `/prover/${COVENANT}.json`, vkUrl: covenantVk.url, kind: "app", witnessMap: covenant.witnessMap, label: "contract asset covenant" },
          noOpEventApplicationStep(kernels.noOpEventApplication, kernelWitness),
          {
            circuitUrl: CIRCUIT_URLS.private_value_transfer_kernel,
            vkUrl: kernels.transfer.url,
            kind: "kernel",
            witnessMap: {
              ...kernelWitness,
              ...noOpEventApplicationWitness(kernels.noOpEventApplication, kernelWitness),
            },
            label: "transfer kernel",
          },
          { circuitUrl: CIRCUIT_URLS.private_value_hiding_kernel, vkUrl: kernels.hidingKernel.url, kind: "hiding", witnessMap: hidingKernelWitness(build.publicInputs, kernels.transfer), label: "hiding kernel" },
        ];
        return {
          assetId: s.assetId,
          privateValueCommitment: build.privateValueCommitment,
          run: (prover, onStatus) => prover.proveChonk({ steps, expectedPublicInputs: build.publicInputs }, onStatus),
        };
      },
    },
    {
      id: "userAssetTransfer",
      label: "User asset transfer",
      description: "A person moves an asset they own, authorized by the semantic asset-payment rule: the contract transfer's shape, priced with a signature instead of a covenant.",
      circuits: ["account_rule_asset_payment_ecdsa", NO_OP_EVENT_APPLICATION, "private_value_transfer_kernel", "private_value_hiding_kernel"],
      async prepare(context) {
        const [s, kernels, assetPaymentVk] = await Promise.all([
          state(context),
          kernelVks(context),
          context.vk("account_rule_asset_payment_ecdsa"),
        ]);
        const build = buildAssetAction({
          pcashChainId,
          snapshot: s.snapshot,
          assetId: s.assetId,
          owner: s.nativeAccount(s.nativeRules.assetPaymentRule),
          inputs: [
            { kind: "asset", amount: 300n, noteSecret: s.userAssetSecret, leafIndex: 1, siblings: s.outputTree.proof(1).siblings },
            { kind: "dummy" },
            { kind: "dummy" },
            { kind: "dummy" },
          ],
          outputs: [
            openedAssetActionOutput({
              kind: "asset",
              pcashChainId,
              assetId: s.assetId,
              outputIndex: 0,
              recipientAddress: s.successor.address,
              recipientMlKemPublicKey: s.successorReceiveKey.publicKey,
              authenticatedRecipient: true,
              noteSecret: 0x641n,
              amount: 200n,
            }),
            ownerChangeAssetActionOutput({
              kind: "asset",
              pcashChainId,
              assetId: s.assetId,
              amount: 100n,
              receiveKey: s.userReceiveKey.publicKey,
            }),
            { kind: "dummy", dummySecret: 0x643n, amount: 0n, outputData: sizeClassFiller() },
            { kind: "dummy", dummySecret: 0x644n, amount: 0n, outputData: sizeClassFiller() },
            { kind: "dummy", dummySecret: 0x645n, amount: 0n, outputData: sizeClassFiller() },
          ],
          openFeeAmount: 0n,
          issuanceOwnerCommitment: 0n,
          validUntilTimestamp: 999_999n,
        });
        const prepared = build.prepareOwnerAuthorization({
          wallet: s.nativeWallet,
        });
        const witness = prepared.authorize(authorizePcashRequestWithPrivateKey(s.nativePrivateKey, prepared.request));
        const kernelWitness = build.buildKernelWitnessMap({ vkFields: assetPaymentVk.fields, vkHash: assetPaymentVk.hash });
        const steps: ChonkProofStep[] = [
          { circuitUrl: CIRCUIT_URLS.account_rule_asset_payment_ecdsa, vkUrl: assetPaymentVk.url, kind: "app", witnessMap: witness.witnessMap, label: "user asset-payment authorization" },
          noOpEventApplicationStep(kernels.noOpEventApplication, kernelWitness),
          {
            circuitUrl: CIRCUIT_URLS.private_value_transfer_kernel,
            vkUrl: kernels.transfer.url,
            kind: "kernel",
            witnessMap: {
              ...kernelWitness,
              ...noOpEventApplicationWitness(kernels.noOpEventApplication, kernelWitness),
            },
            label: "transfer kernel",
          },
          { circuitUrl: CIRCUIT_URLS.private_value_hiding_kernel, vkUrl: kernels.hidingKernel.url, kind: "hiding", witnessMap: hidingKernelWitness(build.publicInputs, kernels.transfer), label: "hiding kernel" },
        ];
        return {
          assetId: s.assetId,
          privateValueCommitment: build.privateValueCommitment,
          run: (prover, onStatus) => prover.proveChonk({ steps, expectedPublicInputs: build.publicInputs }, onStatus),
        };
      },
    },
  ];
}
