import type { ContractFunctionRecord, ContractSourceView, PublishedImplementation } from "./types.ts";
import { bytes32Hex } from "@pcash/sdk/utils";

export const NODE_SYNC_TOLERANCE_BLOCKS = 2n;

export type NodeSyncState =
  | { kind: "checking" }
  | { kind: "caughtUp"; blocksBehind: bigint }
  | { kind: "behind"; blocksBehind: bigint };

export function nodeSyncState(
  latestL1BlockNumber: bigint,
  observedL1BlockNumber: bigint | null,
): NodeSyncState {
  if (observedL1BlockNumber === null) return { kind: "checking" };
  const blocksBehind = observedL1BlockNumber > latestL1BlockNumber
    ? observedL1BlockNumber - latestL1BlockNumber
    : 0n;
  return blocksBehind > NODE_SYNC_TOLERANCE_BLOCKS
    ? { kind: "behind", blocksBehind }
    : { kind: "caughtUp", blocksBehind };
}

export function selectorHex(selector: number): string {
  if (!Number.isInteger(selector) || selector < 0 || selector > 255) throw new Error("selector must fit uint8");
  return `0x${selector.toString(16).padStart(2, "0")}`;
}

export function contractBadge(view: ContractSourceView): "Contract Source Code Verified" | "Contract Source Code Not Verified" {
  return view.verificationStatus === "verified" ? "Contract Source Code Verified" : "Contract Source Code Not Verified";
}

/** Wire quantities arrive as bigint from the SDK; the UI formats numbers. */
export function quantity(value: bigint | number): number {
  return typeof value === "number" ? value : Number(value);
}

export function contractBlockNumber(view: ContractSourceView): bigint {
  return view.contract.accountProof.boundary.header.number;
}

export function contractBlockHash(view: ContractSourceView): string {
  return bytes32Hex(view.contract.accountProof.boundary.blockHash);
}

export function contractFunctionSetCommitment(view: ContractSourceView): string {
  return view.contract.accountProof.account.accountRuleSetCommitment;
}

export function contractReceiveKeyPublished(view: ContractSourceView): boolean {
  return BigInt(view.contract.accountProof.account.receiveKeyHash) !== 0n;
}

export function selectedFunction(view: ContractSourceView, selector: number | undefined): ContractFunctionRecord | undefined {
  if (selector !== undefined) {
    const selected = view.contract.functions.find((fn) => quantity(fn.selector) === selector);
    if (selected) return selected;
  }
  return view.contract.functions[0];
}

export function implementationFor(
  view: ContractSourceView,
  fn: ContractFunctionRecord,
): PublishedImplementation | undefined {
  return view.implementations.find(
    (implementation) => implementation.applicationVkHash.toLowerCase() === fn.applicationVkHash.toLowerCase(),
  );
}

export type ImplementationSourceState = "unverified" | "loading" | "unavailable" | "available";

export function implementationSourceState(
  verificationStatus: ContractSourceView["verificationStatus"],
  applicationVkHash: string | undefined,
  sources: ReadonlyMap<string, unknown | null>,
  loading: boolean,
): ImplementationSourceState {
  if (verificationStatus !== "verified") return "unverified";
  if (applicationVkHash === undefined) return "unavailable";
  if (loading) return "loading";
  const key = applicationVkHash.toLowerCase();
  return sources.has(key) && sources.get(key) !== null ? "available" : "unavailable";
}

export function reproductionCommand(bundlePath = "pcash-contract-verification-bundle.json"): string {
  return `npm run source:reproduce -- --bundle ${bundlePath}`;
}
