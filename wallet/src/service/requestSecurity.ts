import type { IncomingMessage } from "node:http";

const LOOPBACK_AUTHORITIES = ["127.0.0.1", "localhost", "[::1]"] as const;

/** Return the exact loopback authority addressed by this request. */
export function loopbackRequestAuthority(request: IncomingMessage): string | undefined {
  const host = request.headers.host?.trim().toLowerCase();
  const port = request.socket.localPort;
  if (host === undefined || port === undefined) return undefined;
  if (LOOPBACK_AUTHORITIES.some((name) => host === `${name}:${port}`)) return host;
  if (port === 80 && LOOPBACK_AUTHORITIES.some((name) => host === name)) return host;
  return undefined;
}

/** Browser requests must be same-origin with the exact loopback listener. */
export function hasExpectedLoopbackOrigin(
  request: IncomingMessage,
  authority: string,
): boolean {
  const value = request.headers.origin;
  if (value === undefined) return true;
  try {
    const origin = new URL(value);
    return origin.protocol === "http:"
      && origin.host.toLowerCase() === authority
      && origin.username === ""
      && origin.password === ""
      && origin.pathname === "/"
      && origin.search === ""
      && origin.hash === "";
  } catch {
    return false;
  }
}
