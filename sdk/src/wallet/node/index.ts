export { createWalletProvers, type ProverKind } from "../provers.ts";
export { createWalletVault, unlockWalletVault, type UnlockedWalletVault, type WalletVaultDocument } from "./vault.ts";
export { hasInteractiveTerminal, promptSecret } from "./terminal.ts";
export type { WalletStorageCipher } from "../storageCipher.ts";
