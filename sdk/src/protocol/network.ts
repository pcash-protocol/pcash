import { addressHex } from "../utils/hex.ts";
import { type FieldNumberish, toField } from "../crypto/field.ts";
import { DEFAULT_NETWORK, NETWORKS } from "../constants/networkProfile.ts";
import { U32_LIMIT, U64_LIMIT, U160_LIMIT, uintBelow } from "../utils/validate.ts";

export interface NetworkConfigLike {
  pcashChainId: FieldNumberish;
  l1ChainId: FieldNumberish;
  inboxAddress: FieldNumberish | string;
}

export interface NetworkConfig {
  pcashChainId: bigint;
  l1ChainId: bigint;
  inboxAddress: bigint;
}

function addressValue(value: FieldNumberish | string): bigint {
  if (typeof value === "string") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new Error("inboxAddress must be a 20-byte 0x address");
    }
    return BigInt(value);
  }
  return uintBelow(value, U160_LIMIT, "inboxAddress");
}

export function resolveNetworkConfig(network: NetworkConfigLike): NetworkConfig {
  return {
    pcashChainId: uintBelow(network.pcashChainId, U32_LIMIT, "pcashChainId"),
    l1ChainId: uintBelow(network.l1ChainId, U64_LIMIT, "l1ChainId"),
    inboxAddress: addressValue(network.inboxAddress),
  };
}

/** Resolve the network for a PCASH chain id: the default config unless overridden. */
export function networkForChain(
  chainId: FieldNumberish,
  network?: NetworkConfigLike,
): NetworkConfig {
  const cid = toField(chainId, "chainId");
  const resolved = resolveNetworkConfig(
    network ?? { ...DEFAULT_NETWORK_CONFIG, pcashChainId: cid },
  );
  if (resolved.pcashChainId !== cid) {
    throw new Error("chainId does not match network.pcashChainId");
  }
  return resolved;
}

/**
 * The network a node status reports. The inbox receives every self-published
 * batch and is the verifying contract of every PCASH signature, so a PCASH
 * chain id compiled into this build fixes it and a status reporting another
 * inbox is refused. Development chains reuse a compiled chain id on their own
 * L1, so the L1 chain id is not fixed here; a submitter checks it against its
 * L1 endpoint. Other chain ids are unpinned.
 */
export function networkConfigFromStatus(status: {
  pcashChainId: number | bigint;
  l1ChainId: bigint;
  inboxAddress: string;
}): NetworkConfig {
  const network = resolveNetworkConfig({
    pcashChainId: BigInt(status.pcashChainId),
    l1ChainId: status.l1ChainId,
    inboxAddress: status.inboxAddress,
  });
  const compiled = Object.values(NETWORKS).find((candidate) => candidate.pcashChainId === network.pcashChainId);
  if (compiled !== undefined && network.inboxAddress !== compiled.inboxAddress) {
    throw new Error(`the node reports inbox ${addressHex(network.inboxAddress)} for PCASH chain ${network.pcashChainId}, whose inbox is ${addressHex(compiled.inboxAddress)}`);
  }
  return network;
}

/** Generated Sepolia values are convenience defaults, not circuit identity. */
export const DEFAULT_NETWORK_CONFIG: NetworkConfig = DEFAULT_NETWORK;

export function inboxAddressHex(network: NetworkConfigLike): string {
  return addressHex(resolveNetworkConfig(network).inboxAddress);
}
