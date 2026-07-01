import { describe, expect, it } from 'vitest';
import { optionsToRecord } from './options';

describe('optionsToRecord', () => {
  it('returns empty object for empty array', () => {
    expect(optionsToRecord([])).toEqual({});
  });

  it('returns empty object when input is null', () => {
    expect(optionsToRecord(null)).toEqual({});
  });

  it('maps name/value pairs into a record', () => {
    const result = optionsToRecord([
      { name: 'title', value: 'プリコネ' },
      { name: 'current', value: 50 },
    ]);
    expect(result).toEqual({ title: 'プリコネ', current: 50 });
  });

  it('treats undefined input as empty', () => {
    expect(
      optionsToRecord(undefined as unknown as { name: string; value: string | number }[]),
    ).toEqual({});
  });

  it('uses the last value when names collide', () => {
    const result = optionsToRecord([
      { name: 'title', value: 'A' },
      { name: 'title', value: 'B' },
    ]);
    expect(result).toEqual({ title: 'B' });
  });

  it('preserves number type for integer options', () => {
    const result = optionsToRecord([{ name: 'max', value: 99 }]);
    expect(typeof result.max).toBe('number');
    expect(result.max).toBe(99);
  });
});
