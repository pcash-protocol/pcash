import type { TestInfo } from "@playwright/test";
export function buildWebsite(testInfo: TestInfo, env: NodeJS.ProcessEnv): string;
export function stageWebsite(website: string, toolRoot: string, options?: { versioned?: boolean }): void;
