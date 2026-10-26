import { storeTransactionData, type TransactionData, type DataRecord } from "@pcash/sdk/delivery";
import { BN254_SCALAR_MODULUS } from "@pcash/sdk/crypto";
import { formatAssetDefinition, parseAssetDefinition, type AssetDefinition } from "@pcash/sdk/protocol";
import { bytes32Hex, fromHex, toHex, U128_LIMIT } from "@pcash/sdk/utils";
import { stringify } from "viem";
import { inspect } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DurablePreBroadcastError,
  WalletConflictError,
  type AssetSendOutput,
  type DurableSubmissionAdapter,
  type Wallet,
  type WalletAsset,
  type WalletBulkJob,
} from "@pcash/sdk/wallet";
import { synchronizedThrough } from "@pcash/sdk/wallet/scanning";
import type { SyncWalletResult } from "@pcash/sdk/wallet/actions";
import type { SelectedRelayQuoteProvider } from "@pcash/sdk/eip712";
import type { MempoolQuery, PcashNodeClient } from "@pcash/sdk/clients";
import type { Relayer, RelayJournalRecovery } from "@pcash/sdk/relay";
import {
  publicErrorMessage,
  RelayDeadlineError,
  RelayJournalConflictError,
  RelayPreBroadcastError,
  RelayUpstreamError,
  RelayValidationError,
} from "@pcash/sdk/relay";
import type { LoggerContext } from "@pcash/sdk/blgr";
import {
  normalizeWalletHttpMethod,
  normalizeWalletHttpRoute,
  type WalletServiceMetrics,
} from "./metricsTypes.ts";
import {
  hasExpectedLoopbackOrigin,
  loopbackRequestAuthority,
} from "./requestSecurity.ts";

/** The largest single region an S arena holds; the builder checks the exact fit before proving. */

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

/**
 * What a submission carries when that changes which L1 publication is safe:
 * signed registration, or an account request that is registration or an
 * update depending on the account's state when it runs.
 */
export type SubmissionPurpose = "registration" | "account-update";

/**
 * The request's transport; `wallet` selects whose poster commitment an L1
 * publication names. `node`, when set, is the node every adapter it returns
 * publishes through.
 */
export type SubmissionFor = ((body: Record<string, unknown>, wallet: string | undefined, purpose?: SubmissionPurpose) => DurableSubmissionAdapter)
  & { readonly node?: PcashNodeClient };

export interface WalletHttpContext {
  token?: string;
  /** Where a failure's full error chain goes; a response carries only its message. */
  logger: Pick<LoggerContext, "error">;
  metrics?: WalletServiceMetrics;
  node: Pick<PcashNodeClient, "status">;
  relay: Pick<Relayer, "getMempool" | "getMempoolTransaction" | "relay">;
  relayJournal: RelayJournalRecovery;
  selectedRelayQuote?: SelectedRelayQuoteProvider;
  runtimeFor(wallet?: string): Wallet;
  listWallets(): unknown;
  importWallet(body: Record<string, unknown>): Promise<unknown>;
  createReceiveKey(wallet: string | undefined, body: Record<string, unknown>): Promise<unknown>;
  importReceiveKey(wallet: string | undefined, body: Record<string, unknown>): Promise<unknown>;
  listReceiveKeys(wallet: string | undefined): unknown | Promise<unknown>;
  submissionFor: SubmissionFor;
  /** Where signed registration goes when the request names no path. */
  registrationSubmit: "l1" | "mempool";
  sync(wallet: string | undefined, full: boolean): Promise<SyncWalletResult>;
}

class HttpValidationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HttpValidationError";
  }
}

function readBody(request: IncomingMessage, maximumBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer | string) => {
      if (rejected) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > maximumBytes) {
        rejected = true;
        reject(new HttpValidationError(`request body exceeds ${maximumBytes} bytes`));
        return;
      }
      chunks.push(bytes);
    });
    request.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

async function requestBody(request: IncomingMessage, maximumBytes = MAX_REQUEST_BODY_BYTES): Promise<Record<string, unknown>> {
  const raw = await readBody(request, maximumBytes);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new HttpValidationError("request body must be valid JSON", error);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpValidationError("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const json = stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(json);
}

function hasJsonContentType(request: IncomingMessage): boolean {
  const contentType = request.headers["content-type"];
  return typeof contentType === "string"
    && contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function presentAction(result: unknown, account = false): unknown {
  if (result === null || typeof result !== "object") return result;
  const value = result as Record<string, unknown>;
  const nested = value.submission as { output?: unknown } | null | undefined;
  const rawOutput = nested?.output ?? value.output;
  const output = rawOutput !== null && typeof rawOutput === "object"
    ? rawOutput as Record<string, unknown>
    : {};
  return {
    ...value,
    path: output.path ?? (value.queued === true ? "mempool" : "pending"),
    submit: output,
    ...(account ? { accountAccepted: value.accepted === true } : {}),
  };
}

/** Signed registration takes the request's path, else the service's default: L1, or the mempool in Tor mode. */
export function accountCreationSubmission(
  submissionFor: SubmissionFor,
  body: Record<string, unknown>,
  wallet: string | undefined,
  defaultSubmit: WalletHttpContext["registrationSubmit"],
  recovery?: () => Promise<RelayJournalRecovery>,
): DurableSubmissionAdapter {
  if (body.submit === "selected") return {
    mode: "mempool",
    preflight: async () => { throw new HttpValidationError("proof-free account creation cannot pay a selected relayer"); },
    submit: async () => { throw new HttpValidationError("proof-free account creation cannot pay a selected relayer"); },
  };
  const submit = body.submit ?? defaultSubmit;
  let adapter: DurableSubmissionAdapter | undefined;
  const transport = () => adapter ??= submissionFor({ ...body, submit }, wallet, "registration");
  return {
    mode: submit === "l1" ? "l1" : "mempool",
    ...(submissionFor.node === undefined ? {} : { node: submissionFor.node }),
    ...(recovery === undefined ? {} : { l1Recovery: recovery }),
    preflight: async (context) => transport().preflight(context),
    submit: async (context) => transport().submit(context),
    isDefinitePreBroadcastError: (error) => adapter?.isDefinitePreBroadcastError?.(error) === true,
  };
}

export function privateRelayTerms(body: Record<string, unknown>, selectedRelayQuote?: SelectedRelayQuoteProvider) {
  const privateRelayFeeAmount = decimalBigint(body.privateRelayFeeAmount);
  if (body.privateRelayFeeAmount !== undefined && privateRelayFeeAmount === undefined) {
    throw new HttpValidationError("privateRelayFeeAmount must be a decimal string");
  }
  if (body.submit === "selected") {
    if (privateRelayFeeAmount === undefined || privateRelayFeeAmount === 0n || selectedRelayQuote === undefined) {
      throw new HttpValidationError("selected submission requires a positive privateRelayFeeAmount and configured quote session");
    }
    return { privateRelayFeeAmount, selectedRelayQuote };
  }
  if (privateRelayFeeAmount !== undefined) throw new HttpValidationError("privateRelayFeeAmount requires selected submission");
  return {};
}

function query(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

function selectedWallet(url: URL, body: Record<string, unknown>): string | undefined {
  if (body.wallet === undefined) return query(url, "wallet");
  if (typeof body.wallet !== "string") throw new HttpValidationError("wallet must be a string");
  return body.wallet;
}

function decimalBigint(value: unknown): bigint | undefined {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
    ? BigInt(value)
    : undefined;
}

function fieldValue(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(?:0x[0-9a-fA-F]{1,64}|0|[1-9][0-9]*)$/.test(value)) {
    throw new HttpValidationError(`${label} must be a 0x-hex or decimal field element`);
  }
  const parsed = BigInt(value);
  if (parsed >= BN254_SCALAR_MODULUS) throw new HttpValidationError(`${label} must be a BN254 scalar field element`);
  return parsed;
}

function nonzeroField(value: unknown, label: string): bigint {
  const parsed = fieldValue(value, label);
  if (parsed === 0n) throw new HttpValidationError(`${label} must be nonzero`);
  return parsed;
}

function noteAmount(value: unknown, label: string): bigint {
  const amount = decimalBigint(value);
  if (amount === undefined || amount <= 0n || amount >= U128_LIMIT) {
    throw new HttpValidationError(`${label} must be a positive uint128 decimal string`);
  }
  return amount;
}

function optionalRetryContentHash(body: Record<string, unknown>): { retryContentHash?: string } {
  if (body.retryContentHash === undefined) return {};
  if (typeof body.retryContentHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.retryContentHash)) {
    throw new HttpValidationError("retryContentHash must be a 32-byte content hash");
  }
  return { retryContentHash: body.retryContentHash };
}

function optionalOpenFee(body: Record<string, unknown>): { openFeeAmount?: bigint } {
  if (body.openFeeAmount === undefined) return {};
  const openFeeAmount = decimalBigint(body.openFeeAmount);
  if (openFeeAmount === undefined) throw new HttpValidationError("openFeeAmount must be a decimal string");
  return { openFeeAmount };
}

function presentDefinition(definition: AssetDefinition) {
  return {
    text: formatAssetDefinition(definition),
    name: definition.metadata.name,
    symbol: definition.metadata.symbol,
    decimals: definition.metadata.decimals,
    contentDigest: toHex(definition.metadata.contentDigest),
    initialSupply: definition.initialSupply,
  };
}

function presentAsset(asset: WalletAsset) {
  return {
    assetId: bytes32Hex(asset.assetId),
    definition: asset.definition === null ? null : presentDefinition(asset.definition),
    private: asset.private,
    spendable: asset.spendable,
    created: asset.created,
  };
}

function parseAssetSendOutputs(value: unknown): AssetSendOutput[] {
  if (!Array.isArray(value) || value.length === 0) throw new HttpValidationError("outputs must be a nonempty array");
  return value.map((item: unknown, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new HttpValidationError(`outputs[${index}] must be an object`);
    const output = item as Record<string, unknown>;
    if (typeof output.to !== "string" || output.to.length === 0) throw new HttpValidationError(`outputs[${index}].to is required`);
    return {
      to: output.to,
      amount: noteAmount(output.amount, `outputs[${index}].amount`),
      ...(output.noteSecret === undefined ? {} : { noteSecret: fieldValue(output.noteSecret, `outputs[${index}].noteSecret`) }),
    };
  });
}

/** Authenticated HTTP input. Record payloads use hex; schema validation is shared with the SDK. */
function parseTransactionData(value: unknown): TransactionData | undefined {
  if (value === undefined) return undefined;
  const object = (value: unknown): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpValidationError("data audiences and records must be objects");
    return value as Record<string, unknown>;
  };
  const records = (value: unknown): DataRecord[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new HttpValidationError("records must be an array");
    return value.map(item => {
      const record = object(item);
      if (typeof record.schema !== "string" || typeof record.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(record.data)) throw new HttpValidationError("records require a schema and hex data");
      return { schema: record.schema, data: fromHex(record.data) };
    });
  };
  const data = object(value);
  if (data.recipients !== undefined && !Array.isArray(data.recipients)) throw new HttpValidationError("data.recipients must be an array");
  const parsed: TransactionData = { self: records(data.self), public: records(data.public), recipients: ((data.recipients ?? []) as unknown[]).map(value => {
    const recipient = object(value);
    if (typeof recipient.to !== "string") throw new HttpValidationError("data recipient requires to");
    return { to: recipient.to, records: records(recipient.records) };
  }) };
  try { storeTransactionData(parsed); } catch (error) { throw new HttpValidationError((error as Error).message); }
  return parsed;
}

function positiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) throw new HttpValidationError(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpValidationError(`${label} is too large`);
  return parsed;
}

function nonnegativeBigint(value: string | undefined, label: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new HttpValidationError(`${label} must be a nonnegative integer`);
  }
  return BigInt(value);
}

function publicRecoveredNote(note: SyncWalletResult["recovered"][number]) {
  return {
    leafIndex: note.leafIndex.toString(),
    outputIndex: note.outputIndex,
    assetId: `0x${note.assetId.toString(16)}`,
    amount: note.amount.toString(),
    outputCommitment: `0x${note.outputCommitment.toString(16)}`,
  };
}

async function walletStatus(
  nodeClient: Pick<PcashNodeClient, "status">,
  runtime: Wallet,
): Promise<unknown> {
  const [node, wallet] = await Promise.all([nodeClient.status(), runtime.snapshot()]);
  const syncedThrough = wallet.syncedThrough;
  const nodeTip = {
    pcashNumber: node.latestBlock,
    pcashHash: node.latestBlockHash,
  };
  return {
    address: wallet.address,
    network: wallet.network,
    balances: wallet.balances,
    finalizedThrough: wallet.finalizedThrough,
    pendingActionCount: wallet.pendingActionCount,
    scan: {
      syncedThrough,
      nodeTip,
      caughtUp: synchronizedThrough(node, syncedThrough),
    },
  };
}

async function walletView(runtime: Wallet): Promise<unknown> {
  const snapshot = await runtime.snapshot();
  const native = snapshot.balances.find((balance) => balance.assetId === 0n)
    ?? { private: 0n, spendable: 0n };
  return {
    address: snapshot.address,
    syncedThrough: snapshot.syncedThrough,
    finalizedThrough: snapshot.finalizedThrough,
    notes: snapshot.ownedNoteCount,
    private: native.private,
    spendable: native.spendable,
    balances: snapshot.balances,
    receiveKeys: snapshot.receiveKeys,
  };
}

export async function handleWalletHttp(
  request: IncomingMessage,
  response: ServerResponse,
  context: WalletHttpContext,
): Promise<void> {
  const metricContext = {
    method: normalizeWalletHttpMethod(request.method),
    route: normalizeWalletHttpRoute(request.url),
  };
  const startedAtMilliseconds = performance.now();
  const journaled = journaledAction();
  try {
    const authority = loopbackRequestAuthority(request);
    if (authority === undefined) {
      send(response, 400, { error: "unexpected Host header" });
      return;
    }
    if (!hasExpectedLoopbackOrigin(request, authority)) {
      send(response, 403, { error: "unexpected Origin header" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://wallet.local");
    const journalRoute = url.pathname === "/relay-journal"
      || url.pathname.startsWith("/relay-journal/");
    const authorized = context.token !== undefined
      && request.headers.authorization === `Bearer ${context.token}`;
    if ((context.token !== undefined && !authorized) || (journalRoute && !authorized)) {
      send(response, 401, { error: "unauthorized" });
      return;
    }

    const method = request.method ?? "GET";
    const wallet = query(url, "wallet");

    if (method === "GET" && url.pathname === "/health") {
      const status = await context.node.status();
      send(response, 200, { ok: true, latestBlock: status.latestBlock, wallets: context.listWallets() });
      return;
    }
    if (method === "GET" && url.pathname === "/status") {
      send(response, 200, await walletStatus(context.node, context.runtimeFor(wallet)));
      return;
    }
    if (method === "GET" && url.pathname === "/mempool") {
      const contentHash = query(url, "contentHash");
      if (contentHash !== undefined) {
        send(response, 200, await context.relay.getMempoolTransaction(contentHash));
        return;
      }
      const limit = positiveInteger(query(url, "limit"), "limit");
      const minOpenFee = nonnegativeBigint(query(url, "minOpenFee"), "minOpenFee");
      const cursor = query(url, "cursor");
      const kind = query(url, "kind");
      const mempoolQuery: MempoolQuery = {
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
        ...(kind === undefined ? {} : { kind }),
        ...(minOpenFee === undefined ? {} : { minOpenFee }),
      };
      send(response, 200, await context.relay.getMempool(mempoolQuery));
      return;
    }
    if (method === "GET" && url.pathname === "/relay-journal") {
      send(response, 200, await context.relayJournal.show());
      return;
    }
    if (method === "GET" && url.pathname === "/bulk") {
      send(response, 200, (await context.runtimeFor(wallet).bulkJobs()).map(bulkJobSummary));
      return;
    }
    if (method === "GET" && url.pathname === "/assets") {
      send(response, 200, (await context.runtimeFor(wallet).assets()).map(presentAsset));
      return;
    }
    if (method === "GET" && url.pathname === "/code") {
      send(response, 200, await context.runtimeFor(wallet).receiveCode());
      return;
    }
    if (method === "GET" && url.pathname === "/wallet") {
      send(response, 200, await walletView(context.runtimeFor(wallet)));
      return;
    }
    if (method === "GET" && url.pathname === "/wallets") {
      send(response, 200, context.listWallets());
      return;
    }
    if (method === "GET" && url.pathname === "/receive-keys") {
      send(response, 200, await context.listReceiveKeys(wallet));
      return;
    }
    if (method !== "POST") {
      send(response, 404, { error: `unknown route ${method} ${url.pathname}` });
      return;
    }
    if (!hasJsonContentType(request)) {
      send(response, 415, { error: "mutating requests require content-type application/json" });
      return;
    }
    const body = await requestBody(request, url.pathname === "/bulk" ? 2 * 1024 * 1024 : MAX_REQUEST_BODY_BYTES);
    const bodyWallet = selectedWallet(url, body);

    if (url.pathname === "/scan") {
      if (body.full !== undefined && typeof body.full !== "boolean") {
        send(response, 400, { error: "full must be a boolean" });
        return;
      }
      const runtime = context.runtimeFor(bodyWallet);
      const result = await context.sync(bodyWallet, body.full === true);
      const wallet = await walletView(runtime) as {
        syncedThrough: unknown;
        notes: number;
        spendable: bigint;
      };
      send(response, 200, {
        scanned: result.scanned,
        trialDecryptAttempts: result.trialDecryptAttempts,
        decrypted: result.decrypted,
        recoveredCount: result.recovered.length,
        recovered: result.recovered.map(publicRecoveredNote),
        syncedThrough: result.syncedThrough,
        outputRange: { from: result.startedAtOutputIndex, to: result.nextOutputIndex },
        wallet: {
          syncedThrough: wallet.syncedThrough,
          notes: wallet.notes,
          spendable: wallet.spendable,
          balance: wallet.spendable,
        },
      });
      return;
    }
    if (url.pathname === "/bulk") {
      const job = parseBulkJobRequest(body.job);
      send(response, 200, bulkJobSummary(await context.runtimeFor(bodyWallet).startBulkJob(job)));
      return;
    }
    if (url.pathname === "/bulk/step") {
      if (typeof body.jobId !== "string" || !/^[0-9a-f]+$/.test(body.jobId)) throw new HttpValidationError("jobId is required");
      const jobId = body.jobId;
      const chunkIndex = body.chunkIndex;
      if (chunkIndex !== undefined && (typeof chunkIndex !== "number" || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0)) {
        throw new HttpValidationError("chunkIndex must be a nonnegative integer");
      }
      const relayTerms = privateRelayTerms(body, context.selectedRelayQuote);
      const submission = context.submissionFor(body, bodyWallet);
      const result = await context.runtimeFor(bodyWallet).runBulkJobStep({
        jobId, ...(chunkIndex === undefined ? {} : { chunkIndex }), submission, ...relayTerms, onPrepared: journaled.record,
      });
      // Do not print recipient plaintext, pending note openings, or witness data.
      send(response, 200, result.state === "submitted" ? { state: result.state, jobId: result.jobId,
        chunkIndex: result.chunkIndex, contentHash: result.result.contentHash, accepted: result.result.accepted, queued: result.result.queued } : result);
      return;
    }
    if (url.pathname === "/transfer") {
      const shape = body.shape;
      if (shape !== undefined && shape !== 0 && shape !== 1) throw new HttpValidationError("shape must be 0 (S) or 1 (L)");
      const data = parseTransactionData(body.data);
      const amount = decimalBigint(body.amount);
      if (typeof body.to !== "string" || amount === undefined) {
        send(response, 400, { error: "transfer requires to and a nonnegative decimal-string amount" });
        return;
      }
      const openFeeAmount = decimalBigint(body.openFeeAmount);
      if (body.openFeeAmount !== undefined && openFeeAmount === undefined) {
        send(response, 400, { error: "openFeeAmount must be a decimal string" });
        return;
      }
      const submission = context.submissionFor(body, bodyWallet);
      send(response, 200, presentAction(await context.runtimeFor(bodyWallet).send({
        to: body.to,
        amount,
        ...(data === undefined ? {} : { data }),
        ...(shape === undefined ? {} : { shape }),
        ...(openFeeAmount === undefined ? {} : { openFeeAmount }),
        ...privateRelayTerms(body, context.selectedRelayQuote),
        submission,
        onPrepared: journaled.record,
      })));
      return;
    }
    if (url.pathname === "/assets") {
      const initialSupply = decimalBigint(body.initialSupply);
      const retry = optionalRetryContentHash(body);
      const openFee = optionalOpenFee(body);
      if (typeof body.name !== "string" || typeof body.symbol !== "string" || typeof body.decimals !== "number" || initialSupply === undefined || initialSupply <= 0n) {
        send(response, 400, { error: "asset creation requires name, symbol, numeric decimals and positive initialSupply" }); return;
      }
      if (typeof body.contentDigest !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.contentDigest)) {
        throw new HttpValidationError("contentDigest must be a 32-byte 0x-hex digest");
      }
      const assetId = body.assetId === undefined ? undefined : nonzeroField(body.assetId, "assetId");
      const relayTerms = privateRelayTerms(body, context.selectedRelayQuote);
      const submission = context.submissionFor(body, bodyWallet);
      const result = await context.runtimeFor(bodyWallet).createAsset({
        metadata: { name: body.name, symbol: body.symbol, decimals: body.decimals, contentDigest: fromHex(body.contentDigest) },
        initialSupply, ...openFee, ...retry,
        ...(assetId === undefined ? {} : { assetId }),
        ...relayTerms, submission, onPrepared: journaled.record,
      });
      send(response, 200, presentAction({ ...result, assetId: bytes32Hex(result.assetId), definition: presentDefinition(result.definition) }));
      return;
    }
    if (url.pathname === "/assets/send" || url.pathname === "/assets/burn") {
      const assetId = nonzeroField(body.assetId, "assetId");
      const openFee = optionalOpenFee(body);
      const retry = optionalRetryContentHash(body);
      const intent = url.pathname === "/assets/send"
        ? { outputs: parseAssetSendOutputs(body.outputs), data: parseTransactionData(body.data) }
        : { amount: noteAmount(body.amount, "amount") };
      const relayTerms = privateRelayTerms(body, context.selectedRelayQuote);
      const submission = context.submissionFor(body, bodyWallet);
      const runtime = context.runtimeFor(bodyWallet);
      const result = "outputs" in intent
        ? await runtime.sendAsset({
          assetId, outputs: intent.outputs,
          ...(intent.data === undefined ? {} : { data: intent.data }),
          ...openFee, ...retry, ...relayTerms, submission, onPrepared: journaled.record,
        })
        : await runtime.burnAsset({ assetId, amount: intent.amount, ...openFee, ...retry, ...relayTerms, submission, onPrepared: journaled.record });
      send(response, 200, presentAction({ ...result, assetId: bytes32Hex(result.assetId) }));
      return;
    }
    if (url.pathname === "/assets/import") {
      if (typeof body.definition !== "string") throw new HttpValidationError("definition must be share text or a share link");
      let definition: AssetDefinition;
      try {
        definition = parseAssetDefinition(body.definition);
      } catch (error) {
        throw new HttpValidationError(`asset definition is invalid: ${error instanceof Error ? error.message : String(error)}`, error);
      }
      const { assetId } = await context.runtimeFor(bodyWallet).importAssetDefinition(definition);
      send(response, 200, { assetId: bytes32Hex(assetId) });
      return;
    }
    if (url.pathname === "/account") {
      const openFeeAmount = decimalBigint(body.openFeeAmount);
      if (body.openFeeAmount !== undefined && openFeeAmount === undefined) {
        send(response, 400, { error: "openFeeAmount must be a decimal string" });
        return;
      }
      const submission = context.submissionFor(body, bodyWallet, "account-update");
      send(response, 200, presentAction(await context.runtimeFor(bodyWallet).updateAccount({
        ...(openFeeAmount === undefined ? {} : { openFeeAmount }),
        ...privateRelayTerms(body, context.selectedRelayQuote),
        submission,
        userAccountCreationSubmission: accountCreationSubmission(context.submissionFor, body, bodyWallet, context.registrationSubmit, async () => context.relayJournal),
        onPrepared: journaled.record,
      }), true));
      return;
    }
    if (url.pathname === "/relay") {
      if (
        body.contentHashes !== undefined
        && (!Array.isArray(body.contentHashes) || body.contentHashes.some((contentHash) => typeof contentHash !== "string"))
      ) {
        send(response, 400, { error: "contentHashes must be an array of content-hash strings" });
        return;
      }
      if (body.noSubmit !== undefined && typeof body.noSubmit !== "boolean") {
        send(response, 400, { error: "noSubmit must be a boolean" });
        return;
      }
      if (body.maxBlobs !== undefined && typeof body.maxBlobs !== "number") {
        send(response, 400, { error: "maxBlobs must be a number" });
        return;
      }
      if (body.daMode !== undefined && typeof body.daMode !== "string") {
        send(response, 400, { error: "daMode must be a string" });
        return;
      }
      if (
        typeof body.daMode === "string"
        && body.daMode !== "auto"
        && body.daMode !== "calldata"
        && body.daMode !== "blobs"
      ) {
        send(response, 400, { error: "daMode expects auto, calldata, or blobs" });
        return;
      }
      if (body.l1Rpc !== undefined && typeof body.l1Rpc !== "string") {
        send(response, 400, { error: "l1Rpc must be a string" });
        return;
      }
      const contentHashes = body.contentHashes as string[] | undefined;
      send(response, 200, await context.relay.relay({
        ...(contentHashes === undefined ? {} : { contentHashes }),
        ...(typeof body.noSubmit === "boolean" ? { noSubmit: body.noSubmit } : {}),
        ...(typeof body.maxBlobs === "number" ? { maxBlobs: body.maxBlobs } : {}),
        ...(
          body.daMode === "auto" || body.daMode === "calldata" || body.daMode === "blobs"
            ? { daMode: body.daMode }
            : {}
        ),
        ...(typeof body.l1Rpc === "string" ? { l1Rpc: body.l1Rpc } : {}),
      }));
      return;
    }
    if (url.pathname === "/relay-journal/reconcile") {
      send(response, 200, await context.relayJournal.reconcile());
      return;
    }
    if (url.pathname === "/relay-journal/resolve") {
      if (typeof body.transactionHash !== "string") {
        send(response, 400, { error: "transactionHash is required" });
        return;
      }
      send(response, 200, await context.relayJournal.resolve(body.transactionHash));
      return;
    }
    if (url.pathname === "/wallets/import") {
      send(response, 200, await context.importWallet(body));
      return;
    }
    if (url.pathname === "/receive-keys") {
      const result = body.create === true
        ? await context.createReceiveKey(bodyWallet, body)
        : await context.importReceiveKey(bodyWallet, body);
      send(response, 200, result);
      return;
    }
    send(response, 404, { error: `unknown route ${method} ${url.pathname}` });
  } catch (error) {
    const status = httpStatus(error);
    const contentHash = journaled.inDoubt(error);
    // The caller gets our message; the operator's log gets the whole chain.
    if (status >= 500 || contentHash !== undefined) {
      context.logger.error(`${metricContext.method} ${metricContext.route} failed with ${status}`
        + `${contentHash === undefined ? "" : `; transaction ${contentHash} may have been submitted`}: ${inspect(error, { depth: 8 })}`);
    }
    send(response, status, { error: publicErrorMessage(error), ...(contentHash === undefined ? {} : { contentHash }) });
  } finally {
    try {
      context.metrics?.recordHttpRequest({
        ...metricContext,
        status: response.statusCode,
        durationSeconds: Math.max(0, performance.now() - startedAtMilliseconds) / 1000,
      });
    } catch {
      // Instrumentation is observational and cannot alter HTTP handling.
    }
  }
}

/**
 * The action a request journaled. Once its bytes are journaled, any failure
 * other than a definite pre-broadcast refusal may leave them submitted, so the
 * response names their content hash.
 */
function journaledAction() {
  let contentHash: string | undefined;
  return {
    record: (journaledContentHash: string) => { contentHash = journaledContentHash; },
    inDoubt: (error: unknown) => isPreBroadcast(error) ? undefined : contentHash,
  };
}

/** A failure before anything was broadcast: the action's bytes were not sent. */
function isPreBroadcast(error: unknown): error is DurablePreBroadcastError | RelayPreBroadcastError {
  return error instanceof DurablePreBroadcastError || error instanceof RelayPreBroadcastError;
}

function httpStatus(error: unknown): number {
  if (error instanceof WalletConflictError || error instanceof RelayJournalConflictError) return 409;
  if (error instanceof RelayDeadlineError) return 504;
  if (error instanceof RelayUpstreamError) return 502;
  // Nothing was sent: an upstream failure keeps its status, anything else is a refusal.
  if (isPreBroadcast(error)) {
    const nested = httpStatus(error.cause);
    return nested === 500 ? 400 : nested;
  }
  if (error instanceof RelayValidationError || error instanceof HttpValidationError) return 400;
  return 500;
}

/** Recipients stay out of service output. */
function bulkJobSummary(job: WalletBulkJob) {
  const { recipients, recovery, ...summary } = job;
  return { ...summary, recipientCount: recipients.length,
    recovery: recovery == null ? null : { ...recovery, appTag: toHex(recovery.appTag) } };
}

/** The HTTP client, not stored wallet state, supplies this configuration. An absent fee resolves at approval. */
function parseBulkJobRequest(value: unknown): {
  kind: "payment" | "consolidation"; openFeeAmount?: bigint; maxTransactions: number;
  recipients?: { to: string; amount: bigint; noteSecret?: bigint }[]; targetNotes?: number; assetId?: bigint; shape?: 0 | 1;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpValidationError("job must be an object");
  const job = value as Record<string, unknown>;
  if (job.kind !== "payment" && job.kind !== "consolidation") throw new HttpValidationError("job.kind must be payment or consolidation");
  const openFeeAmount = job.openFeeAmount === undefined ? undefined : decimalBigint(job.openFeeAmount);
  if (job.openFeeAmount !== undefined && (openFeeAmount === undefined || openFeeAmount >= U128_LIMIT)) throw new HttpValidationError("job.openFeeAmount must be a uint128 decimal string");
  if (typeof job.maxTransactions !== "number" || !Number.isSafeInteger(job.maxTransactions) || job.maxTransactions < 1) throw new HttpValidationError("job.maxTransactions must be positive");
  const shape = job.shape;
  if (shape !== undefined && shape !== 0 && shape !== 1) throw new HttpValidationError("job.shape must be 0 (S) or 1 (L)");
  const assetId = job.assetId === undefined ? undefined : fieldValue(job.assetId, "job.assetId");
  const targetNotes = job.targetNotes;
  if (targetNotes !== undefined && (typeof targetNotes !== "number" || !Number.isSafeInteger(targetNotes) || targetNotes < 1)) throw new HttpValidationError("job.targetNotes must be positive");
  const rawRecipients = job.recipients ?? [];
  if (!Array.isArray(rawRecipients) || rawRecipients.length > 10_000) throw new HttpValidationError("job.recipients must be an array of at most 10000 recipients");
  const recipients = rawRecipients.map((value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpValidationError("recipient must be an object");
    const recipient = value as Record<string, unknown>;
    const amount = decimalBigint(recipient.amount);
    if (typeof recipient.to !== "string" || recipient.to.length === 0 || amount === undefined || amount <= 0n || amount >= U128_LIMIT) {
      throw new HttpValidationError("recipient requires to and a positive uint128 decimal-string amount");
    }
    return { to: recipient.to, amount,
      ...(recipient.noteSecret === undefined ? {} : { noteSecret: fieldValue(recipient.noteSecret, "recipient noteSecret") }) };
  });
  if ((job.kind === "payment") !== (recipients.length > 0)) throw new HttpValidationError("only payment jobs require recipients");
  return { kind: job.kind, ...(openFeeAmount === undefined ? {} : { openFeeAmount }), maxTransactions: job.maxTransactions, recipients,
    ...(shape === undefined ? {} : { shape }), ...(assetId === undefined ? {} : { assetId }),
    ...(targetNotes === undefined ? {} : { targetNotes }) };
}
