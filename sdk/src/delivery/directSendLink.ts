// A direct send's link carries its opening in the URL fragment, which a
// browser never sends to a server.

import { decodeDirectSendOpening, encodeDirectSendOpening, type DirectSendOpening } from "../protocol/directSend.ts";
import { fromBase64Url, toBase64Url } from "../utils/bytes.ts";

export function formatDirectSendLink(opening: DirectSendOpening, pageUrl: string): string {
  const hash = pageUrl.indexOf("#");
  return `${hash < 0 ? pageUrl : pageUrl.slice(0, hash)}#${toBase64Url(encodeDirectSendOpening(opening))}`;
}

/** The opening a direct-send link, or its bare fragment, carries. */
export function parseDirectSendLink(text: string): DirectSendOpening {
  const trimmed = text.trim();
  const hash = trimmed.indexOf("#");
  return decodeDirectSendOpening(fromBase64Url(hash < 0 ? trimmed : trimmed.slice(hash + 1)));
}
