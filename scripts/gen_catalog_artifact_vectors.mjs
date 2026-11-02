// Generate the catalog content-ID conformance vectors:
//   vectors/catalog_artifact.json — CatalogArtifact preimages and content IDs
//
// These are transport conformance data for the optional publication catalog. They
// are NOT part of the consensus identity or circuit-release pipeline: nothing here
// feeds a state root, a domain tag, a verifying key, or genesis identity.
//
// Run: node scripts/gen_catalog_artifact_vectors.mjs [--check]

import { keccak_256 } from "@noble/hashes/sha3.js";
import { runGenerator } from "./generated_files.mjs";

const DOMAIN = "PCASH_CATALOG_ARTIFACT";
const NAMESPACE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MARKETPLACE_NAMESPACE = "pcash.marketplace.offer.v1";

const utf8 = (value) => new TextEncoder().encode(value);
const bytesHex = (value) => `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
const u16be = (value) => Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
const u32be = (value) => Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
const concat = (...parts) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** The exact CatalogArtifact content-ID preimage. Mirrored in Rust and the SDK. */
function preimage({ namespace, pcashChainId, payload }) {
  if (!NAMESPACE_RE.test(namespace)) throw new Error(`bad namespace: ${namespace}`);
  const namespaceBytes = utf8(namespace);
  if (namespaceBytes.length !== namespace.length) throw new Error("namespace must be ASCII under the syntax rule");
  if (!Number.isInteger(pcashChainId) || pcashChainId < 0 || pcashChainId > 0xffff_ffff) {
    throw new Error(`pcashChainId must be a u32: ${pcashChainId}`);
  }
  return concat(
    utf8(DOMAIN),
    u32be(pcashChainId),
    u16be(namespaceBytes.length),
    namespaceBytes,
    u32be(payload.length),
    payload,
  );
}

// An ordinary marketplace publication: the exact shape @pcash/marketplace
// serializes, with short deterministic field values so the vector file stays small.
const MARKETPLACE_PAYLOAD = JSON.stringify({
  version: 1,
  chainId: "0x0000000000000000000000000000000000000000000000000000000000000001",
  terms: {
    router: "0x00000000000000000000000000000000000000000000000000000000000000a1",
    seller: "0x00000000000000000000000000000000000000000000000000000000000000b2",
    id: "0x0000000000000000000000000000000000000000000000000000000000000007",
    pcashAmount: "0x00000000000000000000000000000000000000000000000000000000000f4240",
    ethPriceWei: "0x00000000000000000000000000000000000000000000000000038d7ea4c68000",
    deadlineT: "0x0000000000000000000000000000000000000000000000000000000068b3c1e0",
  },
  l2Contract: {
    address: "0x00000000000000000000000000000000000000000000000000000000000000c3",
    functionSetCommitment: "0x00000000000000000000000000000000000000000000000000000000000000e5",
    nkRoot: "0x00000000000000000000000000000000000000000000000000000000000000f6",
    bodyHex: "0x0102030405",
    mlKemPublicKeyHex: "0x",
    functions: {
      claim: {
        selector: 1,
        applicationVkHash: "0x0000000000000000000000000000000000000000000000000000000000000011",
        configurationCommitment: "0x0000000000000000000000000000000000000000000000000000000000000012",
        commitmentBlinder: "0x0000000000000000000000000000000000000000000000000000000000000013",
        functionSiblings: ["0x1", "0x2", "0x3", "0x4", "0x5", "0x6", "0x7", "0x8"],
      },
      reclaim: {
        selector: 2,
        applicationVkHash: "0x0000000000000000000000000000000000000000000000000000000000000021",
        configurationCommitment: "0x0000000000000000000000000000000000000000000000000000000000000022",
        commitmentBlinder: "0x0000000000000000000000000000000000000000000000000000000000000023",
        functionSiblings: ["0x1", "0x2", "0x3", "0x4", "0x5", "0x6", "0x7", "0x8"],
      },
    },
  },
  reclaimAuthority: "0x00000000000000000000000000000000000000000000000000000000000000b2",
  reclaimDelta: "0x1e",
});

// A one-byte payload mutation: flip the final `deadlineT` nibble pair inside the
// serialized publication. Same length, one differing byte.
const MUTATED_MARKETPLACE_PAYLOAD = MARKETPLACE_PAYLOAD.replace("0x0000000000000000000000000000000000000000000000000000000068b3c1e0", "0x0000000000000000000000000000000000000000000000000000000068b3c1e1");
if (MUTATED_MARKETPLACE_PAYLOAD === MARKETPLACE_PAYLOAD) throw new Error("payload mutation did not apply");

const MAX_NAMESPACE = `n${"0123456789.-_".repeat(6)}0123456789.-_0123456`.slice(0, 64);
if (MAX_NAMESPACE.length !== 64 || !NAMESPACE_RE.test(MAX_NAMESPACE)) {
  throw new Error(`max-length namespace fixture is wrong: ${MAX_NAMESPACE.length} ${MAX_NAMESPACE}`);
}

const CASES = [
  {
    name: "marketplace-offer",
    note: "An ordinary marketplace publication under the shipped namespace.",
    namespace: MARKETPLACE_NAMESPACE,
    pcashChainId: 1,
    payload: utf8(MARKETPLACE_PAYLOAD),
  },
  {
    name: "mutated-payload",
    note: "The marketplace publication with exactly one payload byte changed.",
    namespace: MARKETPLACE_NAMESPACE,
    pcashChainId: 1,
    payload: utf8(MUTATED_MARKETPLACE_PAYLOAD),
  },
  {
    name: "mutated-namespace",
    note: "The marketplace publication under a namespace differing by one byte.",
    namespace: "pcash.marketplace.offer.w1",
    pcashChainId: 1,
    payload: utf8(MARKETPLACE_PAYLOAD),
  },
  {
    name: "mutated-chain-id",
    note: "The marketplace publication bound to a different PCASH chain ID.",
    namespace: MARKETPLACE_NAMESPACE,
    pcashChainId: 2,
    payload: utf8(MARKETPLACE_PAYLOAD),
  },
  {
    name: "empty-payload",
    note: "A zero-byte payload still produces a well-defined content ID.",
    namespace: MARKETPLACE_NAMESPACE,
    pcashChainId: 1,
    payload: new Uint8Array(0),
  },
  {
    name: "min-namespace",
    note: "The shortest legal namespace.",
    namespace: "a",
    pcashChainId: 1,
    payload: utf8("payload"),
  },
  {
    name: "max-namespace",
    note: "A 64-byte namespace, the longest the syntax rule allows.",
    namespace: MAX_NAMESPACE,
    pcashChainId: 1,
    payload: utf8("payload"),
  },
  {
    name: "namespace-prefix-sibling",
    note: "A namespace that is a byte-prefix of another; the length prefix keeps the two preimages distinct.",
    namespace: "a.b",
    pcashChainId: 1,
    payload: utf8("payload"),
  },
  {
    name: "max-chain-id",
    note: "The largest u32 PCASH chain ID.",
    namespace: MARKETPLACE_NAMESPACE,
    pcashChainId: 0xffff_ffff,
    payload: utf8("payload"),
  },
  {
    name: "non-utf8-payload",
    note: "Payloads are opaque bytes; nothing requires them to be text.",
    namespace: MARKETPLACE_NAMESPACE,
    pcashChainId: 1,
    payload: Uint8Array.of(0x00, 0xff, 0xfe, 0x80, 0x7f, 0x01),
  },
];

const cases = CASES.map((entry) => ({
  name: entry.name,
  note: entry.note,
  namespace: entry.namespace,
  pcashChainId: entry.pcashChainId,
  payload: bytesHex(entry.payload),
  contentId: bytesHex(keccak_256(preimage(entry))),
}));

const distinct = new Set(cases.map((entry) => entry.contentId));
if (distinct.size !== cases.length) throw new Error("content IDs must be distinct across vectors");

// One fully expanded preimage, so a cross-language mismatch can be localised to a
// framing field instead of the hash. Every case's preimage follows the same rule;
// repeating them all would quadruple the file for no extra coverage.
const exampleSource = CASES.find((entry) => entry.name === "non-utf8-payload");
const example = {
  case: exampleSource.name,
  preimage: bytesHex(preimage(exampleSource)),
};

const output = {
  note: "CatalogArtifact content-ID conformance vectors. Transport data only: not consensus identity, not a circuit-release input.",
  domain: DOMAIN,
  namespaceSyntax: "^[a-z0-9][a-z0-9._-]{0,63}$",
  preimageRule: "ASCII(domain) || u32_be(pcashChainId) || u16_be(namespaceLen) || namespace || u32_be(payloadLen) || payload",
  contentIdRule: "keccak256(preimage)",
  preimageExample: example,
  cases,
};

export const outputs = new Map([["vectors/catalog_artifact.json", `${JSON.stringify(output, null, 2)}\n`]]);
await runGenerator(import.meta, outputs);
