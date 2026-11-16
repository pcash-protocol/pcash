#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  WIRE_PROOF_BYTES, PRIVATE_VALUE_PUBLIC_INPUTS,
  USER_ACCOUNT_UPDATE_PUBLIC_INPUTS,
} from "../../../../../sdk/src/protocol/codec.ts";
import { CHONK_VK_LEN } from "../../../../../sdk/src/protocol/account.ts";

import { PRIVATE_VALUE_PROFILES } from "../../../../../sdk/src/constants/privateValueProfiles.ts";
import { Config } from "../../../../../sdk/src/bcfg/index.ts";
import { Logger } from "../../../../../sdk/src/blgr/index.ts";

const logger = new Logger("info");
await logger.open();

const config = new Config("pcash");
config.load({ argv: true, env: true });
const configuredBundle = config.str("circuit-bundle");
if (!configuredBundle) throw new Error("PCASH_CIRCUIT_BUNDLE is required");
const bundleDir = resolve(configuredBundle);
const scalarModulus = BigInt("0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001");
const profiles = [
  {
    name: "private_value",
    directory: join(bundleDir, "known-answers", "private_value"),
    vk: join(bundleDir, "vks", "private_value_hiding_kernel.chonk.vk"),
    proofBytes: WIRE_PROOF_BYTES,
    publicInputs: PRIVATE_VALUE_PUBLIC_INPUTS,
  },
  {
    name: "private_value_large",
    directory: join(bundleDir, "known-answers", "private_value_large"),
    vk: join(bundleDir, "vks", "private_value_large_hiding_kernel.chonk.vk"),
    proofBytes: WIRE_PROOF_BYTES,
    publicInputs: PRIVATE_VALUE_PROFILES.L.publicInputs,
  },
  {
    name: "user_account_update",
    directory: join(bundleDir, "known-answers", "user_account_update"),
    vk: join(bundleDir, "vks", "user_account_update_hiding_kernel.chonk.vk"),
    proofBytes: WIRE_PROOF_BYTES,
    publicInputs: USER_ACCOUNT_UPDATE_PUBLIC_INPUTS,
  },

];

if (config.argv.length > 0 || Object.keys(config.args).some((key) => key !== "circuitbundle")) throw new Error("usage: node check.mjs");

function requireCanonicalFields(bytes, label) {
  if (bytes.length % 32 !== 0) throw new Error(`${label} is not a multiple of 32 bytes`);
  for (let offset = 0; offset < bytes.length; offset += 32) {
    if (BigInt(`0x${bytes.subarray(offset, offset + 32).toString("hex")}`) >= scalarModulus) {
      throw new Error(`${label} has a noncanonical field element at byte ${offset}`);
    }
  }
}

for (const profile of profiles) {
  const positivePath = join(profile.directory, "proof");
  const negativePath = join(profile.directory, "proof.rejected");
  const positive = readFileSync(positivePath);
  const expectedNegative = Buffer.from(positive);
  // The low byte of the last scalar, before the final Shplonk Q and KZG W commitments.
  const flipOffset = expectedNegative.length - 65;
  expectedNegative[flipOffset] ^= 0x01;

  const actualNegative = readFileSync(negativePath);
  if (!actualNegative.equals(expectedNegative)) {
    throw new Error(`${profile.name}/proof.rejected must equal proof with byte ${flipOffset} XORed by 0x01`);
  }
  if (positive.length !== profile.proofBytes) throw new Error(`${profile.name}/proof has the wrong length`);
  if (readFileSync(profile.vk).length !== CHONK_VK_LEN * 32) throw new Error(`${profile.name}/vk has the wrong length`);
  if (readFileSync(join(profile.directory, "public_inputs")).length !== profile.publicInputs * 32) {
    throw new Error(`${profile.name}/public_inputs has the wrong length`);
  }
  requireCanonicalFields(readFileSync(join(profile.directory, "public_inputs")), `${profile.name}/public_inputs`);

  logger.info(`${profile.name} known-answer shape valid`);
}
