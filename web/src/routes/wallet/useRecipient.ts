import { useEffect, useState } from "react";
import { getPublicClient } from "wagmi/actions";
import type { Wallet } from "@pcash/sdk/wallet";
import { useEthereumNetwork } from "../../lib/EthereumProvider.tsx";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { NAMES_OFF_MESSAGE } from "../../names/NameResolutionSession.ts";
import { useEthereumNameResolver, useNameAddress } from "../../names/useEthereumName.ts";
import { normalizeIdentityName } from "../explorer/identityName.ts";
import { classifyUnregisteredAddress, describeRecipient, type RecipientReach, type ResolvedRecipient } from "./model.ts";

export { NO_RECEIVE_KEY_MESSAGE } from "../../components/friendlyError.ts";

/** What a recipient field names as the user types: an address or an ENS-style name. */
export function useRecipientInput(to: string) {
  const name = normalizeIdentityName(to.trim());
  const nameResolver = useEthereumNameResolver();
  const namedAddress = useNameAddress(name);
  const recipient: ResolvedRecipient | undefined = name === undefined
    ? (to.trim() === "" ? undefined : describeRecipient(to))
    : namedAddress.state === "resolved" ? { kind: "address", address: namedAddress.address }
      : namedAddress.state === "disabled" ? { kind: "invalid", message: NAMES_OFF_MESSAGE }
      : namedAddress.state === "unresolved" ? { kind: "invalid", message: "This name does not resolve to an Ethereum address." }
        : namedAddress.state === "error" ? { kind: "invalid", message: "Name resolution is unavailable. Press Send to retry." } : undefined;
  return { name, nameResolver, recipient, resolvingName: name !== undefined && namedAddress.state === "resolving" };
}

/** Reads an address's code and transaction count on PCASH's Ethereum network. */
export type L1AddressReader = (address: `0x${string}`) => Promise<{ code: string | undefined; nonce: number }>;

export function useL1AddressReader(): L1AddressReader {
  const { ethereumConfig, l1ChainId } = useEthereumNetwork();
  return async (address) => {
    const client = getPublicClient(ethereumConfig, { chainId: l1ChainId });
    if (client === undefined) throw new Error("PCASH's Ethereum network is not configured");
    const [code, nonce] = await Promise.all([client.getCode({ address }), client.getTransactionCount({ address })]);
    return { code, nonce };
  };
}

/**
 * How a payment reaches an address: its published receive key, from the
 * wallet's synced account directory, or else a direct send, which depends on
 * what Ethereum shows about the address. "unknown" when the directory could not
 * answer, "unchecked" when Ethereum could not.
 */
export async function recipientReach(wallet: Pick<Wallet, "hasReceiveKey">, readL1: L1AddressReader, address: string): Promise<RecipientReach> {
  let present: boolean;
  try { present = await wallet.hasReceiveKey(address); } catch { return "unknown"; }
  if (present) return "present";
  try {
    const { code, nonce } = await readL1(address as `0x${string}`);
    return classifyUnregisteredAddress(code, nonce);
  } catch {
    return "unchecked";
  }
}

/** Whether an address can receive a private payment, from the wallet's synced account directory. */
export function useRecipientReceiveKey(address: string | undefined): "checking" | "present" | "missing" | "unknown" | undefined {
  return useRecipientLookup(address, (wallet, key) => wallet.hasReceiveKey(key).then(
    (present) => present ? "present" as const : "missing" as const,
    () => "unknown" as const,
  ));
}

/** How a native payment reaches an address: its receive key, or a direct send judged from Ethereum. */
export function useRecipientReach(address: string | undefined): RecipientReach | "checking" | undefined {
  const readL1 = useL1AddressReader();
  return useRecipientLookup(address, (wallet, key) => recipientReach(wallet, readL1, key));
}

/** One lookup per address, rechecked on every sync. */
function useRecipientLookup<State extends string>(
  address: string | undefined,
  lookup: (wallet: Pick<Wallet, "hasReceiveKey">, address: string) => Promise<State>,
): State | "checking" | undefined {
  const { wallet, snapshot } = useWallet();
  const syncedThrough = snapshot?.syncedThrough?.pcashHash;
  const key = address?.toLowerCase();
  const [checked, setChecked] = useState<{ key: string; state: State }>();
  useEffect(() => {
    if (key === undefined || wallet === undefined) return;
    let current = true;
    void lookup(wallet, key).then((state) => { if (current) setChecked({ key, state }); });
    return () => { current = false; };
  }, [key, wallet, syncedThrough]);
  if (key === undefined || wallet === undefined) return undefined;
  // Each sync rechecks; the previous answer stands until the new one arrives.
  return checked?.key === key ? checked.state : "checking";
}
