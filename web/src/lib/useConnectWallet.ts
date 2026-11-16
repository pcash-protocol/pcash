import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getConnection } from "wagmi/actions";
import { useConnectWalletDialog } from "../components/ConnectWalletDialog.tsx";
import { useEthereumNetwork } from "./EthereumProvider.tsx";
import { useWallet } from "./WalletProvider.tsx";

/** Starts a wallet connection from a signed-out state, reusing a connection wagmi already holds. */
export function useConnectWallet(): () => void {
  const wallet = useWallet();
  const { ethereumConfig } = useEthereumNetwork();
  const picker = useConnectWalletDialog();
  return () => {
    wallet.beginOnboarding();
    if (getConnection(ethereumConfig).status === "connected") { void wallet.connect().catch(() => undefined); return; }
    picker.open();
  };
}

/** Navigation state asking the destination to start connect or sign-in once it has rendered. */
export const START_WALLET = { startWallet: true } as const;

/**
 * Starts connect or sign-in when this page was opened with START_WALLET. It
 * runs in the destination, which stays mounted while the picker is open, and
 * onboarding returns here. The state is consumed so a reload or Back does not
 * start it again.
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
