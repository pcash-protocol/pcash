import type { PreparedEvent } from "../src/protocol/events.ts";
import { authorizePcashRequestWithPrivateKey } from "../src/eip712/authorization.ts";
import { prepareUserAccountUpdate } from "../src/builders/accountUpdate.ts";
import { prepareSponsoredContractCreation } from "../src/builders/contractCreation.ts";
import { ACCOUNT_KIND_USER } from "../src/constants/params.ts";
import { buildContractBody, functionSelector } from "../src/protocol/contract.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { receiveKeyHash } from "../src/protocol/account.ts";
import { defaultUserAccountRuleSet } from "../src/rules/referenceRules.ts";
import { feePaymentFixture, TEST_DEFAULT_RULE_SECRETS } from "@pcash/test-support/protocol-fixtures";
import { deriveTestWallet } from "./testWallet.ts";

function walletAndRules() {
  const wallet = deriveTestWallet({ mlKem: "deterministic" });
  const rules = defaultUserAccountRuleSet({
    wallet,
    network: DEFAULT_NETWORK_CONFIG,
    secrets: TEST_DEFAULT_RULE_SECRETS,
  });
  return { wallet, rules };
}

/** A user-account update authorized by the installed administration rule. */
export function userAccountUpdateFixture({ validUntilTimestamp = 1_000_000n, preparedEvent }: { validUntilTimestamp?: bigint; preparedEvent?: PreparedEvent } = {}) {
  const { wallet, rules } = walletAndRules();
  const fixture = feePaymentFixture({
    wallet,
    inputAmount: 1_000n,
    noteSecret: 0xbeefn,
    accountIndex: 7,
    accountRuleSetCommitment: rules.accountRuleSetCommitment,
    receiveKeyHash: receiveKeyHash(wallet.mlKemPublicKey),
  });
  const build = prepareUserAccountUpdate({
    ...(preparedEvent === undefined ? {} : { preparedEvent }),
    network: DEFAULT_NETWORK_CONFIG,
    current: {
      address: wallet.address,
      accountRevision: 1n,
      ruleSetCommitment: rules.accountRuleSetCommitment,
      receiveKey: { status: "available" as const, mlKemPublicKey: wallet.mlKemPublicKey },
    },
    nkRoot: wallet.nkRoot,
    proposed: {
      ruleSetCommitment: rules.accountRuleSetCommitment,
      receiveKey: { operation: "keep" as const },
    },
    recentPcashBlockHash: fixture.recentPcashBlockHash,
    validUntilTimestamp,
    snapshot: fixture.snapshot,
    fee: {
      openFeeAmount: 100n,
      inputs: fixture.inputs,
      receiveKey: wallet.mlKemPublicKey,
      dummyInputEntropy: 42n,
    },
    rule: {
      applicationVkHash: rules.accountAdminRule.applicationVkHash,
      configurationCommitment: rules.accountAdminRule.configurationCommitment,
      commitmentBlinder: rules.accountAdminRule.commitmentBlinder,
      entryIndex: rules.accountAdminRule.entryIndex,
      siblings: rules.accountAdminRule.siblings,
    },
    readableEcdsa: {
      signerAddress: wallet.address,
    },
  });
  const readable = build.authorizeReadableEcdsa!(
    authorizePcashRequestWithPrivateKey(wallet.privKey, build.authorizationRequest!),
  );
  return { build, authorizationPackage: "account_rule_admin_ecdsa", authorizationWitnessMap: readable.witnessMap };
}

/** A contract-account creation whose fee the sponsor's installed sponsorship rule pays. */
export function sponsoredContractCreationFixture({ validUntilTimestamp = 1_000_000n, preparedEvent }: { validUntilTimestamp?: bigint; preparedEvent?: PreparedEvent } = {}) {
  const { wallet, rules } = walletAndRules();
  const contract = buildContractBody({
    nullifierKey: { publishesNkRoot: true, nkRoot: 0x5151n },
    functions: [{ selector: functionSelector(0), applicationVkHash: 0x1234n, configurationCommitment: 0x5678n }],
  });
  const sponsorReceiveKeyHash = receiveKeyHash(wallet.mlKemPublicKey);
  const fixture = feePaymentFixture({
    wallet,
    inputAmount: 2_000n,
    noteSecret: 0xcafen,
    accountIndex: 7,
    accountRuleSetCommitment: rules.accountRuleSetCommitment,
    receiveKeyHash: sponsorReceiveKeyHash,
  });
  const build = prepareSponsoredContractCreation({
    ...(preparedEvent === undefined ? {} : { preparedEvent }),
    network: DEFAULT_NETWORK_CONFIG,
    contract: { body: contract.body, address: contract.address },
    sponsor: {
      address: wallet.address,
      nkRoot: wallet.nkRoot,
      accountIndex: fixture.accountIndex,
      accountSiblings: fixture.accountSiblings,
      accountRuleSetCommitment: rules.accountRuleSetCommitment,
      accountKind: ACCOUNT_KIND_USER,
      accountRevision: 1n,
      receiveKeyHash: sponsorReceiveKeyHash,
      rule: {
        configurationCommitment: rules.contractFeeSponsorshipRule.configurationCommitment,
        commitmentBlinder: rules.contractFeeSponsorshipRule.commitmentBlinder,
        entryIndex: rules.contractFeeSponsorshipRule.entryIndex,
        siblings: rules.contractFeeSponsorshipRule.siblings,
      },
    },
    sponsorWallet: wallet,
    sponsorReceiveKey: wallet.mlKemPublicKey,
    snapshot: { ...fixture.snapshot, recentPcashBlockHash: fixture.recentPcashBlockHash },
    fee: {
      openFeeAmount: 250n,
      validUntilTimestamp,
      inputs: fixture.inputs,
      dummyInputEntropy: 43n,
    },
  });
  const authorization = build.authorizeReadableEcdsa(
    authorizePcashRequestWithPrivateKey(wallet.privKey, build.authorizationRequest),
  );
  return {
    build,
    contract,
    authorizationPackage: "account_rule_contract_fee_sponsorship_ecdsa",
    authorizationWitnessMap: authorization.witnessMap,
  };
}
