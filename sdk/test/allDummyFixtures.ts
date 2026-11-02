import { buildNativeTransfer } from "../src/builders/nativeTransfer.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { MERKLE_DEPTH } from "../src/constants/params.ts";
import type { PrivateValueShape } from "../src/constants/privateValueProfiles.ts";
import { syntheticRecentBlockOpenings } from "@pcash/test-support/protocol-fixtures";
import { zeroPaymentParams } from "./zeroPaymentFixtures.ts";
import { issuancePayoutOpening } from "../src/protocol/payout.ts";

/** The same ordinary action, with or without its account in historical state. */
export function allDummyFixture({ shape = 0, registered = false, inputAmounts = [], dummyInputEntropy = 42n }: {
  shape?: PrivateValueShape; registered?: boolean; inputAmounts?: bigint[]; dummyInputEntropy?: bigint;
} = {}) {
  const { params, wallet } = zeroPaymentParams({ shape, inputAmounts, dummyInputEntropy });
  if (!registered) {
    const accounts = new SparseMerkleTree(MERKLE_DEPTH);
    params.accountStateRoot = accounts.root;
    params.accountIndex = 0;
    params.accountSiblings = accounts.proof(0).siblings;
    Object.assign(params, syntheticRecentBlockOpenings({
      outputRoot: BigInt(params.outputRoot), outputCount: inputAmounts.length,
      accountStateRoot: accounts.root, accountCount: 0,
    }));
  }
  const inputs = buildNativeTransfer(params).transaction.inputs;
  const payout = issuancePayoutOpening(wallet.address, wallet.nkRoot, params.chainId, inputs.map((input) => input.nullifier), shape);
  params.issuanceOwnerCommitment = payout.ownerCommitment;
  params.designatedIssuanceOpening = { recipientAddress: wallet.address, noteSecret: payout.noteSecret, transactionContext: payout.context };
  return { build: buildNativeTransfer(params), params, wallet };
}
