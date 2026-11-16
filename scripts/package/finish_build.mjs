import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Config } from "../../sdk/src/bcfg/index.ts";
import { Logger } from "../../sdk/src/blgr/index.ts";

const config = new Config("pcash");
config.load({ argv: true, env: true });
const DIST = path.resolve(process.cwd(), config.str("dist", "dist"));
const BINS = config.array("bin", []);
const SHEBANG = "#!/usr/bin/env node";
const logger = new Logger("info");
await logger.open();

let changed = 0;
for (const name of BINS) {
  const file = path.join(DIST, name);
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  if (!lines[0].startsWith("#!")) {
    throw new Error(`${name} lost its shebang during compilation`);
  }
  if (lines[0] !== SHEBANG) {
    lines[0] = SHEBANG;
    writeFileSync(file, lines.join("\n"));
    changed += 1;
  }
  chmodSync(file, 0o755);
}
logger.info(`finish_build: ${changed} shebang(s) rewritten, ${BINS.length} bin(s) made executable`);
