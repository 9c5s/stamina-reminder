export interface TitleMaster {
  name: string;
  max: number;
  regen_minutes_per_point: number;
}

export const KEY_PREFIX = 'title:';

/**
 * KV から取得した値が現行 TitleMaster スキーマに一致するか検証する。
 * 旧スキーマ (regen_seconds_per_point) の残存値や壊れたレコードを明示的に検出して、
 * NaN を含む満タン時刻計算などの silent failure を防ぐ。
 */
export function isValidTitleMaster(v: unknown): v is TitleMaster {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.name === 'string' &&
    typeof t.max === 'number' &&
    Number.isFinite(t.max) &&
    t.max > 0 &&
    typeof t.regen_minutes_per_point === 'number' &&
    Number.isFinite(t.regen_minutes_per_point) &&
    t.regen_minutes_per_point > 0
  );
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
