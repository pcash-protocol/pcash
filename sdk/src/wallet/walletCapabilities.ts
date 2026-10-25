import type { PcashActionSigner } from "@pcash/sdk/eip712";
import type { WalletProfile } from "@pcash/sdk/protocol";
import type { PcashProfile } from "./externalIdentity.ts";

interface WalletAuthority {
  readonly profile: PcashProfile | WalletProfile;
  readonly signer?: PcashActionSigner | undefined;
}

interface SpendableWalletAuthority extends WalletAuthority {
  readonly profile: PcashProfile;
  readonly signer: PcashActionSigner;
}

export function isPcashProfile(profile: object): profile is PcashProfile {
  return "applicationSeed" in profile && "defaultUserRuleSecrets" in profile;
}

export function missingSpendableCapability(
  authority: WalletAuthority,
): "profile" | "signer" | null {
  if (!isPcashProfile(authority.profile)) return "profile";
  return authority.signer === undefined ? "signer" : null;
}

/** The single spendability predicate used by Wallet and action contexts. */
export function isSpendableWallet(
  authority: WalletAuthority,
): authority is SpendableWalletAuthority {
  return missingSpendableCapability(authority) === null;
}
