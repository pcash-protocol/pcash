import { globSync } from "node:fs";
import { spawnSync } from "node:child_process";

const excluded = new Set(["application.proving.test.ts"]);
const files = globSync("test/**/*.test.{ts,mts}").filter(file => !excluded.has(file.split("/").at(-1))).sort();
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
