import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { fetchVerified, installToolchain } from "./bootstrap_prover_toolchain.mjs";
import { TOOLCHAIN, pinnedComponents, readToolchainReceipt, toolPaths } from "../sdk/src/node/toolchain.ts";

const scratch = mkdtempSync(join(tmpdir(), "pcash-toolchain-install-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * A tool root whose receipt and binaries are the pinned ones, without any
 * download: the binaries are stand-ins the manifest is made to pin.
 */
function pinnedRoot() {
  const root = mkdtempSync(join(scratch, "root-"));
  const paths = toolPaths(root);
  const pins = pinnedComponents();
  for (const [binary, archive] of [[paths.nargo, pins.nargo], [paths.bb, pins.barretenberg]]) {
    const pinned = Buffer.from(`the binary in ${archive.url}`);
    archive.binarySha256 = sha256(pinned);
    mkdirSync(dirname(binary), { recursive: true });
    writeFileSync(binary, pinned, { mode: 0o755 });
  }
  const receipt = Object.fromEntries(Object.entries(pins).map(([component, pin]) => [component, pin.sha256]));
  writeFileSync(paths.receipt, JSON.stringify(receipt));
  return { root, paths, receipt };
}

/** A release archive holding one `bb` that reports `version`, with that binary's bytes. */
function bbArchive(version) {
  const directory = mkdtempSync(join(scratch, "archive-"));
  const binary = Buffer.from(`#!/bin/sh\ncat <<'EOF'\n${version}\nEOF\n`);
  writeFileSync(join(directory, "bb"), binary, { mode: 0o755 });
  execFileSync("tar", ["-czf", join(directory, "bb.tar.gz"), "-C", directory, "bb"]);
  return { archive: readFileSync(join(directory, "bb.tar.gz")), binary };
}

test("fetchVerified requests and installs exactly the pinned prefix", async () => {
  const destination = join(mkdtempSync(join(scratch, "case-")), "g1.dat");
  const data = Buffer.from("test G1 points");
  const pin = { url: "https://example.test/g1.dat", bytes: data.length, sha256: sha256(data) };
  await fetchVerified(pin, destination, async (url, options) => {
    assert.equal(url, pin.url);
    assert.equal(options.headers.Range, `bytes=0-${data.length - 1}`);
    return new Response(data, { status: 206 });
  });
  assert.deepEqual(readFileSync(destination), data);
});

test("fetchVerified asks for a whole file when no prefix is pinned", async () => {
  const destination = join(mkdtempSync(join(scratch, "case-")), "g2.dat");
  const data = Buffer.from("test G2 point");
  await fetchVerified({ url: "https://example.test/g2.dat", sha256: sha256(data) }, destination, async (_url, options) => {
    assert.deepEqual(options, {});
    return new Response(data);
  });
  assert.deepEqual(readFileSync(destination), data);
});

test("fetchVerified keeps the installed file on a failed status, wrong bytes or an oversized response", async () => {
  const directory = mkdtempSync(join(scratch, "case-"));
  const destination = join(directory, "g1.dat");
  writeFileSync(destination, "existing");
  const data = Buffer.from("abcd");
  const pin = { url: "https://example.test/g1.dat", bytes: data.length, sha256: sha256(data) };
  const respond = (body, status) => async () => new Response(body, { status });
  await assert.rejects(fetchVerified(pin, destination, respond("gone", 404)), /download failed \(404\)/);
  await assert.rejects(fetchVerified(pin, destination, respond("wxyz", 206)), /digest mismatch/);
  await assert.rejects(fetchVerified(pin, destination, respond("abc", 206)), /digest mismatch/);
  await assert.rejects(fetchVerified(pin, destination, respond("abcde", 200)), /more than the 4 bytes expected/);
  assert.equal(readFileSync(destination, "utf8"), "existing");
  assert.deepEqual(readdirSync(directory), ["g1.dat"]);
});

test("a current installation is left alone and needs no network", async () => {
  const { root, receipt } = pinnedRoot();
  await installToolchain(root, async () => assert.fail("a current installation downloaded something"));
  assert.deepEqual(readToolchainReceipt(root), receipt);
});

test("a failed install drops only that component from the receipt", async () => {
  const { root, paths, receipt } = pinnedRoot();
  writeFileSync(paths.receipt, JSON.stringify({ ...receipt, bn254G2: "0".repeat(64) }));
  const requested = [];
  await assert.rejects(installToolchain(root, async (url) => {
    requested.push(url);
    return new Response("not the pinned bytes");
  }), /digest mismatch/);
  assert.deepEqual(requested, [pinnedComponents().bn254G2.url]);
  const { bn254G2: _dropped, ...others } = receipt;
  assert.deepEqual(readToolchainReceipt(root), others);
});

test("an archive is installed only when its binary is the pinned one and reports the pinned release", async (t) => {
  const { root, paths } = pinnedRoot();
  const installed = readFileSync(paths.bb);
  const pin = pinnedComponents().barretenberg;
  const original = { ...pin };
  t.after(() => Object.assign(pin, original));
  const install = ({ archive }, binarySha256) => {
    Object.assign(pin, { sha256: sha256(archive), binarySha256 });
    return installToolchain(root, async () => new Response(archive));
  };

  const release = bbArchive(TOOLCHAIN.barretenberg.version);
  await assert.rejects(
    install(release, sha256("another bb")),
    new RegExp(`binary digest mismatch for bb in .*: expected ${sha256("another bb")}, got ${sha256(release.binary)}`),
  );
  assert.deepEqual(readFileSync(paths.bb), installed);

  const mislabeled = bbArchive("0.0.0-other");
  await assert.rejects(install(mislabeled, sha256(mislabeled.binary)), /bb in .* does not report the version/);
  assert.deepEqual(readFileSync(paths.bb), installed);
  assert.equal(readToolchainReceipt(root).barretenberg, undefined);

  await install(release, sha256(release.binary));
  assert.deepEqual(readFileSync(paths.bb), release.binary);
  assert.equal(readToolchainReceipt(root).barretenberg, sha256(release.archive));
});
