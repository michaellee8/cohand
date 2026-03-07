import { describe, it, expect } from 'vitest';
import { createPRNG, randomInRange, randomInt } from './prng';

describe('createPRNG', () => {
  it('same seed produces same sequence', () => {
    const rng1 = createPRNG('task-42-action-0');
    const rng2 = createPRNG('task-42-action-0');

    const seq1 = Array.from({ length: 10 }, () => rng1());
    const seq2 = Array.from({ length: 10 }, () => rng2());

    expect(seq1).toEqual(seq2);
  });

  it('different seeds produce different sequences', () => {
    const rng1 = createPRNG('task-42-action-0');
    const rng2 = createPRNG('task-42-action-1');

    const seq1 = Array.from({ length: 10 }, () => rng1());
    const seq2 = Array.from({ length: 10 }, () => rng2());

    expect(seq1).not.toEqual(seq2);
  });

  it('output is in [0, 1)', () => {
    const rng = createPRNG('bounds-test');

    for (let i = 0; i < 1000; i++) {
      const val = rng();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  it('produces varied output (not stuck on a single value)', () => {
    const rng = createPRNG('variety-test');
    const values = new Set(Array.from({ length: 100 }, () => rng()));

    // At least 90 unique values out of 100 draws
    expect(values.size).toBeGreaterThan(90);
  });
});

describe('randomInRange', () => {
  it('produces values in [min, max)', () => {
    const rng = createPRNG('range-test');

    for (let i = 0; i < 500; i++) {
      const val = randomInRange(rng, 10, 20);
      expect(val).toBeGreaterThanOrEqual(10);
      expect(val).toBeLessThan(20);
    }
  });

  it('produces values across the range (not clustered)', () => {
    const rng = createPRNG('spread-test');
    const values = Array.from({ length: 200 }, () => randomInRange(rng, 0, 100));

    const min = Math.min(...values);
    const max = Math.max(...values);

    // Should span at least 80% of the range
    expect(max - min).toBeGreaterThan(80);
  });
});

describe('randomInt', () => {
  it('produces integers in [min, max] inclusive', () => {
    const rng = createPRNG('int-test');

    for (let i = 0; i < 500; i++) {
      const val = randomInt(rng, 5, 10);
      expect(Number.isInteger(val)).toBe(true);
      expect(val).toBeGreaterThanOrEqual(5);
      expect(val).toBeLessThanOrEqual(10);
    }
  });

  it('can produce both min and max values', () => {
    const rng = createPRNG('minmax-test');
    const values = Array.from({ length: 500 }, () => randomInt(rng, 0, 2));

    expect(values).toContain(0);
    expect(values).toContain(2);
  });

  it('single-value range always returns that value', () => {
    const rng = createPRNG('single-test');
    for (let i = 0; i < 10; i++) {
      expect(randomInt(rng, 7, 7)).toBe(7);
    }
  });
});
