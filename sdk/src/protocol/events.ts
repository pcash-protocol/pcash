import { NO_OP_EVENT_APPLICATION_VK_HASH } from "../constants/rulePins.ts";
import type { WitnessMap } from "./witness.ts";
import { EVENT_DOMAIN, EVENT_ENTRY_DOMAIN } from "../constants/domainTags.ts";
import { toField, type FieldNumberish } from "../crypto/field.ts";
import { poseidon } from "../crypto/poseidon2.ts";
import { randomFieldEntropy } from "../utils/bytes.ts";

/** The sender retains this opening and delivers it encrypted to each recipient. */
export interface TransactionEvent {
  applicationVkHash: FieldNumberish;
  event: FieldNumberish;
}

export interface EventOptions {
  preparedEvent?: PreparedEvent;
  eventSalt?: FieldNumberish;
}

export function eventEntry(application: TransactionEvent): bigint {
  return poseidon([EVENT_ENTRY_DOMAIN, toField(application.applicationVkHash), toField(application.event)]);
}

/** SDK convention for transactions without an application claim. */
export const DEFAULT_EVENT_ENTRY = eventEntry({ applicationVkHash: NO_OP_EVENT_APPLICATION_VK_HASH, event: 0n });

export function eventsCommitment(salt: FieldNumberish, event: TransactionEvent = { applicationVkHash: NO_OP_EVENT_APPLICATION_VK_HASH, event: 0n }): bigint {
  return poseidon([EVENT_DOMAIN, eventEntry(event), toField(salt, "eventSalt")]);
}

export interface PreparedEvent {
  eventEntry: bigint;
  eventSalt: bigint;
}

export function prepareEvent(options: EventOptions): PreparedEvent & { eventsCommitment: bigint } {
  const prepared = options.preparedEvent ?? {
    eventEntry: DEFAULT_EVENT_ENTRY,
    eventSalt: toField(options.eventSalt ?? randomFieldEntropy(), "eventSalt"),
  };
  return { ...prepared, eventsCommitment: poseidon([EVENT_DOMAIN, prepared.eventEntry, prepared.eventSalt]) };
}

/** Derive the event context from the authorizing statement assembled by the build. */
export function eventStatementFromKernel(witness: WitnessMap, event: FieldNumberish = 0n): [bigint, bigint, bigint] {
  const statement = (witness.rule_statement ?? witness.primary_statement ?? witness.fee_statement) as readonly FieldNumberish[];
  return [toField(statement[1]!), toField(statement[2]!), toField(event)];
}

export function noOpEventWitness(statement: readonly FieldNumberish[]): WitnessMap {
  return { action_commitment: toField(statement[0]!).toString(), recent_pcash_block_hash: toField(statement[1]!).toString() };
}
