import status from "./recorded/status.json";

/** Chain id of the recorded fixture. Kept apart from the world so config can import it without the data. */
export const FIXTURE_CHAIN_ID: number = status.pcashChainId;
