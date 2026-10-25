import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DeterministicInjectedProvider,
  FIXED_ACCOUNT,
  FIXED_CHAIN_ID,
  ProviderRpcError,
} from "./injected_provider.mjs";

const OTHER_ACCOUNT = `0x${"22".repeat(20)}`;
const ANVIL_ACTOR_KEY = `0x${"02".repeat(32)}`;

function keyDerivationTypedData() {
  return {
    domain: {
      name: "PCASH",
      version: "1",
      chainId: Number(FIXED_CHAIN_ID),
      verifyingContract: `0x${"12".repeat(20)}`,
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      PcashKeyDerivation: [
        { name: "pcashChainId", type: "uint256" },
        { name: "account", type: "address" },
        { name: "context", type: "string" },
      ],
    },
    primaryType: "PcashKeyDerivation",
    message: {
      pcashChainId: "1346589512",
      account: FIXED_ACCOUNT,
      context: "pcash-profile",
    },
  };
}

describe("deterministic injected provider", () => {
  it("can broadcast an activation through the supplied local-chain sender", async () => {
    const sent = [];
    const hash = `0x${"cd".repeat(32)}`;
    const provider = new DeterministicInjectedProvider({ connected: true, broadcastTransaction: async (transaction) => {
      sent.push(transaction);
      return hash;
    } });
    const transaction = { from: FIXED_ACCOUNT, to: OTHER_ACCOUNT, data: "0x1234", value: "0x0" };
    assert.equal(await provider.request({ method: "eth_sendTransaction", params: [transaction] }), hash);
    assert.deepEqual(sent, [transaction]);
    assert.deepEqual(provider.sentTransactions, [transaction]);
    assert.equal((await provider.request({ method: "eth_getTransactionByHash", params: [hash] })).hash, hash);
  });

  for (const value of ["0x38d7ea4c68000", undefined]) {
    it(`broadcasts transaction value ${value ?? "omitted"}`, async () => {
      const sent = [];
      const hash = `0x${"cd".repeat(32)}`;
      const provider = new DeterministicInjectedProvider({ connected: true, broadcastTransaction: async (transaction) => {
        sent.push(transaction); return hash;
      } });
      const transaction = { from: FIXED_ACCOUNT, to: OTHER_ACCOUNT, data: "0x1234", ...(value === undefined ? {} : { value }) };
      assert.equal(await provider.request({ method: "eth_sendTransaction", params: [transaction] }), hash);
      assert.deepEqual(sent, [transaction]);
    });
  }

  it("connects its fixed account and logs MetaMask-compatible requests", async () => {
    const provider = new DeterministicInjectedProvider();

    assert.deepEqual(await provider.request({ method: "eth_accounts" }), []);
    assert.equal(await provider.request({ method: "eth_chainId" }), "0xaa36a7");
    assert.deepEqual(await provider.request({ method: "eth_requestAccounts" }), [FIXED_ACCOUNT]);
    assert.deepEqual(await provider.request({ method: "eth_accounts" }), [FIXED_ACCOUNT]);
    assert.deepEqual(provider.requestLog, [
      { method: "eth_accounts" },
      { method: "eth_chainId" },
      { method: "eth_requestAccounts" },
      { method: "eth_accounts" },
    ]);

    const copy = provider.requestLog;
    copy.push({ method: "mutated" });
    assert.equal(provider.requestLog.length, 4);
    provider.clearRequestLog();
    assert.deepEqual(provider.requestLog, []);
  });

  it("signs eth_signTypedData_v4 payloads with the fixed account", async () => {
    const provider = new DeterministicInjectedProvider({ connected: true });
    const typedData = keyDerivationTypedData();
    const signature = await provider.request({
      method: "eth_signTypedData_v4",
      params: [FIXED_ACCOUNT.toLowerCase(), JSON.stringify(typedData)],
    });

    assert.match(signature, /^0x[0-9a-f]{130}$/);
    assert.equal(
      await recoverTypedDataAddress({ ...typedData, signature }),
      FIXED_ACCOUNT,
    );
    assert.deepEqual(provider.requestLog, [{
      method: "eth_signTypedData_v4",
      params: [FIXED_ACCOUNT.toLowerCase(), JSON.stringify(typedData)],
    }]);
  });

  it("can sign as an injected deterministic actor key", async () => {
    const actor = privateKeyToAccount(ANVIL_ACTOR_KEY);
    const provider = new DeterministicInjectedProvider({
      connected: true,
      privateKey: ANVIL_ACTOR_KEY,
    });
    const typedData = {
      ...keyDerivationTypedData(),
      message: { ...keyDerivationTypedData().message, account: actor.address },
    };

    assert.deepEqual(await provider.request({ method: "eth_accounts" }), [actor.address]);
    const signature = await provider.request({
      method: "eth_signTypedData_v4",
      params: [actor.address, JSON.stringify(typedData)],
    });
    assert.equal(await recoverTypedDataAddress({ ...typedData, signature }), actor.address);
  });

  it("emits account and chain changes and supports listener removal", async () => {
    const provider = new DeterministicInjectedProvider();
    const accountEvents = [];
    const chainEvents = [];
    const onAccounts = (accounts) => accountEvents.push(accounts);
    const onChain = (chainId) => chainEvents.push(chainId);
    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);

    await provider.request({ method: "eth_requestAccounts" });
    provider.setAccounts([OTHER_ACCOUNT]);
    provider.setChainId(1n);
    provider.setChainId("0x1");
    provider.removeListener("accountsChanged", onAccounts);
    provider.disconnect();
    provider.removeListener("chainChanged", onChain);
    provider.setChainId(10n);

    assert.deepEqual(accountEvents, [[FIXED_ACCOUNT], [OTHER_ACCOUNT]]);
    assert.deepEqual(chainEvents, ["0x1"]);
    assert.deepEqual(await provider.request({ method: "eth_accounts" }), []);
    assert.equal(await provider.request({ method: "eth_chainId" }), "0xa");
  });

  it("switches to an exact requested Ethereum chain", async () => {
    const provider = new DeterministicInjectedProvider({ chainId: 1n });
    const chainEvents = [];
    provider.on("chainChanged", (chainId) => chainEvents.push(chainId));

    assert.equal(await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xaa36a7" }],
    }), null);
    assert.equal(await provider.request({ method: "eth_chainId" }), "0xaa36a7");
    assert.deepEqual(chainEvents, ["0xaa36a7"]);
  });

  it("injects queued one-shot rejections without changing provider state", async () => {
    const provider = new DeterministicInjectedProvider();
    provider.rejectNext("eth_requestAccounts");
    provider.rejectNext("eth_requestAccounts", {
      code: 4001,
      message: "Second request rejected by the journey",
      data: { checkpoint: "connect" },
    });

    await assert.rejects(
      provider.request({ method: "eth_requestAccounts" }),
      (error) => error instanceof ProviderRpcError
        && error.code === 4001
        && error.message === "User rejected the request.",
    );
    assert.deepEqual(await provider.request({ method: "eth_accounts" }), []);
    await assert.rejects(
      provider.request({ method: "eth_requestAccounts" }),
      (error) => error.code === 4001
        && error.message === "Second request rejected by the journey"
        && error.data.checkpoint === "connect",
    );
    assert.deepEqual(await provider.request({ method: "eth_requestAccounts" }), [FIXED_ACCOUNT]);
    assert.equal(
      provider.requestLog.filter(({ method }) => method === "eth_requestAccounts").length,
      3,
    );
  });

  it("fails closed for disconnected, changed, malformed, and unsupported requests", async () => {
    const provider = new DeterministicInjectedProvider();
    const typedData = keyDerivationTypedData();
    const sign = () => provider.request({
      method: "eth_signTypedData_v4",
      params: [FIXED_ACCOUNT, JSON.stringify(typedData)],
    });

    await assert.rejects(sign(), (error) => error.code === 4100 && /not connected/.test(error.message));
    provider.setAccounts([OTHER_ACCOUNT]);
    await assert.rejects(sign(), (error) => error.code === 4100 && /not selected/.test(error.message));
    await assert.rejects(
      provider.request({
        method: "eth_signTypedData_v4",
        params: [OTHER_ACCOUNT, JSON.stringify(typedData)],
      }),
      (error) => error.code === 4100 && /no fixture signing key/.test(error.message),
    );
    await assert.rejects(
      provider.request({ method: "eth_signTypedData_v4", params: [FIXED_ACCOUNT, "not-json"] }),
      (error) => error.code === -32602,
    );
    await assert.rejects(
      provider.request({ method: "wallet_switchEthereumChain" }),
      (error) => error.code === -32602 && /requires/.test(error.message),
    );
  });
});
