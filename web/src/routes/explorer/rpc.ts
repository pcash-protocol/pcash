// Source verification uses a separate `pscan_*` listener. Check its network
// identity against the trusted RPC endpoint before displaying a verified badge.

import {
  createPscanClient,
  PcashNodeClient,
  type ContractSourceBundle,
  type ContractSourceView,
  type ImplementationSourceFile,
  type ImplementationSourceView,
  type PscanClient,
  type SourceVerificationInfo,
  type StatusResult,
} from "@pcash/sdk/clients";

export type {
  ContractSourceBundle,
  ContractSourceView,
  ImplementationSourceFile,
  ImplementationSourceView,
  SourceVerificationInfo,
  StatusResult,
};

/**
 * Whether the independently configured pscan listener reports the RPC endpoint's
 * chain ID and genesis hash. This does not compare their current heads.
 * `undefined` means the listener disclosed no genesis hash. Both `false` and
 * `undefined` block source display.
 */
export function pscanIdentityMatches(
  info: Pick<SourceVerificationInfo, "pcashChainId" | "genesisHash">,
  node: Pick<StatusResult, "pcashChainId" | "genesisHash">,
): boolean | undefined {
  if (info.genesisHash === null) return undefined;
  return info.pcashChainId === node.pcashChainId
    && info.genesisHash.toLowerCase() === node.genesisHash.toLowerCase();
}

export class SourceRpcClient {
  private readonly source: PscanClient | undefined;

  /** `pscanUrl` comes from the explorer config; absent means the service is off. */
  constructor(
    private readonly node: PcashNodeClient,
    pscanUrl?: string | undefined,
  ) {
    this.source = pscanUrl === undefined ? undefined : createPscanClient(pscanUrl);
  }

  get configured(): boolean {
    return this.source !== undefined;
  }

  status(): Promise<StatusResult> {
    return this.node.status();
  }

  #source(): PscanClient {
    if (this.source === undefined) throw new Error("The source-verification endpoint is not configured");
    return this.source;
  }

  sourceInfo(): Promise<SourceVerificationInfo> {
    return this.#source().sourceVerificationInfo();
  }

  contractSource(address: string): Promise<ContractSourceView | null> {
    return this.#source().getContractSource(address);
  }

  implementationSource(applicationVkHash: string): Promise<ImplementationSourceView | null> {
    return this.#source().getImplementationSource(applicationVkHash);
  }

  sourceFile(applicationVkHash: string, path: string): Promise<ImplementationSourceFile | null> {
    return this.#source().getImplementationSourceFile(applicationVkHash, path);
  }

  contractBundle(address: string): Promise<ContractSourceBundle | null> {
    return this.#source().getContractSourceBundle(address);
  }
}
