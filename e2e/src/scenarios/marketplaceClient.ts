import {
  MarketplaceController,
  privateKeyL1Signer,
  type L1FeeCap,
  type MarketplaceProver,
  type MarketplaceStore,
  type StoredOffer,
} from "@pcash/marketplace/client";
import { PRIVATE_VALUE_PROFILES } from "@pcash/sdk/constants";
import { createReleaseChonkCircuitResolver, nativeChonkBackend } from "@pcash/sdk/node";
import { proveTransferTransactionChonk } from "@pcash/sdk/prover";
import type { PcashNodeClient } from "@pcash/sdk/clients";
import type { Wallet } from "@pcash/sdk/wallet";
import { nativeTokensProver } from "@pcash/tokens/tooling/nativeProver";
import type { Address, Hex } from "viem";

/** Listing and purchase state held in memory, as a fresh browser profile starts with none. */
export class MemoryMarketplaceStore implements MarketplaceStore {
  readonly #offers = new Map<string, StoredOffer>();

  async list(): Promise<StoredOffer[]> {
    return [...this.#offers.values()].map((offer) => structuredClone(offer));
  }

  async get(key: string): Promise<StoredOffer | null> {
    const offer = this.#offers.get(key);
    return offer === undefined ? null : structuredClone(offer);
  }

  async put(offer: StoredOffer): Promise<void> {
    this.#offers.set(offer.key, structuredClone(offer));
  }

  async remove(key: string): Promise<void> {
    this.#offers.delete(key);
  }

  async clear(): Promise<void> {
    this.#offers.clear();
  }

  async update(key: string, operation: (current: StoredOffer | null) => StoredOffer | null): Promise<StoredOffer | null> {
    const next = operation(await this.get(key));
    if (next === null) this.#offers.delete(key);
    else this.#offers.set(key, structuredClone(next));
    return next === null ? null : structuredClone(next);
  }
}

/** The release package a pinned browser circuit URL serves. */
function packageOf(circuitUrl: string): string {
  const match = /^\/prover\/(.+)\.json$/.exec(circuitUrl);
  if (match === null) throw new Error(`${circuitUrl} is not a pinned circuit URL`);
  return match[1]!;
}

/** The website's Marketplace proof requests, proved on the native CHONK stack. */
export function nativeMarketplaceProver(): MarketplaceProver {
  const backend = nativeChonkBackend();
  const resolve = createReleaseChonkCircuitResolver({ backend });
  const notMarketplace = async (): Promise<never> => { throw new Error("the Marketplace proves only contract calls and asset actions"); };
  return {
    ...nativeTokensProver(),
    async proveTransfer(args) {
      if (args.authorizationCircuitUrl === undefined) throw new Error("a Marketplace contract call names its circuit");
      const result = await proveTransferTransactionChonk({
        build: {
          shape: args.shape ?? PRIVATE_VALUE_PROFILES.S.shapeId,
          publicInputs: [...args.expectedPublicInputs],
          buildKernelWitnessMap: args.buildKernelWitnessMap,
        },
        authorizationPackage: packageOf(args.authorizationCircuitUrl),
        authorizationWitnessMap: args.authorizationWitnessMap,
        resolve,
        backend,
      });
      return { proof: result.proof };
    },
    proveUserAccountUpdate: notMarketplace,
  };
}

/** The Marketplace client the website runs for one wallet and Ethereum key, proving natively. */
export function marketplaceController(params: {
  node: PcashNodeClient;
  wallet: Wallet;
  l1RpcUrl: string;
  l1PrivateKey: Hex;
  router: Address;
  feeCap?: L1FeeCap;
  store?: MarketplaceStore;
}): MarketplaceController {
  const prover = nativeMarketplaceProver();
  return new MarketplaceController({
    node: params.node,
    store: params.store ?? new MemoryMarketplaceStore(),
    l1RpcUrls: [params.l1RpcUrl],
    configuredRouter: { address: params.router },
    identity: { wallet: params.wallet, l1Signer: privateKeyL1Signer(params.l1PrivateKey, params.l1RpcUrl, params.feeCap) },
    prover: async () => prover,
  });
}
