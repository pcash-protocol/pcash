import { eventStatementFromKernel } from "../src/protocol/events.ts";
import { NO_OP_EVENT_APPLICATION, type ChonkCircuitMaterial, type ChonkCircuitResolver } from "../src/prover/stacks.ts";
import type { WitnessMap } from "../src/protocol/witness.ts";

const vkWitness = (material: ChonkCircuitMaterial) => ({ key: material.vkFields, hash: material.vkHash });

/** The kernel witness for the SDK-selected no-op event application. */
export async function noOpEventApplicationWitness(resolve: ChonkCircuitResolver, kernel: WitnessMap): Promise<WitnessMap> {
  return { event_application_vk: vkWitness(await resolve(NO_OP_EVENT_APPLICATION, "app")), event_statement: eventStatementFromKernel(kernel).map(String) };
}

/** The same kernel witness with another event application substituted. */
export function substituteEventApplication(map: WitnessMap, application: ChonkCircuitMaterial): WitnessMap {
  return { ...map, event_application_vk: vkWitness(application) };
}

/** A substituted event application cannot reuse the no-op event statement. */
export const MISMATCHED_EVENT_APPLICATION_REJECTION = /rule statement must match the kernel/;
