import { createMempoolSubmissionAdapter } from "@pcash/sdk/wallet";
import type { BrowserL1Options } from "@pcash/sdk/wallet/web";

type WalletWeb = typeof import("@pcash/sdk/wallet/web");

/**
 * The browser wallet's two publication paths. Every action is relayed through
 * the node mempool by default; posting to Ethereum from the connected wallet
 * happens only when a caller explicitly passes `selfPublication`.
 */
export function browserPublication(
  web: Pick<WalletWeb, "createBrowserL1SubmissionAdapter">,
  options: BrowserL1Options,
) {
  return {
    submission: createMempoolSubmissionAdapter(options.node),
    selfPublication: web.createBrowserL1SubmissionAdapter({ ...options, includeMempool: true }),
  };
}
