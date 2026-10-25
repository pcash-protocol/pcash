export interface BrowserProverAsset {
  readonly logicalPath: string;
  readonly source: string;
  readonly size: number;
}

export interface BrowserProverArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface BrowserProverManifest {
  readonly version: 1;
  readonly assetSetId: string;
  readonly artifacts: readonly BrowserProverArtifact[];
}

export interface BrowserProverAssetPlan {
  readonly assets: readonly BrowserProverAsset[];
  readonly bundleRoot: string;
  readonly toolRoot: string;
  readonly byLogicalPath: ReadonlyMap<string, BrowserProverAsset>;
}

export const BROWSER_SRS_POINTS: readonly number[];
export function resolveBrowserProverAssets(options: {
  readonly bundle?: string | undefined;
  readonly toolRoot: string;
  readonly required?: boolean | undefined;
}): BrowserProverAssetPlan | undefined;
export function canonicalBrowserProverManifestPayload(artifacts: readonly BrowserProverArtifact[]): string;
export function createBrowserProverManifest(plan: BrowserProverAssetPlan): BrowserProverManifest;
export function stageBrowserProverAssets(plan: BrowserProverAssetPlan, destination: string): void;
export function exportBrowserProverAssetSet(
  plan: BrowserProverAssetPlan,
  publicRoot: string,
  expectedManifest: BrowserProverManifest,
): { readonly manifest: BrowserProverManifest; readonly output: string };
