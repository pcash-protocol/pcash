// A proof-bearing contract publication is an ordinary all-dummy value action
// carrying its immutable body. Its open issuance pays the poster.

import { buildMineAction, snapshotFromAccountProof } from "@pcash/sdk/builders";
import type { PcashActionSigner } from "@pcash/sdk/eip712";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { networkConfigFromStatus } from "@pcash/sdk/protocol";
import { createReleaseChonkCircuitResolver, nativeChonkBackend } from "@pcash/sdk/node";
import { proveTransferTransactionChonk } from "@pcash/sdk/prover";
import { addressHex } from "@pcash/sdk/utils";
import type { PcashProfile } from "../deps.ts";

export interface AttachedContractPublicationParams {
  node: PcashNodeClient;
  sender: { wallet: PcashProfile; signer: PcashActionSigner };
  contract: { body: Uint8Array; address: bigint };
  validUntilTimestamp?: bigint;
}

/** Prove an all-dummy type-0x00 action that ensures the contract exists. */
export async function buildAttachedContractCreation(params: AttachedContractPublicationParams): Promise<Uint8Array> {
  const snapshot = await params.node.getWitnessSnapshot({ accounts: [addressHex(params.sender.wallet.address)] });
  const path = snapshot.accounts[0]!;
  if (path.status !== "present") throw new Error("publication fixture requires an existing sender account");
  const status = snapshot.status;
  const build = buildMineAction({
    chainId: status.pcashChainId,
    network: networkConfigFromStatus(status),
    wallet: params.sender.wallet,
    ...snapshotFromAccountProof(path),
    accountSiblings: path.status === "present" ? path.accountSiblings : [],
    accountRevision: path.status === "present" ? path.account.accountRevision : 0n,
    receiveKeyHash: path.status === "present" ? BigInt(path.account.receiveKeyHash) : 0n,
    issuanceOwnerCommitment: 0n,
    validUntilTimestamp: params.validUntilTimestamp ?? status.latestBlockTimestamp + 1_800n,
    accountCreation: { kind: "contract", body: params.contract.body },
    sender: { outgoingKey: params.sender.wallet.outgoingKey },
  });
  const proof = await proveTransferTransactionChonk({
    build,
    authorizationPackage: "account_rule_mine",
    authorizationWitnessMap: build.accountRuleWitnessMap!,
    resolve: createReleaseChonkCircuitResolver(),
    backend: nativeChonkBackend(),
  });
  return build.encodeTransaction(proof.proof);
}
