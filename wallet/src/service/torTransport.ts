// Outbound HTTP for `--network-privacy tor`: every request is tunnelled
// through a Tor SOCKS5 port. The hostname goes to Tor unresolved, so DNS
// happens at the exit; TLS is verified here against that hostname; redirects
// are refused; and there is no fallback to a direct connection.
//
// Requests are grouped into sessions. Each session has its own connection
// pool and authenticates to the SOCKS port with fresh random credentials, and
// Tor's default IsolateSOCKSAuth puts streams with different credentials on
// different circuits. A server therefore cannot tie one session's requests to
// another's by connection or circuit.

import { randomBytes } from "node:crypto";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Agent, fetch as undiciFetch, type buildConnector } from "undici";
import { http, type Transport } from "viem";

export const DEFAULT_TOR_SOCKS = "127.0.0.1:9050";

/** Covers circuit construction, which Tor can take tens of seconds to finish on a cold start. */
const SOCKS_CONNECT_TIMEOUT_MS = 60_000;
/** One L1 RPC request over Tor, including a fresh circuit. */
const L1_RPC_TIMEOUT_MS = 90_000;

const V3_ONION_HOST = /^(?:[a-z0-9-]+\.)*[a-z2-7]{56}\.onion$/;

export interface SocksEndpoint {
  host: string;
  port: number;
}

export type TorFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function parseTorSocks(value: string): SocksEndpoint {
  const bracketed = /^\[([^\]]+)\]:([0-9]+)$/.exec(value);
  const plain = /^([^:[\]]+):([0-9]+)$/.exec(value);
  const match = bracketed ?? plain;
  const port = Number(match?.[2]);
  if (match === null || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--tor-socks expects host:port, got ${value}`);
  }
  return { host: match[1]!, port };
}

/**
 * A URL the wallet may reach through Tor: HTTPS to a named host, or HTTP to a
 * v3 onion service, whose address already authenticates it. A loopback or
 * IP-literal destination cannot be reached through an exit, so it is refused.
 */
export function assertTorDestination(value: string | URL, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  const host = url.hostname.toLowerCase();
  const onion = V3_ONION_HOST.test(host);
  if (url.protocol === "http:" && onion) return url;
  if (url.protocol !== "https:") {
    throw new Error(`${label} must be https:// or http:// to a v3 .onion address with --network-privacy tor`);
  }
  if (host.endsWith(".onion") && !onion) throw new Error(`${label} names an onion address that is not v3`);
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0 || host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(`${label} must name a remote host with --network-privacy tor`);
  }
  return url;
}

const SOCKS_REPLY_ERRORS: Record<number, string> = {
  0x01: "general failure",
  0x02: "connection not allowed",
  0x03: "network unreachable",
  0x04: "host unreachable",
  0x05: "connection refused",
  0x06: "TTL expired (Tor could not complete the connection in time)",
  0x07: "command not supported",
  0x08: "address type not supported",
  0xf0: "onion service descriptor not found",
  0xf1: "onion service descriptor invalid",
  0xf2: "onion service introduction failed",
  0xf3: "onion service rendezvous failed",
  0xf4: "onion service requires client authorization",
  0xf5: "onion service client authorization rejected",
  0xf6: "onion address invalid",
  0xf7: "onion service introduction timed out",
};

/** SOCKS5 username/password credentials (RFC 1929). Tor uses them only to choose a circuit. */
export interface SocksCredential {
  username: string;
  password: string;
}

function randomSocksCredential(): SocksCredential {
  return { username: randomBytes(16).toString("hex"), password: randomBytes(16).toString("hex") };
}

/**
 * Opens a SOCKS5 CONNECT tunnel to `host:port`, sending the hostname
 * unresolved and authenticating with `credential`.
 */
export function openSocksTunnel(
  socks: SocksEndpoint,
  credential: SocksCredential,
  host: string,
  port: number,
  timeoutMs = SOCKS_CONNECT_TIMEOUT_MS,
): Promise<Socket> {
  const name = Buffer.from(host, "utf8");
  if (name.length === 0 || name.length > 255) return Promise.reject(new Error(`cannot send host ${host} to the SOCKS proxy`));
  const username = Buffer.from(credential.username, "utf8");
  const password = Buffer.from(credential.password, "utf8");
  const proxy = `${socks.host}:${socks.port}`;
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: socks.host, port: socks.port });
    let buffered = Buffer.alloc(0);
    let stage: "greeting" | "auth" | "reply" = "greeting";
    const fail = (message: string, cause?: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`Tor SOCKS proxy ${proxy}: ${message}`, cause === undefined ? undefined : { cause }));
    };
    const timer = setTimeout(() => fail(`no CONNECT reply for ${host}:${port} within ${timeoutMs} ms`), timeoutMs);
    socket.once("error", (error) => fail(`${error.message}; is tor running?`, error));
    socket.once("close", () => fail(`closed the connection to ${host}:${port}`));
    socket.once("connect", () => socket.write(Buffer.from([0x05, 0x01, 0x02])));
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (stage === "greeting") {
        if (buffered.length < 2) return;
        if (buffered[0] !== 0x05 || buffered[1] !== 0x02) {
          return fail("does not accept SOCKS5 username/password authentication, which separates Tor circuits");
        }
        buffered = buffered.subarray(2);
        stage = "auth";
        const auth = Buffer.alloc(3 + username.length + password.length);
        auth.set([0x01, username.length]);
        username.copy(auth, 2);
        auth[2 + username.length] = password.length;
        password.copy(auth, 3 + username.length);
        socket.write(auth);
      }
      if (stage === "auth") {
        if (buffered.length < 2) return;
        if (buffered[0] !== 0x01 || buffered[1] !== 0x00) return fail("refused the SOCKS5 credentials");
        buffered = buffered.subarray(2);
        stage = "reply";
        const request = Buffer.alloc(7 + name.length);
        request.set([0x05, 0x01, 0x00, 0x03, name.length]);
        name.copy(request, 5);
        request.writeUInt16BE(port, 5 + name.length);
        socket.write(request);
      }
      if (buffered.length < 5) return;
      if (buffered[0] !== 0x05) return fail("sent a malformed CONNECT reply");
      const code = buffered[1]!;
      if (code !== 0x00) return fail(`CONNECT to ${host}:${port} failed: ${SOCKS_REPLY_ERRORS[code] ?? `code ${code}`}`);
      const addressType = buffered[3];
      const addressLength = addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : addressType === 0x03 ? 1 + buffered[4]! : -1;
      if (addressLength < 0) return fail("sent a malformed CONNECT reply");
      const replyLength = 4 + addressLength + 2;
      if (buffered.length < replyLength) return;
      // The destination speaks only after the client does, so nothing may follow the reply.
      if (buffered.length > replyLength) return fail("sent data before the tunnel was used");
      clearTimeout(timer);
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      socket.pause();
      resolve(socket);
    });
  });
}

function socksConnector(socks: SocksEndpoint, credential: SocksCredential): buildConnector.connector {
  return (options, callback) => {
    const https = options.protocol === "https:";
    const port = Number(options.port) || (https ? 443 : 80);
    openSocksTunnel(socks, credential, options.hostname, port).then((socket) => {
      if (!https) {
        callback(null, socket);
        return;
      }
      const secure = tlsConnect({ socket, servername: options.servername ?? options.hostname, ALPNProtocols: ["http/1.1"] });
      const onError = (error: Error) => callback(error, null);
      secure.once("error", onError);
      secure.once("secureConnect", () => {
        secure.off("error", onError);
        callback(null, secure);
      });
    }, (error: Error) => callback(error, null));
  };
}

/** One circuit-isolated group of requests. */
export interface TorSession {
  /** Sends a request through Tor. Only destinations accepted by {@link assertTorDestination} are dialled. */
  fetch: TorFetch;
  /** Closes the session's connections. */
  close(): Promise<void>;
}

export interface TorTransport {
  /** Opens a session with its own connection pool and fresh SOCKS credentials. */
  session(): TorSession;
  /** Closes every session still open. */
  close(): Promise<void>;
}

export function torTransport(socks: SocksEndpoint): TorTransport {
  const open = new Set<Agent>();
  return {
    session() {
      const dispatcher = new Agent({ connect: socksConnector(socks, randomSocksCredential()) });
      open.add(dispatcher);
      return {
        fetch: async (input, init) => {
          // A Request could carry its own redirect mode and body; callers pass a URL and init.
          if (input instanceof Request) throw new Error("Tor fetch takes a URL, not a Request");
          const url = assertTorDestination(input, "Tor request URL");
          const response = await undiciFetch(url, {
            ...(init as Parameters<typeof undiciFetch>[1]),
            redirect: "error",
            dispatcher,
          });
          return response as unknown as Response;
        },
        close: async () => {
          if (open.delete(dispatcher)) await dispatcher.close();
        },
      };
    },
    close: async () => {
      const dispatchers = [...open];
      open.clear();
      await Promise.all(dispatchers.map((dispatcher) => dispatcher.close()));
    },
  };
}

/** A viem transport for an Ethereum RPC endpoint reached through Tor. */
export function torL1Transport(fetchFn: TorFetch, url: string): Transport {
  assertTorDestination(url, "L1 RPC URL");
  return http(url, { fetchFn, timeout: L1_RPC_TIMEOUT_MS });
}
