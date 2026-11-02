// Contract accounts — creation transaction types 0x02 and 0x04, accountKind 1.
//
// A smart contract is an unsigned, kind-1 account whose address is derived from
// its content (nullifier-key commitment, function set, and optional receive key)
// rather than from an ECDSA public key. Anyone can spend from it only by calling
// one of its registered functions, each implemented by an account-rule circuit
// proof; the contract itself never signs. One-to-one with the node's contract
// acceptance rules and circuits/protocol/lib/src/authorization/account.nr (accountKind == 1).
//
// The account shape only. Building a transfer that CALLS one of these functions
// needs the witness builders and lives in ../builders/contractCall.ts, so that
// ../clients/ can decode a contract account without pulling in the proving layer.

import { type FieldNumberish, toField } from "../crypto/field.ts";
import { bytesToBigInt, concatBytes, field32 } from "../utils/bytes.ts";
import { poseidon } from "../crypto/poseidon2.ts";
import {
  accountRuleEntryCommitment,
  buildAccountRuleSet,
  accountStateCommitment,
  receiveKeyHash as receiveKeyHashOf,
} from "./account.ts";
import { nullifierKeyCommitment } from "./notes.ts";
import { CONTRACT_ADDRESS_DOMAIN } from "../constants/domainTags.ts";
import { ACCOUNT_KIND_CONTRACT, ML_KEM_768_PUBLIC_KEY_LENGTH } from "../constants/params.ts";
import { encodeReceiveKey, RECEIVE_KEY_ABSENT, RECEIVE_KEY_PRESENT } from "./codec.ts";

const UINT160_MASK = (1n << 160n) - 1n;
export const PUBLISHES_NK_ROOT_FALSE = 0 as const;
export const PUBLISHES_NK_ROOT_TRUE = 1 as const;

function checkedPublishesNkRoot(value: FieldNumberish): 0 | 1 {
  const flag = toField(value, "publishesNkRoot");
  if (flag === 0n) return PUBLISHES_NK_ROOT_FALSE;
  if (flag === 1n) return PUBLISHES_NK_ROOT_TRUE;
  throw new Error("publishesNkRoot must be 0 or 1");
}

/**
 * A contract body serializes exactly one representation of its nullifier-key
 * material. This union makes the contradictory combination — an `nkRoot` and a
 * `nullifierKeyCommitment` that disagree — unrepresentable.
 */
export type ContractNullifierKeyMaterial =
  | { publishesNkRoot: false; nullifierKeyCommitment: FieldNumberish }
  | { publishesNkRoot: true; nkRoot: FieldNumberish };

/** The account's `nullifierKeyCommitment`, derived when the root is published. */
function contractNullifierKeyCommitment(
  material: ContractNullifierKeyMaterial,
): bigint {
  return material.publishesNkRoot
    ? nullifierKeyCommitment(material.nkRoot)
    : toField(material.nullifierKeyCommitment, "nullifierKeyCommitment");
}

/** The single 32-byte field the body serializes for this variant. */
function nullifierKeyMaterialField(material: ContractNullifierKeyMaterial): bigint {
  return material.publishesNkRoot
    ? toField(material.nkRoot, "nkRoot")
    : toField(material.nullifierKeyCommitment, "nullifierKeyCommitment");
}

declare const functionSelectorBrand: unique symbol;

/** A smart contract function selector encoded as a single unsigned byte. */
export type FunctionSelector = number & { readonly [functionSelectorBrand]: true };

/** Validate and construct a smart contract function selector. */
export function functionSelector(value: number): FunctionSelector {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error("smart contract function selector must be an integer from 0 to 255");
  }
  return value as FunctionSelector;
}

/** One registered function in a smart contract's depth-8 function set. */
export interface ContractFunction {
  selector: FunctionSelector;
  applicationVkHash: FieldNumberish;
  configurationCommitment: FieldNumberish;
}

/** One named field in a Smart Contract function's developer-facing ABI. */
export interface ContractFunctionAbiField {
  name: string;
  type: string;
  visibility?: "public" | "private";
  description?: string;
}

/** How an application derives a function's committed configuration fields. */
export interface ContractFunctionConfigurationCommitment {
  scheme: "poseidon";
  domain: string;
  fields: readonly string[];
}

/** Developer-facing metadata that names one committed Smart Contract function. */
export interface ContractFunctionManifestEntry {
  name: string;
  selector: FunctionSelector;
  applicationVkHash: FieldNumberish;
  arguments?: readonly ContractFunctionAbiField[];
  configuration?: readonly ContractFunctionAbiField[];
  configurationCommitment?: ContractFunctionConfigurationCommitment;
}

/** A versioned developer-facing ABI for one Smart Contract. */
export interface ContractManifest {
  schemaVersion: 1;
  contract: string;
  functions: readonly ContractFunctionManifestEntry[];
}

/** A manifest entry bound to the corresponding function in a verified body. */
export interface VerifiedContractFunctionManifestEntry {
  name: string;
  selector: FunctionSelector;
  applicationVkHash: bigint;
  arguments?: readonly ContractFunctionAbiField[];
  configuration?: readonly ContractFunctionAbiField[];
  configurationCommitment?: ContractFunctionConfigurationCommitment;
  function: ContractFunction;
}

const verifiedContractManifestBrand: unique symbol = Symbol("VerifiedContractManifest");

/** A manifest whose selectors and implementations exactly match a contract body. */
export interface VerifiedContractManifest {
  readonly [verifiedContractManifestBrand]: true;
  schemaVersion: 1;
  contract: string;
  functions: readonly VerifiedContractFunctionManifestEntry[];
}

/** A decoded or to-be-encoded contract-account body. */
export interface ContractBody {
  /** Exactly one representation of the account's nullifier-key material. */
  nullifierKey: ContractNullifierKeyMaterial;
  /** ML-KEM-768 receive key (1184 bytes) or undefined. */
  mlKemPublicKey?: Uint8Array;
  functions: ContractFunction[];
}

/**
 * Bind a developer-facing manifest to a contract body. The manifest must name
 * every body function exactly once and bind the same selector and
 * implementation verification key. This verifies metadata identity only; it
 * does not generate a
 * witness or proof for any function.
 */
export function verifyContractManifest(
  body: ContractBody,
  manifest: ContractManifest,
): VerifiedContractManifest {
  if (manifest.schemaVersion !== 1) {
    throw new Error("smart contract manifest schemaVersion must be 1");
  }
  if (manifest.contract.trim().length === 0) {
    throw new Error("smart contract manifest contract name must be nonempty");
  }
  if (manifest.functions.length !== body.functions.length) {
    throw new Error("smart contract manifest must describe every function exactly once");
  }

  const bodyBySelector = new Map<FunctionSelector, ContractFunction>();
  for (const bodyFunction of body.functions) {
    const selector = functionSelector(bodyFunction.selector);
    if (bodyBySelector.has(selector)) {
      throw new Error(`smart contract body has duplicate function selector ${selector}`);
    }
    bodyBySelector.set(selector, bodyFunction);
  }

  const names = new Set<string>();
  const selectors = new Set<FunctionSelector>();
  const functions = manifest.functions.map((entry) => {
    const name = entry.name.trim();
    if (name.length === 0) {
      throw new Error("smart contract manifest function name must be nonempty");
    }
    if (names.has(name)) {
      throw new Error(`smart contract manifest has duplicate function name ${name}`);
    }
    names.add(name);

    const selector = functionSelector(entry.selector);
    if (selectors.has(selector)) {
      throw new Error(`smart contract manifest has duplicate function selector ${selector}`);
    }
    selectors.add(selector);

    const bodyFunction = bodyBySelector.get(selector);
    if (bodyFunction === undefined) {
      throw new Error(`smart contract manifest selector ${selector} is not in the contract body`);
    }
    const applicationVkHash = toField(
      entry.applicationVkHash,
      `manifest function ${name} applicationVkHash`,
    );
    if (
      applicationVkHash !==
      toField(bodyFunction.applicationVkHash, `contract function ${selector} applicationVkHash`)
    ) {
      throw new Error(`smart contract manifest function ${name} applicationVkHash does not match`);
    }

    return {
      name,
      selector,
      applicationVkHash,
      ...(entry.arguments !== undefined ? { arguments: [...entry.arguments] } : {}),
      ...(entry.configuration !== undefined ? { configuration: [...entry.configuration] } : {}),
      ...(entry.configurationCommitment !== undefined
        ? {
            configurationCommitment: {
              ...entry.configurationCommitment,
              fields: [...entry.configurationCommitment.fields],
            },
          }
        : {}),
      function: bodyFunction,
    };
  });

  for (const selector of bodyBySelector.keys()) {
    if (!selectors.has(selector)) {
      throw new Error(`smart contract manifest is missing function selector ${selector}`);
    }
  }

  return {
    [verifiedContractManifestBrand]: true,
    schemaVersion: 1,
    contract: manifest.contract.trim(),
    functions,
  };
}

/**
 * Resolve a verified function by its developer-facing name or numeric selector.
 * The returned entry supplies ABI metadata and the committed function fields;
 * the application remains responsible for constructing its witness and proof.
 */
export function resolveContractFunction(
  manifest: VerifiedContractManifest,
  nameOrSelector: string | FunctionSelector,
): VerifiedContractFunctionManifestEntry {
  const entry =
    typeof nameOrSelector === "string"
      ? manifest.functions.find((candidate) => candidate.name === nameOrSelector)
      : manifest.functions.find(
          (candidate) => candidate.selector === functionSelector(nameOrSelector),
        );
  if (entry === undefined) {
    throw new Error(`smart contract function ${String(nameOrSelector)} is not in the manifest`);
  }
  return entry;
}

/**
 * contractPreimage = poseidon(CONTRACT_ADDRESS_DOMAIN, nullifierKeyCommitment,
 * functionSetCommitment, receiveKeyHash, publishesNkRoot); address =
 * uint160(contractPreimage).
 */
export function contractAddress(
  nullifierKeyCommitment: FieldNumberish,
  functionSetCommitment: FieldNumberish,
  receiveKeyHash: FieldNumberish,
  publishesNkRoot: FieldNumberish,
): bigint {
  const profile = checkedPublishesNkRoot(publishesNkRoot);
  const preimage = poseidon([
    CONTRACT_ADDRESS_DOMAIN,
    nullifierKeyCommitment,
    functionSetCommitment,
    receiveKeyHash,
    profile,
  ]);
  return preimage & UINT160_MASK;
}

/** A function's depth-8 membership opening against its Smart Contract's function set. */
export interface ContractFunctionMembership {
  functionSetCommitment: bigint;
  functionCommitment: bigint;
  selector: FunctionSelector;
  /** Leaf-level-upward depth-8 siblings. */
  siblings: bigint[];
}

/** A constructed Smart Contract function set and its selector membership openings. */
export interface ContractFunctionSet {
  functionSetCommitment: bigint;
  /** Return the opening for a registered selector; throws when the selector is absent. */
  membership(selector: FunctionSelector): ContractFunctionMembership;
}

/**
 * Construct the depth-8 function set and expose membership openings using only
 * Smart Contract function terminology. The shared account-rule-entry tree is
 * an implementation detail of this adapter.
 */
export function buildContractFunctionSet(
  functions: readonly ContractFunction[],
): ContractFunctionSet {
  const functionCommitments = new Map<FunctionSelector, bigint>();
  const set = buildAccountRuleSet(
    functions.map((entry) => {
      const selector = functionSelector(entry.selector);
      if (functionCommitments.has(selector)) {
        throw new Error(`duplicate smart contract function selector ${selector}`);
      }
      const functionCommitment = contractFunctionCommitment(entry);
      functionCommitments.set(selector, functionCommitment);
      return {
        entryIndex: selector,
        accountRuleEntryCommitment: functionCommitment,
      };
    }),
  );
  return {
    functionSetCommitment: set.accountRuleSetCommitment,
    membership(selectorValue: FunctionSelector): ContractFunctionMembership {
      const selector = functionSelector(selectorValue);
      const functionCommitment = functionCommitments.get(selector);
      if (functionCommitment === undefined) {
        throw new Error(`smart contract function selector ${selector} is not registered`);
      }
      const opening = set.membership(selector);
      return {
        functionSetCommitment: opening.accountRuleSetCommitment,
        functionCommitment,
        selector,
        siblings: opening.siblings,
      };
    },
  };
}

/**
 * `contractFunctionCommitment = accountRuleEntryCommitment(vkHash, config, 0)`.
 * A contract publishes its complete function list on Ethereum DA, so a
 * published per-function blinder hides nothing; distinct deployments already
 * differ through `nullifierKeyCommitment`, which the address preimage binds.
 */
export function contractFunctionCommitment(entry: {
  applicationVkHash: FieldNumberish;
  configurationCommitment: FieldNumberish;
}): bigint {
  return accountRuleEntryCommitment(entry.applicationVkHash, entry.configurationCommitment, 0n);
}

export interface BuildContractParams {
  /** Exactly one representation of the account's nullifier-key material. */
  nullifierKey: ContractNullifierKeyMaterial;
  mlKemPublicKey?: Uint8Array;
  functions: readonly ContractFunction[];
}

export interface ContractBuild extends ContractVerification {
  /** The unsigned body shared by every contract-creation funding mode. */
  body: Uint8Array;
  contract: ContractBody;
}

/**
 * Build a contract-account body: derive the nullifier-key commitment
 * from the supplied variant, derive the function-set commitment from the
 * function list, encode the body, and derive the content address. `functions`
 * must be nonempty with strictly increasing selectors (the node rejects
 * otherwise).
 */
export function buildContractBody(params: BuildContractParams): ContractBuild {
  if (params.functions.length < 1) throw new Error("smart contract requires at least one function");

  const body: ContractBody = {
    nullifierKey: params.nullifierKey,
    ...(params.mlKemPublicKey !== undefined ? { mlKemPublicKey: params.mlKemPublicKey } : {}),
    functions: [...params.functions],
  };
  const verification = verifyContract(body);

  return {
    body: encodeContractBody(body),
    contract: body,
    ...verification,
  };
}

/** Encode a contract-account body. Selectors are emitted in the order given. */
export function encodeContractBody(
  body: ContractBody,
): Uint8Array {
  if (body.functions.length > 0xff) throw new Error("smart contract functionCount must fit in a u8");

  const parts: Uint8Array[] = [
    Uint8Array.from([body.nullifierKey.publishesNkRoot ? 1 : 0]),
    field32(nullifierKeyMaterialField(body.nullifierKey)),
    encodeReceiveKey(body.mlKemPublicKey),
    Uint8Array.from([body.functions.length]),
  ];
  for (const entry of body.functions) {
    const selector = functionSelector(entry.selector);
    parts.push(
      Uint8Array.from([selector]),
      field32(entry.applicationVkHash),
      field32(entry.configurationCommitment),
    );
  }
  return concatBytes(...parts);
}

/** Decode a contract-account body. Throws on any malformation or trailing bytes. */
export function decodeContractBody(
  bytes: Uint8Array,
): ContractBody {
  let o = 0;
  const need = (n: number): void => {
    if (o + n > bytes.length) throw new Error("smart contract body: unexpected end of input");
  };
  const field = (): bigint => {
    need(32);
    const v = bytesToBigInt(bytes.subarray(o, o + 32));
    o += 32;
    return v;
  };
  const u8 = (): number => {
    need(1);
    return bytes[o++]!;
  };

  const publishesNkRootByte = u8();
  if (publishesNkRootByte !== 0 && publishesNkRootByte !== 1) {
    throw new Error("smart contract publishesNkRoot must be 0 or 1");
  }
  const material = field();
  const nullifierKey: ContractNullifierKeyMaterial = publishesNkRootByte === 1
    ? { publishesNkRoot: true, nkRoot: material }
    : { publishesNkRoot: false, nullifierKeyCommitment: material };

  const receiveKeyMode = u8();
  let mlKemPublicKey: Uint8Array | undefined;
  if (receiveKeyMode === RECEIVE_KEY_PRESENT) {
    need(ML_KEM_768_PUBLIC_KEY_LENGTH);
    mlKemPublicKey = bytes.slice(o, o + ML_KEM_768_PUBLIC_KEY_LENGTH);
    o += ML_KEM_768_PUBLIC_KEY_LENGTH;
  } else if (receiveKeyMode !== RECEIVE_KEY_ABSENT) {
    throw new Error(`smart contract receive-key mode must be 0 or 1, got ${receiveKeyMode}`);
  }

  const functionCount = u8();
  const functions: ContractFunction[] = [];
  for (let i = 0; i < functionCount; i++) {
    const selector = functionSelector(u8());
    functions.push({
      selector,
      applicationVkHash: field(),
      configurationCommitment: field(),
    });
  }
  if (o !== bytes.length) throw new Error("smart contract body: trailing bytes");
  return {
    nullifierKey,
    ...(mlKemPublicKey !== undefined ? { mlKemPublicKey } : {}),
    functions,
  };
}

export interface ContractVerification {
  address: bigint;
  nullifierKeyCommitment: bigint;
  functionSetCommitment: bigint;
  accountStateCommitment: bigint;
  functionSet: ContractFunctionSet;
  /** `receiveKeyHash(mlKemPublicKey)`, or zero without a receive key. */
  receiveKeyHash: bigint;
}

/**
 * Verify a contract-account body against the acceptance rules: canonical
 * nullifier-key material, at least one function with strictly increasing
 * selectors. Returns the derived commitment, function-set root,
 * content address, and account leaf. Throws on the first violated rule.
 */
export function verifyContract(
  body: ContractBody,
): ContractVerification {
  const commitment = contractNullifierKeyCommitment(body.nullifierKey);

  if (body.functions.length < 1) throw new Error("smart contract requires functionCount >= 1");
  for (let i = 1; i < body.functions.length; i++) {
    if (body.functions[i]!.selector <= body.functions[i - 1]!.selector) {
      throw new Error("smart contract function selectors must be strictly increasing");
    }
  }
  const functionSet = buildContractFunctionSet(body.functions);
  const functionSetCommitment = functionSet.functionSetCommitment;
  if (body.mlKemPublicKey !== undefined && body.mlKemPublicKey.length !== ML_KEM_768_PUBLIC_KEY_LENGTH) {
    throw new Error(`mlKemPublicKey must be ${ML_KEM_768_PUBLIC_KEY_LENGTH} bytes`);
  }
  const receiveKeyHash = body.mlKemPublicKey === undefined ? 0n : receiveKeyHashOf(body.mlKemPublicKey);
  const address = contractAddress(
    commitment,
    functionSetCommitment,
    receiveKeyHash,
    body.nullifierKey.publishesNkRoot ? 1n : 0n,
  );
  const leaf = accountStateCommitment(
    address,
    commitment,
    functionSetCommitment,
    ACCOUNT_KIND_CONTRACT,
    1n,
    receiveKeyHash,
  );
  return { address, nullifierKeyCommitment: commitment, functionSetCommitment, accountStateCommitment: leaf, functionSet, receiveKeyHash };
}
