// The known-answer proofs a circuit bundle carries. Each is a real proof for
// one hiding kernel, with its public inputs and a rejected variant.
//
// The runtime answers are what a node checks its verifier against at startup,
// one per hiding kernel. The others reuse those hiding-kernel keys and only
// supply integration tests, so a runtime bundle omits them.
export const KNOWN_ANSWERS = [
  { name: "private_value", hidingKernel: "private_value_hiding_kernel", runtime: true },
  { name: "private_value_large", hidingKernel: "private_value_large_hiding_kernel", runtime: true },
  { name: "user_account_update", hidingKernel: "user_account_update_hiding_kernel", runtime: true },
  { name: "real_event", hidingKernel: "private_value_hiding_kernel", runtime: false },
  { name: "shared_claim_s", hidingKernel: "private_value_hiding_kernel", runtime: false, transaction: true },
  { name: "shared_claim_l", hidingKernel: "private_value_large_hiding_kernel", runtime: false, transaction: true },
  { name: "large_sponsored_transfer", hidingKernel: "private_value_large_hiding_kernel", runtime: false },
  { name: "large_asset_creation", hidingKernel: "private_value_large_hiding_kernel", runtime: false },
];

/** The bundle-relative files of one known answer; `tx_bytes` is the whole encoded transaction. */
export function knownAnswerFiles(answer) {
  return ["proof", "proof.rejected", "public_inputs", ...(answer.transaction ? ["tx_bytes"] : [])]
    .map((file) => `known-answers/${answer.name}/${file}`);
}
