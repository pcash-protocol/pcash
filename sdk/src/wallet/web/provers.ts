import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import type { Prover, AssetProver, ProveStatus, BrowserProverSession } from "@pcash/sdk/browser-prover";
import { CIRCUIT_URLS } from "@pcash/sdk/browser-prover/requests";
import type { WalletRuntimeProvers } from "../actions/walletRuntime.ts";

export interface BrowserWalletProverOptions {
  /** The exact node connection and capability snapshot this wallet authenticated. */
  node: { readonly rpcUrl: string };
  proverAssets: { assetSetId: string; baseUrl: string } | null;
  onStatus?: (status: ProveStatus) => void;
}

export interface BrowserWalletProvers extends WalletRuntimeProvers {
  /** Cancel the proof currently owned by this wallet prover, if any. */
  cancelCurrent(): void;
  /** Release the worker and its WASM memory when the wallet session ends. */
  destroy(): void;
}

/** Wallet proving capabilities whose heavy worker implementation loads on the first write action. */
export function createBrowserWalletProvers(
  options: BrowserWalletProverOptions,
): BrowserWalletProvers {
  let pending: Promise<typeof import("@pcash/sdk/browser-prover")> | undefined;
  let session: BrowserProverSession | undefined;
  let generation = 0;
  let current: { generation: number; controller: AbortController } | undefined;
  const prover = async (signal: AbortSignal, circuitUrl: string): Promise<BrowserProverSession> => {
    const sdk = await (pending ??= import("@pcash/sdk/browser-prover"));
    signal.throwIfAborted();
    const srsPoints = sdk.PROTOCOL_CIRCUIT_PROFILES[circuitUrl]!.srsPoints;
    // Keep one worker. Asset creation needs a larger SRS; ordinary payments
    // need not download that larger profile until it is actually used.
    if (session === undefined || session.profile.srsPoints < srsPoints) {
      session?.destroy();
      session = sdk.createBrowserProverSession({
        srsPoints,
        threads: sdk.normalizeProverThreads("auto", navigator.hardwareConcurrency),
      }, sdk.resolveBrowserProverAssetSource(options.node.rpcUrl, options.proverAssets));
    }
    return session;
  };
  const run = async <T>(
    operation: (
      prover: Prover & AssetProver,
      onStatus: ((status: ProveStatus) => void) | undefined,
      signal: AbortSignal,
    ) => Promise<T>,
    circuitUrl: string = CIRCUIT_URLS.private_value_transfer_kernel,
    externalSignal?: AbortSignal,
  ): Promise<T> => {
    current?.controller.abort();
    const operationGeneration = ++generation;
    const controller = new AbortController();
    const abort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener("abort", abort, { once: true });
    current = { generation: operationGeneration, controller };
    const onStatus = options.onStatus === undefined
      ? undefined
      : (status: ProveStatus): void => {
          if (
            current?.generation === operationGeneration
            && !controller.signal.aborted
          ) options.onStatus?.(status);
        };
    try {
      return await operation(await prover(controller.signal, circuitUrl), onStatus, controller.signal);
    } finally {
      externalSignal?.removeEventListener("abort", abort);
      if (current?.generation === operationGeneration) current = undefined;
    }
  };
  return {
    cancelCurrent() {
      generation += 1;
      const active = current;
      current = undefined;
      active?.controller.abort();
    },
    destroy() {
      generation += 1;
      const active = current;
      current = undefined;
      active?.controller.abort();
      session?.destroy();
      session = undefined;
    },
    assetCreation: {
      shapes: [PRIVATE_VALUE_PROFILES.S.shapeId],
      async proveAndEncode(build, authorizationWitnessMap, mintRule) {
        if (build.shape !== PRIVATE_VALUE_PROFILES.S.shapeId) throw new Error("L transactions require native proving.");
        const mintRuleUrl = (CIRCUIT_URLS as Readonly<Record<string, string>>)[mintRule.packageName];
        if (mintRuleUrl === undefined) throw new Error("This mint rule requires native proving.");
        return run(async (browserProver, onStatus, signal) => {
          const proof = await browserProver.proveAssetAction({
            operation: "mint",
            authorization: { circuitUrl: CIRCUIT_URLS.account_rule_mint_ecdsa, witnessMap: authorizationWitnessMap, label: "mint authorization" },
            mintRule: { circuitUrl: mintRuleUrl, witnessMap: mintRule.witnessMap, label: "mint rule" },
            buildKernelWitnessMap: build.buildMintKernelWitnessMap, expectedPublicInputs: build.publicInputs,
          }, onStatus, signal);
          return build.encodeTransaction(proof.proof);
        }, CIRCUIT_URLS.account_rule_mint_ecdsa);
      },
    },
    assetAction: {
      shapes: [PRIVATE_VALUE_PROFILES.S.shapeId],
      async proveAndEncode(build, authorization, policy) {
        if (build.shape !== PRIVATE_VALUE_PROFILES.S.shapeId) throw new Error("L transactions require native proving.");
        if (authorization.packageName === "account_rule_large_batch_transfer_ecdsa") throw new Error("L transactions require native proving.");
        const urls = CIRCUIT_URLS as Readonly<Record<string, string>>;
        const circuitUrl = urls[authorization.packageName];
        if (circuitUrl === undefined) throw new Error("This authorization requires native proving.");
        const policyUrl = policy === undefined ? undefined : urls[policy.packageName];
        if (policy !== undefined && policyUrl === undefined) throw new Error("This transfer rule requires native proving.");
        return run(async (browserProver, onStatus, signal) => {
          const authorizationStep = { circuitUrl, witnessMap: authorization.witnessMap, label: "asset authorization" };
          const proof = await browserProver.proveAssetAction(policy === undefined ? {
            operation: "transfer",
            authorization: authorizationStep,
            buildKernelWitnessMap: build.buildKernelWitnessMap, expectedPublicInputs: build.publicInputs,
          } : {
            operation: "restricted-transfer",
            authorization: authorizationStep,
            policy: { circuitUrl: policyUrl!, witnessMap: policy.witnessMap, label: "transfer rule" },
            buildKernelWitnessMap: build.buildRestrictedKernelWitnessMap, expectedPublicInputs: build.publicInputs,
          }, onStatus, signal);
          return build.encodeTransaction(proof.proof);
        });
      },
    },
    privateValue: {
      async proveAndEncode(build, externalSignal) {
        if (build.shape !== PRIVATE_VALUE_PROFILES.S.shapeId) throw new Error("L transactions require native proving.");
        if (build.authorizationCircuit === "account_rule_large_batch_transfer_ecdsa") throw new Error("This authorization requires native proving.");
        const authorizationCircuitUrl = CIRCUIT_URLS[build.authorizationCircuit];
        if (build.accountRuleWitnessMap === undefined) {
          throw new Error("default-rule transfer did not produce an ECDSA application witness map");
        }
        return run(async (browserProver, onStatus, signal) => {
          const result = await browserProver.proveTransfer({
            authorizationWitnessMap: build.accountRuleWitnessMap!,
            buildKernelWitnessMap: build.buildKernelWitnessMap,
            expectedPublicInputs: build.publicInputs,
            authorizationCircuitUrl,
          }, onStatus, signal);
          return build.encodeTransaction(result.proof);
        }, CIRCUIT_URLS.private_value_transfer_kernel, externalSignal);
      },
    },
    userAccountUpdate: {
      async proveAndEncode(build) {
        if (build.readableEcdsaWitnessMap === undefined) {
          throw new Error("user account update did not produce an administration witness map");
        }
        return run(async (browserProver, onStatus, signal) => {
          const result = await browserProver.proveUserAccountUpdate({
            authorizationWitnessMap: build.readableEcdsaWitnessMap!,
            buildKernelWitnessMap: build.buildKernelWitnessMap,
            expectedPublicInputs: [...build.publicInputs],
            authorizationCircuitUrl: CIRCUIT_URLS.account_rule_admin_ecdsa,
          }, onStatus, signal);
          return build.encodeTransaction(result.proof);
        });
      },
    },
  };
}
