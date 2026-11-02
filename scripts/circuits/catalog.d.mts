export type CircuitRole = "application" | "kernel" | "hiding";
export type CircuitKind = "app" | "kernel" | "hiding";

export interface CircuitCatalogEntry {
  releaseId: string;
  owner: string;
  ownerRoot: string;
  packageName: string;
  packagePath: string;
  targetPath: string;
  sourceArtifactPath: string;
  artifactId: string;
  proverArtifactPath: string;
  verificationKeyPath: string;
  role: CircuitRole;
  kind: CircuitKind;
  publicInputs: number;
  provingRuntimes: Array<"native" | "browser">;
  srsPoints: number;
  dependencies: string[];
  profile: "S" | "L" | undefined;
  wrapper: string | undefined;
  fixture: boolean;
  /** Whether an external application is a callable account function. */
  contractManifest: boolean;
  /** Name of the constant in protocol_stack_hashes.nr that pins this circuit's Mega VK hash. */
  pin: string | undefined;
  /**
   * Each circuit this one folds, by its call_data bus: an account-rule application or one of the named pinned
   * circuits.
   */
  links: Array<{ callData: number; folds: "application" | string[] }>;
}

export function circuitCatalog(root?: string): CircuitCatalogEntry[];
export function circuitByReleaseId(root?: string): Record<string, CircuitCatalogEntry>;
