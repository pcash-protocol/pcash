import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { prepareWorktree } from "./worktree.mts";

function write(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function linkedWorktree(): { primary: string; worktree: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pcash-worktree-")));
  const primary = join(root, "primary");
  const worktree = join(root, "worktree");
  const gitDir = join(primary, ".git", "worktrees", "wt");
  write(gitDir, "commondir", "../..\n");
  write(worktree, ".git", `gitdir: ${gitDir}\n`);
  return { primary, worktree };
}

function workspace(root: string, marker: string): void {
  write(root, "package.json", JSON.stringify({
    name: "worktree-fixture", version: "1.0.0", private: true, workspaces: ["sdk", "wallet"],
  }));
  write(root, "sdk/package.json", JSON.stringify({
    name: "@pcash/sdk", version: "1.0.0", type: "module", exports: "./dist/index.js",
  }));
  write(root, "sdk/dist/index.js", `export const marker = ${JSON.stringify(marker)};\n`);
  write(root, "wallet/package.json", JSON.stringify({
    name: "@pcash/wallet", version: "1.0.0", dependencies: { "@pcash/sdk": "1.0.0" },
  }));
  write(root, "package-lock.json", JSON.stringify({
    name: "worktree-fixture", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: {
      "": { name: "worktree-fixture", version: "1.0.0", workspaces: ["sdk", "wallet"] },
      "sdk": { name: "@pcash/sdk", version: "1.0.0" },
      "wallet": { name: "@pcash/wallet", version: "1.0.0", dependencies: { "@pcash/sdk": "1.0.0" } },
      "node_modules/@pcash/sdk": { resolved: "sdk", link: true },
      "node_modules/@pcash/wallet": { resolved: "wallet", link: true },
    },
  }));
  // The fixture needs no registry packages or access to the user's npm cache.
  write(root, ".npmrc", "offline=true\naudit=false\nfund=false\ncache=.npm-cache\n");
}

test("preparation preserves existing local dependencies", () => {
  const { primary, worktree } = linkedWorktree();
  write(primary, "node_modules/marker", "primary");
  write(worktree, "node_modules/marker", "worktree");
  prepareWorktree(worktree);
  assert.equal(lstatSync(join(worktree, "node_modules")).isSymbolicLink(), false);
  assert.equal(readFileSync(join(worktree, "node_modules/marker"), "utf8"), "worktree");
});

test("preparation installs dependencies locally even when the primary has packages and tools", async () => {
  const { primary, worktree } = linkedWorktree();
  workspace(primary, "primary");
  workspace(worktree, "worktree");
  mkdirSync(join(primary, "node_modules/@pcash"), { recursive: true });
  symlinkSync("../../sdk", join(primary, "node_modules/@pcash/sdk"), "dir");
  write(primary, ".pcash-tools/installed.json", "primary tools\n");

  prepareWorktree(worktree);

  assert.equal(lstatSync(join(worktree, "node_modules")).isSymbolicLink(), false);
  const fromWallet = createRequire(join(worktree, "wallet/consumer.mjs"));
  const resolvedSdk = fromWallet.resolve("@pcash/sdk");
  assert.equal(resolvedSdk, join(worktree, "sdk/dist/index.js"));
  assert.equal((await import(pathToFileURL(resolvedSdk).href)).marker, "worktree");
  assert.equal(existsSync(join(worktree, ".pcash-tools")), false);
  assert.equal(readFileSync(join(primary, ".pcash-tools/installed.json"), "utf8"), "primary tools\n");

  write(worktree, "node_modules/installed-once", "preserved");
  prepareWorktree(worktree);
  assert.equal(readFileSync(join(worktree, "node_modules/installed-once"), "utf8"), "preserved");
});

test("preparation installs standalone dependencies without writing to stdout", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pcash-standalone-")));
  workspace(root, "standalone");
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { prepareWorktree } from ${JSON.stringify(new URL("./worktree.mts", import.meta.url).href)};
    import { createRequire } from "node:module";
    prepareWorktree(process.cwd());
    console.log(createRequire(${JSON.stringify(join(root, "wallet/consumer.mjs"))}).resolve("@pcash/sdk"));
  `], { cwd: root, encoding: "utf8" });
  assert.equal(stdout, `${join(root, "sdk/dist/index.js")}\n`);
});
