import type { WalletExecutionContext } from "./actions/walletClient.ts";

const WALLET_ACTION: unique symbol = Symbol("pcash.wallet.action");
const WALLET_ACTION_RESULT: unique symbol = Symbol("pcash.wallet.action.result");

type ErasedWalletActionCallback = {
  (context: WalletExecutionContext<any, any>): unknown | Promise<unknown>;
  readonly [WALLET_ACTION]: true;
};

/** A branded operation accepted by {@link Wallet.execute}. */
export interface WalletAction<Result> extends ErasedWalletActionCallback {
  /** Stable operation name used by Wallet lifecycle events. */
  readonly actionName: string;
  readonly [WALLET_ACTION_RESULT]?: Result;
}

/**
 * Adapt an experimental wallet operation for {@link Wallet.execute}.
 *
 * Prefer a named action from `@pcash/sdk/wallet/actions` when one exists. The
 * callback receives wallet authority only for the duration of `execute`.
 */
export function walletAction<Result, Prepared = unknown, Output = unknown>(
  actionName: string,
  callback: (
    context: WalletExecutionContext<Prepared, Output>,
  ) => Result | Promise<Result>,
): WalletAction<Result> {
  if (actionName.trim() === "") throw new Error("wallet action name must not be empty");
  const action = ((context: WalletExecutionContext<any, any>) =>
    callback(context as WalletExecutionContext<Prepared, Output>)) as ErasedWalletActionCallback;
  Object.defineProperty(action, WALLET_ACTION, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(action, "actionName", {
    value: actionName,
    configurable: false,
    enumerable: true,
    writable: false,
  });
  return Object.freeze(action) as WalletAction<Result>;
}

/** Internal validator kept out of the package entry points. */
export function walletActionName(action: WalletAction<unknown>): string {
  if (action[WALLET_ACTION] !== true) {
    throw new TypeError("Wallet.execute requires an action created by walletAction()");
  }
  return action.actionName;
}

/** Internal executor kept out of the package entry points. */
export async function runWalletAction<Result>(
  action: WalletAction<Result>,
  context: WalletExecutionContext<any, any>,
): Promise<Result> {
  walletActionName(action);
  return await action(context) as Result;
}
