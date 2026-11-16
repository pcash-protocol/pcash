import { encodePost, type BoardNetwork } from "@pcash/board/codec";
import { applicationSchemaId, encodeRecords, decodeTransaction, accountCreationAttachmentSize } from "@pcash/sdk/protocol";
import { fromHex, toHex, utf8 } from "@pcash/sdk/utils";
import { describe, expect, it } from "vitest";
import { fixtureStatus, fixtureWorld } from "./fixtures/world.ts";
import { decodeArena, transactionArena } from "./arena.ts";

const network: BoardNetwork = { chainId: BigInt(fixtureStatus.pcashChainId), genesisHash: fixtureStatus.genesisHash };
const S_ARENA_BYTES = 2_632;

/** An S arena whose public segment holds `records`, laid out as a reader finds it: salt, marker, length, list, zero padding. */
function publicArena(records: Parameters<typeof encodeRecords>[0]): Uint8Array {
  const list = encodeRecords(records);
  const arena = new Uint8Array(S_ARENA_BYTES);
  arena.fill(0xab, 0, 32);
  arena.set(utf8("PCASHPUB"), 32);
  arena.set([list.length >> 8, list.length & 0xff], 40);
  arena.set(list, 42);
  return arena;
}

describe("transaction arena", () => {
  it("precedes the trailing creation attachment", () => {
    const transaction = fixtureWorld.transactions.find(({ summary }) => summary.kind === "privateValue")!;
    const raw = fromHex(transaction.rawTransaction);
    const arena = transactionArena(transaction.rawTransaction)!;
    expect([2_632, 16_672]).toContain(arena.length);
    const decoded = decodeTransaction(raw);
    if (decoded.kind !== 0) throw new Error("expected private value");
    const end = raw.length - accountCreationAttachmentSize(decoded.accountCreation);
    expect(toHex(arena)).toBe(toHex(raw.subarray(end - arena.length, end)));
  });

  it("is absent from a user account creation and present in an account update's section", () => {
    const creation = fixtureWorld.transactions.find(({ summary }) => summary.kind === "userAccountCreation")!;
    expect(transactionArena(creation.rawTransaction)).toBeNull();
    const update = fixtureWorld.transactions.find(({ summary }) => summary.kind === "userAccountUpdate")!;
    expect(transactionArena(update.rawTransaction)?.length).toBe(S_ARENA_BYTES);
  });

  it("has no public records when every cell is encrypted or filler", () => {
    const transaction = fixtureWorld.transactions.find(({ summary }) => summary.kind === "privateValue")!;
    const decoded = decodeArena(network, transactionArena(transaction.rawTransaction)!);
    expect(decoded.publicRecords).toBeNull();
    expect(decoded.salt).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("decodes a message board post and keeps an unknown record opaque", () => {
    const { post, record } = encodePost(network, { board: `0x${"11".repeat(32)}`, text: "gm from the arena" });
    const other = { schema: applicationSchemaId("org.example.note"), data: utf8("plain words") };
    const decoded = decodeArena(network, publicArena([record, other]));
    expect(decoded.cells).toBe(40);
    expect(decoded.salt).toBe(`0x${"ab".repeat(32)}`);
    const posted = decoded.publicRecords!.find(({ kind }) => kind === "boardPost");
    expect(posted).toMatchObject({ kind: "boardPost", postId: post.id, board: post.board, parent: null, text: "gm from the arena" });
    expect(decoded.publicRecords!.find(({ kind }) => kind === "unknown")).toMatchObject({ schema: other.schema, text: "plain words", data: toHex(other.data) });
  });
});
