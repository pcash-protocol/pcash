/** Characters of a memo shown before it is cut. */
export const MEMO_SHOWN_LENGTH = 200;

// Not fatal: invalid UTF-8 becomes U+FFFD.
const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * A memo as plain text for display. The sender writes it and anyone can send
 * anything: line breaks and tabs become spaces, other control and format
 * characters (bidi overrides, zero-width characters) are removed, whitespace
 * collapses, and long text is cut with an ellipsis.
 */
export function memoText(memo: Uint8Array | string): string {
  const decoded = typeof memo === "string" ? memo : decoder.decode(memo);
  const cleaned = decoded
    .replace(/[\p{Cc}\p{Cf}]/gu, (char) => /\s/u.test(char) ? " " : "")
    .replace(/\s+/gu, " ")
    .trim();
  const chars = [...cleaned];
  return chars.length <= MEMO_SHOWN_LENGTH ? cleaned : `${chars.slice(0, MEMO_SHOWN_LENGTH).join("").trimEnd()}…`;
}
