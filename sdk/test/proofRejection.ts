import { BBApiException, type Barretenberg } from "@aztec-foundation/bb.js";
import { proveChonkStack, type ChonkBackend, type ChonkProgress, type NativeChonkStep } from "../src/prover/chonk.ts";

type ExpectedRejection = { operation: "finalize" }
  | { circuit: string; actualIoSize: number; expectedIoSize: number };

export async function expectRecursiveProofRejection(
  steps: readonly NativeChonkStep[],
  publicInputs: readonly bigint[],
  backend: ChonkBackend,
  expected: ExpectedRejection = { operation: "finalize" },
  api?: Barretenberg,
): Promise<void> {
  let operation: ChonkProgress | undefined;
  try {
    await proveChonkStack(steps, publicInputs, backend, {
      onProgress: (progress) => {
        if (progress.durationMs === undefined) operation = progress;
      },
      api,
    });
  } catch (error) {
    // bb verifies the accumulated proof inside chonkProve; a spliced VK
    // with a different public-input count is rejected earlier by HN recursion.
    // Each test specifies which semantic rejection it expects and where.
    // Startup, ACVM, transport, and resource failures cannot establish soundness.
    if (operation?.step === "prove" && error instanceof BBApiException) {
      if ("operation" in expected) {
        if (operation.operation === expected.operation
          && error.message === "Failed to verify the generated proof!") return;
      } else {
        const diagnostic = "Assertion failed: (expected_io_size == vk_num_public_inputs)\n"
          + `  Actual  : ${expected.actualIoSize}\n  Expected: ${expected.expectedIoSize}\n`
          + "  Reason  : process_hn_recursion_constraints: IO size mismatch with VK num_public_inputs";
        if (operation.circuit === expected.circuit && error.message.trim() === diagnostic) return;
      }
    }
    throw new Error(`Unexpected rejection during ${operation?.step}/${operation?.circuit ?? operation?.operation}: ${String(error)}`, { cause: error });
  }
  throw new Error("Tampered recursive proof unexpectedly succeeded");
}
