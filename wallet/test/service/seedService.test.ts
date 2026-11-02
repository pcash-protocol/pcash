import { readWalletConnection, resolveWalletConnection } from "../../src/connection.ts";
import { parseCli } from "../../src/cli/cli.ts";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { WIRE_PROOF_BYTES, networkConfigFromStatus, decodeTransaction, transactionIdentity } from "@pcash/sdk/protocol";
import { fieldToHex } from "@pcash/sdk/crypto";
import { addressHex, fromHex, toHex } from "@pcash/sdk/utils";
import { privateKeyPcashActionSigner } from "@pcash/sdk/eip712";
import { ChainSim } from "../chainFixture.ts";
import { deriveSeedWalletIdentity, generateWalletMnemonic } from "@pcash/sdk/wallet";
import { WalletHttpClient } from "../../src/cli/client.ts";
import { createServiceRelayJournals, parseServeArgs, startWalletServer } from "../../src/service/serve.ts";
import { Wallet, OPEN_WALLET_INTERNAL } from "@pcash/sdk/wallet";
import { inventoryPath, openKeystore } from "../../src/service/credentials.ts";
import { openNodeWalletDatabase } from "../../src/node/walletDatabase.ts";
import { WALLET_DATABASE_STATE_STORE } from "@pcash/sdk/wallet/database";
import { markPendingUserAccountCreationBroadcastRequested } from "@pcash/sdk/wallet/testing";

const fixture = vi.hoisted(() => ({ node: null as PcashNodeClient | null }));
const l1Senders = vi.hoisted(() => [] as string[]);
const recoveryConfigs = vi.hoisted(() => [] as { transportFor?: (rpcUrl: string) => unknown }[]);
/** Each constructed node client's fetch, and every method call by the index of the client that made it. */
const nodeClients = vi.hoisted(() => ({ fetches: [] as unknown[], calls: [] as { client: number; method: string }[] }));
vi.mock("@pcash/sdk/clients", async (original) => ({
  ...await original<typeof import("@pcash/sdk/clients")>(),
  PcashNodeClient: vi.fn(function (_url: string, options?: { fetchFn?: unknown }) {
    const client = nodeClients.fetches.push(options?.fetchFn) - 1;
    return new Proxy(fixture.node!, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          nodeClients.calls.push({ client, method: String(property) });
          return (value as (...args: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }),
}));

// The service test supplies proof bytes while exercising setup and transport.
vi.mock("@pcash/sdk/wallet/node", async (original) => ({
  ...await original<typeof import("@pcash/sdk/wallet/node")>(),
  createWalletProvers: () => ({ privateValue: { proveAndEncode: async (build: { encodeTransaction(proof: Uint8Array): Uint8Array }) => build.encodeTransaction(new Uint8Array(WIRE_PROOF_BYTES)) } }),
}));
vi.mock("@pcash/sdk/relay", async (original) => {
  const actual = await original<typeof import("@pcash/sdk/relay")>();
  return {
    ...actual,
    RelayJournalRecoveryManager: class extends actual.RelayJournalRecoveryManager {
      constructor(config: ConstructorParameters<typeof actual.RelayJournalRecoveryManager>[0]) {
        recoveryConfigs.push(config);
        super(config);
      }
    },
    prepareTransactionForL1: async (_entry: unknown, _status: unknown, submitter: { address: string }) => {
      l1Senders.push(submitter.address.toLowerCase());
      throw new Error("test stopped after selecting the L1 signer");
    },
  };
});

vi.mock("../../src/service/torTransport.ts", async (original) => {
  const actual = await original<typeof import("../../src/service/torTransport.ts")>();
  return { ...actual, torL1Transport: vi.fn(actual.torL1Transport) };
});

const MNEMONIC = `${"abandon ".repeat(23)}art`;
const TOKEN = "seed-service-test-token";
const PASSWORD = "local vault test password";
const services: Awaited<ReturnType<typeof startWalletServer>>[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  l1Senders.length = 0;
  recoveryConfigs.length = 0;
  nodeClients.fetches.length = 0;
  nodeClients.calls.length = 0;
});

function setup(directory: string, password = PASSWORD, l1Key?: string) {
  return parseServeArgs(["--listen", "127.0.0.1:0", "--data-dir", directory, "--scan-interval-ms", "60000"], {
    PCASH_WALLET_PASSWORD: password,
    PCASH_WALLET_TOKEN: TOKEN,
    ...(l1Key === undefined ? {} : { PCASH_WALLET_L1_KEY: l1Key }),
  });
}

async function start(directory: string, password = PASSWORD, l1Key?: string) {
  const service = await startWalletServer(setup(directory, password, l1Key), { error: () => undefined } as never);
  services.push(service);
  return { service, client: new WalletHttpClient(service.url, TOKEN) };
}

it("imports a seed over the local API, registers without a gas key, and reopens the encrypted vault", async () => {
  const directory = mkdtempSync(join(tmpdir(), "seed-service-"));
  const sim = new ChainSim(123456n);
  fixture.node = sim.client();
  const node = fixture.node;
  node.status = async () => ({ ...sim.status(), acceptedTransactionTypes: [0, 1, 2, 3] });
  node.getBlock = async (number) => ({ hash: fieldToHex(sim.block(BigInt(number)).hash), timestamp: sim.block(BigInt(number)).envelope.header.timestamp }) as never;
  const published: string[] = [];
  node.submitRawTransaction = async (hex) => {
    published.push(hex);
    const id = transactionIdentity(fromHex(hex));
    return { contentHash: id.contentHash, status: "ready" } as never;
  };
  const identity = deriveSeedWalletIdentity(MNEMONIC, networkConfigFromStatus(await node.status()));
  const address = addressHex(identity.profile.address);
  const first = await start(directory);
  const anonymous = new WalletHttpClient(first.service.url);
  await expect(anonymous.request("GET", "/wallets")).rejects.toMatchObject({ status: 401 });
  await expect(first.client.importMnemonic(MNEMONIC)).resolves.toMatchObject({ address });
  expect(await first.client.request("GET", "/wallets")).toEqual([{ address }]);
  await expect(first.client.request("POST", "/wallets/import", { keyFile: "/unread/private-key.json" }))
    .rejects.toMatchObject({ status: 400 });
  await expect(first.client.request("POST", "/receive-keys", { create: true }))
    .rejects.toMatchObject({ status: 400 });
  await expect(first.client.request("POST", "/receive-keys", { file: "/unread/receive-key.json" }))
    .rejects.toMatchObject({ status: 400 });
  await expect(first.client.request("GET", "/code")).rejects.toThrow("no registered receive key");
  await first.client.request("POST", "/account", { submit: "mempool", waitMode: "none" });
  expect(published).toHaveLength(1);
  const action = decodeTransaction(fromHex(published[0]!));
  expect(action.kind).toBe(0);
  if (action.kind !== 0 || action.accountCreation?.kind !== "user") throw new Error("expected attached setup");
  const creation = decodeTransaction(action.accountCreation.transactionBytes);
  expect(creation).toMatchObject({ kind: 1, authorization: { kind: "signed" } });
  if (creation.kind !== 1) throw new Error("expected user account creation");
  sim.addBlock({ accounts: [{
    address,
    nullifierKeyCommitment: BigInt(toHex(creation.nullifierKeyCommitment)),
    accountRuleSetCommitment: BigInt(toHex(creation.ruleSetCommitment)),
    receiveKey: creation.mlKemPublicKey,
  }] });
  const code = await first.client.request("GET", "/code");
  const disk = readFileSync(join(directory, "keystore.json"), "utf8");
  expect(disk).not.toContain(MNEMONIC);
  expect(disk).not.toContain(toHex(identity.privateKey).slice(2));
  expect(disk).not.toContain(toHex(identity.profile.mlKemSecretKey).slice(2));
  await first.service.close();
  await expect(startWalletServer(setup(directory, "wrong password"), { error: () => undefined } as never))
    .rejects.toThrow(/authentication failed/);
  const second = await start(directory);
  expect(await second.client.request("GET", "/wallets")).toEqual([{ address }]);
  expect(await second.client.request("GET", "/code")).toEqual(code);
}, 30_000);

it("allows configuring the seed account itself as the service's L1 gas key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "seed-service-gas-"));
  const sim = new ChainSim(123456n);
  fixture.node = sim.client();
  const identity = deriveSeedWalletIdentity(MNEMONIC, networkConfigFromStatus(await fixture.node.status()));
  const { client } = await start(directory, PASSWORD, toHex(identity.privateKey));
  const address = addressHex(identity.profile.address);
  await expect(client.importMnemonic(MNEMONIC)).resolves.toMatchObject({ address });
  expect(await client.request("GET", "/wallets")).toEqual([{ address }]);
});

it.each([false, true])("defaults registration to the selected wallet key with optional gas override=%s", async (override) => {
  const directory = mkdtempSync(join(tmpdir(), "seed-service-self-publication-"));
  const sim = new ChainSim(123456n);
  fixture.node = sim.client();
  fixture.node.status = async () => ({ ...sim.status(), acceptedTransactionTypes: [0, 1, 2, 3] });
  fixture.node.getBlock = async number => ({ hash: fieldToHex(sim.block(BigInt(number)).hash), timestamp: sim.block(BigInt(number)).envelope.header.timestamp }) as never;
  const gasKey = new Uint8Array(32).fill(0x31);
  const identity = deriveSeedWalletIdentity(MNEMONIC, networkConfigFromStatus(await fixture.node.status()));
  const address = addressHex(identity.profile.address);
  const expectedSender = override ? addressHex(privateKeyPcashActionSigner(gasKey).address) : address;
  const service = await startWalletServer({
    ...setup(directory, PASSWORD, override ? toHex(gasKey) : undefined), l1Rpc: "http://l1.invalid",
  }, { error: () => undefined } as never);
  services.push(service);
  const client = new WalletHttpClient(service.url, TOKEN);
  await expect(client.importMnemonic(MNEMONIC)).resolves.toMatchObject({
    address, ethereumFundingAddress: expectedSender, l1ChainId: sim.status().l1ChainId.toString(), pcashChainId: "123456",
  });
  await expect(client.request("POST", "/account", {})).rejects.toThrow("test stopped after selecting the L1 signer");
  expect(l1Senders).toEqual([expectedSender]);
  expect(recoveryConfigs).toHaveLength(1);
  expect(recoveryConfigs[0]).not.toHaveProperty("transportFor");
});

it("in Tor mode builds the node client on the Tor fetch and registers through the mempool by default", async () => {
  const directory = mkdtempSync(join(tmpdir(), "seed-service-tor-"));
  const sim = new ChainSim(123456n);
  fixture.node = sim.client();
  fixture.node.status = async () => ({ ...sim.status(), acceptedTransactionTypes: [0, 1, 2, 3] });
  fixture.node.getBlock = async number => ({ hash: fieldToHex(sim.block(BigInt(number)).hash), timestamp: sim.block(BigInt(number)).envelope.header.timestamp }) as never;
  const published: string[] = [];
  fixture.node.submitRawTransaction = async (hex) => {
    published.push(hex);
    return { contentHash: transactionIdentity(fromHex(hex)).contentHash, status: "ready" } as never;
  };
  const { PcashNodeClient } = await import("@pcash/sdk/clients");
  vi.mocked(PcashNodeClient).mockClear();
  const service = await startWalletServer(parseServeArgs([
    "--listen", "127.0.0.1:0", "--data-dir", directory, "--scan-interval-ms", "60000",
    "--network-privacy", "tor", "--rpc-url", "https://rpc.example.org",
  ], { PCASH_WALLET_PASSWORD: PASSWORD, PCASH_WALLET_TOKEN: TOKEN }), { error: () => undefined } as never);
  services.push(service);
  expect(vi.mocked(PcashNodeClient).mock.calls).toEqual([["https://rpc.example.org", { fetchFn: expect.any(Function) }]]);
  expect(nodeClients.fetches).toEqual([expect.any(Function)]);
  const client = new WalletHttpClient(service.url, TOKEN);
  const imported = await client.importMnemonic(MNEMONIC);
  expect(imported).toMatchObject({ networkPrivacy: "tor", pcashChainId: "123456" });
  expect(imported).not.toHaveProperty("ethereumFundingAddress");
  expect(imported).not.toHaveProperty("serviceGasAddress");
  await expect(client.request("POST", "/relay", { l1Rpc: "https://l1.example" })).rejects.toMatchObject({ status: 400 });
  expect(published).toEqual([]);
  await client.request("POST", "/account", { waitMode: "none" });
  expect(published).toHaveLength(1);
  expect(decodeTransaction(fromHex(published[0]!))).toMatchObject({ kind: 0, accountCreation: { kind: "user" } });
  expect(l1Senders).toEqual([]);
});

it("in Tor mode syncs each wallet and runs each request's actions on node clients of their own", async () => {
  const directory = mkdtempSync(join(tmpdir(), "seed-service-tor-isolation-"));
  const sim = new ChainSim(123456n);
  fixture.node = sim.client();
  fixture.node.status = async () => ({ ...sim.status(), acceptedTransactionTypes: [0, 1, 2, 3] });
  fixture.node.getBlock = async number => ({ hash: fieldToHex(sim.block(BigInt(number)).hash), timestamp: sim.block(BigInt(number)).envelope.header.timestamp }) as never;
  fixture.node.submitRawTransaction = async (hex) =>
    ({ contentHash: transactionIdentity(fromHex(hex)).contentHash, status: "ready" }) as never;
  const service = await startWalletServer(parseServeArgs([
    "--listen", "127.0.0.1:0", "--data-dir", directory, "--scan-interval-ms", "60000",
    "--network-privacy", "tor", "--rpc-url", "https://rpc.example.org",
  ], { PCASH_WALLET_PASSWORD: PASSWORD, PCASH_WALLET_TOKEN: TOKEN }), { error: () => undefined } as never);
  services.push(service);
  const client = new WalletHttpClient(service.url, TOKEN);
  const syncMethods = new Set(["getOutputs", "getAccountChanges", "getOutputFrontier"]);
  const syncClients = () => new Set(nodeClients.calls.filter(({ method }) => syncMethods.has(method)).map(({ client }) => client));
  const callsBy = (client: number) => nodeClients.calls.filter((call) => call.client === client).map(({ method }) => method);

  const first = await client.importMnemonic(MNEMONIC) as { address: string };
  const [firstSync] = [...syncClients()];
  expect(syncClients().size).toBe(1);
  const second = await client.importMnemonic(generateWalletMnemonic()) as { address: string };
  const secondSync = [...syncClients()].find((index) => index !== firstSync);
  expect(syncClients().size).toBe(2);

  const before = nodeClients.calls.length;
  await client.request("POST", "/account", { wallet: first.address, waitMode: "none" });
  // Registration's anchor check and admission share one client, which nothing else used.
  const admission = nodeClients.calls.find(({ method }) => method === "submitRawTransaction")!.client;
  expect(callsBy(admission).sort()).toEqual(["getBlock", "status", "status", "status", "submitRawTransaction"]);
  expect(nodeClients.calls.slice(0, before).some(({ client }) => client === admission)).toBe(false);
  // The wallet's own client only syncs; the other wallet's is not touched.
  const walletReads = new Set(["status", "getBlockHeader", ...syncMethods]);
  const registration = nodeClients.calls.slice(before);
  expect(registration.filter(({ client }) => client !== admission).every(({ client, method }) => client === firstSync && walletReads.has(method))).toBe(true);
  expect(registration.some(({ client }) => client === secondSync)).toBe(false);

  // A request that waits for acceptance looks its receipt up on its own action client too.
  fixture.node.getReceipt = async () => [{
    transactionId: "0x01", kind: "user_account_creation", outcome: "succeeded", inclusion: { l1BlockNumber: 1n },
  }] as never;
  const waited = nodeClients.calls.length;
  await client.request("POST", "/account", { wallet: second.address });
  const receiptClients = new Set(nodeClients.calls.slice(waited).filter(({ method }) => method === "getReceipt").map(({ client }) => client));
  expect(receiptClients.size).toBe(1);
  const [secondAction] = [...receiptClients];
  expect(secondAction).not.toBe(admission);
  expect(nodeClients.calls.filter(({ method }) => method === "submitRawTransaction").map(({ client }) => client)).toEqual([admission, secondAction]);
  expect(nodeClients.calls.slice(0, waited).some(({ client }) => client === secondAction)).toBe(false);
  expect([firstSync, secondSync]).not.toContain(secondAction);
  // Every client has a fetch of its own: the service's, one per wallet and one per request.
  expect(new Set(nodeClients.fetches).size).toBe(nodeClients.fetches.length);
  expect(nodeClients.fetches.every((fetch) => typeof fetch === "function")).toBe(true);
});

it("in Tor mode self-publishes registration through a Tor-reachable L1 endpoint only when asked", async () => {
  const directory = mkdtempSync(join(tmpdir(), "seed-service-tor-l1-"));
  const sim = new ChainSim(123456n);
  fixture.node = sim.client();
  fixture.node.status = async () => ({ ...sim.status(), acceptedTransactionTypes: [0, 1, 2, 3] });
  fixture.node.getBlock = async number => ({ hash: fieldToHex(sim.block(BigInt(number)).hash), timestamp: sim.block(BigInt(number)).envelope.header.timestamp }) as never;
  const address = addressHex(deriveSeedWalletIdentity(MNEMONIC, networkConfigFromStatus(await fixture.node.status())).profile.address);
  const service = await startWalletServer(parseServeArgs([
    "--listen", "127.0.0.1:0", "--data-dir", directory, "--scan-interval-ms", "60000",
    "--network-privacy", "tor", "--rpc-url", "https://rpc.example.org", "--l1-rpc", "https://l1.example.org",
  ], { PCASH_WALLET_PASSWORD: PASSWORD, PCASH_WALLET_TOKEN: TOKEN }), { error: () => undefined } as never);
  services.push(service);
  const client = new WalletHttpClient(service.url, TOKEN);
  await expect(client.importMnemonic(MNEMONIC)).resolves.toMatchObject({ address, networkPrivacy: "tor" });
  await expect(client.request("POST", "/account", { submit: "l1", l1Rpc: "http://l1.example.org" })).rejects.toThrow(/l1Rpc must be https/);
  expect(l1Senders).toEqual([]);
  const { torL1Transport } = await import("../../src/service/torTransport.ts");
  vi.mocked(torL1Transport).mockClear();
  await expect(client.request("POST", "/account", { submit: "l1" })).rejects.toThrow("test stopped after selecting the L1 signer");
  expect(l1Senders).toEqual([address]);
  expect(vi.mocked(torL1Transport).mock.calls).toEqual([[expect.any(Function), "https://l1.example.org"]]);
  // Journal recovery reads L1 through Tor too.
  expect(recoveryConfigs).toHaveLength(1);
  recoveryConfigs[0]!.transportFor!("https://l1.example.org");
  expect(vi.mocked(torL1Transport).mock.calls).toHaveLength(2);
  expect(() => recoveryConfigs[0]!.transportFor!("http://l1.example.org")).toThrow(/L1 RPC URL must be https/);
});

it("recovers an old sender's activation hash after restart without L1 configuration and releases it after resolution", async () => {
  const directory = mkdtempSync(join(tmpdir(), "seed-service-activation-recovery-"));
  const sim = new ChainSim(123456n);
  fixture.node = sim.client();
  const node = fixture.node;
  node.status = async () => ({ ...sim.status(), acceptedTransactionTypes: [0, 1, 2, 3] });
  node.getBlock = async number => ({ hash: fieldToHex(sim.block(BigInt(number)).hash), timestamp: sim.block(BigInt(number)).envelope.header.timestamp }) as never;
  const gasKey = new Uint8Array(32).fill(0x31);
  const oldSender = addressHex(privateKeyPcashActionSigner(gasKey).address);
  const identity = deriveSeedWalletIdentity(MNEMONIC, networkConfigFromStatus(await node.status()));
  const address = addressHex(identity.profile.address);
  const first = await startWalletServer({
    ...setup(directory, PASSWORD, toHex(gasKey)), l1Rpc: "http://l1.invalid",
  }, { error: () => undefined } as never);
  services.push(first);
  const firstClient = new WalletHttpClient(first.url, TOKEN);
  await firstClient.importMnemonic(MNEMONIC);
  await expect(firstClient.request("POST", "/account", {})).rejects.toThrow("test stopped after selecting the L1 signer");
  await first.close();

  // Reproduce a crash after durable broadcast journaling but before the wallet received its hash.
  const vault = await openKeystore(directory, PASSWORD);
  const database = await openNodeWalletDatabase(inventoryPath(directory), { cipher: vault.storageCipher });
  const hash = `0x${"76".repeat(32)}`;
  let contentHash: string;
  try {
    const store = database[WALLET_DATABASE_STATE_STORE]({
      address: identity.profile.address,
      network: { chainId: 123456n, genesisHash: sim.genesisHash },
    });
    const pending = await store.transaction(current => {
      markPendingUserAccountCreationBroadcastRequested(current!, address);
      return { data: current!, value: structuredClone(current!.pendingUserAccountCreations![0]!) };
    });
    contentHash = pending.contentHash;
    const journals = createServiceRelayJournals({ dataDir: directory, dev: false, node });
    await journals.forAddress(oldSender).journal.create({
      kind: "batch", createdAt: "2026-10-09T00:00:00Z", resolutionId: hash,
      phase: "broadcast_attempted", submissionKind: "signed_raw", transactionHash: hash,
      signedTransaction: "0x02", previousTransactionHashes: [], lastBroadcastBlock: pending.recentPcashBlockNumber,
      relayerAddress: oldSender, chainId: pending.l1ChainId,
      nonce: "0", gasLimit: "21000", maxFeePerGas: "2", maxPriorityFeePerGas: "1",
      genesisL1Block: pending.genesisL1Block, genesisL1BlockHash: pending.genesisL1BlockHash,
      carrier: "calldata", batch: "0x", selected: [contentHash], batchItemIndexes: ["0"],
      observationMode: "batch", collectibleOpenFee: "0", inboxAddress: pending.inboxAddress,
      maxFeePerBlobGas: null, headCheckedBlock: pending.recentPcashBlockNumber,
      headCheckedBlockHash: pending.recentPcashBlockHash,
    });
    sim.addBlock({ timestamp: BigInt(pending.validUntilTimestamp) + 1n });
  } finally { await database.close(); vault.close(); }

  const opens = vi.spyOn(Wallet, OPEN_WALLET_INTERNAL);
  try {
    const restarted = await start(directory);
    const runtime = await opens.mock.results.at(-1)!.value as Wallet;
    await expect(runtime.accountActivation()).resolves.toMatchObject({
      contentHash, state: "l1-submitted", l1TxHash: hash,
    });
    await restarted.client.request("POST", "/relay-journal/resolve", { transactionHash: hash });
    await expect(runtime.accountActivation()).resolves.toBeNull();
    const replacement = await runtime.prepareAccountActivation();
    expect(replacement.contentHash).not.toBe(contentHash);
    expect(replacement.state).toBe("prepared");
    expect(l1Senders).toEqual([oldSender]);
  } finally { opens.mockRestore(); }
}, 30_000);


it("starts with generated local authentication and reuses it after a restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "seed-service-discovery-"));
  fixture.node = new ChainSim(123456n).client();
  const options = parseServeArgs(["--listen", "127.0.0.1:0", "--data-dir", directory], { PCASH_WALLET_PASSWORD: PASSWORD });
  const first = await startWalletServer(options, { error: () => undefined } as never);
  services.push(first);
  const saved = readWalletConnection(directory)!;
  expect(saved.url).toBe(first.url);
  const connection = resolveWalletConnection(parseCli(["wallet", "list", "--data-dir", directory], {}));
  await expect(new WalletHttpClient(connection.url, connection.token).request("GET", "/wallets")).resolves.toEqual([]);
  await expect(new WalletHttpClient(first.url).request("GET", "/wallets")).rejects.toMatchObject({ status: 401 });
  await first.close();
  const second = await startWalletServer(options, { error: () => undefined } as never);
  services.push(second);
  expect(readWalletConnection(directory)).toEqual({ url: second.url, token: saved.token });
  await expect(new WalletHttpClient(second.url, saved.token).request("GET", "/wallets")).resolves.toEqual([]);
}, 30_000);

it("does not persist an explicitly configured token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "seed-service-explicit-token-"));
  fixture.node = new ChainSim(123456n).client();
  await start(directory);
  expect(existsSync(join(directory, "connection.json"))).toBe(false);
});
