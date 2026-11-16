// The arena writer's randomness: its salt, cell allocation and filler. Builds
// always draw from the CSPRNG. Tests swap the source here to freeze vectors;
// the protocol index does not re-export this module, so no public input can
// carry a random source.

import { randomBytes } from "@noble/hashes/utils.js";

let source: (length: number) => Uint8Array = randomBytes;

export function arenaRandom(length: number): Uint8Array {
  return source(length);
}

/** Run `build` with `random` as the arena writer's randomness. */
export function withArenaRandom<T>(random: (length: number) => Uint8Array, build: () => T): T {
  const previous = source;
  source = random;
  try {
    return build();
  } finally {
    source = previous;
  }
}
