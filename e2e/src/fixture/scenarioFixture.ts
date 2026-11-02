import { randomBytes } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "@pcash/sdk/bcfg";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  PcashNodeClient,
  PcashNodeRpcError,
  admitTransaction,
  createAdminClient,
  transactionIdentity,
  networkConfigFromStatus,
  type NetworkConfig,
  type StatusResult,
} from "../deps.ts";
import { ANVIL_HARNESS_KEY, AnvilBackend } from "../backends/anvil.ts";
import { LiveL1Backend } from "../backends/live.ts";
import { l1FeeCaps, l1Rpc, validPrivateKey } from "../backends/rpc.ts";
import type { L1Backend } from "../backends/types.ts";
import { loadE2eConfig, type E2eConfig } from "../config.ts";
import { e2eSettings } from "../settings.ts";
import { ScenarioActor } from "../actors/actor.ts";
import { PcashCliActor, type JsonObject, type P2pIdentityJson } from "../actors/nodeCli.ts";
import { ScenarioArtifacts } from "../framework/artifacts.ts";
import { buildRequiredBinaries, type BuiltBinaries } from "../framework/build.ts";
import { eventually } from "../framework/eventually.ts";
import { logger } from "../framework/logger.ts";
import { leasePorts, type PortLease } from "../framework/ports.ts";
import { ManagedProcess, ProcessRegistry } from "../framework/process.ts";
import { HarnessL1, type Poster } from "./harness.ts";
import {
  buildSourceBundle,
  sourceVerificationPublication,
  SOURCE_VERIFICATION_MANIFEST,
  type SourceVerificationDefinition,
} from "../../../scripts/source-verification/index.mts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/** `local` launches Anvil and nodes; `live` attaches to a network something else runs. */
export type NetworkMode = "local" | "live";

/** A generous budget for one proof-carrying carrier or router call. */
const L1_GAS_PER_TRANSACTION = 1_500_000n;

/** The fixed ports `just e2e-up` serves on, which are also live mode's defaults. */
export const STACK_PORTS = { l1: 8545, rpc: 8645, admin: 8647, pscan: 8648 } as const;

export interface NodeRuntime {
  name: "node-a" | "node-b";
  rpcUrl: string;
  pscanUrl?: string;
  adminUrl?: string;
  process?: ManagedProcess;
  cli: PcashCliActor;
  client: PcashNodeClient;
}

/** A node this fixture launched, and so can inspect on disk and restart. */
export interface LocalNode extends NodeRuntime {
  pscanUrl: string;
  adminUrl: string;
  process: ManagedProcess;
  rpcPort: number;
  adminPort: number;
  p2pPort: number;
  pscanPort: number;
  dataDir: string;
  flags: LocalNodeFlags;
}

interface LocalNodeFlags {
  disableCatalog?: boolean;
  startTimeoutMs?: number;
  bootnode?: string;
  enableSourceSubmissions: boolean;
  /** A stack node takes a live node's public Explorer and mempool policy. */
  stack: boolean;
}

export interface AcceptedScenarioSubmission {
  label: string;
  contentHash: string;
  nodeA: ReceiptJson;
  nodeB: ReceiptJson;
}

export interface InclusionJson {
  l1BlockNumber: string;
  l1BlockHash: string;
  l1TransactionIndex: string;
  batchItemIndex: string;
}

export interface ReceiptJson extends JsonObject {
  outcome: string;
  kind: string;
  transactionId: string;
  inclusion: InclusionJson;
  outputLeafStart?: string | null;
}

export interface FixtureOptions {
  disableCatalog?: boolean;
  name: string;
  mode?: NetworkMode;
  env?: NodeJS.ProcessEnv;
  sourceVerificationDefinition?: SourceVerificationDefinition;
  sourceVerificationManifest?: string;
  enableNodeASourceSubmissions?: boolean;
  /** Local only. */
  nodeCount?: 1 | 2;
  artifactsRoot?: string;
  keepArtifacts?: boolean;
  nodeStartTimeoutMs?: number;
  /** Local only: pin actors to funded Anvil accounts, as browser journeys do. */
  actorKeys?: Readonly<Record<string, `0x${string}`>>;
  durationMs?: number;
  /** Include the marketplace lane in traffic. */
  marketplace?: boolean;
  /** Local only: serve on the stack's fixed ports with a live node's mempool policy. */
  stack?: boolean;
}

export class ScenarioFixture {
  readonly repoRoot = REPO_ROOT;
  readonly name: string;
  readonly mode: NetworkMode;
  readonly settings: Config;
  readonly backend: L1Backend;
  readonly artifacts: ScenarioArtifacts;
  readonly processes: ProcessRegistry;
  readonly binaries: BuiltBinaries;
  readonly network: NetworkConfig;
  readonly initialStatus: StatusResult;
  readonly sourceVerificationManifest: string | undefined;
  readonly config: E2eConfig;
  readonly harness: HarnessL1;
  readonly nodeCount: 1 | 2;
  readonly durationMs: number | undefined;
  readonly marketplace: boolean;
  readonly actors: Record<string, ScenarioActor> = {};
  nodeA: NodeRuntime;
  nodeB: NodeRuntime;
  #portLease: PortLease | undefined;
  #actorKeys: Readonly<Record<string, `0x${string}`>>;
  #finished = false;
  #stopRequested = false;

  private constructor(params: {
    name: string;
    mode: NetworkMode;
    settings: Config;
    backend: L1Backend;
    artifacts: ScenarioArtifacts;
    processes: ProcessRegistry;
    binaries: BuiltBinaries;
    nodeA: NodeRuntime;
    nodeB: NodeRuntime;
    portLease?: PortLease;
    initialStatus: StatusResult;
    sourceVerificationManifest?: string;
    config: E2eConfig;
    harnessKey: `0x${string}`;
    actorKeys: Readonly<Record<string, `0x${string}`>>;
    durationMs?: number;
    marketplace: boolean;
  }) {
    this.name = params.name;
    this.mode = params.mode;
    this.settings = params.settings;
    this.backend = params.backend;
    this.artifacts = params.artifacts;
    this.processes = params.processes;
    this.binaries = params.binaries;
    this.nodeA = params.nodeA;
    this.nodeB = params.nodeB;
    this.#portLease = params.portLease;
    this.initialStatus = params.initialStatus;
    this.sourceVerificationManifest = params.sourceVerificationManifest;
    this.config = params.config;
    this.nodeCount = params.nodeA === params.nodeB ? 1 : 2;
    this.durationMs = params.durationMs;
    this.marketplace = params.marketplace;
    this.#actorKeys = params.actorKeys;
    this.network = networkConfigFromStatus(params.initialStatus);
    this.harness = new HarnessL1({
      privateKey: params.harnessKey,
      l1: params.backend,
      node: params.nodeA.client,
      relayNode: params.nodeB.client,
      journalDirectory: params.artifacts.path("harness-relay-journal"),
      ...(params.config.maxFeePerGas === undefined ? {} : { maxFeePerGas: params.config.maxFeePerGas }),
      waitForRelayCopy: (contentHash) => this.waitForPeerCopy(contentHash),
      record: (event, detail) => params.artifacts.record(event, detail),
    });
  }

  static async create(params: FixtureOptions): Promise<ScenarioFixture> {
    const settings = e2eSettings(params.env);
    const mode = params.mode ?? "local";
    const config = loadE2eConfig(settings);
    const artifacts = await ScenarioArtifacts.create(
      params.name,
      params.artifactsRoot,
      params.keepArtifacts === true || mode === "live",
    );
    const processes = new ProcessRegistry();
    let portLease: PortLease | undefined;
    try {
      const binaries = await buildRequiredBinaries(REPO_ROOT);
      let sourceVerificationManifest = params.sourceVerificationManifest;
      if (params.sourceVerificationDefinition !== undefined && sourceVerificationManifest === undefined) {
        const sourceRoot = artifacts.path("source-verification");
        buildSourceBundle(sourceRoot, params.sourceVerificationDefinition, REPO_ROOT, "PCASH E2E Operator");
        sourceVerificationManifest = join(sourceRoot, SOURCE_VERIFICATION_MANIFEST);
      }
      const common = {
        name: params.name,
        settings,
        artifacts,
        processes,
        binaries,
        config,
        marketplace: params.marketplace ?? mode === "local",
        ...(sourceVerificationManifest === undefined ? {} : { sourceVerificationManifest }),
        ...(params.durationMs === undefined ? {} : { durationMs: params.durationMs }),
      };
      const fixture = mode === "live"
        ? await ScenarioFixture.#attach(common)
        : await ScenarioFixture.#launch(common, params, (lease) => { portLease = lease; });
      artifacts.record("fixture-ready", {
        mode,
        nodeCount: fixture.nodeCount,
        rpc: fixture.nodeA.rpcUrl,
        l1ChainId: fixture.network.l1ChainId,
        pcashChainId: fixture.network.pcashChainId,
        harness: fixture.harness.address,
      });
      return fixture;
    } catch (error) {
      await processes.stopAll().catch(() => undefined);
      await portLease?.release().catch(() => undefined);
      const result = await artifacts.finish(error);
      logger.error(`E2E setup failed; artifacts preserved at ${result.path}`);
      throw error;
    }
  }

  static async #launch(
    common: FixtureCommon,
    params: FixtureOptions,
    leased: (lease: PortLease) => void,
  ): Promise<ScenarioFixture> {
    const { settings, artifacts, processes, binaries } = common;
    const nodeCount = params.nodeCount ?? 2;
    const configuredTimeout = settings.str("node-start-timeout-ms")?.trim();
    const nodeStartTimeoutMs = params.nodeStartTimeoutMs ?? (configuredTimeout ? Number(configuredTimeout) : undefined);
    if (nodeStartTimeoutMs !== undefined && (!Number.isSafeInteger(nodeStartTimeoutMs) || nodeStartTimeoutMs <= 0 || nodeStartTimeoutMs > 1_800_000)) {
      throw new Error("PCASH_E2E_NODE_START_TIMEOUT_MS must be an integer in 1..1800000");
    }
    const lease = await leasePorts(params.stack === true ? 1 : 9);
    leased(lease);
    // A stack serves on fixed ports and leases only its P2P listener.
    const [l1Port, nodeARpc, nodeAAdmin, nodeAP2p, nodeAPscan, nodeBRpc, nodeBAdmin, nodeBP2p, nodeBPscan] = params.stack === true
      ? [STACK_PORTS.l1, STACK_PORTS.rpc, STACK_PORTS.admin, lease.ports[0], STACK_PORTS.pscan]
      : lease.ports;
    if (l1Port === undefined || nodeARpc === undefined || nodeAAdmin === undefined || nodeAP2p === undefined || nodeAPscan === undefined) {
      throw new Error("port allocator returned an incomplete fixture lease");
    }
    const release = (ports: readonly number[]) =>
      Promise.all(ports.filter((port) => lease.ports.includes(port)).map((port) => lease.releasePort(port)));
    const backend = new AnvilBackend(settings);
    await release([l1Port]);
    await backend.start({ repoRoot: REPO_ROOT, artifactsRoot: artifacts.root, processes, port: l1Port });
    for (const key of Object.values(params.actorKeys ?? {})) {
      await l1Rpc(backend.rpcUrl, "anvil_setBalance", [privateKeyToAccount(key).address, "0x56bc75e2d63100000"]);
    }
    const anchor = await backend.anchor();
    const launch = { backend, anchor, binaries, artifacts, processes };
    const flags: LocalNodeFlags = {
      disableCatalog: params.disableCatalog === true,
      ...(nodeStartTimeoutMs === undefined ? {} : { startTimeoutMs: nodeStartTimeoutMs }),
      enableSourceSubmissions: params.stack === true || params.enableNodeASourceSubmissions === true,
      stack: params.stack === true,
    };
    await release([nodeARpc, nodeAAdmin, nodeAP2p, nodeAPscan]);
    const nodeA = await startNode({
      ...launch,
      name: "node-a",
      rpcPort: nodeARpc,
      adminPort: nodeAAdmin,
      p2pPort: nodeAP2p,
      pscanPort: nodeAPscan,
      dataDir: artifacts.path("node-a"),
      flags,
    });
    if (common.sourceVerificationManifest !== undefined) {
      await createAdminClient(nodeA.adminUrl).publishSourceVerification(
        sourceVerificationPublication(common.sourceVerificationManifest),
      );
    }
    let nodeB: LocalNode = nodeA;
    if (nodeCount === 2) {
      if (nodeBRpc === undefined || nodeBAdmin === undefined || nodeBP2p === undefined || nodeBPscan === undefined) {
        throw new Error("port allocator returned an incomplete fixture lease");
      }
      await release([nodeBRpc, nodeBAdmin, nodeBP2p, nodeBPscan]);
      nodeB = await startNode({
        ...launch,
        name: "node-b",
        rpcPort: nodeBRpc,
        adminPort: nodeBAdmin,
        p2pPort: nodeBP2p,
        pscanPort: nodeBPscan,
        dataDir: artifacts.path("node-b"),
        flags: {
          ...flags,
          bootnode: await waitForBootstrapAddress(nodeA),
          enableSourceSubmissions: true,
        },
      });
      await waitForPeers(nodeA, nodeB);
    }
    const initialStatus = nodeCount === 1 ? await nodeA.client.status() : await waitForSameHead(nodeA, nodeB);
    return new ScenarioFixture({
      ...common,
      mode: "local",
      backend,
      nodeA,
      nodeB,
      portLease: lease,
      initialStatus,
      harnessKey: ANVIL_HARNESS_KEY,
      actorKeys: params.actorKeys ?? {},
    });
  }

  static async #attach(common: FixtureCommon): Promise<ScenarioFixture> {
    const { settings, binaries } = common;
    const rpcUrl = url(settings.str("rpc-url"), `http://127.0.0.1:${STACK_PORTS.rpc}`, "PCASH_E2E_RPC_URL");
    const backend = await LiveL1Backend.connect(url(settings.str("l1-rpc"), `http://127.0.0.1:${STACK_PORTS.l1}`, "PCASH_E2E_L1_RPC"));
    // A local stack serves its admin and Explorer endpoints on the stack ports; a remote node exposes only what it names.
    const configuredPscan = settings.str("pscan-url");
    const pscanUrl = configuredPscan?.trim()
      ? url(configuredPscan, "", "PCASH_E2E_PSCAN_URL")
      : backend.anvil ? `http://127.0.0.1:${STACK_PORTS.pscan}` : undefined;
    const configuredAdmin = settings.str("admin-url");
    const adminUrl = configuredAdmin?.trim()
      ? url(configuredAdmin, "", "PCASH_E2E_ADMIN_URL")
      : backend.anvil ? `http://127.0.0.1:${STACK_PORTS.admin}` : undefined;
    const client = new PcashNodeClient(rpcUrl);
    const initialStatus = await client.status();
    if (initialStatus.l1ChainId !== backend.chainId) {
      throw new Error(`PCASH_E2E_L1_RPC is chain ${backend.chainId}, but the node at ${rpcUrl} follows chain ${initialStatus.l1ChainId}`);
    }
    const configuredKey = settings.str("l1-key")?.trim();
    if (!configuredKey && !backend.anvil) {
      throw new Error("PCASH_E2E_L1_KEY is required: a funded key on the node's L1 that pays every batch the run publishes");
    }
    const harnessKey = configuredKey ? validPrivateKey(configuredKey, "PCASH_E2E_L1_KEY") : ANVIL_HARNESS_KEY;
    const harnessAddress = privateKeyToAccount(harnessKey).address;
    const balance = BigInt(await l1Rpc<string>(backend.rpcUrl, "eth_getBalance", [harnessAddress, "latest"]));
    if (balance === 0n) throw new Error(`PCASH_E2E_L1_KEY account ${harnessAddress} holds no ETH on chain ${backend.chainId}`);
    const node: NodeRuntime = {
      name: "node-a",
      rpcUrl,
      ...(pscanUrl === undefined ? {} : { pscanUrl }),
      ...(adminUrl === undefined ? {} : { adminUrl }),
      cli: new PcashCliActor(binaries.nodeCli, rpcUrl, adminUrl, REPO_ROOT),
      client,
    };
    if (common.sourceVerificationManifest !== undefined && adminUrl !== undefined) {
      await createAdminClient(adminUrl).publishSourceVerification(
        sourceVerificationPublication(common.sourceVerificationManifest),
      );
    }
    common.artifacts.record("live-network", {
      rpc: rpcUrl,
      l1Rpc: new URL(backend.rpcUrl).origin,
      harness: harnessAddress,
      harnessBalanceWei: balance,
    });
    return new ScenarioFixture({
      ...common,
      mode: "live",
      backend,
      nodeA: node,
      nodeB: node,
      initialStatus,
      harnessKey,
      actorKeys: {},
    });
  }

  /** A node this fixture launched; scenarios that inspect or restart nodes run only locally. */
  local(name: "A" | "B"): LocalNode {
    const node = name === "A" ? this.nodeA : this.nodeB;
    if (!isLocalNode(node)) throw new Error(`scenario ${this.name} requires a local network`);
    return node;
  }

  /** Create actors with fresh keys and open their wallets at the current output boundary. */
  async createActors(names: readonly string[]): Promise<void> {
    await Promise.all([...new Set(names)].filter((name) => this.actors[name] === undefined).map(async (name) => {
      const actor = await ScenarioActor.create({
        name,
        privateKey: this.#actorKeys[name] ?? generatePrivateKey(),
        network: this.network,
        artifactsRoot: this.artifacts.root,
        node: this.nodeA.client,
        harness: this.harness,
      });
      await actor.client();
      this.actors[name] = actor;
    }));
    this.artifacts.record("actors-created", {
      actors: Object.fromEntries(Object.entries(this.actors).map(([name, actor]) => [name, actor.address])),
    });
  }

  /**
   * Fund an address to send `transactions` L1 transactions of its own, plus
   * `extraWei`. Only actors that must be their own Ethereum sender need this.
   */
  async fundL1Gas(address: string, transactions: number, extraWei = 0n): Promise<void> {
    const { maxFeePerGas } = await l1FeeCaps(this.backend.rpcUrl, this.config.maxFeePerGas);
    await this.harness.fundEth(address, BigInt(transactions) * L1_GAS_PER_TRANSACTION * maxFeePerGas + extraWei);
  }

  async waitForPeerCopy(contentHash: string): Promise<void> {
    if (this.nodeA === this.nodeB) return;
    await eventually(
      `node B to observe ${contentHash} from node A`,
      async () => ({
        mempool: await this.nodeB.cli.mempoolTransaction(contentHash),
        receipts: await this.nodeB.cli.receiptByContent<ReceiptJson[]>(contentHash),
      }),
      ({ mempool, receipts }) => mempool !== null || receipts.length > 0,
      { timeoutMs: 30_000, cancellation: () => firstCancellation(this.nodeA.process, this.nodeB.process) },
    );
  }

  /** Post one entry as its own batch naming `publisher`'s poster commitment, the wallet's `--submit l1`. */
  async publishOnL1(entry: Uint8Array, label: string, publisher: Poster): Promise<AcceptedScenarioSubmission> {
    await this.harness.publish(entry, publisher);
    return this.waitForAcceptedAcrossNodes(transactionIdentity(entry).contentHash, label);
  }

  /** Admit exact bytes to the public mempool, relay them, and wait for canonical acceptance. */
  async submitAndWait(entry: Uint8Array, label: string): Promise<AcceptedScenarioSubmission> {
    const admitted = await admitTransaction(this.nodeA.client, entry);
    await this.waitForPeerCopy(admitted.contentHash);
    return this.harness.relayUntil([admitted.contentHash], () => this.waitForAcceptedAcrossNodes(admitted.contentHash, label));
  }

  async waitForAcceptedAcrossNodes(contentHash: string, label: string): Promise<AcceptedScenarioSubmission> {
    const timeoutMs = this.backend.anvil ? 3 * 60_000 : 15 * 60_000;
    const [nodeA, nodeB]: [ReceiptJson, ReceiptJson] = this.nodeA === this.nodeB
      ? await waitForAcceptedReceipt(this.nodeA, contentHash, timeoutMs).then((receipt) => [receipt, receipt])
      : await Promise.all([
        waitForAcceptedReceipt(this.nodeA, contentHash, timeoutMs),
        waitForAcceptedReceipt(this.nodeB, contentHash, timeoutMs),
      ]);
    if (nodeA.kind !== nodeB.kind || JSON.stringify(nodeA.inclusion) !== JSON.stringify(nodeB.inclusion)) {
      throw new Error(`${label}: nodes returned different accepted receipts`);
    }
    this.artifacts.record("submission-accepted", { label, contentHash, kind: nodeA.kind, inclusion: nodeA.inclusion });
    return { label, contentHash, nodeA, nodeB };
  }

  async submitExpectingRejection(entry: Uint8Array, label: string): Promise<string> {
    let contentHash: string;
    try {
      contentHash = (await admitTransaction(this.nodeA.client, entry)).contentHash;
    } catch (error) {
      if (!(error instanceof PcashNodeRpcError)) throw error;
      const reason = `admission-rejected: ${error.message}`;
      this.artifacts.record("submission-rejected", { label, stage: "admission", reason });
      return reason;
    }
    await this.waitForPeerCopy(contentHash);
    const receipt = await this.harness.relayUntil([contentHash], () => eventually(
      `${label} to receive a derivation result`,
      () => this.nodeA.cli.receiptByContent<ReceiptJson[]>(contentHash),
      (receipts) => receipts.length > 0,
      {
        timeoutMs: this.backend.anvil ? 2 * 60_000 : 10 * 60_000,
        cancellation: () => this.nodeA.process?.cancellationReason() ?? null,
      },
    ));
    if (receipt.some((item) => item.outcome === "succeeded")) {
      throw new Error(`${label}: an action expected to fail received an accepted receipt`);
    }
    await this.nodeA.cli.assertNeverAccepted(contentHash, 2_000);
    const reason = "derivation-skipped";
    this.artifacts.record("submission-rejected", { label, contentHash, stage: "derivation", reason });
    return reason;
  }

  async waitForNodesAtL1Head(target?: bigint): Promise<void> {
    target ??= await this.backend.blockNumber();
    await Promise.all([waitForL1(this.nodeA, target), waitForL1(this.nodeB, target)]);
  }

  async restartNode(name: "A" | "B"): Promise<void> {
    const current = this.local(name);
    if (!(this.backend instanceof AnvilBackend)) throw new Error("only a local network restarts nodes");
    await this.processes.stop(current.process);
    const replacement = await startNode({
      name: current.name,
      rpcPort: current.rpcPort,
      adminPort: current.adminPort,
      p2pPort: current.p2pPort,
      pscanPort: current.pscanPort,
      dataDir: current.dataDir,
      flags: current.flags,
      backend: this.backend,
      anchor: await this.backend.anchor(),
      binaries: this.binaries,
      artifacts: this.artifacts,
      processes: this.processes,
      logSuffix: "restart",
    });
    if (this.nodeA === this.nodeB) {
      this.nodeA = replacement;
      this.nodeB = replacement;
    } else if (name === "A") this.nodeA = replacement;
    else this.nodeB = replacement;
    this.artifacts.record("node-restarted", { node: name, dataDir: current.dataDir });
  }

  /** Ask a long-running scenario to finish its current round and stop. */
  requestStop(): void {
    this.#stopRequested = true;
  }

  get stopRequested(): boolean {
    return this.#stopRequested;
  }

  randomField(): bigint {
    let value = 0n;
    while (value === 0n) value = BigInt(`0x${randomBytes(31).toString("hex")}`);
    return value;
  }

  /**
   * Stop every process at once, abandoning in-flight work, even while
   * `finish` is still waiting on it. The harness journal keeps any unsettled
   * L1 transaction in the preserved artifacts.
   */
  async abort(): Promise<void> {
    await this.processes.stopAll().catch(() => undefined);
    if (this.#finished) return;
    this.#finished = true;
    if (this.#portLease !== undefined) await this.#portLease.release().catch(() => undefined);
    const result = await this.artifacts.finish(new Error("interrupted"));
    if (result.preserved) logger.info(`E2E artifacts preserved at ${result.path}`);
  }

  async finish(failure?: unknown): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    let teardownError: unknown;
    const attempt = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        teardownError ??= error;
      }
    };
    await attempt(() => this.harness.stopAutoRelay());
    await attempt(() => this.harness.idle());
    for (const actor of Object.values(this.actors)) await attempt(() => actor.close());
    if (failure !== undefined) {
      const tails: Record<string, string> = {};
      for (const processHandle of [this.nodeB.process, this.nodeA.process, this.backend.process]) {
        if (processHandle !== undefined) tails[processHandle.name] = await processHandle.tail();
      }
      this.artifacts.record("process-log-tails", tails);
    }
    await attempt(() => this.processes.stopAll());
    if (this.#portLease !== undefined) await attempt(() => this.#portLease!.release());
    const result = await this.artifacts.finish(failure ?? teardownError);
    if (result.preserved) logger.info(`E2E artifacts preserved at ${result.path}`);
    if (failure === undefined && teardownError !== undefined) throw teardownError;
  }
}

interface FixtureCommon {
  name: string;
  settings: Config;
  artifacts: ScenarioArtifacts;
  processes: ProcessRegistry;
  binaries: BuiltBinaries;
  config: E2eConfig;
  marketplace: boolean;
  sourceVerificationManifest?: string;
  durationMs?: number;
}

function isLocalNode(node: NodeRuntime): node is LocalNode {
  return "dataDir" in node;
}

function url(value: string | null, fallback: string, name: string): string {
  const configured = value?.trim() || fallback;
  const parsed = new URL(configured);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${name} must be an HTTP URL`);
  return parsed.toString().replace(/\/$/, "");
}

async function startNode(params: {
  name: "node-a" | "node-b";
  rpcPort: number;
  adminPort: number;
  p2pPort: number;
  pscanPort: number;
  dataDir: string;
  flags: LocalNodeFlags;
  backend: AnvilBackend;
  anchor: { number: bigint; hash: string };
  binaries: BuiltBinaries;
  artifacts: ScenarioArtifacts;
  processes: ProcessRegistry;
  logSuffix?: string;
}): Promise<LocalNode> {
  const rpcUrl = `http://127.0.0.1:${params.rpcPort}`;
  const adminUrl = `http://127.0.0.1:${params.adminPort}`;
  const p2pAddress = `/ip4/127.0.0.1/tcp/${params.p2pPort}`;
  const identityPath = join(params.dataDir, "p2p_identity.pb");
  await mkdir(params.dataDir, { recursive: true, mode: 0o700 });
  const localCli = new PcashCliActor(params.binaries.nodeCli, rpcUrl, adminUrl, REPO_ROOT);
  const identity: P2pIdentityJson = await fileExists(identityPath)
    ? await localCli.p2pKeyInspect(identityPath, p2pAddress)
    : await localCli.p2pKeyGenerate(identityPath, p2pAddress);
  const pcashChainId = Number(BigInt(params.anchor.hash) >> 224n) || 1;
  const nodeEnv = { ...process.env };
  delete nodeEnv.PCASH_NETWORK;
  const processHandle = await params.processes.start({
    name: params.name,
    command: params.binaries.node,
    args: [
      "--l1-rpc", params.backend.rpcUrl,
      "--beacon-api", params.backend.beaconApiUrl,
      "--l1-chain-id", params.backend.chainId.toString(),
      "--data-dir", params.dataDir,
      "--rpc-addr", `127.0.0.1:${params.rpcPort}`,
      "--admin-addr", `127.0.0.1:${params.adminPort}`,
      "--pscan-addr", `127.0.0.1:${params.pscanPort}`,
      ...(params.flags.enableSourceSubmissions ? ["--enable-source-submissions"] : []),
      ...(params.flags.stack ? ["--enable-configuration-opening-submissions"] : []),
      "--p2p-listen", p2pAddress,
      // Nothing confirms a loopback listener as reachable, so the node reports a bootstrap address only when given one.
      "--p2p-advertise-addr", p2pAddress,
      "--p2p-allow-private-addresses",
      ...(params.flags.bootnode === undefined ? [] : ["--p2p-bootnode", params.flags.bootnode]),
      "--pcash-chain-id", pcashChainId.toString(),
      "--genesis-l1-block", params.anchor.number.toString(),
      "--genesis-l1-block-hash", params.anchor.hash,
      "--source-verification-reproducer", params.binaries.sourceVerificationReproducer,
      "--poll-secs", "1",
      "--p2p-anti-entropy-secs", "1",
      ...(params.flags.disableCatalog ? [] : ["--enable-catalog"]),
      "--pboard",
      // Local scenarios admit proof-free registrations to relay them; a live node does not.
      ...(params.flags.stack ? [] : ["--mempool-accept-unpaid-registration"]),
    ],
    cwd: REPO_ROOT,
    env: {
      ...nodeEnv,
      PCASH_TOOL_ROOT: params.binaries.toolRoot,
      RUST_LOG: `${process.env.RUST_LOG?.trim() || "info"},pcash_node::resume=info`,
    },
    logPath: params.artifacts.path(
      "logs",
      `${params.name}${params.logSuffix === undefined ? "" : `-${params.logSuffix}`}.log`,
    ),
  });
  const cli = new PcashCliActor(params.binaries.nodeCli, rpcUrl, adminUrl, REPO_ROOT, processHandle);
  const runtime: LocalNode = {
    name: params.name,
    rpcUrl,
    rpcPort: params.rpcPort,
    adminPort: params.adminPort,
    p2pPort: params.p2pPort,
    pscanPort: params.pscanPort,
    pscanUrl: `http://127.0.0.1:${params.pscanPort}`,
    adminUrl,
    dataDir: params.dataDir,
    flags: params.flags,
    process: processHandle,
    cli,
    client: new PcashNodeClient(rpcUrl),
  };
  await eventually(
    `${params.name} public status readiness`,
    () => cli.status<{ latestBlock: string }>(),
    (status) => typeof status.latestBlock === "string",
    { timeoutMs: params.flags.startTimeoutMs ?? 60_000, cancellation: () => processHandle.cancellationReason() },
  );
  await waitForL1(runtime, await params.backend.blockNumber());
  await eventually(
    `${params.name} to use its provisioned P2P identity`,
    () => cli.nodeInfo<{ peerId: string; bootstrapAddresses: string[] }>(),
    (info) => info.peerId === identity.peerId
      && info.bootstrapAddresses.includes(identity.bootstrapAddress ?? ""),
    { timeoutMs: 60_000, cancellation: () => processHandle.cancellationReason() },
  );
  return runtime;
}

async function waitForBootstrapAddress(node: LocalNode): Promise<string> {
  const info = await eventually(
    `${node.name} P2P bootstrap address`,
    () => node.cli.nodeInfo<{ bootstrapAddresses: string[] }>(),
    (value) => value.bootstrapAddresses.some((address) => address.includes(`/tcp/${node.p2pPort}/p2p/`)),
    { timeoutMs: 60_000, cancellation: () => node.process.cancellationReason() },
  );
  const address = info.bootstrapAddresses.find((candidate) => candidate.includes(`/tcp/${node.p2pPort}/p2p/`));
  if (address === undefined) throw new Error("unreachable missing P2P bootstrap address");
  return address;
}

async function waitForPeers(a: LocalNode, b: LocalNode): Promise<void> {
  await eventually(
    "two-node P2P connection",
    async () => Promise.all([
      a.cli.mempool<{ peerCount: string }>(),
      b.cli.mempool<{ peerCount: string }>(),
    ]),
    ([left, right]) => BigInt(left.peerCount) > 0n && BigInt(right.peerCount) > 0n,
    { timeoutMs: 60_000, cancellation: () => firstCancellation(a.process, b.process) },
  );
}

async function waitForSameHead(a: LocalNode, b: LocalNode): Promise<StatusResult> {
  const pair = await eventually(
    "two nodes to expose one canonical head",
    () => Promise.all([a.client.status(), b.client.status()]),
    ([left, right]) => left.genesisHash === right.genesisHash && left.latestBlockHash === right.latestBlockHash,
    { timeoutMs: 120_000, cancellation: () => firstCancellation(a.process, b.process) },
  );
  return pair[0];
}

async function waitForL1(node: NodeRuntime, target: bigint): Promise<void> {
  await eventually(
    `${node.name} to derive through L1 block ${target}`,
    () => node.cli.status<{ latestL1BlockNumber: string }>(),
    (status) => BigInt(status.latestL1BlockNumber) >= target,
    { timeoutMs: 10 * 60_000, intervalMs: 500, cancellation: () => node.process?.cancellationReason() ?? null },
  );
}

async function waitForAcceptedReceipt(node: NodeRuntime, contentHash: string, timeoutMs: number): Promise<ReceiptJson> {
  const receipts = await eventually(
    `${node.name} accepted receipt for ${contentHash}`,
    () => node.cli.receiptByContent<ReceiptJson[]>(contentHash),
    (items) => items.some((item) => item.outcome === "succeeded"),
    { timeoutMs, intervalMs: 500, cancellation: () => node.process?.cancellationReason() ?? null },
  );
  return receipts.find((item) => item.outcome === "succeeded")!;
}

function firstCancellation(...processes: Array<ManagedProcess | undefined>): string | null {
  return processes.map((item) => item?.cancellationReason() ?? null).find((reason) => reason !== null) ?? null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
