import { createContext, useContext } from "react";
import type { NetworkProfile } from "../lib/networks.ts";

interface NetworkContextValue {
  network: NetworkProfile;
}

// Public deployment configuration; Explorer never imports a wallet runtime.
export const NetworkContext = createContext<NetworkContextValue | null>(null);
export function useNetwork(): NetworkContextValue { return useContext(NetworkContext)!; }
