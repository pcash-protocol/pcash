const sessions = new WeakMap<object, number>();
let nextSession = 0;

/** A query-key number for a client object, stable for that object's lifetime. */
export function querySession(value: object | undefined): number | undefined {
  if (value === undefined) return undefined;
  let session = sessions.get(value);
  if (session === undefined) { session = ++nextSession; sessions.set(value, session); }
  return session;
}
