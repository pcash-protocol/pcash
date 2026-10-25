import type {
  DurableSubmissionCallbacks,
  DurableSubmissionPhase,
} from "./actions/durableSubmission.ts";
import type { StatusResult } from "@pcash/sdk/clients";
import type { WalletSnapshot } from "./actions/walletClient.ts";

export interface WalletEventWallet {
  readonly address: string;
  readonly network: Readonly<{ chainId: bigint; genesisHash: string }>;
  readonly spendable: boolean;
}

export interface WalletEventContext {
  readonly wallet: WalletEventWallet;
}

export interface WalletActionEventContext extends WalletEventContext {
  readonly action: Readonly<{ id: string; name: string }>;
}

export interface WalletPreparedEvent extends WalletActionEventContext {
  readonly contentHash: string;
  readonly transactionHex: string;
}

export interface WalletEventMap {
  snapshot: WalletEventContext & { readonly snapshot: WalletSnapshot };
  "sync:started": WalletEventContext;
  /** The followed node reported a new tip or index cursor. */
  "sync:tip": WalletEventContext & { readonly status: StatusResult };
  "sync:progress": WalletEventContext & {
    readonly phase?: string;
    readonly syncedThrough?: { pcashNumber: bigint; pcashHash: string };
  };
  "sync:completed": WalletEventContext & {
    readonly syncedThrough: { pcashNumber: bigint; pcashHash: string };
  };
  "sync:error": WalletEventContext & { readonly error: Error };
  "action:started": WalletActionEventContext;
  "action:progress": WalletActionEventContext & {
    readonly phase: string;
    readonly message: string;
  };
  "action:before-journal": WalletPreparedEvent;
  "action:prepared": WalletPreparedEvent;
  "action:completed": WalletActionEventContext;
  "action:error": WalletActionEventContext & { readonly error: Error };
}

export interface WalletHookMap {
  "action:before-journal": WalletPreparedEvent;
  "action:prepared": WalletPreparedEvent;
}

export type WalletEventName = keyof WalletEventMap;
export type WalletHookName = keyof WalletHookMap;
export type WalletEventListener<Name extends WalletEventName> =
  (event: Readonly<WalletEventMap[Name]>) => void | Promise<void>;
export type WalletHookListener<Name extends WalletHookName> =
  (event: Readonly<WalletHookMap[Name]>) => void | Promise<void>;

export interface WalletActionLifecycle {
  readonly context: WalletActionEventContext;
  progress(phase: string, message: string): void;
  beforeJournal(contentHash: string, transactionHex: string): Promise<void>;
  prepared(contentHash: string, transactionHex: string): Promise<void>;
  durableCallbacks(callbacks?: DurableSubmissionCallbacks): DurableSubmissionCallbacks;
}

interface WalletActionSession {
  readonly lifecycle: WalletActionLifecycle;
  complete(): void;
  fail(error: Error): void;
  close(): void;
}

type Listener = (event: never) => void | Promise<void>;

/** Small browser-safe typed registry; Node EventEmitter semantics are intentionally avoided. */
export class WalletEventRegistry {
  readonly #listeners = new Map<WalletEventName, Set<Listener>>();
  readonly #hooks = new Map<WalletHookName, Set<Listener>>();
  #actionSequence = 0;

  on<Name extends WalletEventName>(name: Name, listener: WalletEventListener<Name>): () => void {
    const listeners = this.#listeners.get(name) ?? new Set<Listener>();
    listeners.add(listener as Listener);
    this.#listeners.set(name, listeners);
    return () => {
      listeners.delete(listener as Listener);
      if (listeners.size === 0) this.#listeners.delete(name);
    };
  }

  hook<Name extends WalletHookName>(name: Name, listener: WalletHookListener<Name>): () => void {
    const hooks = this.#hooks.get(name) ?? new Set<Listener>();
    hooks.add(listener as Listener);
    this.#hooks.set(name, hooks);
    return () => {
      hooks.delete(listener as Listener);
      if (hooks.size === 0) this.#hooks.delete(name);
    };
  }

  count(name: WalletEventName): number {
    return this.#listeners.get(name)?.size ?? 0;
  }

  emit<Name extends WalletEventName>(name: Name, event: WalletEventMap[Name]): void {
    const immutable = Object.freeze(event);
    for (const listener of [...(this.#listeners.get(name) ?? [])]) {
      try {
        void Promise.resolve(listener(immutable as never)).catch(() => undefined);
      } catch {
        // Observers cannot change wallet execution.
      }
    }
  }

  async runHooks<Name extends WalletHookName>(name: Name, event: WalletHookMap[Name]): Promise<void> {
    for (const listener of [...(this.#hooks.get(name) ?? [])]) {
      await listener(event as never);
    }
  }

  startAction(wallet: WalletEventWallet, name: string): WalletActionSession {
    const context: WalletActionEventContext = Object.freeze({
      wallet,
      action: Object.freeze({ id: `${++this.#actionSequence}`, name }),
    });
    let active = true;
    const assertActive = () => {
      if (!active) throw new Error("wallet action lifecycle is no longer active");
    };
    const preparedEvent = (contentHash: string, transactionHex: string): WalletPreparedEvent => Object.freeze({
      ...context,
      contentHash,
      transactionHex,
    });
    let lifecycle!: WalletActionLifecycle;
    lifecycle = Object.freeze({
      context,
      progress: (phase: string, message: string) => {
        assertActive();
        this.emit("action:progress", { ...context, phase, message });
      },
      beforeJournal: async (contentHash: string, transactionHex: string) => {
        assertActive();
        const event = preparedEvent(contentHash, transactionHex);
        this.emit("action:before-journal", event);
        await this.runHooks("action:before-journal", event);
      },
      prepared: async (contentHash: string, transactionHex: string) => {
        assertActive();
        const event = preparedEvent(contentHash, transactionHex);
        this.emit("action:prepared", event);
        await this.runHooks("action:prepared", event);
      },
      durableCallbacks: (callbacks: DurableSubmissionCallbacks = {}) => ({
        beforeJournal: async (contentHash: string, transactionHex: string) => {
          await lifecycle.beforeJournal(contentHash, transactionHex);
          await callbacks.beforeJournal?.(contentHash, transactionHex);
        },
        onPrepared: async (contentHash: string, transactionHex: string) => {
          await lifecycle.prepared(contentHash, transactionHex);
          await callbacks.onPrepared?.(contentHash, transactionHex);
        },
        onProgress: (
          phase: DurableSubmissionPhase,
          message: string,
        ) => {
          lifecycle.progress(phase, message);
          try {
            callbacks.onProgress?.(phase, message);
          } catch {
            // Progress callbacks are observers, just like event listeners.
          }
        },
        ...(callbacks.nowUnixMilliseconds === undefined ? {} : {
          nowUnixMilliseconds: callbacks.nowUnixMilliseconds,
        }),
      }),
    });
    this.emit("action:started", context);
    return Object.freeze({
      lifecycle,
      complete: () => this.emit("action:completed", context),
      fail: (error: Error) => this.emit("action:error", { ...context, error }),
      close: () => { active = false; },
    });
  }

  clear(): void {
    this.#listeners.clear();
    this.#hooks.clear();
  }
}
