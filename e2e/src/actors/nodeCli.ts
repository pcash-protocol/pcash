import {
  expectCommandFailure,
  parseJsonOutput,
  runSuccessfulCommand,
  type CommandResult,
} from "../framework/command.ts";
import { eventually } from "../framework/eventually.ts";
import type { ManagedProcess } from "../framework/process.ts";

export type JsonObject = Record<string, unknown>;

export interface P2pIdentityJson extends JsonObject {
  peerId: string;
  keyType: string;
  publicKey: string;
  filePermissions: string | null;
  insecurePermissions: boolean;
  bootstrapAddress?: string;
}

export interface NodeInfoJson extends JsonObject {
  peerId: string;
  listenAddresses: string[];
  bootstrapAddresses: string[];
  advertised: boolean;
  topic: string;
  peerCount: string;
}

export interface PeerInfoJson extends JsonObject {
  peerId: string;
  direction: "inbound" | "outbound";
  compatible: boolean;
  bannedSeconds: string | null;
}

export class PcashCliActor {
  readonly binary: string;
  readonly rpcUrl: string;
  /** Admin commands need it; a live node's public RPC serves everything else. */
  readonly adminUrl: string | undefined;
  readonly cwd: string;
  readonly process: ManagedProcess | undefined;

  constructor(binary: string, rpcUrl: string, adminUrl: string | undefined, cwd: string, process?: ManagedProcess) {
    this.binary = binary;
    this.rpcUrl = rpcUrl;
    this.adminUrl = adminUrl;
    this.cwd = cwd;
    this.process = process;
  }

  async run<T = JsonObject>(args: readonly string[], timeoutMs = 30_000): Promise<T> {
    const result = await runSuccessfulCommand(this.binary, this.#args(args), { cwd: this.cwd, timeoutMs });
    return parseJsonOutput<T>(result);
  }

  status<T = JsonObject>(): Promise<T> {
    return this.run<T>(["status"]);
  }

  nodeInfo<T = JsonObject>(): Promise<T> {
    return this.run<T>(["node-info"]);
  }

  peers<T = PeerInfoJson[]>(): Promise<T> {
    return this.run<T>(["peers"]);
  }

  addPeer<T = { peerId: string }>(address: string): Promise<T> {
    return this.run<T>(["add-peer", address]);
  }

  removePeer<T = { removed: boolean; banned: boolean }>(peerId: string, ban = false): Promise<T> {
    return this.run<T>(["remove-peer", peerId, ...(ban ? ["--ban"] : [])]);
  }

  p2pKeyGenerate<T = P2pIdentityJson>(path: string, address?: string): Promise<T> {
    return this.run<T>([
      "p2p-key", "generate", "--out", path,
      ...(address === undefined ? [] : ["--addr", address]),
    ]);
  }

  p2pKeyInspect<T = P2pIdentityJson>(path: string, address?: string): Promise<T> {
    return this.run<T>([
      "p2p-key", "inspect", path,
      ...(address === undefined ? [] : ["--addr", address]),
    ]);
  }

  block<T = JsonObject>(height?: bigint): Promise<T> {
    return height === undefined
      ? this.run<T>(["get-block-header"])
      : this.run<T>(["get-block-by-number", height.toString()]);
  }

  blocks<T = JsonObject>(from?: bigint, to?: bigint): Promise<T> {
    const args = ["get-blocks"];
    if (from !== undefined) args.push("--from", from.toString());
    if (to !== undefined) args.push("--to", to.toString());
    return this.run<T>(args);
  }

  account<T = JsonObject>(address: string): Promise<T> {
    return this.run<T>(["get-account", address]);
  }

  accountProof<T = JsonObject>(address: string): Promise<T> {
    return this.run<T>(["get-account-proof", address]);
  }

  outputs<T = JsonObject>(request: Record<string, unknown>): Promise<T> {
    return this.run<T>(["get-outputs", JSON.stringify(request)]);
  }

  receipt<T = unknown>(transactionId: string): Promise<T> {
    return this.run<T>(["get-receipt", "--tx-id", transactionId]);
  }

  receiptByContent<T = unknown>(contentHash: string): Promise<T> {
    return this.run<T>(["get-receipt", "--content-hash", contentHash]);
  }

  mempool<T = JsonObject>(options: { cursor?: string; limit?: number; kind?: string } = {}): Promise<T> {
    const args = ["get-mempool"];
    if (options.cursor !== undefined) args.push("--cursor", options.cursor);
    if (options.limit !== undefined) args.push("--limit", String(options.limit));
    if (options.kind !== undefined) args.push("--kind", options.kind);
    return this.run<T>(args);
  }

  mempoolTransaction<T = JsonObject | null>(contentHash: string): Promise<T> {
    return this.run<T>(["get-mempool-transaction", contentHash]);
  }

  nullifiersSpent<T = readonly boolean[]>(nullifiers: readonly string[]): Promise<T> {
    if (nullifiers.length === 0) throw new Error("at least one nullifier is required");
    return this.run<T>(["are-nullifiers-spent", ...nullifiers]);
  }

  nullifierProofs<T = JsonObject>(nullifiers: readonly string[]): Promise<T> {
    if (nullifiers.length === 0) throw new Error("at least one nullifier is required");
    return this.run<T>(["get-nullifier-proofs", ...nullifiers]);
  }

  submitRaw<T extends { contentHash: string } = { contentHash: string }>(transactionHex: string): Promise<T> {
    return this.run<T>(["submit-raw-transaction", transactionHex], 120_000);
  }

  expectedFailure(args: readonly string[], stderr?: RegExp): Promise<CommandResult> {
    return expectCommandFailure(
      this.binary,
      this.#args(args),
      { cwd: this.cwd, timeoutMs: 120_000, ...(stderr === undefined ? {} : { stderr }) },
    );
  }

  #args(args: readonly string[]): string[] {
    return [
      "--rpc-url", this.rpcUrl,
      ...(this.adminUrl === undefined ? [] : ["--admin-url", this.adminUrl]),
      "--json", ...args,
    ];
  }

  async assertNeverAccepted(contentHash: string, durationMs = 5_000): Promise<void> {
    const deadline = Date.now() + durationMs;
    await eventually(
      `transaction ${contentHash} to remain rejected`,
      async () => {
        const value = await this.receiptByContent<unknown>(contentHash);
        const accepted = receiptAccepted(value);
        if (accepted) throw new Error(`rejected transaction ${contentHash} later received an accepted receipt`);
        return Date.now();
      },
      (now) => now >= deadline,
      {
        timeoutMs: durationMs + 2_000,
        intervalMs: 250,
        cancellation: () => this.process?.cancellationReason() ?? null,
      },
    );
  }
}

export function receiptAccepted(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(receiptAccepted);
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.outcome === "succeeded" || record.status === "accepted" || receiptAccepted(record.receipts);
}
