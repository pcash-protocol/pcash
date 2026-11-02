import { describe, expect, it } from "vitest";
import { parseExtendedCode } from "@pcash/sdk/delivery";
import { defaultUserAccountRuleSet } from "@pcash/sdk/rules";
import { generateMlKemKeyPair } from "@pcash/sdk/protocol";
import { addressHex } from "@pcash/sdk/utils";
import { createWalletRuntime } from "../../src/wallet/actions/walletRuntime.ts";
import { derivePcashProfileFromPrivateKey } from "../../src/wallet/externalIdentity.ts";
import { memoryWalletStateStore } from "../../src/wallet/memoryStoreBackend.ts";
import { retainReceiveKeyPair } from "../../src/wallet/receiveKeyring.ts";
import { emptyWalletState } from "../../src/wallet/store.ts";
import { ChainSim } from "./chainFixture.ts";
import { TEST_PRIV_KEY } from "./testWallet.ts";

function fixture() {
  const sim = new ChainSim(8191n);
  const network = { pcashChainId: sim.pcashChainId, l1ChainId: sim.l1ChainId, inboxAddress: sim.inboxAddress };
  const wallet = derivePcashProfileFromPrivateKey(TEST_PRIV_KEY, network);
  const rules = defaultUserAccountRuleSet({ wallet, network, secrets: wallet.defaultUserRuleSecrets });
  const replacement = generateMlKemKeyPair(new Uint8Array(64).fill(0x87));
  const data = emptyWalletState({ address: wallet.address, network: { chainId: sim.pcashChainId, genesisHash: sim.genesisHash } });
  const account = (receiveKey: Uint8Array | null, accountRevision = 1) => ({
    address: addressHex(wallet.address), nullifierKeyCommitment: wallet.nullifierKeyCommitment,
    accountRuleSetCommitment: rules.accountRuleSetCommitment, accountRevision, receiveKey,
  });
  const runtime = () => createWalletRuntime({
    node: sim.client(), wallet, chainId: sim.pcashChainId, store: memoryWalletStateStore(data),
  });
  return { sim, wallet, replacement, data, account, runtime };
}

describe("advertised receive code", () => {
  it("follows registered rotation and reorgs instead of the newest owned key", async () => {
    const f = fixture();
    retainReceiveKeyPair(f.data, f.replacement);
    f.sim.addBlock({ accounts: [f.account(f.wallet.mlKemPublicKey)] });
    const runtime = f.runtime();
    expect(parseExtendedCode((await runtime.code()).extendedCode).mlKemPublicKey).toEqual(f.wallet.mlKemPublicKey);

    f.sim.addBlock({ accounts: [f.account(f.replacement.publicKey, 2)] });
    expect(parseExtendedCode((await runtime.code()).extendedCode).mlKemPublicKey).toEqual(f.replacement.publicKey);

    f.sim.reorg(1n, [{}]);
    expect(parseExtendedCode((await runtime.code()).extendedCode).mlKemPublicKey).toEqual(f.wallet.mlKemPublicKey);

    f.sim.addBlock({ accounts: [f.account(null, 2)] });
    await expect(runtime.code()).rejects.toThrow("no registered receive key");
  });

  it.each([false, true])("refuses an absent registered receive key with account present=%s", async (created) => {
    const f = fixture();
    if (created) f.sim.addBlock({ accounts: [f.account(null)] });
    await expect(f.runtime().code()).rejects.toThrow("no registered receive key");
  });

  it("refuses to advertise an unowned registered receive key", async () => {
    const f = fixture();
    f.sim.addBlock({ accounts: [f.account(f.replacement.publicKey)] });
    await expect(f.runtime().code()).rejects.toThrow(/does not own.*receive key/);
  });
});
