import {
  ACCOUNT_KIND_USER,
  DEFAULT_NETWORK_CONFIG,
  MERKLE_DEPTH,
  SparseMerkleTree,
  accountStateCommitment,
  authorizePcashRequestWithPrivateKey,
  buildContractBody,
  defaultUserAccountRuleSet,
  deriveWalletIdentity,
  fullOutputCommitment,
  generateMlKemKeyPair,
  nullifierKeyCommitment,
  prepareSponsoredContractCreation,
  receiveKeyHash as protocolReceiveKeyHash,
} from "@pcash/sdk/browser";
import { CIRCUIT_URLS } from "@pcash/sdk/browser-prover";
import { syntheticRecentBlockFixture } from "@pcash/test-support/protocol-fixtures";
import { hexToBytes } from "viem";
import {
  authorizationAccount,
  NO_OP_EVENT_APPLICATION,
  nativeRuleSecrets,
  pcashChainId,
  selector,
  type PerformanceScenario,
} from "./common.ts";

const sponsorPrivateKey = hexToBytes("0x5ca1ab1e0c0ffee05ca1ab1e0c0ffee05ca1ab1e0c0ffee05ca1ab1e0c0ffee0");

/** A USER pays a contract account's creation fee from one private note, as a Marketplace listing does. */
export function contractCreationScenario(): PerformanceScenario {
  return {
    id: "contractCreation",
    label: "Contract creation",
    description: "A person creates a contract account and pays its fee from one private note.",
    circuits: [
      "account_rule_contract_fee_sponsorship_ecdsa",
      NO_OP_EVENT_APPLICATION,
      "contract_creation_kernel",
      "contract_creation_hiding_kernel",
    ],
    prepare: async () => {
      const network = { ...DEFAULT_NETWORK_CONFIG, pcashChainId };
      const receiveKey = generateMlKemKeyPair();
      const receiveKeyHash = protocolReceiveKeyHash(receiveKey.publicKey);
      const sponsor = {
        ...deriveWalletIdentity(sponsorPrivateKey),
        nkRoot: 0xc0c0c0n,
        mlKemPublicKey: receiveKey.publicKey,
      };
      const rules = defaultUserAccountRuleSet({
        wallet: sponsor,
        network,
        secrets: nativeRuleSecrets,
      });

      // The creation kernel binds only the derived address, so the body's
      // contents do not change proving cost.
      const contract = buildContractBody({
        nullifierKey: { publishesNkRoot: true, nkRoot: 0xe5c0e5c0n },
        functions: [{ selector, applicationVkHash: 0xe5c1n, configurationCommitment: 0xe5c2n }],
      });

      const feeNote = { noteSecret: 0x701n, amount: 1_000_000n, leafIndex: 0 };
      const outputTree = new SparseMerkleTree(MERKLE_DEPTH);
      outputTree.setLeaf(feeNote.leafIndex, fullOutputCommitment({
        owner: sponsor.address,
        noteSecret: feeNote.noteSecret,
        assetId: 0n,
        amount: feeNote.amount,
      }, feeNote.leafIndex));
      const accountStateTree = new SparseMerkleTree(MERKLE_DEPTH);
      accountStateTree.setLeaf(0, accountStateCommitment(
        sponsor.address,
        nullifierKeyCommitment(sponsor.nkRoot),
        rules.accountRuleSetCommitment,
        ACCOUNT_KIND_USER,
        1n,
        receiveKeyHash,
      ));
      const recent = syntheticRecentBlockFixture({
        outputRoot: outputTree.root,
        outputCount: 1,
        accountStateRoot: accountStateTree.root,
        accountCount: 1,
      });
      const rule = rules.contractFeeSponsorshipRule;

      const build = prepareSponsoredContractCreation({
        network,
        contract: { body: contract.body, address: contract.address },
        sponsor: {
          ...authorizationAccount({
            address: sponsor.address,
            nkRoot: sponsor.nkRoot,
            accountIndex: 0,
            accountSiblings: accountStateTree.proof(0).siblings,
            accountRuleSetCommitment: rules.accountRuleSetCommitment,
            accountKind: ACCOUNT_KIND_USER,
            configurationCommitment: rule.configurationCommitment,
            commitmentBlinder: rule.commitmentBlinder,
            entryIndex: rule.entryIndex,
            entrySiblings: rule.siblings,
          }),
          receiveKeyHash,
        },
        sponsorWallet: sponsor,
        sponsorReceiveKey: receiveKey.publicKey,
        snapshot: {
          recentPcashBlockHash: recent.recentPcashBlockHash,
          stateRootHeaderSiblings: recent.stateRootHeaderSiblings,
          outputRoot: outputTree.root,
          outputRootStateSiblings: recent.outputRootStateSiblings,
          accountStateRoot: accountStateTree.root,
          accountStateRootStateSiblings: recent.accountStateRootStateSiblings,
        },
        fee: {
          openFeeAmount: 2_500n,
          validUntilTimestamp: 999_999n,
          inputs: [{ ...feeNote, siblings: outputTree.proof(feeNote.leafIndex).siblings }],
        },
      });
      const sponsorship = build.authorizeReadableEcdsa(
        authorizePcashRequestWithPrivateKey(sponsorPrivateKey, build.authorizationRequest),
      );
      return {
        privateValueCommitment: build.payment.privateValueCommitment,
        run: (prover, onStatus) => prover.proveSponsoredContractCreation({
          authorizationWitnessMap: sponsorship.witnessMap,
          buildKernelWitnessMap: build.buildKernelWitnessMap,
          expectedPublicInputs: [...build.publicInputs],
          authorizationCircuitUrl: CIRCUIT_URLS.account_rule_contract_fee_sponsorship_ecdsa,
        }, onStatus),
      };
    },
  };
}
