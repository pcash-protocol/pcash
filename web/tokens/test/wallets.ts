// Deterministic USER profiles with the default reference rule set installed.

import { addressFromPublicKeyXY, publicKeyXY } from "@pcash/sdk/eip712";
import {
  assetDefinitionAssetId,
  assetSecretCommitment,
  generateMlKemKeyPair,
  noteBodyCommitment,
  ownerCommitment,
  receiveKeyHash,
  type AssetDefinition,
  type WalletProfile,
} from "@pcash/sdk/protocol";
import {
  defaultUserAccountRuleSet,
  generateDefaultUserRuleSecrets,
  type DefaultUserAccountRule,
  type DefaultUserAccountRuleSet,
  type DefaultUserRuleSecrets,
} from "@pcash/sdk/rules";
import type { AssetAccountAuthorization } from "@pcash/sdk/builders";
import { concatBytes } from "@pcash/sdk/utils";
import type { SyntheticChain } from "./chain.ts";

export interface TestUser extends WalletProfile {
  privKey: Uint8Array;
  mlKemPublicKey: Uint8Array;
  mlKemSecretKey: Uint8Array;
  secrets: DefaultUserRuleSecrets;
  rules: DefaultUserAccountRuleSet;
}

export function testUser(seed: number): TestUser {
  const privKey = new Uint8Array(32).fill(seed);
  const { x, y } = publicKeyXY(privKey);
  const address = addressFromPublicKeyXY(concatBytes(x, y));
  const nkRoot = 0x5eed0000n + BigInt(seed);
  const mlKem = generateMlKemKeyPair(new Uint8Array(64).fill(seed));
  const secrets = Object.fromEntries(Object.keys(generateDefaultUserRuleSecrets())
    .map((key, index) => [key, BigInt(seed) * 0x1000n + BigInt(index) + 1n])) as unknown as DefaultUserRuleSecrets;
  const wallet = {
    privKey,
    pubX: x,
    pubY: y,
    address,
    nkRoot,
    mlKemPublicKey: mlKem.publicKey,
    mlKemSecretKey: mlKem.secretKey,
  };
  return { ...wallet, secrets, rules: defaultUserAccountRuleSet({ wallet, secrets }) };
}

/** A note a user already holds, appended as an earlier transaction would have. */
export function giveNote(chain: SyntheticChain, user: TestUser, assetId: bigint, amount: bigint, noteSecret: bigint): { leafIndex: number; noteSecret: bigint; amount: bigint } {
  const leafIndex = chain.appendBody(noteBodyCommitment(ownerCommitment(user.address, noteSecret), assetId, amount));
  return { leafIndex, noteSecret, amount };
}

/** Register the user in the chain's account tree with its default rules. */
export function registerUser(chain: SyntheticChain, user: TestUser): number {
  return chain.addUser(user, user.rules.accountRuleSetCommitment);
}

/** The user's authenticated opening under one of its default rules at the chain head. */
export function userAuthorization(chain: SyntheticChain, user: TestUser, rule: DefaultUserAccountRule): AssetAccountAuthorization {
  const index = chain.accountsByAddress.get(user.address)!.index;
  return {
    address: user.address,
    nkRoot: user.nkRoot,
    accountIndex: index,
    accountSiblings: chain.accountSiblings(index),
    accountRuleSetCommitment: user.rules.accountRuleSetCommitment,
    accountKind: 0n,
    accountRevision: 1n,
    receiveKeyHash: receiveKeyHash(user.mlKemPublicKey),
    rule: {
      configurationCommitment: rule.configurationCommitment,
      commitmentBlinder: rule.commitmentBlinder,
      entryIndex: rule.entryIndex,
      siblings: rule.siblings,
    },
  };
}

/** A standard asset definition and the asset ID it derives. */
export function testToken(seed: bigint): { definition: AssetDefinition; assetId: bigint } {
  const definition: AssetDefinition = {
    initialSupply: 1_000_000n,
    assetSecretCommitment: assetSecretCommitment(seed + 2n),
    metadata: { name: "Foo", symbol: "FOO", decimals: 6, contentDigest: new Uint8Array(32).fill(Number(seed % 251n)) },
  };
  return { definition, assetId: assetDefinitionAssetId(definition) };
}
