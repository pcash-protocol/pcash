import { isBuiltinSchema, type DataRecord, type RecordSchema } from "../src/protocol/records.ts";

/** Decode a standard record when an assertion needs its typed value. */
export function recordValue<T>(records: readonly DataRecord[] | null | undefined, schema: RecordSchema<T>): T | undefined {
  const record = records?.find(record => record.schema === schema.id);
  return record === undefined ? undefined : schema.decode(record.data);
}

export function applicationDataRecords(records: readonly DataRecord[]): DataRecord[] {
  return records.filter(record => !isBuiltinSchema(record.schema));
}

export function orderedRecords(records: readonly DataRecord[]): DataRecord[] {
  return [...records].sort((a, b) => a.schema < b.schema ? -1 : a.schema > b.schema ? 1 : 0);
}
