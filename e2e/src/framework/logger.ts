import { Logger } from "@pcash/sdk/blgr";

/**
 * The E2E suite's one logger. It resolves through the SDK's dist output, so the
 * launcher (run.ts) must not import it before building the workspace packages.
 */
export const logger = new Logger("info");
await logger.open();
