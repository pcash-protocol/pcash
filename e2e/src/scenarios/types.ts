import type { PcashActionSigner, PcashProfile } from "../deps.ts";

export interface ScenarioWalletActor {
  name: string;
  privateKey: string;
  signer: PcashActionSigner;
  wallet: PcashProfile;
  address: string;
  walletDatabasePath: string;
}
