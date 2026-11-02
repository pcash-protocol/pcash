// Promise-tail serializers: run async operations one at a time, in call order.
// A rejected operation settles its caller and never wedges the operations
// queued behind it.

/** Serialize every operation through one queue. */
export function serialQueue(): <T>(operation: () => T | Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => T | Promise<T>): Promise<T> => {
    const running = tail.then(operation, operation);
    tail = running.then(() => undefined, () => undefined);
    return running;
  };
}

/** Serialize operations that share a key; an idle key retains nothing. */
export function keyedSerialQueue(): <T>(key: string, operation: () => T | Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return <T>(key: string, operation: () => T | Promise<T>): Promise<T> => {
    const running = (tails.get(key) ?? Promise.resolve()).then(operation, operation);
    const tail = running.then(() => undefined, () => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      // A later operation may already have replaced this tail.
      if (tails.get(key) === tail) tails.delete(key);
    });
    return running;
  };
}
