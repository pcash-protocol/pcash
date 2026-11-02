/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The node a hosted build proves against; empty for the local bundle. */
  readonly VITE_PROOF_LAB_RPC_URL: string;
  /** "1" when the serving machine saves posted results. */
  readonly VITE_PROOF_LAB_SAVES_RESULTS: string;
}
