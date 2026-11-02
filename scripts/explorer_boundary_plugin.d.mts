import type { Plugin } from "vite";

export function explorerBoundaryPlugin(options: {
  repositoryRoot: string;
  webRoot: string;
  explorerEntry: string;
  requireExplorerEntry: boolean;
}): Plugin;
