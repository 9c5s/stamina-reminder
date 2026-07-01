import { describe, expect, it, vi } from 'vitest';
import { getTitle, isValidTitleMaster, KEY_PREFIX, TITLE_LIMITS } from './titles';

function makeFakeKV(entries: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(entries));
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

describe('isValidTitleMaster', () => {
  it('accepts a valid current-schema record', () => {
    expect(isValidTitleMaster({ name: 'プリコネ', max: 99, regen_minutes_per_point: 6 })).toBe(
      true,
    );
  });

  it('rejects the legacy schema that still uses regen_seconds_per_point', () => {
    expect(isValidTitleMaster({ name: 'プリコネ', max: 99, regen_seconds_per_point: 360 })).toBe(
      false,
    );
  });

  it('rejects a non-object value', () => {
    expect(isValidTitleMaster(null)).toBe(false);
    expect(isValidTitleMaster(undefined)).toBe(false);
    expect(isValidTitleMaster('string')).toBe(false);
  });

  it('rejects records with wrong field types', () => {
    expect(isValidTitleMaster({ name: 'プリコネ', max: '99', regen_minutes_per_point: 6 })).toBe(
      false,
    );
    expect(isValidTitleMaster({ name: 123, max: 99, regen_minutes_per_point: 6 })).toBe(false);
  });

  it('rejects records with non-positive numbers', () => {
    expect(isValidTitleMaster({ name: 'プリコネ', max: 0, regen_minutes_per_point: 6 })).toBe(
      false,
    );
    expect(isValidTitleMaster({ name: 'プリコネ', max: 99, regen_minutes_per_point: 0 })).toBe(
      false,
    );
  });

  it('rejects records with NaN or Infinity', () => {
    expect(
      isValidTitleMaster({ name: 'プリコネ', max: Number.NaN, regen_minutes_per_point: 6 }),
    ).toBe(false);
    expect(
      isValidTitleMaster({
        name: 'プリコネ',
        max: 99,
        regen_minutes_per_point: Number.POSITIVE_INFINITY,
      }),
    ).toBe(false);
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(isValidTitleMaster({ name: '', max: 99, regen_minutes_per_point: 6 })).toBe(false);
    expect(isValidTitleMaster({ name: '   ', max: 99, regen_minutes_per_point: 6 })).toBe(false);
  });

  it('rejects a name whose UTF-8 byte length exceeds NAME_MAX_BYTES', () => {
    const overflowName = 'あ'.repeat(TITLE_LIMITS.NAME_MAX_BYTES); // 3 bytes/char * NAME_MAX_BYTES
    expect(isValidTitleMaster({ name: overflowName, max: 99, regen_minutes_per_point: 6 })).toBe(
      false,
    );
  });

  it('rejects a name whose character count exceeds NAME_MAX_CHARS', () => {
    // 100 文字ちょうど超過を ASCII で作ることで NAME_MAX_BYTES を下回りつつ char 制約で弾かれることを固定する
    const overCharName = 'a'.repeat(TITLE_LIMITS.NAME_MAX_CHARS + 1);
    expect(isValidTitleMaster({ name: overCharName, max: 99, regen_minutes_per_point: 6 })).toBe(
      false,
    );
  });

  it('rejects non-integer max and regen values', () => {
    expect(isValidTitleMaster({ name: 'プリコネ', max: 99.5, regen_minutes_per_point: 6 })).toBe(
      false,
    );
    expect(isValidTitleMaster({ name: 'プリコネ', max: 99, regen_minutes_per_point: 6.5 })).toBe(
      false,
    );
  });

  it('rejects values above the upper bound', () => {
    expect(
      isValidTitleMaster({
        name: 'プリコネ',
        max: TITLE_LIMITS.MAX_MAX + 1,
        regen_minutes_per_point: 6,
      }),
    ).toBe(false);
    expect(
      isValidTitleMaster({
        name: 'プリコネ',
        max: 99,
        regen_minutes_per_point: TITLE_LIMITS.REGEN_MINUTES_MAX + 1,
      }),
    ).toBe(false);
  });

  it('accepts values at the exact boundary', () => {
    expect(
      isValidTitleMaster({
        name: 'プリコネ',
        max: TITLE_LIMITS.MAX_MIN,
        regen_minutes_per_point: TITLE_LIMITS.REGEN_MINUTES_MIN,
      }),
    ).toBe(true);
    expect(
      isValidTitleMaster({
        name: 'プリコネ',
        max: TITLE_LIMITS.MAX_MAX,
        regen_minutes_per_point: TITLE_LIMITS.REGEN_MINUTES_MAX,
      }),
    ).toBe(true);
  });
});

describe('getTitle', () => {
  it('returns the parsed TitleMaster when the KV entry is valid', async () => {
    const kv = makeFakeKV({
      [`${KEY_PREFIX}プリコネ`]: JSON.stringify({
        name: 'プリコネ',
        max: 99,
        regen_minutes_per_point: 6,
      }),
    });
    const t = await getTitle(kv, 'プリコネ');
    expect(t).toEqual({ name: 'プリコネ', max: 99, regen_minutes_per_point: 6 });
  });

  it('returns null when the KV key is missing', async () => {
    const kv = makeFakeKV();
    expect(await getTitle(kv, '未登録')).toBeNull();
  });

  it('returns null and warns when the stored value is invalid JSON', async () => {
    const kv = makeFakeKV({ [`${KEY_PREFIX}壊れた`]: '{not-json' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await getTitle(kv, '壊れた')).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('returns null and warns when the stored record uses the legacy schema', async () => {
    const kv = makeFakeKV({
      [`${KEY_PREFIX}旧`]: JSON.stringify({
        name: '旧',
        max: 99,
        regen_seconds_per_point: 360,
      }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await getTitle(kv, '旧')).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
