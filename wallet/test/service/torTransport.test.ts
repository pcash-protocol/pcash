import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PcashNodeClient } from "@pcash/sdk/clients";
import { SelectedRelayHttpClient } from "@pcash/sdk/relay";
import { createPublicClient } from "viem";
import {
  assertTorDestination,
  openSocksTunnel,
  parseTorSocks,
  torL1Transport,
  torTransport,
  type SocksEndpoint,
} from "../../src/service/torTransport.ts";

const ONION = `${"a".repeat(56)}.onion`;

// Self-signed for node.example; no system root vouches for it.
const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgrPvb7FvCYuddqcUU
DM7Zx4ikqP2CI/77U1MQgf8tEMKhRANCAAR3TDV6woQQ1T4luswJjuygCWFUTOgk
UcCR+JYr3CBUopLtEX+qbs0Vf1gtjskQJ1CQmQGNv4OHmk0f2Wxav6O1
-----END PRIVATE KEY-----`;
const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIBfjCCASOgAwIBAgIUEvxoIw/6Ing2jUyJUw7HCiWDPcAwCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMbm9kZS5leGFtcGxlMCAXDTI2MTAyNTA2MzAwN1oYDzIxMjYx
MDAxMDYzMDA3WjAXMRUwEwYDVQQDDAxub2RlLmV4YW1wbGUwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAAR3TDV6woQQ1T4luswJjuygCWFUTOgkUcCR+JYr3CBUopLt
EX+qbs0Vf1gtjskQJ1CQmQGNv4OHmk0f2Wxav6O1o0swSTAdBgNVHQ4EFgQUxzfy
+EWD4T0TMttGk3uk+ngSd0EwDwYDVR0TAQH/BAUwAwEB/zAXBgNVHREEEDAOggxu
b2RlLmV4YW1wbGUwCgYIKoZIzj0EAwIDSQAwRgIhAL50xyGMU2TM4OhLRre82t9K
A5WiDrL7plVs1FzZLRJlAiEAwvWAaXfOOnx1UoxhTgUxjSpB6kXSRs8PDNTVWm+r
+z8=
-----END CERTIFICATE-----`;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of closers.splice(0).reverse()) await close();
});

async function listen(server: Server | HttpServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

interface Connect { addressType: number; host: string; port: number }

const CREDENTIAL = { username: "user", password: "pass" };

/**
 * A SOCKS5 proxy that records each CONNECT and the username it was
 * authenticated with, and either answers with `reply` or splices the client to
 * `upstreamPort` on loopback, as Tor would to the exit.
 */
async function fakeSocks(options: { upstreamPort?: number; reply?: number; silent?: boolean; noAuth?: boolean } = {}) {
  const connects: Connect[] = [];
  const usernames: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    let buffered = Buffer.alloc(0);
    let stage: "greeting" | "auth" | "connect" = "greeting";
    let username = "";
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (stage === "greeting") {
        if (buffered.length < 2 || buffered.length < 2 + buffered[1]!) return;
        const methods = [...buffered.subarray(2, 2 + buffered[1]!)];
        buffered = buffered.subarray(2 + buffered[1]!);
        if (options.noAuth || !methods.includes(0x02)) {
          client.end(Buffer.from([0x05, 0xff]));
          return;
        }
        stage = "auth";
        client.write(Buffer.from([0x05, 0x02]));
      }
      if (stage === "auth") {
        if (buffered.length < 2) return;
        const usernameLength = buffered[1]!;
        if (buffered.length < 3 + usernameLength) return;
        const passwordLength = buffered[2 + usernameLength]!;
        if (buffered.length < 3 + usernameLength + passwordLength) return;
        username = buffered.subarray(2, 2 + usernameLength).toString("utf8");
        buffered = buffered.subarray(3 + usernameLength + passwordLength);
        stage = "connect";
        client.write(Buffer.from([0x01, 0x00]));
      }
      if (buffered.length < 5) return;
      const addressType = buffered[3]!;
      const nameLength = buffered[4]!;
      if (buffered.length < 7 + nameLength) return;
      const host = buffered.subarray(5, 5 + nameLength).toString("utf8");
      const port = buffered.readUInt16BE(5 + nameLength);
      connects.push({ addressType, host, port });
      usernames.push(username);
      client.off("data", onData);
      if (options.silent) return;
      const answer = (code: number) => client.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      if (options.upstreamPort === undefined) {
        answer(options.reply ?? 0x05);
        client.end();
        return;
      }
      const upstream = connect({ host: "127.0.0.1", port: options.upstreamPort }, () => {
        answer(0x00);
        client.pipe(upstream).pipe(client);
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    };
    client.on("data", onData);
  });
  const port = await listen(server);
  closers.push(async () => { for (const socket of sockets) socket.destroy(); });
  return { socks: { host: "127.0.0.1", port } satisfies SocksEndpoint, connects, usernames };
}

describe("Tor destinations", () => {
  it("accepts HTTPS to a named host and HTTP or HTTPS to a v3 onion service", () => {
    expect(assertTorDestination("https://rpc.example.org/v1", "--rpc-url").hostname).toBe("rpc.example.org");
    expect(assertTorDestination(`http://${ONION}:8645`, "--rpc-url").hostname).toBe(ONION);
    expect(assertTorDestination(`https://api.${ONION}`, "--rpc-url").hostname).toBe(`api.${ONION}`);
  });

  it("refuses clear HTTP, local and IP-literal hosts, and non-v3 onion addresses", () => {
    for (const url of ["http://rpc.example.org", "http://127.0.0.1:8645", "ftp://rpc.example.org"]) {
      expect(() => assertTorDestination(url, "--rpc-url")).toThrow(/https:\/\/ or http:\/\/ to a v3 \.onion/);
    }
    for (const url of ["https://127.0.0.1:8645", "https://[::1]:8645", "https://localhost", "https://node.localhost", "https://203.0.113.7"]) {
      expect(() => assertTorDestination(url, "--rpc-url")).toThrow(/remote host/);
    }
    expect(() => assertTorDestination("https://expyuzz4wqqyqhjn.onion", "--rpc-url")).toThrow(/not v3/);
    expect(() => assertTorDestination("/relative", "--rpc-url")).toThrow(/absolute URL/);
  });

  it("parses the SOCKS endpoint", () => {
    expect(parseTorSocks("127.0.0.1:9050")).toEqual({ host: "127.0.0.1", port: 9050 });
    expect(parseTorSocks("[::1]:9150")).toEqual({ host: "::1", port: 9150 });
    expect(parseTorSocks("tor:9050")).toEqual({ host: "tor", port: 9050 });
    for (const value of ["127.0.0.1", "127.0.0.1:0", "127.0.0.1:70000", ":9050"]) {
      expect(() => parseTorSocks(value)).toThrow(/--tor-socks expects host:port/);
    }
  });
});

describe("SOCKS5 tunnel", () => {
  it("sends the hostname to the proxy unresolved", async () => {
    const { socks, connects, usernames } = await fakeSocks({ reply: 0x05 });
    await expect(openSocksTunnel(socks, CREDENTIAL, "rpc.example.org", 443)).rejects.toThrow(/CONNECT to rpc\.example\.org:443 failed: connection refused/);
    expect(connects).toEqual([{ addressType: 0x03, host: "rpc.example.org", port: 443 }]);
    expect(usernames).toEqual([CREDENTIAL.username]);
  });

  it("refuses a proxy that cannot separate circuits by credentials", async () => {
    const { socks, connects } = await fakeSocks({ noAuth: true });
    await expect(openSocksTunnel(socks, CREDENTIAL, "rpc.example.org", 443)).rejects.toThrow(/username\/password authentication/);
    expect(connects).toEqual([]);
  });

  it("names Tor's onion-service failures", async () => {
    const { socks } = await fakeSocks({ reply: 0xf0 });
    await expect(openSocksTunnel(socks, CREDENTIAL, ONION, 80)).rejects.toThrow(/onion service descriptor not found/);
  });

  it("fails when the proxy is not listening", async () => {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    closers.pop();
    await expect(openSocksTunnel({ host: "127.0.0.1", port }, CREDENTIAL, "rpc.example.org", 443)).rejects.toThrow(/is tor running\?/);
  });

  it("gives up when the proxy never answers CONNECT", async () => {
    const { socks } = await fakeSocks({ silent: true });
    await expect(openSocksTunnel(socks, CREDENTIAL, "rpc.example.org", 443, 50)).rejects.toThrow(/no CONNECT reply/);
  });
});

describe("Tor fetch", () => {
  it("gives each session its own credentials and keeps them for every connection it opens", async () => {
    // Closing each connection makes every request open a new tunnel.
    const upstream = createHttpServer((_request, response) => {
      response.setHeader("connection", "close");
      response.end("ok");
    });
    const { socks, usernames } = await fakeSocks({ upstreamPort: await listen(upstream) });
    const transport = torTransport(socks);
    closers.push(() => transport.close());
    const first = transport.session();
    const second = transport.session();
    for (const session of [first, second, first, second]) {
      await expect((await session.fetch(`http://${ONION}/`)).text()).resolves.toBe("ok");
    }
    expect(usernames).toHaveLength(4);
    expect(usernames[2]).toBe(usernames[0]);
    expect(usernames[3]).toBe(usernames[1]);
    expect(usernames[1]).not.toBe(usernames[0]);
    expect(usernames[0]).toMatch(/^[0-9a-f]{32}$/);
    // A closed session sends nothing more; the other is unaffected.
    await first.close();
    await expect(first.fetch(`http://${ONION}/`)).rejects.toThrow();
    await expect((await second.fetch(`http://${ONION}/`)).text()).resolves.toBe("ok");
    expect(usernames).toHaveLength(5);
  });

  it("carries requests through the proxy and never through the global fetch", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("global fetch must not be used"); });
    const requests: string[] = [];
    const upstream = createHttpServer((request, response) => {
      requests.push(`${request.method} ${request.headers.host} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
    const { socks, connects } = await fakeSocks({ upstreamPort: await listen(upstream) });
    const transport = torTransport(socks);
    closers.push(() => transport.close());
    const tor = transport.session();
    const response = await tor.fetch(`http://${ONION}:8645/rpc`, { method: "POST", body: "{}" });
    expect(await response.json()).toEqual({ ok: true });
    expect(connects).toEqual([{ addressType: 0x03, host: ONION, port: 8645 }]);
    expect(requests).toEqual([`POST ${ONION}:8645 /rpc`]);
  });

  it("serves the node RPC client and the selected relay client", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("global fetch must not be used"); });
    const upstream = createHttpServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/selected/info") {
          response.end(JSON.stringify({ recipient: "7", maxQuoteLifetimeSeconds: "60" }));
          return;
        }
        const { id, method } = JSON.parse(body) as { id: number; method: string };
        response.end(JSON.stringify({ jsonrpc: "2.0", id, result: method }));
      });
    });
    const { socks, connects } = await fakeSocks({ upstreamPort: await listen(upstream) });
    const transport = torTransport(socks);
    closers.push(() => transport.close());
    const tor = transport.session();
    await expect(new PcashNodeClient(`http://${ONION}:8645`, { fetchFn: tor.fetch }).call("pcash_probe")).resolves.toBe("pcash_probe");
    const relay = await SelectedRelayHttpClient.connect(`http://${ONION}`, tor.fetch);
    expect(relay).toMatchObject({ recipient: 7n, maxQuoteLifetimeSeconds: 60n });
    expect(relay.withFetch(transport.session().fetch)).toMatchObject({ url: `http://${ONION}`, recipient: 7n, maxQuoteLifetimeSeconds: 60n });
    expect(connects.map(({ host }) => host)).toEqual([ONION, ONION]);
  });

  it("carries an L1 client and refuses an L1 endpoint outside the Tor policy", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("global fetch must not be used"); });
    const upstream = createHttpServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => {
        const { id } = JSON.parse(body) as { id: number };
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0xaa36a7" }));
      });
    });
    const { socks, connects } = await fakeSocks({ upstreamPort: await listen(upstream) });
    const transport = torTransport(socks);
    closers.push(() => transport.close());
    const tor = transport.session();
    const l1 = createPublicClient({ transport: torL1Transport(tor.fetch, `http://${ONION}:8545`) });
    await expect(l1.getChainId()).resolves.toBe(11155111);
    expect(connects).toEqual([{ addressType: 0x03, host: ONION, port: 8545 }]);
    expect(() => torL1Transport(tor.fetch, "http://l1.example.org")).toThrow(/L1 RPC URL must be https/);
  });

  it("refuses a redirect instead of following it", async () => {
    const upstream = createHttpServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", "http://127.0.0.1:1/");
      response.end();
    });
    const { socks, connects } = await fakeSocks({ upstreamPort: await listen(upstream) });
    const transport = torTransport(socks);
    closers.push(() => transport.close());
    const tor = transport.session();
    await expect(tor.fetch(`http://${ONION}/`)).rejects.toMatchObject({ cause: { message: expect.stringMatching(/redirect/) } });
    expect(connects).toHaveLength(1);
  });

  it("verifies the destination's TLS certificate", async () => {
    const upstream = createHttpsServer({ key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT }, (_request, response) => response.end("trusted?"));
    const { socks, connects } = await fakeSocks({ upstreamPort: await listen(upstream) });
    const transport = torTransport(socks);
    closers.push(() => transport.close());
    const tor = transport.session();
    await expect(tor.fetch("https://node.example/")).rejects.toMatchObject({ cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } });
    expect(connects).toEqual([{ addressType: 0x03, host: "node.example", port: 443 }]);
  });

  it("refuses a destination outside the Tor policy before dialling", async () => {
    const { socks, connects } = await fakeSocks({ reply: 0x05 });
    const transport = torTransport(socks);
    closers.push(() => transport.close());
    const tor = transport.session();
    await expect(tor.fetch("http://rpc.example.org/")).rejects.toThrow(/v3 \.onion/);
    await expect(tor.fetch(new Request("https://rpc.example.org/"))).rejects.toThrow(/not a Request/);
    expect(connects).toEqual([]);
  });
});
