import { describe, expect, it } from 'vitest';
import { calculateFullAtMs } from './stamina-calc';

describe('calculateFullAtMs', () => {
  it('returns nowMs + remaining * regen * 1000 when below max', () => {
    const result = calculateFullAtMs({
      current: 10,
      max: 99,
      regenSecondsPerPoint: 360,
      nowMs: 1_000_000,
    });
    // (99 - 10) * 360 * 1000 = 32_040_000
    expect(result).toBe(1_000_000 + 32_040_000);
  });

  it('returns null when current equals max (already full)', () => {
    const result = calculateFullAtMs({
      current: 99,
      max: 99,
      regenSecondsPerPoint: 360,
      nowMs: 1_000_000,
    });
    expect(result).toBeNull();
  });

  it('returns null when current exceeds max', () => {
    const result = calculateFullAtMs({
      current: 100,
      max: 99,
      regenSecondsPerPoint: 360,
      nowMs: 1_000_000,
    });
    expect(result).toBeNull();
  });

  it('handles regenSecondsPerPoint of 1 (extreme regen)', () => {
    const result = calculateFullAtMs({
      current: 0,
      max: 10,
      regenSecondsPerPoint: 1,
      nowMs: 0,
    });
    expect(result).toBe(10_000);
  });
});
