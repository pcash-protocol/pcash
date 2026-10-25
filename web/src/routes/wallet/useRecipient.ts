import { useEffect, useState } from "react";
import { useWallet } from "../../lib/WalletProvider.tsx";
import { NAMES_OFF_MESSAGE } from "../../names/NameResolutionSession.ts";
import { useEthereumNameResolver, useNameAddress } from "../../names/useEthereumName.ts";
import { normalizeIdentityName } from "../explorer/identityName.ts";
import { describeRecipient, type ResolvedRecipient } from "./model.ts";

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

/** Whether an address can receive a private payment, from the wallet's synced account directory. */
export function useRecipientReceiveKey(address: string | undefined): "checking" | "present" | "missing" | "unknown" | undefined {
  const { wallet, snapshot } = useWallet();
  const syncedThrough = snapshot?.syncedThrough?.pcashHash;
  const key = address?.toLowerCase();
  const [checked, setChecked] = useState<{ key: string; state: "present" | "missing" | "unknown" }>();
  useEffect(() => {
    if (key === undefined || wallet === undefined) return;
    let current = true;
    void wallet.hasReceiveKey(key).then(
      (present) => { if (current) setChecked({ key, state: present ? "present" : "missing" }); },
      () => { if (current) setChecked({ key, state: "unknown" }); },
    );
    return () => { current = false; };
  }, [key, wallet, syncedThrough]);
  if (key === undefined || wallet === undefined) return undefined;
  // Each sync rechecks; the previous answer stands until the new one arrives.
  return checked?.key === key ? checked.state : "checking";
}
