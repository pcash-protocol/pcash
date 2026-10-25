// The wallet-facing token application: one object a page holds per open
// wallet. Every long action reports progress, fails with a `TokensError` code
// where the user can act on the reason, and resumes from where an interrupted
// run stopped when called again.

import type { DurableSubmissionAdapter, Wallet } from "@pcash/sdk/wallet";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import type { AssetProver } from "@pcash/sdk/browser-prover/requests";
import { TOKENS_CIRCUIT_PROFILES } from "../circuits.ts";
import type { TokensActionCallbacks, TokensProgressCallback } from "./action.ts";
import {
  advanceLinkSet,
  claimLink,
  createLinkSet,
  inspectClaimLink,
  linkSets,
  linkSetStatus,
  linkSetUrls,
  claimUnclaimedLinks,
  type ClaimLinkInspection,
  type UnclaimedLinksClaim,
  type LinkSetStatus,
  type LinkSetView,
  type TokenClaimResult,
} from "./links.ts";
import {
  advanceDrop,
  availableDrops,
  claimDrop,
  createDrop,
  dropEligibility,
  drops,
  dropStatus,
  reclaimDrop,
  type AvailableDrop,
  type DropEligibilityResult,
  type DropReclaimResult,
  type DropStatus,
  type DropView,
} from "./drops.ts";
import type { TokensRuntime } from "./runtime.ts";
import type { TokensStore } from "./store.ts";

export interface TokensAppOptions<Prepared = unknown, Output = unknown> {
  wallet: Wallet<Prepared, Output>;
  /** The wallet's node, for reads that need no wallet, such as inspecting a link before connecting. */
  node: PcashNodeClient;
  /** Proves the template functions: `defaultTokensProver(node)` in a browser. */
  prover: AssetProver;
  /** Creator records: link sets and drops. */
  store: TokensStore;
  /** Overrides the wallet's configured submission for every token action. */
  submission?: DurableSubmissionAdapter<Prepared, Output>;
  /** Polling while a relayed transaction waits for inclusion or funding waits for finality. */
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
  now?: () => number;
}

/** Relay fee and callbacks shared by every action that publishes a transaction. */
export interface TokensActionOptions extends TokensActionCallbacks {
  /**
   * Public fee for a relayed transaction. Zero or absent claims in the transfer
   * role; a positive fee is paid from this wallet's PCASH. Self-publication
   * takes no fee.
   */
  openFeeAmount?: bigint;
}

export class TokensApp<Prepared = unknown, Output = unknown> {
  readonly #rt: TokensRuntime<Prepared, Output>;

  constructor(options: TokensAppOptions<Prepared, Output>) {
    this.#rt = {
      wallet: options.wallet,
      node: options.node,
      prover: options.prover,
      store: options.store,
      ...(options.submission === undefined ? {} : { submission: options.submission }),
      pollIntervalMs: options.pollIntervalMs ?? 2_000,
      pollMaxAttempts: options.pollMaxAttempts ?? 150,
      now: options.now ?? Date.now,
    };
  }

  /** Create a claim-link contract and fund one note per amount; resolves once every link is final. */
  createLinkSet(params: { assetId: bigint; amounts: readonly bigint[] } & TokensActionOptions): Promise<LinkSetView> {
    return createLinkSet(this.#rt, params);
  }

  /** Continue an interrupted link set. */
  resumeLinkSet(key: string, onProgress?: TokensProgressCallback): Promise<LinkSetView> {
    return advanceLinkSet(this.#rt, key, onProgress);
  }

  linkSets(): Promise<LinkSetView[]> {
    return linkSets(this.#rt);
  }

  linkSetStatus(key: string): Promise<LinkSetStatus> {
    return linkSetStatus(this.#rt, key);
  }

  /** The claim URLs of a ready set; the secret part stays in the URL fragment. */
  linkSetUrls(key: string, claimPageUrl: string): Promise<string[]> {
    return linkSetUrls(this.#rt, key, claimPageUrl);
  }

  /** The creator's own claim of every link still unclaimed, up to four per call. */
  claimUnclaimedLinks(key: string, options?: TokensActionOptions): Promise<UnclaimedLinksClaim> {
    return claimUnclaimedLinks(this.#rt, key, options);
  }

  inspectLink(url: string): Promise<ClaimLinkInspection> {
    return inspectClaimLink(this.#rt, url);
  }

  /** Claim into this wallet, or to `recipient` (an address or receive code). */
  claimLink(url: string, options?: { recipient?: string } & TokensActionOptions): Promise<TokenClaimResult> {
    return claimLink(this.#rt, url, options);
  }

  /** Create a drop, fund its inventory, and publish it to the node catalog. */
  createDrop(params: {
    assetId: bigint;
    claimAmount: bigint;
    count: number;
    cutoffBlockNumber?: bigint;
    claimEndTimestamp: bigint;
  } & TokensActionOptions): Promise<DropView> {
    return createDrop(this.#rt, params);
  }

  /** Continue an interrupted drop. */
  resumeDrop(key: string, onProgress?: TokensProgressCallback): Promise<DropView> {
    return advanceDrop(this.#rt, key, onProgress);
  }

  drops(): Promise<DropView[]> {
    return drops(this.#rt);
  }

  dropStatus(key: string): Promise<DropStatus> {
    return dropStatus(this.#rt, key);
  }

  reclaimDrop(key: string, options?: TokensActionOptions): Promise<DropReclaimResult> {
    return reclaimDrop(this.#rt, key, options);
  }

  availableDrops(): Promise<AvailableDrop[]> {
    return availableDrops(this.#rt);
  }

  /** Whether `address`, or this wallet when omitted, can claim `drop`. */
  dropEligibility(drop: AvailableDrop, address?: string): Promise<DropEligibilityResult> {
    return dropEligibility(this.#rt, drop, address);
  }

  claimDrop(drop: AvailableDrop, options?: TokensActionOptions): Promise<TokenClaimResult> {
    return claimDrop(this.#rt, drop, options);
  }
}

/** Load the browser prover with the token template circuits only when a claim needs it. */
export async function defaultTokensProver(node: PcashNodeClient): Promise<AssetProver> {
  const [{ createBrowserProver, resolveBrowserProverAssetSource }, status] = await Promise.all([
    import("@pcash/sdk/browser-prover"),
    node.status(),
  ]);
  return createBrowserProver(resolveBrowserProverAssetSource(node.rpcUrl, status.proverAssets), TOKENS_CIRCUIT_PROFILES);
}
