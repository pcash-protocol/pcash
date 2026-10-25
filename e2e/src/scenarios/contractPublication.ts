// A sponsored contract-account creation carries a fee section, so publishing
// one means proving a sponsorship from a user account that already exists. A
// zero-fee publication spends nothing: every input slot is a dummy and the
// sponsor signs the exact zero-fee action. It pays no publisher, so it is
// published directly on Ethereum or by a relayer that sponsors unpaid entries.

import { requestPcashAuthorization, type PcashActionSigner } from "@pcash/sdk/eip712";
import { prepareSponsoredContractCreation, snapshotFromAccountProof } from "@pcash/sdk/builders";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import { networkConfigFromStatus } from "@pcash/sdk/protocol";
import { ACCOUNT_KIND_USER } from "@pcash/sdk/constants";
import {
  createReleaseChonkCircuitResolver,
  nativeChonkBackend,
} from "@pcash/sdk/node";
import { proveSponsoredContractCreationChonk } from "@pcash/sdk/prover";
import { addressHex } from "@pcash/sdk/utils";
import type { PcashProfile } from "../deps.ts";

export interface SponsoredContractPublicationParams {
  node: PcashNodeClient;
  /** The user account that authorizes the creation and pays its fee. */
  sponsor: { wallet: PcashProfile; signer: PcashActionSigner };
  contract: { body: Uint8Array; address: bigint };
  /** Defaults to a zero fee paid from all-dummy input slots. */
  openFeeAmount?: bigint;
  validUntilTimestamp?: bigint;
}

const DEFAULT_VALIDITY_WINDOW = 1_800n;

/** Build, authorize, and prove the exact type-0x02 bytes for one creation. */
export async function buildSponsoredContractCreation(
  params: SponsoredContractPublicationParams,
): Promise<Uint8Array> {
  const openFeeAmount = params.openFeeAmount ?? 0n;
  if (openFeeAmount !== 0n) {
    throw new Error("this helper publishes zero-fee creations; fund a wallet flow for a paid one");
  }
  const sponsorAddress = addressHex(params.sponsor.wallet.address);
  const snapshot = await params.node.getWitnessSnapshot({ accounts: [sponsorAddress] });
  const accountPath = snapshot.accounts[0]!;
  if (accountPath.status !== "present") {
    throw new Error(`contract sponsor ${sponsorAddress} has no authenticated account`);
  }
  const status = snapshot.status;
  const network = networkConfigFromStatus(status);
  const rules = defaultUserAccountRuleSet({
    wallet: params.sponsor.wallet,
    network,
    secrets: params.sponsor.wallet.defaultUserRuleSecrets,
  });
  const build = prepareSponsoredContractCreation({
    network,
    contract: params.contract,
    sponsor: {
      address: params.sponsor.wallet.address,
      nkRoot: params.sponsor.wallet.nkRoot,
      accountIndex: Number(accountPath.account.index),
      accountSiblings: accountPath.accountSiblings,
      accountRuleSetCommitment: rules.accountRuleSetCommitment,
      accountKind: ACCOUNT_KIND_USER,
      accountRevision: accountPath.account.accountRevision,
      receiveKeyHash: BigInt(accountPath.account.receiveKeyHash),
      rule: rules.contractFeeSponsorshipRule,
    },
    sponsorWallet: params.sponsor.wallet,
    snapshot: snapshotFromAccountProof(accountPath),
    fee: {
      openFeeAmount,
      validUntilTimestamp: params.validUntilTimestamp
        ?? status.latestBlockTimestamp + DEFAULT_VALIDITY_WINDOW,
      inputs: [],
    },
  });
  const authorization = build.authorizeReadableEcdsa(
    await requestPcashAuthorization(params.sponsor.signer, build.authorizationRequest),
  );
  const proof = await proveSponsoredContractCreationChonk({
    build,
    authorizationPackage: "account_rule_contract_fee_sponsorship_ecdsa",
    authorizationWitnessMap: authorization.witnessMap,
    resolve: createReleaseChonkCircuitResolver(),
    backend: nativeChonkBackend(),
  });
  return build.encodeTransaction(proof.proof);
}
