import { useCallback, useState } from "react";
import type { AssetProver } from "@pcash/sdk/browser-prover/requests";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import { availableDropsFromNode, defaultTokensProver, dropEligibilityFromNode, inspectLinkAtNode, TokensApp, type AvailableDrop, type TokensProgress } from "@pcash/tokens/app";
import type { DurableSubmissionAdapter } from "@pcash/sdk/wallet";
import { openTokensStore, type IndexedDbTokensStore } from "../../lib/TokensStore.ts";
import { useWallet } from "../../lib/WalletProvider.tsx";
import type { SubmissionMode } from "../../lib/WebsiteSettings.tsx";
import { recordProofTiming } from "../../components/proofStages.ts";

let store: Promise<IndexedDbTokensStore> | undefined;
const provers = new WeakMap<PcashNodeClient, AssetProver>();

/** The template prover for a node, loaded when a claim or reclaim first proves. */
function tokensProver(node: PcashNodeClient): AssetProver {
  let prover = provers.get(node);
  if (prover === undefined) {
    let loading: Promise<AssetProver> | undefined;
    prover = { proveAssetAction: async (...args) => (await (loading ??= defaultTokensProver(node))).proveAssetAction(...args) };
    provers.set(node, prover);
  }
  return prover;
}

/**
 * The token application for the open wallet. The submission mode decides how
 * each action is published: Fast posts from the connected Ethereum wallet and
 * Open relay goes through the node mempool.
 */
export function useTokensApp() {
  const { wallet, node, selfPublication, connectedAccount } = useWallet();
  const [progress, setProgress] = useState<TokensProgress>();
  const onProgress = useCallback((next: TokensProgress) => {
    if (next.proof !== undefined) recordProofTiming(next.proof);
    setProgress(next);
  }, []);

  /** `fast` is the Fast adapter one action publishes with; the connected wallet's own by default. */
  const app = useCallback(async (mode: SubmissionMode = "slow", fast?: DurableSubmissionAdapter): Promise<TokensApp> => {
    if (wallet === undefined) throw new Error("Sign in to your wallet first.");
    let submission: DurableSubmissionAdapter | undefined;
    if (mode === "fast") {
      if (selfPublication === undefined) throw new Error("Connect an Ethereum wallet to publish it yourself.");
      submission = fast ?? selfPublication as DurableSubmissionAdapter;
    }
    return new TokensApp({
      wallet, node, prover: tokensProver(node), store: await (store ??= openTokensStore()),
      ...(submission === undefined ? {} : { submission }),
    });
  }, [node, selfPublication, wallet]);

  const availableDrops = useCallback(() => availableDropsFromNode(node), [node]);
  const dropEligibility = useCallback(async (drop: AvailableDrop) => {
    if (wallet !== undefined) return (await app()).dropEligibility(drop);
    return connectedAccount === undefined ? undefined : dropEligibilityFromNode(node, drop, connectedAccount);
  }, [app, connectedAccount, node, wallet]);

  return {
    available: wallet !== undefined, app,
    inspectLink: useCallback((url: string) => inspectLinkAtNode(node, url), [node]),
    availableDrops, dropEligibility,
    progress, onProgress, clearProgress: useCallback(() => setProgress(undefined), []),
  };
}
