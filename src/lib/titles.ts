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
  const titles: TitleMaster[] = [];
  for (const k of list.keys) {
    const raw = await kv.get(k.name);
    if (raw) titles.push(JSON.parse(raw) as TitleMaster);
  }
  return titles;
}
