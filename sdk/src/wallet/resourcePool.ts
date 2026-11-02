/** Reference-count resources by key without overlapping a final close and reopen. */
export function keyedResourcePool<T>(close: (resource: T) => Promise<void>) {
  const entries = new Map<string, {
    resource: Promise<T>;
    users: number;
    closing?: Promise<void>;
  }>();
  return async function acquire(key: string, open: () => Promise<T>): Promise<{
    resource: T;
    release: () => Promise<void>;
  }> {
    let entry = entries.get(key);
    if (entry?.closing !== undefined) {
      await entry.closing;
      return acquire(key, open);
    }
    if (entry === undefined) {
      entry = { resource: open(), users: 0 };
      entries.set(key, entry);
    }
    entry.users += 1;
    let resource: T;
    try {
      resource = await entry.resource;
    } catch (error) {
      entry.users -= 1;
      if (entry.users === 0 && entries.get(key) === entry) entries.delete(key);
      throw error;
    }
    let released = false;
    return { resource, release: async () => {
      if (released) return;
      released = true;
      entry!.users -= 1;
      if (entry!.users === 0 && entries.get(key) === entry) {
        entry!.closing = close(resource).finally(() => {
          if (entries.get(key) === entry) entries.delete(key);
        });
        await entry!.closing;
      }
    } };
  };
}
