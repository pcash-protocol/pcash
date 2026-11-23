// The contract writes one Ethereum account sends, one at a time. A stablecoin
// issuer and a deny-list admin that use the same key share one writer, so
// their writes, timed heartbeats included, never race for a nonce.

import type { Abi, Address, Hex, PublicClient, TransactionReceipt, WalletClient } from "viem";

export interface ContractWrite {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

export class EthereumWriter {
  /** The account every write is sent from. */
  readonly address: Address;
  readonly #publicClient: PublicClient;
  readonly #walletClient: WalletClient;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(params: { publicClient: PublicClient; walletClient: WalletClient }) {
    const account = params.walletClient.account;
    if (account === undefined) throw new Error("the wallet client has no account");
    this.address = account.address;
    this.#publicClient = params.publicClient;
    this.#walletClient = params.walletClient;
  }

  /**
   * Send `write` once every earlier write given to this writer has finished,
   * and wait for its receipt before the next one is sent. Rejects if the
   * transaction reverted, or if another transaction from the account was mined
   * at its nonce instead, in which case the write is not done.
   */
  write(write: ContractWrite): Promise<TransactionReceipt> {
    return this.#exclusive(async () => {
      const hash = await this.#send(write);
      const receipt = await this.#publicClient.waitForTransactionReceipt({ hash });
      if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
        throw new Error(`${write.functionName} transaction ${hash} was replaced by ${receipt.transactionHash}; the write is not done`);
      }
      if (receipt.status !== "success") throw new Error(`${write.functionName} transaction ${hash} reverted`);
      return receipt;
    });
  }

  /**
   * Send `write` once every earlier write given to this writer has finished,
   * and return its hash without waiting for it to be mined. The next write may
   * be sent while this one is pending.
   */
  send(write: ContractWrite): Promise<Hex> {
    return this.#exclusive(() => this.#send(write));
  }

  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(run, run);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  #send(write: ContractWrite): Promise<Hex> {
    const walletClient = this.#walletClient;
    return walletClient.writeContract({
      chain: walletClient.chain ?? null, account: walletClient.account!, ...write,
    } as Parameters<WalletClient["writeContract"]>[0]);
  }
}
