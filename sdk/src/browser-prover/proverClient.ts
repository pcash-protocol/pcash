import type { WitnessMap } from "../protocol/witness.ts";
import { eventStatementFromKernel, noOpEventWitness } from "../protocol/events.ts";
// Browser Prover: spawns the module worker (proverWorker.ts) and exposes the
// typed `Prover` promise API with a streamed onStatus callback. Each action is
// one worker round trip containing its complete ordered CHONK stack. The
// one-shot factory spawns one worker per action; wallet and benchmark sessions
// retain it across one fixed SRS/thread profile.

import {
  type ChonkCircuitKind,
  type ChonkVkArtifacts,
  chonkVkArtifacts,
  vkFieldsFromBytes,
} from "../protocol/account.ts";
import {
  assertBrowserCircuit,
  fetchPinnedArtifact,
  proverCircuitId,
  type BrowserProverAssetSource,
} from "./artifacts.ts";
import { PROVER_ARTIFACT_SHA256 } from "../constants/proverArtifacts.ts";
import { serialQueue } from "../utils/serial.ts";
import { CIRCUIT_SRS_POINTS } from "../constants/circuitRuntimes.ts";
import { PRIVATE_VALUE_PROFILES, privateValueProfile, type PrivateValueShape } from "../constants/privateValueProfiles.ts";
import { privateValuePublicInputNames } from "../protocol/witness.ts";
import { numberToHex } from "viem";
import {
  CIRCUIT_URLS,
  type AssetActionProofRequest,
  type AssetProver,
  type ChonkProver,
  type Prover,
  type ProveStatus,
  type ProofResult,
} from "./requests.ts";
import {
  normalizeProverThreads,
  type ProverProfile,
  type SupportedSrsPoints,
} from "../prover/profile.ts";
import type {
  WorkerOperationRequest,
  WorkerRequest,
  WorkerResponse,
} from "./proverWorker.ts";

const toHexList = (xs: readonly bigint[]): string[] => xs.map((x) => numberToHex(x));

/** A release-pinned CHONK VK, parsed for the kind its stack position folds it as. */
type LoadedChonkVk = ChonkVkArtifacts & { url: string; kind: ChonkCircuitKind };

const chonkVkCache = new Map<string, Promise<LoadedChonkVk>>();

function chonkVkUrl(circuitUrl: string): string {
  return `/chonk-vks/${proverCircuitId(circuitUrl)}.vk`;
}

function loadChonkVk(
  circuitUrl: string,
  kind: ChonkCircuitKind,
  vkUrl: string,
  digests: Readonly<Record<string, string>>,
  assetSource: BrowserProverAssetSource,
  allowNativeOnly: boolean,
): Promise<LoadedChonkVk> {
  assertBrowserCircuit(circuitUrl, allowNativeOnly);
  const expectedDigest = digests[vkUrl];
  if (expectedDigest === undefined) {
    throw new Error(`prover artifact ${vkUrl} is not pinned by this release`);
  }
  const cacheKey = `${vkUrl}\0${kind}\0${expectedDigest}`;
  let pending = chonkVkCache.get(cacheKey);
  if (pending === undefined) {
    pending = (async () => {
      const bytes = await fetchPinnedArtifact(vkUrl, digests, assetSource, allowNativeOnly);
      const vk = chonkVkArtifacts(vkFieldsFromBytes(bytes, kind, `CHONK VK ${vkUrl}`), kind);
      return {
        ...vk,
        url: vkUrl,
        kind,
      };
    })();
    chonkVkCache.set(cacheKey, pending);
    void pending.catch(() => {
      if (chonkVkCache.get(cacheKey) === pending) chonkVkCache.delete(cacheKey);
    });
  }
  return pending;
}

export const TYPE0_PUBLIC_INPUT_NAMES: readonly string[] = privateValuePublicInputNames(PRIVATE_VALUE_PROFILES.S);

export const ACCOUNT_UPDATE_PUBLIC_INPUT_NAMES = [
  ...TYPE0_PUBLIC_INPUT_NAMES,
  "account_update_commitment",
] as const;


/** A browser proving operation was canceled before it produced a usable proof. */
export class ProverAbortError extends Error {
  override readonly name = "AbortError";

  constructor(message = "proving canceled") {
    super(message);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProverAbortError();
}

/** Callers serialize requests because each call replaces the worker's message handlers. */
class WorkerSession {
  private readonly worker: Worker;
  private terminated = false;
  readonly profile: ProverProfile;
  /** Pinned sha256 per URL sent with every worker request. */
  readonly artifactDigests: Readonly<Record<string, string>>;
  readonly circuitProfiles: BrowserCircuitProfiles;
  readonly assetSource: BrowserProverAssetSource;
  constructor(
    profile: ProverProfile,
    artifactDigests: Readonly<Record<string, string>>,
    circuitProfiles: BrowserCircuitProfiles,
    assetSource: BrowserProverAssetSource,
  ) {
    this.profile = profile;
    this.artifactDigests = artifactDigests;
    this.circuitProfiles = circuitProfiles;
    this.assetSource = assetSource;
    this.worker = new Worker(new URL("./proverWorker.js", import.meta.url), { type: "module" });
  }

  get closed(): boolean {
    return this.terminated;
  }

  loadChonkVk(circuitUrl: string, kind: ChonkCircuitKind): Promise<LoadedChonkVk> {
    const vkUrl = this.circuitProfiles[circuitUrl]?.vkUrl ?? chonkVkUrl(circuitUrl);
    return loadChonkVk(
      circuitUrl,
      kind,
      vkUrl,
      this.artifactDigests,
      this.assetSource,
      this.profile.allowNativeOnlyCircuits === true,
    );
  }

  /** Send one request; resolve when a message of `resultType` arrives. */
  request<T extends WorkerResponse["type"]>(
    req: WorkerOperationRequest,
    resultType: T,
    onStatus?: (s: ProveStatus) => void,
    signal?: AbortSignal,
  ): Promise<Extract<WorkerResponse, { type: T }>> {
    if (signal?.aborted) {
      return Promise.reject(new ProverAbortError());
    }
    if (this.terminated) return Promise.reject(new Error("prover worker session is closed"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        signal?.removeEventListener("abort", abort);
        this.worker.onmessage = null;
        this.worker.onerror = null;
        this.worker.onmessageerror = null;
      };
      const finish = <R>(complete: (value: R) => void, value: R): void => {
        if (settled) return;
        settled = true;
        cleanup();
        complete(value);
      };
      const fail = (cause: Error): void => finish(reject, cause);
      // A crashed or confused worker cannot serve another request.
      const crash = (cause: Error): void => {
        if (settled) return;
        this.terminate();
        fail(cause);
      };
      const abort = (): void => crash(new ProverAbortError());
      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        if (settled) return;
        const msg = event.data;
        if (msg.type === "status") {
          const { type: _type, ...status } = msg;
          onStatus?.(status);
          return;
        }
        if (msg.type === "error") {
          fail(new Error(msg.error));
          return;
        }
        if (msg.type === resultType) {
          finish(resolve, msg as Extract<WorkerResponse, { type: T }>);
          return;
        }
        crash(new Error(`prover worker sent ${String(msg.type)} while ${resultType} was pending`));
      };
      this.worker.onerror = (event) => {
        const location = event.filename
          ? ` at ${event.filename}:${event.lineno}:${event.colno}`
          : "";
        crash(new Error(`${event.message || "prover worker crashed"}${location}`));
      };
      this.worker.onmessageerror = () => crash(new Error("prover worker response could not be decoded"));
      signal?.addEventListener("abort", abort, { once: true });
      const profiledRequest: WorkerRequest = {
        ...req,
        profile: this.profile,
        artifactDigests: this.artifactDigests,
        assetSource: this.assetSource,
      };
      try {
        this.worker.postMessage(profiledRequest);
      } catch (cause) {
        fail(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.worker.terminate();
  }
}

// Main-thread witness assembly is outside the worker's timings; measure it
// separately rather than attributing it to proof generation.
function measureAssembly<T>(
  circuit: string,
  requestStartedAt: number,
  onStatus: ((s: ProveStatus) => void) | undefined,
  build: () => T,
): T {
  const started = performance.now();
  try {
    return build();
  } finally {
    const now = performance.now();
    onStatus?.({
      phase: "proving",
      message: `assemble ${circuit}`,
      // Since the request began, as the interface specifies. The measurement
      // itself is durationMs; conflating the two makes the log read as if every
      // assembly happened at the start of the run.
      elapsedMs: Math.round(now - requestStartedAt),
      step: "assemble",
      circuit,
      durationMs: Math.round(now - started),
    });
  }
}

type CircuitName = keyof typeof CIRCUIT_URLS;
type KernelProof = Prover["proveTransfer"];
type KernelProofRequest = Parameters<KernelProof>[0];
type KernelMethod = "proveTransfer" | "proveUserAccountUpdate";
type ChonkStep = Extract<WorkerOperationRequest, { kind: "chonk" }>["steps"][number];

/** A transaction family's hiding kernel, which closes its protocol kernel into one CHONK proof. */
interface ProofFamily {
  hidingKernel: { circuit: CircuitName; label: string };
  publicInputNames: readonly string[];
}

/** The event application of a kernel that consumes one rule. */
const NO_OP_EVENT_APPLICATION = { circuit: "no_op_event_application", label: "no-op event application" } as const satisfies {
  circuit: CircuitName;
  label: string;
};

/** One authorization application, the no-op event application, and a protocol kernel folded ahead of its family's hiding kernel. */
interface KernelPipeline extends ProofFamily {
  /** Used when the request names no installed authorization circuit or label. */
  authorization: { circuit: CircuitName; label: string };
  kernel: { circuit: CircuitName; label: string };
}

/** Each private-value shape's protocol circuits. */
const PRIVATE_VALUE_CIRCUITS: Record<PrivateValueShape, {
  /** The readable rule a transfer folds when the request names none. */
  transferAuthorization: CircuitName;
  transferKernel: CircuitName;
  sponsoredTransferKernel: CircuitName;
  assetCreationKernel: CircuitName;
  hidingKernel: CircuitName;
}> = {
  [PRIVATE_VALUE_PROFILES.S.shapeId]: {
    transferAuthorization: "account_rule_payment_ecdsa",
    transferKernel: "private_value_transfer_kernel",
    sponsoredTransferKernel: "private_value_sponsored_transfer_kernel",
    assetCreationKernel: "private_value_asset_creation_kernel",
    hidingKernel: "private_value_hiding_kernel",
  },
  [PRIVATE_VALUE_PROFILES.L.shapeId]: {
    transferAuthorization: "account_rule_large_batch_transfer_ecdsa",
    transferKernel: "private_value_large_transfer_kernel",
    sponsoredTransferKernel: "private_value_large_sponsored_transfer_kernel",
    assetCreationKernel: "private_value_large_asset_creation_kernel",
    hidingKernel: "private_value_large_hiding_kernel",
  },
};

function privateValueFamily(shape: PrivateValueShape): ProofFamily {
  const circuits = PRIVATE_VALUE_CIRCUITS[shape];
  return {
    hidingKernel: { circuit: circuits.hidingKernel, label: "hiding kernel" },
    publicInputNames: privateValuePublicInputNames(privateValueProfile(shape)),
  };
}

const KERNEL_PIPELINES: Record<Exclude<KernelMethod, "proveTransfer">, KernelPipeline> = {
  proveUserAccountUpdate: {
    authorization: { circuit: "account_rule_admin_ecdsa", label: "installed administration rule" },
    kernel: { circuit: "user_account_update_kernel", label: "user account update kernel" },
    hidingKernel: { circuit: "user_account_update_hiding_kernel", label: "user account update hiding kernel" },
    publicInputNames: ACCOUNT_UPDATE_PUBLIC_INPUT_NAMES,
  },

};

function kernelPipeline(method: KernelMethod, request: KernelProofRequest): KernelPipeline {
  if (method !== "proveTransfer") return KERNEL_PIPELINES[method];
  const shape = request.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId;
  return {
    ...privateValueFamily(shape),
    authorization: { circuit: PRIVATE_VALUE_CIRCUITS[shape].transferAuthorization, label: "installed authorization rule" },
    kernel: { circuit: PRIVATE_VALUE_CIRCUITS[shape].transferKernel, label: "transfer kernel" },
  };
}

/** The circuits a kernel pipeline folds, in proving order. */
function pipelineCircuitUrls(
  pipeline: KernelPipeline,
  request: KernelProofRequest,
): [authorization: string, application: string, kernel: string, hidingKernel: string] {
  return [
    request.authorizationCircuitUrl ?? CIRCUIT_URLS[pipeline.authorization.circuit],
    request.eventApplication?.circuitUrl ?? CIRCUIT_URLS[NO_OP_EVENT_APPLICATION.circuit],
    CIRCUIT_URLS[pipeline.kernel.circuit],
    CIRCUIT_URLS[pipeline.hidingKernel.circuit],
  ];
}

const vkWitness = (vk: ChonkVkArtifacts): { key: readonly string[]; hash: string } => ({ key: vk.vkFields, hash: vk.vkHash });

/** The no-op event-application step and the witness its kernel verifies. */
function noOpEventApplicationStep(vk: LoadedChonkVk, statement: readonly bigint[]): ChonkStep {
  return { circuitUrl: CIRCUIT_URLS[NO_OP_EVENT_APPLICATION.circuit], vkUrl: vk.url, kind: vk.kind, witnessMap: noOpEventWitness(statement), label: NO_OP_EVENT_APPLICATION.label };
}

/** The hiding-kernel step that closes a family's protocol kernel over `statement`. */
function hidingStep(
  family: ProofFamily,
  statement: string[],
  kernelVk: ChonkVkArtifacts,
  hidingKernelVk: LoadedChonkVk,
): ChonkStep {
  const publicWitness = Object.fromEntries(family.publicInputNames.map((name, index) => [name, statement[index]!]));
  return {
    circuitUrl: CIRCUIT_URLS[family.hidingKernel.circuit],
    vkUrl: hidingKernelVk.url,
    kind: hidingKernelVk.kind,
    witnessMap: { ...publicWitness, transaction_statement: statement, kernel_vk: vkWitness(kernelVk) },
    label: family.hidingKernel.label,
  };
}

async function proveKernelPipeline(
  session: WorkerSession,
  pipeline: KernelPipeline,
  request: KernelProofRequest,
  onStatus?: (s: ProveStatus) => void,
  signal?: AbortSignal,
): Promise<ProofResult> {
  throwIfAborted(signal);
  const requestStartedAt = performance.now();
  const { authorizationWitnessMap, eventApplication, buildKernelWitnessMap, expectedPublicInputs,
    authorizationLabel = pipeline.authorization.label } = request;
  const [authorizationUrl, applicationUrl, kernelUrl, hidingKernelUrl] = pipelineCircuitUrls(pipeline, request);
  const [authorizationVk, eventApplicationVk, kernelVk, hidingKernelVk] = await Promise.all([
    session.loadChonkVk(authorizationUrl, "app"),
    session.loadChonkVk(applicationUrl, "app"),
    session.loadChonkVk(kernelUrl, "kernel"),
    session.loadChonkVk(hidingKernelUrl, "hiding"),
  ]);
  throwIfAborted(signal);
  const statement = toHexList(expectedPublicInputs);
  const baseWitness = buildKernelWitnessMap(authorizationVk);
  const eventStatement = eventStatementFromKernel(baseWitness, eventApplication?.event);
  const kernelWitnessMap = measureAssembly(
    pipeline.kernel.circuit,
    requestStartedAt,
    onStatus,
    () => ({ ...baseWitness, event_application_vk: vkWitness(eventApplicationVk), event_statement: toHexList(eventStatement) }),
  );
  const result = await session.request(
    {
      kind: "chonk",
      steps: [
        {
          circuitUrl: authorizationUrl,
          vkUrl: authorizationVk.url,
          kind: authorizationVk.kind,
          witnessMap: authorizationWitnessMap,
          label: authorizationLabel,
        },
        eventApplication === undefined ? noOpEventApplicationStep(eventApplicationVk, eventStatement)
          : { ...eventApplication, vkUrl: eventApplicationVk.url, kind: eventApplicationVk.kind },
        { circuitUrl: kernelUrl, vkUrl: kernelVk.url, kind: kernelVk.kind, witnessMap: kernelWitnessMap, label: pipeline.kernel.label },
        hidingStep(pipeline, statement, kernelVk, hidingKernelVk),
      ],
      expectedPublicInputs: statement,
    },
    "chonk-result",
    onStatus,
    signal,
  );
  return { proof: result.proof };
}

async function proveAssetAction(
  session: WorkerSession,
  args: AssetActionProofRequest,
  onStatus?: (s: ProveStatus) => void,
  signal?: AbortSignal,
): Promise<ProofResult> {
  throwIfAborted(signal);
  const requestStartedAt = performance.now();
  const shape = args.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId;
  const circuits = PRIVATE_VALUE_CIRCUITS[shape];
  const family = privateValueFamily(shape);
  const statement = toHexList(args.expectedPublicInputs);
  const hidingKernelVk = await session.loadChonkVk(CIRCUIT_URLS[circuits.hidingKernel], "hiding");
  throwIfAborted(signal);
  const applicationSteps: ChonkStep[] = [];
  let kernelUrl: string;
  let kernelLabel: string;
  let kernelWitnessMap: Record<string, unknown>;
  const eventUrl = args.eventApplication?.circuitUrl ?? CIRCUIT_URLS[NO_OP_EVENT_APPLICATION.circuit];
  const eventVk = await session.loadChonkVk(eventUrl, "app");
  const withEvent = (base: WitnessMap): WitnessMap => {
    const statement = eventStatementFromKernel(base, args.eventApplication?.event);
    applicationSteps.push(args.eventApplication === undefined ? noOpEventApplicationStep(eventVk, statement)
      : { ...args.eventApplication, vkUrl: eventVk.url, kind: eventVk.kind });
    return { ...base, event_application_vk: vkWitness(eventVk), event_statement: toHexList(statement) };
  };
  if (args.operation === "sponsored-transfer") {
    const [primaryVk, feeVk, kernelVk] = await Promise.all([
      session.loadChonkVk(args.primary.circuitUrl, "app"),
      session.loadChonkVk(args.feePayer.circuitUrl, "app"),
      session.loadChonkVk(CIRCUIT_URLS[circuits.sponsoredTransferKernel], "kernel"),
    ]);
    throwIfAborted(signal);
    applicationSteps.push(
      { ...args.primary, vkUrl: primaryVk.url, kind: primaryVk.kind },
      { ...args.feePayer, vkUrl: feeVk.url, kind: feeVk.kind },
    );
    kernelUrl = CIRCUIT_URLS[circuits.sponsoredTransferKernel];
    kernelLabel = "sponsored-transfer kernel";
    kernelWitnessMap = measureAssembly(
      circuits.sponsoredTransferKernel,
      requestStartedAt,
      onStatus,
      () => withEvent(args.buildKernelWitnessMap(primaryVk, feeVk)),
    );
    applicationSteps.push({ circuitUrl: kernelUrl, vkUrl: kernelVk.url, kind: kernelVk.kind, witnessMap: kernelWitnessMap, label: kernelLabel });
  } else {
    // Transfer and asset creation each fold one installed application, then the no-op event application.
    const kernel = args.operation === "transfer" ? circuits.transferKernel : circuits.assetCreationKernel;
    kernelUrl = CIRCUIT_URLS[kernel];
    kernelLabel = args.operation === "transfer" ? "transfer kernel" : "asset-creation kernel";
    const [authorizationVk, kernelVk] = await Promise.all([
      session.loadChonkVk(args.authorization.circuitUrl, "app"),
      session.loadChonkVk(kernelUrl, "kernel"),
    ]);
    throwIfAborted(signal);
    applicationSteps.push(
      { ...args.authorization, vkUrl: authorizationVk.url, kind: authorizationVk.kind },
    );
    kernelWitnessMap = measureAssembly(
      kernel,
      requestStartedAt,
      onStatus,
      () => withEvent(args.buildKernelWitnessMap(authorizationVk)),
    );
    applicationSteps.push({ circuitUrl: kernelUrl, vkUrl: kernelVk.url, kind: kernelVk.kind, witnessMap: kernelWitnessMap, label: kernelLabel });
  }
  const kernelVk = await session.loadChonkVk(kernelUrl, "kernel");
  throwIfAborted(signal);
  const result = await session.request({
    kind: "chonk",
    steps: [...applicationSteps, hidingStep(family, statement, kernelVk, hidingKernelVk)],
    expectedPublicInputs: statement,
  }, "chonk-result", onStatus, signal);
  return { proof: result.proof };
}

/** The circuits an asset action folds, in proving order. */
function assetActionCircuitUrls(args: AssetActionProofRequest): string[] {
  const circuits = PRIVATE_VALUE_CIRCUITS[args.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId];
  const hiding = CIRCUIT_URLS[circuits.hidingKernel];
  if (args.operation === "sponsored-transfer") {
    return [args.primary.circuitUrl, args.feePayer.circuitUrl, args.eventApplication?.circuitUrl ?? CIRCUIT_URLS[NO_OP_EVENT_APPLICATION.circuit], CIRCUIT_URLS[circuits.sponsoredTransferKernel], hiding];
  }
  const kernel = args.operation === "transfer" ? circuits.transferKernel : circuits.assetCreationKernel;
  return [args.authorization.circuitUrl, args.eventApplication?.circuitUrl ?? CIRCUIT_URLS[NO_OP_EVENT_APPLICATION.circuit], CIRCUIT_URLS[kernel], hiding];
}

function proverForSession(session: WorkerSession): Prover & AssetProver & ChonkProver {
  return {
  async proveChonk(
    { steps, expectedPublicInputs },
    onStatus,
    signal,
  ): Promise<ProofResult> {
      const result = await session.request(
        {
          kind: "chonk",
          steps: steps.map((step) => ({
            circuitUrl: step.circuitUrl,
            vkUrl: step.vkUrl,
            kind: step.kind,
            witnessMap: step.witnessMap,
            label: step.label,
          })),
          expectedPublicInputs: toHexList(expectedPublicInputs),
        },
        "chonk-result",
        onStatus,
        signal,
      );
      return { proof: result.proof };
  },

  proveTransfer: (args, onStatus, signal) =>
    proveKernelPipeline(session, kernelPipeline("proveTransfer", args), args, onStatus, signal),
  proveUserAccountUpdate: (args, onStatus, signal) =>
    proveKernelPipeline(session, kernelPipeline("proveUserAccountUpdate", args), args, onStatus, signal),

  async proveAssetAction(args, onStatus, signal): Promise<ProofResult> {
      return proveAssetAction(session, args, onStatus, signal);
  },
  };
}

export interface BrowserProverSession extends Prover, AssetProver, ChonkProver {
  readonly profile: ProverProfile;
  setup(onStatus?: (status: ProveStatus) => void, signal?: AbortSignal): Promise<void>;
  destroy(): void;
}

/**
 * One explicitly profiled browser prover. The caller owns its lifetime, making
 * both one-action sessions and warm consecutive-action sessions measurable.
 */
export function createBrowserProverSession(
  profile: Omit<ProverProfile, "reuse">,
  assetSource: BrowserProverAssetSource,
  applicationProfiles: BrowserCircuitProfiles = {},
): BrowserProverSession {
  const workerProfile: ProverProfile = { ...profile, reuse: true };
  const { profiles, digests } = browserProfiles(applicationProfiles);
  const spawn = (): WorkerSession => new WorkerSession(
    workerProfile,
    digests,
    profiles,
    assetSource,
  );
  let session = spawn();
  let destroyed = false;
  const serial = serialQueue();
  const enqueue = <T>(operation: (active: WorkerSession, prover: ReturnType<typeof proverForSession>) => Promise<T>): Promise<T> =>
    serial(async (): Promise<T> => {
      if (destroyed) throw new Error("prover worker session is closed");
      const active = session;
      try {
        return await operation(active, proverForSession(active));
      } catch (cause) {
        if (active.closed && !destroyed && session === active) session = spawn();
        throw cause;
      }
    });
  return {
    profile: workerProfile,
    setup: (onStatus, signal) => enqueue(async (active) => {
      await active.request({ kind: "setup" }, "setup-result", onStatus, signal);
    }),
    proveChonk: (args, onStatus, signal) =>
      enqueue((_active, prover) => prover.proveChonk(args, onStatus, signal)),
    proveTransfer: (args, onStatus, signal) =>
      enqueue((_active, prover) => prover.proveTransfer(args, onStatus, signal)),
    proveUserAccountUpdate: (args, onStatus, signal) =>
      enqueue((_active, prover) => prover.proveUserAccountUpdate(args, onStatus, signal)),
    proveAssetAction: (args, onStatus, signal) =>
      enqueue((_active, prover) => prover.proveAssetAction(args, onStatus, signal)),
    destroy: () => {
      destroyed = true;
      session.terminate();
    },
  };
}

export interface BrowserCircuitProfile {
  srsPoints: SupportedSrsPoints;
  /** Release pin for the circuit JSON the worker fetches. */
  circuitSha256: string;
  /** Exact CHONK verification-key URL paired with this circuit. */
  vkUrl: string;
  /** Release pin for the CHONK VK the worker fetches. */
  vkSha256: string;
}

export type BrowserCircuitProfiles = Readonly<Record<string, BrowserCircuitProfile>>;

function releasePin(url: string): string {
  const digest = PROVER_ARTIFACT_SHA256[url];
  if (digest === undefined) throw new Error(`no release pin for ${url}`);
  return digest;
}

export const PROTOCOL_CIRCUIT_PROFILES: BrowserCircuitProfiles = Object.fromEntries(
  Object.values(CIRCUIT_URLS).map((url) => [url, {
    srsPoints: CIRCUIT_SRS_POINTS[proverCircuitId(url)]! as SupportedSrsPoints,
    circuitSha256: releasePin(url),
    vkUrl: chonkVkUrl(url),
    vkSha256: releasePin(chonkVkUrl(url)),
  }]),
);

/** Current release profiles, measured from the exact CHONK circuit artifacts. */
function oneShotSrsPoints(
  circuitUrls: readonly string[],
  profiles: BrowserCircuitProfiles = PROTOCOL_CIRCUIT_PROFILES,
): SupportedSrsPoints {
  let required: SupportedSrsPoints = 2 ** 18;
  for (const url of circuitUrls) {
    const profile = profiles[url];
    if (profile === undefined) {
      throw new Error(`no release-pinned browser SRS profile for ${url}; use an explicitly profiled prover session`);
    }
    if (profile.srsPoints > required) required = profile.srsPoints;
  }
  return required;
}

function assertChonkStepProfiles(
  steps: readonly { circuitUrl: string; vkUrl: string }[],
  profiles: BrowserCircuitProfiles,
): void {
  for (const step of steps) {
    const profile = profiles[step.circuitUrl];
    if (profile === undefined) continue;
    if (step.vkUrl !== profile.vkUrl) {
      throw new Error(
        `CHONK VK URL ${step.vkUrl} does not match the release profile for ${step.circuitUrl}`,
      );
    }
  }
}

function defaultOneShotProfile(srsPoints: SupportedSrsPoints): ProverProfile {
  const hardwareConcurrency = typeof navigator === "undefined" ? 1 : navigator.hardwareConcurrency;
  return {
    srsPoints,
    threads: normalizeProverThreads("auto", hardwareConcurrency),
    reuse: false,
  };
}

async function withOneShotProver<T>(
  srsPoints: SupportedSrsPoints,
  digests: Readonly<Record<string, string>>,
  profiles: BrowserCircuitProfiles,
  assetSource: BrowserProverAssetSource,
  run: (prover: Prover & AssetProver & ChonkProver) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  const session = new WorkerSession(defaultOneShotProfile(srsPoints), digests, profiles, assetSource);
  let abort: (() => void) | undefined;
  try {
    if (signal === undefined) return await run(proverForSession(session));
    const canceled = new Promise<never>((_resolve, reject) => {
      abort = () => {
        session.terminate();
        reject(new ProverAbortError());
      };
      signal.addEventListener("abort", abort, { once: true });
    });
    return await Promise.race([run(proverForSession(session)), canceled]);
  } finally {
    if (abort !== undefined) signal?.removeEventListener("abort", abort);
    session.terminate();
  }
}

/** Build a lazy one-shot browser prover from protocol and application profiles. */
export function createBrowserProver(
  assetSource: BrowserProverAssetSource,
  applicationProfiles: BrowserCircuitProfiles = {},
): Prover & AssetProver & ChonkProver {
  const { profiles, digests } = browserProfiles(applicationProfiles);
  const oneShotPipeline = (method: KernelMethod): KernelProof => (args, onStatus, signal) =>
    withOneShotProver(
      oneShotSrsPoints(pipelineCircuitUrls(kernelPipeline(method, args), args), profiles),
      digests,
      profiles,
      assetSource,
      (prover) => prover[method](args, onStatus, signal),
      signal,
    );
  return {
  proveChonk: (args, onStatus, signal) => {
    assertChonkStepProfiles(args.steps, profiles);
    return withOneShotProver(
      oneShotSrsPoints(args.steps.map((step) => step.circuitUrl), profiles),
      digests,
      profiles,
      assetSource,
      (prover) => prover.proveChonk(args, onStatus, signal),
      signal,
    );
  },
  proveTransfer: oneShotPipeline("proveTransfer"),
  proveUserAccountUpdate: oneShotPipeline("proveUserAccountUpdate"),
  proveAssetAction: (args, onStatus, signal) =>
    withOneShotProver(
      oneShotSrsPoints(assetActionCircuitUrls(args), profiles),
      digests,
      profiles,
      assetSource,
      (prover) => prover.proveAssetAction(args, onStatus, signal),
      signal,
    ),
  };
}

function browserProfiles(applicationProfiles: BrowserCircuitProfiles) {
  const profiles = { ...PROTOCOL_CIRCUIT_PROFILES, ...applicationProfiles };
  // Protocol pins (all bundle circuits + CRS) plus each application's own
  // circuit/VK pins: the merged map flows into every worker request.
  const digests: Record<string, string> = { ...PROVER_ARTIFACT_SHA256 };
  for (const [url, entry] of Object.entries(applicationProfiles)) {
    const existingCircuitDigest = digests[url];
    if (existingCircuitDigest !== undefined && existingCircuitDigest !== entry.circuitSha256) {
      throw new Error(`conflicting release pins for ${url}`);
    }
    digests[url] = entry.circuitSha256;
    const existingVkDigest = digests[entry.vkUrl];
    if (existingVkDigest !== undefined && existingVkDigest !== entry.vkSha256) {
      throw new Error(`conflicting release pins for ${entry.vkUrl}`);
    }
    digests[entry.vkUrl] = entry.vkSha256;
  }
  return { profiles, digests };
}
