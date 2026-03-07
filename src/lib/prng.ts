// src/lib/prng.ts

/**
 * Create a deterministic PRNG from a string seed.
 * Uses Mulberry32 algorithm — simple, fast, good distribution.
 * Seeded from taskId + actionIndex for deterministic replay and debugging.
 */
export function createPRNG(seed: string): () => number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(31, h) + seed.charCodeAt(i) | 0;
  }

  return function mulberry32(): number {
    h |= 0;
    h = h + 0x6d2b79f5 | 0;
    let t = Math.imul(h ^ h >>> 15, 1 | h);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Random number in range [min, max) using the PRNG.
 */
export function randomInRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

/**
 * Random integer in range [min, max] inclusive.
 */
export function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(randomInRange(rng, min, max + 1));
}
