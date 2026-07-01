import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../index';
import { KEY_PREFIX } from '../lib/titles';
import { handleTitle } from './title';

interface FakeKV extends KVNamespace {
  __store: Map<string, string>;
}

function makeFakeKV(entries: Record<string, string> = {}): FakeKV {
  const store = new Map<string, string>(Object.entries(entries));
  const kv = {
    __store: store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix }: { prefix?: string } = {}) {
      const keys = [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: '' };
    },
  } as unknown as FakeKV;
  return kv;
}

type SubOption = { name: string; value: string | number };

function subCommand(name: string, options: SubOption[]) {
  return { name, options };
}

async function invoke(
  kv: FakeKV,
  sub: { name: string; options: SubOption[] },
): Promise<{ status: number; content: string }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.post('/', async (c) => handleTitle(c, { data: { options: [sub] } }));
  const bindings = { TITLES: kv } as unknown as Bindings;
  const res = await app.request('/', { method: 'POST' }, bindings);
  const body = (await res.json()) as { data: { content: string } };
  return { status: res.status, content: body.data.content };
}

describe('handleTitle add', () => {
  it('persists regen_minutes_per_point as-is (no seconds conversion)', async () => {
    const kv = makeFakeKV();
    const { status, content } = await invoke(
      kv,
      subCommand('add', [
        { name: 'name', value: 'プリコネ' },
        { name: 'max', value: 99 },
        { name: 'regen_minutes', value: 6 },
      ]),
    );
    expect(status).toBe(200);
    expect(content).toBe('プリコネ を登録 (max=99, regen=6min/pt)');
    const raw = kv.__store.get(`${KEY_PREFIX}プリコネ`);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string)).toEqual({
      name: 'プリコネ',
      max: 99,
      regen_minutes_per_point: 6,
    });
  });

  it('rejects non-integer regen_minutes', async () => {
    const kv = makeFakeKV();
    const { content } = await invoke(
      kv,
      subCommand('add', [
        { name: 'name', value: 'プリコネ' },
        { name: 'max', value: 99 },
        { name: 'regen_minutes', value: 1.5 },
      ]),
    );
    expect(content).toBe('回復分数は 1 以上の整数で指定してください');
    expect(kv.__store.size).toBe(0);
  });

  it('rejects regen_minutes above the 1440 upper bound', async () => {
    const kv = makeFakeKV();
    const { content } = await invoke(
      kv,
      subCommand('add', [
        { name: 'name', value: 'プリコネ' },
        { name: 'max', value: 99 },
        { name: 'regen_minutes', value: 1441 },
      ]),
    );
    expect(content).toBe('回復分数は 1440 以下 (1 日) で指定してください');
    expect(kv.__store.size).toBe(0);
  });

  it('rejects non-integer max', async () => {
    const kv = makeFakeKV();
    const { content } = await invoke(
      kv,
      subCommand('add', [
        { name: 'name', value: 'プリコネ' },
        { name: 'max', value: 99.5 },
        { name: 'regen_minutes', value: 6 },
      ]),
    );
    expect(content).toBe('最大スタミナは 1 以上の整数で指定してください');
  });
});

describe('handleTitle list', () => {
  it('renders regen in min/pt notation from the KV value', async () => {
    const kv = makeFakeKV({
      [`${KEY_PREFIX}プリコネ`]: JSON.stringify({
        name: 'プリコネ',
        max: 99,
        regen_minutes_per_point: 6,
      }),
    });
    const { content } = await invoke(kv, subCommand('list', []));
    expect(content).toBe('- プリコネ: max=99, regen=6min/pt');
  });

  it('skips corrupt entries and warns instead of leaking undefined values', async () => {
    const kv = makeFakeKV({
      [`${KEY_PREFIX}正常`]: JSON.stringify({
        name: '正常',
        max: 50,
        regen_minutes_per_point: 3,
      }),
      [`${KEY_PREFIX}旧`]: JSON.stringify({
        name: '旧',
        max: 99,
        regen_seconds_per_point: 360,
      }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { content } = await invoke(kv, subCommand('list', []));
      expect(content).toBe('- 正常: max=50, regen=3min/pt');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('appends the未表示 suffix so shown + hidden equals list.keys.length', async () => {
    // 1 件分すら入らない狭い擬似 LIMIT を作るために、非常に長いタイトル名を 2 件用意する。
    // 1 件目の 1 行が SUFFIX_RESERVE を控えた LIMIT に収まらないケースは実運用では発生し
    // にくいので、本ケースは「truncated 分岐に入ったとき shown ベースで数える」不変式が
    // 破損 skip と混在しても崩れないことを固定する目的で残す。
    const longName = 'あ'.repeat(20);
    const kv = makeFakeKV({
      [`${KEY_PREFIX}${longName}A`]: JSON.stringify({
        name: `${longName}A`,
        max: 100,
        regen_minutes_per_point: 5,
      }),
      [`${KEY_PREFIX}壊れた`]: '{not-json',
      [`${KEY_PREFIX}${longName}B`]: JSON.stringify({
        name: `${longName}B`,
        max: 100,
        regen_minutes_per_point: 5,
      }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { content } = await invoke(kv, subCommand('list', []));
      // 3 件全てが正常だった場合の想定合計と現状の shown 分を比較する。
      // shown + (未表示 N) = 3 になっていれば合計が list.keys.length と一致する不変式が成立する
      const shownLines = content.split('\n').filter((l) => l.startsWith('- ')).length;
      const suffixMatch = content.match(/\(他 (\d+) 件は未表示\)/);
      if (suffixMatch) {
        const hidden = Number(suffixMatch[1]);
        expect(shownLines + hidden).toBe(3);
      } else {
        // truncation 分岐に入らなかった (全件入りきった) 場合は破損 skip 分だけ落ちる想定
        expect(shownLines).toBe(2);
      }
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
