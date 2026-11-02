# Provenance

Every file adapted from another repository is recorded here as `<dest> ← <source-repo>:<path> @ <sha>`.

## Solidity dependencies

`forge-std` is not vendored. Each Solidity project installs it with Soldeer into an ignored `dependencies/` directory, pinned by its `soldeer.lock` to `1.16.2` with a recorded archive checksum, and used under that project's MIT/Apache-2.0 license. Retrieve it with `just setup`, or `forge soldeer install --config-location foundry` from the project directory.

## Circuits / SDK

Imported files retain source-path and revision attribution in their headers or adjacent manifests.

`circuits/vendor/poseidon/` and `circuits/vendor/keccak256/` are **pruned, locally edited extracts** of upstream Noir libraries. They are vendored rather than fetched as Git dependencies so that a build never needs the network. Each is recorded below with its exact upstream commit, the files retained, and every local edit, so the vendored source can be reproduced from upstream.

### `circuits/vendor/poseidon`

Upstream `https://github.com/noir-lang/poseidon`, tag `v0.3.0`, commit `0880c371e88e583d39515fd3f877538657ac41eb`, Apache License 2.0 (the retained `LICENSE`).

Retained: `Nargo.toml` and `LICENSE`, both byte-for-byte upstream, and `src/poseidon2.nr`, edited below.

Local edits:
- `src/poseidon2.nr` keeps only `Poseidon2::hash` and the `hash_internal` it calls. Removed: the `Poseidon2` sponge fields and its `new`, `perform_duplex`, `absorb`, and `squeeze`, and `Poseidon2Hasher` with its `Hasher` and `Default` impls. Nothing used them, and `Poseidon2Hasher` re-absorbs stale cache lanes, so for more than three inputs that are not a multiple of three it differs from the sponge `hash` computes.
- `src/lib.nr` is rewritten to declare only `poseidon2` and re-export `std::hash::poseidon2_permutation`.
- Removed `src/poseidon/` (the Poseidon-1 implementation and its BN254 round-constant table) and the library's own `src/{tests,oracle_tests,bench}.nr`. First-party code imports only `poseidon::poseidon2::Poseidon2`, and `poseidon2.nr` delegates to the Noir standard-library permutation, so nothing under `src/poseidon/` is reachable.
- Removed upstream release and CI tooling: `.github/`, `scripts/`, `CHANGELOG.md`, `CONTRIBUTING.md`, `README.md`, release-please configs, `package.json`, `tsconfig.json`, `yarn.lock`, `oracle_server.ts`, `.gitignore`.

### `circuits/vendor/keccak256`

Upstream `https://github.com/noir-lang/keccak256`, tag `v0.1.2`, commit `47d8cf8df8d68b6bce5ee18cdd5f06a4b6556c6d`.

License: the upstream repository publishes no license file. Its README describes the package as the Keccak256 hashing interface "formerly in the Noir standard library", and `https://github.com/noir-lang/noir` licenses that library under MIT OR Apache-2.0. The vendored code is used on that basis.

Retained: `Nargo.toml` and `src/lib.nr`, both byte-for-byte upstream.

Local edits:
- `src/keccak256.nr` is upstream with its three leading `mod tests; mod oracle_tests; mod benchmarks;` declarations removed. Nothing in the module body references them.
- Removed `src/keccak256/{tests,oracle_tests,benchmarks}.nr` and the same upstream release and CI tooling listed above.

The upstream suite never ran here: the vendored packages are path dependencies, not members of `circuits/Nargo.toml`, so `nargo test --workspace` never executed them. `circuits/signature/src/keccak_boundary.nr` replaces that coverage with a first-party known-answer gate that does run, exercising the 136-byte rate boundary at lengths 0, 1, 134, 135, 136, 137, and 200.

### `sdk/src/bcfg`

Upstream `https://github.com/bcoin-org/bcfg`, tag `v0.2.2`, commit `2f49d5a84dbed5653bfe7fe90da32273f3a53056`, MIT License.

Retained: `LICENSE`, byte-for-byte upstream. The TypeScript modules are ports of `lib/bcfg.js` (`index.ts`), `lib/config.js` (`config.ts`), and `lib/fs.js` with `lib/fs-browser.js` (`fs.ts`); each keeps its upstream header.

Local edits:
- CommonJS became ES modules with TypeScript types. `module.exports = Config` became the named export `Config`, and its fields are declared. Each typed getter gains overload signatures so a call with a fallback returns the fallback's type rather than `null`; the getter bodies are unchanged. The remaining edits are the non-null assertions and parameter types strict mode requires.
- The package.json `browser` field no longer swaps modules. `fs.ts` and `config.ts` resolve `node:fs`, `node:path`, and `node:os` through `process.getBuiltinModule`, so the folder has no static `node:` import; without it `fs.unsupported` is true and the home directory is `/`. `process` is read through `globalThis.process`, and `global.location` became `globalThis.location`.
- `bsert` is replaced by a local `assert`. `fs.ts` exports only `readFileSync` and `unsupported`.
- Removed upstream tooling: `package.json`, `package-lock.json`, `tsconfig.json`, `.eslintrc.json`, `.github/`, `.gitignore`, `.npmignore`, `README.md`. `test/bcfg-test.js` is ported to `sdk/test/bcfg.test.ts`.

### `sdk/src/blgr`

Upstream `https://github.com/bcoin-org/blgr`, tag `v0.2.1`, commit `ee753fd383fb465fdb5c7b98265c5dee9ff3f1e7`, MIT License.

Retained: `LICENSE`, byte-for-byte upstream. The TypeScript modules are ports of `lib/blgr.js` (`index.ts`), `lib/logger.js` (`logger.ts`), `lib/format.js` (`format.ts`), `lib/inspect.js` with `lib/inspect-browser.js` (`inspect.ts`), and `lib/fs.js` with `lib/fs-browser.js` (`fs.ts`); each keeps its upstream header.

Local edits:
- CommonJS became ES modules with TypeScript types. `Logger`'s static tables became static class fields, and the undeclared `timer` field is declared.
- The package.json `browser` field no longer swaps modules. `fs.ts`, `inspect.ts`, and `logger.ts` resolve `node:fs`, `node:util`, and `node:path` through `process.getBuiltinModule` and fall back to upstream's browser behaviour when it is absent, so the folder has no static `node:` import. `process` is read through `globalThis.process`.
- `bsert` is replaced by a local `assert`.
- `fs.ts` uses `fs.promises` in place of upstream's hand-rolled `promisify`, and drops the `open`, `close`, `read`, `write`, `ftruncate`, and `mkdir` exports the logger never used.
- `format.ts` hex-encodes any `Uint8Array` for `%x`/`%h` rather than testing `Buffer.isBuffer`.
- `Logger.global` is removed.
- `Logger#raw` and `LoggerContext#raw` are added: program output written to stdout without a prefix, regardless of level, open state, or log file.
- Removed upstream tooling: `package.json`, `package-lock.json`, `tsconfig.json`, `.eslintrc.json`, `.github/`, `.gitignore`, `.npmignore`, `README.md`. `test/logger-test.js` is ported to `sdk/test/blgr.test.ts`.

## Reference proof-stack pins

The reference node and SDK are qualified against Barretenberg `6.0.0`. The CRS digests that release's verifier depends on are pinned in [protocol spec §16](docs/protocol-spec.md#16-proof-system-release).

## Issuance arithmetic dependencies

`pcash-issuance` pins Rug `1.30.0` with integer arithmetic only, built from the GMP `6.3.0` sources bundled in `gmp-mpfr-sys` `1.7.1`. Their Cargo archive checksums are recorded in `Cargo.lock`. The build uses the bundled library with upstream library tests enabled; it does not select system libraries or skip those tests. Issuance arithmetic is exact integer arithmetic, so its results do not depend on the GMP version. The numeric conformance job builds debug and release with Rust `1.94.1` on Linux and macOS, on both ARM64 and x86-64. A target's known-answer results must match `vectors/issuance.json` exactly.

The issuance multiplier's fractional kernel is the cubic of the Bitcoin Cash `aserti3-2d` difficulty algorithm (specification v0.6, 2020-08-12; Bitcoin Cash Node commit `1a79646efa3bca9bd9ad1cc93670900f5f5e573a`), with its coefficients, rounding constant, and operation order unchanged. These sources are provenance only; the protocol specification and `vectors/issuance.json` are authoritative.

Rug and `gmp-mpfr-sys` declare `LGPL-3.0+`; their licenses and that of the bundled GMP remain applicable alongside this repository's own license. The pinned build links GMP statically. The Cargo source archives contain the upstream license files.
