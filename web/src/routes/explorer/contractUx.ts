
export interface LoadedSourceFile {
  path: string;
  content: string;
}

export interface OrderedSourceFiles {
  application: LoadedSourceFile[];
  dependencies: LoadedSourceFile[];
  verification: LoadedSourceFile[];
  build: LoadedSourceFile[];
}

const SOURCE_EXTENSION = ".nr";

function normalizedRoot(packageRoot: string): string {
  return packageRoot.replace(/^\.\//, "").replace(/\/$/, "");
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function moduleName(path: string): string {
  const basename = path.slice(path.lastIndexOf("/") + 1).replace(/\.nr$/, "");
  return basename === "main" || basename === "lib"
    ? path.split("/").slice(-3, -2)[0] ?? basename
    : basename;
}

function mentionScore(content: string, candidate: LoadedSourceFile): number {
  const name = moduleName(candidate.path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const moduleReference = new RegExp(`(?:mod\\s+|use\\s+|::)${name}(?:\\b|::)`);
  return moduleReference.test(content) ? 2 : 0;
}

function relevancePartition(files: LoadedSourceFile[], seeds: LoadedSourceFile[]): {
  relevant: LoadedSourceFile[];
  remaining: LoadedSourceFile[];
} {
  const ranked = files.map((file) => ({
    file,
    score: Math.max(0, ...seeds.map((seed) => mentionScore(seed.content, file))),
  }));
  return {
    relevant: ranked.filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
      .map((entry) => entry.file),
    remaining: ranked.filter((entry) => entry.score === 0)
      .map((entry) => entry.file)
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** Application code first, then dependencies in approximate import distance, then build inputs. */
export function orderSourceFiles(packageRoot: string, files: LoadedSourceFile[]): OrderedSourceFiles {
  const root = normalizedRoot(packageRoot);
  const noir = files.filter((file) => file.path.endsWith(SOURCE_EXTENSION));
  const build = files.filter((file) => !file.path.endsWith(SOURCE_EXTENSION));
  const applicationCandidates = noir.filter((file) => isInside(file.path, root));
  const main = applicationCandidates.find((file) => /(?:^|\/)src\/main\.nr$/.test(file.path));
  const applicationRest = applicationCandidates.filter((file) => file !== main);
  const orderedApplication = relevancePartition(applicationRest, main === undefined ? [] : [main]);
  const application = [
    ...(main === undefined ? [] : [main]),
    ...orderedApplication.relevant,
    ...orderedApplication.remaining,
  ];
  const dependencyOrder = relevancePartition(
    noir.filter((file) => !isInside(file.path, root)),
    application.length === 0 ? noir.slice(0, 1) : application,
  );
  const packageManifest = `${root}/Nargo.toml`;
  build.sort((a, b) =>
    Number(b.path === packageManifest) - Number(a.path === packageManifest)
      || a.path.localeCompare(b.path));
  return {
    application,
    dependencies: dependencyOrder.relevant,
    verification: dependencyOrder.remaining,
    build,
  };
}

export function formatPresentedValue(displayFormat: string, raw: string): string {
  const value = BigInt(raw);
  switch (displayFormat) {
    case "ethereum-address":
      return `0x${value.toString(16).padStart(40, "0")}`;
    case "unix-timestamp": {
      const millis = value * 1_000n;
      if (millis > BigInt(Number.MAX_SAFE_INTEGER)) return value.toString();
      return new Date(Number(millis)).toISOString().replace("T", " · ").replace(".000Z", " UTC");
    }
    case "hex":
    case "field":
      return raw.startsWith("0x") ? raw : `0x${value.toString(16)}`;
    case "chain-id":
    case "uint":
    default:
      return value.toString();
  }
}

export function isConfigurationSalt(name: string): boolean {
  return /^configuration_?salt$/i.test(name);
}

export function formatNoirAbiType(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Private witness";
  const type = value as { kind?: unknown; path?: unknown; name?: unknown; sign?: unknown; width?: unknown; length?: unknown; type?: unknown };
  if (type.kind === "field") return "Field";
  if (type.kind === "boolean") return "bool";
  if (type.kind === "integer" && Number.isInteger(type.width)) {
    return `${type.sign === "signed" ? "i" : "u"}${String(type.width)}`;
  }
  if (type.kind === "array" && Number.isInteger(type.length)) {
    return `[${formatNoirAbiType(type.type)}; ${String(type.length)}]`;
  }
  if (type.kind === "struct") {
    const path = typeof type.path === "string" ? type.path : typeof type.name === "string" ? type.name : "struct";
    return path.split("::").at(-1) ?? path;
  }
  return typeof type.kind === "string" ? type.kind : "Private witness";
}

export function sourceIdentityConfirmed(
  verificationStatus: "verified" | "not_verified",
  identityMatch: boolean | undefined,
): boolean {
  return verificationStatus === "verified" && identityMatch === true;
}

function provenanceLabel(value: string): string {
  const words = value.replaceAll("_", " ").replaceAll("-", " ");
  return words.length === 0 ? value : words[0]!.toUpperCase() + words.slice(1);
}

/** Keep the publisher's self-description separate from Pscan ingestion provenance. */
export function presentationAttribution(
  publisherLabel: string,
  verificationAuthority: string,
  verificationMethod: string,
): { publisher: string; source: string } {
  return {
    publisher: `Self-declared publisher: ${publisherLabel}`,
    source: `Source: ${provenanceLabel(verificationAuthority)} / ${provenanceLabel(verificationMethod)}`,
  };
}
