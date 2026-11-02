function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  const fromCause = errorCode(candidate.cause);
  if (fromCause !== undefined) return fromCause;
  if (Array.isArray(candidate.errors)) {
    for (const nested of candidate.errors) {
      const code = errorCode(nested);
      if (code !== undefined) return code;
    }
  }
  return undefined;
}

export async function assertPollingRelayerStopped(
  relayerUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const healthUrl = `${relayerUrl.replace(/\/$/, "")}/health`;
  let response: Response;
  try {
    response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(2_000) });
  } catch (error) {
    if (errorCode(error) === "ECONNREFUSED") return;
    throw new Error(
      `could not establish whether the continuous relayer is stopped at ${healthUrl}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const body = (await response.text()).trim();
  if (response.status === 503 && body === "stopped") return;
  if (response.ok) throw new Error("rich seed requires the continuous relayer service to be stopped");
  throw new Error(`could not establish whether the continuous relayer is stopped: ${healthUrl} returned HTTP ${response.status}`);
}
