const RELOAD_KEY = "pcash-deployment-reload";
const RELOAD_INTERVAL_MS = 10_000;

let held = false;

/** While a proof or unsent transaction would be lost, a failed chunk shows the error page instead of reloading. */
export function holdDeploymentReload(hold: boolean): void {
  held = hold;
}

/**
 * Reload after a code chunk fails to load. A tab opened before a deployment
 * still references the previous build's hashed chunks, which the host no
 * longer serves; reloading fetches the current page and its chunks. A second
 * failure soon after a reload is left to the error page, so a chunk that is
 * genuinely missing or an offline browser cannot cause a reload loop.
 */
export function reloadForCurrentDeployment(): void {
  if (held) return;
  try {
    const previous = Number(sessionStorage.getItem(RELOAD_KEY));
    if (Date.now() - previous < RELOAD_INTERVAL_MS) return;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return; // Without storage a reload loop cannot be ruled out.
  }
  location.reload();
}
