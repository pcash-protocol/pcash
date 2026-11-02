import type { Connect } from "vite";
import type { BrowserProverAssetPlan } from "../../scripts/circuits/browser_assets.mjs";

export {
  BROWSER_SRS_POINTS,
  resolveBrowserProverAssets,
  stageBrowserProverAssets,
} from "../../scripts/circuits/browser_assets.mjs";

export function browserProverAssetsMiddleware(plan: BrowserProverAssetPlan, prefix?: string): Connect.NextHandleFunction;
