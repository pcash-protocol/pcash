import { createWalletClient, custom, type Address, type Chain, type WalletClient } from "viem";

/** Wallet requests are never retried: a retried eth_sendTransaction prompts again and can send twice. */
export function networkWalletClient(client: WalletClient, account: Address, chain: Chain) {
  return createWalletClient({
    account, chain,
    transport: custom({ request: (request) => client.request(request) }, { retryCount: 0 }),
  });
}
