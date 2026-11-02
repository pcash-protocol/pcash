class WalletActionCanceledError extends Error {
  constructor() {
    super("wallet action canceled");
    this.name = "AbortError";
  }
}

export function throwIfWalletActionCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WalletActionCanceledError();
}

export function abortableWalletAction<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation;
  throwIfWalletActionCanceled(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new WalletActionCanceledError());
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
