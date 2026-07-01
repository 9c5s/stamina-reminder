export interface TitleMaster {
  name: string;
  max: number;
  regen_seconds_per_point: number;
}

const KEY_PREFIX = 'title:';

export async function getTitle(kv: KVNamespace, name: string): Promise<TitleMaster | null> {
  const raw = await kv.get(`${KEY_PREFIX}${name}`);
  return raw ? (JSON.parse(raw) as TitleMaster) : null;
}

export async function putTitle(kv: KVNamespace, t: TitleMaster): Promise<void> {
  await kv.put(`${KEY_PREFIX}${t.name}`, JSON.stringify(t));
}

export async function deleteTitle(kv: KVNamespace, name: string): Promise<void> {
  await kv.delete(`${KEY_PREFIX}${name}`);
}

export async function listTitles(kv: KVNamespace): Promise<TitleMaster[]> {
  const list = await kv.list({ prefix: KEY_PREFIX });
  // 逐次 await ではなく Promise.all で並列フェッチし、レイテンシを削減する
  const raws = await Promise.all(list.keys.map((k) => kv.get(k.name)));
  return raws
    .map((raw) => (raw ? (JSON.parse(raw) as TitleMaster) : null))
    .filter((t): t is TitleMaster => t !== null);
}
