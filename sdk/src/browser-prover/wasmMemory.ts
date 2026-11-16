import type { Barretenberg } from "@aztec-foundation/bb.js";

function property(value: unknown, key: string): unknown {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? Reflect.get(value, key)
    : undefined;
}

/**
 * Barretenberg's Wasm linear-memory size in bytes, read through bb.js
 * internals. `Barretenberg.backend` is a BarretenbergWasmAsyncBackend whose
 * `wasm` is either a BarretenbergWasmMain (direct Wasm: `memSize()` returns a
 * number) or a comlink proxy to one in a nested worker (`memSize()` returns a
 * Promise). Resolves undefined for any other shape or if the read fails, so
 * measurement never changes a proof's outcome.
 */
export async function barretenbergWasmMemoryBytes(
  api: Barretenberg | undefined,
): Promise<number | undefined> {
  const wasm = property(property(api, "backend"), "wasm");
  const memSize = property(wasm, "memSize");
  if (typeof memSize !== "function") return undefined;
  try {
    const bytes: unknown = await Reflect.apply(memSize, wasm, []);
    return typeof bytes === "number" ? bytes : undefined;
  } catch {
    return undefined;
  }
}
