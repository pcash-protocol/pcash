// The authorization boundary binds a signature to one exact typed-data digest
// and one authorizing account, whichever signer produced it.

import { describe, expect, it } from "vitest";
import {
  authorizePcashRequestWithPrivateKey,
  createPcashAuthorizationRequest,
  privateKeyPcashActionSigner,
  requestPcashAuthorization,
  requirePcashAuthorization,
  requireWalletAuthorization,
  verifyPcashAuthorization,
  type PcashActionSigner,
  type PcashAuthorizationRequest,
} from "../src/eip712/authorization.ts";
import { pcashSigningHash, pcashTypedData, serializeEcdsaSignature, signDigest } from "../src/eip712/eip712.ts";
import { DEFAULT_NETWORK_CONFIG } from "../src/protocol/network.ts";
import { deriveTestWallet } from "./testWallet.ts";

const key = (value: number): Uint8Array => {
  const bytes = new Uint8Array(32);
  bytes[31] = value;
  return bytes;
};
const wallet = deriveTestWallet();
const other = deriveTestWallet({ privKey: key(0x42) });
const fixtureTypedData = (seed: number) => pcashTypedData(DEFAULT_NETWORK_CONFIG, "PcashFixture(uint256 seed)", { seed });

function request(seed: number, authorizingAddress = wallet.address): PcashAuthorizationRequest {
  return createPcashAuthorizationRequest({
    kind: "fixture",
    authorizingAddress,
    typedData: fixtureTypedData(seed),
  });
}

describe("createPcashAuthorizationRequest", () => {
  it("derives the digest from the typed data", () => {
    expect(request(1).digest).toEqual(pcashSigningHash(fixtureTypedData(1)));
    expect(request(1).digest).not.toEqual(request(2).digest);
  });

  it("rejects an authorizing address wider than 160 bits", () => {
    expect(() => request(1, 1n << 160n)).toThrow(/authorizingAddress/);
  });
});

describe("verifyPcashAuthorization", () => {
  it("accepts the authorizing account's signature over the exact digest", () => {
    const req = request(1);
    const verified = verifyPcashAuthorization(req, serializeEcdsaSignature(signDigest(wallet.privKey, req.digest)));
    expect(verified.authorizingAddress).toBe(wallet.address);
    expect(verified.pubX).toEqual(wallet.pubX);
    expect(verified.pubY).toEqual(wallet.pubY);
  });

  it("rejects a signature by a different key, naming both addresses", () => {
    const req = request(1);
    const signature = serializeEcdsaSignature(signDigest(other.privKey, req.digest));
    expect(() => verifyPcashAuthorization(req, signature)).toThrow(
      /^fixture signature recovers 0x[0-9a-f]{40}, expected 0x[0-9a-f]{40}$/,
    );
  });

  it("rejects the right key over a different digest", () => {
    const signature = serializeEcdsaSignature(signDigest(wallet.privKey, request(2).digest));
    expect(() => verifyPcashAuthorization(request(1), signature)).toThrow(/signature recovers/);
  });
});

describe("requirePcashAuthorization", () => {
  it("rebinds witness material to the request it was verified for", () => {
    const req = request(1);
    const verified = authorizePcashRequestWithPrivateKey(wallet.privKey, req);
    const rebound = requirePcashAuthorization(req, verified);
    expect([rebound.r, rebound.s, rebound.yParity]).toEqual([verified.r, verified.s, verified.yParity]);
  });

  it("refuses to rebind an authorization onto a different digest", () => {
    const verified = authorizePcashRequestWithPrivateKey(wallet.privKey, request(1));
    expect(() => requirePcashAuthorization(request(2), verified)).toThrow(/signature recovers/);
  });

  it("refuses to rebind an authorization onto a different authorizing account", () => {
    const verified = authorizePcashRequestWithPrivateKey(wallet.privKey, request(1));
    expect(() => requirePcashAuthorization(request(1, other.address), verified)).toThrow(/signature recovers/);
  });

  it("refuses an authorization whose signature was replaced with a high-s twin", () => {
    const verified = authorizePcashRequestWithPrivateKey(wallet.privKey, request(1));
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    expect(() => requirePcashAuthorization(request(1), { ...verified, s: n - verified.s }))
      .toThrow(/low-s/);
  });
});

describe("requestPcashAuthorization", () => {
  it("rejects a signer whose address is not the authorizing account before asking it", async () => {
    let asked = false;
    const signer: PcashActionSigner = {
      address: other.address,
      async signTypedData() {
        asked = true;
        return new Uint8Array(65);
      },
    };
    await expect(requestPcashAuthorization(signer, request(1)))
      .rejects.toThrow(/selected PCASH signer does not match/);
    expect(asked).toBe(false);
  });

  it("rejects a signer that claims the right address but signs with another key", async () => {
    const signer: PcashActionSigner = {
      address: wallet.address,
      async signTypedData(req) {
        return serializeEcdsaSignature(signDigest(other.privKey, req.digest));
      },
    };
    await expect(requestPcashAuthorization(signer, request(1))).rejects.toThrow(/signature recovers/);
  });

  it("rejects a signer address wider than 160 bits", async () => {
    const signer = { ...privateKeyPcashActionSigner(wallet.privKey), address: 1n << 160n };
    await expect(requestPcashAuthorization(signer, request(1))).rejects.toThrow(/signer\.address/);
  });

  it("verifies a matching raw-key signer", async () => {
    const verified = await requestPcashAuthorization(privateKeyPcashActionSigner(wallet.privKey), request(1));
    expect(verified.authorizingAddress).toBe(wallet.address);
  });
});

describe("privateKeyPcashActionSigner", () => {
  it("derives the key's address and refuses requests for another account", async () => {
    const signer = privateKeyPcashActionSigner(other.privKey);
    expect(signer.address).toBe(other.address);
    await expect(signer.signTypedData(request(1, wallet.address)))
      .rejects.toThrow(/raw-key PCASH signer does not match/);
  });

  it("keeps its own copy of the key", async () => {
    const privKey = key(0x42);
    const signer = privateKeyPcashActionSigner(privKey);
    privKey.fill(0);
    const signature = await signer.signTypedData(request(1, other.address));
    expect(verifyPcashAuthorization(request(1, other.address), signature).authorizingAddress).toBe(other.address);
  });

  it("rejects an invalid private key up front", () => {
    expect(() => privateKeyPcashActionSigner(new Uint8Array(32))).toThrow();
  });
});

describe("requireWalletAuthorization", () => {
  const verified = authorizePcashRequestWithPrivateKey(wallet.privKey, request(1));

  it("accepts the wallet's own authorization", () => {
    expect(() => requireWalletAuthorization(wallet, verified, "payment")).not.toThrow();
  });

  it("rejects another account's authorization", () => {
    expect(() => requireWalletAuthorization(other, verified, "payment"))
      .toThrow(/^payment authorization does not match the wallet address$/);
  });

  it("rejects a profile whose public key does not match the recovered key", () => {
    const swappedY = { ...wallet, pubY: other.pubY };
    expect(() => requireWalletAuthorization(swappedY, verified, "payment"))
      .toThrow(/^payment authorization public key does not match the wallet profile$/);
    const swappedX = { ...wallet, pubX: other.pubX };
    expect(() => requireWalletAuthorization(swappedX, verified, "asset-burn"))
      .toThrow(/asset-burn authorization public key/);
  });
});
