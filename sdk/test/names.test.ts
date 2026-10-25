import { describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeErrorResult, encodeFunctionResult, namehash, parseAbi, zeroAddress } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { createEthereumNameResolver, normalizeIdentityName } from "../src/names/index.ts";

const address = "0x1234567890123456789012345678901234567890";
const gns = "0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6";
const wns = "0x0000000000696760E15f265e828DB644A0c242EB";
function fixture() {
  const client = createPublicClient({ chain: mainnet, transport: custom({ request: async () => { throw new Error("Unexpected RPC"); } }) });
  const forward = vi.spyOn(client, "getEnsAddress").mockResolvedValue(address);
  const reverse = vi.spyOn(client, "getEnsName").mockResolvedValue(null);
  const read = vi.spyOn(client, "readContract").mockResolvedValue("");
  const avatar = vi.spyOn(client, "getEnsAvatar").mockResolvedValue("https://example.com/avatar.png");
  return { resolver: createEthereumNameResolver({ client }), forward, reverse, read, avatar };
}

describe("Ethereum names", () => {
  it.each([["SUB.CAFE\u0301.gwei", "sub.café.gwei", gns, "gns"], ["alice.wei", "alice.wei", wns, "wns"]])("routes %s to its canonical registry", async (input, name, registry, system) => {
    const { resolver, read, forward } = fixture();
    read.mockResolvedValue(address);
    expect(await resolver.resolveName(input!)).toEqual({ address, name, system });
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ address: registry, functionName: "resolve", args: [BigInt(namehash(name!))] }));
    expect(forward).not.toHaveBeenCalled();
  });

  it.each(["alice.eth", "sub.café.eth", "example.com", "💩.eth"])("keeps ENS dotted namespace %s", async (name) => {
    const { resolver, forward, read } = fixture();
    expect(await resolver.resolveName(name)).toEqual({ address, name, system: "ens" });
    expect(forward).toHaveBeenCalledWith({ name });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects malformed user names and bare labels without RPC", async () => {
    const { resolver, read, forward } = fixture();
    for (const input of ["alice", "alice..wei", "a/b.gwei", ""]) {
      expect(normalizeIdentityName(input)).toBeUndefined();
      expect(await resolver.resolveName(input)).toBeNull();
    }
    expect(read).not.toHaveBeenCalled(); expect(forward).not.toHaveBeenCalled();
  });

  it("maps absent and expired forward records to null, but propagates RPC failures", async () => {
    const { resolver, read, forward } = fixture();
    read.mockResolvedValue(zeroAddress); forward.mockResolvedValue(null);
    for (const name of ["absent.wei", "expired.gwei", "absent.eth"]) expect(await resolver.resolveName(name)).toBeNull();
    read.mockRejectedValue(new Error("offline"));
    await expect(resolver.resolveName("alice.wei")).rejects.toThrow("offline");
  });

  it("prefers verified ENS, then GNS, then WNS, without duplicate forward reads", async () => {
    const { resolver, reverse, forward, read } = fixture();
    reverse.mockResolvedValueOnce("alice.eth");
    expect((await resolver.reverseAddress(address)).identity?.name).toBe("alice.eth");
    expect(read).not.toHaveBeenCalled(); expect(forward).not.toHaveBeenCalled();
    read.mockResolvedValueOnce("alice.gwei");
    expect((await resolver.reverseAddress(address)).identity?.system).toBe("gns");
    read.mockResolvedValueOnce("").mockResolvedValueOnce("sub.alice.wei");
    expect((await resolver.reverseAddress(address)).identity?.name).toBe("sub.alice.wei");
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ address: wns, functionName: "reverseResolve", args: [address] }));
    expect(forward).not.toHaveBeenCalled();
  });

  it("distinguishes absent names, partial success and failed lookups", async () => {
    const { resolver, reverse, read } = fixture();
    expect(await resolver.reverseAddress(address)).toEqual({ identity: null, complete: true });
    reverse.mockRejectedValue(new Error("offline"));
    read.mockResolvedValueOnce("alice.gwei");
    expect(await resolver.reverseAddress(address)).toEqual({ identity: { address, name: "alice.gwei", system: "gns" }, complete: false });
    await expect(resolver.reverseAddress(address)).rejects.toThrow("temporarily unavailable");
    read.mockRejectedValue(new Error("offline"));
    await expect(resolver.reverseAddress(address)).rejects.toThrow("temporarily unavailable");
  });

  it("does not relabel unnormalized or wrong-namespace owner-controlled reverse names", async () => {
    const { resolver, reverse, read } = fixture();
    reverse.mockResolvedValue("alice.gwei");
    read.mockResolvedValueOnce("ALICE.gwei").mockResolvedValueOnce("alice..wei");
    expect(await resolver.reverseAddress(address)).toEqual({ identity: null, complete: true });
  });

  it("keeps avatars optional and separate from name lookup", async () => {
    const { resolver, reverse, avatar } = fixture();
    reverse.mockResolvedValue("alice.eth"); avatar.mockRejectedValue(new Error("image offline"));
    const { identity } = await resolver.reverseAddress(address);
    expect(identity?.name).toBe("alice.eth"); expect(avatar).not.toHaveBeenCalled();
    await expect(resolver.getAvatar(identity!)).rejects.toThrow("image offline");
    expect(await resolver.getAvatar({ address, name: "alice.wei", system: "wns" })).toBeNull();
  });

  it("rejects non-mainnet configuration", () => {
    const client = createPublicClient({ chain: sepolia, transport: custom({ request: async () => null }) });
    expect(() => createEthereumNameResolver({ client })).toThrow("mainnet");
  });

  it("lets viem handle ENS forward/reverse mismatches and continues to the other registries", async () => {
    const request = vi.fn(async ({ params }: { params?: unknown }) => {
      const [{ to }] = params as [{ to: string }];
      if (to.toLowerCase() === mainnet.contracts.ensUniversalResolver.address.toLowerCase()) {
        throw { code: 3, message: "execution reverted", data: encodeErrorResult({
          abi: parseAbi(["error ReverseAddressMismatch(string primary, bytes primaryAddress)"]),
          errorName: "ReverseAddressMismatch", args: ["spoofed.eth", zeroAddress],
        }) };
      }
      return encodeFunctionResult({ abi: parseAbi(["function reverseResolve(address) view returns (string)"]), functionName: "reverseResolve", result: to.toLowerCase() === gns.toLowerCase() ? "alice.gwei" : "" });
    });
    const client = createPublicClient({ chain: mainnet, transport: custom({ request }, { retryCount: 0 }) });
    expect(await createEthereumNameResolver({ client }).reverseAddress(address)).toEqual({ identity: { address, name: "alice.gwei", system: "gns" }, complete: true });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
