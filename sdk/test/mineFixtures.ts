import { buildMineAction } from "../src/builders/nativeTransfer.ts";
import { issuancePayoutOpening } from "../src/protocol/payout.ts";
import { allDummyFixture } from "./allDummyFixtures.ts";

export function mineFixture(registered = false) {
  const { params, wallet } = allDummyFixture({ registered });
  const initial = buildMineAction(params);
  const payout = issuancePayoutOpening(wallet.address, wallet.nkRoot, params.chainId,
    initial.transaction.inputs.map((input) => input.nullifier), initial.shape);
  const build = buildMineAction({
    ...params,
    issuanceOwnerCommitment: payout.ownerCommitment,
    designatedIssuanceOpening: { recipientAddress: wallet.address, noteSecret: payout.noteSecret, transactionContext: payout.context },
  });
  return { build, params, wallet, payout };
}
