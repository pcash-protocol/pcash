import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { mnemonicToAccount } from "viem/accounts";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import {
  decryptEnvelope,
  encryptEnvelope,
  payoutSeed,
  receiveKeyHash,
  type NetworkConfigLike,
} from "@pcash/sdk/protocol";
import { fieldToHex } from "@pcash/sdk/crypto";
import { toHex, utf8 } from "@pcash/sdk/utils";
import { assertPcashProfileMatchesAccount, derivePcashProfileFromPrivateKey } from "../../src/wallet/externalIdentity.ts";
import {
  deriveSeedWalletIdentity,
  generateWalletMnemonic,
  normalizeWalletMnemonic,
  validateWalletMnemonic,
} from "../../src/wallet/seedIdentity.ts";
import { isSpendableWallet } from "../../src/wallet/walletCapabilities.ts";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import vector from "./fixtures/seed-identity.json";

const MNEMONIC = `${"abandon ".repeat(23)}art`;
const NETWORK: NetworkConfigLike = {
  pcashChainId: 123456n,
  l1ChainId: 11155111n,
  inboxAddress: "0x1111111111111111111111111111111111111111",
};

describe("seed wallet identity", () => {
  it("preserves the frozen mnemonic-to-profile derivation", () => {
    const { privateKey, profile } = deriveSeedWalletIdentity(MNEMONIC, NETWORK);
    expect({
      privateKey: toHex(privateKey),
      address: `0x${profile.address.toString(16).padStart(40, "0")}`,
      pubX: toHex(profile.pubX),
      pubY: toHex(profile.pubY),
      nkRoot: fieldToHex(profile.nkRoot),
      nullifierKeyCommitment: fieldToHex(profile.nullifierKeyCommitment),
      mlKemPublicKeySha256: toHex(sha256(profile.mlKemPublicKey)),
      mlKemSecretKeySha256: toHex(sha256(profile.mlKemSecretKey)),
      applicationSeed: toHex(profile.applicationSeed),
      payoutSeed: fieldToHex(payoutSeed(profile.nkRoot)),
      defaultUserRuleSecrets: Object.fromEntries(Object.entries(profile.defaultUserRuleSecrets)
        .map(([name, value]) => [name, fieldToHex(BigInt(value))])),
    }).toEqual(vector);
    expect(profile.recoveryContract).toBe("seed-derived");
    expect("privateKey" in profile).toBe(false);
  });

  it("restores the mainstream Ethereum account without reproducing privacy secrets from that key", () => {
    const { privateKey, profile } = deriveSeedWalletIdentity(MNEMONIC, NETWORK);
    expect(profile.address).toBe(BigInt(mnemonicToAccount(MNEMONIC).address));
    const ethereumProfile = derivePcashProfileFromPrivateKey(privateKey, NETWORK);
    expect(ethereumProfile.address).toBe(profile.address);
    expect(ethereumProfile.nkRoot).not.toBe(profile.nkRoot);
    expect(ethereumProfile.mlKemSecretKey).not.toEqual(profile.mlKemSecretKey);
    expect(ethereumProfile.applicationSeed).not.toEqual(profile.applicationSeed);
    for (const name of Object.keys(profile.defaultUserRuleSecrets) as (keyof typeof profile.defaultUserRuleSecrets)[]) {
      expect(ethereumProfile.defaultUserRuleSecrets[name]).not.toBe(profile.defaultUserRuleSecrets[name]);
    }
  });

  it("separates each PCASH chain's privacy material while preserving the Ethereum account", () => {
    const identity = deriveSeedWalletIdentity(MNEMONIC, NETWORK);
    const other = deriveSeedWalletIdentity(MNEMONIC, { ...NETWORK, pcashChainId: 123457n });
    expect(other.privateKey).toEqual(identity.privateKey);
    expect(other.profile.nkRoot).not.toBe(identity.profile.nkRoot);
    expect(other.profile.mlKemPublicKey).not.toEqual(identity.profile.mlKemPublicKey);
    expect(other.profile.applicationSeed).not.toEqual(identity.profile.applicationSeed);
    expect(other.profile.defaultUserRuleSecrets).not.toEqual(identity.profile.defaultUserRuleSecrets);
  });

  it("preserves the profile when only the L1 chain or inbox changes", () => {
    const identity = deriveSeedWalletIdentity(MNEMONIC, NETWORK);
    for (const network of [
      { ...NETWORK, l1ChainId: 1n },
      { ...NETWORK, inboxAddress: "0x2222222222222222222222222222222222222222" },
    ]) {
      expect(deriveSeedWalletIdentity(MNEMONIC, network)).toEqual(identity);
    }
  });

  it("restores installed rules and decrypts with a freshly reconstructed profile", () => {
    const { privateKey, profile } = deriveSeedWalletIdentity(MNEMONIC, NETWORK);
    const rules = defaultUserAccountRuleSet({
      wallet: profile, network: NETWORK,
      secrets: profile.defaultUserRuleSecrets,
    });
    const restored = deriveSeedWalletIdentity(MNEMONIC, NETWORK).profile;
    expect(assertPcashProfileMatchesAccount(restored, {
      address: `0x${profile.address.toString(16).padStart(40, "0")}`,
      accountKind: 0,
      nullifierKeyCommitment: fieldToHex(profile.nullifierKeyCommitment),
      accountRuleSetCommitment: fieldToHex(rules.accountRuleSetCommitment),
      receiveKeyHash: fieldToHex(receiveKeyHash(profile.mlKemPublicKey)),
    }, NETWORK).accountRuleSetCommitment).toBe(rules.accountRuleSetCommitment);
    const plaintext = utf8("seed-wallet recovery");
    const encrypted = encryptEnvelope(profile.mlKemPublicKey, plaintext);
    expect(decryptEnvelope(restored.mlKemSecretKey, encrypted)).toEqual(plaintext);
    expect(isSpendableWallet({ profile: restored, signer: privateKeyPcashActionSigner(privateKey) })).toBe(true);
  });
});

describe("wallet mnemonic", () => {
  it("generates valid 24-word English phrases", () => {
    const mnemonic = generateWalletMnemonic();
    expect(mnemonic.split(" ")).toHaveLength(24);
    expect(validateWalletMnemonic(mnemonic)).toBe(true);
  });

  it("normalizes copied phrases before validation and derivation", () => {
    const copied = ` \n${MNEMONIC.toUpperCase().replaceAll(" ", "\t \n")} \n`;
    expect(normalizeWalletMnemonic(copied)).toBe(MNEMONIC);
    expect(validateWalletMnemonic(copied)).toBe(true);
    expect(deriveSeedWalletIdentity(copied, NETWORK)).toEqual(deriveSeedWalletIdentity(MNEMONIC, NETWORK));
  });

  it.each([
    "",
    `${"abandon ".repeat(11)}about`,
    "abandon ".repeat(24).trim(),
    `${"abandon ".repeat(23)}notaword`,
  ])("rejects missing, short or invalid recovery phrases", (mnemonic) => {
    expect(validateWalletMnemonic(mnemonic)).toBe(false);
    expect(() => deriveSeedWalletIdentity(mnemonic, NETWORK)).toThrow("24-word English BIP-39");
  });
});
