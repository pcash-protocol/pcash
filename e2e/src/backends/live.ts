import { l1Rpc } from "./rpc.ts";
import type { L1Backend } from "./types.ts";

/** An L1 some other party runs: Sepolia under a live network, or the Anvil of a local stack. */
export class LiveL1Backend implements L1Backend {
  readonly anvil: boolean;
  readonly chainId: bigint;
  readonly rpcUrl: string;

  private constructor(rpcUrl: string, chainId: bigint, anvil: boolean) {
    this.rpcUrl = rpcUrl;
    this.chainId = chainId;
    this.anvil = anvil;
  }

  static async connect(rpcUrl: string): Promise<LiveL1Backend> {
    const [chainId, clientVersion] = await Promise.all([
      l1Rpc<string>(rpcUrl, "eth_chainId"),
      l1Rpc<string>(rpcUrl, "web3_clientVersion"),
    ]);
    return new LiveL1Backend(rpcUrl, BigInt(chainId), /anvil/i.test(clientVersion));
  }

  async blockNumber(): Promise<bigint> {
    return BigInt(await l1Rpc<string>(this.rpcUrl, "eth_blockNumber"));
  }
}
