import { buildNativeTransfer, type BuildNativeTransferParams } from "../src/builders/nativeTransfer.ts";
import type { PrivateValueShape } from "../src/constants/privateValueProfiles.ts";
import { MERKLE_DEPTH } from "../src/constants/params.ts";
import { SparseMerkleTree } from "../src/crypto/tree.ts";
import { fullOutputCommitment } from "../src/protocol/notes.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { syntheticRecentBlockOpenings, withSyntheticTransferOpenings } from "@pcash/test-support/protocol-fixtures";
import { deriveTestWallet, testAuthorizationResolver } from "./testWallet.ts";

interface ZeroPaymentOptions {
  shape?: PrivateValueShape;
  inputAmounts?: readonly bigint[];
  openFeeAmount?: bigint;
  dummyInputEntropy?: bigint;
}

/**
 * Parameters for a zero-value native payment to the signer's own address under
 * the default rules, spending `inputAmounts` (none by default) from an
 * otherwise empty output tree.
 */
export function zeroPaymentParams(params: ZeroPaymentOptions = {}) {
  const wallet = deriveTestWallet({ mlKem: "deterministic" });
  const chainId = BigInt(DEFAULT_NETWORK_CONFIG.pcashChainId);
  const inputAmounts = params.inputAmounts ?? [];
  const base = withSyntheticTransferOpenings({
    shape: params.shape ?? 0,
    chainId,
    wallet,
    authorizationResolver: testAuthorizationResolver(wallet),
    recipientAddress: wallet.address,
    inputAmount: 1n,
    noteSecret: 100n,
    paymentAmount: 0n,
    openFeeAmount: params.openFeeAmount ?? 0n,
    issuanceOwnerCommitment: 0n,
    dummyInputEntropy: params.dummyInputEntropy ?? 42n,
    validUntilTimestamp: 9_999_999n,
  });
  const tree = new SparseMerkleTree(MERKLE_DEPTH);
  const noteSecret = (index: number) => BigInt(100 + index);
  inputAmounts.forEach((amount, index) => {
    tree.setLeaf(index, fullOutputCommitment(
      { owner: wallet.address, noteSecret: noteSecret(index), assetId: 0n, amount },
      index,
    ));
  });
  const buildParams: BuildNativeTransferParams = {
    ...base,
    inputs: inputAmounts.map((amount, index) => ({
      amount,
      noteSecret: noteSecret(index),
      outputIndex: index,
      siblings: tree.proof(index).siblings,
    })),
    outputRoot: tree.root,
    ...syntheticRecentBlockOpenings({
      outputRoot: tree.root,
      outputCount: inputAmounts.length,
      accountStateRoot: base.accountStateRoot,
      accountCount: 1,
    }),
  };
  return { params: buildParams, wallet };
}

export function zeroPaymentFixture(options: ZeroPaymentOptions = {}) {
  const { params, wallet } = zeroPaymentParams(options);
  return { build: buildNativeTransfer(params), params, wallet };
}
