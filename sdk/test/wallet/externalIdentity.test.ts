// Canonical PCASH profile derivation.
//
// The first test checks that the typed data a viem signer forwards to a browser
// wallet (without an explicit EIP712Domain type) hashes to exactly the digest
// the profile is derived from.

import { describe, expect, it } from "vitest";
import { hashTypedData, recoverAddress as viemRecoverAddress } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  PROFILE_DERIVATION_CONTEXT,
  assertPcashProfileMatchesAccount,
  assertPcashProfileMatchesAccountIdentity,
  derivePcashProfileFromPrivateKey,
  derivePcashProfileFromSignature,
  profileDerivationSigningRequest,
  requestPcashProfile,
} from "../../src/wallet/externalIdentity.ts";
import { DEFAULT_NETWORK_CONFIG, resolveNetworkConfig, type NetworkConfigLike } from "@pcash/sdk/protocol";
import { deriveWalletIdentity } from "@pcash/sdk/eip712";
import { nullifierKeyCommitment, receiveKeyHash } from "@pcash/sdk/protocol";
import { fieldToHex } from "@pcash/sdk/crypto";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import { keccak256 } from "@pcash/sdk/utils";

const NETWORK = resolveNetworkConfig(DEFAULT_NETWORK_CONFIG);
const PRIV = Uint8Array.from({ length: 32 }, (_, i) => (i + 1) & 0xff);
const IDENTITY = deriveWalletIdentity(PRIV);
const SECP256K1_SCALAR_ORDER = secp256k1.Point.Fn.ORDER;

const keyDerivationTypedData = (network: NetworkConfigLike, account: bigint) =>
  profileDerivationSigningRequest(network, account).typedData;
const keyDerivationDigest = (network: NetworkConfigLike, account: bigint) =>
  profileDerivationSigningRequest(network, account).digest;

const hex = (bytes: Uint8Array): `0x${string}` =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
const word = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;

/** Sign a digest the way a wallet does, returning `r ‖ s ‖ v` with v in {27,28}. */
function walletSignature(
  digest: Uint8Array,
  v27 = true,
  privateKey: Uint8Array = PRIV,
): Uint8Array {
  const sig = secp256k1.sign(digest, privateKey, { prehash: false });
  const out = new Uint8Array(65);
  out.set(sig.toBytes("compact"), 0);
  out[64] = v27 ? 27 + sig.recovery : sig.recovery;
  return out;
}

function scalarBytes(value: bigint): Uint8Array {
  const encoded = value.toString(16).padStart(64, "0");
  return Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(encoded.slice(i * 2, i * 2 + 2), 16));
}

function highSTwin(signature: Uint8Array): Uint8Array {
  const high = signature.slice();
  const lowS = BigInt(hex(signature.slice(32, 64)));
  high.set(scalarBytes(SECP256K1_SCALAR_ORDER - lowS), 32);
  const v = signature[64]!;
  high[64] = v >= 27 ? 27 + ((v - 27) ^ 1) : v ^ 1;
  return high;
}

function withScalar(signature: Uint8Array, offset: 0 | 32, value: bigint): Uint8Array {
  const changed = signature.slice();
  changed.set(scalarBytes(value), offset);
  return changed;
}

describe("canonical PCASH profile", () => {
  it("emits typed data that hashes to the digest the SDK derives from", () => {
    const typedData = keyDerivationTypedData(NETWORK, IDENTITY.address);
    // viem hashes the typed data exactly as eth_signTypedData_v4 would.
    const walletDigest = hashTypedData({
      domain: typedData.domain as never,
      types: { PcashKeyDerivation: typedData.types.PcashKeyDerivation },
      primaryType: "PcashKeyDerivation",
      message: typedData.message as never,
    });
    expect(walletDigest).toBe(hex(keyDerivationDigest(NETWORK, IDENTITY.address)));
  });

  it("puts the L1 chain id in the domain and the PCASH chain id in the message", () => {
    const typedData = keyDerivationTypedData(NETWORK, IDENTITY.address);
    expect(BigInt(typedData.domain.chainId)).toBe(NETWORK.l1ChainId);
    expect(BigInt(typedData.message.pcashChainId)).toBe(NETWORK.pcashChainId);
    expect(typedData.message.context).toBe(PROFILE_DERIVATION_CONTEXT);
  });

  it("recovers the signing account from a wallet signature over the typed data", async () => {
    const digest = keyDerivationDigest(NETWORK, IDENTITY.address);
    const signature = walletSignature(digest);
    const recovered = await viemRecoverAddress({ hash: hex(digest), signature: hex(signature) });
    expect(BigInt(recovered)).toBe(IDENTITY.address);
  });

  it("derives every value an account needs, and derives them stably", () => {
    const digest = keyDerivationDigest(NETWORK, IDENTITY.address);
    const signature = walletSignature(digest);

    const first = derivePcashProfileFromSignature(signature, NETWORK, IDENTITY.address);
    const second = derivePcashProfileFromSignature(signature, NETWORK, IDENTITY.address);

    expect(first.recoveryContract).toBe("ethereum-signature-derived");
    expect(first.nkRoot).toBe(second.nkRoot);
    expect(first.mlKemPublicKey).toEqual(second.mlKemPublicKey);
    expect(first.mlKemSecretKey).toEqual(second.mlKemSecretKey);
    expect(first.pubX).toEqual(IDENTITY.pubX);
    expect(first.pubY).toEqual(IDENTITY.pubY);
    expect("privKey" in first).toBe(false);
    expect(first.nkRoot).not.toBe(0n);
    // Distinct salt labels must give independent values from the shared IKM.
    expect(first.nkRoot).not.toBe(first.defaultUserRuleSecrets.paymentCommitmentBlinder);
    expect(first.address).toBe(IDENTITY.address);
    expect(first.applicationSeed).toHaveLength(32);
    expect(first.applicationSeed).toEqual(second.applicationSeed);
    expect(first.defaultUserRuleSecrets).toEqual(second.defaultUserRuleSecrets);
    // One salt and one blinder per default rule, every scalar independent.
    const ruleSecrets = Object.values(first.defaultUserRuleSecrets);
    expect(new Set(ruleSecrets)).toHaveLength(ruleSecrets.length);
    expect(Object.values(first.defaultUserRuleSecrets).every((value) => value !== 0n)).toBe(true);
    // The application seed must not be nullifier material wearing a hat.
    expect(BigInt(`0x${Array.from(first.applicationSeed, (b) => b.toString(16).padStart(2, "0")).join("")}`))
      .not.toBe(first.nkRoot);
    expect(first.nullifierKeyCommitment).toBe(nullifierKeyCommitment(first.nkRoot));

    const firstRules = defaultUserAccountRuleSet({
      wallet: first,
      network: NETWORK,
      secrets: first.defaultUserRuleSecrets,
    });
    const secondRules = defaultUserAccountRuleSet({
      wallet: second,
      network: NETWORK,
      secrets: second.defaultUserRuleSecrets,
    });
    expect(firstRules.accountRuleSetCommitment).toBe(secondRules.accountRuleSetCommitment);
    expect(keccak256(first.mlKemPublicKey)).toEqual(keccak256(second.mlKemPublicKey));
  });

  it("derives through the same async signer boundary used by browser wallets", async () => {
    const direct = derivePcashProfileFromSignature(
      walletSignature(keyDerivationDigest(NETWORK, IDENTITY.address)),
      NETWORK,
      IDENTITY.address,
    );
    await expect(requestPcashProfile(privateKeyPcashActionSigner(PRIV), NETWORK)).resolves.toEqual(
      direct,
    );
    expect(derivePcashProfileFromPrivateKey(PRIV, NETWORK)).toEqual(direct);
  });

  it("reconstructs every immutable user-account commitment before wallet use", () => {
    const profile = derivePcashProfileFromPrivateKey(PRIV, NETWORK);
    const rules = defaultUserAccountRuleSet({
      wallet: profile,
      network: NETWORK,
      secrets: profile.defaultUserRuleSecrets,
    });
    const account = {
      address: `0x${profile.address.toString(16).padStart(40, "0")}`,
      nullifierKeyCommitment: word(profile.nullifierKeyCommitment),
      accountRuleSetCommitment: word(rules.accountRuleSetCommitment),
      accountKind: 0,
      receiveKeyHash: fieldToHex(receiveKeyHash(profile.mlKemPublicKey)),
    };
    expect(assertPcashProfileMatchesAccount(profile, account, NETWORK).accountRuleSetCommitment)
      .toBe(rules.accountRuleSetCommitment);
    expect(() => assertPcashProfileMatchesAccount(profile, {
      ...account,
      nullifierKeyCommitment: word(profile.nullifierKeyCommitment + 1n),
    }, NETWORK)).toThrow("nullifier-key");
    expect(() => assertPcashProfileMatchesAccount(profile, {
      ...account,
      accountRuleSetCommitment: word(rules.accountRuleSetCommitment + 1n),
    }, NETWORK)).toThrow("default rule set");
    expect(() => assertPcashProfileMatchesAccountIdentity(profile, {
      ...account,
      accountRuleSetCommitment: word(rules.accountRuleSetCommitment + 1n),
    })).not.toThrow();
    expect(() => assertPcashProfileMatchesAccount(profile, {
      ...account,
      receiveKeyHash: `0x${"00".repeat(32)}`,
    }, NETWORK)).not.toThrow();
  });

  it("rejects a signature from any account other than the requested profile account", () => {
    const otherKey = Uint8Array.from({ length: 32 }, (_, i) => (i + 33) & 0xff);
    const digest = keyDerivationDigest(NETWORK, IDENTITY.address);
    expect(() =>
      derivePcashProfileFromSignature(
        walletSignature(digest, true, otherKey),
        NETWORK,
        IDENTITY.address,
      )
    ).toThrow("expected");
  });

  it("normalizes the recovery byte so 27/28 and 0/1 wallets agree", () => {
    const digest = keyDerivationDigest(NETWORK, IDENTITY.address);
    const legacy = derivePcashProfileFromSignature(walletSignature(digest, true), NETWORK, IDENTITY.address);
    const parity = derivePcashProfileFromSignature(walletSignature(digest, false), NETWORK, IDENTITY.address);
    // Same wallet, different v convention, same PCASH identity — otherwise a
    // user's balance would depend on which wallet they connected with.
    expect(parity.nkRoot).toBe(legacy.nkRoot);
    expect(parity.mlKemPublicKey).toEqual(legacy.mlKemPublicKey);
  });

  it("derives the same full identity from equivalent low-s and high-s signatures", () => {
    const digest = keyDerivationDigest(NETWORK, IDENTITY.address);
    for (const v27 of [true, false]) {
      const low = walletSignature(digest, v27);
      const high = highSTwin(low);
      expect(derivePcashProfileFromSignature(high, NETWORK, IDENTITY.address)).toEqual(
        derivePcashProfileFromSignature(low, NETWORK, IDENTITY.address),
      );
    }
  });

  it("binds both the authorization and derived profile to the PCASH chain", () => {
    const digest = keyDerivationDigest(NETWORK, IDENTITY.address);
    const signature = walletSignature(digest);
    const here = derivePcashProfileFromSignature(signature, NETWORK, IDENTITY.address);
    const otherNetwork = {
      ...DEFAULT_NETWORK_CONFIG,
      pcashChainId: NETWORK.pcashChainId + 1n,
    };
    expect(() => derivePcashProfileFromSignature(signature, otherNetwork, IDENTITY.address)).toThrow(
      "expected",
    );
    const elsewhere = derivePcashProfileFromSignature(
      walletSignature(keyDerivationDigest(otherNetwork, IDENTITY.address)),
      otherNetwork,
      IDENTITY.address,
    );
    expect(elsewhere.nkRoot).not.toBe(here.nkRoot);
  });

  it("accepts 0x-hex signatures as wallets return them", () => {
    const digest = keyDerivationDigest(NETWORK, IDENTITY.address);
    const signature = walletSignature(digest);
    expect(derivePcashProfileFromSignature(hex(signature), NETWORK, IDENTITY.address).nkRoot).toBe(
      derivePcashProfileFromSignature(signature, NETWORK, IDENTITY.address).nkRoot,
    );
  });

  it("rejects malformed signatures rather than deriving a wrong identity", () => {
    expect(() => derivePcashProfileFromSignature(new Uint8Array(64), NETWORK, IDENTITY.address)).toThrow(
      "65 bytes",
    );
    const badV = walletSignature(keyDerivationDigest(NETWORK, IDENTITY.address));
    badV[64] = 9;
    expect(() => derivePcashProfileFromSignature(badV, NETWORK, IDENTITY.address)).toThrow(
      "unusable recovery byte",
    );
    const signature = walletSignature(keyDerivationDigest(NETWORK, IDENTITY.address));
    for (const [component, offset, value] of [
      ["r", 0, 0n],
      ["r", 0, SECP256K1_SCALAR_ORDER],
      ["s", 32, 0n],
      ["s", 32, SECP256K1_SCALAR_ORDER],
    ] as const) {
      expect(() =>
        derivePcashProfileFromSignature(withScalar(signature, offset, value), NETWORK, IDENTITY.address),
      ).toThrow(`profile-derivation signature ${component} is outside the secp256k1 scalar range`);
    }
  });
});
