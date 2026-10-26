import { buildContractBody, buildNativeTransfer, deriveWalletIdentity } from "@pcash/sdk/browser";
import { transferFixture } from "@pcash/test-support/protocol-fixtures";
import { hexToBytes } from "viem";
import { NO_OP_EVENT_APPLICATION, pcashChainId, selector, type PerformanceScenario } from "./common.ts";

/** One native payment creates the contract and funds its first note. */
export function contractCreationScenario(): PerformanceScenario {
  return {
    id: "contractCreation",
    label: "Create and fund contract",
    description: "A native payment creates a contract account and funds it in one proof.",
    circuits: ["account_rule_payment_ecdsa", NO_OP_EVENT_APPLICATION, "private_value_transfer_kernel", "private_value_hiding_kernel"],
    prepare: async () => {
      const wallet = { ...deriveWalletIdentity(hexToBytes("0x5ca1ab1e0c0ffee05ca1ab1e0c0ffee05ca1ab1e0c0ffee05ca1ab1e0c0ffee0")), nkRoot: 0xc0c0c0n };
      const contract = buildContractBody({
        nullifierKey: { publishesNkRoot: true, nkRoot: 0xe5c0e5c0n },
        functions: [{ selector, applicationVkHash: 0xe5c1n, configurationCommitment: 0xe5c2n }],
      });
      const build = buildNativeTransfer(transferFixture({
        chainId: pcashChainId, wallet, recipientAddress: contract.address,
        accountCreation: { kind: "contract", body: contract.body },
        inputAmount: 1_000_000n, paymentAmount: 900_000n, openFeeAmount: 2_500n,
        issuanceOwnerCommitment: 0n, validUntilTimestamp: 999_999n, noteSecret: 0x701n,
      }));
      return {
        privateValueCommitment: build.privateValueCommitment,
        run: (prover, onStatus) => prover.proveTransfer({
          authorizationWitnessMap: build.accountRuleWitnessMap!,
          buildKernelWitnessMap: build.buildKernelWitnessMap,
          expectedPublicInputs: build.publicInputs,
          authorizationCircuitUrl: `/prover/${build.authorizationCircuit}.json`,
          authorizationLabel: "contract funding authorization",
        }, onStatus),
      };
    },
  };
}
