import { useState } from "react";
import { formatEtherAmount } from "../components/EtherAmount.tsx";
import { EthereumFaucetLinks, hasEthereumFaucets } from "../components/EthereumFaucets.tsx";
import { useNetwork } from "../components/NetworkContext.tsx";
import { Notice } from "../components/Notice.tsx";
import { useWallet } from "./WalletProvider.tsx";

/** Rounded up: a cost estimate must not read lower than the quote. */
export function formatEthCost(wei: bigint): string {
  return formatEtherAmount(wei, "up");
}

/** Rounded down: a balance must not read higher than it is. */
function formatEthBalance(wei: bigint): string {
  return formatEtherAmount(wei, "down");
}

export interface GasShortfall { balanceWei: bigint; requiredWei: bigint | undefined }

/**
 * Whether the last read balance looks short of `requiredWei`, the most the
 * transaction can cost; while that is unknown, only an empty balance counts.
 */
export function gasShort(balanceWei: bigint | undefined, requiredWei: bigint | undefined): boolean {
  return balanceWei !== undefined && (requiredWei === undefined ? balanceWei === 0n : balanceWei < requiredWei);
}

export interface GasGuard {
  /** Shown after an attempt that the connected Ethereum wallet cannot pay gas for. */
  shortfall: GasShortfall | undefined;
  /**
   * Call on each attempt to send. The first attempt without enough ETH only
   * shows the warning and returns false; the next attempt proceeds anyway.
   */
  proceed(): boolean;
}

/**
 * A warning before an action starts that the connected wallet looks short of
 * ETH, by gasShort: Buy shows it before its first attempt. The wallet's
 * assertFasterGas is what stops a Faster action before proving.
 */
export function useGasGuard(enabled: boolean, requiredWei: bigint | undefined): GasGuard {
  const balance = useWallet().l1Balance;
  const short = enabled && gasShort(balance, requiredWei);
  const [warned, setWarned] = useState(false);
  return {
    shortfall: warned && short ? { balanceWei: balance!, requiredWei } : undefined,
    proceed() {
      if (short && !warned) { setWarned(true); return false; }
      setWarned(false);
      return true;
    },
  };
}

export function GasWarning({ shortfall, action }: { shortfall: GasShortfall | undefined; action: string }) {
  const { network } = useNetwork();
  if (shortfall === undefined) return null;
  const { balanceWei, requiredWei } = shortfall;
  return <Notice tone="error">
    <strong>Not enough ETH for gas.</strong>{" "}
    Your Ethereum wallet has {formatEthBalance(balanceWei)}{requiredWei === undefined ? "" : <>, and this transaction can cost up to {formatEthCost(requiredWei)}</>}.
    {" "}Add ETH to your wallet first, or press {action} again to generate the proof anyway. Submitting it is expected to fail.
    {hasEthereumFaucets(network.l1ChainId) && <>
      {" "}{network.name} ETH is free test ETH with no value. Claim some from a faucet; this panel updates when it arrives.
      <EthereumFaucetLinks chainId={network.l1ChainId} />
    </>}
  </Notice>;
}

/** A payment-principal shortfall is exact, so it cannot be bypassed and needs no gas estimate. */
export function PaymentShortfallWarning({ shortfall }: { shortfall: GasShortfall | undefined }) {
  const { network } = useNetwork();
  if (shortfall === undefined || shortfall.requiredWei === undefined) return null;
  return <Notice tone="error">
    <strong>Not enough ETH for this purchase.</strong>{" "}
    Your Ethereum wallet has {formatEthBalance(shortfall.balanceWei)}, but the payment costs {formatEthCost(shortfall.requiredWei)} before gas.
    {" "}Add ETH to your wallet first. This panel updates when it arrives.
    {hasEthereumFaucets(network.l1ChainId) && <>
      {" "}{network.name} ETH is free test ETH with no value. Claim some from a faucet.
      <EthereumFaucetLinks chainId={network.l1ChainId} />
    </>}
  </Notice>;
}
