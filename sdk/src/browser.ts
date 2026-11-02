// Browser-safe barrel: every folder listed here is free of `node:` imports,
// directly and transitively, so this entry point bundles for in-browser proving
// (@noir-lang/noir_js + @aztec-foundation/bb.js consume the witness maps from
// ./builders/ and the CHONK stack in ./prover/). It deliberately excludes the Node-only
// folders — ./node/ (fs I/O, native toolchain). This is pinned by
// test/browserBarrel.test.ts, which fails if any transitively-imported module
// reaches a `node:` specifier. The default Node entry layers ./node/ on top.
//
// Prefer the per-folder subpaths (@pcash/sdk/protocol, /clients, …) over this
// barrel: they are what let a bundler drop the layers an application never calls.

export * from "./constants/index.ts";
export * from "./crypto/index.ts";
export * from "./utils/index.ts";
export * from "./protocol/index.ts";
export * from "./eip712/index.ts";
export * from "./rules/index.ts";
export * from "./delivery/index.ts";
export * from "./builders/index.ts";
export * from "./clients/index.ts";
export * from "./l1/index.ts";
export * from "./relay/index.ts";
export * from "./source-verification/index.ts";
export * from "./prover/index.ts";
