// Worker-agnostic proving surface shared by the browser worker client
// (proverClient.ts, backed by proverWorker.ts) and the headless Node driver
// and native executors. Applications contribute their own circuit URLs and
// witnesses; this module knows only the protocol and supported reference rules.

import type { PrivateValueShape } from "../constants/privateValueProfiles.ts";
import type { ChonkCircuitKind, ChonkVkArtifacts } from "../protocol/account.ts";
import type { WitnessMap } from "../protocol/witness.ts";

/** Coarse phase for the ProvingOverlay machine. */
export type ProvePhase =
  | "idle"
  | "preparing"
  | "proving"
  | "submitting"
  | "confirming"
  | "done"
  | "error";

/** A streamed progress update from the worker (or a flow step). */
/**
 * What a status update is timing.
 *
 * `crs` is the proving parameters: fetched once and kept in IndexedDB, so it
 * survives worker restarts and is genuinely paid once per browser.
 *
 * `runtime` is starting the WASM prover: `noir` initializes the Noir execution
 * Wasm, `barretenberg` fetches, compiles, and instantiates the Barretenberg
 * Wasm and spawns its threads, and `barretenberg-srs` loads the cached proving
 * parameters into Barretenberg. One-shot callers pay it on every action;
 * retained sessions pay it when their worker starts or is replaced after
 * cancellation or a crash.
 */
export type ProveStep =
  | "crs"
  | "runtime"
  | "load"
  | "execute"
  | "prove"
  | "artifacts"
  | "assemble";

export type ProveScope = "circuit" | "stack";

export interface ProveStatus {
  phase: ProvePhase;
  message: string;
  /** Milliseconds since the current proving request began (worker-measured). */
  elapsedMs: number;
  /** What this update is timing; absent on updates a flow emits itself. */
  step?: ProveStep;
  /** The circuit the step belongs to, so callers need not parse `message`. */
  circuit?: string;
  /** Stack-wide CHONK work is measured without pretending it is another circuit. */
  scope?: ProveScope;
  /** The stack operation a stack-scope update times: `start`, `finalize` or `compress`. */
  operation?: string;
  /** The circuit's zero-based position in the stack, on circuit updates of a CHONK stack. */
  circuitIndex?: number;
  /** How many circuits the CHONK stack folds, on every update that belongs to one. */
  circuitCount?: number;
  /**
   * Measured duration of a COMPLETED operation. An update carrying this is a
   * measurement, not progress: it is emitted after the work it describes.
   *
   * Timing must not be inferred from the gap between progress updates. Between
   * one operation's start and the next there is real work with no update of its
   * own — recursion artifacts, witness assembly, worker round trips, the next
   * circuit's fetch — and a gap-derived bucket silently absorbs all of it.
   */
  durationMs?: number;
  /**
   * Barretenberg's Wasm linear-memory size in bytes when the measured operation
   * completed, present when the profile sets `reportWasmMemory`. Wasm memory
   * never shrinks, so the last value in a proving run is its peak.
   */
  wasmMemoryBytes?: number;
}

/** A finished hiding-kernel proof whose statement was bound to the requested inputs. */
export interface ProofResult {
  proof: Uint8Array;
}

/**
 * Protocol circuit artifact URLs, all served by the browser release. The
 * manifest's runtimes decide which a browser proves by default; the L
 * profile's are native-only.
 */
export const CIRCUIT_URLS = {
  account_rule_mine: "/prover/account_rule_mine.json",
  account_rule_asset_creation_ecdsa: "/prover/account_rule_asset_creation_ecdsa.json",
  account_rule_payment_ecdsa: "/prover/account_rule_payment_ecdsa.json",
  account_rule_asset_payment_ecdsa: "/prover/account_rule_asset_payment_ecdsa.json",
  account_rule_asset_burn_ecdsa: "/prover/account_rule_asset_burn_ecdsa.json",
  account_rule_batch_transfer_ecdsa: "/prover/account_rule_batch_transfer_ecdsa.json",
  account_rule_contract_fee_sponsorship_ecdsa:
    "/prover/account_rule_contract_fee_sponsorship_ecdsa.json",
  account_rule_admin_ecdsa: "/prover/account_rule_admin_ecdsa.json",
  no_op_event_application: "/prover/no_op_event_application.json",
  private_value_sponsored_transfer_kernel: "/prover/private_value_sponsored_transfer_kernel.json",
  private_value_asset_creation_kernel: "/prover/private_value_asset_creation_kernel.json",
  private_value_transfer_kernel: "/prover/private_value_transfer_kernel.json",
  user_account_update_kernel: "/prover/user_account_update_kernel.json",
  private_value_hiding_kernel: "/prover/private_value_hiding_kernel.json",
  user_account_update_hiding_kernel: "/prover/user_account_update_hiding_kernel.json",
  account_rule_large_batch_transfer_ecdsa: "/prover/account_rule_large_batch_transfer_ecdsa.json",
  account_rule_large_asset_creation_ecdsa: "/prover/account_rule_large_asset_creation_ecdsa.json",
  account_rule_large_contract_fee_sponsorship_ecdsa:
    "/prover/account_rule_large_contract_fee_sponsorship_ecdsa.json",
  private_value_large_transfer_kernel: "/prover/private_value_large_transfer_kernel.json",
  private_value_large_sponsored_transfer_kernel: "/prover/private_value_large_sponsored_transfer_kernel.json",
  private_value_large_asset_creation_kernel: "/prover/private_value_large_asset_creation_kernel.json",
  private_value_large_hiding_kernel: "/prover/private_value_large_hiding_kernel.json",
} as const;

export interface ChonkProofStep {
  circuitUrl: string;
  vkUrl: string;
  kind: ChonkCircuitKind;
  witnessMap: WitnessMap;
  label: string;
}

export interface ChonkProver {
  proveChonk(
    args: {
      steps: readonly ChonkProofStep[];
      expectedPublicInputs: readonly bigint[];
    },
    onStatus?: (s: ProveStatus) => void,
    signal?: AbortSignal,
  ): Promise<ProofResult>;
}

/**
 * The proving capability the write flows consume.
 *
 * Each entry point folds the installed authorization application, the no-op
 * event application, its protocol kernel, and the family's hiding kernel into
 * one CHONK proof.
 */
export interface Prover {
  proveTransfer(
    args: {
      eventApplication?: ChonkApplicationStep & { event: bigint };
      authorizationWitnessMap: WitnessMap;
      buildKernelWitnessMap: (authorizationVk: ChonkVkArtifacts) => WitnessMap;
      expectedPublicInputs: bigint[];
      /** Defaults to S. L folds the large transfer kernel and hiding kernel. */
      shape?: PrivateValueShape;
      /**
       * Defaults to the shape's readable rule: payment for S, large batch
       * transfer for L. Contract calls substitute their installed app circuit.
       */
      authorizationCircuitUrl?: string;
      authorizationLabel?: string;
    },
    onStatus?: (s: ProveStatus) => void,
    signal?: AbortSignal,
  ): Promise<ProofResult>;
  proveUserAccountUpdate(
    args: {
      eventApplication?: ChonkApplicationStep & { event: bigint };
      authorizationWitnessMap: WitnessMap;
      buildKernelWitnessMap: (authorizationVk: ChonkVkArtifacts) => WitnessMap;
      expectedPublicInputs: bigint[];
      authorizationCircuitUrl?: string;
      authorizationLabel?: string;
    },
    onStatus?: (s: ProveStatus) => void,
    signal?: AbortSignal,
  ): Promise<ProofResult>;

}

/** One private application folded into a CHONK transaction. */
export interface ChonkApplicationStep {
  circuitUrl: string;
  witnessMap: WitnessMap;
  label: string;
}

interface AssetActionProofRequestBase {
  eventApplication?: ChonkApplicationStep & { event: bigint };
  /** Defaults to S. L folds the shape's large kernel and hiding kernel. */
  shape?: PrivateValueShape;
  /** The hiding kernel's public inputs, never an application return statement. */
  expectedPublicInputs: readonly bigint[];
}

/**
 * Browser proving inputs for the protocol's bounded asset composition paths.
 * Each request names the private applications and kernel witness builder that
 * CHONK folds into the private-value hiding kernel.
 */
export type AssetActionProofRequest =
  | (AssetActionProofRequestBase & {
      operation: "transfer" | "assetCreation";
      authorization: ChonkApplicationStep;
      buildKernelWitnessMap: (authorizationVk: ChonkVkArtifacts) => WitnessMap;
    })
  | (AssetActionProofRequestBase & {
      operation: "sponsored-transfer";
      primary: ChonkApplicationStep;
      feePayer: ChonkApplicationStep;
      buildKernelWitnessMap: (
        primaryVk: ChonkVkArtifacts,
        feePayerVk: ChonkVkArtifacts,
      ) => WitnessMap;
    });

/** Asset proving is separate so native prover adapters do not need a dummy method. */
export interface AssetProver {
  proveAssetAction(
    args: AssetActionProofRequest,
    onStatus?: (s: ProveStatus) => void,
    signal?: AbortSignal,
  ): Promise<ProofResult>;
}
