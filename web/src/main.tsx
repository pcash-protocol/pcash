import { reloadForCurrentDeployment } from "./lib/deploymentReload.ts";
import { logger } from "./lib/logger.ts";
import { clearRequestedSiteData, resetDevelopmentStorage } from "./lib/siteStorage.ts";

// Vite reports every failed dynamic import here, including chunks that a newer deployment removed.
window.addEventListener("vite:preloadError", reloadForCurrentDeployment);

try {
  await clearRequestedSiteData();
  if (import.meta.env.DEV && import.meta.env.VITE_PCASH_FRESH_START) {
    await resetDevelopmentStorage(import.meta.env.VITE_PCASH_FRESH_START);
  }
  // Providers can read storage at module initialization, so import only after reset.
  await import("./renderApp.tsx");
} catch (error) {
  const root = document.getElementById("root");
  if (root) root.textContent = `Unable to start PCASH: ${error instanceof Error ? error.message : String(error)}`;
  logger.error(error);
}

export {};
