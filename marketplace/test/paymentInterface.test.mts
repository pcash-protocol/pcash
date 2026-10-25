import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak256, toBytes } from "viem";
import {
  PAYMENT_EVENT_SIG,
  PAYMENT_EVENT_SIGNATURE,
  paymentCarrierContextHash,
} from "../src/commitments.mts";

function solidityPaymentSignature(source: string): string {
  const declaration = /event\s+Payment\s*\(([\s\S]*?)\)\s*;/.exec(source)?.[1];
  if (!declaration) throw new Error("Payment event declaration not found");
  const types = declaration.split(",").map((parameter) => parameter.trim().split(/\s+/)[0]);
  return `Payment(${types.join(",")})`;
}

function solidityTypes(source: string, name: "buy" | "retry"): string[] {
  const declaration = new RegExp(`function\\s+${name}\\s*\\(([\\s\\S]*?)\\)\\s*external`).exec(source)?.[1];
  if (!declaration) throw new Error(`Solidity ${name} declaration not found`);
  return declaration.split(",").map((parameter) => parameter.trim().split(/\s+/)[0]!);
}

function clientTypes(source: string, name: "buy" | "retry"): string[] {
  const declaration = new RegExp(`function ${name}\\((.*?)\\)`).exec(source)?.[1];
  if (!declaration) throw new Error(`client ${name} ABI not found`);
  return declaration.split(",").map((parameter) => parameter.trim().split(/\s+/)[0]!);
}

/** The declared errors a router function's body, and the private helpers it calls, raise through `require`. */
function solidityErrors(source: string, name: string): string[] {
  const body = new RegExp(`function\\s+${name}\\s*\\([\\s\\S]*?\\{([\\s\\S]*?)\\n    \\}`).exec(source)?.[1];
  if (!body) throw new Error(`Solidity ${name} body not found`);
  const helpers = [...body.matchAll(/\b(_\w+)\(/g)].map((match) => match[1]!);
  const own = [...body.matchAll(/require\([\s\S]*?,\s*(\w+)\([^()]*\)\);/g)].map((match) => {
    const error = match[1]!;
    const parameters = new RegExp(`error\\s+${error}\\s*\\(([^)]*)\\)\\s*;`).exec(source)?.[1];
    if (parameters === undefined) throw new Error(`Solidity error ${error} not declared`);
    return `error ${error}(${parameters.trim()})`;
  });
  return [...new Set([...own, ...helpers.flatMap((helper) => solidityErrors(source, helper))])];
}

test("Payment event signature agrees across Solidity and TypeScript", () => {
  const solidity = readFileSync(fileURLToPath(new URL("../l1-contracts/src/PaymentRouter.sol", import.meta.url)), "utf8");
  const fromSolidity = solidityPaymentSignature(solidity);
  assert.equal(fromSolidity, PAYMENT_EVENT_SIGNATURE);
  assert.equal(keccak256(toBytes(fromSolidity)), PAYMENT_EVENT_SIG);
});

// The claim circuit's frozen vector: `cast abi-encode "f(bytes32,address,uint256,bytes32)"` of
// these terms, hashed as an event carrier from the router.
test("payment carrier context hash matches the claim circuit's frozen vector", () => {
  assert.equal(
    paymentCarrierContextHash(
      {
        router: 0x5fbdb2315678afecb367f032d93f642f64180aa3n,
        seller: 0x70997970c51812dc3a010c7d01b50e0d17dc79c8n,
        id: 0x1d6e0c3e5c1f2e5b9b0f4a7e8c3d2b1a09f8e7d6c5b4a39281706f5e4d3c2b1an,
        ethPriceWei: 1_000_000_000_000_000_000n,
      },
      0x077961001bbcf8fe10a31b578b3f8bf9643c91f96e7a5ad26f7b213cffc2e291n,
    ),
    0x0279fb617ca3786d2a4cff0ebf82eb1d49007d9fd6e196e34812c1dc1008a0c2n,
  );
});

for (const name of ["buy", "retry"] as const) test(`router and client agree on the ${name} ABI`, () => {
  const solidity = readFileSync(fileURLToPath(new URL("../l1-contracts/src/PaymentRouter.sol", import.meta.url)), "utf8");
  const client = readFileSync(fileURLToPath(new URL("../src/client/paymentRouter.ts", import.meta.url)), "utf8");
  assert.deepEqual(clientTypes(client, name), solidityTypes(solidity, name));
});

test("client decodes every router error buy() and retry() raise", () => {
  const solidity = readFileSync(fileURLToPath(new URL("../l1-contracts/src/PaymentRouter.sol", import.meta.url)), "utf8");
  const frontend = readFileSync(fileURLToPath(new URL("../src/client/buy.ts", import.meta.url)), "utf8");
  const errors = [...new Set([...solidityErrors(solidity, "buy"), ...solidityErrors(solidity, "retry")])];
  for (const expected of ["error AlreadyPaid(bytes32 paymentKey)", "error NotPaid(bytes32 paymentKey)", "error NotAfterPassed()", "error InvalidAnchor()"]) {
    assert.ok(errors.includes(expected), `router source parse missed ${expected}`);
  }
  for (const error of errors) assert.ok(frontend.includes(`"${error}"`), `buy.ts cannot decode ${error}`);
});
