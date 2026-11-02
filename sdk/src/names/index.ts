import type { Address, PublicClient } from "viem";
import { getAddress, parseAbi } from "viem/utils";
import { namehash, normalize } from "viem/ens";

export type NameSystem = "ens" | "gns" | "wns";
export interface EthereumName {
  address: Address;
  name: string;
  system: NameSystem;
}

export interface ReverseNameResult {
  identity: EthereumName | null;
  /** False when a higher-priority service failed; this result must not be persisted. */
  complete: boolean;
}

// Canonical Ethereum mainnet deployments:
// https://github.com/lucadonnoh/gwei-names
// https://github.com/z0r0z/wei-names
const registries = {
  gns: "0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6",
  wns: "0x0000000000696760E15f265e828DB644A0c242EB",
} as const;
const registryAbi = parseAbi([
  "function resolve(uint256 tokenId) view returns (address)",
  "function reverseResolve(address addr) view returns (string)",
]);

/** User-supplied names use ENSIP-15 normalization in every namespace. */
export function normalizeIdentityName(value: string): string | undefined {
  try {
    const name = normalize(value);
    return name.includes(".") ? name : undefined;
  } catch {
    return undefined;
  }
}

function systemFor(name: string): NameSystem {
  return name.endsWith(".gwei") ? "gns" : name.endsWith(".wei") ? "wns" : "ens";
}

type NamingClient = Pick<PublicClient, "chain" | "getEnsAddress" | "getEnsName" | "getEnsAvatar" | "readContract">;

export function createEthereumNameResolver({ client }: { client: NamingClient }) {
  // Configuration is a trust boundary: these registry addresses are mainnet deployments.
  if (client.chain?.id !== 1) throw new Error("Ethereum names require an Ethereum mainnet client.");

  async function resolveName(input: string): Promise<EthereumName | null> {
    const name = normalizeIdentityName(input);
    if (name === undefined) return null;
    const system = systemFor(name);
    const address = system === "ens"
      ? await client.getEnsAddress({ name })
      : await client.readContract({
        address: registries[system], abi: registryAbi, functionName: "resolve", args: [BigInt(namehash(name))],
      });
    return address === null || address === "0x0000000000000000000000000000000000000000" ? null : { address: getAddress(address), name, system };
  }

  async function reverseAddress(input: string): Promise<ReverseNameResult> {
    const address = getAddress(input);
    const errors: unknown[] = [];
    for (const system of ["ens", "gns", "wns"] as const) {
      try {
        // ENS's universal resolver verifies the forward record. WNS/GNS perform
        // the same ownership relationship check inside reverseResolve itself.
        const raw = system === "ens"
          ? await client.getEnsName({ address })
          : await client.readContract({
            address: registries[system], abi: registryAbi, functionName: "reverseResolve", args: [address],
          });
        if (!raw) continue;
        const name = normalizeIdentityName(raw);
        // Name owners can register strings their clients never normalized.
        // Do not display a transformed name that could identify a different token.
        if (name === undefined || name !== raw || systemFor(name) !== system) continue;
        return { identity: { address, name, system }, complete: errors.length === 0 };
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Name resolution is temporarily unavailable.");
    return { identity: null, complete: true };
  }

  async function getAvatar(identity: EthereumName): Promise<string | null> {
    return identity.system === "ens" ? client.getEnsAvatar({ name: identity.name }) : null;
  }

  return { resolveName, reverseAddress, getAvatar };
}

export type EthereumNameResolver = ReturnType<typeof createEthereumNameResolver>;
