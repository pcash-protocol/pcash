import { globSync } from "node:fs";
import { spawnSync } from "node:child_process";

const excluded = new Set(["manifest.test.mts", "reclaimFlow.test.ts", "tokenEscrowFlows.test.mts"]);
const files = globSync("test/**/*.test.{ts,mts}").filter(file => !excluded.has(file.split("/").at(-1))).sort();
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
const reclaim = spawnSync(process.execPath, ["--test", "--test-name-pattern=^(reclaim dummy|reclaim grounding|durable reclaim state|reclaim resume)", "test/reclaimFlow.test.ts"], { stdio: "inherit" });
process.exitCode = (result.status ?? 1) || (reclaim.status ?? 1);
