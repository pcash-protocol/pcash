// Publisher-supplied source-verification input: configuration profiles, Noir
// ABIs, and bundle manifests.

import { describe, expect, it } from "vitest";
import {
  assertContractFunctionPresentationAbi,
  assertContractPresentationProfile,
  assertSourceVerificationManifest,
  canonicalAbiSha256,
  canonicalJson,
  configurationProfileCommitment,
  configurationProfileValues,
  CONTRACT_PRESENTATION_PROFILE_SCHEMA_VERSION,
  applicationVkHash,
  sha256Hex,
  sourceBundleDigest,
  SOURCE_VERIFICATION_BUNDLE_FORMAT,
  SOURCE_VERIFICATION_PROOF_PROFILE,
  SOURCE_VERIFICATION_SCHEMA_VERSION,
  validatePcashNoirAbi,
  verificationKeyFields,
  type ContractConfigurationProfile,
  type ContractFunctionPresentation,
} from "../src/source-verification/sourceVerification.ts";
import { BN254_SCALAR_MODULUS } from "../src/crypto/field.ts";
import { poseidon } from "../src/crypto/poseidon2.ts";
import { computeCircuitVkHash, VK_LEN } from "../src/protocol/account.ts";
import { field32 } from "../src/utils/bytes.ts";

const VK_HASH = `0x${"00".repeat(31)}01`;

const PROFILE: ContractConfigurationProfile = {
  id: "example-profile-v1",
  implementationLabel: "Example.run",
  selector: 0,
  scheme: "poseidon-explicit-domain-positional-v1",
  domain: `0x${"00".repeat(31)}02`,
  fields: [
    { name: "configurationSalt", type: "field" },
    { name: "deadline", type: "uint64", bits: 64 },
  ],
};

function manifest(configurationProfile: unknown): Record<string, unknown> {
  return {
    schemaVersion: SOURCE_VERIFICATION_SCHEMA_VERSION,
    bundleFormat: SOURCE_VERIFICATION_BUNDLE_FORMAT,
    proofProfile: {
      id: SOURCE_VERIFICATION_PROOF_PROFILE,
      returnFields: 4,
      returnVisibility: "databus",
    },
    implementations: [{ applicationVkHash: VK_HASH }],
    configurationBindings: [{ applicationVkHash: VK_HASH, configurationProfile }],
    configurationOpenings: [],
  };
}

describe("configurationProfileValues", () => {
  it("reads only the input's own fields, never inherited ones", () => {
    const inherited = Object.create({ deadline: 5n }) as Record<string, bigint>;
    inherited.configurationSalt = 1n;
    expect(() => configurationProfileValues(PROFILE, inherited)).toThrow(/missing example-profile-v1 field deadline/);
    expect(configurationProfileValues(PROFILE, { configurationSalt: 1n, deadline: 5n })).toEqual([1n, 5n]);
  });
});

describe("validatePcashNoirAbi", () => {
  it("rejects a null parameter with a clear error", () => {
    const field = { kind: "field" };
    const abi = {
      parameters: [{ name: "recent_pcash_block_hash", type: field, visibility: "private" }, null],
      return_type: { abi_type: { kind: "array", length: 4, type: field }, visibility: "databus" },
      error_types: {},
      abi_version: 1,
    };
    expect(() => validatePcashNoirAbi(abi)).toThrow(/parameter 1 must be an object/);
  });
});

describe("assertSourceVerificationManifest configuration profiles", () => {
  it.each([
    ["an array", []],
    ["an unsupported scheme", { ...PROFILE, scheme: "other" }],
    ["a noncanonical domain", { ...PROFILE, domain: "0x2" }],
    ["a selector out of range", { ...PROFILE, selector: 256 }],
    ["fields that are not an array", { ...PROFILE, fields: {} }],
    ["a null field", { ...PROFILE, fields: [null] }],
    ["a duplicate field", { ...PROFILE, fields: [PROFILE.fields[0], PROFILE.fields[0]] }],
    ["a uint without matching bits", { ...PROFILE, fields: [{ name: "deadline", type: "uint64", bits: 32 }] }],
    ["a uint wider than a field", { ...PROFILE, fields: [{ name: "deadline", type: "uint254", bits: 254 }] }],
    ["bits on a field", { ...PROFILE, fields: [{ name: "salt", type: "field", bits: 8 }] }],
  ])("rejects %s", (_label, profile) => {
    expect(() => assertSourceVerificationManifest(manifest(profile))).toThrow(/configurationProfile/);
  });

  it("checks the profile before looking at presentation metadata", () => {
    expect(() => assertSourceVerificationManifest(manifest(PROFILE))).toThrow(/presentation/);
  });
});

const VK_HASH_2 = `0x${"00".repeat(31)}03`;
const FIELD = { kind: "field" };

const PROFILE_2: ContractConfigurationProfile = {
  ...PROFILE,
  id: "example-profile-v1-second",
  selector: 1,
  fields: [{ name: "configurationSalt", type: "field" }],
};

function fnPresentation(
  profile: ContractConfigurationProfile,
  applicationVkHash: string,
  name: string,
): ContractFunctionPresentation {
  return {
    selector: profile.selector,
    applicationVkHash: applicationVkHash as `0x${string}`,
    name,
    summary: `Runs ${name}.`,
    configurationFields: profile.fields.map((field, position) => ({
      position,
      name: field.name,
      label: `Label ${field.name}`,
      description: `Describes ${field.name}.`,
      displayFormat: "field",
      overviewOrder: null,
    })),
    proofGroups: [{ title: "Inputs", description: "Private inputs.", items: [{ abiParameter: "amount", description: "Amount." }] }],
  };
}

function presentation(functions: ContractFunctionPresentation[]): Record<string, unknown> {
  return {
    schemaVersion: CONTRACT_PRESENTATION_PROFILE_SCHEMA_VERSION,
    publisherLabel: "Publisher",
    contractName: "Example",
    contractDescription: "An example contract.",
    functions,
  };
}

const BINDINGS = [
  { applicationVkHash: VK_HASH as `0x${string}`, configurationProfile: PROFILE },
  { applicationVkHash: VK_HASH_2 as `0x${string}`, configurationProfile: PROFILE_2 },
];

function twoFunctions(): ContractFunctionPresentation[] {
  return [fnPresentation(PROFILE, VK_HASH, "run"), fnPresentation(PROFILE_2, VK_HASH_2, "settle")];
}

function fullManifest(): Record<string, unknown> {
  return {
    ...manifest(PROFILE),
    implementations: [{ applicationVkHash: VK_HASH }, { applicationVkHash: VK_HASH_2 }],
    configurationBindings: BINDINGS,
    presentation: presentation(twoFunctions()),
  };
}

function abi(overrides: Record<string, unknown> = {}, parameters: unknown[] = [
  { name: "amount", type: FIELD, visibility: "private" },
]): Record<string, unknown> {
  return {
    parameters,
    return_type: { abi_type: { kind: "array", length: 4, type: FIELD }, visibility: "databus" },
    error_types: {},
    abi_version: 1,
    ...overrides,
  };
}

describe("canonicalJson", () => {
  it("sorts object keys recursively and keeps array order", () => {
    expect(canonicalJson({ b: [3, { z: 1, a: null }], a: "x", c: true })).toBe(
      '{"a":"x","b":[3,{"a":null,"z":1}],"c":true}',
    );
    expect(canonicalAbiSha256({ b: 1, a: 2 })).toBe(canonicalAbiSha256({ a: 2, b: 1 }));
    expect(canonicalAbiSha256({ a: 1 })).toBe(sha256Hex('{"a":1}'));
  });

  it.each([
    ["NaN", Number.NaN, /finite/],
    ["Infinity", Number.POSITIVE_INFINITY, /finite/],
    ["undefined member", { a: undefined }, /undefined at a/],
    ["bigint", 1n, /does not support bigint/],
    ["function", () => 0, /does not support function/],
    ["nested undefined array entry", [undefined], /does not support undefined/],
  ])("rejects %s", (_label, value, message) => {
    expect(() => canonicalJson(value)).toThrow(message);
  });
});

describe("sourceBundleDigest attachment paths", () => {
  const SHA = "ab".repeat(32);
  const file = (path: string, length = 1, sha256 = SHA) => ({ path, length, sha256 });

  it("is independent of listing order and binds every entry", () => {
    const a = file("src/main.nr");
    const b = file("Nargo.toml", 2);
    expect(sourceBundleDigest([a, b])).toBe(sourceBundleDigest([b, a]));
    expect(sourceBundleDigest([a, b])).not.toBe(sourceBundleDigest([a, { ...b, length: 3 }]));
    expect(sourceBundleDigest([file("a-b_c.d/e")])).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["empty", ""],
    ["parent segment", "src/../main.nr"],
    ["current segment", "./main.nr"],
    ["leading slash", "/src/main.nr"],
    ["backslash", "src\\main.nr"],
    ["empty segment", "src//main.nr"],
    ["trailing slash", "src/"],
    ["unsupported character", "src/ma in.nr"],
    ["non-ASCII", "src/mäin.nr"],
    ["overlong", "a".repeat(1025)],
  ])("rejects a %s path", (_label, path) => {
    expect(() => sourceBundleDigest([file(path)])).toThrow(/source path must be a normalized relative POSIX path/);
  });

  it("rejects duplicate paths, bad lengths, and bad digests", () => {
    expect(() => sourceBundleDigest([file("a"), file("a", 2)])).toThrow(/duplicate source path a/);
    expect(() => sourceBundleDigest([file("a", -1)])).toThrow(/invalid source length for a/);
    expect(() => sourceBundleDigest([file("a", 1.5)])).toThrow(/invalid source length for a/);
    expect(() => sourceBundleDigest([file("a", Number.MAX_SAFE_INTEGER + 1)])).toThrow(/invalid source length/);
    expect(() => sourceBundleDigest([file("a", 1, "AB".repeat(32))])).toThrow(/invalid SHA-256 for a/);
    expect(() => sourceBundleDigest([file("a", 1, "ab".repeat(31))])).toThrow(/invalid SHA-256 for a/);
  });
});

describe("validatePcashNoirAbi shape", () => {
  it("accepts private inputs of any type and a four-Field databus return", () => {
    expect(() => validatePcashNoirAbi(abi())).not.toThrow();
    expect(() => validatePcashNoirAbi(abi({}, []))).not.toThrow();
    expect(() => validatePcashNoirAbi(abi({}, [
      { name: "fee_paid", type: { kind: "boolean" }, visibility: "private" },
      { name: "recent_pcash_block_hash", type: FIELD, visibility: "private" },
    ]))).not.toThrow();
  });

  it.each([
    ["a non-object", null, /Noir ABI must be an object/],
    ["non-array parameters", { ...abi(), parameters: {} }, /parameters must be an array/],
    ["an array parameter", abi({}, [[]]), /parameter 0 must be an object/],
    ["a public parameter", abi({}, [
      { name: "recent_pcash_block_hash", type: FIELD, visibility: "private" },
      { name: "amount", type: FIELD, visibility: "public" },
    ]), /parameter 1 must be private/],
    ["a null return type", abi({ return_type: null }), /four-Field databus/],
    ["a public return", abi({ return_type: { abi_type: { kind: "array", length: 4, type: FIELD }, visibility: "public" } }), /four-Field databus/],
    ["a five-Field return", abi({ return_type: { abi_type: { kind: "array", length: 5, type: FIELD }, visibility: "databus" } }), /four-Field databus/],
    ["a non-array return", abi({ return_type: { abi_type: FIELD, visibility: "databus" } }), /four-Field databus/],
    ["a non-field return element", abi({ return_type: { abi_type: { kind: "array", length: 4, type: { kind: "integer" } }, visibility: "databus" } }), /four-Field databus/],
    ["missing error_types", abi({ error_types: undefined }), /exactly abi_version 1, parameters, return_type, and error_types/],
    ["array error_types", abi({ error_types: [] }), /exactly abi_version 1, parameters, return_type, and error_types/],
    ["an extra key", abi({ extra: 1 }), /exactly abi_version 1, parameters, return_type, and error_types/],
    ["missing abi_version", abi({ abi_version: undefined }), /exactly abi_version 1, parameters, return_type, and error_types/],
    ["another abi_version", abi({ abi_version: 2 }), /exactly abi_version 1, parameters, return_type, and error_types/],
  ])("rejects %s", (_label, value, message) => {
    expect(() => validatePcashNoirAbi(value)).toThrow(message);
  });
});

describe("assertContractFunctionPresentationAbi", () => {
  const presented = (items: string[]): ContractFunctionPresentation => ({
    ...fnPresentation(PROFILE, VK_HASH, "run"),
    proofGroups: [{ title: "Inputs", description: "d", items: items.map((abiParameter) => ({ abiParameter, description: "d" })) }],
  });
  const twoParams = abi({}, [
    { name: "amount", type: FIELD, visibility: "private" },
    { name: "recipient", type: FIELD, visibility: "private" },
  ]);

  it("accepts metadata covering every parameter once", () => {
    expect(() => assertContractFunctionPresentationAbi(presented(["recipient", "amount"]), twoParams)).not.toThrow();
  });

  it("rejects unknown, repeated, and omitted parameters", () => {
    expect(() => assertContractFunctionPresentationAbi(presented(["amount", "recipient", "other"]), twoParams))
      .toThrow(/run presentation references unknown ABI parameter other/);
    expect(() => assertContractFunctionPresentationAbi(presented(["amount", "amount"]), twoParams))
      .toThrow(/describes ABI parameter amount more than once/);
    expect(() => assertContractFunctionPresentationAbi(presented(["amount"]), twoParams))
      .toThrow(/omits ABI parameter\(s\): recipient/);
    // The chain and block witnesses are ordinary parameters the metadata must describe.
    const withContext = abi({}, [
      { name: "pcash_chain_id", type: FIELD, visibility: "private" },
      { name: "amount", type: FIELD, visibility: "private" },
    ]);
    expect(() => assertContractFunctionPresentationAbi(presented(["amount"]), withContext))
      .toThrow(/omits ABI parameter\(s\): pcash_chain_id/);
  });

  it("rejects duplicate or non-identifier ABI parameter names", () => {
    expect(() => assertContractFunctionPresentationAbi(presented(["amount"]), abi({}, [
      { name: "amount", type: FIELD, visibility: "private" },
      { name: "amount", type: FIELD, visibility: "private" },
    ]))).toThrow(/duplicate parameter amount/);
    expect(() => assertContractFunctionPresentationAbi(presented(["amount"]), abi({}, [
      { name: "1amount", type: FIELD, visibility: "private" },
    ]))).toThrow(/parameter 0 must be a Noir identifier/);
  });
});

describe("verificationKeyFields", () => {
  const vk = (fill: (index: number) => bigint) => {
    const bytes = new Uint8Array(VK_LEN * 32);
    for (let index = 0; index < VK_LEN; index++) bytes.set(field32(fill(index)), index * 32);
    return bytes;
  };

  it("splits a raw key into canonical fields and hashes them", () => {
    const raw = vk((index) => BigInt(index));
    const fields = verificationKeyFields(raw);
    expect(fields).toHaveLength(VK_LEN);
    expect(fields[7]).toBe(7n);
    expect(applicationVkHash(raw)).toBe(computeCircuitVkHash(fields));
  });

  it("rejects a wrong length and a non-canonical field", () => {
    expect(() => verificationKeyFields(new Uint8Array(VK_LEN * 32 - 1)))
      .toThrow(new RegExp(`must be ${VK_LEN} 32-byte fields \\(${VK_LEN * 32} bytes\\), got ${VK_LEN * 32 - 1}`));
    expect(() => verificationKeyFields(vk((index) => (index === 3 ? BN254_SCALAR_MODULUS : 0n))))
      .toThrow(/verification key field 3 is not canonical/);
  });
});

describe("configuration profile values and commitment", () => {
  it("bounds each value by its declared type", () => {
    expect(configurationProfileValues(PROFILE, { configurationSalt: 1n, deadline: (1n << 64n) - 1n })[1]).toBe((1n << 64n) - 1n);
    expect(() => configurationProfileValues(PROFILE, { configurationSalt: 1n, deadline: 1n << 64n }))
      .toThrow(/deadline does not fit uint64/);
    expect(() => configurationProfileValues(PROFILE, { configurationSalt: BN254_SCALAR_MODULUS, deadline: 0n }))
      .toThrow(/configurationSalt must be a BN254 scalar field element/);
    expect(() => configurationProfileValues(PROFILE, { configurationSalt: -1n, deadline: 0n }))
      .toThrow(/configurationSalt must be nonnegative/);
    expect(() => configurationProfileValues(PROFILE, { configurationSalt: 1n, deadline: 0n, extra: 0n }))
      .toThrow(/unexpected example-profile-v1 field extra/);
  });

  it("binds the domain and every field", () => {
    const commitment = configurationProfileCommitment(PROFILE, { configurationSalt: 1n, deadline: 5n });
    expect(commitment).toBe(poseidon([2n, 1n, 5n]));
    expect(configurationProfileCommitment({ ...PROFILE, domain: `0x${"00".repeat(31)}09` }, { configurationSalt: 1n, deadline: 5n }))
      .not.toBe(commitment);
    const saltless: ContractConfigurationProfile = { ...PROFILE, fields: [{ name: "deadline", type: "uint64", bits: 64 }] };
    expect(configurationProfileCommitment(saltless, { deadline: 0n })).toBe(poseidon([2n, 0n]));
  });
});

describe("assertSourceVerificationManifest", () => {
  it("accepts a complete manifest", () => {
    expect(() => assertSourceVerificationManifest(fullManifest())).not.toThrow();
  });

  const variants: [string, (m: Record<string, unknown>) => unknown, RegExp][] = [
    ["a non-object", () => null, /manifest must be an object/],
    ["a wrong schema version", (m) => ({ ...m, schemaVersion: 2 }), /unsupported source verification manifest version/],
    ["a wrong bundle format", (m) => ({ ...m, bundleFormat: "other" }), /unsupported source verification manifest version/],
    ["no implementations", (m) => ({ ...m, implementations: [] }), /must contain implementations/],
    ["non-array implementations", (m) => ({ ...m, implementations: {} }), /must contain implementations/],
    ["no configuration bindings", (m) => ({ ...m, configurationBindings: [] }), /must contain configurationBindings/],
    ["a missing proof profile", (m) => ({ ...m, proofProfile: undefined }), /wrong proof profile/],
    ["a wrong proof profile id", (m) => ({ ...m, proofProfile: { ...(m.proofProfile as object), id: "other" } }), /wrong proof profile/],
    ["a wrong return width", (m) => ({ ...m, proofProfile: { ...(m.proofProfile as object), returnFields: 5 } }), /wrong proof profile/],
    ["a public return", (m) => ({ ...m, proofProfile: { ...(m.proofProfile as object), returnVisibility: "public" } }), /wrong proof profile/],
    ["non-array openings", (m) => ({ ...m, configurationOpenings: null }), /configurationOpenings must be an array/],
    ["a non-canonical application VK hash", (m) => ({
      ...m,
      implementations: [{ applicationVkHash: VK_HASH.toUpperCase().replace("0X", "0x").replace(/1$/, "A") }],
    }), /implementations\[0\]\.applicationVkHash must be a canonical lowercase BN254 field/],
    ["an application VK hash at the modulus", (m) => ({
      ...m,
      implementations: [{ applicationVkHash: `0x${BN254_SCALAR_MODULUS.toString(16).padStart(64, "0")}` }],
    }), /implementations\[0\]\.applicationVkHash must be a canonical/],
    ["a duplicate implementation", (m) => ({
      ...m,
      implementations: [{ applicationVkHash: VK_HASH }, { applicationVkHash: VK_HASH }],
    }), /duplicate applicationVkHash/],
    ["a malformed binding hash", (m) => ({
      ...m,
      configurationBindings: [{ ...BINDINGS[0], applicationVkHash: "0x1" }, BINDINGS[1]],
    }), /configurationBindings\[0\]\.applicationVkHash must be a canonical/],
    ["a binding to an absent implementation", (m) => ({
      ...m,
      configurationBindings: [BINDINGS[0], { ...BINDINGS[1], applicationVkHash: `0x${"00".repeat(31)}04` }],
    }), /configurationBindings\[1\] names an implementation absent from the bundle/],
    ["an unbound implementation", (m) => ({ ...m, configurationBindings: [BINDINGS[0]] }),
      /every source implementation must be used by a configuration binding/],
    ["an untrimmed profile id", (m) => ({
      ...m,
      configurationBindings: [{ ...BINDINGS[0], configurationProfile: { ...PROFILE, id: " x" } }, BINDINGS[1]],
    }), /configurationProfile\.id must be nonempty, trimmed display text/],
    ["a non-identifier field name", (m) => ({
      ...m,
      configurationBindings: [{ ...BINDINGS[0], configurationProfile: { ...PROFILE, fields: [{ name: "a-b", type: "field" }] } }, BINDINGS[1]],
    }), /fields\[0\]\.name must be a Noir identifier/],
    ["a uint0 field", (m) => ({
      ...m,
      configurationBindings: [{ ...BINDINGS[0], configurationProfile: { ...PROFILE, fields: [{ name: "a", type: "uint0", bits: 0 }] } }, BINDINGS[1]],
    }), /must be a field or a uintN of at most 253 bits/],
    ["a missing presentation", (m) => ({ ...m, presentation: undefined }), /contract presentation profile must be an object/],
  ];

  it.each(variants)("rejects %s", (_label, mutate, message) => {
    expect(() => assertSourceVerificationManifest(mutate(fullManifest()))).toThrow(message);
  });

  it("accepts a uint253 configuration field, the widest that fits a field", () => {
    const wide: ContractConfigurationProfile = { ...PROFILE, fields: [{ name: "wide", type: "uint253", bits: 253 }] };
    const m = fullManifest();
    m.configurationBindings = [{ applicationVkHash: VK_HASH, configurationProfile: wide }, BINDINGS[1]];
    m.presentation = presentation([fnPresentation(wide, VK_HASH, "run"), fnPresentation(PROFILE_2, VK_HASH_2, "settle")]);
    expect(() => assertSourceVerificationManifest(m)).not.toThrow();
  });
});

describe("assertContractPresentationProfile", () => {
  const check = (functions: ContractFunctionPresentation[], extra: Record<string, unknown> = {}) => () =>
    assertContractPresentationProfile({ ...presentation(functions), ...extra }, BINDINGS);
  const withFirst = (patch: Partial<ContractFunctionPresentation>) => {
    const [first, second] = twoFunctions();
    return [{ ...first!, ...patch }, second!];
  };
  const withField = (position: number, patch: Record<string, unknown>) => {
    const [first, second] = twoFunctions();
    const configurationFields = first!.configurationFields.map((field, index) => (index === position ? { ...field, ...patch } : field));
    return [{ ...first!, configurationFields } as ContractFunctionPresentation, second!];
  };

  it("accepts a presentation bound to the ordered implementations", () => {
    expect(check(twoFunctions())).not.toThrow();
  });

  it.each([
    ["an array", () => assertContractPresentationProfile([], BINDINGS), /must be an object/],
    ["a wrong version", check(twoFunctions(), { schemaVersion: 2 }), /unsupported contract presentation profile version/],
    ["an empty publisher", check(twoFunctions(), { publisherLabel: "" }), /presentation\.publisherLabel must be nonempty/],
    ["an untrimmed name", check(twoFunctions(), { contractName: "Example " }), /presentation\.contractName must be nonempty/],
    ["a control character", check(twoFunctions(), { contractDescription: "bad\u0007" }), /presentation\.contractDescription/],
    ["an overlong description", check(twoFunctions(), { contractDescription: "x".repeat(2_001) }), /at most 2000 characters/],
    ["a missing function", check(twoFunctions().slice(0, 1)), /must cover every implementation exactly once/],
    ["swapped function order", check(twoFunctions().reverse()), /selectors must be strictly increasing|does not match its implementation/],
    ["a null function", check([null as unknown as ContractFunctionPresentation, twoFunctions()[1]!]), /functions\[0\] must be an object/],
    ["a selector out of range", check(withFirst({ selector: 300 })), /functions\[0\]\.selector must be an integer from 0 to 255/],
    ["a selector mismatch", check(withFirst({ selector: 0 }).map((fn, i) => (i === 1 ? { ...fn, selector: 2 } : fn))),
      /functions\[1\]\.selector does not match its implementation/],
    ["a malformed VK hash", check(withFirst({ applicationVkHash: "0x01" })), /functions\[0\]\.applicationVkHash must be a canonical/],
    ["a VK hash mismatch", check(withFirst({ applicationVkHash: VK_HASH_2 as `0x${string}` })),
      /functions\[0\]\.applicationVkHash does not match its implementation/],
    ["a non-identifier name", check(withFirst({ name: "run it" })), /functions\[0\]\.name must be a Noir identifier/],
    ["a duplicate name", check(withFirst({ name: "settle" })), /duplicate presentation function name settle/],
    ["an overlong summary", check(withFirst({ summary: "x".repeat(501) })), /functions\[0\]\.summary/],
    ["a missing configuration field", check(withFirst({ configurationFields: [] })),
      /configurationFields must cover the configuration profile exactly/],
    ["a null configuration field", check(withFirst({ configurationFields: [null as never, twoFunctions()[0]!.configurationFields[1]!] })),
      /configurationFields\[0\] must be an object/],
    ["a wrong position", check(withField(1, { position: 0 })), /configurationFields\[1\]\.position must be 1/],
    ["a renamed field", check(withField(1, { name: "expiry" })), /configurationFields\[1\]\.name does not match the configuration profile/],
    ["an empty label", check(withField(0, { label: "" })), /configurationFields\[0\]\.label/],
    ["an unsupported display format", check(withField(0, { displayFormat: "percent" })), /displayFormat is unsupported/],
    ["a negative overview order", check(withField(0, { overviewOrder: -1 })), /overviewOrder must be null or a nonnegative integer/],
    ["a fractional overview order", check(withField(0, { overviewOrder: 0.5 })), /overviewOrder must be null or a nonnegative integer/],
    ["a duplicate overview order", check(withField(0, { overviewOrder: 0 }).map((fn, i) => (i === 0
      ? { ...fn, configurationFields: fn.configurationFields.map((field) => ({ ...field, overviewOrder: 0 })) }
      : fn))), /duplicate overviewOrder 0/],
    ["a sparse overview order", check(withField(0, { overviewOrder: 1 })), /overviewOrder values must be dense from zero/],
    ["no proof groups", check(withFirst({ proofGroups: [] })), /proofGroups must not be empty/],
    ["a null proof group", check(withFirst({ proofGroups: [null as never] })), /proofGroups\[0\] must be an object/],
    ["a duplicate group title", check(withFirst({ proofGroups: [
      { title: "Inputs", description: "a", items: [{ abiParameter: "a", description: "a" }] },
      { title: "Inputs", description: "b", items: [{ abiParameter: "b", description: "b" }] },
    ] })), /duplicate proof group title Inputs/],
    ["an empty group", check(withFirst({ proofGroups: [{ title: "Inputs", description: "a", items: [] }] })),
      /proofGroups\[0\]\.items must not be empty/],
    ["a null item", check(withFirst({ proofGroups: [{ title: "Inputs", description: "a", items: [null as never] }] })),
      /items\[0\] must be an object/],
    ["a non-identifier ABI parameter", check(withFirst({ proofGroups: [{ title: "Inputs", description: "a", items: [{ abiParameter: "0x", description: "a" }] }] })),
      /items\[0\]\.abiParameter must be a Noir identifier/],
    ["an empty item description", check(withFirst({ proofGroups: [{ title: "Inputs", description: "a", items: [{ abiParameter: "a", description: "" }] }] })),
      /items\[0\]\.description/],
  ])("rejects %s", (_label, run, message) => {
    expect(run).toThrow(message);
  });

  it("accepts dense overview orders across functions", () => {
    const [first, second] = twoFunctions();
    const functions = [
      { ...first!, configurationFields: first!.configurationFields.map((field, index) => ({ ...field, overviewOrder: index === 0 ? 1 : null })) },
      { ...second!, configurationFields: second!.configurationFields.map((field) => ({ ...field, overviewOrder: 0 })) },
    ];
    expect(check(functions)).not.toThrow();
  });
});
