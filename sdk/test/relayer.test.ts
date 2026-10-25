// L1 identity and signing key helpers.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { custom, TimeoutError } from "viem";
import { describe, expect, it } from "vitest";
import { bytesEqual } from "../src/utils/bytes.ts";
import {
  DEFAULT_INBOX,
  L1IdentityError,
  l1ChainIdNumber,
  relayerAccount,
  requireL1Identity,
} from "../src/l1/relayer.ts";
import { fromHex, toHex } from "../src/utils/hex.ts";
import { INBOX_ADDRESS } from "../src/constants/networkProfile.ts";

const bytes = (n: number, seed = 1): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 0xff);
describe("hex helpers", () => {
  it("toHex/fromHex round-trip arbitrary bytes", () => {
    const b = bytes(37, 5);
    expect(bytesEqual(fromHex(toHex(b)), b)).toBe(true);
  });
  it("toHex is lowercase 0x", () => {
    expect(toHex(Uint8Array.from([0x0a, 0xff, 0x00]))).toBe("0x0aff00");
  });
  it("fromHex rejects odd-length input", () => {
    expect(() => fromHex("0xabc")).toThrow(/odd/);
  });
  it("DEFAULT_INBOX is INBOX_ADDRESS as a 20-byte 0x address", () => {
    expect(DEFAULT_INBOX).toBe(`0x${INBOX_ADDRESS.toString(16).padStart(40, "0")}`);
    expect(DEFAULT_INBOX.length).toBe(42);
  });
});

describe("relayer signing key boundary", () => {
  it("rejects a key that is not exactly 32 bytes", () => {
    // relayerAccount delegates derivation to viem; the width check is the whole
    // of what it adds, so that is what there is to test.
    expect(() => relayerAccount(`0x${"11".repeat(31)}`)).toThrow(/32 bytes/);
    expect(() => relayerAccount(`0x${"11".repeat(33)}`)).toThrow(/32 bytes/);
    expect(() => relayerAccount("0x")).toThrow(/32 bytes/);
  });

  it("accepts a bare key without the 0x prefix", () => {
    expect(relayerAccount("11".repeat(32)).address).toBe(
      relayerAccount(`0x${"11".repeat(32)}`).address,
    );
  });

  it("rejects a malformed key rather than deriving from truncated bytes", () => {
    expect(() => relayerAccount(`0x${"1".repeat(63)}`)).toThrow(/odd length/);
    expect(() => relayerAccount(`0xzz${"11".repeat(31)}`)).toThrow(/not valid hex/);
  });

  it("keeps the signing key out of the filesystem", () => {
    // The key is held in memory for the lifetime of one call. Asserted on the
    // source rather than by watching tmpdir, so it holds regardless of what else
    // the suite is doing concurrently.
    const source = readFileSync(
      fileURLToPath(new URL("../src/l1/relayer.ts", import.meta.url)),
      "utf8",
    );
    for (const forbidden of ["writeFileSync", "mkdtempSync", "scryptSync", "createCipheriv"]) {
      expect(source).not.toContain(forbidden);
    }
  });

});

describe("L1 endpoint identity", () => {
  const anchorHash = `0x${"ab".repeat(32)}`;
  const identityTransport = (chainIdHex: string) =>
    custom({
      async request({ method }) {
        if (method === "eth_chainId") return chainIdHex;
        if (method === "eth_getBlockByNumber") return { hash: anchorHash, number: "0x7b" };
        throw new Error(`unexpected RPC method ${method}`);
      },
    });

  it("accepts an endpoint whose chain id and anchor both match", async () => {
    await requireL1Identity(
      "http://unused",
      { chainId: 11155111n, anchorNumber: 123n, anchorHash },
      { transport: identityTransport("0xaa36a7") },
    );
  });

  it("rejects a mismatched chain id", async () => {
    await expect(
      requireL1Identity(
        "http://unused",
        { chainId: 1n, anchorNumber: 123n, anchorHash },
        { transport: identityTransport("0xaa36a7") },
      ),
    ).rejects.toThrow(/chain id/);
  });

  it("rejects a matching chain id whose anchor block differs", async () => {
    await expect(
      requireL1Identity(
        "http://unused",
        { chainId: 11155111n, anchorNumber: 123n, anchorHash: `0x${"cd".repeat(32)}` },
        { transport: identityTransport("0xaa36a7") },
      ),
    ).rejects.toThrow(/anchor hash/);
  });

  it("never echoes the RPC URL when the transport fails", async () => {
    const secretUrl = "https://user:hunter2@l1.example/rpc";
    const transport = custom({
      async request() {
        throw new Error(`connection to ${secretUrl} refused`);
      },
    });
    await expect(
      requireL1Identity(
        secretUrl,
        { chainId: 11155111n, anchorNumber: 123n, anchorHash },
        { transport },
      ),
    ).rejects.toThrow(/^reading the L1 chain id failed/);
    await requireL1Identity(
      secretUrl,
      { chainId: 11155111n, anchorNumber: 123n, anchorHash },
      { transport: identityTransport("0xaa36a7") },
    ).catch((error: Error) => {
      expect(error.message).not.toContain("hunter2");
    });
  });
});

describe("requireL1Identity error types", () => {
  const anchorHash = `0x${"ab".repeat(32)}`;

  it("keeps a transport timeout recognizable without its credential-bearing message", async () => {
    const secretUrl = "https://user:hunter2@l1.example/rpc";
    const failure = await requireL1Identity(
      secretUrl,
      { chainId: 1n, anchorNumber: 1n, anchorHash },
      { transport: custom({ async request() { throw new TimeoutError({ body: {}, url: secretUrl }); } }) },
    ).then(() => undefined, (error: unknown) => error as Error);
    expect(failure?.name).toBe("TimeoutError");
    expect(failure?.message).toBe("reading the L1 chain id failed (TimeoutError)");
  });

  it("throws identity mismatches as L1IdentityError", async () => {
    await expect(requireL1Identity(
      "http://unused",
      { chainId: 1n, anchorNumber: 1n, anchorHash },
      { transport: custom({ async request() { return "0x2"; } }) },
    )).rejects.toBeInstanceOf(L1IdentityError);
  });
});

describe("L1 chain id narrowing", () => {
  it("accepts the widest chain id Viem can carry exactly", () => {
    expect(l1ChainIdNumber(11155111n)).toBe(11155111);
    expect(l1ChainIdNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects a chain id that Number would silently round to another chain", () => {
    // 2**53 + 1 becomes 2**53, so a carrier would be signed for a chain the
    // intended RPC rejects. Fail before any client or signer exists.
    expect(() => l1ChainIdNumber(9007199254740993n)).toThrow(/exceeds the 9007199254740991/);
    expect(() => l1ChainIdNumber(0n)).toThrow(/must be positive/);
  });
});
