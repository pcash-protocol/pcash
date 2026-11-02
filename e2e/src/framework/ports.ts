import { createServer, type Server } from "node:net";

export interface PortLease {
  readonly ports: readonly number[];
  releasePort(port: number): Promise<void>;
  release(): Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("free-port lease did not bind an IPv4 socket"));
        return;
      }
      resolve(address.port);
    });
  });
}

export async function leasePorts(count: number): Promise<PortLease> {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("port lease count must be a positive integer");
  }
  const servers: Server[] = [];
  const ports: number[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer((socket) => socket.destroy());
      servers.push(server);
      ports.push(await listen(server));
    }
  } catch (error) {
    await Promise.all(servers.map((server) => close(server)));
    throw error;
  }
  let released = false;
  return {
    ports,
    async releasePort(port: number) {
      const index = ports.indexOf(port);
      if (index < 0) throw new Error(`port ${port} does not belong to this lease`);
      await close(servers[index]!);
    },
    async release() {
      if (released) return;
      released = true;
      await Promise.all(servers.map((server) => close(server)));
    },
  };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
