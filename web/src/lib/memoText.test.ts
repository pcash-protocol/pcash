import { describe, expect, it } from "vitest";
import { MEMO_SHOWN_LENGTH, memoText } from "./memoText.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("memo display text", () => {
  it("removes bidi overrides and zero-width characters", () => {
    // U+202E would show "exe.txt" reversed; U+200B and U+FEFF hide inside words.
    expect(memoText(bytes("invoice‮txt.exe"))).toBe("invoicetxt.exe");
    expect(memoText("pa​y‍me⁦nt⁩ ﻿ok")).toBe("payment ok");
  });

  it("turns line breaks and tabs into single spaces and trims", () => {
    expect(memoText(bytes("\n  rent\r\n\tfor\u0000 May   "))).toBe("rent for May");
  });

  it("replaces invalid UTF-8 instead of throwing", () => {
    expect(memoText(Uint8Array.of(0x68, 0x69, 0xff, 0xc3))).toBe("hi��");
    expect(memoText(new Uint8Array(0))).toBe("");
  });

  it("cuts long text with an ellipsis without splitting a character", () => {
    expect(memoText("a".repeat(MEMO_SHOWN_LENGTH))).toBe("a".repeat(MEMO_SHOWN_LENGTH));
    expect(memoText("a".repeat(MEMO_SHOWN_LENGTH + 1))).toBe(`${"a".repeat(MEMO_SHOWN_LENGTH)}…`);
    const emoji = memoText("😀".repeat(MEMO_SHOWN_LENGTH + 5));
    expect([...emoji]).toHaveLength(MEMO_SHOWN_LENGTH + 1);
    expect(emoji.endsWith("😀…")).toBe(true);
  });
});
