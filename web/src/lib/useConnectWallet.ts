import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { disconnect, getAccount } from "wagmi/actions";
import { useEthereumNetwork } from "./EthereumProvider.tsx";
import { useWallet } from "./WalletProvider.tsx";

/**
 * Starts a wallet connection from a signed-out state. RainbowKit withholds its
 * picker while wagmi holds or is attempting a connection, which an account
 * switch in the extension can leave behind; a held connection is reused, and
 * an attempt that never finished is dropped before the picker opens.
 */
export function useConnectWallet(): () => void {
  const wallet = useWallet();
  const { ethereumConfig } = useEthereumNetwork();
  const { openConnectModal } = useConnectModal();
  const [pickerRequested, setPickerRequested] = useState(false);
  useEffect(() => {
    if (!pickerRequested || openConnectModal === undefined) return;
    setPickerRequested(false);
    openConnectModal();
  }, [pickerRequested, openConnectModal]);
  return () => {
    wallet.beginOnboarding();
    if (openConnectModal !== undefined) { openConnectModal(); return; }
    if (getAccount(ethereumConfig).status === "connected") { void wallet.connect().catch(() => undefined); return; }
    void disconnect(ethereumConfig).catch(() => undefined).then(() => setPickerRequested(true));
  };
}

/** Navigation state asking the destination to start connect or sign-in once it has rendered. */
export const START_WALLET = { startWallet: true } as const;

/**
 * Starts connect or sign-in when this page was opened with START_WALLET. It
 * runs in the destination, which stays mounted for the picker's recovery
 * step, and onboarding returns here. The state is consumed so a reload or
 * Back does not start it again.
 */
export function useStartWalletOnArrival(): void {
  const wallet = useWallet();
  const connect = useConnectWallet();
  const location = useLocation();
  const navigate = useNavigate();
  const requested = (location.state as Partial<typeof START_WALLET> | null)?.startWallet === true;
  useEffect(() => {
    // Until a saved connection resolves (restoring passes through connecting), the next step is unknown.
    if (!requested || wallet.phase === "initializing" || wallet.phase === "connecting") return;
    void navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
    if (wallet.phase === "disconnected") connect();
    else if (wallet.phase === "sign-in-required") void wallet.signIn().catch(() => undefined);
  }, [requested, wallet, connect, location, navigate]);
}
