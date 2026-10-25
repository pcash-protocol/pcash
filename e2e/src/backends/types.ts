import type { ManagedProcess } from "../framework/process.ts";

/**
 * The Ethereum chain a fixture's nodes follow. Only an Anvil the harness
 * launched exposes chain controls; a live L1 is observed, never steered.
 */
export interface L1Backend {
  /** Anvil mines every second; any other L1 gets Sepolia-scale waits and automatic DA. */
  readonly anvil: boolean;
  readonly chainId: bigint;
  readonly rpcUrl: string;
  readonly process?: ManagedProcess;
  blockNumber(): Promise<bigint>;
  mine?(count?: number): Promise<void>;
  setNextTimestamp?(timestamp: bigint): Promise<void>;
  snapshot?(): Promise<string>;
  revert?(snapshotId: string): Promise<void>;
}
