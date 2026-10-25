import { lineageFixture } from "@pcash/lineage/fixture";
import type { PerformanceScenario } from "./common.ts";

export function lineageScenarios(): PerformanceScenario[] {
  return [0, 1].map(k => ({
    id: k === 0 ? "lineageControl" : "lineageEvent",
    label: k === 0 ? "Lineage control (SDK no-op)" : "Private lineage event",
    description: k === 0 ? "The same S payment and anchor as the lineage fixture, folding the SDK no-op event application with no lineage claim." : "Four-input-capable fixed-root lineage circuit over authenticated results, policy publication, and deny-set gaps. Synthetic witness for measuring proofs; accepted handoffs are tested separately.",
    circuits: ["account_rule_payment_ecdsa", k === 0 ? "no_op_event_application" : "event_lineage", "private_value_transfer_kernel", "private_value_hiding_kernel"],
    async prepare(context) {
      const fixture = await lineageFixture(async () => {
        const vk = await context.vk("event_lineage");
        const artifact = await (await fetch("/prover/event_lineage.json")).json();
        return { kind: "app", artifact, verificationKey: new Uint8Array(), vkFields: vk.fields, vkHash: vk.hash };
      }, k !== 0);
      return {
        privateValueCommitment: fixture.build.privateValueCommitment,
        run: (prover, onStatus) => prover.proveTransfer({
          authorizationWitnessMap: fixture.build.accountRuleWitnessMap!,
          buildKernelWitnessMap: fixture.build.buildKernelWitnessMap,
          expectedPublicInputs: fixture.build.publicInputs,
          authorizationCircuitUrl: `/prover/${fixture.build.authorizationCircuit}.json`,
          ...(k === 0 ? {} : { eventApplication: { circuitUrl: "/prover/event_lineage.json", label: "lineage event", witnessMap: fixture.eventApplication!.witnessMap, event: fixture.eventApplication!.preparedEvent.application.event } }),
        }, onStatus),
      };
    },
  }));
}
