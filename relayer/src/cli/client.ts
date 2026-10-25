import type { RelayerHttpCommand } from "./args.ts";

export class RelayerHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RelayerHttpError";
    this.status = status;
  }
}

export class RelayerHttpClient {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs = 5_000) {
    this.url = url.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  async request(command: RelayerHttpCommand): Promise<unknown> {
    const url = `${this.url}/${command}`;
    let response: Response;
    let body: string;
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      response = await fetch(url, { signal });
      body = await response.text();
    } catch (error) {
      const detail = signal.aborted
        ? `timed out after ${this.timeoutMs} ms`
        : error instanceof Error ? error.message : String(error);
      throw new Error(`relayer HTTP request to ${url} failed: ${detail}`, { cause: error });
    }
    if (!response.ok) {
      const detail = body.trim();
      throw new RelayerHttpError(
        response.status,
        detail === "" ? `relayer HTTP returned ${response.status}` : detail,
      );
    }
    if (command !== "status") return body;
    try {
      return JSON.parse(body) as unknown;
    } catch (error) {
      throw new Error("relayer status response is not valid JSON", { cause: error });
    }
  }
}
