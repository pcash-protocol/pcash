import { useEffect, useState } from "react";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { ACCOUNT_WEIGHT, quoteNetworkFee } from "@pcash/sdk/protocol";
import { privateValueActionUnits } from "@pcash/sdk/wallet/actions";
import { useWallet } from "./WalletProvider.tsx";

/** State units of a profile S action by an account that already exists. */
export const S_ACTION_UNITS = privateValueActionUnits(PRIVATE_VALUE_PROFILES.S.shapeId);
/** State units of a profile S action whose attachment creates an account: its sender's, or a contract's. */
export const S_ACTION_WITH_ACCOUNT_UNITS = S_ACTION_UNITS + ACCOUNT_WEIGHT;

/** The node's fee excess is read again on this cadence, so a view waiting for a zero fee sees it return. */
export const NETWORK_FEE_REFRESH_MS = 12_000;

/**
 * The node's latest fee excess, read again every NETWORK_FEE_REFRESH_MS while
 * enabled. Undefined until a status is known. A failed read keeps the last value.
 */
export function useFeeExcess(enabled = true): bigint | undefined {
  const { node, status } = useWallet();
  const [read, setRead] = useState<{ node: typeof node; feeExcess: bigint }>();
  const known = status !== undefined;
  useEffect(() => {
    if (!enabled || !known) return;
    let cancelled = false;
    const poll = () => void node.status().then((current) => {
      if (!cancelled) setRead({ node, feeExcess: current.feeExcess });
    }, () => undefined);
    poll();
    const timer = setInterval(poll, NETWORK_FEE_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [node, enabled, known]);
  if (!enabled) return undefined;
  return read !== undefined && read.node === node ? read.feeExcess : status?.feeExcess;
}

/** The network fee the SDK quotes now for an action of `units` state units. */
export function useNetworkFee(units: bigint, enabled = true): bigint | undefined {
  const feeExcess = useFeeExcess(enabled);
  return feeExcess === undefined ? undefined : quoteNetworkFee(feeExcess, units);
}
