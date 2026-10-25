import type { Config } from "@pcash/sdk/bcfg";
import type { Address } from "viem";

/** Run settings every scenario shares; `PCASH_E2E_*` overrides the few an operator tunes. */
export interface E2eConfig {
  /** `PCASH_E2E_L1_MAX_FEE_PER_GAS`: a ceiling over every live EIP-1559 quote. */
  maxFeePerGas?: bigint;
  assets: { initialSupply: bigint; actionFee: bigint };
  marketplace: {
    /** `PCASH_E2E_PAYMENT_ROUTER_ADDRESS`: reuse a deployed router instead of deploying one. */
    routerAddress?: Address;
    /** Never an address that sends L1 transactions: payouts are measured as its exact balance gain. */
    feeRecipient: Address;
    feeBps: number;
    ethPriceWei: bigint;
  };
  seed: {
    /** Plain transfers among the funded seed actors after the planned waves; each one is a native proof. */
    volumeTransfers: number;
  };
}

export const DEFAULT_MARKETPLACE_FEE_RECIPIENT: Address = "0x0000000000000000000000000000000000000fee";

export function loadE2eConfig(settings: Config): E2eConfig {
  const maxFeePerGas = optional(settings.str("l1-max-fee-per-gas"), (value) => decimal(value, "PCASH_E2E_L1_MAX_FEE_PER_GAS", 1n));
  const routerAddress = optional(settings.str("payment-router-address"), (value) => address(value, "PCASH_E2E_PAYMENT_ROUTER_ADDRESS"));
  const feeRecipient = optional(settings.str("payment-router-fee-recipient"), (value) => address(value, "PCASH_E2E_PAYMENT_ROUTER_FEE_RECIPIENT"));
  const feeBps = optional(settings.str("payment-router-fee-bps"), (value) => Number(decimal(value, "PCASH_E2E_PAYMENT_ROUTER_FEE_BPS", 1n)));
  if (feeBps !== undefined && feeBps >= 10_000) throw new Error("PCASH_E2E_PAYMENT_ROUTER_FEE_BPS must be between 1 and 9999");
  const volumeTransfers = optional(settings.str("seed-volume-transfers"), (value) => Number(decimal(value, "PCASH_E2E_SEED_VOLUME_TRANSFERS", 0n)));
  return {
    ...(maxFeePerGas === undefined ? {} : { maxFeePerGas }),
    assets: { initialSupply: 1_000_000n, actionFee: 1n },
    marketplace: {
      ...(routerAddress === undefined ? {} : { routerAddress }),
      feeRecipient: feeRecipient ?? DEFAULT_MARKETPLACE_FEE_RECIPIENT,
      feeBps: feeBps ?? 500,
      ethPriceWei: 1_000_000_000_000_000n,
    },
    seed: { volumeTransfers: volumeTransfers ?? 8 },
  };
}

export function parseDuration(value: string): number {
  const match = /^([1-9][0-9]*)(s|m|h)$/.exec(value.trim());
  if (match === null) throw new Error("--duration expects a positive integer followed by s, m, or h");
  const multiplier = match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : 1_000;
  const duration = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(duration)) throw new Error("--duration is too large");
  return duration;
}

function optional<T>(value: string | null, parse: (value: string) => T): T | undefined {
  const trimmed = value?.trim();
  return trimmed ? parse(trimmed) : undefined;
}

function decimal(value: string, label: string, minimum: bigint): bigint {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${label} must be a decimal integer`);
  const parsed = BigInt(value);
  if (parsed < minimum) throw new Error(`${label} must be at least ${minimum}`);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) && label !== "PCASH_E2E_L1_MAX_FEE_PER_GAS") throw new Error(`${label} is too large`);
  return parsed;
}

function address(value: string, label: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} must be a 20-byte 0x address`);
  return value.toLowerCase() as Address;
}
