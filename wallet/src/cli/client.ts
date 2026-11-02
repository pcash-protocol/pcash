// HTTP transport and request serialization for pcash-wallet-cli.
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { memoSchema, claimedSenderSchema, MAX_RECORD_BYTES, type DataRecord } from "@pcash/sdk/delivery";
import { toHex } from "@pcash/sdk/utils";
import type { Cli, RecordInput } from "./cli.ts";

export class WalletHttpError extends Error {
  readonly status: number;
  /** A journaled transaction that may have been submitted; check its outcome before retrying. */
  readonly contentHash?: string;
  constructor(status: number, message: string, contentHash?: string) {
    super(message);
    this.status = status;
    if (contentHash !== undefined) this.contentHash = contentHash;
    this.name = "WalletHttpError";
  }
}

export class WalletHttpClient {
  readonly url: string;
  readonly token?: string;
  private readonly onRequest: (() => () => void) | undefined;
  constructor(url: string, token?: string, onRequest?: () => () => void) {
    this.url = url;
    this.onRequest = onRequest;
    if (token !== undefined) this.token = token;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token !== undefined) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const finish = this.onRequest?.();
    try {
      let response: Response;
      let text: string;
      try {
        response = await fetch(`${this.url.replace(/\/$/, "")}${path}`, {
          method,
          headers: this.headers(),
          redirect: "error",
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        text = await response.text();
      } catch {
        const endpoint = new URL(this.url).origin;
        throw new Error(`Could not complete the request to the wallet service at ${endpoint}. Start pcash-wallet or check --wallet-url / --data-dir.`
          + (method === "POST" ? " The action may have been submitted; check its outcome before retrying." : ""));
      }
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = { error: text };
        }
      }
      if (!response.ok) {
        const message = parsed !== null && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${response.status}`;
        const contentHash = parsed !== null && typeof parsed === "object" && "contentHash" in parsed
          && typeof (parsed as { contentHash: unknown }).contentHash === "string"
          ? (parsed as { contentHash: string }).contentHash
          : undefined;
        throw new WalletHttpError(response.status, response.status === 401
          ? "Wallet authentication failed. Use the server’s --data-dir, or set the same PCASH_WALLET_TOKEN in both terminals."
          : message, contentHash);
      }
      return parsed;
    } finally { finish?.(); }
  }

  /** Recovery material is sent only to the user's authenticated local service. */
  assertSeedImportAvailable(): void {
    const url = new URL(this.url);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
      || (url.pathname !== "" && url.pathname !== "/")) {
      throw new Error("wallet creation and recovery require a loopback wallet URL");
    }
    if (this.token === undefined || this.token.trim() === "") {
      throw new Error("wallet creation and recovery require local authentication; start pcash-wallet with the same --data-dir, or set PCASH_WALLET_TOKEN / --wallet-token");
    }
  }

  async preflightOnboarding(): Promise<void> {
    this.assertSeedImportAvailable();
    await this.request("GET", "/health");
  }

  async importMnemonic(mnemonic: string): Promise<unknown> {
    this.assertSeedImportAvailable();
    return this.request("POST", "/wallets/import", { mnemonic });
  }

  async dispatch(cli: Cli): Promise<unknown> {
    const wallet = cli.wallet;
    const submission = {
      ...(cli.submit === undefined ? {} : { submit: cli.submit }),
      ...(cli.privateRelayFee === undefined ? {} : { privateRelayFeeAmount: cli.privateRelayFee.toString() }),
      waitMode: cli.waitMode,
      ...(cli.l1Rpc === undefined ? {} : { l1Rpc: cli.l1Rpc }),
      ...(wallet === undefined ? {} : { wallet }),
    };
    switch (cli.command) {
      case "bulk": {
        if (cli.subcommand === "show") return this.request("GET", withQuery("/bulk", wallet));
        if (cli.subcommand === "step") return this.request("POST", "/bulk/step", {
          ...submission, jobId: cli.jobId, ...(cli.chunkIndex === undefined ? {} : { chunkIndex: cli.chunkIndex }),
        });
        const job: unknown = cli.subcommand === "start"
          ? JSON.parse(await readFile(cli.file!, "utf8"))
          : { kind: "consolidation", ...(cli.fee === undefined ? {} : { openFeeAmount: cli.fee.toString() }), maxTransactions: cli.maxTransactions,
            ...(cli.targetNotes === undefined ? {} : { targetNotes: cli.targetNotes }),
            ...(cli.shape === undefined ? {} : { shape: cli.shape }),
            ...(cli.assetId === undefined ? {} : { assetId: cli.assetId.toString() }) };
        return this.request("POST", "/bulk", { job, ...(wallet === undefined ? {} : { wallet }) });
      }
      case "balance":
        return this.request("GET", withQuery("/wallet", wallet));
      case "status":
        return this.request("GET", withQuery("/status", wallet));
      case "receive":
        return this.request("GET", withQuery("/code", wallet));
      case "sync":
        return this.request("POST", "/scan", {
          ...(wallet === undefined ? {} : { wallet }),
          full: cli.full,
        });
      case "mempool": {
        const query = new URLSearchParams();
        if (cli.mempoolContentHash !== undefined) query.set("contentHash", cli.mempoolContentHash);
        if (cli.cursor !== undefined) query.set("cursor", cli.cursor);
        if (cli.limit !== undefined) query.set("limit", cli.limit.toString());
        if (cli.kind !== undefined) query.set("kind", cli.kind);
        if (cli.minOpenFee !== undefined) query.set("minOpenFee", cli.minOpenFee.toString());
        const suffix = query.size === 0 ? "" : `?${query.toString()}`;
        return this.request("GET", `/mempool${suffix}`);
      }
      case "relay":
        return this.request("POST", "/relay", {
          contentHashes: cli.relayContentHashes,
          noSubmit: cli.noSubmit,
          daMode: cli.daMode,
          maxBlobs: cli.maxBlobs,
          ...(cli.l1Rpc === undefined ? {} : { l1Rpc: cli.l1Rpc }),
        });
      case "relay-journal":
        if (cli.subcommand === "show") return this.request("GET", "/relay-journal");
        if (cli.subcommand === "reconcile") {
          return this.request("POST", "/relay-journal/reconcile", {});
        }
        return this.request("POST", "/relay-journal/resolve", {
          transactionHash: cli.transactionHash,
        });
      case "asset": {
        if (cli.subcommand === "create") return this.request("POST", "/assets", { ...submission,
          name: cli.assetName, symbol: cli.assetSymbol, decimals: cli.assetDecimals, initialSupply: cli.assetSupply!.toString(),
          contentDigest: cli.assetContentDigest,
          ...(cli.fee === undefined ? {} : { openFeeAmount: cli.fee.toString() }),
          ...(cli.retryContentHash === undefined ? {} : { retryContentHash: cli.retryContentHash }),
          ...(cli.assetId === undefined ? {} : { assetId: cli.assetId.toString() }) });
        if (cli.subcommand === "list") return this.request("GET", withQuery("/assets", wallet));
        if (cli.subcommand === "import") {
          return this.request("POST", "/assets/import", { definition: cli.definition, ...(wallet === undefined ? {} : { wallet }) });
        }
        const terms = {
          ...(cli.fee === undefined ? {} : { openFeeAmount: cli.fee.toString() }),
          ...(cli.retryContentHash === undefined ? {} : { retryContentHash: cli.retryContentHash }),
        };
        if (cli.subcommand === "burn") {
          return this.request("POST", "/assets/burn", { ...submission, ...terms, assetId: cli.assetId!.toString(), amount: cli.amount!.toString() });
        }
        const outputs: unknown = cli.file !== undefined
          ? JSON.parse(await readFile(cli.file, "utf8"))
          : [{ to: cli.to, amount: cli.amount!.toString(), ...(cli.noteSecret === undefined ? {} : { noteSecret: cli.noteSecret.toString() }) }];
        return this.request("POST", "/assets/send", { ...submission, ...terms, assetId: cli.assetId!.toString(), outputs });
      }
      case "send": {
        const encoded: DataRecord[] = [];
        if (cli.memo !== undefined) encoded.push(memoSchema.encode(cli.memo));
        if (cli.includeSender) {
          const status = await this.request("GET", withQuery("/status", wallet)) as { address: string };
          encoded.push(claimedSenderSchema.encode(BigInt(status.address)));
        }
        const recipient = await wireRecords([...encoded.map(record => ({ schema: record.schema, data: toHex(record.data) })), ...cli.records.to]);
        const self = await wireRecords(cli.records.self), published = await wireRecords(cli.records.public);
        const data = {
          ...(recipient.length === 0 ? {} : { recipients: [{ to: cli.to, records: recipient }] }),
          ...(self.length === 0 ? {} : { self }),
          ...(published.length === 0 ? {} : { public: published }),
        };
        return this.request("POST", "/transfer", {
          ...submission,
          to: cli.to,
          ...(cli.shape === undefined ? {} : { shape: cli.shape }),
          amount: cli.amount!.toString(),
          ...(Object.keys(data).length === 0 ? {} : { data }),
          ...(cli.fee === undefined ? {} : { openFeeAmount: cli.fee.toString() }),
        });
      }
      case "account":
        return this.request("POST", "/account", {
          ...submission,
          ...(cli.fee === undefined ? {} : { openFeeAmount: cli.fee.toString() }),
        });
      case "wallet":
        if (cli.subcommand === "list") return this.request("GET", "/wallets");
        if (!cli.dev) throw new Error("seed wallet creation and recovery require the onboarding flow");
        return this.request("POST", "/wallets/import", {
          ...(cli.keyFile === undefined ? {} : { keyFile: cli.keyFile }),
        });
      case "receive-key":
        if (cli.subcommand === "list") return this.request("GET", withQuery("/receive-keys", wallet));
        if (cli.subcommand === "create") {
          return this.request("POST", "/receive-keys", {
            ...submission,
            create: true,
            ...(cli.publishReceiveKey ? { receiveKey: "replace" } : {}),
            ...(cli.fee === undefined ? {} : { openFeeAmount: cli.fee.toString() }),
          });
        }
        return this.request("POST", "/receive-keys", {
          ...submission,
          ...(cli.file === undefined ? {} : { file: cli.file }),
          ...(cli.publishReceiveKey ? { receiveKey: "replace" } : {}),
          ...(cli.fee === undefined ? {} : { openFeeAmount: cli.fee.toString() }),
        });
      default:
        throw new Error(`unsupported command ${cli.command}`);
    }
  }
}

/** Record files are the user's input: read at most one byte past the record limit. */
async function wireRecords(records: readonly RecordInput[]): Promise<{ schema: string; data: string }[]> {
  return Promise.all(records.map(async (record) => {
    if (!("file" in record)) return record;
    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream(record.file, { end: MAX_RECORD_BYTES })) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    if (bytes.length > MAX_RECORD_BYTES) throw new Error(`${record.file} exceeds the ${MAX_RECORD_BYTES}-byte record limit`);
    return { schema: record.schema, data: toHex(bytes) };
  }));
}

function withQuery(path: string, wallet: string | undefined): string {
  if (wallet === undefined) return path;
  return `${path}${path.includes("?") ? "&" : "?"}wallet=${encodeURIComponent(wallet)}`;
}
