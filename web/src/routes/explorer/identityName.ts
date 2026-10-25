import { normalizeIdentityName } from "@pcash/sdk/names";
export { normalizeIdentityName } from "@pcash/sdk/names";

/** Every account page, for a hex address or a name, lives under this prefix. */
export const ADDRESS_PATH_PREFIX = "/";

export function identityNameFromPath(pathname: string): string | undefined {
  if (!pathname.startsWith(ADDRESS_PATH_PREFIX)) return undefined;
  const segment = pathname.slice(ADDRESS_PATH_PREFIX.length);
  if (segment.includes("/")) return undefined;
  try {
    return normalizeIdentityName(decodeURIComponent(segment));
  } catch {
    return undefined;
  }
}
