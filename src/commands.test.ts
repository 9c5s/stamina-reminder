import { describe, expect, it } from 'vitest';
import { commands } from './commands';

describe('commands definition', () => {
  it('exposes /title add with regen_minutes as an integer option in 1..1440', () => {
    const titleCmd = commands.find((c) => c.name === 'title');
    const titleAdd = titleCmd?.options?.find((o) => o.name === 'add');
    const regen = titleAdd?.options?.find((o) => o.name === 'regen_minutes');
    expect(regen).toBeDefined();
    expect(regen).toMatchObject({
      // type 4 は Discord Application Command Option type INTEGER に相当する
      type: 4,
      required: true,
      min_value: 1,
      max_value: 1440,
    });
  });

  it('no longer references the legacy regen_seconds option', () => {
    const titleAdd = commands
      .find((c) => c.name === 'title')
      ?.options?.find((o) => o.name === 'add');
    const legacy = titleAdd?.options?.find((o) => o.name === 'regen_seconds');
    expect(legacy).toBeUndefined();
  });

  it('keeps /title add max option bounded to 1..100000', () => {
    const max = commands
      .find((c) => c.name === 'title')
      ?.options?.find((o) => o.name === 'add')
      ?.options?.find((o) => o.name === 'max');
    expect(max).toMatchObject({ type: 4, required: true, min_value: 1, max_value: 100000 });
  });

  it('caps every string name option at 100 chars so TITLE_LIMITS.NAME_MAX_CHARS stays honored', () => {
    // 直値で境界を固定して、TITLE_LIMITS を変えたときに shape テストが警告する状態を保つ
    const nameLikeOptions: { name: string; max_length?: number }[] = [];
    for (const cmd of commands) {
      for (const sub of cmd.options ?? []) {
        for (const opt of sub.options ?? []) {
          if (opt.name === 'name' || opt.name === 'title') nameLikeOptions.push(opt);
        }
      }
    }
    expect(nameLikeOptions.length).toBeGreaterThan(0);
    for (const opt of nameLikeOptions) {
      expect(opt.max_length).toBe(100);
    }
  });
});
