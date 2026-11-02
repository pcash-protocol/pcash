import { ADDRESS_PATH_PREFIX, identityNameFromPath } from "./identityName.ts";
import { matchPath } from "react-router-dom";

/**
 * Chain-object routes. Every one of these is a leaf at the site root: the
 * "Explorer" nav item groups them, but it is a path segment only for the
 * dashboard itself.
 */
export const explorerPaths = {
  dashboard: "explorer",
  blocks: "blocks",
  block: "block/:number",
  transactions: "transactions",
  transaction: "tx/:transactionId",
  batch: "batch/:hash",
  contracts: "contracts",
  search: "search",
} as const;

const ADDRESS_PATH = /^\/0x[0-9a-fA-F]{40}$/;

export function isAddressPath(pathname: string): boolean {
  return ADDRESS_PATH.test(pathname);
}

export function isNamePath(pathname: string): boolean {
  return identityNameFromPath(pathname) !== undefined;
}

/** An account page: `/` followed by a hex address or a dotted name. */
export function isIdentityPath(pathname: string): boolean {
  return isAddressPath(pathname) || isNamePath(pathname);
}

/** Whether the explorer renders this pathname. Identity is a separate route. */
export function isExplorerPath(pathname: string): boolean {
  return Object.values(explorerPaths).some((path) => matchPath(`/${path}`, pathname) !== null);
}

/** The account page for a hex address or a name. */
export function addressPath(identity: string): string {
  return `${ADDRESS_PATH_PREFIX}${identity}`;
}

export function transactionPath(id: string): string {
  return `/tx/${id}`;
}

export function blockPath(number: bigint | number): string {
  return `/block/${number}`;
}

export function batchPath(l1TransactionHash: string): string {
  return `/batch/${l1TransactionHash}`;
}

export function searchPath(query: string): string {
  return `/search?q=${encodeURIComponent(query)}`;
}
