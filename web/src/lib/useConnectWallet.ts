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
