import { Logger } from "@pcash/sdk/blgr";

export const logger = new Logger(import.meta.env.DEV ? "debug" : "error");
// Without a log file, open() marks the logger open before it first awaits.
void logger.open();
