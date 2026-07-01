export interface TitleMaster {
  name: string;
  max: number;
  regen_minutes_per_point: number;
}

export const KEY_PREFIX = 'title:';

/**
 * TitleMaster が満たすべき境界。commands.ts の Discord option 制約と
 * handlers/title.ts の runtime バリデーションと mirror し、KV 直書きや
 * 破損値も同じ境界で拒否できるようにする。
 */
export const TITLE_LIMITS = {
  /** UTF-8 バイト長の上限。KV key `title:<name>` を 512 バイト以内に収める余裕を含む */
  NAME_MAX_BYTES: 490,
  MAX_MIN: 1,
  MAX_MAX: 100000,
  REGEN_MINUTES_MIN: 1,
  REGEN_MINUTES_MAX: 1440,
} as const;

const nameByteLength = (s: string): number => new TextEncoder().encode(s).length;

/**
 * KV から取得した値が現行 TitleMaster スキーマと境界を満たすか検証する。
 * 旧スキーマ (regen_seconds_per_point) の残存値や壊れたレコード、境界外の値を
 * 明示的に検出して、NaN を含む満タン時刻計算などの silent failure を防ぐ。
 */
export function isValidTitleMaster(v: unknown): v is TitleMaster {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  if (typeof t.name !== 'string') return false;
  const trimmed = t.name.trim();
  if (trimmed.length === 0) return false;
  if (nameByteLength(t.name) > TITLE_LIMITS.NAME_MAX_BYTES) return false;
  if (
    typeof t.max !== 'number' ||
    !Number.isInteger(t.max) ||
    t.max < TITLE_LIMITS.MAX_MIN ||
    t.max > TITLE_LIMITS.MAX_MAX
  ) {
    return false;
  }
  if (
    typeof t.regen_minutes_per_point !== 'number' ||
    !Number.isInteger(t.regen_minutes_per_point) ||
    t.regen_minutes_per_point < TITLE_LIMITS.REGEN_MINUTES_MIN ||
    t.regen_minutes_per_point > TITLE_LIMITS.REGEN_MINUTES_MAX
  ) {
    return false;
  }
  return true;
}

export async function getTitle(kv: KVNamespace, name: string): Promise<TitleMaster | null> {
  const raw = await kv.get(`${KEY_PREFIX}${name}`);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // 破損した JSON は運用上の異常なのでログを残し、呼び出し元には「未登録」相当を返す
    console.warn(`title KV entry corrupt (JSON parse failed): ${name}`, err);
    return null;
  }
  if (!isValidTitleMaster(parsed)) {
    console.warn(`title KV entry corrupt (schema mismatch): ${name}`);
    return null;
  }
  return parsed;
}

export async function putTitle(kv: KVNamespace, t: TitleMaster): Promise<void> {
  await kv.put(`${KEY_PREFIX}${t.name}`, JSON.stringify(t));
}

export async function deleteTitle(kv: KVNamespace, name: string): Promise<void> {
  await kv.delete(`${KEY_PREFIX}${name}`);
}
