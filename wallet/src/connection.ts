// Shared local configuration for the server and its stateless HTTP client.
import { type Stats, constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const defaultWalletDataDir = (): string => join(homedir(), ".pcash", "wallet");
export interface WalletConnection { url: string; token: string }
const filename = "connection.json";

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

// This file is configuration shared with another process. Permissions prevent
// other local users from substituting an endpoint or reading the bearer token.
function privateOwner(stat: Stats, label: string): void {
  if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error(`${label} must be owned by the current user and private (directory 0700, file 0600)`);
  }
}

function connectionDirectory(dataDir: string, create: boolean): string | undefined {
  const directory = resolve(dataDir);
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  let stat;
  try { stat = lstatSync(directory); }
  catch (error) { if (!create && missing(error)) return undefined; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`wallet connection directory ${directory} must be a directory, not a symlink`);
  privateOwner(stat, `wallet connection directory ${directory}`);
  return directory;
}

export function readWalletConnection(dataDir: string): WalletConnection | undefined {
  const directory = connectionDirectory(dataDir, false);
  if (directory === undefined) return undefined;
  const path = join(directory, filename);
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    privateOwner(stat, `wallet connection file ${path}`);
    if (!stat.isFile() || stat.size > 4096) throw new Error(`wallet connection file ${path} must be a regular file of at most 4096 bytes`);
    let value: Partial<WalletConnection> | null;
    try { value = JSON.parse(readFileSync(fd, "utf8")) as Partial<WalletConnection> | null; }
    catch { throw new Error(`invalid wallet connection configuration in ${path}`); }
    if (value === null || typeof value.url !== "string" || typeof value.token !== "string" || value.token.trim() === "") {
      throw new Error(`invalid wallet connection configuration in ${path}`);
    }
    const url = new URL(value.url);
    if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error(`wallet connection endpoint in ${path} must be a loopback service URL`);
    }
    return { url: url.origin, token: value.token };
  } finally { closeSync(fd); }
}

export function generatedWalletToken(dataDir: string): string {
  connectionDirectory(dataDir, true);
  return readWalletConnection(dataDir)?.token ?? randomBytes(32).toString("hex");
}

export function saveWalletConnection(dataDir: string, connection: WalletConnection): void {
  const directory = connectionDirectory(dataDir, true)!;
  // Refuse an unsafe existing configuration rather than replacing it silently.
  readWalletConnection(dataDir);
  const temporary = join(directory, `.${filename}.${randomBytes(8).toString("hex")}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(connection) + "\n");
    fsyncSync(fd);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  } finally { closeSync(fd); }
  try { renameSync(temporary, join(directory, filename)); }
  catch (error) { unlinkSync(temporary); throw error; }
}

export function resolveWalletConnection(options: { dataDir: string; url: string; explicitUrl: boolean; token?: string }): { url: string; token?: string } {
  // Fully explicit configuration does not depend on local discovery.
  const saved = options.explicitUrl && options.token !== undefined ? undefined : readWalletConnection(options.dataDir);
  const url = options.explicitUrl ? options.url : saved?.url ?? options.url;
  const sameEndpoint = saved !== undefined && new URL(url).href === new URL(saved.url).href;
  const token = options.token ?? (sameEndpoint ? saved?.token : undefined);
  return { url, ...(token === undefined ? {} : { token }) };
}
