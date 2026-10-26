import type { PreparedEvent } from "../src/protocol/events.ts";
import { authorizePcashRequestWithPrivateKey } from "../src/eip712/authorization.ts";
import { prepareUserAccountUpdate } from "../src/builders/accountUpdate.ts";
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
