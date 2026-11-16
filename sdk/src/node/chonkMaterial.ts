import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Config } from "../bcfg/index.ts";
import { chonkVkArtifacts, vkFieldsFromBytes } from "../protocol/account.ts";
import { computeChonkVk, type ChonkBackend } from "../prover/chonk.ts";
import type { ChonkCircuitMaterial, ChonkCircuitResolver } from "../prover/stacks.ts";
import { nativeChonkBackend } from "./nativeProver.ts";

/** Resolve compiled artifacts and canonical Mega VKs for native proving. */
export function createChonkCircuitResolver(options: {
  artifactDirectory: string;
  verificationKeyDirectory?: string;
  threads?: number;
  backend?: ChonkBackend;
}): ChonkCircuitResolver {
  const cache = new Map<string, Promise<ChonkCircuitMaterial>>();
  let fallbackBackend = options.backend;
  const backendForFallback = (): ChonkBackend =>
    fallbackBackend ??= nativeChonkBackend(options.threads);
  return (packageName, kind) => {
    const cacheKey = `${packageName}:${kind}`;
    let pending = cache.get(cacheKey);
    if (pending === undefined) {
      pending = (async () => {
        const artifactPath = join(options.artifactDirectory, `${packageName}.json`);
        const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
          bytecode: string;
          abi: unknown;
        };
        const vkPath = options.verificationKeyDirectory === undefined
          ? undefined
          : join(options.verificationKeyDirectory, `${packageName}.chonk.vk`);
        if (vkPath !== undefined && existsSync(vkPath)) {
          const verificationKey = new Uint8Array(readFileSync(vkPath));
          const vk = chonkVkArtifacts(vkFieldsFromBytes(verificationKey, kind), kind);
          return {
            kind,
            artifact,
            verificationKey,
            ...vk,
          };
        }
        const computed = await computeChonkVk(
          packageName,
          artifact,
          kind,
          backendForFallback(),
        );
        return {
          kind,
          artifact,
          verificationKey: computed.bytes,
          vkFields: computed.vkFields,
          vkHash: computed.vkHash,
        };
      })();
      cache.set(cacheKey, pending);
    }
    return pending!;
  };
}

/** Resolve the active content-addressed circuit bundle used by CLI proving. */
export function createReleaseChonkCircuitResolver(options: {
  backend?: ChonkBackend;
  threads?: number;
} = {}): ChonkCircuitResolver {
  const config = new Config("pcash");
  config.load({ env: true });
  let bundle = config.str("circuit-bundle") ?? undefined;
  if (!bundle) {
    const repository = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
    const resolver = join(repository, "scripts", "circuits", "bundle.mjs");
    bundle = execFileSync(process.execPath, [resolver, "--print-path"], {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }).trim().split(/\r?\n/).at(-1);
  }
  if (!bundle) throw new Error("no active CHONK circuit bundle");
  return createChonkCircuitResolver({
    artifactDirectory: join(bundle, "prover-assets"),
    verificationKeyDirectory: join(bundle, "vks"),
    ...options,
  });
}
