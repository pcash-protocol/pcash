import type { StatusResult } from "@pcash/sdk/clients";

const DATABASE_NAME = "pcash-profile-session";
const DATABASE_VERSION = 1;
const SESSION_STORE = "session";

export interface ProfileSessionIdentity {
  pcashChainId: string;
  l1ChainId: string;
  genesisHash: string;
  inboxAddress: string;
  account: string;
}

export function profileSessionIdentity(current: Pick<StatusResult, "pcashChainId" | "l1ChainId" | "genesisHash" | "inboxAddress">, account: string): ProfileSessionIdentity {
  return {
    pcashChainId: current.pcashChainId.toString(),
    genesisHash: current.genesisHash,
    l1ChainId: current.l1ChainId.toString(),
    inboxAddress: current.inboxAddress,
    account,
  };
}

interface StoredProfileSession extends ProfileSessionIdentity {
  key: string;
  signature: string;
}

interface StoredMutationRevision {
  key: string;
  revision: number;
}

export type LoadedProfileSession =
  | { state: "absent"; revision: number }
  | { state: "match"; revision: number; signature: string };

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("profile session IndexedDB request failed"));
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("profile session IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("profile session IndexedDB transaction failed"));
  });
}

function normalizedIdentity(identity: ProfileSessionIdentity): ProfileSessionIdentity {
  return {
    pcashChainId: identity.pcashChainId,
    l1ChainId: identity.l1ChainId,
    genesisHash: identity.genesisHash.toLowerCase(),
    inboxAddress: identity.inboxAddress.toLowerCase(),
    account: identity.account.toLowerCase(),
  };
}

function storedSession(value: unknown): StoredProfileSession | null {
  return value === undefined ? null : value as StoredProfileSession;
}

export function profileSessionKey(identity: ProfileSessionIdentity): string {
  const normalized = normalizedIdentity(identity);
  return JSON.stringify([normalized.pcashChainId, normalized.l1ChainId, normalized.genesisHash,
    normalized.inboxAddress, normalized.account]);
}

function revisionKey(identity: ProfileSessionIdentity): string {
  return `revision:${profileSessionKey(identity)}`;
}

function mutationRevision(value: StoredMutationRevision | undefined): number {
  return value?.revision ?? 0;
}

export function createProfileSessionStore(scope: string) {
  const channelName = `${DATABASE_NAME}:${scope}`;
  let changeChannel: BroadcastChannel | undefined;
  const signOutListeners = new Set<(key: string, revision: number) => void>();
  const changeListeners = new Set<(key: string, revision: number) => void>();

  function publishChange(identity: ProfileSessionIdentity, revision: number, signedOut: boolean): void {
    if (typeof BroadcastChannel === "undefined") return;
    // Reuse the listening channel: BroadcastChannel never echoes to its sender.
    const channel = changeChannel ?? new BroadcastChannel(channelName);
    channel.postMessage({ key: profileSessionKey(identity), revision, signedOut });
    if (channel !== changeChannel) channel.close();
  }

  function subscribe(listeners: Set<(key: string, revision: number) => void>, listener: (key: string, revision: number) => void): () => void {
    if (typeof BroadcastChannel === "undefined") return () => undefined;
    listeners.add(listener);
    if (changeChannel === undefined) {
      changeChannel = new BroadcastChannel(channelName);
      changeChannel.onmessage = (event: MessageEvent<{ key: string; revision: number; signedOut: boolean }>) => {
        for (const notify of changeListeners) notify(event.data.key, event.data.revision);
        if (event.data.signedOut) for (const notify of signOutListeners) notify(event.data.key, event.data.revision);
      };
    }
    return () => {
      listeners.delete(listener);
      if (signOutListeners.size === 0 && changeListeners.size === 0) {
        changeChannel?.close();
        changeChannel = undefined;
      }
    };
  }

  function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const opening = indexedDB.open(`${DATABASE_NAME}:${scope}`, DATABASE_VERSION);
      opening.onupgradeneeded = () => {
        if (!opening.result.objectStoreNames.contains(SESSION_STORE)) {
          opening.result.createObjectStore(SESSION_STORE, { keyPath: "key" });
        }
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error ?? new Error("profile session IndexedDB could not be opened"));
      opening.onblocked = () => reject(new Error("profile session IndexedDB open is blocked by another tab"));
    });
  }

  async function profileSessionRevision(identity: ProfileSessionIdentity): Promise<number> {
    if (globalThis.indexedDB === undefined) return 0;
    const database = await openDatabase();
    try {
      const transaction = database.transaction(SESSION_STORE, "readonly");
      const done = completed(transaction);
      const revision = mutationRevision(await request(transaction.objectStore(SESSION_STORE).get(revisionKey(identity))));
      await done;
      return revision;
    } finally {
      database.close();
    }
  }

  async function loadProfileSession(identity: ProfileSessionIdentity): Promise<LoadedProfileSession> {
    if (globalThis.indexedDB === undefined) return { state: "absent", revision: 0 };
    const database = await openDatabase();
    try {
      const transaction = database.transaction(SESSION_STORE, "readonly");
      const done = completed(transaction);
      const store = transaction.objectStore(SESSION_STORE);
      const [value, revision] = await Promise.all([
        request(store.get(profileSessionKey(identity))).then(storedSession),
        request(store.get(revisionKey(identity))).then(mutationRevision),
      ]);
      await done;
      if (value === null) return { state: "absent", revision };
      return { state: "match", revision, signature: value.signature };
    } finally {
      database.close();
    }
  }

  async function saveProfileSession(
    identity: ProfileSessionIdentity,
    signature: string,
    expectedRevision: number,
  ): Promise<number | null> {
    if (globalThis.indexedDB === undefined) throw new Error("remembering a PCASH sign-in requires IndexedDB");
    const database = await openDatabase();
    try {
      const transaction = database.transaction(SESSION_STORE, "readwrite", { durability: "strict" });
      const done = completed(transaction);
      if (transaction.durability !== "strict") {
        transaction.abort();
        await done.catch(() => undefined);
        throw new Error("profile sign-in persistence requires strict IndexedDB durability");
      }
      const store = transaction.objectStore(SESSION_STORE);
      const currentRevision = mutationRevision(await request(store.get(revisionKey(identity))));
      if (currentRevision !== expectedRevision) {
        await done;
        return null;
      }
      store.put({
        key: profileSessionKey(identity),
        ...normalizedIdentity(identity),
        signature,
      } satisfies StoredProfileSession);
      store.put({ key: revisionKey(identity), revision: currentRevision + 1 } satisfies StoredMutationRevision);
      await done;
      publishChange(identity, currentRevision + 1, false);
      return currentRevision + 1;
    } finally {
      database.close();
    }
  }

  async function clearProfileSessionIfRevision(identity: ProfileSessionIdentity, expectedRevision: number): Promise<boolean> {
    if (globalThis.indexedDB === undefined) return false;
    const database = await openDatabase();
    try {
      const transaction = database.transaction(SESSION_STORE, "readwrite", { durability: "strict" });
      const done = completed(transaction);
      if (transaction.durability !== "strict") {
        transaction.abort();
        await done.catch(() => undefined);
        throw new Error("profile sign-in persistence requires strict IndexedDB durability");
      }
      const store = transaction.objectStore(SESSION_STORE);
      const revision = mutationRevision(await request(store.get(revisionKey(identity))));
      if (revision !== expectedRevision) {
        await done;
        return false;
      }
      store.delete(profileSessionKey(identity));
      store.put({ key: revisionKey(identity), revision: revision + 1 } satisfies StoredMutationRevision);
      await done;
      publishChange(identity, revision + 1, true);
      return true;
    } finally {
      database.close();
    }
  }

  return {
    subscribeToSignOut: (listener: (key: string, revision: number) => void) => subscribe(signOutListeners, listener),
    subscribeToChanges: (listener: (key: string, revision: number) => void) => subscribe(changeListeners, listener),
    profileSessionRevision, loadProfileSession, saveProfileSession, clearProfileSessionIfRevision,
  };
}
