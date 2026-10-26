// Noir entry points for the circuits whose manifest entry names a `wrapper`.
// Each is a thin `main` over one library relation at one private-value
// profile. Each role has its own template, so its databus and public-input
// boundary stays visible:
//   application  returns the rule statement as return_data;
//   kernel       reads each folded rule statement from call_data(n), verifies the
//                event application after the rules, and returns the
//                transaction statement;
//   hiding       reads the kernel statement from call_data(0), accepts only
//                the pinned kernel keys, and binds the statement to the public
//                inputs.
// An entry point declares its parameters once; the `main` parameter list and
// the argument list are both derived from that declaration.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { generatedHeader } from "../generated_files.mjs";
import { array, call, noirStatement, noirUses } from "../noir_layout.mjs";
import { PROFILE_SOURCE } from "./profile_config.mjs";
import { privateValuePublicInputNames } from "../../sdk/src/protocol/witness.ts";
import { assetCreationEip712TypeFor, batchTransferEip712TypeFor } from "../../sdk/src/rules/semanticRuleTypes.ts";

const GENERATOR = "scripts/circuits/gen_constants.mjs";

// The module of every type a generated parameter names.
const TYPE_MODULES = {
  AppVerificationKey: "pcash_protocol::recursion",
  AssetNamespaceOpening: "reference_rule_common::value_rule",
  AuthorizedAccount: "pcash_protocol::authorization::authentication",
  Configuration: "reference_rule_common::configuration",
  InputNoteWitness: "pcash_protocol::primitives::types",
  KernelVerificationKey: "pcash_protocol::recursion",
  NativeChange: "pcash_protocol::ledger::fee_payment",
  NativeRelayOutput: "pcash_protocol::ledger::fee_payment",
  OutputDeclaration: "reference_rule_common::value_rule",
  Secp256k1PubKey: "signature_common::secp256k1",
  Signature: "signature_common::secp256k1",
  PrivateValue: "pcash_protocol::ledger::private_value",
  PrivateValueChoices: "pcash_protocol::ledger::private_value",
};
// The module of every protocol global a generated parameter type names.
const GLOBAL_MODULES = {
  EVENT_STATEMENT_LENGTH: "pcash_protocol::events",
  RULE_STATEMENT_LENGTH: "pcash_protocol::authorization::statement",
  BLOCK_HEADER_TREE_DEPTH: "pcash_protocol::primitives::params",
  STATE_TREE_DEPTH: "pcash_protocol::primitives::params",
};
const PROFILE_MODULE = "pcash_protocol::generated::private_value_profiles";
const PINS_MODULE = "pcash_protocol::generated::protocol_stack_hashes";
const TYPE_HASH_MODULE = "reference_rule_common::generated::reference_rule_constants";

// Size tokens in parameter types, replaced by the profile's constants.
const SIZE_CONSTANTS = { N_IN: "INPUTS", N_OUT: "OUTPUTS", SHAPE: "SHAPE_ID", PUBLIC_INPUTS: "PUBLIC_INPUTS" };

/** One entry-point parameter. */
const param = (name, type, { comment } = {}) => ({ name, type, comment });

// The output and account roots under the recent header's state root.
const stateOpeningParams = [
  param("block_header_state_siblings", "[Field; BLOCK_HEADER_TREE_DEPTH]"),
  param("output_root", "Field"),
  param("state_output_siblings", "[Field; STATE_TREE_DEPTH]"),
  param("account_state_root", "Field"),
  param("state_account_siblings", "[Field; STATE_TREE_DEPTH]"),
];

// What every reference rule opens before its own fields: the chain and block
// it binds into its statement, and its configuration and signer.
const ruleOpeningParams = [
  param("pcash_chain_id", "Field"),
  param("recent_pcash_block_hash", "Field"),
  param("configuration", "Configuration"),
  param("signature", "Signature"),
  param("pubkey", "Secp256k1PubKey"),
  param("nk_root", "Field"),
];

const APPLICATIONS = {
  batch_transfer: {
    typeHash: (profile) => batchTransferEip712TypeFor(profile.outputs),
    params: [
      ...ruleOpeningParams,
      param("asset_id", "Field", { comment: ["Signed message fields."] }),
      param("outputs", "[OutputDeclaration; N_OUT]"),
      param("issuance_recipient", "Field"),
      param("relay_fee_amount", "Field"),
      param("relay_fee_owner_commitment", "Field"),
      param("private_value", "PrivateValue<N_IN, N_OUT, SHAPE>", { comment: [
        "Private openings. Note secrets are witnessed for directed slots only;",
        "owner change derives its secret in-circuit.",
      ] }),
      param("issuance_note_secret", "Field"),
      param("output_note_secrets", "[Field; N_OUT]"),
      param("owner_change_amounts", "[Field; N_OUT]"),
      param("asset_namespace_opening", "AssetNamespaceOpening"),
    ],
  },
  asset_creation: {
    typeHash: (profile) => assetCreationEip712TypeFor(profile.outputs),
    params: [
      ...ruleOpeningParams,
      param("metadata_commitment", "Field", { comment: ["Signed message fields; the rule derives the signed asset ID."] }),
      param("initial_supply", "Field"),
      param("asset_secret_commitment", "Field"),
      param("outputs", "[OutputDeclaration; N_OUT]"),
      param("issuance_recipient", "Field"),
      param("relay_fee_amount", "Field"),
      param("relay_fee_owner_commitment", "Field"),
      param("private_value", "PrivateValue<N_IN, N_OUT, SHAPE>", { comment: ["Private openings."] }),
      param("issuance_note_secret", "Field"),
      param("output_note_secrets", "[Field; N_OUT]"),
      param("owner_change_amounts", "[Field; N_OUT]"),
    ],
  },
  contract_fee_sponsorship: {
    params: [
      ...ruleOpeningParams,
      param("sponsored_contract", "Field", { comment: ["Signed message fields."] }),
      param("issuance_recipient", "Field"),
      param("relay_fee_amount", "Field"),
      param("relay_fee_owner_commitment", "Field"),
      param("native_change_amount", "Field", { comment: ["Private openings."] }),
      param("private_value", "PrivateValue<N_IN, N_OUT, SHAPE>"),
      param("issuance_note_secret", "Field"),
    ],
  },
};

// A kernel's private-value witnesses: the free choices, and each output's
// owner commitment (real outputs) or secret (DUMMY outputs).
const choiceParams = [
  param("choices", "PrivateValueChoices<N_IN, N_OUT>"),
  param("output_owner_commitments", "[Field; N_OUT]"),
  param("output_dummy_secrets", "[Field; N_OUT]"),
];

const ruleStatement = (index) => `call_data(${index}) [Field; RULE_STATEMENT_LENGTH]`;

const KERNELS = {
  transfer: [
    param("pcash_chain_id", "Field"),
    param("recent_pcash_block_hash", "Field"),
    ...choiceParams,
    param("output_amounts", "[Field; N_OUT]"),
    param("asset_id", "Field"),
    param("dummy_input_seed", "Field"),
    param("replay_ids", "[Field; N_IN]", { comment: ["Rule-defined replay identity per APPLICATION slot; ignored otherwise."] }),
    ...stateOpeningParams,
    param("account", "AuthorizedAccount"),
    param("account_kind", "Field", { comment: ["Bound by account membership unless every input is DUMMY."] }),
    param("owner_inputs", "[InputNoteWitness; N_IN]"),
    param("rule_statement", ruleStatement(1)),
    param("authorization_vk", "AppVerificationKey"),
    param("event_statement", "call_data(2) [Field; EVENT_STATEMENT_LENGTH]"),
    param("event_application_vk", "AppVerificationKey"),
    param("event_salt", "Field"),
  ],
  sponsored_transfer: [
    param("pcash_chain_id", "Field"),
    param("recent_pcash_block_hash", "Field"),
    ...choiceParams,
    param("asset_output_amounts", "[Field; N_OUT]"),
    param("native_change", "NativeChange", { comment: [
      "The fee payer's change note, if any. Its secret is theirs to choose: the",
      "change returns to a real party, not to a contract that later provers must",
      "be able to reconstruct.",
    ] }),
    param("native_relay_output", "NativeRelayOutput"),
    param("asset_id", "Field"),
    param("dummy_input_seed", "Field"),
    param("replay_ids", "[Field; N_IN]"),
    ...stateOpeningParams,
    param("primary", "AuthorizedAccount"),
    param("fee_payer", "AuthorizedAccount"),
    param("owner_inputs", "[InputNoteWitness; N_IN]"),
    param("primary_statement", ruleStatement(1)),
    param("primary_vk", "AppVerificationKey"),
    param("fee_statement", ruleStatement(2)),
    param("fee_vk", "AppVerificationKey"),
    param("event_statement", "call_data(3) [Field; EVENT_STATEMENT_LENGTH]"),
    param("event_application_vk", "AppVerificationKey"),
    param("event_salt", "Field"),
  ],
  asset_creation: [
    param("pcash_chain_id", "Field"),
    param("recent_pcash_block_hash", "Field"),
    ...choiceParams,
    param("output_amounts", "[Field; N_OUT]"),
    param("metadata_commitment", "Field"),
    param("initial_supply", "Field"),
    param("asset_secret", "Field"),
    param("dummy_input_seed", "Field"),
    param("replay_ids", "[Field; N_IN]", { comment: ["Rule-defined replay identity per APPLICATION slot; ignored otherwise."] }),
    ...stateOpeningParams,
    param("account", "AuthorizedAccount"),
    param("account_kind", "Field", { comment: ["A user or a contract account may create an asset."] }),
    param("native_inputs", "[InputNoteWitness; N_IN]"),
    param("rule_statement", ruleStatement(1)),
    param("authorization_vk", "AppVerificationKey"),
    param("event_statement", "call_data(2) [Field; EVENT_STATEMENT_LENGTH]"),
    param("event_application_vk", "AppVerificationKey"),
    param("event_salt", "Field"),
  ],
};

// The account stacks publish one field after the private-value statement.
const ACCOUNT_ACTION_FIELDS = {
  user_account_update: "account_update_commitment",
};

const transactionStatement = (actionField) =>
  param("transaction_statement", `call_data(0) [Field; PUBLIC_INPUTS${actionField ? " + 1" : ""}]`);

/** The arguments that pass `params` on. */
const argumentsOf = (params) => params.map((parameter) => parameter.name);

const sized = (text, profile) =>
  text.replace(/\b(N_IN|N_OUT|SHAPE|PUBLIC_INPUTS)\b/g, (token) => `${profile.name}_${SIZE_CONSTANTS[token]}`);

const typeNames = (text) => (text.match(/\b[A-Z][a-z]\w*\b/g) ?? []).filter((name) => name !== "Field");

/**
 * One generated `main`: its imports, the parameter list, and one call of
 * `callee` from `module` with `args`. `generics` passes the profile's slot
 * counts and shape explicitly. Without `returns`, `main` returns nothing.
 * `inputs` names header inputs beyond the manifest and the profiles.
 */
function entryPoint(profile, { callee, module, generics = false, params, args, returns, pins = [], typeHash, inputs = [] }) {
  const parameterLines = params.flatMap((parameter) => [
    ...(parameter.comment ?? []).map((line) => `    // ${line}`),
    `    ${parameter.name}: ${sized(parameter.type, profile)},`,
  ]);
  const target = `${callee}${generics ? sized("::<N_IN, N_OUT, SHAPE>", profile) : ""}`;
  const statement = noirStatement(call(target, ...args), { trailing: returns !== undefined });
  const returnType = returns === undefined ? "" : ` -> return_data ${sized(returns, profile)}`;
  const body = `fn main(\n${parameterLines.join("\n")}\n)${returnType} {\n${statement}\n}\n`;

  const imports = new Map();
  const use = (from, name) => {
    if (!imports.has(from)) imports.set(from, []);
    if (!imports.get(from).includes(name)) imports.get(from).push(name);
  };
  for (const suffix of Object.values(SIZE_CONSTANTS)) {
    if (new RegExp(`\\b${profile.name}_${suffix}\\b`).test(body)) use(PROFILE_MODULE, `${profile.name}_${suffix}`);
  }
  use(module, callee);
  for (const [name, from] of Object.entries(GLOBAL_MODULES)) {
    if (new RegExp(`\\b${name}\\b`).test(body)) use(from, name);
  }
  for (const parameter of params) {
    for (const name of typeNames(parameter.type)) use(TYPE_MODULES[name] ?? module, name);
  }
  for (const pin of pins) use(PINS_MODULE, pin);
  if (typeHash !== undefined) use(TYPE_HASH_MODULE, typeHash);

  return generatedHeader(GENERATOR, ["circuits/manifest.json", PROFILE_SOURCE, ...inputs])
    + noirUses(imports)
    + "\n"
    + body;
}

const typeHashName = (rule, profile) => `${profile.name}_${rule.toUpperCase()}_TYPE_HASH`;

/**
 * The EIP-712 type hash of every profiled rule message, as `[name, bytes]`.
 * A message lists every output slot, so each profile has its own type.
 */
export function applicationTypeHashes(profiles) {
  return Object.entries(APPLICATIONS).flatMap(([rule, { typeHash }]) => typeHash === undefined ? []
    : profiles.map((profile) => [
      typeHashName(rule, profile),
      keccak_256(new TextEncoder().encode(typeHash(profile))),
    ]));
}

function application(rule, profile) {
  const { typeHash, params: baseParams } = APPLICATIONS[rule];
  const params = [...baseParams, param("event_entry", "Field")];
  const typeHashConstant = typeHash ? typeHashName(rule, profile) : undefined;
  return entryPoint(profile, {
    callee: "authorize",
    module: `reference_rule_common::${rule}`,
    generics: true,
    params,
    args: [...(typeHashConstant ? [typeHashConstant] : []), ...argumentsOf(params)],
    returns: "[Field; RULE_STATEMENT_LENGTH]",
    typeHash: typeHashConstant,
  });
}

function kernel(name, profile) {
  const params = KERNELS[name];
  return entryPoint(profile, {
    callee: name,
    module: `pcash_protocol::kernels::${name}`,
    generics: true,
    params,
    args: argumentsOf(params),
    returns: "[Field; PUBLIC_INPUTS]",
  });
}

// `pins` are the pin constants of the protocol kernels this hiding kernel
// accepts. The public inputs are passed on as one array: the statement the
// kernel must match.
function hidingKernel(profile, pins, actionField) {
  const publicInputs = [...privateValuePublicInputNames(profile), ...(actionField ? [actionField] : [])]
    .map((name) => param(name, "pub Field"));
  const params = [...publicInputs, transactionStatement(actionField), param("kernel_vk", "KernelVerificationKey")];
  return entryPoint(profile, {
    callee: "hiding_kernel",
    module: "pcash_protocol::recursion",
    params,
    args: [
      array(publicInputs.map((parameter) => parameter.name)),
      ...argumentsOf(params.slice(publicInputs.length)),
      array(pins),
    ],
    pins,
    inputs: ["sdk/src/protocol/witness.ts"],
  });
}

/**
 * The `main.nr` source of one manifest wrapper at `profile`, or undefined for
 * an unknown wrapper. `pins` are the pin constants of the circuits it folds,
 * from its declared links.
 */
export function wrapperSource(wrapper, profile, pins) {
  if (Object.hasOwn(APPLICATIONS, wrapper)) return application(wrapper, profile);
  if (wrapper === "hiding_kernel") return hidingKernel(profile, pins);
  for (const [stack, field] of Object.entries(ACCOUNT_ACTION_FIELDS)) {
    if (wrapper === `${stack}_hiding_kernel`) return hidingKernel(profile, pins, field);
  }
  const kernelName = wrapper.replace(/_kernel$/, "");
  if (kernelName !== wrapper && Object.hasOwn(KERNELS, kernelName)) return kernel(kernelName, profile);
  return undefined;
}
