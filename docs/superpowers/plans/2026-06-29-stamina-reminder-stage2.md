# Stamina Reminder Stage 2 (Phase 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisites:** `2026-06-29-stamina-reminder-stage1.md` 完了 (PING/PONG deploy 済、Discord Endpoint URL 登録済、`wrangler tail` で Ed25519 verify が成功している状態)。

**Goal:** `/stamina add/list/cancel` および `/title add/list/remove` の slash コマンドを稼働させ、UserState DO の `alarm()` で満タン通知を実通信する。`DISCORD_BOT_TOKEN` を Runtime secret に投入し、`bun run register-commands` でコマンド登録、spec §13.3 Stage 2 検証を完了する。

**Architecture:** `src/index.ts` の Hono entry が `/interactions` を受けて `src/interactions.ts` の `dispatchInteraction` で type/name 分岐 → `src/handlers/stamina.ts` または `src/handlers/title.ts` が呼ばれる。stamina handler は user_id でユニークな `UserState` DO に fetch、`add`/`list`/`cancel` を DO 内で実装。DO は SQLite テーブル `stamina` で状態保持し、`setAlarm(full_at_ms)` で次回満タン時刻に wake → `alarm()` で Discord REST API に通知を POST → 行を DELETE → 残行があれば `setAlarm` で再キュー。`title` handler は KV `TITLES` 名前空間を直接読み書き。

**Tech Stack:** Hono v4、discord-interactions、Cloudflare Durable Objects (SQLite backend)、KV、Workers fetch API (Discord REST 通信)、Bun (`Bun.file` でローカル `.dev.vars` 解析)。

## Global Constraints

- DO migration を含む deploy 後は **migration 前 version への rollback 不可** (Cloudflare 公式仕様、spec §14)。本 Phase で `tag = "v1" new_sqlite_classes = ["UserState"]` を初投入する deploy が境界となる。問題は **前方修正** (新たな fix deploy) で対応する。
- `DISCORD_BOT_TOKEN` の投入は **Phase 6 deploy が成功した後** (= 第 1 段階期間中の不要な token 露出を避ける、spec §12 step 22)。
- `DISCORD_BOT_TOKEN` は Cloudflare Runtime secret のみ。Workers Builds の Build Secret に置かない。
- `register-commands` は Workers Builds 環境で実行しない (ローカル手動運用、spec §13)。
- `.dev.vars` の解析は spec §9 の最小 parser を採用 (dotenv パッケージや `process.env` 経路は使わない、Bun ネイティブ実行に揃える)。architecture.md §8.6 の `dotenv` 記述は無視する (HANDOFF.md Phase 6 / spec §12 step 21 の明示指示)。
- DO 内の SQLite テーブル `stamina` の PRIMARY KEY は `title_name`。`user_id` は DO ID (`state.id.name`) で管理 (column 不要)。
- alarm() の at-least-once 性質に対して: 通知後即 DELETE することで再試行重複を最小化。`channel_id` は Interaction 受信時の値を行に保存。
- **KV の eventual consistency**: Cloudflare 公式 (https://developers.cloudflare.com/kv/api/write-key-value-pairs/) によれば、KV への書き込みは **同じグローバルネットワーク location からのリクエストには即時可視**、ただし **他 location には伝搬まで最大 60 秒 (または `cacheTtl` 秒)** かかる。本 bot は単一ユーザー想定で同じ region からのアクセスが主だが、edge case として `/title add` → `/stamina add` を別 region から続けて投げると未登録扱いになる可能性がある。Task 17 の smoke では同一クライアントから順序で叩くため通常は問題なし。本番運用で再発したら 60 秒待機 or DO へ title master を寄せる選択。
- Discord REST が non-2xx を返した場合は alarm() ハンドラ内で例外 throw、DO の at-least-once 再試行に任せる (最大 6 回、2 秒スタート指数バックオフ)。429 のときは `Retry-After` ヘッダを `console.log` してログから観測可能にする。token 失効や権限不足など恒久エラーは 6 回再試行で消化されないため、手動で `bunx wrangler secret put DISCORD_BOT_TOKEN` の再投入が必要 (Task 15 と同じ手順)。

## Files

このフェーズで作成/変更するファイル:

- Create: `src/lib/stamina-calc.ts` (満タン時刻計算の純粋関数)
- Create: `src/lib/stamina-calc.test.ts`
- Create: `src/lib/dev-vars.ts` (`.dev.vars` 最小 parser)
- Create: `src/lib/dev-vars.test.ts`
- Create: `src/lib/options.ts` (Discord interaction options[] を Record<string, string | number> に正規化する純粋関数)
- Create: `src/lib/options.test.ts`
- Create: `src/lib/titles.ts` (KV からタイトル取得、Phase 6 では DO 内から呼ぶ薄いラッパ)
- Create: `src/lib/discord-rest.ts` (Discord REST POST 共通)
- Create: `src/handlers/stamina.ts`
- Create: `src/handlers/title.ts`
- Create: `src/durable-objects/user-state.ts`
- Create: `src/commands.ts`
- Modify: `src/interactions.ts` (dispatch を `/stamina` `/title` に分岐、`stamina-options-test` 対象の純粋関数を切り出し)
- Modify: `src/interactions.test.ts` (新分岐のテスト追加)
- Modify: `src/index.ts` (`Bindings` 拡張、`export { UserState }` 追加、handler 呼出)
- Create: `scripts/register-commands.ts`
- Create: `scripts/register-commands-url.test.ts` (TDD で URL 構築をテスト)
- Modify: `wrangler.toml` (DO binding と `[[migrations]]` 追加)

このフェーズで作成しない:
- `src/durable-objects/user-state.test.ts` (DO は environment: 'node' の vitest で動かないため対象外、本格的な integration test は spec §14 で別 spec とされる)

## Interfaces

- Consumes (stage1 計画から):
  - `src/index.ts` の `Bindings` (Phase 5 では `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY` のみ)
  - `src/interactions.ts` の `dispatchInteraction`
  - `wrangler.toml` (第 1 段階) の `[vars]` と `[[kv_namespaces]]`
  - Cloudflare 上に deploy 済の Worker (Phase 5)
- Produces (本 Phase で完成):
  - `UserState` Durable Object (`src/durable-objects/user-state.ts` の class)、`USER_STATE` binding で参照可能
  - `/stamina add` (title:string, current:integer) / `/stamina list` / `/stamina cancel` (title:string)
  - `/title add` (name:string, max:integer, regen_seconds:integer) / `/title list` / `/title remove` (name:string)
  - 満タン時刻に Discord チャンネルに `<@user_id> {title} のスタミナが満タンになった` を投稿
- 純粋関数 export (TDD 対象):
  - `calculateFullAtMs({ current, max, regenSecondsPerPoint, nowMs }): number` (`src/lib/stamina-calc.ts`)
  - `parseDevVars(text: string): Record<string, string>` (`src/lib/dev-vars.ts`)
  - `optionsToRecord(opts?: { name: string; value: string | number }[] | null): Record<string, string | number>` (`src/lib/options.ts`、handlers と DO の双方が共通利用、undefined/null も `{}` で受ける防御的シグネチャ、Task 4.5 で TDD)
  - `buildRegisterCommandsUrl({ appId, guildId? }): string` (`scripts/register-commands.ts` から export、テストで参照)

---

### Task 1: 満タン時刻計算 (src/lib/stamina-calc.ts) を TDD で実装

**Files:**
- Create: `src/lib/stamina-calc.test.ts`
- Create: `src/lib/stamina-calc.ts`

**Interfaces:**
- Produces: `calculateFullAtMs(args: { current: number; max: number; regenSecondsPerPoint: number; nowMs: number }): number | null`
  - `current >= max` → `null` (満タン扱い、登録不要)
  - `current < max` → `nowMs + (max - current) * regenSecondsPerPoint * 1000`

- [ ] **Step 1: feature branch を作成**

```sh
git checkout main
git pull --rebase origin main
git checkout -b feat/stage2-handlers-and-do
```

- [ ] **Step 2: テストを書く (失敗する状態)**

`src/lib/stamina-calc.test.ts` を以下で作成:

```ts
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
```

- [ ] **Step 3: テスト失敗を確認**

```sh
bun run test
```

期待: 新規 4 テスト fail (`./stamina-calc` 未作成)、既存テストは引き続き pass。

- [ ] **Step 4: src/lib/stamina-calc.ts を実装**

```ts
export interface CalcArgs {
  current: number;
  max: number;
  regenSecondsPerPoint: number;
  nowMs: number;
}

export function calculateFullAtMs(args: CalcArgs): number | null {
  const remain = args.max - args.current;
  if (remain <= 0) return null;
  return args.nowMs + remain * args.regenSecondsPerPoint * 1000;
}
```

- [ ] **Step 5: テスト pass を確認**

```sh
bun run test
```

期待: 4 テスト pass。既存テストも引き続き pass。

- [ ] **Step 6: commit**

```sh
git add src/lib/stamina-calc.ts src/lib/stamina-calc.test.ts
git commit -m "feat: add stamina full-at calculator with unit tests"
```

---

### Task 2: .dev.vars parser (src/lib/dev-vars.ts) を TDD で実装

**Files:**
- Create: `src/lib/dev-vars.test.ts`
- Create: `src/lib/dev-vars.ts`

**Interfaces:**
- Produces: `parseDevVars(text: string): Record<string, string>`
  - `KEY=VALUE` 1 行 1 ペア
  - 行頭 `#` はコメント (無視)
  - 空行は無視
  - 値先頭/末尾の `"..."` / `'...'` は strip
  - `=` を含む値は `split('=')` 後に join('=') で復元
  - 行頭 trim、key/value 個別 trim

- [ ] **Step 1: テストを書く**

`src/lib/dev-vars.test.ts` を以下で作成:

```ts
import { describe, expect, it } from 'vitest';
import { parseDevVars } from './dev-vars';

describe('parseDevVars', () => {
  it('parses simple key=value pairs', () => {
    const result = parseDevVars('FOO=bar\nBAZ=qux\n');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores blank lines', () => {
    const result = parseDevVars('FOO=bar\n\n\nBAZ=qux\n');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores comment lines starting with #', () => {
    const result = parseDevVars('# this is comment\nFOO=bar\n# another\n');
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('strips surrounding double quotes', () => {
    const result = parseDevVars('FOO="hello"\n');
    expect(result).toEqual({ FOO: 'hello' });
  });

  it('strips surrounding single quotes', () => {
    const result = parseDevVars("FOO='hello'\n");
    expect(result).toEqual({ FOO: 'hello' });
  });

  it('keeps = inside the value', () => {
    const result = parseDevVars('TOKEN=a=b=c\n');
    expect(result).toEqual({ TOKEN: 'a=b=c' });
  });

  it('trims whitespace around keys and values', () => {
    const result = parseDevVars('  FOO  =  bar  \n');
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('returns empty object for empty input', () => {
    const result = parseDevVars('');
    expect(result).toEqual({});
  });
});
```

- [ ] **Step 2: テスト失敗を確認**

```sh
bun run test
```

期待: 新規 8 テスト fail。

- [ ] **Step 3: src/lib/dev-vars.ts を実装**

```ts
export function parseDevVars(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const [k, ...v] = line.split('=');
        return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')];
      }),
  );
}
```

- [ ] **Step 4: テスト pass を確認**

```sh
bun run test
```

期待: 8 テスト pass。

- [ ] **Step 5: commit**

```sh
git add src/lib/dev-vars.ts src/lib/dev-vars.test.ts
git commit -m "feat: add dev-vars parser used by register-commands"
```

---

### Task 3: src/lib/titles.ts (KV ラッパ) を作成

**Files:**
- Create: `src/lib/titles.ts`

**Interfaces:**
- Consumes: `KVNamespace`
- Produces:
  - `type TitleMaster = { name: string; max: number; regen_seconds_per_point: number }`
  - `getTitle(kv: KVNamespace, name: string): Promise<TitleMaster | null>`
  - `putTitle(kv: KVNamespace, t: TitleMaster): Promise<void>`
  - `deleteTitle(kv: KVNamespace, name: string): Promise<void>`
  - `listTitles(kv: KVNamespace): Promise<TitleMaster[]>`
  - key 形式: `title:<name>` (architecture.md §5 と一致)

- [ ] **Step 1: src/lib/titles.ts を書く**

```ts
export interface TitleMaster {
  name: string;
  max: number;
  regen_seconds_per_point: number;
}

const KEY_PREFIX = 'title:';

export async function getTitle(
  kv: KVNamespace,
  name: string,
): Promise<TitleMaster | null> {
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
```

注意: KVNamespace は Cloudflare Workers の型 (`@cloudflare/workers-types` 経由)。`environment: 'node'` の vitest からは型のみ参照可能、実 KV 操作は test 対象外 (実 Worker で smoke する)。

- [ ] **Step 2: typecheck を通す**

```sh
bun run typecheck
```

期待: exit 0。`KVNamespace` 型が `@cloudflare/workers-types/<date>` から解決される。

- [ ] **Step 3: commit**

```sh
git add src/lib/titles.ts
git commit -m "feat: add titles kv wrapper"
```

---

### Task 4: src/lib/discord-rest.ts (Discord REST 共通) を作成

**Files:**
- Create: `src/lib/discord-rest.ts`

**Interfaces:**
- Consumes: `fetch` (Workers globalThis)
- Produces:
  - `postChannelMessage(args: { botToken: string; channelId: string; content: string }): Promise<Response>`
  - Discord REST `POST /channels/{channel.id}/messages` (`@discord-interactions-types` の Webhook 経路と異なり、bot token 認証)
  - `Authorization: Bot <token>`、`allowed_mentions.parse: ['users']` で user mention のみ展開

- [ ] **Step 1: src/lib/discord-rest.ts を書く**

```ts
export interface PostChannelMessageArgs {
  botToken: string;
  channelId: string;
  content: string;
}

export async function postChannelMessage(
  args: PostChannelMessageArgs,
): Promise<Response> {
  const url = `https://discord.com/api/v10/channels/${args.channelId}/messages`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${args.botToken}`,
    },
    body: JSON.stringify({
      content: args.content,
      allowed_mentions: { parse: ['users'] },
    }),
  });
}
```

注意: 429 (Rate Limit) は呼出側 (UserState DO の alarm) で `Retry-After` を見て例外 throw する設計。本ラッパは単純な fetch 委譲のみ。

- [ ] **Step 2: typecheck**

```sh
bun run typecheck
```

期待: exit 0。

- [ ] **Step 3: commit**

```sh
git add src/lib/discord-rest.ts
git commit -m "feat: add discord rest helper for channel messages"
```

---

### Task 4.5: src/lib/options.ts (Discord option 配列 → record) を TDD で実装

**Files:**
- Create: `src/lib/options.test.ts`
- Create: `src/lib/options.ts`

**Interfaces:**
- Consumes: なし (純粋関数)
- Produces: `optionsToRecord(opts?: { name: string; value: string | number }[] | null): Record<string, string | number>` を export
  - 配列が空なら `{}` を返す
  - `undefined` / `null` が渡された場合 (handler 内で `sub.options ?? []` で吸収するが、直接呼ばれてもクラッシュしないように) も `{}` を返す
  - 同じ `name` の重複時は **後勝ち** (Discord は重複オプションを送らない前提だが、防御的に明示)

- [ ] **Step 1: テストを書く (失敗する状態)**

`src/lib/options.test.ts` を以下で作成:

```ts
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
    expect(optionsToRecord(undefined as unknown as { name: string; value: string | number }[])).toEqual({});
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
```

- [ ] **Step 2: テスト失敗を確認**

```sh
bun run test
```

期待: `src/lib/options.test.ts` の 6 テストすべて fail (`./options` 未作成)。

- [ ] **Step 3: src/lib/options.ts を実装**

```ts
export interface DiscordOption {
  name: string;
  value: string | number;
}

export function optionsToRecord(
  opts: DiscordOption[] | undefined | null,
): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  if (!opts) return result;
  for (const o of opts) {
    result[o.name] = o.value;
  }
  return result;
}
```

- [ ] **Step 4: テスト pass を確認**

```sh
bun run test
```

期待: 6 テスト pass。既存テストも依然 pass。

- [ ] **Step 5: commit**

```sh
git add src/lib/options.ts src/lib/options.test.ts
git commit -m "feat: add options-to-record helper for discord interactions"
```

---

### Task 5: src/durable-objects/user-state.ts を実装 (Bindings 拡張も含む)

**Files:**
- Modify: `src/index.ts` (`Bindings` 型を Phase 6 ターゲットに先行拡張、handler の wiring は Task 10 で行う)
- Create: `src/durable-objects/user-state.ts`

**Interfaces:**
- Consumes:
  - `DurableObject` (`cloudflare:workers` から import、base class)
  - `DurableObjectState`, `SqlStorage` 型 (`@cloudflare/workers-types`)
  - `Bindings` 内の `TITLES: KVNamespace` と `DISCORD_BOT_TOKEN: string`
  - `./../lib/stamina-calc.calculateFullAtMs`
  - `./../lib/titles.getTitle`
  - `./../lib/discord-rest.postChannelMessage`
  - `./../lib/options.optionsToRecord`
- Produces:
  - `class UserState extends DurableObject<Bindings>` を export (CF 公式 https://developers.cloudflare.com/durable-objects/api/base/ の現行 API)
  - `fetch(req: Request): Promise<Response>` (HTTP method dispatcher、`POST /stamina` のみ受ける)
  - `alarm()`: 満タン時刻を過ぎた行を通知 → DELETE → 残行があれば再 setAlarm
  - SQLite テーブル `stamina` (PK = title_name)
  - `src/index.ts` の `Bindings` を 5 binding (USER_STATE / TITLES / DISCORD_BOT_TOKEN / DISCORD_APPLICATION_ID / DISCORD_PUBLIC_KEY) に拡張 (handler の呼出変更は Task 10)

- [ ] **Step 0: src/index.ts の `Bindings` 型を先行拡張する**

Task 5 / 6 / 7 はいずれも `Bindings` に `USER_STATE` / `TITLES` / `DISCORD_BOT_TOKEN` がある前提で型を解決する。これらを Task 10 まで Bindings 拡張を遅延させると、各 Task 末尾の `bun run typecheck` が失敗するため、Bindings 拡張だけ先行して入れる。

`Edit` で `src/index.ts` の `Bindings` 型を以下に書き換える (export の `UserState` 追加と handler 呼出変更は Task 10 で行うため、ここでは型のみ):

```ts
export type Bindings = {
  USER_STATE: DurableObjectNamespace;
  TITLES: KVNamespace;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
};
```

注意: この時点では `wrangler.toml` に `USER_STATE` binding と `[[migrations]]` がまだ無い (Task 12 で追加)。Bindings 型の `USER_STATE` は **deploy 時に存在しない binding** を参照する形になるが、本 Task で deploy はしない (typecheck と test のみ)。Stage1 で deploy 済の Worker は `c.env.USER_STATE` をまだ呼ばないため、Stage1 期間中の runtime エラーは起きない。**Task 12 で `wrangler.toml` に `[[durable_objects.bindings]]` と `[[migrations]] tag = "v1"` を追記し、Task 13-14 で PR/merge して deploy するまでの間 (= Task 5〜11)、「型はあるが runtime binding は存在しない」状態が続く**。Task 14 の deploy 完了でこの不整合が完全解消される。本 Task 5 から Task 14 までは local の `bun run typecheck` / `bun run test` のみで進める。

- [ ] **Step 1: src/durable-objects/user-state.ts を書く**

architecture.md §8.4 のコード雛形を spec round 13 PASS + 本計画書の helper 群 (stamina-calc, titles, discord-rest) に揃えて整形:

```ts
import { DurableObject } from 'cloudflare:workers';
import type { Bindings } from '../index';
import { calculateFullAtMs } from '../lib/stamina-calc';
import { getTitle } from '../lib/titles';
import { postChannelMessage } from '../lib/discord-rest';
import { optionsToRecord } from '../lib/options';

interface StaminaRow {
  title_name: string;
  current: number;
  full_at_ms: number;
  channel_id: string;
  registered_at_ms: number;
}

interface DispatchPayload {
  sub_name: 'add' | 'list' | 'cancel';
  options: { name: string; value: string | number }[];
  channel_id: string;
}

export class UserState extends DurableObject<Bindings> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS stamina (
        title_name        TEXT NOT NULL,
        current           INTEGER NOT NULL,
        full_at_ms        INTEGER NOT NULL,
        channel_id        TEXT NOT NULL,
        registered_at_ms  INTEGER NOT NULL,
        PRIMARY KEY (title_name)
      )
    `);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/stamina' && req.method === 'POST') {
      const payload = (await req.json()) as DispatchPayload;
      return this.handleStamina(payload);
    }
    return new Response('not found', { status: 404 });
  }

  private async handleStamina(payload: DispatchPayload): Promise<Response> {
    const opts = optionsToRecord(payload.options);
    switch (payload.sub_name) {
      case 'add':
        return this.add(String(opts.title), Number(opts.current), payload.channel_id);
      case 'list':
        return this.list();
      case 'cancel':
        return this.cancel(String(opts.title));
    }
    return new Response('未対応のサブコマンド');
  }

  private async add(title: string, current: number, channelId: string): Promise<Response> {
    const t = await getTitle(this.env.TITLES, title);
    if (!t) {
      return new Response(`未登録のタイトル: ${title} (先に /title add で登録して)`);
    }
    const nowMs = Date.now();
    const fullAtMs = calculateFullAtMs({
      current,
      max: t.max,
      regenSecondsPerPoint: t.regen_seconds_per_point,
      nowMs,
    });
    if (fullAtMs === null) {
      return new Response(`${title} は既に満タン`);
    }

    this.sql.exec(
      `INSERT OR REPLACE INTO stamina
       (title_name, current, full_at_ms, channel_id, registered_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
      title,
      current,
      fullAtMs,
      channelId,
      nowMs,
    );

    await this.refreshAlarm();
    const at = new Date(fullAtMs).toLocaleString('ja-JP');
    return new Response(`${title}: ${current}/${t.max} 登録、満タン予定 ${at}`);
  }

  private async list(): Promise<Response> {
    const rows = [
      ...this.sql.exec<Pick<StaminaRow, 'title_name' | 'current' | 'full_at_ms'>>(
        `SELECT title_name, current, full_at_ms FROM stamina ORDER BY full_at_ms`,
      ),
    ];
    if (!rows.length) return new Response('登録なし');
    const lines = rows.map(
      (r) =>
        `- ${r.title_name}: 現在 ${r.current} -> 満タン ${new Date(r.full_at_ms).toLocaleString('ja-JP')}`,
    );
    return new Response(lines.join('\n'));
  }

  private async cancel(title: string): Promise<Response> {
    this.sql.exec(`DELETE FROM stamina WHERE title_name = ?`, title);
    await this.refreshAlarm();
    return new Response(`${title} をキャンセル`);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const due = [
      ...this.sql.exec<Pick<StaminaRow, 'title_name' | 'channel_id'>>(
        `SELECT title_name, channel_id FROM stamina WHERE full_at_ms <= ?`,
        now,
      ),
    ];
    const userId = (this.ctx.id.name as string | undefined) ?? 'anon';

    for (const r of due) {
      const resp = await postChannelMessage({
        botToken: this.env.DISCORD_BOT_TOKEN,
        channelId: r.channel_id,
        content: `<@${userId}> ${r.title_name} のスタミナが満タンになった`,
      });
      if (!resp.ok) {
        // 2xx 以外は行を削除せず例外 throw -> DO 再試行 (最大 6 回、2秒スタート指数バックオフ)
        // 通知失敗時にリマインダが消えるのを防ぐ (token 不正 / 5xx / 429 すべて該当)
        if (resp.status === 429) {
          const retryAfter = resp.headers.get('Retry-After') ?? 'unknown';
          console.log(`rate limited for ${r.title_name}, retry-after=${retryAfter}`);
        }
        throw new Error(
          `postChannelMessage failed for ${r.title_name}: status=${resp.status}`,
        );
      }
      // 通知成功 (2xx) を確認した後に行削除 -> at-least-once でも重複通知は 1 件まで
      this.sql.exec(`DELETE FROM stamina WHERE title_name = ?`, r.title_name);
    }

    await this.refreshAlarm();
  }

  private async refreshAlarm(): Promise<void> {
    const rows = [
      ...this.sql.exec<{ next_at: number | null }>(
        `SELECT MIN(full_at_ms) AS next_at FROM stamina`,
      ),
    ];
    const nextAt = rows[0]?.next_at;
    if (nextAt) {
      await this.ctx.storage.setAlarm(nextAt);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }
}
```

注意 (Major 7 反映): `alarm()` ハンドラは Discord REST の **2xx 以外すべて** で例外 throw する。token 失効 / 権限不足 / 5xx / 429 のいずれでも行を削除しない設計にすることで、リマインダが「通知失敗で消える」事故を防ぐ。DO の at-least-once 再試行は最大 6 回 (2 秒スタート指数バックオフ) で、それを超えても回復しない恒久エラー (例: token 失効) の場合は手動介入 (token を `wrangler secret put` で再投入) が必要。

- [ ] **Step 2: typecheck**

```sh
bun run typecheck
```

期待: exit 0。

注意 (Round 3 + Round 4 反映): Cloudflare 公式 (https://developers.cloudflare.com/durable-objects/api/base/) では `import { DurableObject } from 'cloudflare:workers'` して `class ... extends DurableObject<Env>` する形が現行 API。`implements DurableObject` パターンは公式 docs から消えており、本計画書では `extends DurableObject<Bindings>` で書く。base class が `ctx` と `env` を readonly プロパティとして提供するため、ローカルで `this.state = state` を設定する必要はない (`this.ctx` / `this.env` がそのまま使える)。`super(ctx, env)` の呼出が必須。

`override` キーワードの扱い (`tsconfig.json` で `"noImplicitOverride": true` 設定):
- `bun run typecheck` を実行して、`fetch` / `alarm` メソッドに対する診断を見る
- **TS4114** (`This member must have an 'override' modifier because it overrides a member in the base class ...`) が出た場合: `async fetch(...)` を `override async fetch(...)` に、`async alarm(...)` を `override async alarm(...)` に変更する
- **TS4113** (`This member cannot have an 'override' modifier because it is not declared in the base class ...`) が出た場合: `override` を外す (= base class が abstract method として宣言していない)
- どちらの診断も出ない場合: 現コード例どおり `override` 無しで OK
- どちらを採用したかを Self-Review の note に記録 (`@cloudflare/workers-types/<実装日 YYYY-MM-DD>` の base class 宣言で決まる、実装時の事実を残す)

normative path は **`bun run typecheck` の出力 (TS4114 / TS4113)** に従う。

検証ショートカット (optional): 直接型定義を覗く場合は `rg "class DurableObject|abstract.*fetch\(|abstract.*alarm\(" node_modules/@cloudflare/workers-types/<実装日 YYYY-MM-DD>/index.d.ts` で base class の abstract method 宣言を確認する。`bunx wrangler types` でも生成された型 (例: `worker-configuration.d.ts`) を確認できるが、その内容は wrangler 側の生成仕様に依存するため、abstract 判定は workers-types の dated subpath 確認の方が確実。

- [ ] **Step 3: commit**

```sh
git add src/index.ts src/durable-objects/user-state.ts
git commit -m "feat: extend bindings and add user-state durable object with alarm-based reminder"
```

注意: Step 0 で行った `src/index.ts` の `Bindings` 拡張変更も同じ commit に含める。これにより Task 5 単位で「赤 (Step 1〜2 の typecheck/test fail) → 緑 (実装完了) → commit」の境界が閉じる。Task 10 では `Bindings` 定義に触れず、handler wiring と `export { UserState }` の追加のみ行う。

---

### Task 6: src/handlers/stamina.ts を実装

**Files:**
- Create: `src/handlers/stamina.ts`

**Interfaces:**
- Consumes:
  - `hono` の `Context`
  - `Bindings` (`src/index.ts` から import)
  - `discord-interactions` の `InteractionResponseType`
- Produces:
  - `handleStamina(c: Context<{ Bindings: Bindings }>, interaction: any): Promise<Response>`
  - interaction.member?.user?.id (guild scope) または interaction.user?.id (DM scope) → DO ID
  - DO に `POST /stamina` で sub_name と options を JSON で渡す

- [ ] **Step 1: src/handlers/stamina.ts を書く**

```ts
import type { Context } from 'hono';
import { InteractionResponseType } from 'discord-interactions';
import type { Bindings } from '../index';

interface Interaction {
  data?: {
    options?: { name: string; options?: { name: string; value: string | number }[] }[];
  };
  member?: { user?: { id: string } };
  user?: { id: string };
  channel_id?: string;
}

export async function handleStamina(
  c: Context<{ Bindings: Bindings }>,
  interaction: Interaction,
): Promise<Response> {
  const sub = interaction.data?.options?.[0];
  if (!sub) return ephemeral(c, 'サブコマンド指定なし');

  const userId =
    interaction.member?.user?.id ?? interaction.user?.id ?? 'anon';
  const stub = c.env.USER_STATE.get(c.env.USER_STATE.idFromName(userId));

  const resp = await stub.fetch(
    new Request('https://do/stamina', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sub_name: sub.name,
        options: sub.options ?? [],
        channel_id: interaction.channel_id ?? '',
      }),
    }),
  );

  const body = await resp.text();
  return c.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: body, flags: 64 },
  });
}

function ephemeral(c: Context, msg: string) {
  return c.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: msg, flags: 64 },
  });
}
```

注意:
- `interaction: any` を明示的に `Interaction` 型に絞った (architecture.md §8.2 では `any`)。lint の `noExplicitAny` が warn なので、ここで型を絞っておけば lint も pass。
- `flags: 64` は Discord の `EPHEMERAL` (ユーザーにのみ見える返信)。

- [ ] **Step 2: typecheck と lint**

```sh
bun run typecheck
bun run lint:code
```

期待: 両方 exit 0。

- [ ] **Step 3: commit**

```sh
git add src/handlers/stamina.ts
git commit -m "feat: add stamina interaction handler"
```

---

### Task 7: src/handlers/title.ts を実装

**Files:**
- Create: `src/handlers/title.ts`

**Interfaces:**
- Consumes:
  - `hono` の `Context`、`Bindings`、`InteractionResponseType`
  - `../lib/titles` の `getTitle`, `putTitle`, `deleteTitle`, `listTitles`
- Produces:
  - `handleTitle(c, interaction): Promise<Response>`
  - `add`/`list`/`remove` をその場で処理 (DO 不要、KV のみ)

- [ ] **Step 1: src/handlers/title.ts を書く**

```ts
import type { Context } from 'hono';
import { InteractionResponseType } from 'discord-interactions';
import type { Bindings } from '../index';
import { deleteTitle, listTitles, putTitle } from '../lib/titles';
import { optionsToRecord } from '../lib/options';

interface Interaction {
  data?: {
    options?: { name: string; options?: { name: string; value: string | number }[] }[];
  };
}

export async function handleTitle(
  c: Context<{ Bindings: Bindings }>,
  interaction: Interaction,
): Promise<Response> {
  const sub = interaction.data?.options?.[0];
  if (!sub) return ephemeral(c, 'サブコマンド指定なし');

  const opts = optionsToRecord(sub.options);

  switch (sub.name) {
    case 'add': {
      const name = String(opts.name);
      const max = Number(opts.max);
      const regen = Number(opts.regen_seconds);
      await putTitle(c.env.TITLES, {
        name,
        max,
        regen_seconds_per_point: regen,
      });
      return ephemeral(c, `${name} を登録 (max=${max}, regen=${regen}s/pt)`);
    }
    case 'list': {
      const titles = await listTitles(c.env.TITLES);
      if (!titles.length) return ephemeral(c, 'タイトル未登録');
      const lines = titles.map(
        (t) => `- ${t.name}: max=${t.max}, regen=${t.regen_seconds_per_point}s/pt`,
      );
      return ephemeral(c, lines.join('\n'));
    }
    case 'remove': {
      const name = String(opts.name);
      await deleteTitle(c.env.TITLES, name);
      return ephemeral(c, `${name} を削除`);
    }
  }
  return ephemeral(c, '未対応のサブコマンド');
}

function ephemeral(c: Context, msg: string) {
  return c.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: msg, flags: 64 },
  });
}
```

- [ ] **Step 2: typecheck と lint**

```sh
bun run typecheck
bun run lint:code
```

期待: 両方 exit 0。

- [ ] **Step 3: commit**

```sh
git add src/handlers/title.ts
git commit -m "feat: add title interaction handler"
```

---

### Task 8: src/commands.ts (Slash コマンド定義) を作成

**Files:**
- Create: `src/commands.ts`

**Interfaces:**
- Produces:
  - `export const commands: Command[]` (architecture.md §8.5 と一致)
  - 6 sub: `/stamina add` / `/stamina list` / `/stamina cancel` / `/title add` / `/title list` / `/title remove`

- [ ] **Step 1: src/commands.ts を書く**

```ts
interface CommandOption {
  name: string;
  description: string;
  type: number;
  required?: boolean;
  options?: CommandOption[];
}

interface Command {
  name: string;
  description: string;
  options?: CommandOption[];
}

export const commands: Command[] = [
  {
    name: 'stamina',
    description: 'スタミナ通知の管理',
    options: [
      {
        name: 'add',
        description: '現在のスタミナを登録',
        type: 1,
        options: [
          { name: 'title', description: 'タイトル名', type: 3, required: true },
          { name: 'current', description: '現在のスタミナ', type: 4, required: true },
        ],
      },
      { name: 'list', description: '登録中のスタミナ一覧', type: 1 },
      {
        name: 'cancel',
        description: '指定タイトルをキャンセル',
        type: 1,
        options: [{ name: 'title', description: 'タイトル名', type: 3, required: true }],
      },
    ],
  },
  {
    name: 'title',
    description: 'タイトルマスタの管理',
    options: [
      {
        name: 'add',
        description: 'タイトルを追加',
        type: 1,
        options: [
          { name: 'name', description: 'タイトル名', type: 3, required: true },
          { name: 'max', description: '最大スタミナ', type: 4, required: true },
          {
            name: 'regen_seconds',
            description: '1ポイント回復に必要な秒数',
            type: 4,
            required: true,
          },
        ],
      },
      { name: 'list', description: 'タイトル一覧', type: 1 },
      {
        name: 'remove',
        description: 'タイトルを削除',
        type: 1,
        options: [{ name: 'name', description: 'タイトル名', type: 3, required: true }],
      },
    ],
  },
];
```

- [ ] **Step 2: typecheck と lint**

```sh
bun run typecheck
bun run lint:code
```

期待: 両方 exit 0。

- [ ] **Step 3: commit**

```sh
git add src/commands.ts
git commit -m "feat: define slash commands for stamina and title"
```

---

### Task 9: src/interactions.ts を `/stamina` `/title` 分岐に拡張 (TDD)

**Files:**
- Modify: `src/interactions.test.ts`
- Modify: `src/interactions.ts`

**Interfaces:**
- Produces (更新):
  - `dispatchInteraction(interaction)` の戻り値は **直接の type/data ではなく**、`{ kind: 'pong' } | { kind: 'unknown' } | { kind: 'route'; name: 'stamina' | 'title' }` に切替。これで Hono の `app.post('/interactions')` 側で `kind` を見て handler を呼ぶ。
  - 理由: 純粋関数 (test 可能) で副作用なしに「どの handler に流すか」だけを決め、handler 自体は Bindings/Context を必要とするため `src/index.ts` 側で実行する。Phase 5 の `{ type: 1 } | { type: 4; ... }` を返す形は、副作用なしの handler 出力を表現していたが、Phase 6 では handler 内で env 依存が出るため kind ベースに切替えた。
  - Phase 5 のテストを 1 件だけ書き換え (PING → PONG kind)、新規テストで route kind を 2 件追加。

- [ ] **Step 1: src/interactions.test.ts を書き換え**

`Read` で現状を読んでから (Phase 5 で書いた 3 テストがある)、`Write` で以下に上書き:

```ts
import { describe, expect, it } from 'vitest';
import { dispatchInteraction } from './interactions';

describe('dispatchInteraction', () => {
  it('returns pong for PING interaction', () => {
    const result = dispatchInteraction({ type: 1 });
    expect(result).toEqual({ kind: 'pong' });
  });

  it('routes /stamina to stamina handler', () => {
    const result = dispatchInteraction({
      type: 2,
      data: { name: 'stamina', options: [{ name: 'list', options: [] }] },
    });
    expect(result).toEqual({ kind: 'route', name: 'stamina' });
  });

  it('routes /title to title handler', () => {
    const result = dispatchInteraction({
      type: 2,
      data: { name: 'title', options: [{ name: 'list', options: [] }] },
    });
    expect(result).toEqual({ kind: 'route', name: 'title' });
  });

  it('returns unknown for application command with unknown name', () => {
    const result = dispatchInteraction({
      type: 2,
      data: { name: 'mystery' },
    });
    expect(result).toEqual({ kind: 'unknown' });
  });

  it('returns unknown for unsupported interaction type', () => {
    const result = dispatchInteraction({ type: 99 });
    expect(result).toEqual({ kind: 'unknown' });
  });
});
```

- [ ] **Step 2: テスト失敗を確認**

```sh
bun run test
```

期待: 5 テストすべて fail (古い `{ type: 1 } | { type: 4 }` 形式の実装と齟齬)。

- [ ] **Step 3: src/interactions.ts を更新**

`Write` で上書き:

```ts
type Interaction = {
  type: number;
  data?: { name?: string };
};

export type DispatchResult =
  | { kind: 'pong' }
  | { kind: 'route'; name: 'stamina' | 'title' }
  | { kind: 'unknown' };

export function dispatchInteraction(interaction: Interaction): DispatchResult {
  if (interaction.type === 1) {
    return { kind: 'pong' };
  }
  if (interaction.type === 2) {
    const name = interaction.data?.name;
    if (name === 'stamina' || name === 'title') {
      return { kind: 'route', name };
    }
  }
  return { kind: 'unknown' };
}
```

- [ ] **Step 4: テスト pass を確認**

```sh
bun run test
```

期待: 5 テスト pass。Task 1〜2 の stamina-calc / dev-vars テストも依然 pass。

- [ ] **Step 5: commit**

```sh
git add src/interactions.ts src/interactions.test.ts
git commit -m "refactor: switch dispatchInteraction to kind-based result"
```

---

### Task 10: src/index.ts に handler wiring と `export { UserState }` を追加

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes:
  - `src/handlers/stamina.handleStamina`
  - `src/handlers/title.handleTitle`
  - `src/interactions.dispatchInteraction` (Task 9 で kind-based 戻り値に refactor 済)
- Produces:
  - `export { UserState } from './durable-objects/user-state'` (Worker が DO クラスを export する義務)
  - `app.post('/interactions')` 内で `dispatchInteraction` の結果に応じて `handleStamina` / `handleTitle` / fallback を呼ぶ wiring
  - **`Bindings` 型は Task 5 Step 0 で既に 5 binding に拡張済み**。本 Task では再定義せず、import / route 登録 / export 追加のみに留める

- [ ] **Step 1: src/index.ts に必要 import と export を追加**

`Edit` で以下の差分を入れる (`Bindings` 定義はそのまま、`Hono` import は既存、`verifyKey` の使い方も既存)。

```diff
 import { Hono } from 'hono';
-import { verifyKey } from 'discord-interactions';
+import { verifyKey, InteractionResponseType } from 'discord-interactions';
 import { dispatchInteraction } from './interactions';
+import { handleStamina } from './handlers/stamina';
+import { handleTitle } from './handlers/title';
+
+export { UserState } from './durable-objects/user-state';
```

- [ ] **Step 2: `/interactions` route の本体を kind-based dispatch に書き換え**

`Edit` で `app.post('/interactions', ...)` 内の handler 部分を以下に書き換え:

```ts
app.post('/interactions', async (c) => {
  const sig = c.req.header('x-signature-ed25519') ?? '';
  const ts = c.req.header('x-signature-timestamp') ?? '';
  const body = await c.req.text();

  const valid = await verifyKey(body, sig, ts, c.env.DISCORD_PUBLIC_KEY);
  if (!valid) return c.text('invalid signature', 401);

  const interaction = JSON.parse(body);
  const result = dispatchInteraction(interaction);

  if (result.kind === 'pong') {
    return c.json({ type: 1 });
  }
  if (result.kind === 'route') {
    if (result.name === 'stamina') return handleStamina(c, interaction);
    if (result.name === 'title') return handleTitle(c, interaction);
  }
  return c.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: '未対応のコマンド', flags: 64 },
  });
});
```

`app.get('/healthz', ...)` と `export default app` は既存のまま手を入れない。`Bindings` 型定義は Task 5 Step 0 で拡張済みのため再定義しない (二重定義になる)。

- [ ] **Step 3: typecheck と lint と test**

```sh
bun run typecheck
bun run lint:code
bun run test
```

期待: すべて exit 0。

- [ ] **Step 4: commit**

```sh
git add src/index.ts
git commit -m "feat: wire stamina and title handlers in worker entry"
```

---

### Task 11: scripts/register-commands.ts と URL 構築の TDD

**Files:**
- Create: `scripts/register-commands-url.test.ts`
- Create: `scripts/register-commands.ts`

**Interfaces:**
- Produces:
  - `buildRegisterCommandsUrl({ appId: string; guildId?: string }): string` (export、純粋関数 = TDD 対象)
  - `buildRegisterRequest({ appId: string; guildId?: string; clearGuild?: boolean; commands: unknown[] }): { url: string; body: string }` (export、純粋関数 = TDD 対象、`--clear-guild` の URL + body 構築 + guildId 必須検証を集約)
  - スクリプト本体: `Bun.file('.dev.vars').text()` → `parseDevVars` で env → `buildRegisterRequest` で `{url, body}` → `fetch(url, { method: 'PUT', body })` 投出。`process.argv.includes('--clear-guild')` で `clearGuild` フラグを受ける

- [ ] **Step 1: テストを書く**

`scripts/register-commands-url.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildRegisterCommandsUrl, buildRegisterRequest } from './register-commands';

describe('buildRegisterCommandsUrl', () => {
  it('builds global commands URL when guildId is undefined', () => {
    const url = buildRegisterCommandsUrl({ appId: '12345' });
    expect(url).toBe('https://discord.com/api/v10/applications/12345/commands');
  });

  it('builds guild commands URL when guildId is provided', () => {
    const url = buildRegisterCommandsUrl({
      appId: '12345',
      guildId: '67890',
    });
    expect(url).toBe(
      'https://discord.com/api/v10/applications/12345/guilds/67890/commands',
    );
  });

  it('treats empty string guildId as global', () => {
    const url = buildRegisterCommandsUrl({ appId: '12345', guildId: '' });
    expect(url).toBe('https://discord.com/api/v10/applications/12345/commands');
  });
});

describe('buildRegisterRequest', () => {
  const fakeCommands = [{ name: 'stamina', description: 'test' }];

  it('returns global URL and command body when no guildId / no clearGuild', () => {
    const req = buildRegisterRequest({
      appId: '12345',
      commands: fakeCommands,
    });
    expect(req.url).toBe('https://discord.com/api/v10/applications/12345/commands');
    expect(req.body).toBe(JSON.stringify(fakeCommands));
  });

  it('returns guild URL and command body when guildId set', () => {
    const req = buildRegisterRequest({
      appId: '12345',
      guildId: '67890',
      commands: fakeCommands,
    });
    expect(req.url).toBe(
      'https://discord.com/api/v10/applications/12345/guilds/67890/commands',
    );
    expect(req.body).toBe(JSON.stringify(fakeCommands));
  });

  it('returns guild URL and empty array body when clearGuild + guildId set', () => {
    const req = buildRegisterRequest({
      appId: '12345',
      guildId: '67890',
      clearGuild: true,
      commands: fakeCommands,
    });
    expect(req.url).toBe(
      'https://discord.com/api/v10/applications/12345/guilds/67890/commands',
    );
    expect(req.body).toBe('[]');
  });

  it('throws when clearGuild is true but guildId is missing', () => {
    expect(() =>
      buildRegisterRequest({
        appId: '12345',
        clearGuild: true,
        commands: fakeCommands,
      }),
    ).toThrow(/guildId/);
  });

  it('throws when clearGuild is true but guildId is empty string', () => {
    expect(() =>
      buildRegisterRequest({
        appId: '12345',
        guildId: '',
        clearGuild: true,
        commands: fakeCommands,
      }),
    ).toThrow(/guildId/);
  });
});
```

- [ ] **Step 2: テスト失敗を確認**

```sh
bun run test
```

期待: 新規 8 テスト (URL builder 3 件 + buildRegisterRequest 5 件) すべて fail (`scripts/register-commands` 未作成)。

- [ ] **Step 3: scripts/register-commands.ts を書く**

`Write` で作成:

```ts
import { commands } from '../src/commands';
import { parseDevVars } from '../src/lib/dev-vars';

export function buildRegisterCommandsUrl(args: {
  appId: string;
  guildId?: string;
}): string {
  if (args.guildId && args.guildId.length > 0) {
    return `https://discord.com/api/v10/applications/${args.appId}/guilds/${args.guildId}/commands`;
  }
  return `https://discord.com/api/v10/applications/${args.appId}/commands`;
}

export interface RegisterRequest {
  url: string;
  body: string;
}

export function buildRegisterRequest(args: {
  appId: string;
  guildId?: string;
  clearGuild?: boolean;
  commands: unknown[];
}): RegisterRequest {
  if (args.clearGuild) {
    if (!args.guildId || args.guildId.length === 0) {
      throw new Error('--clear-guild requires guildId');
    }
    return {
      url: buildRegisterCommandsUrl({ appId: args.appId, guildId: args.guildId }),
      body: '[]',
    };
  }
  return {
    url: buildRegisterCommandsUrl({ appId: args.appId, guildId: args.guildId }),
    body: JSON.stringify(args.commands),
  };
}

async function main() {
  const text = await Bun.file('.dev.vars').text();
  const env = parseDevVars(text);

  const appId = env.DISCORD_APPLICATION_ID;
  const token = env.DISCORD_BOT_TOKEN;
  const guildId = env.DISCORD_GUILD_ID;
  const clearGuild = process.argv.includes('--clear-guild');

  if (!appId || !token) {
    console.error('DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required in .dev.vars');
    process.exit(1);
  }

  let req: RegisterRequest;
  try {
    req = buildRegisterRequest({ appId, guildId, clearGuild, commands });
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const resp = await fetch(req.url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${token}`,
    },
    body: req.body,
  });

  console.log(resp.status, await resp.text());
}

if (import.meta.main) {
  await main();
}
```

注意: `--clear-guild` フラグは Task 18 Step 5 の「guild scope コマンドの空配列 PUT」で使う。token を curl の argv に展開せず Bun script 内 fetch の header にだけ載るため、process list 経由の露出を回避できる。

注意:
- `import.meta.main` は Bun の機能 (Node とは異なる)。`bun scripts/register-commands.ts` 実行時のみ `main()` を呼び、`import` 経由 (= test 経由) では呼ばない。
- vitest テストは `buildRegisterCommandsUrl` と `buildRegisterRequest` の純粋関数のみを import するので `main()` は呼ばれない。

- [ ] **Step 4: テスト pass を確認**

```sh
bun run test
```

期待: `buildRegisterCommandsUrl` の 3 テストと `buildRegisterRequest` の 5 テスト、合計 8 テストが pass。

- [ ] **Step 5: ローカル `bun run register-commands` のロジックを dry-run で確認 (実登録はしない)**

**重要**: spec §12 step 23 の「Phase2 deploy 後にコマンド登録」順序を守るため、本 Step では **実 Discord にコマンドを登録しない**。Phase 6 deploy 完了前に Discord 側に登録するとハンドラ未到達で `/stamina list` が 404 になる。

ロジック (URL 構築 / `.dev.vars` 読込 / fetch 投出経路) だけ確認する手段は 2 つ:

(a) **`buildRegisterCommandsUrl` 単体テスト (Step 1-4 で既に green になっている)** を改めて確認:

```sh
bun run test
```

期待: `scripts/register-commands-url.test.ts` の 8 テスト (URL builder 3 + buildRegisterRequest 5) が pass。

(b) `.dev.vars` に **dummy token** を一時設定して全フロー (Bun.file → parseDevVars → fetch → 401 受領) を実行する。実 token は絶対に使わない:

```sh
# .dev.vars を一時的に dummy 化 (実 token はバックアップ)
cp .dev.vars .dev.vars.bak
# .dev.vars の DISCORD_BOT_TOKEN を `dummy-token-for-dry-run` に書き換える (任意の dummy 値)
bun run register-commands
```

期待: `401 ...` が出力される (URL 構築までは成功、Discord 側で token 不正と判定)。401 以外 (200 / network error 等) が出た場合はロジック問題:
- 200 が出たら token が dummy になっていない (誤って実 token を投入してしまった) → Discord Developer Portal で **Bot Token を即時 Reset** する
- TypeError / fetch failure → コード問題、`scripts/register-commands.ts` を見直す

確認後、必ず:

```sh
mv .dev.vars.bak .dev.vars
```

で `.dev.vars` を実 token に戻す。

注意: 実登録は **Task 16 で deploy 完了後** に行う。本 Step は Plan を agent が走らせる場合 (= 実 token はまだ `.dev.vars` にあるが Discord 側に登録は不要) の dry-run 確認用。手動運用者は (a) のテスト確認のみで十分。

- [ ] **Step 6: commit**

```sh
git add scripts/register-commands.ts scripts/register-commands-url.test.ts
git commit -m "feat: add register-commands script with url builder tests"
```

---

### Task 12: wrangler.toml に DO binding と [[migrations]] を追加

**Files:**
- Modify: `wrangler.toml`

**Interfaces:**
- Produces: `USER_STATE` binding (class_name = `UserState`)、`v1` migration (new_sqlite_classes = `["UserState"]`)
- 注意: この `[[migrations]]` を含む deploy が **migration 前 version への rollback を恒久ブロックする境界** (CF 公式仕様、spec §14 / §13.4)

- [ ] **Step 1: wrangler.toml の末尾に追記**

`Read` で現状確認 → `Edit` で末尾 (`[[kv_namespaces]]` ブロックの後) に以下を追加:

```toml

[[durable_objects.bindings]]
name = "USER_STATE"
class_name = "UserState"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["UserState"]
```

- [ ] **Step 2: check-pins が green**

```sh
bun run check-pins
```

期待: exit 0。

- [ ] **Step 3: wrangler dev でローカル起動を確認**

```sh
bunx wrangler dev
```

期待: `Ready on http://localhost:8787` と表示され、DO bindings に `USER_STATE` が現れる。`Ctrl+C` で停止。

別ターミナルから `/healthz` を確認:

```sh
curl -s http://127.0.0.1:8787/healthz
```

期待: `ok`。

- [ ] **Step 4: commit**

```sh
git add wrangler.toml
git commit -m "feat: add user-state durable object binding and v1 migration"
```

---

### Task 13: bun run check 全体 green と PR 作成

**Files:**
- なし (確認のみ)

**Interfaces:**
- Consumes: Task 1〜12 の commit
- Produces: GitHub PR `feat/stage2-handlers-and-do` → `main`

- [ ] **Step 1: bun run check / ci / check-pins**

```sh
bun run check
bun run ci
bun run check-pins
```

期待: 3 つすべて exit 0。

- [ ] **Step 2: PR 作成**

```sh
gh pr create \
  --base main \
  --head feat/stage2-handlers-and-do \
  --title "feat: stage 2 with user-state do and full handlers" \
  --body "$(cat <<'EOF'
## Summary
- `src/lib/stamina-calc.ts` (満タン時刻計算) を TDD で実装
- `src/lib/dev-vars.ts` (.dev.vars 最小 parser) を TDD で実装
- `src/lib/options.ts` (Discord interaction option 配列 → record 正規化) を TDD で実装、handlers と DO で共通利用
- `src/lib/titles.ts` (KV ラッパ), `src/lib/discord-rest.ts` (Discord REST 共通) を追加
- `src/durable-objects/user-state.ts` を実装 (SQLite + alarm + 通知 + 再キュー、`!resp.ok` で例外 throw)
- `src/handlers/stamina.ts` / `src/handlers/title.ts` を実装
- `src/commands.ts` (Slash コマンド定義) を追加
- `src/interactions.ts` を kind-based dispatch に refactor、`/stamina` `/title` を route
- `src/index.ts` の `Bindings` を 5 binding (USER_STATE / TITLES / DISCORD_BOT_TOKEN / DISCORD_APPLICATION_ID / DISCORD_PUBLIC_KEY) に拡張 (Task 5 Step 0)、`export { UserState }` と handler wiring を追加 (Task 10)
- `scripts/register-commands.ts` を実装、`buildRegisterCommandsUrl` と `buildRegisterRequest` を TDD で (URL builder 3 件 + `--clear-guild` 含む request builder 5 件、合計 8 件の純粋関数 test)。`--clear-guild` フラグで guild scope クリーンアップにも使用、token を argv に展開しない設計
- `wrangler.toml` に `USER_STATE` binding と `[[migrations]] tag = "v1"` を追加

**注意:** この PR を merge して deploy された後、migration 前 version への rollback は Cloudflare 公式仕様により不可能。問題が出た場合は前方修正 (新たな fix deploy) で対応する。

## Test plan
- [x] `bun run check` green (lint:code, typecheck, test)
- [x] `bun run ci` green (lint + lint:actions + typecheck + test)
- [x] `bun run check-pins` green
- [x] `bunx wrangler dev` でローカル起動、bindings に `USER_STATE` が出る
- [ ] CI workflow が PR で green
- [ ] PR merge 後、Workers Builds が `main` push を検知して deploy 開始
- [ ] DISCORD_BOT_TOKEN を Runtime secret に投入 (Task 15)
- [ ] `bun run register-commands` でコマンド登録 (Task 16)
- [ ] spec §13.3 Stage 2 検証 (slash command smoke + alarm 通知) を完了 (Task 17)

## Related
- `docs/superpowers/specs/2026-06-29-github-cicd-design.md` (round 13 PASS)
- `docs/superpowers/plans/2026-06-29-stamina-reminder-stage2.md` (本計画)
EOF
)"
```

期待: PR URL が出力。

- [ ] **Step 3: CI green を watch**

```sh
gh pr checks --watch
```

期待: `Check` job green。

---

### Task 14: PR merge → Workers Builds 自動 deploy → Sanity check

**Files:**
- なし

**Interfaces:**
- Consumes: Task 13 の PR、Workers Builds の OAuth 連携 (Phase 5 で設定済)
- Produces: 第 2 段階の Worker version (DO migration v1 を含む)

- [ ] **Step 1: PR を rebase merge**

```sh
gh pr merge --rebase --delete-branch
```

期待: PR が rebase merge され、feature branch が削除される。

- [ ] **Step 2: Workers Builds の deploy 進行を watch**

ブラウザ: `Workers & Pages → stamina-reminder → Deployments`、新 build が `In progress` → `Success` になることを確認。

CLI:

```sh
bunx wrangler deployments list --name stamina-reminder
```

期待: 最新行に新 version、Trigger=builds.cloudflare.com。

- [ ] **Step 3: deploy 失敗時のリカバリ**

- `bun install --frozen-lockfile` 系: bun.lock を再生成 → commit → push (前方修正、rollback はもう使えない)
- DO migration エラー (`Migration error: ...`): `wrangler.toml` の `[[migrations]]` 記法を再確認 (`tag = "v1"` の形式、`new_sqlite_classes = ["UserState"]` のクラス名綴り、`src/durable-objects/user-state.ts` の `export class UserState` と一致)
- `wrangler deploy` 認証: stage1 Task 6 の custom API Token のスコープ (Workers Scripts: Edit, Workers KV Storage: Read, Account Settings: Read, User Details: Read) を再確認

- [ ] **Step 4: Worker URL に `/healthz` を投げて 200 ok を確認**

```sh
curl -s https://stamina-reminder.<subdomain>.workers.dev/healthz
```

期待: `ok`。

- [ ] **Step 5: ローカル main を最新化**

```sh
git checkout main
git pull --rebase origin main
```

---

### Task 15: DISCORD_BOT_TOKEN を Cloudflare Runtime secret に投入

**Files:**
- なし

**Interfaces:**
- Consumes: bootstrap Task 2 で控えた `DISCORD_BOT_TOKEN`
- Produces: Worker Runtime secrets に `DISCORD_BOT_TOKEN` が登録された状態、新 version が即時 deploy される (`wrangler secret put` 仕様)

- [ ] **Step 1: secret を投入**

```sh
bunx wrangler secret put DISCORD_BOT_TOKEN --name stamina-reminder
```

対話プロンプトで bootstrap Task 2 の token を貼り付けて Enter。

期待: `🌀 Creating the secret for the Worker "stamina-reminder"` → `✨ Success!` → 新 Worker version が即時 deploy される。

注意: `wrangler secret put` は新 version 作成 + 即時 production deploy。Stage 2 deploy 後の直後にこれを実行することで、token 投入が独立した production change として記録される (spec §13.4)。

- [ ] **Step 2: 投入を確認**

```sh
bunx wrangler secret list --name stamina-reminder
```

期待: `DISCORD_BOT_TOKEN` が一覧に現れる (値は表示されない)。

- [ ] **Step 3: 即時 deploy された version の sanity check (Stage 1 範囲)**

別ターミナルで:

```sh
bunx wrangler tail stamina-reminder --format pretty
```

ブラウザの Discord Developer Portal で再度 Endpoint URL を `Save` (= ping 再送信トリガー、Endpoint URL 値は変えない)。tail に `POST /interactions 200` が現れ、error / Ed25519 関連の警告なしを確認。

`Ctrl+C` で tail 停止。

注意: ここで slash コマンドの smoke test は **やらない** (まだ register-commands を実行していないため、`/stamina list` を叩いても Discord 側にコマンド定義が無く失敗する)。slash command smoke は Task 17 まで持ち越し。

---

### Task 16: ローカルから register-commands を guild scope で実行

**Files:**
- Modify: `.dev.vars` (`DISCORD_GUILD_ID` を一時的に設定する。Task 18 で再びコメントアウトして global へ切り替える)

**Interfaces:**
- Consumes: `.dev.vars` の `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`、Cloudflare 上で deploy 済みの Stage 2 Worker
- Produces: Discord 側 (招待先 guild scope) に `/stamina add/list/cancel` と `/title add/list/remove` が **即時** 登録される (global は伝搬最大 1 時間のため、検証用に guild scope を使う)

- [ ] **Step 1: Guild ID を取得して .dev.vars に設定**

Discord クライアントで自分のサーバーの Guild ID を取得:
- Discord 設定 → 詳細設定 → `開発者モード` を ON
- bot を招待したサーバー名を右クリック → `ID をコピー`

`.dev.vars` の `# DISCORD_GUILD_ID=` 行のコメントを外して値を入れる:

```
DISCORD_GUILD_ID=<GUILD_ID>
```

- [ ] **Step 2: guild scope でコマンド登録**

```sh
bun run register-commands
```

期待: `200 [...]`。

Discord クライアントの該当サーバーで `/stamina` を入力すると、サブコマンド (`add`/`list`/`cancel`) が即時補完で出る。

- [ ] **Step 3: 軽い動作確認 (smoke の本実施は Task 17)**

Discord で `/stamina list` を実行。

期待: `登録なし` の ephemeral 返信。

注意: 本番運用向けの global scope 切替は Task 18 で行う。Task 17 の Stage 2 検証は guild scope のまま実施することを前提に組まれているため、ここで global に切り替えると Task 17 で `/stamina list` 等が反映されない (= 検証不能) 状態になる。

---

### Task 17: spec §13.3 Stage 2 検証 (smoke + alarm 通知)

**Files:**
- なし (動作確認のみ)

**Interfaces:**
- Consumes: deploy 済 Worker、register 済 slash commands、Discord クライアント
- Produces: spec §13.3 Stage 2 のチェックリスト完了

- [ ] **Step 1: wrangler tail を起動**

```sh
bunx wrangler tail stamina-reminder --format pretty
```

- [ ] **Step 2: `/title add` でテスト用タイトルを登録**

Discord で:

```
/title add name:テストタイトル max:10 regen_seconds:6
```

期待: ephemeral 返信 `テストタイトル を登録 (max=10, regen=6s/pt)`。

tail に POST /interactions 200 が出る。

- [ ] **Step 3: `/title list` で登録確認**

```
/title list
```

期待: ephemeral 返信 `- テストタイトル: max=10, regen=6s/pt`。

- [ ] **Step 4: 短時間で満タンになる `/stamina add` を投入**

current を `max - 1` (= 9) にすることで、`(10 - 9) * 6 * 1000` = 6000 ms = 6 秒後に満タンになる:

```
/stamina add title:テストタイトル current:9
```

期待: ephemeral 返信 `テストタイトル: 9/10 登録、満タン予定 YYYY/M/D HH:MM:SS`。

万一「未登録のタイトル: テストタイトル」が返った場合は **KV eventual consistency** の影響 (Global Constraints 参照、同 region なら即時可視のため通常起きないが edge case)。60 秒待ってから Step 4 を再試行する。再現するなら DO 経由 (title master を DO に移すなどの設計変更) を別 spec で検討。

- [ ] **Step 5: `/stamina list` で登録確認**

```
/stamina list
```

期待: `- テストタイトル: 現在 9 -> 満タン YYYY/M/D HH:MM:SS`。

- [ ] **Step 6: 約 6 秒待って alarm() が発火することを確認**

期待:
- Discord の同じチャンネルに bot からのリプライ: `<@自分のユーザーID> テストタイトル のスタミナが満タンになった`
- tail に DO の alarm() 実行ログ、`POST /channels/.../messages` 200 が出る

- [ ] **Step 7: 通知後 `/stamina list` を再確認**

```
/stamina list
```

期待: `登録なし` (alarm 実行後に DO 内で行が DELETE されている)。

- [ ] **Step 8: tail エラーが無いか確認**

tail のスクロールを上に戻し、Step 2〜7 中に以下のような行が **無い** ことを確認:
- `invalid signature` (= Ed25519 verify 失敗)
- `Migration error`
- `alarm` 関連の `error` レベル
- Discord REST 429 (= rate limit、頻発したら spec §13.3 Stage 2 の item 8 に従って setAlarm の再キュー観測)

- [ ] **Step 9: Cancel 経路の sanity (任意)**

新しい `/stamina add` を投入してから cancel:

```
/stamina add title:テストタイトル current:5
/stamina cancel title:テストタイトル
/stamina list
```

期待: 最後の list で `登録なし`。

- [ ] **Step 10: `/title remove` でテストデータを片付ける**

```
/title remove name:テストタイトル
/title list
```

期待: 最後の list で `タイトル未登録`。

- [ ] **Step 11: wrangler tail を停止**

ターミナルで `Ctrl+C`。

Stage 2 検証 (spec §13.3 Stage 2) チェック項目:
- [x] Workers Builds の最新 deploy が Success (Task 14)
- [x] `/healthz` 200 (Task 14)
- [x] Endpoint URL 200 (Task 15)
- [x] `/title add` → KV 登録 (Step 2)
- [x] `/title list` → 一覧 (Step 3)
- [x] `/stamina add` → DO 内 INSERT + setAlarm (Step 4)
- [x] alarm() 発火 → Discord REST POST → 通知 (Step 6)
- [x] alarm() 後の `/stamina list` で行削除 (Step 7)
- [x] tail エラーなし (Step 8)
- [x] `/stamina cancel` でキャンセル (Step 9、任意)
- [x] `/title remove` で削除 (Step 10)

すべて green であれば Stage 2 検証完了。残るのは global scope への切替 (Task 18)。

---

### Task 18: global scope に切り替えて guild scope を片付け

**Files:**
- Modify: `.dev.vars` (`DISCORD_GUILD_ID` 行を再びコメントアウト)

**Interfaces:**
- Consumes: Task 17 完了の guild scope 動作
- Produces: Discord 側に global scope コマンドが登録された状態 (伝搬最大 1 時間)。任意で guild scope コマンドの空配列 PUT による削除。

- [ ] **Step 1: .dev.vars の DISCORD_GUILD_ID を一旦コメントアウト (global 登録準備)**

`Edit` で `.dev.vars` の `DISCORD_GUILD_ID=<値>` 行を `# DISCORD_GUILD_ID=` に戻す:

```
# DISCORD_GUILD_ID=
```

- [ ] **Step 2: global scope で再登録**

```sh
bun run register-commands
```

期待: `200 [...]`。global コマンド一覧が更新される (Discord クライアントへの反映は最大 1 時間)。

- [ ] **Step 3: 旧 guild コマンドのクリーンアップを行うかの分岐**

Step 2 の global PUT は **global 側だけ更新する**。Task 16 で登録した guild scope コマンドは残ったまま。

- クリーンアップ **しない**: 以下の Step 4〜6 は **`- [ ]` チェックボックスを N/A としてそのまま空欄で残し、Step 7 へジャンプして本 Task 完了**。global の伝搬を待つだけで、guild scope と global scope の二重表示が一時的に出るが、個人 bot で他人に見える影響なし。
- クリーンアップ **する**: Step 4〜6 を実施し、guild scope コマンドを空配列 PUT で削除した後 Step 7 へ進む。

> **Note**: Step 4〜6 は **クリーンアップする場合のみ** 実行。checkbox 消化型 agent (`superpowers:executing-plans`) で Step を順次叩く場合は、Step 3 でこの分岐を判定し、「しない」を選んだら Step 4〜6 はチェックせず Step 7 へ進む。

- [ ] **Step 4 (cleanup する場合のみ): `.dev.vars` の `DISCORD_GUILD_ID` を一時復元**

`scripts/register-commands.ts --clear-guild` は `DISCORD_GUILD_ID` を必須とするため (env に無いと `--clear-guild requires DISCORD_GUILD_ID` で fail する)、Step 1 でコメントアウトした行を Task 16 Step 1 と同じ値で復元する:

```
DISCORD_GUILD_ID=<GUILD_ID>
```

`<GUILD_ID>` は Task 16 Step 1 で控えた実値。

- [ ] **Step 5 (cleanup する場合のみ): cleanup を Bun script 経由で実行**

**セキュリティ注意 (Round 2 + Round 3 反映)**: bot token を shell の argv / env / history に展開せず、`scripts/register-commands.ts --clear-guild` 経由で Bun の fetch から直接送る。

```sh
bun run register-commands -- --clear-guild
```

期待: `200 []`。Discord クライアントから guild scope の `/stamina` / `/title` が消える (global 側が反映されるまでの間、コマンドが一時的にどこにも見えない期間が発生し得る)。

`--` は `bun run` の後ろに付ける形で、`--clear-guild` を script の argv に渡す bun の慣例 (= `process.argv` に `--clear-guild` が含まれる)。フラグなしの呼出 (= Task 16 と同じ呼び方) は通常通り `commands` を PUT する。

- [ ] **Step 6 (cleanup する場合のみ): `DISCORD_GUILD_ID` を再びコメントアウトに戻す**

cleanup 完了後、global scope 運用に戻すため `.dev.vars` の `DISCORD_GUILD_ID` 行を `# DISCORD_GUILD_ID=` に戻す。これで次回以降の `bun run register-commands` (フラグなし) は global scope へ反映される。

- [ ] **Step 7: 検証完了**

本計画書 (Phase 6 stage2) のすべてのタスク完了。stamina-reminder の MVP が稼働。

---

## Self-Review (writer 用)

**1. Spec coverage:**
- HANDOFF.md Phase 6 (第 2 段階実装): Task 1〜18 で網羅 (Task 4.5 で options.ts TDD)
- spec §12 step 21 (handlers / UserState / commands.ts / register-commands.ts): Task 1, 2, 3, 4, 4.5, 5, 6, 7, 8, 9, 10, 11 (TDD helper の Task 1-2 と option parser Task 4.5 を含む)
- spec §12 step 22 (`[[durable_objects.bindings]]` と `[[migrations]] tag = "v1"`): Task 12
- spec §12 step 23 (PR → merge → Workers Builds 自動 deploy + コマンド登録): Task 13 (PR), Task 14 (merge + deploy), Task 16 (guild scope 登録、**Phase 6 deploy 完了後**), Task 18 (global scope 切替)。Task 11 Step 5 は dry-run のみで実登録しない
- spec §12 step 24 (`wrangler secret put DISCORD_BOT_TOKEN` → Stage 1 sanity + Stage 2 検証): Task 15 (Stage 1 sanity), Task 17 (Stage 2 検証)
- spec §13.3 Stage 1 (token 投入直後の sanity check 範囲): Task 15 Step 3
- spec §13.3 Stage 2 (slash command smoke + alarm 通知 + tail 監視): Task 17

architecture.md §8 のコード雛形:
- §8.1 src/index.ts → Task 5 Step 0 (Bindings 拡張) + Task 10 (handler wiring)
- §8.2 src/handlers/stamina.ts → Task 6
- §8.3 src/handlers/title.ts → Task 7
- §8.4 src/durable-objects/user-state.ts → Task 5
- §8.5 src/commands.ts → Task 8
- §8.6 scripts/register-commands.ts → Task 11 (ただし dotenv ではなく Bun.file + parseDevVars に統一、spec §9 の指示)
- §8 共通の option 配列 → record 正規化 → Task 4.5 (`src/lib/options.ts`、`optionsToRecord` を export して Task 5 / 7 から再利用)

**2. Placeholder scan:**
本計画書内で意図的に残している placeholder:
- `<subdomain>` (Task 14 Step 4 / Task 15 Step 3 内の Worker URL、stage1 Task 9 Step 7 で取得済み)
- `<GUILD_ID>` (Task 16 Step 1 で取得した Discord Guild ID、Task 18 Step 4 で `.dev.vars` に一時復元する際にも同値を使う)

これらは本計画書本文内 (docs/ 配下) にのみ残るため `scripts/check-pins.sh` の除外 allowlist に含まれ scan されない。リポジトリ実体への書き込み (`wrangler.toml` の値、`.dev.vars`) では必ず実値に置換すること。Task 18 の cleanup は `bun run register-commands -- --clear-guild` 経由で token / guild id を argv に展開しない設計 (Round 2 / Round 3 反映)。

placeholder 以外の禁止表現 ("TBD", "TODO", "実装は後で", "適切なエラーハンドリング", "Task N と同様") は使っていない。

**3. Type consistency:**
- `UserState` クラス名: `src/durable-objects/user-state.ts` の export、`wrangler.toml` の `class_name = "UserState"`、`[[migrations]] new_sqlite_classes = ["UserState"]`、`src/index.ts` の `export { UserState }` がすべて同じ綴り (Task 5, 10, 12)。
- `USER_STATE` binding 名: `wrangler.toml` の `name = "USER_STATE"`、`src/index.ts` の `Bindings.USER_STATE`、`src/handlers/stamina.ts` の `c.env.USER_STATE.idFromName(userId)` が同綴り (Task 5, 6, 10, 12)。
- `TITLES` binding 名: `wrangler.toml`、`Bindings.TITLES`、`src/lib/titles.ts` の引数 `kv: KVNamespace`、`src/handlers/title.ts` の `c.env.TITLES`、`src/durable-objects/user-state.ts` の `this.env.TITLES` が同綴り (Task 3, 5, 7, 10, 12)。
- `DISCORD_BOT_TOKEN` の参照: `Bindings.DISCORD_BOT_TOKEN`、`src/durable-objects/user-state.ts` の `this.env.DISCORD_BOT_TOKEN`、`src/lib/discord-rest.ts` の `botToken` 引数、Task 15 の `wrangler secret put DISCORD_BOT_TOKEN`、Task 16 の `.dev.vars` の値が同綴り。
- `calculateFullAtMs` シグネチャ: Task 1 で定義した引数 `{ current, max, regenSecondsPerPoint, nowMs }` を Task 5 (`src/durable-objects/user-state.ts`) でそのまま呼出。
- `parseDevVars` シグネチャ: Task 2 で `parseDevVars(text: string): Record<string, string>` として定義、Task 11 (`scripts/register-commands.ts`) でそのまま呼出。
- `dispatchInteraction` 戻り値: Task 9 で `DispatchResult = { kind: 'pong' } | { kind: 'route'; name: 'stamina' | 'title' } | { kind: 'unknown' }` に切替、Task 10 (`src/index.ts`) で `result.kind` を switch。stage1 計画書 Interfaces セクションは round 1 で「Phase 6 で kind-based に破壊的 refactor」と直接修正済 (= stage1 と stage2 で読み替え不要)。
- `optionsToRecord` シグネチャ: Task 4.5 で `optionsToRecord(opts: DiscordOption[] | undefined | null): Record<string, string | number>` として export、Task 5 (`src/durable-objects/user-state.ts`) と Task 7 (`src/handlers/title.ts`) が import して再利用 (private 定義しない)。
- `buildRegisterCommandsUrl` シグネチャ: Task 11 で `({ appId: string; guildId?: string }): string` として定義、test も同じ呼び方。
- KV key prefix `title:` の綴り: architecture.md §5、`src/lib/titles.ts` の `KEY_PREFIX = 'title:'` が同じ (Task 3)。

**4. Round 7 反映 cross-check (Critical 0 / Major 0 / Minor 4):**
- Minor: stage1 Task 8 Step 4 注意の「Discord 系 secrets」表記 → 「Secret は Bot Token のみ、公開値 (Application ID / Public Key) は [vars] に literal commit」と書き分け
- Minor: bootstrap Task 15 Step 3 / PR body の secret-like scan 説明文言過大 → 「HANDOFF.md と非 `docs/` の tracked file を scan、`docs/` は手動レビュー責務」に揃え
- Minor: stage2 Task 13 PR body の `buildRegisterCommandsUrl` のみ言及 → `buildRegisterRequest` も TDD (合計 8 test) + `--clear-guild` の純粋関数検証も追記
- Minor: Round 4 cross-check の test 件数表記 4 → 累計 5 件、内訳 (Round 4 で 2 件 / Round 5 で 2 件 / Round 6 で 1 件) を明記

**5. Round 6 反映 cross-check:**
- Major: bootstrap Task 10 Interfaces lines 790-792 の DISCORD_BOT_TOKEN / DISCORD_PUBLIC_KEY 両方記載 → `DISCORD_BOT_TOKEN` only に修正、`DISCORD_PUBLIC_KEY` は公開値で scan 対象外と明記
- Major: stage1 Task 1 Step 5 の recovery 経路 → Step 5 注記に「修正後は必ず `git add` を再実行してから `bun run check-pins`」を追加、Step 6 でも `git add` を冗長に再実行する形に変更
- Major: HANDOFF.md §7 / architecture §10.6 / bootstrap Task 10 Step 3 解説の check-pins 検出範囲文言過大 → 「`docs/` 配下は手動レビュー責務 (scan 対象外)」を明記、scan 除外の趣旨と検出経路を正確に書き分け
- Minor: Task 11 Step 3 注意「`buildRegisterCommandsUrl` のみを import」 → 「`buildRegisterCommandsUrl` と `buildRegisterRequest` の純粋関数のみを import」に更新
- Minor: Round 4 cross-check 内の `DISCORD_PUBLIC_KEY` 含む記述 → Round 5 で撤回した旨の注記入りに修正
- Minor: `Bearer` prefix 検出 regression test 不足 → test 1 件追加 (`DISCORD_BOT_TOKEN=Bearer ...` 検出)。secret-like scan の test 合計 = 5 件 (round 4: 2 + round 5: 2 + round 6: 1)

**5. Round 5 反映 cross-check:**
- Critical: secret-like scan に `DISCORD_PUBLIC_KEY` を含めたのを撤回 → `DISCORD_BOT_TOKEN` only に縮小、regression test (`DISCORD_PUBLIC_KEY = "64hex"` で exit 0) を追加。HANDOFF.md / architecture §10.6 も「public key は公開値、bot token のみ secret」と整合させた
- Major: `git grep` が untracked を見ない → stage1 Task 1 Step 5 で `git add wrangler.toml tsconfig.json` してから `bun run check-pins` する手順に変更、Step 6 で commit
- Major: secret regex が `Bot ` / `Bearer ` prefix を取りこぼし → 正規表現に `((Bot|Bearer)[[:space:]]+)?` の optional prefix を追加、test 1 件追加 (Bot prefix の literal 検出)
- Major: HANDOFF.md / architecture の運用ルール明文化 → HANDOFF.md §7 に項目 9 を追加、architecture.md §10.6 を bot token と公開値 (application id / public key) で分けた説明に書き換え
- Minor: Task 11 Step 5 の test 件数 (3 → 8) を更新
- Minor: Task 18 Step 4-6 を「cleanup する場合のみ」と明示、Step 3 に Note を追加して checkbox 消化型 agent の挙動を明確化
- Minor: stage1 Self-Review に secret-like literal scan の `DISCORD_BOT_TOKEN` 検出と `DISCORD_PUBLIC_KEY` 許可を明記
- Minor [HYPOTHESIS]: Task 5 Step 2 ショートカットを normative (typecheck 出力) と optional (`rg` での型定義確認) に分け、`bunx wrangler types` の生成内容依存リスクを明記

**5. Round 4 反映 cross-check:**
- Major: Task 18 Step 3 「Step 4 へスキップ」文言矛盾 → 「Step 4〜6 をスキップして Step 7 へ進む」に訂正、「クリーンアップする」分岐も Step 7 へ進む旨を明記
- Major: HANDOFF.md allowlist による実 token 検出経路喪失 → `check-pins.sh` に secret-like literal scan (`DISCORD_BOT_TOKEN` の右辺が `<...>` でなく 20 文字以上の英数記号列を検出、Round 5 で `DISCORD_PUBLIC_KEY` を対象から撤回) を追加、`HANDOFF.md` も scan 対象に含む。test 累計 5 件 (real-looking literal 検出 / Bot prefix / Bearer prefix / placeholder 形式は除外 / public key 64hex 許可)。**内訳: Round 4 で 2 件 (real-looking + placeholder), Round 5 で 2 件 (Bot prefix + public key), Round 6 で 1 件 (Bearer prefix)**
- Major: `override` 必須性 HYPOTHESIS → Task 5 Step 2 注記を TS4114 / TS4113 の分岐手順に具体化、`bunx wrangler types` / `rg` で base class abstract 状況を直接確認するショートカットも明記
- Minor: Task 5 Interfaces の `implements DurableObject` 残り → `extends DurableObject<Bindings>` に更新、`cloudflare:workers` import の Consumes 化
- Minor: Task 11 Interfaces / 期待値が 3 件のまま → `buildRegisterRequest` を Interfaces に追加、Step 2/4 期待値を 8 件 (URL 3 + Request 5) に更新
- Minor: Task 11 注意の Task 18 Step 3 参照 → Step 5 に更新
- Minor: bootstrap PR summary / Task 15 test plan の「docs/ 除外」古い表現 → allowlist 表現と secret-like literal scan に更新
- Minor: Self-Review の test 件数 4 → 5 に修正

**5. Round 3 反映 cross-check:**
- Major: Task 18 順序矛盾 (Step 1 で GUILD_ID コメントアウト → Step 3 で `--clear-guild` 必須矛盾) → Step を 7 段階に再構成、Step 4 で `DISCORD_GUILD_ID` 復元、Step 6 で再コメントアウト
- Major: check-pins Interfaces / Self-Review が古い → bootstrap Task 10 Interfaces を allowlist 形式 (`docs/` + `HANDOFF.md` + `scripts/check-pins.*`) に更新、Self-Review 注記も同期
- Major: UserState の `extends DurableObject<Bindings>` 化 (CF 公式 https://developers.cloudflare.com/durable-objects/api/base/ で verify) → `implements DurableObject` を `extends DurableObject<Bindings>`、`super(ctx, env)` 呼出、`this.state` を `this.ctx` に書き換え
- Major: `--clear-guild` の test 不足 → `buildRegisterRequest` 純粋関数を export、5 件の test (global 通常 / guild 通常 / clear + guildId / clear no guildId throw / clear empty guildId throw) を Task 11 Step 1 に追加。main() は buildRegisterRequest を呼ぶだけに簡素化
- Minor: Task 4.5 Interfaces signature 揺れ → `opts?: ...[] | null` 表記に揃え、null test 1 件追加 (合計 6 test)
- Minor: Self-Review 古い curl/dot-source 記述 → 削除、`--clear-guild` 経由の Task 18 説明に更新

**5. Round 2 反映 cross-check:**
- Critical: check-pins 自己参照 → `scripts/check-pins.sh` の scan 除外パスに `:!HANDOFF.md` / `:!scripts/check-pins.sh` / `:!scripts/check-pins.test.ts` を追加 (bootstrap Task 10)
- Critical: stage1 tsconfig が bun 型を巻き戻し → stage1 Task 1 Step 4 で `"bun"` を保持する手順に変更
- Critical: Task 5 commit に src/index.ts が含まれない → Task 5 Step 3 の `git add` に `src/index.ts` を含め、Task 10 から Bindings 拡張記述を削除
- Major: Task 10 Bindings 二重定義 → Task 10 を diff 形式 (import 追加 + route 書き換え + export 追加) に縮小、Bindings 全文再定義は削除
- Major: Task 18 cleanup の curl argv 露出 → `scripts/register-commands.ts` に `--clear-guild` フラグを追加、`bun run register-commands -- --clear-guild` で fetch 経由に変更
- Major: stage1 Task 2 の `<KV_NAMESPACE_ID>` 残存検出 → Task 2 Step 4 で `bun run check-pins` をローカルで走らせる手順を追加
- Minor: Global Constraints 文言 → 「non-2xx は throw、429 のみ Retry-After を log」に更新
- Minor: `optionsToRecord` Interfaces シグネチャ → `opts?: ... | null` に訂正
- Minor: PR body summary → `src/lib/options.ts` と `--clear-guild` の説明を追加
- Minor: stage1 Self-Review → `<KV_NAMESPACE_ID>` の確認手順 (Task 2 Step 4) を明記

**5. Round 1 反映 cross-check:**
- Critical: Bindings 拡張順序 → Task 5 Step 0 で先行拡張、Task 10 は handler wiring と export { UserState } のみ
- Critical: Bun 型 → bootstrap Task 5 で `@types/bun` 追加、Task 6 tsconfig で `"types": ["@cloudflare/workers-types/<date>", "bun"]` 同居、衝突時の分離手順を Task 6 Step 1 注記に追記済
- Major: branch protection 前段 → bootstrap Task 4 Step 2 で PR 必須 + linear history + force/delete 禁止まで入れる
- Major: register-commands は Task 11 Step 5 で dry-run のみ、実登録は Task 16 まで
- Major: check-pins は `<KV_NAMESPACE_ID>` / `<BOT_TOKEN>` / `<APP_ID>` / `<GUILD_ID>` / `<subdomain>` も検出 (bootstrap Task 10 Step 3)
- Major: option parser → Task 4.5 で `src/lib/options.ts` を export + TDD、Task 5 / 7 が import 利用
- Major: alarm() の throw 条件 → `if (!resp.ok) throw` に変更、Task 5 Step 1 注記で明記
- Major: KV consistency → Global Constraints に CF 公式 URL 付き、Task 17 Step 4 注記
- Major: Task 18 curl の token → `.dev.vars` dot-source + env var 経由に変更
- Major: Biome v2 → bootstrap Tech Stack + Task 7 で v2 構造、v1 採用時の分岐手順も明記
- Major: gh api PUT 例 → stage1 Task 10 Step 1 で full JSON body 例 + UI 推奨
