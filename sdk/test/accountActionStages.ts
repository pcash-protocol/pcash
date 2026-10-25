import { Noir } from "@noir-lang/noir_js";
import { expect } from "vitest";
import { PRIVATE_VALUE_PROFILES } from "../src/constants/privateValueProfiles.ts";
import { fieldToHex } from "../src/crypto/field.ts";
import { privateValuePublicInputNames, type WitnessMap } from "../src/protocol/witness.ts";
import type { ChonkCircuitResolver } from "../src/prover/stacks.ts";
import { noOpEventApplicationWitness, MISMATCHED_EVENT_APPLICATION_REJECTION, substituteEventApplication } from "./noOpEventApplication.ts";

// ACVM checks the statement bindings; the caller also proves the recursive stack.
export async function assertAccountActionStages(params: {
  resolve: ChonkCircuitResolver;
  authorizationPackage: string;
  kernelPackage: string;
  prefix: string;
  extraDataName: string;
  build: {
    publicInputs: readonly bigint[];
    buildKernelWitnessMap: (authorization: Awaited<ReturnType<ChonkCircuitResolver>>) => WitnessMap;
  };
}): Promise<void> {
  const authorization = await params.resolve(params.authorizationPackage, "app");
  const kernel = await params.resolve(params.kernelPackage, "kernel");
  const hidingKernel = await params.resolve(`${params.prefix}_hiding_kernel`, "hiding");
  const publicInputs = params.build.publicInputs.map(fieldToHex);
  const extraDataIndex = PRIVATE_VALUE_PROFILES.S.publicInputs;
  const kernelMap = { ...params.build.buildKernelWitnessMap(authorization), ...await noOpEventApplicationWitness(params.resolve, params.build.buildKernelWitnessMap(authorization)) };
  const executeKernel = (map: WitnessMap) => new Noir(kernel.artifact as never).execute(map as never);
  const statement = (await executeKernel(kernelMap)).returnValue as string[];
  expect(statement.map((value) => BigInt(value))).toEqual(params.build.publicInputs);
  await expect(executeKernel(substituteEventApplication(kernelMap, authorization))).rejects.toThrow(MISMATCHED_EVENT_APPLICATION_REJECTION);

  const hidingKernelMap: WitnessMap = {
    ...Object.fromEntries(privateValuePublicInputNames(PRIVATE_VALUE_PROFILES.S).map((name, index) => [name, publicInputs[index]])),
    [params.extraDataName]: publicInputs[extraDataIndex],
    transaction_statement: statement,
    kernel_vk: { key: kernel.vkFields, hash: kernel.vkHash },
  };
  const executeHidingKernel = (map: WitnessMap) => new Noir(hidingKernel.artifact as never).execute(map as never);
  await executeHidingKernel(hidingKernelMap);
  // The node supplies a zero issuance word; a statement that designates issuance differs from it.
  const issuanceOwner = PRIVATE_VALUE_PROFILES.S.offsets.issuanceOwner;
  await expect(executeHidingKernel({
    ...hidingKernelMap,
    transaction_statement: statement.map((value, index) => index === issuanceOwner ? "0x1" : value),
  })).rejects.toThrow(/kernel statement must equal the public inputs/);
  await expect(executeHidingKernel({
    ...hidingKernelMap,
    [params.extraDataName]: fieldToHex(params.build.publicInputs[extraDataIndex]! + 1n),
  })).rejects.toThrow(/kernel statement must equal the public inputs/);
  await expect(executeHidingKernel({
    ...hidingKernelMap,
    kernel_vk: { key: authorization.vkFields, hash: authorization.vkHash },
  })).rejects.toThrow(/kernel VK must be one the hiding kernel allows/);
}
