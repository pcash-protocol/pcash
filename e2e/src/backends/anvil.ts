import { join } from "node:path";
import type { Config } from "@pcash/sdk/bcfg";
import { foundry } from "viem/chains";
import { eventually } from "../framework/eventually.ts";
import type { ManagedProcess, ProcessRegistry } from "../framework/process.ts";
import { l1Rpc, quantity } from "./rpc.ts";
import type { L1Backend } from "./types.ts";

/** Funded Anvil development accounts that browser journeys pin as their actors. */
export const ANVIL_ACCOUNTS = {
  S: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  R: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
} as const;

/**
 * Anvil account 5 pays the harness's L1 gas. Account 0 deploys local routers
 * and backs `wallet --dev`, and account 1 is the development relayer.
 */
export const ANVIL_HARNESS_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";

export async function withAnvilMiningPaused<T>(rpcUrl: string, operation: () => Promise<T>): Promise<T> {
  const automatic = await l1Rpc<boolean>(rpcUrl, "anvil_getAutomine");
  const interval = await l1Rpc<number | null>(rpcUrl, "anvil_getIntervalMining");
  try {
    await l1Rpc(rpcUrl, "evm_setAutomine", [false]);
    await l1Rpc(rpcUrl, "evm_setIntervalMining", [0]);
    return await operation();
  } finally {
    // Setting an interval of zero disables mining, including automining.
    await l1Rpc(rpcUrl, "evm_setIntervalMining", [interval ?? 0]);
    await l1Rpc(rpcUrl, "evm_setAutomine", [automatic]);
  }
}

/** An Anvil the harness launches and controls. */
export class AnvilBackend implements L1Backend {
  readonly anvil = true;
  readonly chainId: bigint;
  readonly slotsInEpoch: string;
  rpcUrl = "";
  beaconApiUrl = "";
  process?: ManagedProcess;

  constructor(settings: Config) {
    const configuredChainId = settings.str("anvil-chain-id")?.trim() || String(foundry.id);
    if (!/^[1-9][0-9]*$/.test(configuredChainId)) {
      throw new Error("PCASH_E2E_ANVIL_CHAIN_ID must be a positive decimal integer");
    }
    this.chainId = BigInt(configuredChainId);
    if (this.chainId > 18_446_744_073_709_551_615n) {
      throw new Error("PCASH_E2E_ANVIL_CHAIN_ID must fit in a u64");
    }
    const configured = settings.str("anvil-slots-in-epoch")?.trim() || "1";
    if (!/^[1-9][0-9]*$/.test(configured)) throw new Error("PCASH_E2E_ANVIL_SLOTS_IN_EPOCH must be positive");
    this.slotsInEpoch = configured;
  }

  async start(context: { repoRoot: string; artifactsRoot: string; processes: ProcessRegistry; port: number }): Promise<void> {
    this.rpcUrl = `http://127.0.0.1:${context.port}`;
    this.beaconApiUrl = this.rpcUrl;
    this.process = await context.processes.start({
      name: "anvil",
      command: "anvil",
      args: [
        "--port", String(context.port),
        "--chain-id", this.chainId.toString(),
        "--silent",
        "--block-time", "1",
        "--slots-in-an-epoch", this.slotsInEpoch,
      ],
      cwd: context.repoRoot,
      logPath: join(context.artifactsRoot, "logs", "anvil.log"),
    });
    await eventually(
      "Anvil JSON-RPC and Beacon API readiness",
      async () => {
        const [chainId, beacon] = await Promise.all([
          l1Rpc<string>(this.rpcUrl, "eth_chainId"),
          fetch(`${this.beaconApiUrl}/eth/v1/beacon/genesis`).then(async (response) =>
            response.ok ? response.json() as Promise<unknown> : null),
        ]);
        return { chainId: BigInt(chainId), beacon };
      },
      ({ chainId, beacon }) => chainId === this.chainId && beacon !== null,
      { timeoutMs: 30_000, cancellation: () => this.process?.cancellationReason() ?? null },
    );
  }

  async anchor(): Promise<{ number: bigint; hash: string }> {
    const block = await l1Rpc<{ number: string; hash: string }>(this.rpcUrl, "eth_getBlockByNumber", ["0x0", false]);
    return { number: BigInt(block.number), hash: block.hash };
  }

  async blockNumber(): Promise<bigint> {
    return BigInt(await l1Rpc<string>(this.rpcUrl, "eth_blockNumber"));
  }

  async mine(count = 1): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("mine count must be positive");
    await l1Rpc(this.rpcUrl, "anvil_mine", [quantity(BigInt(count)), quantity(1n)]);
  }

  async setNextTimestamp(timestamp: bigint): Promise<void> {
    await l1Rpc(this.rpcUrl, "evm_setNextBlockTimestamp", [quantity(timestamp)]);
  }

  snapshot(): Promise<string> {
    return l1Rpc<string>(this.rpcUrl, "evm_snapshot");
  }

  async revert(snapshotId: string): Promise<void> {
    const reverted = await l1Rpc<boolean>(this.rpcUrl, "evm_revert", [snapshotId]);
    if (!reverted) throw new Error(`Anvil refused snapshot ${snapshotId}`);
  }
}
