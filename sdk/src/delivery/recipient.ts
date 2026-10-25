import { parseExtendedCode, type ExtendedCode } from "./extendedCode.ts";

export interface RecipientDelivery {
  recipientAddress: bigint;
  recipientReceiveKey?: Uint8Array;
  recipientExtendedCode?: string;
}

/** A 20-byte address with or without its 0x prefix, as lowercase 0x hex; otherwise null. */
function recipientAddressHex(to: string): string | null {
  const match = /^(?:0[xX])?([0-9a-fA-F]{40})$/.exec(to);
  return match === null ? null : `0x${match[1]!.toLowerCase()}`;
}

export function looksLikeExtendedCode(to: string): boolean {
  return recipientAddressHex(to) === null && !/^0[xX][0-9a-fA-F]{1,64}$/.test(to);
}

export function parseLocalChainCode(code: string, chainId: bigint): ExtendedCode {
  const parsed = parseExtendedCode(code);
  if (parsed.chainId !== chainId) {
    throw new Error(
      `extended code chain id 0x${parsed.chainId.toString(16)} does not match `
        + `this PCASH chain 0x${chainId.toString(16)}`,
    );
  }
  return parsed;
}

/**
 * The published ML-KEM receive key of the account at a lowercase 0x address,
 * or null when no account there publishes one. Wallets answer this from their
 * synced copy of every published key, so resolving a recipient names nobody
 * to the node.
 */
export type ReceiveKeyLookup = (address: string) => Uint8Array | null | Promise<Uint8Array | null>;

/**
 * The recipient an action names, without its encryption material: the address
 * form and, for an extended code, its chain. A payment that creates no recipient
 * note still signs this exact address.
 */
export function resolveRecipientAddress(to: string, chainId: bigint): RecipientDelivery {
  if (looksLikeExtendedCode(to)) {
    const code = parseLocalChainCode(to, chainId);
    return { recipientAddress: code.address };
  }
  const addressHex = recipientAddressHex(to);
  if (addressHex !== null) return { recipientAddress: BigInt(addressHex) };
  throw new Error(`recipient ${to} is neither a 20-byte address nor an extended code`);
}

export async function resolveRecipientDelivery(
  to: string,
  chainId: bigint,
  receiveKeyOf: ReceiveKeyLookup,
): Promise<RecipientDelivery> {
  const recipient = resolveRecipientAddress(to, chainId);
  if (looksLikeExtendedCode(to)) return { ...recipient, recipientExtendedCode: to };
  const address = recipientAddressHex(to)!;
  const receiveKey = await receiveKeyOf(address);
  if (receiveKey === null) {
    throw new Error(
      `recipient ${address} has no published ML-KEM receive key; they must publish an account with one `
        + "or share an extended code before receiving",
    );
  }
  return { ...recipient, recipientReceiveKey: receiveKey };
}
