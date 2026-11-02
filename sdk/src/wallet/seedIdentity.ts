import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import { mnemonicToAccount } from "viem/accounts";
import { deriveWalletIdentity } from "@pcash/sdk/eip712";
import type { DefaultUserRuleSecrets } from "@pcash/sdk/rules";
import {
  generateMlKemKeyPair,
  ML_KEM_768_SEED_LENGTH,
  nullifierKeyCommitment,
  resolveNetworkConfig,
  type NetworkConfigLike,
} from "@pcash/sdk/protocol";
import { beBytes, concatBytes, scalarFromBytes, utf8 } from "@pcash/sdk/utils";
import type { PcashProfile } from "./externalIdentity.ts";
import { normalizeWalletMnemonic, validateWalletMnemonic } from "./mnemonic.ts";
export { generateWalletMnemonic, normalizeWalletMnemonic, validateWalletMnemonic } from "./mnemonic.ts";

export const WALLET_ETHEREUM_DERIVATION_PATH = "m/44'/60'/0'/0/0";

export interface SeedWalletIdentity {
  profile: PcashProfile & { recoveryContract: "seed-derived" };
  privateKey: Uint8Array;
}

/**
 * One mnemonic owns one Ethereum account and one profile per PCASH network.
 * The BIP-39 passphrase is empty; the vault password does not affect recovery.
 * Privacy secrets derive from the BIP-39 root, never from its Ethereum child.
 */
export function deriveSeedWalletIdentity(
  mnemonic: string,
  network: NetworkConfigLike,
): SeedWalletIdentity {
  const normalized = normalizeWalletMnemonic(mnemonic);
  if (!validateWalletMnemonic(normalized)) {
    throw new Error("wallet recovery phrase must be a valid 24-word English BIP-39 mnemonic");
  }
  const resolved = resolveNetworkConfig(network);
  const seed = mnemonicToSeedSync(normalized);
  const account = mnemonicToAccount(normalized, { path: WALLET_ETHEREUM_DERIVATION_PATH });
  const privateKey = account.getHdKey().privateKey!.slice();
  const { address, pubX, pubY } = deriveWalletIdentity(privateKey);
  const salt = sha256(concatBytes(
    utf8("pcash.seed-wallet"),
    beBytes(resolved.pcashChainId, 4),
  ));
  const expand = (label: string, length: number): Uint8Array =>
    hkdf(sha256, seed, salt, utf8(label), length);
  const scalar = (label: string): bigint => scalarFromBytes(expand(label, 48));
  try {
    const nkRoot = scalar("nullifier-root");
    const mlKemSeed = expand("mlkem-receive-seed", ML_KEM_768_SEED_LENGTH);
    const mlKem = generateMlKemKeyPair(mlKemSeed);
    mlKemSeed.fill(0);
    const defaultUserRuleSecrets: DefaultUserRuleSecrets = {
      paymentCommitmentBlinder: scalar("payment-commitment-blinder"),
      assetCreationCommitmentBlinder: scalar("asset-creation-commitment-blinder"),
      assetPaymentCommitmentBlinder: scalar("asset-payment-commitment-blinder"),
      assetBurnCommitmentBlinder: scalar("asset-burn-commitment-blinder"),
      batchTransferCommitmentBlinder: scalar("batch-transfer-commitment-blinder"),
      largeBatchTransferCommitmentBlinder: scalar("large-batch-transfer-commitment-blinder"),
      largeAssetCreationCommitmentBlinder: scalar("large-asset-creation-commitment-blinder"),
      largeContractFeeCommitmentBlinder: scalar("large-contract-fee-commitment-blinder"),
      accountAdminCommitmentBlinder: scalar("account-admin-commitment-blinder"),
      contractFeeCommitmentBlinder: scalar("contract-fee-commitment-blinder"),
    };
    return {
      privateKey,
      profile: {
        recoveryContract: "seed-derived",
        pubX, pubY, address, nkRoot,
        mlKemPublicKey: mlKem.publicKey,
        mlKemSecretKey: mlKem.secretKey,
        defaultUserRuleSecrets,
        applicationSeed: expand("application-seed", 32),
        outgoingKey: expand("outgoing-key", 32),
        nullifierKeyCommitment: nullifierKeyCommitment(nkRoot),
      },
    };
  } finally {
    seed.fill(0);
  }
}
