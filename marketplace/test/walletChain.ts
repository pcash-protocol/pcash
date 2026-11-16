// A simulated PCASH chain for tests that drive a real Wallet. Every wallet
// action synchronizes first, so the wallet's node serves the public
// synchronization reads from `ChainSim`; a test replaces only the methods its
// flow calls beyond them.

import { addressHex, defaultUserAccountRuleSet, type PcashNodeClient } from "@pcash/sdk/browser";
import type { PcashProfile } from "@pcash/sdk/wallet";
import { ChainSim, type AccountRow, type SimNote } from "@pcash/test-support/chain-sim";

export { ChainSim };

/** The default user account `profile` registers on `sim`'s network. */
export function profileAccount(sim: ChainSim, profile: PcashProfile): AccountRow {
  const network = { pcashChainId: sim.pcashChainId, l1ChainId: sim.l1ChainId, inboxAddress: sim.inboxAddress };
  const rules = defaultUserAccountRuleSet({
    wallet: profile,
    network,
    secrets: profile.defaultUserRuleSecrets,
  });
  return {
    address: addressHex(profile.address),
    nullifierKeyCommitment: profile.nullifierKeyCommitment,
    accountRuleSetCommitment: rules.accountRuleSetCommitment,
    receiveKey: profile.mlKemPublicKey,
  };
}

/** A native note `profile` can decrypt. */
export function noteTo(profile: PcashProfile, amount: bigint, noteSecret?: bigint): SimNote {
  return {
    owner: profile.address,
    receiveKey: profile.mlKemPublicKey,
    amount,
    ...(noteSecret === undefined ? {} : { noteSecret }),
  };
}

/** A node serving `sim`, with `overrides` answering in place of its methods. */
export function simNode(sim: ChainSim, overrides: Record<string, unknown> = {}): PcashNodeClient {
  return new Proxy(sim.client(), {
    get: (target, property) => typeof property === "string" && Object.hasOwn(overrides, property)
      ? overrides[property]
      : Reflect.get(target, property),
  });
}
