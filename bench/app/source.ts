import { CIRCUIT_SRS_POINTS as LINEAGE_SRS_POINTS } from "@pcash/lineage/runtimes";
import { PcashNodeClient } from "@pcash/sdk/clients";
import {
  resolveBrowserProverAssetSource,
  type BrowserProverAssetSource,
  type SupportedSrsPoints,
} from "@pcash/sdk/browser-prover";
import { CIRCUIT_SRS_POINTS } from "@pcash/sdk/constants";
import { BROWSER_PROVER_ASSET_SET_ID } from "@pcash/sdk/constants/prover-artifacts";
import { fieldToHex, poseidon } from "@pcash/sdk/crypto";
import { toHex } from "@pcash/sdk/utils";
import type { ChonkVk, ScenarioContext } from "../scenarios/index.ts";

/**
 * Where this page gets compiled circuits, VKs, and proving parameters.
 *
 * `local` is the working-tree bundle staged by `just bench`, including test and
 * in-development circuits. `node` is the release asset set a node advertises,
 * which is what the hosted page and production browsers download.
 */
export interface LabSource {
  kind: "local" | "node";
  label: string;
  assetSource: BrowserProverAssetSource;
  rpcUrl?: string;
  bundleDigest?: string;
  /** Gate counts, known only for a local bundle. */
  gates: Readonly<Record<string, number>>;
  context: ScenarioContext;
  srsPoints(circuits: readonly string[]): SupportedSrsPoints;
  /** Why a scenario cannot run against this source, or undefined when it can. */
  unavailable(circuits: readonly string[]): string | undefined;
}

interface LocalManifest {
  bundleDigest: string;
  artifacts: string[];
  gates: Record<string, number>;
}

interface NodeManifest {
  assetSetId: string;
  artifacts: Array<{ path: string }>;
}

const circuitPath = (circuit: string) => `/prover/${circuit}.json`;
const vkPath = (circuit: string) => `/chonk-vks/${circuit}.vk`;
const g1Path = (points: number) => `/crs/${points}/bn254_g1.dat`;

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return await response.json() as T;
}

function createSource(
  kind: LabSource["kind"],
  label: string,
  assetSource: BrowserProverAssetSource,
  artifacts: ReadonlySet<string>,
  extra: Pick<LabSource, "gates"> & Partial<Pick<LabSource, "rpcUrl" | "bundleDigest">>,
): LabSource {
  const vks = new Map<string, Promise<ChonkVk>>();
  const srsPoints = (circuits: readonly string[]): SupportedSrsPoints => {
    let points = 0;
    for (const circuit of circuits) {
      const required = CIRCUIT_SRS_POINTS[circuit] ?? LINEAGE_SRS_POINTS[circuit];
      if (required === undefined) throw new Error(`circuit ${circuit} is not in the circuit catalog`);
      points = Math.max(points, required);
    }
    return points as SupportedSrsPoints;
  };
  const available = (circuit: string) => artifacts.has(circuitPath(circuit)) && artifacts.has(vkPath(circuit));
  return {
    kind,
    label,
    assetSource,
    ...extra,
    srsPoints,
    unavailable(circuits) {
      const missing = circuits.filter((circuit) => !available(circuit));
      if (missing.length > 0) return `not served by this source: ${missing.join(", ")}`;
      const points = srsPoints(circuits);
      if (!artifacts.has(g1Path(points))) return `the ${points}-point proving parameters are not served by this source`;
      return undefined;
    },
    context: {
      available,
      vk(circuit) {
        let vk = vks.get(circuit);
        if (vk === undefined) {
          const url = vkPath(circuit);
          vk = fetch(new URL(url.slice(1), assetSource.baseUrl), { credentials: "omit" }).then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            const fields = Array.from({ length: bytes.length / 32 }, (_, index) =>
              toHex(bytes.subarray(index * 32, (index + 1) * 32)));
            return { fields, hash: fieldToHex(poseidon(fields.map(BigInt))), url };
          });
          vks.set(circuit, vk);
        }
        return vk;
      },
    },
  };
}

async function localSource(): Promise<LabSource> {
  const manifest = await fetchJson<LocalManifest>(new URL("lab-source.json", window.location.href).href).catch((cause: unknown) => {
    throw new Error("this page serves no local bundle and names no node; open it with ?rpc=<node RPC URL>", { cause });
  });
  const assetSource = Object.freeze({
    assetSetId: BROWSER_PROVER_ASSET_SET_ID,
    baseUrl: new URL("./", window.location.href).href,
  });
  return createSource("local", `local bundle ${manifest.bundleDigest.slice(0, 12)}`, assetSource, new Set(manifest.artifacts), {
    gates: manifest.gates,
    bundleDigest: manifest.bundleDigest,
  });
}

async function nodeSource(rpcUrl: string): Promise<LabSource> {
  const status = await new PcashNodeClient(rpcUrl).status();
  const assetSource = resolveBrowserProverAssetSource(rpcUrl, status.proverAssets);
  const manifest = await fetchJson<NodeManifest>(new URL("manifest.json", assetSource.baseUrl).href);
  const host = new URL(rpcUrl, window.location.href).host;
  return createSource(
    "node",
    `${host} release ${assetSource.assetSetId.slice(0, 12)}`,
    assetSource,
    new Set(manifest.artifacts.map((artifact) => artifact.path)),
    { gates: {}, rpcUrl },
  );
}

/** `?rpc=` or a hosted build's configured node selects the node's assets; otherwise the local bundle. */
export function resolveLabSource(): Promise<LabSource> {
  const rpcUrl = new URLSearchParams(window.location.search).get("rpc") ?? import.meta.env.VITE_PROOF_LAB_RPC_URL;
  return rpcUrl ? nodeSource(rpcUrl) : localSource();
}
