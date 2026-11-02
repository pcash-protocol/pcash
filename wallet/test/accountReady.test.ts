// Default-account readiness: the wallet's local check, which synchronizes only
// until the account is seen, and the polling policy against a stubbed probe.

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import { addressHex } from "@pcash/sdk/utils";
import { waitForDefaultAccount } from "@pcash/sdk/wallet";
import { OPEN_WALLET_INTERNAL, Wallet } from "@pcash/sdk/wallet";
import { derivePcashProfileFromPrivateKey } from "@pcash/sdk/wallet";
import { PGliteWalletDatabase } from "../src/pgliteDatabase.ts";
import { ChainSim } from "./chainFixture.ts";
import { TEST_PRIV_KEY } from "./testWallet.ts";

const NETWORK = {
  pcashChainId: 1n,
  l1ChainId: 11_155_111n,
  inboxAddress: `0x${"22".repeat(20)}`,
};
const PROFILE = derivePcashProfileFromPrivateKey(TEST_PRIV_KEY, NETWORK);

describe("Wallet.defaultAccountReady", () => {
  it("reflects whether the synced account set holds the profile's account", async () => {
    const sim = new ChainSim(NETWORK.pcashChainId, NETWORK);
    const db = await PGliteWalletDatabase.open(await PGlite.create("memory://"), { ownsClient: true });
    const wallet = await Wallet[OPEN_WALLET_INTERNAL]({ database: db, node: sim.client(), profile: PROFILE });
    const scans = vi.fn();
    wallet.on("sync:started", scans);
    await expect(wallet.defaultAccountReady()).resolves.toBe(false);

    const rules = defaultUserAccountRuleSet({
      wallet: PROFILE, network: NETWORK, secrets: PROFILE.defaultUserRuleSecrets,
    });
    sim.addBlock({ accounts: [{
      address: addressHex(PROFILE.address),
      nullifierKeyCommitment: PROFILE.nullifierKeyCommitment,
      accountRuleSetCommitment: rules.accountRuleSetCommitment,
      receiveKey: PROFILE.mlKemPublicKey,
    }] });
    await expect(wallet.defaultAccountReady()).resolves.toBe(true);
    expect(scans).toHaveBeenCalledTimes(2);

    // The account is now recorded locally and accounts are never removed: no scan.
    await expect(wallet.defaultAccountReady()).resolves.toBe(true);
    expect(scans).toHaveBeenCalledTimes(2);
    await wallet.close();
    await db.close();
  });
});

describe("waitForDefaultAccount", () => {
  it("resolves true on the first ready probe without delaying", async () => {
    const wallet = { defaultAccountReady: vi.fn(async () => true) };
    const delay = vi.fn(async () => undefined);
    await expect(waitForDefaultAccount(wallet, { delay })).resolves.toBe(true);
    expect(delay).not.toHaveBeenCalled();
  });

  it("keeps polling until the account appears, then stops", async () => {
    let calls = 0;
    const wallet = {
      defaultAccountReady: async () => {
        calls += 1;
        return calls >= 3;
      },
    };
    const waits: number[] = [];
    const result = await waitForDefaultAccount(wallet, {
      attempts: 5,
      intervalMs: 250,
      delay: async (ms) => { waits.push(ms); },
    });

    expect(result).toBe(true);
    expect(calls).toBe(3);
    expect(waits).toEqual([250, 250]);
  });

  it("resolves false once the attempt budget is spent", async () => {
    const wallet = { defaultAccountReady: vi.fn(async () => false) };
    const result = await waitForDefaultAccount(wallet, {
      attempts: 3,
      intervalMs: 1,
      delay: async () => undefined,
    });

    expect(result).toBe(false);
    expect(wallet.defaultAccountReady).toHaveBeenCalledTimes(3);
  });
});
