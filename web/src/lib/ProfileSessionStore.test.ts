import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProfileSessionStore, profileSessionKey, type ProfileSessionIdentity } from "./ProfileSessionStore.ts";
const sender = createProfileSessionStore("test");
const { clearProfileSessionIfRevision, loadProfileSession, profileSessionRevision, saveProfileSession } = sender;

const IDENTITY: ProfileSessionIdentity = {
  pcashChainId: "31337",
  l1ChainId: "11155111",
  genesisHash: `0x${"12".repeat(32)}`,
  inboxAddress: `0x${"ab".repeat(20)}`,
  account: `0x${"cd".repeat(20)}`,
};
const OTHER_IDENTITY = { ...IDENTITY, account: `0x${"57".repeat(20)}` };
const SIGNATURE = `0x${"78".repeat(65)}`;
const OTHER_SIGNATURE = `0x${"79".repeat(65)}`;

async function save(identity = IDENTITY, signature = SIGNATURE): Promise<number | null> {
  return saveProfileSession(identity, signature, await profileSessionRevision(identity));
}

async function clear(identity = IDENTITY, store = sender): Promise<boolean> {
  return store.clearProfileSessionIfRevision(identity, await store.profileSessionRevision(identity));
}

describe("ProfileSessionStore", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  });

  it("restores a normalized address and network through a new store instance", async () => {
    await save();
    await expect(createProfileSessionStore("test").loadProfileSession({
      ...IDENTITY,
      account: IDENTITY.account.toUpperCase(),
      inboxAddress: IDENTITY.inboxAddress.toUpperCase(),
    })).resolves.toMatchObject({ state: "match", signature: SIGNATURE });
  });

  it.each([
    OTHER_IDENTITY,
    { ...IDENTITY, pcashChainId: "31338" },
    { ...IDENTITY, l1ChainId: "1" },
    { ...IDENTITY, genesisHash: `0x${"13".repeat(32)}` },
    { ...IDENTITY, inboxAddress: `0x${"13".repeat(20)}` },
  ])("keeps independent credentials and revisions for %j", async (other) => {
    await save();
    await expect(loadProfileSession(other)).resolves.toEqual({ state: "absent", revision: 0 });
    await expect(saveProfileSession(other, OTHER_SIGNATURE, 0)).resolves.toBe(1);
    await expect(loadProfileSession(IDENTITY)).resolves.toMatchObject({ state: "match", signature: SIGNATURE });
    await expect(loadProfileSession(other)).resolves.toMatchObject({ state: "match", signature: OTHER_SIGNATURE });
    await clear();
    await expect(loadProfileSession(IDENTITY)).resolves.toMatchObject({ state: "absent" });
    await expect(loadProfileSession(other)).resolves.toMatchObject({ state: "match", signature: OTHER_SIGNATURE });
  });

  it("keeps other network stores signed in when one network forgets its sign-in", async () => {
    await save();
    const other = createProfileSessionStore("other-network");
    await other.saveProfileSession(IDENTITY, OTHER_SIGNATURE, 0);
    await clear(IDENTITY, other);
    await expect(loadProfileSession(IDENTITY)).resolves.toMatchObject({ state: "match", signature: SIGNATURE });
  });

  it("rejects a pending signature save after the credential is cleared", async () => {
    const staleRevision = await profileSessionRevision(IDENTITY);
    await clear();
    await expect(saveProfileSession(IDENTITY, SIGNATURE, staleRevision)).resolves.toBeNull();
    await expect(loadProfileSession(IDENTITY)).resolves.toMatchObject({ state: "absent" });
  });

  it("does not let a stale save overwrite a newer sign-in", async () => {
    await expect(saveProfileSession(IDENTITY, OTHER_SIGNATURE, 0)).resolves.toBe(1);
    await expect(saveProfileSession(IDENTITY, SIGNATURE, 0)).resolves.toBeNull();
    await expect(loadProfileSession(IDENTITY)).resolves.toMatchObject({ state: "match", signature: OTHER_SIGNATURE });
  });

  it("does not let stale cleanup delete a newer credential or another wallet", async () => {
    const firstRevision = await save();
    const secondRevision = await save();
    await save(OTHER_IDENTITY, OTHER_SIGNATURE);
    await expect(clearProfileSessionIfRevision(IDENTITY, firstRevision!)).resolves.toBe(false);
    await expect(loadProfileSession(IDENTITY)).resolves.toMatchObject({ state: "match", revision: secondRevision });
    await expect(clearProfileSessionIfRevision(IDENTITY, secondRevision!)).resolves.toBe(true);
    await expect(loadProfileSession(IDENTITY)).resolves.toMatchObject({ state: "absent" });
    await expect(loadProfileSession(OTHER_IDENTITY)).resolves.toMatchObject({ state: "match", signature: OTHER_SIGNATURE });
  });

  it("notifies other tabs only after the credential is forgotten", async () => {
    await save();
    const echo = vi.fn();
    const stopSender = sender.subscribeToSignOut(echo);
    const observer = createProfileSessionStore("test");
    let unsubscribe = () => {};
    const notification = new Promise<{ key: string; revision: number }>((resolve) => {
      unsubscribe = observer.subscribeToSignOut((key, revision) => resolve({ key, revision }));
    });
    try {
      await clear();
      await expect(notification).resolves.toEqual({ key: profileSessionKey(IDENTITY), revision: 2 });
      await expect(observer.loadProfileSession(IDENTITY)).resolves.toMatchObject({ state: "absent" });
      expect(echo).not.toHaveBeenCalled();
    } finally { unsubscribe(); stopSender(); }
  });
});


it("announces new cached sign-ins without signing out existing sessions", async () => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  const writer = createProfileSessionStore("cache-change-test");
  const reader = createProfileSessionStore("cache-change-test");
  const signedOut = vi.fn();
  const stopSignOut = reader.subscribeToSignOut(signedOut);
  let stopChanges = () => {};
  const notification = new Promise<{ key: string; revision: number }>((resolve) => {
    stopChanges = reader.subscribeToChanges((key, revision) => resolve({ key, revision }));
  });
  try {
    await writer.saveProfileSession(IDENTITY, SIGNATURE, 0);
    await expect(notification).resolves.toEqual({ key: profileSessionKey(IDENTITY), revision: 1 });
    await expect(reader.loadProfileSession(IDENTITY)).resolves.toMatchObject({ state: "match", signature: SIGNATURE });
    expect(signedOut).not.toHaveBeenCalled();
  } finally { stopChanges(); stopSignOut(); }
});
